import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { credentialPath, usedPath, type CredentialRecord } from '../lib/auth-credentials.ts'
import {
  REFRESH_FAILED,
  REFRESH_TIMED_OUT,
  requestMutationBody,
  reviewerMutationBody,
} from '../lib/admin-response.ts'
import { ORDERED_READ_CONCURRENCY } from '../lib/ordered-concurrency.ts'
import type { CreateOutcome, PrivateStore, VersionedObject } from '../lib/private-store.ts'
import { AUDIT_PAGE_SIZE, loadAdminView } from '../lib/reviewer-admin.ts'
import { loadRequestViews } from '../lib/reviewer-onboarding.ts'
import { listRequests, REQUEST_RECORDS, type ReviewerRequest } from '../lib/reviewer-requests.ts'
import {
  AUDIT_ROOT,
  __resetRosterStore,
  createVercelBlobRosterStore,
  type AuditEvent,
  type RosterBlobBackend,
  type RosterReviewer,
} from '../lib/reviewer-roster.ts'
import { MemoryRosterStore, aReviewer } from './helpers/reviewer-world.ts'

/*
 * The three dashboard read loops, and the one property C6 changed about them.
 *
 * Until C6 each of these read its objects one after another: forty audit
 * objects, every request record, and an outstanding-activation check per
 * qualifying request. The 2026-09-14 V9 measurement put the audit refresh at
 * 3,746.7 / 3,342.2 / 3,770.0 ms against a 2,500 ms post-commit deadline, and
 * the individual reads were not slow -- the serialisation was.
 *
 * So the correction is narrow: a cap-eight ordered mapper, at exactly these
 * three call sites. Everything that makes these loops *correct* has to survive
 * it, and each of the three has a different idea of what a failure means. That
 * is what this file pins down:
 *
 *   - no more than eight reads are ever in flight (a serial loop peaks at one,
 *     so every concurrency assertion here fails against the pre-C6 source);
 *   - output order is the order the loop decided on, never the order the store
 *     happened to answer in -- every helper below answers deliberately out of
 *     order;
 *   - audit: null and malformed objects are skipped, a rejection rejects
 *     `listAudit`, and `loadAdminView` still shows the roster with no audit;
 *   - request list: null and malformed records are skipped, but *any* rejection
 *     rejects the whole list -- a partial waiting list is a wrong answer;
 *   - request views: an outstanding-state failure stays local to its own
 *     request and reads as `false`, and every other view survives in order.
 *
 * Nothing here contacts a store, a network or a credential of any kind. Every
 * hash below is a literal made of repeated hex digits.
 */

/** `0 .. n - 1`, without an iterator this project's target cannot spread. */
const upTo = (n: number): number[] => Array.from({ length: n }, (_unused, index) => index)

/* ------------------------------------------------------------- observation */

/**
 * Counts what is genuinely in flight at once, and records the order work
 * *finished* in.
 *
 * `peak` is the assertion that discriminates: a serial loop cannot exceed one,
 * and a mapper capped at eight cannot exceed eight.
 */
function watcher() {
  let inFlight = 0
  let peak = 0
  let issued = 0
  const started: string[] = []
  const finished: string[] = []

  return {
    get peak(): number {
      return peak
    },
    started,
    finished,
    /**
     * Run one unit of tracked work.
     *
     * Its delay falls as the issue counter rises, so within any group of eight
     * the read issued *first* settles *last*. Deliberate rather than random:
     * "the store answered out of order" has to be a fact this file establishes,
     * not a coincidence a fast machine might fail to produce.
     */
    async run<T>(key: string, produce: () => T): Promise<T> {
      const delayMs = (ORDERED_READ_CONCURRENCY - (issued % ORDERED_READ_CONCURRENCY)) * 4
      issued += 1
      inFlight += 1
      if (inFlight > peak) peak = inFlight
      started.push(key)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      inFlight -= 1
      finished.push(key)
      return produce()
    },
  }
}

function assertAnsweredOutOfOrder(watch: ReturnType<typeof watcher>): void {
  assert.notDeepEqual(
    watch.finished,
    watch.started,
    'the store answered in issue order, so this run proves nothing about ordering',
  )
}

/* ------------------------------------------------------------------- audit */

function auditEvent(index: number): AuditEvent {
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
  return {
    schema: 1,
    id: `event-${String(index).padStart(3, '0')}`,
    at,
    actor: 'mike@example.com',
    action: 'reviewer.created',
    reviewerId: 'anna',
    detail: `line ${index}`,
  }
}

function auditObjectPath(event: AuditEvent): string {
  return `${AUDIT_ROOT}/${event.at.replace(/[:.]/g, '-')}-${event.id}.json`
}

/**
 * A blob backend that serves a prepared audit page, slowly and out of order.
 *
 * `bodies` maps a pathname to what `readObject` should do with it: a string is
 * returned, `null` is a missing object, and an `Error` is *thrown* -- which is
 * the storage-read rejection the three call sites disagree about.
 */
function auditBackend(bodies: Map<string, string | null | Error>, watch = watcher()) {
  const pathnames = Array.from(bodies.keys())
  const backend: RosterBlobBackend = {
    async putObject() {
      throw new Error('not used by these tests')
    },
    async putObjectIfMatch() {
      throw new Error('not used by these tests')
    },
    async readObjectWithEtag() {
      return { body: null, etag: null }
    },
    async listPathnames(prefix) {
      return pathnames.filter((pathname) => pathname.startsWith(prefix))
    },
    async readObject(pathname) {
      return watch.run(pathname, () => {
        const answer = bodies.get(pathname)
        if (answer instanceof Error) throw answer
        return answer ?? null
      })
    },
  }
  return { backend, watch }
}

function auditPage(count: number): Map<string, string | null | Error> {
  const bodies = new Map<string, string | null | Error>()
  for (let index = 0; index < count; index += 1) {
    const event = auditEvent(index)
    bodies.set(auditObjectPath(event), `${JSON.stringify(event, null, 2)}\n`)
  }
  return bodies
}

test('the audit page is read eight at a time and never more', async () => {
  const { backend, watch } = auditBackend(auditPage(AUDIT_PAGE_SIZE))
  const store = createVercelBlobRosterStore({ backend })

  const events = await store.listAudit(AUDIT_PAGE_SIZE)

  assert.equal(events.length, AUDIT_PAGE_SIZE)
  assert.equal(watch.peak, ORDERED_READ_CONCURRENCY)
  assert.equal(watch.started.length, AUDIT_PAGE_SIZE)
})

test('a short audit page never has more reads in flight than there are objects', async () => {
  const { backend, watch } = auditBackend(auditPage(5))
  const store = createVercelBlobRosterStore({ backend })

  assert.equal((await store.listAudit(AUDIT_PAGE_SIZE)).length, 5)
  assert.equal(watch.peak, 5)
})

test('the audit page stays newest-first even though the store answers backwards', async () => {
  const { backend, watch } = auditBackend(auditPage(AUDIT_PAGE_SIZE))
  const store = createVercelBlobRosterStore({ backend })

  const events = await store.listAudit(AUDIT_PAGE_SIZE)

  assertAnsweredOutOfOrder(watch)
  assert.deepEqual(
    events.map((event) => event.id),
    upTo(AUDIT_PAGE_SIZE).reverse().map((index) => auditEvent(index).id),
  )
})

test('only `limit` audit objects are read, however many the store holds', async () => {
  const { backend, watch } = auditBackend(auditPage(60))
  const store = createVercelBlobRosterStore({ backend })

  const events = await store.listAudit(AUDIT_PAGE_SIZE)

  assert.equal(events.length, AUDIT_PAGE_SIZE)
  assert.equal(watch.started.length, AUDIT_PAGE_SIZE)
  // Newest first, so the forty read are events 59 down to 20.
  assert.equal(events[0].id, auditEvent(59).id)
  assert.equal(events[AUDIT_PAGE_SIZE - 1].id, auditEvent(20).id)
})

test('missing and malformed audit objects are skipped, not fatal', async () => {
  const bodies = auditPage(12)
  const pathnames = Array.from(bodies.keys())
  bodies.set(pathnames[2], null)
  bodies.set(pathnames[5], '{ not json')
  // Parses, but is not an audit event: no `detail`.
  bodies.set(pathnames[7], JSON.stringify({ schema: 1, id: 'x', at: '2026-01-01T00:00:00.000Z' }))

  const { backend, watch } = auditBackend(bodies)
  const events = await createVercelBlobRosterStore({ backend }).listAudit(AUDIT_PAGE_SIZE)

  assertAnsweredOutOfOrder(watch)
  assert.equal(events.length, 9)
  const skipped = new Set([pathnames[2], pathnames[5], pathnames[7]])
  for (const event of events) {
    assert.ok(!skipped.has(auditObjectPath(event)), 'a skipped object came back anyway')
  }
})

test('a storage read that rejects still rejects the whole audit page', async () => {
  const bodies = auditPage(20)
  const pathnames = Array.from(bodies.keys())
  bodies.set(pathnames[11], new Error('store unavailable'))

  const { backend } = auditBackend(bodies)
  await assert.rejects(
    () => createVercelBlobRosterStore({ backend }).listAudit(AUDIT_PAGE_SIZE),
    /store unavailable/,
  )
})

test('loadAdminView still shows the roster when the audit log cannot be read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-c6-audit-'))
  const saved = {
    REVIEWER_ROSTER_DRIVER: process.env.REVIEWER_ROSTER_DRIVER,
    REVIEWER_ROSTER_DIR: process.env.REVIEWER_ROSTER_DIR,
    REVIEWER_ROSTER: process.env.REVIEWER_ROSTER,
  }
  process.env.REVIEWER_ROSTER_DRIVER = 'fs'
  process.env.REVIEWER_ROSTER_DIR = dir
  delete process.env.REVIEWER_ROSTER
  __resetRosterStore()

  // A directory where the audit file belongs: it exists, and reading it throws.
  mkdirSync(join(dir, 'audit.ndjson'), { recursive: true })

  try {
    const view = await loadAdminView()
    assert.deepEqual(view.audit, [])
    assert.equal(view.driver, 'fs')
    assert.equal(view.writable, true)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    __resetRosterStore()
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ---------------------------------------------------------- request records */

const HEX24 = (seed: number): string => String(seed).padStart(2, '0').repeat(12).slice(0, 24)

function aRequest(index: number, overrides: Partial<ReviewerRequest> = {}): ReviewerRequest {
  return {
    schema: 1,
    id: HEX24(index % 100),
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    name: `Reader ${index}`,
    email: `reader${index}@example.com`,
    message: 'please',
    status: 'pending',
    reviewerId: null,
    books: [],
    decidedAt: null,
    decidedBy: null,
    activation: null,
    delivery: null,
    alertedAt: null,
    notificationId: null,
    ...overrides,
  }
}

function requestPathOf(request: ReviewerRequest): string {
  return `${REQUEST_RECORDS}/${request.id}.json`
}

/**
 * A private store that answers `read` slowly and backwards, and refuses
 * everything a read loop has no business doing.
 */
function readingStore(bodies: Map<string, string | null | Error>, watch = watcher()) {
  const order = Array.from(bodies.keys())
  const refuse = (): never => {
    throw new Error('a read loop must not write')
  }
  const store: PrivateStore = {
    driver: 'test',
    writable: false,
    provenAtomic: false,
    async read(path) {
      return watch.run(path, () => {
        const answer = bodies.get(path)
        if (answer instanceof Error) throw answer
        return answer ?? null
      })
    },
    async readVersioned(): Promise<VersionedObject> {
      return refuse()
    },
    async create(): Promise<CreateOutcome> {
      return refuse()
    },
    async writeIfMatch(): Promise<boolean> {
      return refuse()
    },
    async removeIfMatch(): Promise<boolean> {
      return refuse()
    },
    async list(prefix) {
      return order.filter((path) => path.startsWith(prefix))
    },
  }
  return { store, watch }
}

function requestRecords(count: number): {
  requests: ReviewerRequest[]
  bodies: Map<string, string | null | Error>
} {
  const requests: ReviewerRequest[] = []
  const bodies = new Map<string, string | null | Error>()
  for (let index = 0; index < count; index += 1) {
    const request = aRequest(index)
    requests.push(request)
    bodies.set(requestPathOf(request), `${JSON.stringify(request, null, 2)}\n`)
  }
  return { requests, bodies }
}

test('request records are read eight at a time and never more', async () => {
  const { bodies } = requestRecords(15)
  const { store, watch } = readingStore(bodies)

  const requests = await listRequests(store)

  assert.equal(requests.length, 15)
  assert.equal(watch.peak, ORDERED_READ_CONCURRENCY)
})

test('the waiting list stays newest-first even though the store answers backwards', async () => {
  const { requests, bodies } = requestRecords(15)
  const { store, watch } = readingStore(bodies)

  const listed = await listRequests(store)

  assertAnsweredOutOfOrder(watch)
  assert.deepEqual(
    listed.map((request) => request.id),
    [...requests].reverse().map((request) => request.id),
  )
})

test('missing and malformed request records are skipped, not fatal', async () => {
  const { bodies } = requestRecords(10)
  const paths = Array.from(bodies.keys())
  bodies.set(paths[1], null)
  bodies.set(paths[4], '{ not json')
  bodies.set(paths[8], JSON.stringify({ schema: 1, id: 'not-a-request-id' }))

  const { store } = readingStore(bodies)
  const listed = await listRequests(store)

  assert.equal(listed.length, 7)
})

test('one rejected read rejects the whole waiting list, never a partial one', async () => {
  const { bodies } = requestRecords(15)
  const paths = Array.from(bodies.keys())
  bodies.set(paths[9], new Error('store unavailable'))

  const { store } = readingStore(bodies)
  await assert.rejects(() => listRequests(store), /store unavailable/)
})

/* ------------------------------------------------------------ request views */

const EPOCH = 0
const NOW_MS = Date.UTC(2026, 0, 2)

function hashFor(index: number): string {
  return String.fromCharCode(97 + (index % 6)).repeat(64)
}

function credentialBody(index: number): string {
  const record: CredentialRecord = {
    schema: 1,
    purpose: 'activation',
    reviewerId: `reviewer-${index}`,
    requestId: null,
    operationId: 'a'.repeat(24),
    emailLabel: 'b'.repeat(32),
    credentialEpoch: EPOCH,
    issuedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    expiresAt: new Date(NOW_MS + 60 * 60 * 1000).toISOString(),
  }
  return `${JSON.stringify(record, null, 2)}\n`
}

/**
 * Fifteen requests, every one of them qualifying for the outstanding-activation
 * check: approved, with an active reviewer, an unspent activation hash, and a
 * live credential record. That is the shape runbook v5's V9 measures.
 */
function outstandingWorld(count = 15): {
  requests: ReviewerRequest[]
  reviewers: RosterReviewer[]
  bodies: Map<string, string | null | Error>
  hashes: string[]
} {
  const requests: ReviewerRequest[] = []
  const reviewers: RosterReviewer[] = []
  const bodies = new Map<string, string | null | Error>()
  const hashes: string[] = []

  for (let index = 0; index < count; index += 1) {
    // Distinct per request, so one request's credential path is nobody else's.
    const hash = `${String(index).padStart(2, '0').repeat(2)}${hashFor(index).slice(4)}`
    hashes.push(hash)
    requests.push(
      aRequest(index, {
        status: 'approved',
        reviewerId: `reviewer-${index}`,
        activation: { tokenHash: hash, operationId: null, expiresAt: null, usedAt: null },
      }),
    )
    reviewers.push(
      aReviewer({
        id: `reviewer-${index}`,
        name: `Reviewer ${index}`,
        // The roster refuses duplicate ids, addresses and code fingerprints, so
        // each of the fifteen has to be genuinely its own person.
        email: `reviewer${index}@example.com`,
        codeHash: `fingerprint-${index}`,
        credentialEpoch: EPOCH,
      }),
    )
    bodies.set(credentialPath('activation', hash), credentialBody(index))
    // Absent `used` marker: unspent, and therefore outstanding.
    bodies.set(usedPath('activation', hash), null)
  }

  return { requests, reviewers, bodies, hashes }
}

function rosterOf(reviewers: RosterReviewer[]): MemoryRosterStore {
  const roster = new MemoryRosterStore()
  roster.seed(reviewers)
  return roster
}

test('outstanding-activation checks run eight at a time and never more', async () => {
  const world = outstandingWorld()
  const { store, watch } = readingStore(world.bodies)

  const views = await loadRequestViews(world.requests, {
    store,
    rosterStore: rosterOf(world.reviewers),
    nowMs: NOW_MS,
  })

  assert.equal(views.length, 15)
  assert.ok(
    views.every((view) => view.activationOutstanding),
    'every seeded request should read as outstanding',
  )
  assert.equal(watch.peak, ORDERED_READ_CONCURRENCY)
})

test('request views keep their input order even though the store answers backwards', async () => {
  const world = outstandingWorld()
  const { store, watch } = readingStore(world.bodies)

  const views = await loadRequestViews(world.requests, {
    store,
    rosterStore: rosterOf(world.reviewers),
    nowMs: NOW_MS,
  })

  assertAnsweredOutOfOrder(watch)
  assert.deepEqual(
    views.map((view) => view.id),
    world.requests.map((request) => request.id),
  )
})

test('an outstanding-state failure stays local to its own request view', async () => {
  const world = outstandingWorld()
  // The seventh request's credential read fails; nobody else's does.
  world.bodies.set(credentialPath('activation', world.hashes[6]), new Error('store unavailable'))
  const { store } = readingStore(world.bodies)

  const views = await loadRequestViews(world.requests, {
    store,
    rosterStore: rosterOf(world.reviewers),
    nowMs: NOW_MS,
  })

  assert.equal(views.length, 15)
  assert.deepEqual(
    views.map((view) => view.id),
    world.requests.map((request) => request.id),
  )
  assert.equal(views[6].activationOutstanding, false)
  views.forEach((view, index) => {
    if (index !== 6) assert.equal(view.activationOutstanding, true, `view ${index} was lost`)
  })
})

test('a request whose reviewer is revoked is not checked at all', async () => {
  const world = outstandingWorld(10)
  const reviewers = world.reviewers.map((row, index) =>
    index === 3 ? { ...row, status: 'revoked' as const } : row,
  )
  const { store, watch } = readingStore(world.bodies)

  const views = await loadRequestViews(world.requests, {
    store,
    rosterStore: rosterOf(reviewers),
    nowMs: NOW_MS,
  })

  assert.equal(views[3].activationOutstanding, false)
  assert.equal(views[3].reviewerStatus, 'revoked')
  assert.ok(
    !watch.started.includes(credentialPath('activation', world.hashes[3])),
    'a revoked reviewer must not cost a credential read',
  )
})

/* --------------------------------------------- the post-commit response, kept */

test('a refresh that rejects never removes the committed result', async () => {
  const body = await reviewerMutationBody({ code: 'one-time' }, async () => {
    throw new Error('store unavailable')
  })

  assert.equal(body.ok, true)
  assert.equal(body.code, 'one-time')
  assert.equal(body.refreshed, false)
  assert.equal(body.refreshError, REFRESH_FAILED)
})

test('a refresh that never settles never removes the committed result', async () => {
  const body = await requestMutationBody(
    { sent: 'accepted' },
    () => new Promise<unknown[] | null>(() => {}),
    20,
  )

  assert.equal(body.ok, true)
  assert.equal(body.sent, 'accepted')
  assert.equal(body.refreshed, false)
  assert.equal(body.refreshError, REFRESH_TIMED_OUT)
})
