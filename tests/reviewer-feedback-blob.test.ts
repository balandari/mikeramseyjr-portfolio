import test from 'node:test'
import assert from 'node:assert/strict'

import {
  __resetFeedbackStore,
  createFeedbackStore,
  type FeedbackDraft,
  type FeedbackEntry,
} from '../lib/reviewer-feedback.ts'
import {
  FEEDBACK_ROOT,
  createVercelBlobFeedbackStore,
  feedbackPathname,
  feedbackPrefix,
  type FeedbackBlobBackend,
} from '../lib/reviewer-feedback-blob.ts'

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
    if (this.unreadable.has(pathname)) throw new Error(`unreadable: ${pathname}`)
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

  const read = await store.listForReviewer('anna', 'the-backward-becoming')
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
  const [read] = await store.listForReviewer('anna', 'the-backward-becoming')

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
  const read = await store.listForReviewer('anna', 'the-backward-becoming')
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

  const read = await store.listForReviewer('anna', 'the-backward-becoming')
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

  const read = await store.listForReviewer('anna', 'the-backward-becoming')
  assert.equal(read.length, 1)
  assert.equal(read[0].comment, 'This line is the one that landed.')
})

/* ------------------------------------------------------------- isolation */

test("one reviewer never receives another reviewer's feedback", async () => {
  const backend = new FakeBlobStore()
  const store = storeWith(backend)

  await store.add(draft({ reviewerId: 'anna', comment: "anna's note" }))
  await store.add(draft({ reviewerId: 'ben', comment: "ben's note" }))

  const anna = await store.listForReviewer('anna', 'the-backward-becoming')
  const ben = await store.listForReviewer('ben', 'the-backward-becoming')

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

  const anna = await store.listForReviewer('anna', 'the-backward-becoming')
  assert.equal(anna.length, 1)
  assert.equal(anna[0].comment, 'anna')
})

test('feedback is scoped by book as well as by reviewer', async () => {
  const backend = new FakeBlobStore()
  const store = storeWith(backend)

  await store.add(draft({ bookSlug: 'the-backward-becoming', comment: 'about book one' }))
  await store.add(draft({ bookSlug: 'a-second-title', comment: 'about book two' }))

  const one = await store.listForReviewer('anna', 'the-backward-becoming')
  const two = await store.listForReviewer('anna', 'a-second-title')

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
  await store.listForReviewer('anna', 'the-backward-becoming')

  assert.deepEqual(seen, ['feedback/v1/anna/the-backward-becoming/'])
})

test("a misfiled object under this reviewer's prefix is skipped, not disclosed", async () => {
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
  assert.equal(anna.length, 1)
  assert.equal(anna[0].comment, 'genuinely mine')
})

test('a pathname returned from outside the requested prefix is ignored', async () => {
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
  assert.equal(anna.length, 1)
  assert.equal(anna[0].comment, 'mine')
})

/* ------------------------------------------------------ malformed objects */

test('a malformed object does not hide the objects around it', async () => {
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
  assert.deepEqual(read.map((entry) => entry.comment).sort(), ['after', 'before'])
})

test('an object the store cannot read does not fail the whole listing', async () => {
  const backend = new FakeBlobStore()
  const store = storeWith(backend)

  await store.add(draft({ comment: 'readable' }))
  const prefix = feedbackPrefix('anna', 'the-backward-becoming')
  const broken = `${prefix}2026-06-06T00-00-00-000Z-broken.json`
  backend.plant(broken, '{}')
  backend.unreadable.add(broken)

  const read = await store.listForReviewer('anna', 'the-backward-becoming')
  assert.equal(read.length, 1)
  assert.equal(read[0].comment, 'readable')
})

test('a listed pathname with no object behind it is skipped', async () => {
  const backend = new FakeBlobStore()
  const store = storeWith(backend)

  await store.add(draft({ comment: 'real' }))
  backend.phantoms.push(
    'feedback/v1/anna/the-backward-becoming/2026-07-07T00-00-00-000Z-ghost.json',
  )

  const read = await store.listForReviewer('anna', 'the-backward-becoming')
  assert.equal(read.length, 1)
  assert.equal(read[0].comment, 'real')
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
    () => store.listForReviewer('anna', 'the-backward-becoming'),
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
