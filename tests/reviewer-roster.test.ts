import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  RosterConflictError,
  RosterReadOnlyError,
  __resetRosterStore,
  createRosterStore,
  createVercelBlobRosterStore,
  emptyRoster,
  isValidReviewerEmail,
  newAuditEvent,
  normalizeReviewerEmail,
  parseRosterDocument,
  serializeRosterDocument,
  suggestReviewerId,
  type RosterBlobBackend,
  type RosterDocument,
  type RosterReviewer,
} from '../lib/reviewer-roster.ts'

/*
 * The roster is the thing that decides who may read an unpublished manuscript,
 * so these tests care about two properties above all others: it never admits
 * anybody it should not, and it never quietly reports "empty" when it actually
 * failed to find out. An empty roster admits nobody, which sounds safe -- but a
 * dashboard that believes the roster is empty will happily save over the real
 * one, and that is how a revocation becomes a restoration.
 */

function reviewer(overrides: Partial<RosterReviewer> = {}): RosterReviewer {
  return {
    id: 'anna',
    name: 'Anna',
    email: 'anna@example.com',
    books: ['the-backward-becoming'],
    status: 'active',
    codeHash: 'fingerprint-anna',
    createdAt: '2026-01-01T00:00:00.000Z',
    codeUpdatedAt: '2026-01-01T00:00:00.000Z',
    lastAccessAt: null,
    ...overrides,
  }
}

function doc(reviewers: RosterReviewer[], updatedAt = '2026-01-01T00:00:00.000Z'): RosterDocument {
  return { schema: 1, updatedAt, reviewers }
}

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

/* ------------------------------------------------------------ normalisation */

test('an address is trimmed and lower-cased, and nothing else', () => {
  assert.equal(normalizeReviewerEmail('  Anna@Example.COM '), 'anna@example.com')
  // Deliberately NOT folded: two spellings are two people until Mike says
  // otherwise.
  assert.equal(normalizeReviewerEmail('a.n.n.a@gmail.com'), 'a.n.n.a@gmail.com')
  assert.equal(normalizeReviewerEmail('anna+drafts@gmail.com'), 'anna+drafts@gmail.com')
  assert.equal(normalizeReviewerEmail(undefined), '')
})

test('an address has to look like one', () => {
  assert.ok(isValidReviewerEmail('anna@example.com'))
  assert.ok(isValidReviewerEmail('a@b.co'))
  assert.ok(!isValidReviewerEmail('anna'))
  assert.ok(!isValidReviewerEmail('anna@localhost'))
  assert.ok(!isValidReviewerEmail('anna @example.com'))
  assert.ok(!isValidReviewerEmail(''))
})

test('an identifier is suggested from a name, or refused', () => {
  assert.equal(suggestReviewerId('Anna Vasquez'), 'anna-vasquez')
  assert.equal(suggestReviewerId('  Mike   Ramsey Jr '), 'mike-ramsey-jr')
  // Nothing usable survives, so nothing is proposed rather than something wrong.
  assert.equal(suggestReviewerId('...'), '')
})

/* ----------------------------------------------------------------- parsing */

test('a well-formed document round-trips', () => {
  const original = doc([reviewer()])
  const parsed = parseRosterDocument(serializeRosterDocument(original))
  assert.deepEqual(parsed, original)
})

test('one malformed reviewer disqualifies the whole document', () => {
  // Partial is worse than refused: a dropped entry could be a dropped
  // revocation, and a dropped revocation is somebody still reading.
  const raw = JSON.stringify({
    schema: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    reviewers: [reviewer(), { id: 'ben', name: 'Ben' }],
  })
  assert.equal(parseRosterDocument(raw), null)
})

test('duplicate ids, fingerprints and addresses are all refused', () => {
  const pairs: RosterReviewer[][] = [
    [reviewer(), reviewer({ codeHash: 'other', email: 'b@example.com' })],
    [reviewer(), reviewer({ id: 'ben', email: 'b@example.com' })],
    [reviewer(), reviewer({ id: 'ben', codeHash: 'other' })],
  ]
  for (const reviewers of pairs) {
    assert.equal(parseRosterDocument(JSON.stringify(doc(reviewers))), null)
  }
})

test('an entry from the older shape is read as active, never as revoked', () => {
  // The env roster had no `status`. Inferring revocation from its absence would
  // lock out every reviewer a deployment already had.
  const raw = JSON.stringify({
    schema: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    reviewers: [{ id: 'anna', name: 'Anna', books: [], codeHash: 'fp' }],
  })
  const parsed = parseRosterDocument(raw)
  assert.equal(parsed?.reviewers[0].status, 'active')
  assert.equal(parsed?.reviewers[0].email, '')
})

test('a revoked entry stays revoked through a round trip', () => {
  const parsed = parseRosterDocument(serializeRosterDocument(doc([reviewer({ status: 'revoked' })])))
  assert.equal(parsed?.reviewers[0].status, 'revoked')
})

test('a wrong schema, wrong shape or unparseable document is refused', () => {
  assert.equal(parseRosterDocument('not json'), null)
  assert.equal(parseRosterDocument('[]'), null)
  assert.equal(parseRosterDocument(JSON.stringify({ schema: 2, reviewers: [] })), null)
  assert.equal(parseRosterDocument(JSON.stringify({ schema: 1 })), null)
})

test('a book slug that could escape a path is refused', () => {
  for (const slug of ['../secret', 'a/b', 'UPPER', '']) {
    assert.equal(parseRosterDocument(JSON.stringify(doc([reviewer({ books: [slug] })]))), null)
  }
})

/* ------------------------------------------------------------- env driver */

test('the env driver reads the old roster and refuses every write', async () => {
  await withEnv(
    {
      REVIEWER_ROSTER_DRIVER: 'env',
      REVIEWER_ROSTER: JSON.stringify([
        { id: 'anna', name: 'Anna', books: ['the-backward-becoming'], codeHash: 'fp-anna' },
      ]),
    },
    async () => {
      const store = createRosterStore()
      assert.equal(store.driver, 'env')
      assert.equal(store.writable, false)

      const loaded = await store.load()
      assert.equal(loaded.reviewers.length, 1)
      assert.equal(loaded.reviewers[0].status, 'active')

      await assert.rejects(
        () => store.save(loaded, loaded.updatedAt),
        (error: Error) => error instanceof RosterReadOnlyError,
      )
      await assert.rejects(
        () => store.appendAudit(newAuditEvent('mike@example.com', 'reviewer.revoked', 'anna', 'x')),
        (error: Error) => error instanceof RosterReadOnlyError,
      )
    },
  )
})

test('an unconfigured deployment gets a roster of nobody, and cannot be written to', async () => {
  await withEnv(
    { REVIEWER_ROSTER_DRIVER: undefined, REVIEWER_ROSTER: undefined },
    async () => {
      const store = createRosterStore()
      assert.equal(store.driver, 'unconfigured')
      assert.equal(store.writable, false)
      assert.deepEqual((await store.load()).reviewers, [])
      await assert.rejects(() => store.save(emptyRoster(), emptyRoster().updatedAt))
    },
  )
})

test('a deployment with only the old REVIEWER_ROSTER keeps its reviewers', async () => {
  // Upgrading this code must not lock anybody out on the next deploy.
  await withEnv(
    {
      REVIEWER_ROSTER_DRIVER: undefined,
      REVIEWER_ROSTER: JSON.stringify([
        { id: 'anna', name: 'Anna', books: [], codeHash: 'fp-anna' },
      ]),
    },
    async () => {
      const store = createRosterStore()
      assert.equal(store.driver, 'env')
      assert.equal((await store.load()).reviewers.length, 1)
    },
  )
})

/* -------------------------------------------------------------- fs driver */

test('the fs driver stores a roster and reads it back exactly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-roster-'))
  try {
    await withEnv(
      { REVIEWER_ROSTER_DRIVER: 'fs', REVIEWER_ROSTER_DIR: dir },
      async () => {
        const store = createRosterStore()
        assert.equal(store.writable, true)

        const before = await store.load()
        const saved = await store.save(doc([reviewer()]), before.updatedAt)
        assert.equal(saved.reviewers.length, 1)

        __resetRosterStore()
        const reloaded = await createRosterStore().load()
        assert.deepEqual(reloaded.reviewers, saved.reviewers)
        assert.equal(reloaded.updatedAt, saved.updatedAt)
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a stale write is refused rather than allowed to clobber', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-roster-'))
  try {
    await withEnv(
      { REVIEWER_ROSTER_DRIVER: 'fs', REVIEWER_ROSTER_DIR: dir },
      async () => {
        const store = createRosterStore()
        const first = await store.save(doc([reviewer()]), (await store.load()).updatedAt)

        // Somebody else revokes in between.
        await store.save({ ...first, reviewers: [reviewer({ status: 'revoked' })] }, first.updatedAt)

        // This caller is still holding the pre-revocation document. Letting it
        // win would silently un-revoke somebody.
        await assert.rejects(
          () => store.save({ ...first, reviewers: [reviewer({ name: 'Renamed' })] }, first.updatedAt),
          (error: Error) => error instanceof RosterConflictError,
        )

        assert.equal((await store.load()).reviewers[0].status, 'revoked')
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt roster file is an error, never an empty roster', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-roster-'))
  try {
    writeFileSync(join(dir, 'roster.json'), '{ this is not json', 'utf8')
    await withEnv(
      { REVIEWER_ROSTER_DRIVER: 'fs', REVIEWER_ROSTER_DIR: dir },
      async () => {
        // Reporting "no reviewers" here would invite the dashboard to add one
        // and save the result over whatever is really in that file.
        await assert.rejects(() => createRosterStore().load(), /malformed/)
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('audit lines are appended, never rewritten, and come back newest first', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-roster-'))
  try {
    await withEnv(
      { REVIEWER_ROSTER_DRIVER: 'fs', REVIEWER_ROSTER_DIR: dir },
      async () => {
        const store = createRosterStore()
        const older = newAuditEvent('mike@example.com', 'reviewer.created', 'anna', 'Added Anna.')
        const newer = {
          ...newAuditEvent('mike@example.com', 'reviewer.revoked', 'anna', 'Revoked Anna.'),
          at: '2030-01-01T00:00:00.000Z',
        }
        await store.appendAudit(older)
        await store.appendAudit(newer)

        const listed = await store.listAudit(10)
        assert.equal(listed.length, 2)
        assert.equal(listed[0].id, newer.id)

        // Both lines are still on disk in full: history is appended to, never
        // edited.
        const raw = readFileSync(join(dir, 'audit.ndjson'), 'utf8').trim().split('\n')
        assert.equal(raw.length, 2)
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------ blob driver */

/** A blob store that can be made to misbehave on purpose. */
function fakeBackend(): RosterBlobBackend & { objects: Map<string, string>; fail: boolean } {
  const objects = new Map<string, string>()
  const backend = {
    objects,
    fail: false,
    async putObject(pathname: string, body: string, overwrite: boolean) {
      if (backend.fail) throw new Error('store unavailable')
      if (!overwrite && objects.has(pathname)) throw new Error('already exists')
      objects.set(pathname, body)
    },
    async listPathnames(prefix: string) {
      if (backend.fail) throw new Error('store unavailable')
      return Array.from(objects.keys()).filter((key) => key.startsWith(prefix))
    },
    async readObject(pathname: string) {
      if (backend.fail) throw new Error('store unavailable')
      return objects.get(pathname) ?? null
    },
  }
  return backend
}

test('the blob driver stores, overwrites and reads back the roster', async () => {
  const backend = fakeBackend()
  const store = createVercelBlobRosterStore({ backend })

  const first = await store.save(doc([reviewer()]), emptyRoster().updatedAt)
  assert.equal((await store.load()).reviewers.length, 1)

  const second = await store.save(
    { ...first, reviewers: [reviewer({ status: 'revoked' })] },
    first.updatedAt,
  )
  assert.equal((await store.load()).reviewers[0].status, 'revoked')
  assert.notEqual(second.updatedAt, first.updatedAt)

  // Current state is one object, deliberately replaced rather than accumulated.
  assert.equal(backend.objects.size, 1)
})

test('an unreachable blob store throws rather than reporting an empty roster', async () => {
  const backend = fakeBackend()
  const store = createVercelBlobRosterStore({ backend })
  await store.save(doc([reviewer()]), emptyRoster().updatedAt)

  backend.fail = true

  // This is the whole point. `[]` here would mean "nobody has access", and the
  // very next save would write that over a real roster.
  await assert.rejects(() => store.load(), /store unavailable/)
})

test('a store that has never been written is empty, and that is not an error', async () => {
  const store = createVercelBlobRosterStore({ backend: fakeBackend() })
  assert.deepEqual((await store.load()).reviewers, [])
})

test('a malformed stored roster is an error, never an empty roster', async () => {
  const backend = fakeBackend()
  backend.objects.set('roster/v1/roster.json', '{ broken')
  await assert.rejects(() => createVercelBlobRosterStore({ backend }).load(), /malformed/)
})

test('the blob driver refuses a stale write', async () => {
  const backend = fakeBackend()
  const store = createVercelBlobRosterStore({ backend })
  const first = await store.save(doc([reviewer()]), emptyRoster().updatedAt)
  await store.save({ ...first, reviewers: [] }, first.updatedAt)

  await assert.rejects(
    () => store.save({ ...first, reviewers: [reviewer()] }, first.updatedAt),
    (error: Error) => error instanceof RosterConflictError,
  )
})

test('audit objects are immutable -- the same line cannot be written twice', async () => {
  const backend = fakeBackend()
  const store = createVercelBlobRosterStore({ backend })
  const event = newAuditEvent('mike@example.com', 'reviewer.revoked', 'anna', 'Revoked Anna.')

  await store.appendAudit(event)
  // Same id, same timestamp, same pathname: the store refuses rather than
  // replacing a record of what happened.
  await assert.rejects(() => store.appendAudit(event), /already exists/)
})

test('the blob driver refuses to start without a credential', () => {
  assert.throws(
    () => createVercelBlobRosterStore({ token: '' }),
    /BLOB_READ_WRITE_TOKEN/,
  )
})

test('the fs driver refuses to start without a directory', async () => {
  await withEnv(
    { REVIEWER_ROSTER_DRIVER: 'fs', REVIEWER_ROSTER_DIR: undefined },
    async () => {
      assert.throws(() => createRosterStore(), /REVIEWER_ROSTER_DIR/)
    },
  )
})
