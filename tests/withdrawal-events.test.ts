import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/*
 * Withdrawal events, exercised through both drivers.
 *
 * The record exists so that a shared note taken back does not simply vanish
 * from Mike's inbox with no explanation. Everything about it is a constraint on
 * what it may **not** carry, so most of what is below is an exclusion scan over
 * the bytes that actually reach the store -- not over the object a constructor
 * returned, which is a different and much weaker thing to check.
 */

import {
  WITHDRAWALS_ROOT,
  __resetWithdrawalStore,
  __withdrawalStoreOver,
  asWithdrawalEvent,
  bookWithdrawalsPrefix,
  createWithdrawalStore,
  serializeWithdrawalEvent,
  withdrawalPath,
  type WithdrawalEvent,
  type WithdrawalStore,
} from '../lib/withdrawal-events.ts'
import { createReadingObjects, type ReadingObjects } from '../lib/reviewer-reading.ts'

const BOOK = 'the-backward-becoming'
const NOTE = 'd290f1ee-6c54-4b01-90e6-d701748f0851'

function event(over: Partial<WithdrawalEvent> = {}): WithdrawalEvent {
  return {
    schema: 1,
    noteId: NOTE,
    bookSlug: BOOK,
    scope: 'paragraph',
    chapterSlug: 'chapter-one',
    revision: 3,
    withdrawnAt: '2026-09-16T12:00:00.000Z',
    ...over,
  }
}

/* --------------------------------------------------------- in-memory driver */

function memoryObjects(): ReadingObjects & { store: Map<string, string> } {
  const store = new Map<string, string>()
  const versions = new Map<string, number>()
  let tick = 0

  return {
    driver: 'memory',
    durable: false,
    store,
    async get(path) {
      return store.has(path) ? (store.get(path) as string) : null
    },
    async getVersioned(path) {
      if (!store.has(path)) return { body: null, version: null }
      return { body: store.get(path) as string, version: String(versions.get(path) ?? 0) }
    },
    async putIfMatch(path, body, version) {
      const held = store.has(path) ? String(versions.get(path) ?? 0) : null
      if (held !== version) return false
      tick += 1
      store.set(path, body)
      versions.set(path, tick)
      return true
    },
    async put(path, body) {
      tick += 1
      store.set(path, body)
      versions.set(path, tick)
    },
    async del(path) {
      store.delete(path)
      versions.delete(path)
    },
    async delIfMatch(path, version) {
      if (!store.has(path)) return false
      if (String(versions.get(path) ?? 0) !== version) return false
      store.delete(path)
      versions.delete(path)
      return true
    },
    // Prefix match with no delimiter, which is what the blob service does.
    async list(prefix) {
      return Array.from(store.keys()).filter((key) => key.startsWith(prefix))
    },
  }
}

function fsHarness(): { store: WithdrawalStore; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'mrj-withdrawals-'))
  const saved = {
    driver: process.env.REVIEWER_FEEDBACK_DRIVER,
    readingDir: process.env.REVIEWER_READING_DIR,
  }
  process.env.REVIEWER_FEEDBACK_DRIVER = 'fs'
  process.env.REVIEWER_READING_DIR = dir
  __resetWithdrawalStore()

  return {
    store: createWithdrawalStore(),
    dir,
    cleanup() {
      __resetWithdrawalStore()
      if (saved.driver === undefined) delete process.env.REVIEWER_FEEDBACK_DRIVER
      else process.env.REVIEWER_FEEDBACK_DRIVER = saved.driver
      if (saved.readingDir === undefined) delete process.env.REVIEWER_READING_DIR
      else process.env.REVIEWER_READING_DIR = saved.readingDir
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** The same test against a real directory and against an in-memory store. */
function forEachDriver(name: string, body: (store: WithdrawalStore) => Promise<void>): void {
  test(`${name} [fs]`, async () => {
    const harness = fsHarness()
    try {
      await body(harness.store)
    } finally {
      harness.cleanup()
    }
  })

  test(`${name} [object store]`, async () => {
    await body(__withdrawalStoreOver(memoryObjects()))
  })
}

/* ------------------------------------------------------------------- paths */

test('a withdrawal lives under its own versioned, per-book prefix', () => {
  assert.equal(WITHDRAWALS_ROOT, 'withdrawals/v1')
  assert.equal(bookWithdrawalsPrefix(BOOK), `withdrawals/v1/${BOOK}/`)
  assert.equal(withdrawalPath(BOOK, NOTE), `withdrawals/v1/${BOOK}/${NOTE}.json`)
  // The trailing slash, so a prefix cannot reach a sibling whose name merely
  // begins with the same letters.
  assert.ok(bookWithdrawalsPrefix(BOOK).endsWith('/'))
})

test('a pathname is never built from an identifier this store does not mint', () => {
  for (const bad of ['../escape', 'UPPER', '', 'a'.repeat(200), 'has space', 'a/b']) {
    assert.throws(() => withdrawalPath(BOOK, bad), /invalid note id/, `"${bad}" built a path`)
    assert.throws(() => withdrawalPath(bad, NOTE), /invalid book slug/, `"${bad}" built a path`)
  }
})

/* -------------------------------------------------------- what it may carry */

test('the stored bytes carry exactly seven fields, and no eighth', () => {
  const bytes = serializeWithdrawalEvent(event())
  const parsed = JSON.parse(bytes) as Record<string, unknown>
  assert.deepEqual(
    Object.keys(parsed).sort(),
    ['bookSlug', 'chapterSlug', 'noteId', 'revision', 'schema', 'scope', 'withdrawnAt'],
  )
  assert.ok(bytes.endsWith('\n'), 'the stored object does not end in a newline')
})

test('a caller cannot widen an event by handing the parser a bigger object', () => {
  /*
   * The mutation this refuses is a real one and it is easy to write: a future
   * caller building an event with `{ ...note, schema: 1 }` rather than field by
   * field. `asWithdrawalEvent` reads a fixed list, so everything else on the
   * input is copied nowhere.
   */
  const widened = asWithdrawalEvent({
    ...event(),
    body: 'THE WORDS SOMEBODY TOOK BACK',
    quote: 'A QUOTATION',
    paragraphText: 'A WHOLE PARAGRAPH',
    paragraphId: 'chapter-one-p002',
    startOffset: 4,
    ownerId: 'anna',
    reviewerEmail: 'anna@example.test',
    token: 'a-token',
    path: 'notes/v1/x',
  })

  assert.ok(widened)
  const bytes = serializeWithdrawalEvent(widened)
  for (const forbidden of [
    'THE WORDS SOMEBODY TOOK BACK',
    'A QUOTATION',
    'A WHOLE PARAGRAPH',
    'chapter-one-p002',
    'anna',
    'anna@example.test',
    'a-token',
    'notes/v1/x',
  ]) {
    assert.ok(!bytes.includes(forbidden), `"${forbidden}" survived into a withdrawal event`)
  }
})

test('a damaged event is refused rather than normalised into existence', () => {
  assert.equal(asWithdrawalEvent(null), null)
  assert.equal(asWithdrawalEvent([]), null)
  assert.equal(asWithdrawalEvent({ ...event(), schema: 2 }), null)
  assert.equal(asWithdrawalEvent({ ...event(), noteId: 'NOT AN ID' }), null)
  assert.equal(asWithdrawalEvent({ ...event(), scope: 'margin' }), null)
  assert.equal(asWithdrawalEvent({ ...event(), revision: 0 }), null)
  assert.equal(asWithdrawalEvent({ ...event(), revision: 1.5 }), null)
  assert.equal(asWithdrawalEvent({ ...event(), withdrawnAt: 'whenever' }), null)
  // A book note anchors to nothing, so a chapter on its event is an invention.
  assert.equal(asWithdrawalEvent({ ...event(), scope: 'book', chapterSlug: 'chapter-one' }), null)
  assert.ok(asWithdrawalEvent({ ...event(), scope: 'book', chapterSlug: null }))
  // And a chapter-anchored scope must say which chapter.
  assert.equal(asWithdrawalEvent({ ...event(), chapterSlug: null }), null)
})

/* ---------------------------------------------------------------- the store */

forEachDriver('an event is written once and never re-dated', async (store) => {
  assert.equal(await store.record(event()), 'recorded')

  // A second attempt does not overwrite, does not move the time, and does not
  // report a failure: the deletion it stands for did happen.
  assert.equal(
    await store.record(event({ withdrawnAt: '2030-01-01T00:00:00.000Z', revision: 99 })),
    'already-recorded',
  )

  const stored = await store.get(BOOK, NOTE)
  assert.equal(stored?.withdrawnAt, '2026-09-16T12:00:00.000Z')
  assert.equal(stored?.revision, 3)
})

forEachDriver('a listing is ordered, scoped to its book, and complete', async (store) => {
  await store.record(event({ noteId: 'bbbbbbbb-0000-4000-8000-000000000002', withdrawnAt: '2026-09-16T12:00:02.000Z' }))
  await store.record(event({ noteId: 'aaaaaaaa-0000-4000-8000-000000000001', withdrawnAt: '2026-09-16T12:00:01.000Z' }))
  await store.record(event({ bookSlug: 'persistent', noteId: 'cccccccc-0000-4000-8000-000000000003' }))

  const listing = await store.list(BOOK)
  assert.equal(listing.incomplete, false)
  assert.deepEqual(
    listing.events.map((row) => row.noteId),
    ['aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002'],
    'oldest first, and another book leaked in',
  )

  const other = await store.list('persistent')
  assert.equal(other.events.length, 1)
})

test('an object that is listed and will not parse makes the listing incomplete', async () => {
  const objects = memoryObjects()
  const store = __withdrawalStoreOver(objects)
  await store.record(event())

  // A second object under the prefix that is not an event. The store listed it,
  // so it exists; refusing to read it must not shorten the answer quietly.
  objects.store.set(`${bookWithdrawalsPrefix(BOOK)}broken.json`, '{ not json')

  const listing = await store.list(BOOK)
  assert.equal(listing.incomplete, true, 'an unreadable object was flattened into absence')
  assert.equal(listing.events.length, 1, 'the readable event was lost as well')
})

test('an object that vanishes between the listing and the read is also incomplete', async () => {
  const objects = memoryObjects()
  const store = __withdrawalStoreOver(objects)
  await store.record(event())

  const listed = objects.list.bind(objects)
  objects.list = async (prefix: string) => {
    const paths = await listed(prefix)
    // The store disagreeing with itself. Nothing removes an event, so this is
    // never a legitimate absence.
    return [...paths, `${bookWithdrawalsPrefix(BOOK)}ghost.json`]
  }

  const listing = await store.list(BOOK)
  assert.equal(listing.incomplete, true)
  assert.equal(listing.events.length, 1)
})

test('a read that throws is incomplete, not empty', async () => {
  const objects = memoryObjects()
  const store = __withdrawalStoreOver(objects)
  await store.record(event())

  objects.get = async () => {
    throw new Error('the store did not answer')
  }

  const listing = await store.list(BOOK)
  assert.equal(listing.incomplete, true, 'a refused read was reported as no withdrawals')
  assert.deepEqual(listing.events, [])
})

/* ------------------------------------------------------------- on real disk */

test('nothing of a note reaches the bytes on disk', async () => {
  const harness = fsHarness()
  try {
    await harness.store.record(event())

    const walk = (dir: string): string[] => {
      if (!existsSync(dir)) return []
      const out: string[] = []
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) out.push(...walk(full))
        else out.push(full)
      }
      return out
    }

    const files = walk(harness.dir)
    assert.equal(files.length, 1, 'one event, one object')
    const bytes = readFileSync(files[0], 'utf8')

    /*
     * Field names rather than loose words. `scope` legitimately holds the value
     * "paragraph", so scanning for the bare word would fail on a correct event
     * and prove nothing about an incorrect one; what must never appear is a
     * field carrying an anchor payload, an identity, or somebody's words.
     */
    for (const forbidden of [
      '"body"',
      '"quote"',
      '"paragraphText"',
      '"paragraphId"',
      '"paragraphOrdinal"',
      '"startOffset"',
      '"endOffset"',
      '"ownerId"',
      '"ownerKind"',
      '"reviewerId"',
      '"email"',
      '"token"',
      '"path"',
      '"position"',
      '"manuscriptSha256"',
    ]) {
      assert.ok(!bytes.includes(forbidden), `${forbidden} appears in a stored event`)
    }

    assert.deepEqual(
      Object.keys(JSON.parse(bytes) as Record<string, unknown>).sort(),
      ['bookSlug', 'chapterSlug', 'noteId', 'revision', 'schema', 'scope', 'withdrawnAt'],
    )
  } finally {
    harness.cleanup()
  }
})

test('the configured store is the one these rules were proved against', async () => {
  const harness = fsHarness()
  try {
    const configured = createWithdrawalStore()
    assert.equal(configured.driver, createReadingObjects().driver)
    assert.equal(await configured.record(event()), 'recorded')
  } finally {
    harness.cleanup()
  }
})
