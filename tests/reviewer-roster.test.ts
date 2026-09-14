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
  mutateRoster,
  newAuditEvent,
  normalizeReviewerEmail,
  parseRosterDocument,
  serializeRosterDocument,
  suggestReviewerId,
  type RosterBlobBackend,
  type RosterDocument,
  type RosterReviewer,
} from '../lib/reviewer-roster.ts'
import { fingerprintAccessCode, identifyReviewerIn } from '../lib/reviewer-access.ts'

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
    emailVerifiedAt: null,
    credentialEpoch: 0,
    origin: 'admin',
    requestId: null,
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

/**
 * A blob store that can be made to misbehave on purpose.
 *
 * It models an ETag the way the real service does — a value that changes on
 * every write — so that `putObjectIfMatch` here fails its precondition in
 * exactly the cases the real one would, and a test that races two mutations is
 * testing the driver's logic rather than a fake that always says yes.
 */
function fakeBackend(): RosterBlobBackend & {
  objects: Map<string, string>
  etags: Map<string, string>
  fail: boolean
  writes: number
} {
  const objects = new Map<string, string>()
  const etags = new Map<string, string>()
  let revision = 0

  const write = (pathname: string, body: string) => {
    revision += 1
    objects.set(pathname, body)
    etags.set(pathname, `etag-${revision}`)
  }

  const backend = {
    objects,
    etags,
    fail: false,
    writes: 0,
    async putObject(pathname: string, body: string, overwrite: boolean) {
      if (backend.fail) throw new Error('store unavailable')
      if (!overwrite && objects.has(pathname)) throw new Error('already exists')
      backend.writes += 1
      write(pathname, body)
    },
    async putObjectIfMatch(pathname: string, body: string, etag: string | null) {
      if (backend.fail) throw new Error('store unavailable')
      if (etag === null) {
        // "Must not exist yet": the first-ever roster, and the case where two
        // deployments could both try to create one.
        if (objects.has(pathname)) return false
      } else if (etags.get(pathname) !== etag) {
        return false
      }
      backend.writes += 1
      write(pathname, body)
      return true
    },
    async listPathnames(prefix: string) {
      if (backend.fail) throw new Error('store unavailable')
      return Array.from(objects.keys()).filter((key) => key.startsWith(prefix))
    },
    async readObject(pathname: string) {
      if (backend.fail) throw new Error('store unavailable')
      return objects.get(pathname) ?? null
    },
    async readObjectWithEtag(pathname: string) {
      if (backend.fail) throw new Error('store unavailable')
      const body = objects.get(pathname) ?? null
      return { body, etag: body === null ? null : (etags.get(pathname) ?? null) }
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

/* ------------------------------------------ the roster from before accounts */

/*
 * Reviewer accounts added three optional fields to a roster entry. The rule
 * this project follows -- the one `paragraphOffset` established -- is that an
 * addition nothing else depends on is not a schema bump, and an entry written
 * before it existed must keep working exactly as it did.
 *
 * These two tests are that promise, stated as code: a document written before
 * any of this existed still parses, still means what it meant, and the access
 * code in it still opens the reader.
 */

test('a roster written before reviewer accounts existed still parses', () => {
  const before = JSON.stringify({
    schema: 1,
    updatedAt: '2026-05-01T00:00:00.000Z',
    reviewers: [
      {
        id: 'anna',
        name: 'Anna',
        email: 'anna@example.com',
        books: ['the-backward-becoming'],
        status: 'active',
        codeHash: 'fingerprint-anna',
        createdAt: '2026-05-01T00:00:00.000Z',
        codeUpdatedAt: '2026-05-01T00:00:00.000Z',
        lastAccessAt: null,
      },
    ],
  })

  const parsed = parseRosterDocument(before)
  assert.ok(parsed, 'an entry from before the new fields is not malformed')
  const [reviewer] = parsed.reviewers

  assert.equal(reviewer.id, 'anna')
  assert.deepEqual(reviewer.books, ['the-backward-becoming'])
  assert.equal(reviewer.status, 'active')

  // The defaults are the truth about such an entry, not a convenience.
  assert.equal(
    reviewer.emailVerifiedAt,
    null,
    'an address nobody has proved is not a way to sign in',
  )
  assert.equal(reviewer.origin, 'admin', 'Mike added them; no request exists')
  assert.equal(reviewer.requestId, null)
})

test('and the access code in it still opens the reader', async () => {
  await withEnv(
    { REVIEWER_AUTH_SECRET: 'a-secret-for-this-test-only' },
    async () => {
      const code = 'ABCD-EFGH-JKMN-PQRS'
      const codeHash = await fingerprintAccessCode(code)
      assert.ok(codeHash)

      // Exactly the shape above: no emailVerifiedAt, no origin, no requestId.
      const document = JSON.stringify({
        schema: 1,
        updatedAt: '2026-05-01T00:00:00.000Z',
        reviewers: [
          {
            id: 'anna',
            name: 'Anna',
            email: 'anna@example.com',
            books: ['the-backward-becoming'],
            status: 'active',
            codeHash,
            createdAt: '2026-05-01T00:00:00.000Z',
            codeUpdatedAt: '2026-05-01T00:00:00.000Z',
            lastAccessAt: null,
          },
        ],
      })

      const parsed = parseRosterDocument(document)
      assert.ok(parsed)

      const identified = await identifyReviewerIn(
        parsed.reviewers.map((entry) => ({
          id: entry.id,
          name: entry.name,
          books: entry.books,
          codeHash: entry.codeHash,
        })),
        code,
      )
      assert.equal(identified?.id, 'anna', 'the code still identifies them')

      // Typed the way a reviewer on a phone types it, as it always worked.
      const loosely = await identifyReviewerIn(
        parsed.reviewers.map((entry) => ({
          id: entry.id,
          name: entry.name,
          books: entry.books,
          codeHash: entry.codeHash,
        })),
        'abcdefghjkmnpqrs',
      )
      assert.equal(loosely?.id, 'anna')
    },
  )
})

/* ------------------------------- conditional writes, and the lost update */

/*
 * The defect these cover, in one sentence: the blob driver used to re-read the
 * document, compare `updatedAt`, and then overwrite -- which is not
 * compare-and-swap, and let two server functions both pass the check and the
 * later one discard the other's change. Reviewer creation, activation
 * verification, address changes, entitlements and revocation all ride on this
 * document, so a lost update there is a lost security decision.
 */

test('the blob driver creates the first roster only once, however many callers try', async () => {
  const backend = fakeBackend()
  const store = createVercelBlobRosterStore({ backend })

  const [a, b] = await Promise.allSettled([
    store.save(doc([reviewer({ id: 'anna', name: 'Anna' })]), emptyRoster().updatedAt, null),
    store.save(doc([reviewer({ id: 'ben', name: 'Ben', email: 'ben@example.com', codeHash: 'fingerprint-ben' })]), emptyRoster().updatedAt, null),
  ])

  const landed = [a, b].filter((outcome) => outcome.status === 'fulfilled')
  assert.equal(landed.length, 1, 'exactly one creation of a roster that did not exist')

  const refused = [a, b].find((outcome) => outcome.status === 'rejected')
  assert.ok(refused && refused.status === 'rejected')
  assert.ok(refused.reason instanceof RosterConflictError, 'and the other is told, not ignored')

  assert.equal((await store.load()).reviewers.length, 1)
})

test('two concurrent roster mutations cannot silently discard one another', async () => {
  const backend = fakeBackend()
  const store = createVercelBlobRosterStore({ backend })
  await store.save(
    doc([reviewer({ id: 'anna', name: 'Anna' }), reviewer({ id: 'ben', name: 'Ben', email: 'ben@example.com', codeHash: 'fingerprint-ben' })]),
    emptyRoster().updatedAt,
    null,
  )

  /*
   * Both mutations read the same document, then both write. Under the old
   * read-check-overwrite the second write landed and the first change vanished
   * without a word. Here one write is refused by its ETag precondition, and
   * `mutateRoster` re-derives it against the document that won -- so both
   * changes are present afterwards.
   */
  const [revoke, entitle] = await Promise.all([
    mutateRoster(
      (current) => ({
        reviewers: current.reviewers.map((row) =>
          row.id === 'anna' ? { ...row, status: 'revoked' as const } : row,
        ),
        event: newAuditEvent('mike@example.com', 'reviewer.revoked', 'anna', 'Revoked Anna.'),
        result: 'revoked',
      }),
      store,
    ),
    mutateRoster(
      (current) => ({
        reviewers: current.reviewers.map((row) =>
          row.id === 'ben' ? { ...row, books: ['the-backward-becoming'] } : row,
        ),
        event: newAuditEvent(
          'mike@example.com',
          'reviewer.entitlements-changed',
          'ben',
          'Gave Ben a book.',
        ),
        result: 'entitled',
      }),
      store,
    ),
  ])

  assert.equal(revoke.result, 'revoked')
  assert.equal(entitle.result, 'entitled')

  const settled = await store.load()
  assert.equal(
    settled.reviewers.find((row) => row.id === 'anna')?.status,
    'revoked',
    'the revocation survived',
  )
  assert.deepEqual(
    settled.reviewers.find((row) => row.id === 'ben')?.books,
    ['the-backward-becoming'],
    'and so did the entitlement change it raced',
  )
})

test('a conditional write that keeps losing is refused rather than forced through', async () => {
  const backend = fakeBackend()
  const store = createVercelBlobRosterStore({ backend })
  await store.save(doc([reviewer({ id: 'anna', name: 'Anna' })]), emptyRoster().updatedAt, null)

  const before = backend.objects.get('roster/v1/roster.json')

  await assert.rejects(
    () =>
      mutateRoster((current) => {
        // Somebody else writes between every read and every write, for ever.
        // This is the pathological case, and the answer must be an honest
        // refusal, never a blind overwrite.
        backend.etags.set('roster/v1/roster.json', `etag-moved-${Math.random()}`)
        return {
          reviewers: current.reviewers,
          event: newAuditEvent('mike@example.com', 'reviewer.renamed', 'anna', 'x'),
          result: null,
        }
      }, store),
    (error: Error) => error instanceof RosterConflictError,
  )

  assert.equal(
    backend.objects.get('roster/v1/roster.json'),
    before,
    'and nothing of anybody else\u2019s was written over to get there',
  )
})

test('the fs driver refuses a conditional write against a revision that moved', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-roster-'))
  try {
    await withEnv({ REVIEWER_ROSTER_DRIVER: 'fs', REVIEWER_ROSTER_DIR: dir }, async () => {
      const store = createRosterStore()

      const opened = await store.loadForUpdate()
      assert.equal(opened.version, null, 'no document yet is its own precondition')

      const first = await store.save(doc([reviewer()]), opened.doc.updatedAt, opened.version)
      const held = await store.loadForUpdate()
      assert.ok(held.version, 'a stored document has a revision')

      // Somebody else writes.
      await store.save({ ...first, reviewers: [] }, first.updatedAt, held.version)

      // The revision we were holding is gone, and so is the right to write.
      await assert.rejects(
        () => store.save({ ...first, reviewers: [reviewer()] }, first.updatedAt, held.version),
        (error: Error) => error instanceof RosterConflictError,
      )
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('two concurrent fs mutations both land, and neither is lost', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-roster-'))
  try {
    await withEnv({ REVIEWER_ROSTER_DRIVER: 'fs', REVIEWER_ROSTER_DIR: dir }, async () => {
      const store = createRosterStore()
      const opened = await store.loadForUpdate()
      await store.save(
        doc([reviewer({ id: 'anna', name: 'Anna' }), reviewer({ id: 'ben', name: 'Ben', email: 'ben@example.com', codeHash: 'fingerprint-ben' })]),
        opened.doc.updatedAt,
        opened.version,
      )

      await Promise.all([
        mutateRoster(
          (current) => ({
            reviewers: current.reviewers.map((row) =>
              row.id === 'anna' ? { ...row, name: 'Anna Renamed' } : row,
            ),
            event: newAuditEvent('mike@example.com', 'reviewer.renamed', 'anna', 'x'),
            result: null,
          }),
          store,
        ),
        mutateRoster(
          (current) => ({
            reviewers: current.reviewers.map((row) =>
              row.id === 'ben' ? { ...row, status: 'revoked' as const } : row,
            ),
            event: newAuditEvent('mike@example.com', 'reviewer.revoked', 'ben', 'x'),
            result: null,
          }),
          store,
        ),
      ])

      const settled = await store.load()
      assert.equal(settled.reviewers.find((row) => row.id === 'anna')?.name, 'Anna Renamed')
      assert.equal(settled.reviewers.find((row) => row.id === 'ben')?.status, 'revoked')
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
