import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { mintReviewerToken } from '../lib/reviewer-access.ts'
import {
  authorizeReviewer,
  identifyReviewerFromStore,
  isReviewerAccessLive,
  toReviewer,
} from '../lib/reviewer-authorization.ts'
import { createReviewer, loadAdminView } from '../lib/reviewer-admin.ts'
import { requestSigninLink } from '../lib/reviewer-onboarding.ts'
import {
  RosterUnreadableError,
  __resetRosterStore,
  createRosterStore,
  createVercelBlobRosterStore,
  parseRosterDocument,
  type RosterBlobBackend,
} from '../lib/reviewer-roster.ts'
import type { Mailer } from '../lib/mailer.ts'

/*
 * C2-1: the roster's `status` field, on both sides of its boundary.
 *
 * The partition this parser draws is three-way, and every region is exercised:
 *
 *   absent key            -> active (legacy compatibility; the one default)
 *   exactly 'active'      -> active
 *   exactly 'revoked'     -> revoked
 *   any other present     -> the whole document is refused
 *
 * The last region used to read as active. The control that matters most is the
 * authorization one below: an intended revocation, mistyped, must not leave a
 * working session behind it.
 *
 * No identity, code, token or roster body is printed by any assertion here;
 * every message names only the status shape under test.
 */

const SECRET = 'roster-status-test-secret-not-used-by-any-deployment'
const ACTOR = 'owner@example.test'
const BOOK = 'the-backward-becoming'

/** Every present value that is not exactly `active` or `revoked`. */
const MALFORMED_PRESENT: Array<[label: string, value: unknown]> = [
  ['"Revoked"', 'Revoked'],
  ['"REVOKED"', 'REVOKED'],
  ['"ACTIVE"', 'ACTIVE'],
  ['"Active"', 'Active'],
  ['"revokd"', 'revokd'],
  ['"disabled"', 'disabled'],
  ['" revoked"', ' revoked'],
  ['"revoked "', 'revoked '],
  ['""', ''],
  ['null', null],
  ['true', true],
  ['false', false],
  ['0', 0],
  ['1', 1],
  ['[]', []],
  ['["revoked"]', ['revoked']],
  ['{}', {}],
  ['{"status":"revoked"}', { status: 'revoked' }],
]

function entry(status: { present: false } | { present: true; value: unknown }, id = 'rev-a') {
  const row: Record<string, unknown> = {
    id,
    name: 'Reviewer',
    books: [BOOK],
    codeHash: `fingerprint-${id}`,
  }
  if (status.present) row.status = status.value
  return row
}

function documentOf(rows: Array<Record<string, unknown>>): string {
  return JSON.stringify({ schema: 1, updatedAt: '2026-01-01T00:00:00.000Z', reviewers: rows })
}

/* ------------------------------------------------------------- the parser */

test('C2-1 parser: an absent status is the legacy default, active', () => {
  const parsed = parseRosterDocument(documentOf([entry({ present: false })]))
  assert.ok(parsed, 'an entry with no status key is not malformed')
  assert.equal(parsed.reviewers[0].status, 'active')
})

test('C2-1 parser: exactly "active" and exactly "revoked" are the two accepted values', () => {
  const active = parseRosterDocument(documentOf([entry({ present: true, value: 'active' })]))
  const revoked = parseRosterDocument(documentOf([entry({ present: true, value: 'revoked' })]))
  assert.equal(active?.reviewers[0].status, 'active')
  assert.equal(revoked?.reviewers[0].status, 'revoked')
})

test('C2-1 parser: every other present status refuses the whole document', () => {
  for (const [label, value] of MALFORMED_PRESENT) {
    // Alone ...
    assert.equal(
      parseRosterDocument(documentOf([entry({ present: true, value })])),
      null,
      `status ${label} must refuse the document`,
    )
    // ... and beside a perfectly good entry, which must not survive it: a
    // partial roster could be a roster with a revocation missing.
    assert.equal(
      parseRosterDocument(
        documentOf([entry({ present: false }, 'rev-b'), entry({ present: true, value }, 'rev-a')]),
      ),
      null,
      `status ${label} beside a valid entry must still refuse the document`,
    )
  }
})

test('C2-1 parser: what this application writes still round-trips', () => {
  // The writers emit exactly 'active' and 'revoked'; tightening the parser
  // cannot reject a document it produced.
  for (const value of ['active', 'revoked'] as const) {
    const raw = documentOf([entry({ present: true, value })])
    const parsed = parseRosterDocument(raw)
    assert.ok(parsed)
    assert.equal(parseRosterDocument(JSON.stringify(parsed))?.reviewers[0].status, value)
  }
})

/* ------------------------------------------------------------- the drivers */

function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  __resetRosterStore()
  return run().finally(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    __resetRosterStore()
  })
}

test('C2-1 env driver: a malformed present status is an unreadable roster, not an active reviewer', async () => {
  for (const [label, value] of MALFORMED_PRESENT) {
    const { id, name, books, codeHash } = entry({ present: false })
    await withEnv(
      {
        REVIEWER_ROSTER_DRIVER: 'env',
        REVIEWER_ROSTER: JSON.stringify([{ id, name, books, codeHash, status: value }]),
        REVIEWER_AUTH_SECRET: SECRET,
      },
      async () => {
        await assert.rejects(
          () => createRosterStore().load(),
          (error: Error) => error instanceof RosterUnreadableError,
          `env status ${label}`,
        )
        assert.equal(await isReviewerAccessLive(), false, `env status ${label} is not live access`)
      },
    )
  }
})

test('C2-1 env driver: the legacy shape with no status still loads as active', async () => {
  const { id, name, books, codeHash } = entry({ present: false })
  await withEnv(
    {
      REVIEWER_ROSTER_DRIVER: 'env',
      REVIEWER_ROSTER: JSON.stringify([{ id, name, books, codeHash }]),
    },
    async () => {
      const loaded = await createRosterStore().load()
      assert.equal(loaded.reviewers.length, 1)
      assert.equal(loaded.reviewers[0].status, 'active')
    },
  )
})

test('C2-1 fs driver: a malformed present status is an error, never a roster', async () => {
  for (const [label, value] of MALFORMED_PRESENT) {
    const dir = mkdtempSync(join(tmpdir(), 'rv-status-fs-'))
    try {
      writeFileSync(join(dir, 'roster.json'), documentOf([entry({ present: true, value })]))
      await withEnv({ REVIEWER_ROSTER_DRIVER: 'fs', REVIEWER_ROSTER_DIR: dir }, async () => {
        await assert.rejects(() => createRosterStore().load(), /malformed/, `fs status ${label}`)
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

function readOnlyBackend(body: string): RosterBlobBackend & { writes: number } {
  const backend = {
    writes: 0,
    async putObject() {
      backend.writes += 1
    },
    async putObjectIfMatch() {
      backend.writes += 1
      return true
    },
    async readObjectWithEtag() {
      return { body, etag: 'etag-1' }
    },
    async listPathnames() {
      return []
    },
    async readObject() {
      return body
    },
  }
  return backend
}

test('C2-1 blob driver: a malformed present status is an error, and nothing is written', async () => {
  for (const [label, value] of MALFORMED_PRESENT) {
    const backend = readOnlyBackend(documentOf([entry({ present: true, value })]))
    const store = createVercelBlobRosterStore({ backend })
    await assert.rejects(() => store.load(), /malformed/, `blob status ${label}`)
    await assert.rejects(() => store.loadForUpdate(), /malformed/, `blob status ${label}`)
    assert.equal(backend.writes, 0, `blob status ${label} wrote`)
  }
  // Positive control on the same seam: absent and exact values load.
  for (const status of [{ present: false } as const, { present: true, value: 'revoked' } as const]) {
    const store = createVercelBlobRosterStore({ backend: readOnlyBackend(documentOf([entry(status)])) })
    assert.equal((await store.load()).reviewers.length, 1)
  }
})

/* ------------------------------------------ authorization, admin, onboarding */

async function withFsRoster(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'rv-status-auth-'))
  try {
    await withEnv(
      {
        REVIEWER_AUTH_SECRET: SECRET,
        REVIEWER_ROSTER_DRIVER: 'fs',
        REVIEWER_ROSTER_DIR: dir,
        REVIEWER_ROSTER: undefined,
      },
      () => run(dir),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Rewrite the one stored entry's `status` exactly as a hand edit would. */
function handEditStatus(dir: string, status: { present: false } | { present: true; value: unknown }) {
  const path = join(dir, 'roster.json')
  const document = JSON.parse(readFileSync(path, 'utf8')) as { reviewers: Record<string, unknown>[] }
  for (const row of document.reviewers) {
    if (status.present) row.status = status.value
    else delete row.status
  }
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`)
  __resetRosterStore()
}

function recordingMailer(): Mailer & { sent: number } {
  const mailer = {
    driver: 'recording',
    sent: 0,
    async send() {
      mailer.sent += 1
      return { status: 'accepted' as const, providerId: null, error: null }
    },
  }
  return mailer as Mailer & { sent: number }
}

test('C2-1 authorization: a mistyped revocation cannot leave an active reviewer behind', async () => {
  for (const [label, value] of MALFORMED_PRESENT) {
    await withFsRoster(async (dir) => {
      const { issued } = await createReviewer(
        { name: 'Status Probe', email: 'probe@example.test', books: [BOOK] },
        ACTOR,
      )
      const entryNow = (await createRosterStore().load()).reviewers[0]
      const session = await mintReviewerToken(toReviewer(entryNow))
      assert.ok(session)
      assert.ok(await authorizeReviewer(session), 'control: the session is live before the edit')

      // The owner meant to revoke, and wrote something that is not `revoked`.
      handEditStatus(dir, { present: true, value })

      // Fail-closed means no reviewer comes back: a refusal to answer (throw)
      // or a refusal (null) are both acceptable; a reviewer is not.
      let authorized: unknown = null
      try {
        authorized = await authorizeReviewer(session)
      } catch {
        authorized = null
      }
      assert.equal(authorized, null, `status ${label} kept a live session`)

      let identified: unknown = null
      try {
        identified = await identifyReviewerFromStore(issued.code)
      } catch {
        identified = null
      }
      assert.equal(identified, null, `status ${label} still admitted the access code`)
      assert.equal(await isReviewerAccessLive(), false, `status ${label} reads as live access`)
    })
  }
})

test('C2-1 authorization: both exact values and the absent default keep their meaning', async () => {
  await withFsRoster(async (dir) => {
    await createReviewer({ name: 'Status Probe', email: 'probe@example.test', books: [BOOK] }, ACTOR)
    const session = await mintReviewerToken(toReviewer((await createRosterStore().load()).reviewers[0]))
    assert.ok(session)

    handEditStatus(dir, { present: false })
    assert.ok(await authorizeReviewer(session), 'absent status is legacy active')

    handEditStatus(dir, { present: true, value: 'active' })
    assert.ok(await authorizeReviewer(session), 'exact active authorizes')

    handEditStatus(dir, { present: true, value: 'revoked' })
    assert.equal(await authorizeReviewer(session), null, 'exact revoked refuses')
  })
})

test('C2-1 admin and onboarding reads fail closed on a malformed present status', async () => {
  await withFsRoster(async (dir) => {
    await createReviewer({ name: 'Status Probe', email: 'probe@example.test', books: [BOOK] }, ACTOR)
    handEditStatus(dir, { present: true, value: 'Revoked' })

    await assert.rejects(() => loadAdminView(), 'the admin view must not render a guessed roster')

    const mailer = recordingMailer()
    await assert.rejects(
      () => requestSigninLink('probe@example.test', { mailer }),
      'onboarding must not decide from a guessed roster',
    )
    assert.equal(mailer.sent, 0, 'nothing may be mailed from a malformed roster')
  })
})
