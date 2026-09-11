/**
 * The reviewer roster, as runtime state.
 *
 * Until now the roster was `REVIEWER_ROSTER`: a JSON array in an environment
 * variable, read at request time but changeable only by editing the deployment.
 * Adding a reviewer, widening what one may read, or revoking one all meant a
 * redeploy. That is the thing this module replaces.
 *
 * What it is NOT is a new piece of infrastructure. The store this writes to is
 * the *same private Vercel Blob store* the feature already uses for reviewer
 * feedback, reached through the same `@vercel/blob` dependency and the same
 * `BLOB_READ_WRITE_TOKEN` credential that is already configured. No new
 * service, no new account, no new paid plan, and nothing irreversible was
 * created to make this work -- which was a hard precondition of the assignment
 * that produced it.
 *
 * The shape of the store, and why:
 *
 *   One document. The roster is small -- a handful of people -- and every read
 *   wants all of it, so it is one JSON object at one fixed pathname rather than
 *   an object per reviewer. A roster is also a set: "who may read" is only
 *   meaningful whole, and a partial roster is a wrong answer rather than a
 *   smaller one.
 *
 *   Overwritten, deliberately. Unlike feedback -- which is evidence, and
 *   immutable -- the roster is current state, so the document is written with
 *   `allowOverwrite: true`. Its *history* is not lost, because every mutation
 *   also appends an immutable audit object that is never rewritten.
 *
 *   Private. Same private store, same rule: an object URL is not a capability.
 *   Reading requires the store credential, which exists only on the server.
 *
 *   No code, ever. A roster entry holds the same keyed HMAC fingerprint of an
 *   access code (`codeHash`) that the env roster held. The code itself is
 *   generated, shown to the administrator exactly once, and never written here,
 *   to a log, or to anything else.
 *
 * Concurrency, stated honestly: Vercel Blob offers no compare-and-swap, so
 * `save()` re-reads the document and refuses when `updatedAt` has moved under
 * it. That closes the window to the width of one read-modify-write rather than
 * to zero. For a dashboard with exactly one administrator this is sufficient,
 * and it is written down here rather than implied to be atomic.
 */

import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

if (typeof window !== 'undefined') {
  throw new Error(
    'lib/reviewer-roster is server-only and must not be imported by a client component',
  )
}

/** Layout version. It is part of every pathname, so a later layout is a new prefix. */
export const ROSTER_PREFIX_VERSION = 'v1'

/** Root of every object this module writes. */
export const ROSTER_ROOT = `roster/${ROSTER_PREFIX_VERSION}`

/** The one document that holds current state. */
export const ROSTER_DOCUMENT = `${ROSTER_ROOT}/roster.json`

/** Prefix under which immutable audit objects are appended. */
export const AUDIT_ROOT = `${ROSTER_ROOT}/audit`

/** Reviewer ids are used inside a dot-separated token, so their shape is constrained. */
const REVIEWER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** Book slugs appear in URLs and on disk, so their shape is constrained too. */
const BOOK_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Deliberately ordinary email validation.
 *
 * This address is never sent to, never used to authenticate a reviewer, and
 * never resolved: reviewer sign-in is code-only. It exists so Mike knows whose
 * code he is issuing. So the check is shape, not deliverability -- one `@`,
 * something either side, no whitespace -- and nothing here pretends to know
 * whether the mailbox is real.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/

export type ReviewerStatus = 'active' | 'revoked'

/** One reviewer, as the roster holds them. */
export type RosterReviewer = {
  /** Stable, non-secret identifier. Appears in the cookie and on feedback rows. */
  id: string
  /** Display name, shown to that reviewer and in the dashboard. */
  name: string
  /** Normalised address. Identification only -- never an authentication factor. */
  email: string
  /** Book slugs this reviewer may open. */
  books: string[]
  /** `revoked` reviewers fail every check immediately, including live sessions. */
  status: ReviewerStatus
  /** Keyed fingerprint of the current access code. Never the code. */
  codeHash: string
  /** ISO 8601, UTC. */
  createdAt: string
  /** When the current code was issued. Replacing a code moves this. */
  codeUpdatedAt: string
  /** Last time this reviewer was authorised, to the hour. Null until they sign in. */
  lastAccessAt: string | null
}

export type RosterDocument = {
  schema: 1
  /** ISO 8601, UTC. Also the optimistic-concurrency marker for `save()`. */
  updatedAt: string
  reviewers: RosterReviewer[]
}

/** What happened, who did it, and to whom. Never what the code was. */
export type AuditEvent = {
  schema: 1
  id: string
  at: string
  /** The administrator's verified email. The only actor that can mutate a roster. */
  actor: string
  action:
    | 'reviewer.created'
    | 'reviewer.renamed'
    | 'reviewer.entitlements-changed'
    | 'reviewer.code-replaced'
    | 'reviewer.revoked'
    | 'reviewer.restored'
  reviewerId: string
  /** One short human-readable line. Contains no code and no credential. */
  detail: string
}

export class RosterConflictError extends Error {
  constructor() {
    super('The roster changed while you were editing it. Reload and try again.')
    this.name = 'RosterConflictError'
  }
}

export class RosterReadOnlyError extends Error {
  constructor(driver: string) {
    super(`The "${driver}" roster driver cannot be edited at runtime.`)
    this.name = 'RosterReadOnlyError'
  }
}

/* ------------------------------------------------------------ normalisation */

/**
 * Normalise an address to the one form the roster stores and compares.
 *
 * Trimmed and lower-cased, and nothing else. Provider-specific folding -- Gmail
 * dots, `+` tags -- is deliberately NOT applied: guessing that two addresses are
 * the same mailbox is exactly the kind of cleverness that quietly merges two
 * different people. Two spellings are two entries, and Mike can see both.
 */
export function normalizeReviewerEmail(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.trim().toLowerCase()
}

export function isValidReviewerEmail(email: string): boolean {
  return email.length > 0 && email.length <= 254 && EMAIL_PATTERN.test(email)
}

export function isValidReviewerId(id: string): boolean {
  return REVIEWER_ID_PATTERN.test(id)
}

export function isValidBookSlug(slug: string): boolean {
  return BOOK_SLUG_PATTERN.test(slug)
}

/**
 * Derive a reviewer id from a name, for the dashboard's convenience.
 *
 * The administrator may always override it. Collisions are the caller's to
 * resolve -- this only proposes.
 */
export function suggestReviewerId(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return REVIEWER_ID_PATTERN.test(base) ? base : ''
}

/* -------------------------------------------------------------- parsing */

export function emptyRoster(): RosterDocument {
  return { schema: 1, updatedAt: new Date(0).toISOString(), reviewers: [] }
}

function isoOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : fallback
}

function asReviewer(value: unknown): RosterReviewer | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>

  const id = typeof row.id === 'string' ? row.id.trim() : ''
  const name = typeof row.name === 'string' ? row.name.trim() : ''
  const codeHash = typeof row.codeHash === 'string' ? row.codeHash.trim() : ''
  if (!REVIEWER_ID_PATTERN.test(id) || !name || !codeHash) return null

  // An entry written by the env roster has no email. It is identification, not
  // authentication, so its absence weakens nothing and is carried as empty.
  const email = normalizeReviewerEmail(row.email)

  if (!Array.isArray(row.books)) return null
  const books: string[] = []
  for (const slug of row.books) {
    if (typeof slug !== 'string' || !BOOK_SLUG_PATTERN.test(slug.trim())) return null
    books.push(slug.trim())
  }

  // Anything that is not exactly `revoked` is treated as active, so an entry
  // from an older shape keeps working. Revocation is never inferred.
  const status: ReviewerStatus = row.status === 'revoked' ? 'revoked' : 'active'

  const createdAt = isoOr(row.createdAt, new Date(0).toISOString())

  return {
    id,
    name,
    email,
    books,
    status,
    codeHash,
    createdAt,
    codeUpdatedAt: isoOr(row.codeUpdatedAt, createdAt),
    lastAccessAt:
      typeof row.lastAccessAt === 'string' && !Number.isNaN(Date.parse(row.lastAccessAt))
        ? row.lastAccessAt
        : null,
  }
}

/**
 * Parse a stored roster document.
 *
 * One malformed reviewer disqualifies the whole document, exactly as the env
 * roster behaved: serving a partial roster could hand someone the wrong
 * entitlements, or silently drop a revocation. Duplicate ids, duplicate
 * fingerprints and duplicate non-empty emails are all refused for the same
 * reason.
 */
export function parseRosterDocument(raw: string): RosterDocument | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const doc = parsed as Record<string, unknown>
  if (doc.schema !== 1) return null
  if (!Array.isArray(doc.reviewers)) return null

  const reviewers: RosterReviewer[] = []
  const seenIds = new Set<string>()
  const seenHashes = new Set<string>()
  const seenEmails = new Set<string>()

  for (const value of doc.reviewers) {
    const reviewer = asReviewer(value)
    if (!reviewer) return null
    if (seenIds.has(reviewer.id)) return null
    if (seenHashes.has(reviewer.codeHash)) return null
    if (reviewer.email && seenEmails.has(reviewer.email)) return null
    seenIds.add(reviewer.id)
    seenHashes.add(reviewer.codeHash)
    if (reviewer.email) seenEmails.add(reviewer.email)
    reviewers.push(reviewer)
  }

  return {
    schema: 1,
    updatedAt: isoOr(doc.updatedAt, new Date(0).toISOString()),
    reviewers,
  }
}

export function serializeRosterDocument(doc: RosterDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`
}

/**
 * The next value of `updatedAt`, guaranteed to be strictly greater than the
 * last one.
 *
 * `updatedAt` is doing two jobs: it is a human-readable "when did this last
 * change", and it is the marker `save()` compares to detect a concurrent write.
 * The second job is the one with a trap in it -- an ISO timestamp has
 * millisecond resolution, and two saves inside the same millisecond produce the
 * *same* string. A stale document would then compare equal to the current one
 * and be allowed to overwrite it, which is precisely the conflict the check
 * exists to catch.
 *
 * So the clock is used when it has moved, and nudged forward by a millisecond
 * when it has not. The value stays an ordinary timestamp, and it never repeats.
 */
export function nextUpdatedAt(previous: string, nowMs: number = Date.now()): string {
  const previousMs = Date.parse(previous)
  const baseline = Number.isFinite(previousMs) ? previousMs : 0
  return new Date(nowMs > baseline ? nowMs : baseline + 1).toISOString()
}

/* ------------------------------------------------------------- the boundary */

export type ReviewerRosterStore = {
  /** Short driver name, for diagnostics. Never includes a credential. */
  readonly driver: string
  /** Whether the dashboard may mutate this roster at runtime. */
  readonly writable: boolean
  load(): Promise<RosterDocument>
  /**
   * Replace the document.
   *
   * `expectedUpdatedAt` is the `updatedAt` the caller read. When the stored
   * document has moved on, this throws `RosterConflictError` rather than
   * overwriting somebody else's change.
   */
  save(next: RosterDocument, expectedUpdatedAt: string): Promise<RosterDocument>
  appendAudit(event: AuditEvent): Promise<void>
  /** Most recent first. */
  listAudit(limit: number): Promise<AuditEvent[]>
}

export function newAuditEvent(
  actor: string,
  action: AuditEvent['action'],
  reviewerId: string,
  detail: string,
): AuditEvent {
  return {
    schema: 1,
    id: randomUUID(),
    at: new Date().toISOString(),
    actor,
    action,
    reviewerId,
    detail,
  }
}

function asAuditEvent(value: unknown): AuditEvent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (row.schema !== 1) return null
  if (typeof row.id !== 'string' || typeof row.actor !== 'string') return null
  if (typeof row.at !== 'string' || Number.isNaN(Date.parse(row.at))) return null
  if (typeof row.action !== 'string' || typeof row.reviewerId !== 'string') return null
  if (typeof row.detail !== 'string') return null
  return value as AuditEvent
}

/** The pathname of one audit object. Timestamp first, so a listing is chronological. */
export function auditPathname(event: AuditEvent): string {
  return `${AUDIT_ROOT}/${event.at.replace(/[:.]/g, '-')}-${event.id}.json`
}

/* ------------------------------------------------------ read-only env driver */

/**
 * The roster as it was: `REVIEWER_ROSTER`, read-only.
 *
 * Kept so a deployment that has not been given a writable store keeps working
 * exactly as before rather than losing its reviewers. The dashboard refuses to
 * mutate it and says why, instead of appearing to save and silently discarding
 * the change on the next cold start.
 */
class EnvRosterStore implements ReviewerRosterStore {
  readonly driver = 'env'
  readonly writable = false

  async load(): Promise<RosterDocument> {
    const source = (process.env.REVIEWER_ROSTER ?? '').trim()
    if (!source) return emptyRoster()

    // The env roster is a bare array; wrap it in the document shape and let the
    // one parser above decide whether every entry is acceptable.
    let parsed: unknown
    try {
      parsed = JSON.parse(source)
    } catch {
      return emptyRoster()
    }
    if (!Array.isArray(parsed)) return emptyRoster()

    return (
      parseRosterDocument(
        JSON.stringify({ schema: 1, updatedAt: new Date(0).toISOString(), reviewers: parsed }),
      ) ?? emptyRoster()
    )
  }

  async save(): Promise<RosterDocument> {
    throw new RosterReadOnlyError(this.driver)
  }

  async appendAudit(): Promise<void> {
    throw new RosterReadOnlyError(this.driver)
  }

  async listAudit(): Promise<AuditEvent[]> {
    return []
  }
}

/* --------------------------------------------------- unconfigured (default) */

/**
 * No roster at all.
 *
 * Every check against it fails, which is the correct behaviour for a
 * deployment that has not been configured: nobody is admitted. Reading is not
 * an error -- there genuinely are no reviewers -- but writing is refused
 * loudly rather than accepted and dropped.
 */
class UnconfiguredRosterStore implements ReviewerRosterStore {
  readonly driver = 'unconfigured'
  readonly writable = false

  async load(): Promise<RosterDocument> {
    return emptyRoster()
  }

  async save(): Promise<RosterDocument> {
    throw new RosterReadOnlyError(this.driver)
  }

  async appendAudit(): Promise<void> {
    throw new RosterReadOnlyError(this.driver)
  }

  async listAudit(): Promise<AuditEvent[]> {
    return []
  }
}

/* -------------------------------------------------------- filesystem driver */

/**
 * A JSON document and an append-only audit log on disk.
 *
 * Durable wherever the filesystem is -- local development, a self-hosted
 * server, a host with a persistent volume -- and NOT durable on a serverless
 * host. It is the driver the tests drive, and the one Mike runs against
 * locally, so the dashboard can be exercised end to end without touching a
 * production store.
 */
class FileSystemRosterStore implements ReviewerRosterStore {
  readonly driver = 'fs'
  readonly writable = true

  private readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  private get documentPath(): string {
    return join(this.root, 'roster.json')
  }

  private get auditPath(): string {
    return join(this.root, 'audit.ndjson')
  }

  async load(): Promise<RosterDocument> {
    if (!existsSync(this.documentPath)) return emptyRoster()
    const raw = readFileSync(this.documentPath, 'utf8')
    const parsed = parseRosterDocument(raw)
    if (!parsed) {
      // A document that does not parse is a configuration fault, not an empty
      // roster. Saying so is what keeps a corrupted file from reading as
      // "nobody has access" and then being overwritten with that.
      throw new Error('the stored roster document is malformed')
    }
    return parsed
  }

  async save(next: RosterDocument, expectedUpdatedAt: string): Promise<RosterDocument> {
    const current = await this.load()
    if (current.updatedAt !== expectedUpdatedAt) throw new RosterConflictError()

    const written: RosterDocument = {
      ...next,
      schema: 1,
      updatedAt: nextUpdatedAt(current.updatedAt),
    }
    mkdirSync(dirname(this.documentPath), { recursive: true })
    writeFileSync(this.documentPath, serializeRosterDocument(written), 'utf8')
    return written
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    mkdirSync(dirname(this.auditPath), { recursive: true })
    appendFileSync(this.auditPath, `${JSON.stringify(event)}\n`, 'utf8')
  }

  async listAudit(limit: number): Promise<AuditEvent[]> {
    if (!existsSync(this.auditPath)) return []
    const events: AuditEvent[] = []
    for (const line of readFileSync(this.auditPath, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      try {
        const event = asAuditEvent(JSON.parse(line))
        if (event) events.push(event)
      } catch {
        continue
      }
    }
    events.sort((a, b) => (a.at === b.at ? b.id.localeCompare(a.id) : b.at.localeCompare(a.at)))
    return events.slice(0, limit)
  }
}

/* ------------------------------------------------------- vercel blob driver */

/**
 * The narrow slice of Vercel Blob this driver uses.
 *
 * Declared here for the same two reasons the feedback driver declares one: the
 * SDK's wider surface stays out of reach, and the driver's behaviour can be
 * tested against a store that misbehaves on purpose.
 */
export type RosterBlobBackend = {
  /** Write one object, replacing it when `overwrite` is true. */
  putObject(pathname: string, body: string, overwrite: boolean): Promise<void>
  /** Every pathname beneath a prefix, following pagination to the end. */
  listPathnames(prefix: string): Promise<string[]>
  /**
   * One object's bytes, or `null` when the store answered and it is not there.
   *
   * A storage, network or credential failure must *reject*. Reporting it as
   * `null` would turn an outage into "the roster is empty", and an empty
   * roster is a roster that admits nobody -- or, worse, one that a subsequent
   * save would persist over the real one.
   */
  readObject(pathname: string): Promise<string | null>
}

export function createRosterBlobBackend(token: string): RosterBlobBackend {
  return {
    async putObject(pathname, body, overwrite) {
      const { put } = await import('@vercel/blob')
      await put(pathname, body, {
        token,
        access: 'private',
        contentType: 'application/json; charset=utf-8',
        allowOverwrite: overwrite,
        addRandomSuffix: false,
      })
    },

    async listPathnames(prefix) {
      const { list } = await import('@vercel/blob')
      const pathnames: string[] = []
      let cursor: string | undefined
      for (;;) {
        const page = await list({ token, prefix, cursor })
        for (const blob of page.blobs) pathnames.push(blob.pathname)
        if (!page.hasMore || !page.cursor) break
        cursor = page.cursor
      }
      return pathnames
    },

    async readObject(pathname) {
      const { get } = await import('@vercel/blob')
      const result = await get(pathname, {
        token,
        access: 'private',
        // A revocation made a moment ago must be readable a moment later.
        // Serving a cached roster would keep a revoked reviewer reading.
        useCache: false,
      })
      if (!result?.stream) return null
      return await new Response(result.stream).text()
    },
  }
}

class VercelBlobRosterStore implements ReviewerRosterStore {
  readonly driver = 'vercel-blob'
  readonly writable = true

  private readonly backend: RosterBlobBackend

  constructor(backend: RosterBlobBackend) {
    this.backend = backend
  }

  async load(): Promise<RosterDocument> {
    const raw = await this.backend.readObject(ROSTER_DOCUMENT)
    // `null` is the honest empty case: the store answered and no roster has
    // been written yet. A failure to reach the store throws, above.
    if (raw === null) return emptyRoster()
    const parsed = parseRosterDocument(raw)
    if (!parsed) throw new Error('the stored roster document is malformed')
    return parsed
  }

  async save(next: RosterDocument, expectedUpdatedAt: string): Promise<RosterDocument> {
    // Re-read immediately before writing. This is not compare-and-swap -- the
    // store offers none -- it narrows the window to one round trip and refuses
    // the obvious conflict instead of silently winning it.
    const current = await this.load()
    if (current.updatedAt !== expectedUpdatedAt) throw new RosterConflictError()

    const written: RosterDocument = {
      ...next,
      schema: 1,
      updatedAt: nextUpdatedAt(current.updatedAt),
    }
    await this.backend.putObject(ROSTER_DOCUMENT, serializeRosterDocument(written), true)
    return written
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    // Immutable, like feedback: history is evidence, and evidence is not
    // edited in place.
    await this.backend.putObject(auditPathname(event), `${JSON.stringify(event, null, 2)}\n`, false)
  }

  async listAudit(limit: number): Promise<AuditEvent[]> {
    const pathnames = await this.backend.listPathnames(`${AUDIT_ROOT}/`)
    // Chronological by pathname, newest first, so only `limit` objects are read.
    pathnames.sort((a, b) => b.localeCompare(a))

    const events: AuditEvent[] = []
    for (const pathname of pathnames.slice(0, limit)) {
      const raw = await this.backend.readObject(pathname)
      if (raw === null) continue
      try {
        const event = asAuditEvent(JSON.parse(raw))
        if (event) events.push(event)
      } catch {
        continue
      }
    }
    events.sort((a, b) => (a.at === b.at ? b.id.localeCompare(a.id) : b.at.localeCompare(a.at)))
    return events
  }
}

export function createVercelBlobRosterStore(options: {
  token?: string
  backend?: RosterBlobBackend
}): ReviewerRosterStore {
  const backend =
    options.backend ??
    createRosterBlobBackend(
      (() => {
        const token = (options.token ?? '').trim()
        if (!token) {
          throw new Error('REVIEWER_ROSTER_DRIVER=vercel-blob requires BLOB_READ_WRITE_TOKEN')
        }
        return token
      })(),
    )
  return new VercelBlobRosterStore(backend)
}

/* ----------------------------------------------------------------- factory */

let store: ReviewerRosterStore | null = null

/**
 * The configured roster store for this process.
 *
 * Selection is explicit, with one deliberate exception: a deployment that sets
 * no driver but still has a `REVIEWER_ROSTER` gets the read-only env driver, so
 * upgrading this code does not lock out the reviewers a deployment already had.
 * Everything else that is unset fails closed to a roster of nobody.
 */
export function createRosterStore(): ReviewerRosterStore {
  if (store) return store

  const driver = (process.env.REVIEWER_ROSTER_DRIVER ?? '').trim().toLowerCase()

  if (driver === 'fs') {
    const dir = (process.env.REVIEWER_ROSTER_DIR ?? '').trim()
    if (!dir) throw new Error('REVIEWER_ROSTER_DRIVER=fs requires REVIEWER_ROSTER_DIR')
    store = new FileSystemRosterStore(dir)
  } else if (driver === 'vercel-blob') {
    store = createVercelBlobRosterStore({ token: process.env.BLOB_READ_WRITE_TOKEN })
  } else if (driver === 'env') {
    store = new EnvRosterStore()
  } else if (!driver && (process.env.REVIEWER_ROSTER ?? '').trim()) {
    store = new EnvRosterStore()
  } else {
    store = new UnconfiguredRosterStore()
  }

  return store
}

/** Test seam. Resets the memoised store so a test can drive each driver. */
export function __resetRosterStore(): void {
  store = null
}

/**
 * A short, non-reversible digest of an access code, for one purpose only:
 * proving in a test that two values differ without writing either one down.
 * It is never stored and never logged.
 */
export function codeDigest(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex').slice(0, 12)
}
