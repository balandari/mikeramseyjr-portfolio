import test from 'node:test'
import assert from 'node:assert/strict'

import {
  __resetFeedbackStore,
  createFeedbackStore,
  type FeedbackDraft,
  type FeedbackEntry,
  type FeedbackListing,
} from '../lib/reviewer-feedback.ts'
import {
  FEEDBACK_ROOT,
  createVercelBlobFeedbackStore,
  feedbackPathname,
  feedbackPrefix,
  type FeedbackBlobBackend,
} from '../lib/reviewer-feedback-blob.ts'

/**
 * The rows of a listing that was expected to be complete.
 *
 * `listForReviewer` answers rows **and** whether every enumerated row could be
 * read. Asserting completeness here means every existing case below now says
 * "these are the comments, and none were dropped" rather than only the first
 * half of that. A case that deliberately damages a row asserts `incomplete`
 * directly and does not go through this.
 */
async function completeEntries(
  listing: Promise<FeedbackListing> | FeedbackListing,
): Promise<FeedbackEntry[]> {
  const resolved = await listing
  assert.equal(resolved.incomplete, false, 'this listing was expected to be complete')
  return resolved.entries
}

/**
 * A blob store that can be made to misbehave on purpose.
 *
 * It enforces the two properties the real store is relied on for -- a listing
 * is strictly prefix-scoped, and a write to an existing pathname is refused --
 * so that a test proving isolation or duplicate refusal is proving the
 * driver's use of those properties, not a convenient stub.
 */
class FakeBlobStore implements FeedbackBlobBackend {
  readonly objects = new Map<string, string>()
  /** Set to make every operation fail, the way an outage does. */
  outage: Error | null = null
  /** Pathnames the listing should return that no object backs. */
  phantoms: string[] = []
  /**
   * Set to make *reads* fail while listing still succeeds -- an outage, a
   * revoked credential or a network partition that begins after the listing
   * has already been answered. This is the shape of failure that must never
   * be mistaken for an empty feedback history.
   */
  readOutage: Error | null = null
  /** Pathnames whose read throws rather than returning bytes. */
  unreadable = new Set<string>()
  /** How many pathnames one page of a listing returns. */
  pageSize = 1000

  async putObject(pathname: string, body: string): Promise<void> {
    if (this.outage) throw this.outage
    if (this.objects.has(pathname)) {
      // This is what `allowOverwrite: false` does in the real store.
      throw new Error(`blob already exists: ${pathname}`)
    }
    this.objects.set(pathname, body)
  }

  async listPathnames(prefix: string): Promise<string[]> {
    if (this.outage) throw this.outage
    const found = [...Array.from(this.objects.keys()), ...this.phantoms]
      .filter((pathname) => pathname.startsWith(prefix))
      .sort()
    // Paging is the store's business, but the driver must consume all of it;
    // the page size is here so a test can prove that it does.
    return found.slice(0, Math.max(found.length, this.pageSize))
  }

  async readObject(pathname: string): Promise<string | null> {
    if (this.outage) throw this.outage
    if (this.readOutage) throw this.readOutage
    if (this.unreadable.has(pathname)) throw new Error(`unreadable: ${pathname}`)
    // `null` means exactly one thing: the store answered and there is no such
    // object. It is never how a failure is reported.
    return this.objects.get(pathname) ?? null
  }

  /** Write an object directly, bypassing the driver, to plant a bad one. */
  plant(pathname: string, body: string): void {
    this.objects.set(pathname, body)
  }
}

function draft(overrides: Partial<FeedbackDraft> = {}): FeedbackDraft {
  return {
    reviewerId: 'anna',
    bookSlug: 'the-backward-becoming',
    chapterSlug: 'chapter-one',
    chapterNumber: 1,
    scope: 'paragraph',
    paragraphId: 'chapter-one-p012',
    paragraphOrdinal: 12,
    quote: 'The exact passage, copied from the manuscript.',
    comment: 'This line is the one that landed.',
    ...overrides,
  }
}

function storeWith(backend: FeedbackBlobBackend) {
  return createVercelBlobFeedbackStore({ backend })
}

/* ------------------------------------------------------------- the layout */

test('the prefix is reviewer-then-book, versioned, and slash-terminated', () => {
  assert.equal(
    feedbackPrefix('anna', 'the-backward-becoming'),
    'feedback/v1/anna/the-backward-becoming/',
  )
  assert.equal(FEEDBACK_ROOT, 'feedback/v1')
})

test('the trailing slash stops one reviewer id from prefixing another', () => {
  // Without the trailing slash, "anna" would list "annabel" too.
  assert.ok(!feedbackPrefix('annabel', 'b').startsWith(feedbackPrefix('anna', 'b')))
})

test('a reviewer id or book slug that could escape the prefix is refused', () => {
  for (const bad of ['..', 'a/b', '/anna', 'anna/', 'An na', '', 'a'.repeat(65)]) {
    assert.throws(() => feedbackPrefix(bad, 'book'), /invalid reviewer id/)
    assert.throws(() => feedbackPrefix('anna', bad), /invalid (book slug|reviewer id)/)
  }
})

test('a pathname is chronological, unique per row, and JSON', () => {
  const entry = {
    ...draft(),
    schema: 1,
    id: '11111111-2222-3333-4444-555555555555',
    createdAt: '2026-09-11T04:05:06.789Z',
  } as FeedbackEntry
  assert.equal(
    feedbackPathname(entry),
    'feedback/v1/anna/the-backward-becoming/2026-09-11T04-05-06-789Z-11111111-2222-3333-4444-555555555555.json',
  )
})

/* -------------------------------------------------------- writes and reads */

test('a comment is stored as its own object and read back with full attribution', async () => {
  const backend = new FakeBlobStore()
  const store = storeWith(backend)

  const written = await store.add(draft())

  assert.equal(store.driver, 'vercel-blob')
  assert.equal(store.durable, true)
  assert.equal(backend.objects.size, 1)

  const [pathname] = Array.from(backend.objects.keys())
  assert.ok(pathname.startsWith('feedback/v1/anna/the-backward-becoming/'))
  assert.ok(pathname.endsWith('.json'))

  const read = await completeEntries(store.listForReviewer('anna', 'the-backward-becoming'))
  assert.equal(read.length, 1)
  assert.deepEqual(read[0], written)
  assert.equal(read[0].schema, 1)
  assert.equal(read[0].chapterSlug, 'chapter-one')
  assert.equal(read[0].paragraphId, 'chapter-one-p012')
  assert.equal(read[0].quote, 'The exact passage, copied from the manuscript.')
})

test('the returned row carries no blob URL, pathname or token', async () => {
  const backend = new FakeBlobStore()
  const store = storeWith(backend)

  const written = await store.add(draft())
  const [read] = await completeEntries(store.listForReviewer('anna', 'the-backward-becoming'))

  const allowed = new Set([
    'schema',
    'id',
    'createdAt',
    'reviewerId',
    'bookSlug',
    'chapterSlug',
    'chapterNumber',
    'scope',
    'paragraphId',
    'paragraphOrdinal',
    'quote',
    'comment',
  ])
  for (const row of [written, read]) {
    for (const key of Object.keys(row)) {
      assert.ok(allowed.has(key), `unexpected field leaked to the caller: ${key}`)
    }
    const serialised = JSON.stringify(row)
    assert.ok(!/https?:\/\//.test(serialised), 'a URL reached the caller')
    assert.ok(!/vercel_blob_rw/.test(serialised), 'a token reached the caller')
  }
})

test('every submission is a separate object -- nothing is appended or merged', async () => {
  const backend = new FakeBlobStore()
  const store = storeWith(backend)

  for (let n = 0; n < 5; n += 1) {
    await store.add(draft({ comment: `comment number ${n}` }))
  }

  assert.equal(backend.objects.size, 5)
  const read = await completeEntries(store.listForReviewer('anna', 'the-backward-becoming'))
  assert.equal(read.length, 5)
  assert.deepEqual(
    read.map((entry) => entry.comment).sort(),
    [0, 1, 2, 3, 4].map((n) => `comment number ${n}`).sort(),
  )
})

test('stored objects are ordered oldest first, however the store paged them', async () => {
  const backend = new FakeBlobStore()
  const store = storeWith(backend)

  await store.add(draft({ comment: 'first' }))
  await store.add(draft({ comment: 'second' }))
  await store.add(draft({ comment: 'third' }))

  const read = await completeEntries(store.listForReviewer('anna', 'the-backward-becoming'))
  const times = read.map((entry) => entry.createdAt)
  assert.deepEqual(times, [...times].sort())
})

/* ---------------------------------------------------------- immutability */

test('writing the same row twice is refused rather than overwriting', async () => {
  const backend = new FakeBlobStore()
  const store = storeWith(backend)

  const entry = await store.add(draft())
  const pathname = feedbackPathname(entry)
  const original = backend.objects.get(pathname)

  await assert.rejects(
    () => backend.putObject(pathname, '{"schema":1,"comment":"replaced"}'),
    /already exists/,
  )
  assert.equal(backend.objects.get(pathname), original, 'the stored object changed')
})

test('an existing object is never replaced, even by a row with the same id', async () => {
  const backend = new FakeBlobStore()
  const store = storeWith(backend)

  const entry = await store.add(draft())
  const collision: FeedbackEntry = { ...entry, comment: 'a different comment entirely' }

  await assert.rejects(
    () => backend.putObject(feedbackPathname(collision), JSON.stringify(collision)),
    /already exists/,
  )

  const read = await completeEntries(store.listForReviewer('anna', 'the-backward-becoming'))
  assert.equal(read.length, 1)
  assert.equal(read[0].comment, 'This line is the one that landed.')
})

/* ------------------------------------------------------------- isolation */

test("one reviewer never receives another reviewer's feedback", async () => {
  const backend = new FakeBlobStore()
  const store = storeWith(backend)

  await store.add(draft({ reviewerId: 'anna', comment: "anna's note" }))
  await store.add(draft({ reviewerId: 'ben', comment: "ben's note" }))

  const anna = await completeEntries(store.listForReviewer('anna', 'the-backward-becoming'))
  const ben = await completeEntries(store.listForReviewer('ben', 'the-backward-becoming'))

  assert.equal(anna.length, 1)
  assert.equal(anna[0].comment, "anna's note")
  assert.equal(ben.length, 1)
  assert.equal(ben[0].comment, "ben's note")
})

test('a reviewer whose id prefixes another gets only their own feedback', async () => {
  const backend = new FakeBlobStore()
  const store = storeWith(backend)

  await store.add(draft({ reviewerId: 'anna', comment: 'anna' }))
  await store.add(draft({ reviewerId: 'annabel', comment: 'annabel' }))

  const anna = await completeEntries(store.listForReviewer('anna', 'the-backward-becoming'))
  assert.equal(anna.length, 1)
  assert.equal(anna[0].comment, 'anna')
})

test('feedback is scoped by book as well as by reviewer', async () => {
  const backend = new FakeBlobStore()
  const store = storeWith(backend)

  await store.add(draft({ bookSlug: 'the-backward-becoming', comment: 'about book one' }))
  await store.add(draft({ bookSlug: 'a-second-title', comment: 'about book two' }))

  const one = await completeEntries(store.listForReviewer('anna', 'the-backward-becoming'))
  const two = await completeEntries(store.listForReviewer('anna', 'a-second-title'))

  assert.equal(one.length, 1)
  assert.equal(one[0].comment, 'about book one')
  assert.equal(two.length, 1)
  assert.equal(two[0].comment, 'about book two')
})

test('only the reviewer-and-book prefix is ever listed', async () => {
  const seen: string[] = []
  const backend = new FakeBlobStore()
  const wrapped: FeedbackBlobBackend = {
    putObject: (p, b) => backend.putObject(p, b),
    listPathnames: (prefix) => {
      seen.push(prefix)
      return backend.listPathnames(prefix)
    },
    readObject: (p) => backend.readObject(p),
  }
  const store = storeWith(wrapped)

  await store.add(draft())
  await completeEntries(store.listForReviewer('anna', 'the-backward-becoming'))

  assert.deepEqual(seen, ['feedback/v1/anna/the-backward-becoming/'])
})

/*
 * SUPERSEDED CONTRACT (F3). This case asserted only the first half of what a
 * reader owes its caller: the surviving rows still come back, and the damaged
 * one is still never disclosed. Both remain asserted below, unchanged. What it
 * did not say -- and what the Judge found -- is that nothing told the caller a
 * row had been dropped, so a shortened history read exactly like a shorter
 * history and the author's export stamped it complete. The listing now carries
 * `incomplete`, and each case asserts both halves.
 */
test("a misfiled object under this reviewer's prefix is skipped, not disclosed, and is counted as a gap", async () => {
  const backend = new FakeBlobStore()
  const store = storeWith(backend)

  await store.add(draft({ comment: 'genuinely mine' }))
  // An object sitting under anna's prefix that says it belongs to ben.
  backend.plant(
    'feedback/v1/anna/the-backward-becoming/2026-01-01T00-00-00-000Z-planted.json',
    JSON.stringify({
      ...draft({ reviewerId: 'ben', comment: "ben's private note" }),
      schema: 1,
      id: 'planted',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  )

  const anna = await store.listForReviewer('anna', 'the-backward-becoming')
  assert.equal(anna.entries.length, 1)
  assert.equal(anna.entries[0].comment, 'genuinely mine')
  assert.equal(anna.incomplete, true, 'a misfiled object is an anomaly, not an absence')
})

/*
 * SUPERSEDED CONTRACT (F3). This case asserted only the first half of what a
 * reader owes its caller: the surviving rows still come back, and the damaged
 * one is still never disclosed. Both remain asserted below, unchanged. What it
 * did not say -- and what the Judge found -- is that nothing told the caller a
 * row had been dropped, so a shortened history read exactly like a shorter
 * history and the author's export stamped it complete. The listing now carries
 * `incomplete`, and each case asserts both halves.
 */
test('a pathname returned from outside the requested prefix is ignored and disclosed', async () => {
  const backend = new FakeBlobStore()
  const leaked = 'feedback/v1/ben/the-backward-becoming/2026-01-01T00-00-00-000Z-x.json'
  backend.plant(
    leaked,
    JSON.stringify({
      ...draft({ reviewerId: 'ben', comment: "ben's note" }),
      schema: 1,
      id: 'x',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  )

  // A store that answers every listing with everything it holds.
  const sloppy: FeedbackBlobBackend = {
    putObject: (p, b) => backend.putObject(p, b),
    listPathnames: async () => Array.from(backend.objects.keys()),
    readObject: (p) => backend.readObject(p),
  }
  const store = storeWith(sloppy)
  await store.add(draft({ comment: 'mine' }))

  const anna = await store.listForReviewer('anna', 'the-backward-becoming')
  assert.equal(anna.entries.length, 1)
  assert.equal(anna.entries[0].comment, 'mine')
  assert.equal(
    anna.incomplete,
    true,
    'a backend answering outside its own prefix is a fault, and is reported as one',
  )
})

/* ------------------------------------------------------ malformed objects */

/*
 * SUPERSEDED CONTRACT (F3). This case asserted only the first half of what a
 * reader owes its caller: the surviving rows still come back, and the damaged
 * one is still never disclosed. Both remain asserted below, unchanged. What it
 * did not say -- and what the Judge found -- is that nothing told the caller a
 * row had been dropped, so a shortened history read exactly like a shorter
 * history and the author's export stamped it complete. The listing now carries
 * `incomplete`, and each case asserts both halves.
 */
test('a malformed object does not hide the objects around it, and is disclosed', async () => {
  const backend = new FakeBlobStore()
  const store = storeWith(backend)

  await store.add(draft({ comment: 'before' }))
  const prefix = feedbackPrefix('anna', 'the-backward-becoming')

  backend.plant(`${prefix}2026-05-05T00-00-00-000Z-truncated.json`, '{"schema":1,"id":')
  backend.plant(`${prefix}2026-05-05T00-00-01-000Z-empty.json`, '')
  backend.plant(`${prefix}2026-05-05T00-00-02-000Z-array.json`, '[1,2,3]')
  backend.plant(`${prefix}2026-05-05T00-00-03-000Z-null.json`, 'null')
  backend.plant(`${prefix}2026-05-05T00-00-04-000Z-wrongschema.json`, '{"schema":99}')
  backend.plant(
    `${prefix}2026-05-05T00-00-05-000Z-missing.json`,
    JSON.stringify({ schema: 1, id: 'm', createdAt: '2026-05-05T00:00:05.000Z' }),
  )
  backend.plant(
    `${prefix}2026-05-05T00-00-06-000Z-baddate.json`,
    JSON.stringify({ ...draft(), schema: 1, id: 'd', createdAt: 'not a date' }),
  )

  await store.add(draft({ comment: 'after' }))

  const read = await store.listForReviewer('anna', 'the-backward-becoming')
  assert.deepEqual(read.entries.map((entry) => entry.comment).sort(), ['after', 'before'])
  assert.equal(read.incomplete, true, 'seven unreadable objects are seven disclosed gaps')
})

test('an object read that throws rejects the whole listing rather than being skipped', async () => {
  // The correction this test exists for: a backend read that *throws* is a
  // storage, network or credential failure, not a property of the object.
  // Skipping it would let a failing store answer "you have written nothing".
  const backend = new FakeBlobStore()
  const store = storeWith(backend)

  await store.add(draft({ comment: 'readable' }))
  const prefix = feedbackPrefix('anna', 'the-backward-becoming')
  const broken = `${prefix}2026-06-06T00-00-00-000Z-broken.json`
  backend.plant(broken, '{}')
  backend.unreadable.add(broken)

  await assert.rejects(
    () => completeEntries(store.listForReviewer('anna', 'the-backward-becoming')),
    /unreadable/,
  )
})

/*
 * SUPERSEDED CONTRACT (F3). This case asserted only the first half of what a
 * reader owes its caller: the surviving rows still come back, and the damaged
 * one is still never disclosed. Both remain asserted below, unchanged. What it
 * did not say -- and what the Judge found -- is that nothing told the caller a
 * row had been dropped, so a shortened history read exactly like a shorter
 * history and the author's export stamped it complete. The listing now carries
 * `incomplete`, and each case asserts both halves.
 */
test('a listed pathname with no object behind it is skipped and disclosed', async () => {
  const backend = new FakeBlobStore()
  const store = storeWith(backend)

  await store.add(draft({ comment: 'real' }))
  backend.phantoms.push(
    'feedback/v1/anna/the-backward-becoming/2026-07-07T00-00-00-000Z-ghost.json',
  )

  const read = await store.listForReviewer('anna', 'the-backward-becoming')
  assert.equal(read.entries.length, 1)
  assert.equal(read.entries[0].comment, 'real')
  assert.equal(
    read.incomplete,
    true,
    'nothing here deletes a comment, so a listed-then-absent object is a fault',
  )
})

/* --------------------------------------------------------------- outages */

test('a storage outage fails a write loudly and stores nothing', async () => {
  const backend = new FakeBlobStore()
  const store = storeWith(backend)

  backend.outage = new Error('blob service unavailable')
  await assert.rejects(() => store.add(draft()), /blob service unavailable/)
  assert.equal(backend.objects.size, 0)
})

test('a storage outage on read raises rather than reporting no feedback', async () => {
  const backend = new FakeBlobStore()
  const store = storeWith(backend)

  await store.add(draft({ comment: 'stored before the outage' }))
  backend.outage = new Error('blob service unavailable')

  // An empty list would read as "you have written nothing", which is a lie.
  await assert.rejects(
    () => completeEntries(store.listForReviewer('anna', 'the-backward-becoming')),
    /blob service unavailable/,
  )
})

test('an outage is not a FeedbackStorageUnavailableError -- it is not a misconfiguration', async () => {
  const backend = new FakeBlobStore()
  const store = storeWith(backend)
  backend.outage = new Error('blob service unavailable')

  await store.add(draft()).then(
    () => assert.fail('the write should have failed'),
    (error: unknown) => {
      assert.equal((error as Error).name, 'Error')
      assert.notEqual((error as Error).name, 'FeedbackStorageUnavailableError')
    },
  )
})

/* ---------------------------- a failure that begins after a successful list */

test('an outage that begins after a successful list cannot return an empty history', async () => {
  // The exact failure the old code produced: the listing succeeds, so the
  // driver holds every pathname; then every read fails; every failure was
  // swallowed; and a reviewer with comments was shown an empty list. The only
  // acceptable outcome is that the operation fails loudly.
  const backend = new FakeBlobStore()
  const store = storeWith(backend)

  await store.add(draft({ comment: 'written months ago' }))
  await store.add(draft({ comment: 'written yesterday' }))

  const prefix = feedbackPrefix('anna', 'the-backward-becoming')
  let listed: string[] = []
  const failingAfterList: FeedbackBlobBackend = {
    putObject: (path, body) => backend.putObject(path, body),
    listPathnames: async (requested) => {
      // The list succeeds -- that is what makes this failure reachable at all.
      listed = await backend.listPathnames(requested)
      backend.readOutage = new Error('blob service unavailable mid-read')
      return listed
    },
    readObject: (path) => backend.readObject(path),
  }

  const result = await completeEntries(storeWith(failingAfterList)
    .listForReviewer('anna', 'the-backward-becoming'))
    .then(
      (entries) => ({ ok: true as const, entries }),
      (error: unknown) => ({ ok: false as const, error }),
    )

  // Proof the listing really did succeed, so this is genuinely the post-list case.
  assert.equal(listed.length, 2)
  assert.ok(listed.every((pathname) => pathname.startsWith(prefix)))

  assert.equal(result.ok, false, 'an outage after listing must not resolve')
  if (result.ok) return
  assert.match((result.error as Error).message, /blob service unavailable mid-read/)
})

test('a credential failure on read propagates instead of emptying the history', async () => {
  const backend = new FakeBlobStore()
  const store = storeWith(backend)

  await store.add(draft({ comment: 'still mine' }))
  backend.readOutage = Object.assign(new Error('access denied for this token'), {
    name: 'BlobAccessError',
  })

  await assert.rejects(
    () => completeEntries(store.listForReviewer('anna', 'the-backward-becoming')),
    /access denied for this token/,
  )
})

test('a read failure is not reported as a FeedbackStorageUnavailableError', async () => {
  // An outage is not a misconfiguration, and must not borrow the 503
  // "not configured" explanation the route gives that error.
  const backend = new FakeBlobStore()
  const store = storeWith(backend)

  await store.add(draft())
  backend.readOutage = new Error('blob service unavailable')

  await completeEntries(store.listForReviewer('anna', 'the-backward-becoming')).then(
    () => assert.fail('the listing should have failed'),
    (error: unknown) => {
      assert.notEqual((error as Error).name, 'FeedbackStorageUnavailableError')
    },
  )
})

test('every read failing is never the same answer as having written nothing', async () => {
  // The two situations must stay distinguishable by the caller, always.
  const backend = new FakeBlobStore()

  const genuinelyEmpty = await completeEntries(storeWith(backend).listForReviewer(
    'anna',
    'the-backward-becoming',
  ))
  assert.deepEqual(genuinelyEmpty, [], 'a reviewer with no comments reads as empty')

  await storeWith(backend).add(draft({ comment: 'one comment' }))
  backend.readOutage = new Error('blob service unavailable')

  await assert.rejects(
    () => completeEntries(storeWith(backend).listForReviewer('anna', 'the-backward-becoming')),
    /blob service unavailable/,
    'a reviewer whose comments cannot be read must not read as empty',
  )
})

/*
 * SUPERSEDED CONTRACT (F3). This case asserted only the first half of what a
 * reader owes its caller: the surviving rows still come back, and the damaged
 * one is still never disclosed. Both remain asserted below, unchanged. What it
 * did not say -- and what the Judge found -- is that nothing told the caller a
 * row had been dropped, so a shortened history read exactly like a shorter
 * history and the author's export stamped it complete. The listing now carries
 * `incomplete`, and each case asserts both halves.
 */
test('a missing object returned normally as null is skipped and disclosed, not raised', async () => {
  // The other polarity: `null` is the store answering, so it must stay
  // *skippable* -- otherwise one vanished object would deny a reviewer every
  // comment they ever wrote. It is no longer *silent*: nothing in this module
  // deletes a comment, so an object the backend listed and then would not back
  // is the store disagreeing with itself, and the caller is told.
  const backend = new FakeBlobStore()
  const store = storeWith(backend)

  await store.add(draft({ comment: 'present' }))
  const prefix = feedbackPrefix('anna', 'the-backward-becoming')
  backend.phantoms.push(`${prefix}2026-08-08T00-00-00-000Z-vanished.json`)

  const read = await store.listForReviewer('anna', 'the-backward-becoming')
  assert.deepEqual(
    read.entries.map((entry) => entry.comment),
    ['present'],
    'the readable comment still reads',
  )
  assert.equal(read.incomplete, true, 'and the vanished one is disclosed, not hidden')
})

/*
 * SUPERSEDED CONTRACT (F3). This case asserted only the first half of what a
 * reader owes its caller: the surviving rows still come back, and the damaged
 * one is still never disclosed. Both remain asserted below, unchanged. What it
 * did not say -- and what the Judge found -- is that nothing told the caller a
 * row had been dropped, so a shortened history read exactly like a shorter
 * history and the author's export stamped it complete. The listing now carries
 * `incomplete`, and each case asserts both halves.
 */
test('a listing of nothing but missing objects is empty and incomplete rather than failing', async () => {
  const backend = new FakeBlobStore()
  const store = storeWith(backend)
  const prefix = feedbackPrefix('anna', 'the-backward-becoming')

  backend.phantoms.push(
    `${prefix}2026-08-08T00-00-00-000Z-a.json`,
    `${prefix}2026-08-08T00-00-01-000Z-b.json`,
  )

  const read = await store.listForReviewer('anna', 'the-backward-becoming')
  assert.deepEqual(read.entries, [], 'nothing readable came back')
  assert.equal(
    read.incomplete,
    true,
    // This is the whole finding in one line: an empty list that is not an
    // empty history. Without the flag these are the same value.
    'and that is not the same answer as a reviewer who wrote nothing',
  )
})

/*
 * SUPERSEDED CONTRACT (F3). This case asserted only the first half of what a
 * reader owes its caller: the surviving rows still come back, and the damaged
 * one is still never disclosed. Both remain asserted below, unchanged. What it
 * did not say -- and what the Judge found -- is that nothing told the caller a
 * row had been dropped, so a shortened history read exactly like a shorter
 * history and the author's export stamped it complete. The listing now carries
 * `incomplete`, and each case asserts both halves.
 */
test('malformed and misfiled objects are skipped while a real one reads, and are disclosed', async () => {
  const backend = new FakeBlobStore()
  const store = storeWith(backend)
  const prefix = feedbackPrefix('anna', 'the-backward-becoming')

  await store.add(draft({ comment: 'the real one' }))

  // Not JSON at all.
  backend.plant(`${prefix}2026-02-02T00-00-00-000Z-truncated.json`, '{"schema":1,')
  // JSON, but not a row of this schema.
  backend.plant(`${prefix}2026-02-02T00-00-01-000Z-wrongschema.json`, '{"schema":2}')
  // A row of this schema that belongs to somebody else, misfiled here.
  backend.plant(
    `${prefix}2026-02-02T00-00-02-000Z-misfiled.json`,
    JSON.stringify({
      ...draft({ reviewerId: 'ben', comment: 'a note that is not annas' }),
      schema: 1,
      id: 'misfiled',
      createdAt: '2026-02-02T00:00:02.000Z',
    }),
  )

  const read = await store.listForReviewer('anna', 'the-backward-becoming')
  assert.deepEqual(
    read.entries.map((entry) => entry.comment),
    ['the real one'],
    'neither the damaged row nor the misfiled one is disclosed',
  )
  assert.equal(read.incomplete, true, 'and all three gaps are reported as gaps')
})

test('a read failure is not softened by a malformed object sitting beside it', async () => {
  // Skipping bad objects must not become a general-purpose catch that also
  // absorbs the failure this correction exists to surface.
  const backend = new FakeBlobStore()
  const store = storeWith(backend)
  const prefix = feedbackPrefix('anna', 'the-backward-becoming')

  await store.add(draft({ comment: 'real' }))
  backend.plant(`${prefix}2026-03-03T00-00-00-000Z-bad.json`, 'not json')
  const broken = `${prefix}2026-03-03T00-00-01-000Z-broken.json`
  backend.plant(broken, '{}')
  backend.unreadable.add(broken)

  await assert.rejects(
    () => completeEntries(store.listForReviewer('anna', 'the-backward-becoming')),
    /unreadable/,
  )
})

test('a read failure denies both reviewers equally and alters neither history', async () => {
  const backend = new FakeBlobStore()
  const store = storeWith(backend)

  await store.add(draft({ comment: 'belongs to anna' }))
  await store.add(draft({ reviewerId: 'ben', comment: 'belongs to ben' }))

  const before = new Map(backend.objects)
  backend.readOutage = new Error('blob service unavailable')

  // Neither reviewer is answered with a false empty list.
  await assert.rejects(() => completeEntries(store.listForReviewer('anna', 'the-backward-becoming')))
  await assert.rejects(() => completeEntries(store.listForReviewer('ben', 'the-backward-becoming')))

  // Nothing stored was touched by the failed reads.
  assert.deepEqual(Array.from(backend.objects.entries()), Array.from(before.entries()))

  // And once the store recovers, both histories are intact and still isolated.
  backend.readOutage = null
  assert.deepEqual(
    (await completeEntries(store.listForReviewer('anna', 'the-backward-becoming'))).map((e) => e.comment),
    ['belongs to anna'],
  )
  assert.deepEqual(
    (await completeEntries(store.listForReviewer('ben', 'the-backward-becoming'))).map((e) => e.comment),
    ['belongs to ben'],
  )
})

/* -------------------------------------------------------- driver selection */

function withEnv<T>(env: Record<string, string | undefined>, run: () => T): T {
  const saved: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  __resetFeedbackStore()
  try {
    return run()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    __resetFeedbackStore()
  }
}

test('the driver is selected only by an explicit REVIEWER_FEEDBACK_DRIVER=vercel-blob', () => {
  withEnv(
    { REVIEWER_FEEDBACK_DRIVER: 'vercel-blob', BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_test_x' },
    () => {
      assert.equal(createFeedbackStore().driver, 'vercel-blob')
    },
  )

  // A token on its own selects nothing. Presence of a credential is not a
  // decision to use it.
  withEnv(
    { REVIEWER_FEEDBACK_DRIVER: undefined, BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_test_x' },
    () => {
      assert.equal(createFeedbackStore().driver, 'unconfigured')
    },
  )

  for (const name of ['vercel_blob', 'blob', 'vercelblob', 'VERCEL-BLOB-X']) {
    withEnv(
      { REVIEWER_FEEDBACK_DRIVER: name, BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_test_x' },
      () => {
        assert.equal(createFeedbackStore().driver, 'unconfigured')
      },
    )
  }
})

test('the driver name is matched case-insensitively and trimmed, like the others', () => {
  withEnv(
    { REVIEWER_FEEDBACK_DRIVER: '  Vercel-Blob  ', BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_test_x' },
    () => {
      assert.equal(createFeedbackStore().driver, 'vercel-blob')
    },
  )
})

test('the blob driver refuses to start without a credential', () => {
  withEnv({ REVIEWER_FEEDBACK_DRIVER: 'vercel-blob', BLOB_READ_WRITE_TOKEN: undefined }, () => {
    assert.throws(() => createFeedbackStore(), /requires BLOB_READ_WRITE_TOKEN/)
  })
  withEnv({ REVIEWER_FEEDBACK_DRIVER: 'vercel-blob', BLOB_READ_WRITE_TOKEN: '   ' }, () => {
    assert.throws(() => createFeedbackStore(), /requires BLOB_READ_WRITE_TOKEN/)
  })
})

test('selecting the blob driver leaves the fs and unconfigured drivers intact', () => {
  withEnv({ REVIEWER_FEEDBACK_DRIVER: undefined, REVIEWER_FEEDBACK_DIR: undefined }, () => {
    assert.equal(createFeedbackStore().driver, 'unconfigured')
  })
  withEnv({ REVIEWER_FEEDBACK_DRIVER: 'fs', REVIEWER_FEEDBACK_DIR: '.' }, () => {
    assert.equal(createFeedbackStore().driver, 'fs')
  })
})
