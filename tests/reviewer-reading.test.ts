import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  READING_ROOT,
  ReadingStorageUnavailableError,
  __readingStoreOver,
  __resetReadingStore,
  annotationPath,
  asAnnotation,
  asBookmark,
  asPosition,
  bookPrefix,
  createReadingStore,
  mintShareToken,
  normalizeNote,
  sharePath,
  type Annotation,
  type ReadingObjects,
  type ReadingPosition,
  type ReadingStore,
} from '../lib/reviewer-reading.ts'
import { MAX_NOTE_LENGTH } from '../lib/reading-anchor.ts'
import type { OwnerRef } from '../lib/reading-access.ts'

/*
 * The store, exercised through both drivers.
 *
 * Every behavioural test below runs twice: once against a real directory on
 * disk, and once against an in-memory object layer standing in for the blob
 * store. That is what makes the isolation claims real rather than a property of
 * one implementation -- the rules live in the store, not in a driver.
 */

const ANNA: OwnerRef = { kind: 'reviewer', id: 'anna' }
const BEN: OwnerRef = { kind: 'reviewer', id: 'ben' }
const MIKE: OwnerRef = { kind: 'author', id: 'aa11bb22cc33dd44ee55ff66' }
const BOOK = 'the-backward-becoming'

/* --------------------------------------------------------- in-memory driver */

function memoryObjects(): ReadingObjects & { store: Map<string, string> } {
  const store = new Map<string, string>()
  /*
   * A revision that is a counter rather than a digest, so two writes of
   * identical bytes are still two revisions. A content digest would let a
   * conditional write succeed against a *different* write that happened to
   * produce the same bytes, which is exactly the interleaving these tests exist
   * to catch -- the double is stricter than the drivers, never looser.
   */
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
    async list(prefix) {
      return Array.from(store.keys()).filter((key) => key.startsWith(prefix))
    },
  }
}

/** A real directory on disk, through the configured `fs` driver. */
function fsStore(): { store: ReadingStore; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'mrj-reading-'))
  const saved = {
    driver: process.env.REVIEWER_FEEDBACK_DRIVER,
    feedbackDir: process.env.REVIEWER_FEEDBACK_DIR,
    readingDir: process.env.REVIEWER_READING_DIR,
  }
  process.env.REVIEWER_FEEDBACK_DRIVER = 'fs'
  process.env.REVIEWER_READING_DIR = dir
  __resetReadingStore()
  const store = createReadingStore()

  return {
    store,
    dir,
    cleanup() {
      __resetReadingStore()
      if (saved.driver === undefined) delete process.env.REVIEWER_FEEDBACK_DRIVER
      else process.env.REVIEWER_FEEDBACK_DRIVER = saved.driver
      if (saved.feedbackDir === undefined) delete process.env.REVIEWER_FEEDBACK_DIR
      else process.env.REVIEWER_FEEDBACK_DIR = saved.feedbackDir
      if (saved.readingDir === undefined) delete process.env.REVIEWER_READING_DIR
      else process.env.REVIEWER_READING_DIR = saved.readingDir
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Run one body against both drivers, so neither can drift from the other. */
function forEachDriver(
  name: string,
  body: (store: ReadingStore) => Promise<void>,
): void {
  test(`${name} [fs]`, async () => {
    const harness = fsStore()
    try {
      await body(harness.store)
    } finally {
      harness.cleanup()
    }
  })

  test(`${name} [object store]`, async () => {
    await body(__readingStoreOver(memoryObjects()))
  })
}

/* ------------------------------------------------------------------ drafts */

function positionFor(owner: OwnerRef, overrides: Partial<ReadingPosition> = {}): ReadingPosition {
  return {
    schema: 1,
    ownerKind: owner.kind,
    ownerId: owner.id,
    bookSlug: BOOK,
    bookTitle: 'The Backward Becoming',
    chapterSlug: 'chapter-two',
    chapterNumber: 2,
    chapterLabel: 'Chapter Two',
    paragraphId: 'chapter-two-p014',
    paragraphOrdinal: 14,
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

function bookmarkDraft(owner: OwnerRef, ordinal = 12, chapter = 'chapter-one') {
  return {
    ownerKind: owner.kind,
    ownerId: owner.id,
    bookSlug: BOOK,
    chapterSlug: chapter,
    chapterNumber: chapter === 'chapter-one' ? 1 : 2,
    chapterLabel: chapter === 'chapter-one' ? 'Chapter One' : 'Chapter Two',
    paragraphId: `${chapter}-p${String(ordinal).padStart(3, '0')}`,
    paragraphOrdinal: ordinal,
    excerpt: 'A short excerpt copied from the manuscript.',
    manuscriptSha256: 'a'.repeat(64),
  }
}

function annotationDraft(
  owner: OwnerRef,
  overrides: Partial<Omit<Annotation, 'schema' | 'id' | 'createdAt' | 'updatedAt' | 'shareToken'>> = {},
) {
  return {
    ownerKind: owner.kind,
    ownerId: owner.id,
    bookSlug: BOOK,
    chapterSlug: 'chapter-one',
    chapterNumber: 1,
    chapterLabel: 'Chapter One',
    paragraphId: 'chapter-one-p003',
    paragraphOrdinal: 3,
    startOffset: 4,
    endOffset: 16,
    quote: 'said nothing',
    manuscriptSha256: 'b'.repeat(64),
    note: null as string | null,
    visibility: 'private' as const,
    ...overrides,
  }
}

/* ------------------------------------------------------------------ layout */

test('every path a record can occupy is beneath its own owner and book prefix', () => {
  const prefix = bookPrefix(ANNA, BOOK)
  assert.equal(prefix, `${READING_ROOT}/reviewer/anna/${BOOK}/`)
  assert.ok(annotationPath(ANNA, BOOK, 'abc-123').startsWith(prefix))

  // The author's records are a different namespace entirely, by path.
  assert.ok(bookPrefix(MIKE, BOOK).startsWith(`${READING_ROOT}/author/`))
  assert.ok(!bookPrefix(MIKE, BOOK).startsWith(`${READING_ROOT}/reviewer/`))
})

test('a path is refused rather than built when any part of it is the wrong shape', () => {
  for (const id of ['../evil', 'Anna', 'a/b', '', 'x'.repeat(80)]) {
    assert.throws(() => bookPrefix({ kind: 'reviewer', id }, BOOK), /invalid owner id/)
  }
  for (const slug of ['../secret', 'Book', 'a/b', '']) {
    assert.throws(() => bookPrefix(ANNA, slug), /invalid book slug/)
  }
  for (const id of ['../x', 'A1', 'a/b', '']) {
    assert.throws(() => annotationPath(ANNA, BOOK, id), /invalid record id/)
  }
  for (const token of ['', 'nothex', 'a'.repeat(31), 'A'.repeat(32), '../x']) {
    assert.throws(() => sharePath(token), /invalid share token/)
  }
})

test('a minted share token is 128 bits of hex, and never repeats', () => {
  const seen = new Set<string>()
  for (let index = 0; index < 200; index += 1) {
    const token = mintShareToken()
    assert.match(token, /^[a-f0-9]{32}$/)
    assert.ok(!seen.has(token))
    seen.add(token)
  }
})

/* ---------------------------------------------------------------- position */

forEachDriver('one automatic position per owner per book, overwritten in place', async (store) => {
  assert.equal(await store.readPosition(ANNA, BOOK), null)

  await store.writePosition(positionFor(ANNA, { paragraphId: 'chapter-one-p002', paragraphOrdinal: 2 }))
  await store.writePosition(positionFor(ANNA, { paragraphId: 'chapter-two-p030', paragraphOrdinal: 30 }))

  const position = await store.readPosition(ANNA, BOOK)
  assert.equal(position?.paragraphId, 'chapter-two-p030')

  // One per book, so there is nothing to accumulate and nothing to remove.
  assert.equal((await store.listBookmarks(ANNA, BOOK)).length, 0)
})

forEachDriver('a position is invisible to every other owner', async (store) => {
  await store.writePosition(positionFor(ANNA))
  assert.equal(await store.readPosition(BEN, BOOK), null)
  assert.equal(await store.readPosition(MIKE, BOOK), null)
  assert.equal(await store.readPosition(ANNA, 'another-book'), null)
})

/* --------------------------------------------------------------- bookmarks */

forEachDriver('many bookmarks coexist in one book, and each can be removed alone', async (store) => {
  const first = await store.addBookmark(bookmarkDraft(ANNA, 4, 'chapter-one'))
  const second = await store.addBookmark(bookmarkDraft(ANNA, 19, 'chapter-one'))
  const third = await store.addBookmark(bookmarkDraft(ANNA, 7, 'chapter-two'))

  const all = await store.listBookmarks(ANNA, BOOK)
  assert.equal(all.length, 3, 'a second bookmark does not replace the first')

  // Reading order: chapter, then paragraph.
  assert.deepEqual(
    all.map((bookmark) => [bookmark.chapterNumber, bookmark.paragraphOrdinal]),
    [
      [1, 4],
      [1, 19],
      [2, 7],
    ],
  )

  assert.equal(await store.removeBookmark(ANNA, BOOK, second.id), true)
  const left = await store.listBookmarks(ANNA, BOOK)
  assert.deepEqual(left.map((bookmark) => bookmark.id).sort(), [first.id, third.id].sort())
})

forEachDriver('removing a bookmark that is not yours does nothing', async (store) => {
  const mine = await store.addBookmark(bookmarkDraft(ANNA))
  assert.equal(await store.removeBookmark(BEN, BOOK, mine.id), false)
  assert.equal((await store.listBookmarks(ANNA, BOOK)).length, 1, 'still there')
})

forEachDriver('one reviewer never sees another reviewer’s bookmarks', async (store) => {
  await store.addBookmark(bookmarkDraft(ANNA, 4))
  await store.addBookmark(bookmarkDraft(BEN, 9))

  assert.deepEqual(
    (await store.listBookmarks(ANNA, BOOK)).map((row) => row.paragraphOrdinal),
    [4],
  )
  assert.deepEqual(
    (await store.listBookmarks(BEN, BOOK)).map((row) => row.paragraphOrdinal),
    [9],
  )
  assert.equal((await store.listBookmarks(MIKE, BOOK)).length, 0)
})

forEachDriver('the author’s bookmarks are a separate namespace from every reviewer’s', async (store) => {
  await store.addBookmark(bookmarkDraft(ANNA, 4))
  const authorMark = await store.addBookmark(bookmarkDraft(MIKE, 4))

  // Same book, same paragraph, two records that cannot see each other.
  assert.equal((await store.listBookmarks(MIKE, BOOK)).length, 1)
  assert.equal((await store.listBookmarks(ANNA, BOOK)).length, 1)
  assert.equal(await store.removeBookmark(ANNA, BOOK, authorMark.id), false)
})

/* ------------------------------------------------------------- annotations */

forEachDriver('an annotation is stored with its anchor and can carry no note at all', async (store) => {
  const highlight = await store.addAnnotation(annotationDraft(ANNA))
  assert.equal(highlight.note, null, 'a highlight with nothing written is a complete record')
  assert.equal(highlight.visibility, 'private')
  assert.equal(highlight.shareToken, null, 'no locator is minted until one is needed')
  assert.equal(highlight.quote, 'said nothing')
  assert.equal(highlight.manuscriptSha256, 'b'.repeat(64))

  const read = await store.getAnnotation(ANNA, BOOK, highlight.id)
  assert.deepEqual(read, highlight)
})

forEachDriver('an annotation is reachable only beneath its own owner’s prefix', async (store) => {
  const mine = await store.addAnnotation(annotationDraft(ANNA, { visibility: 'link' }))

  // A guessed identifier, presented by somebody else, reaches nothing.
  assert.equal(await store.getAnnotation(BEN, BOOK, mine.id), null)
  assert.equal(await store.getAnnotation(MIKE, BOOK, mine.id), null)
  assert.equal(await store.removeAnnotation(BEN, BOOK, mine.id), false)
  assert.equal(await store.updateAnnotation(BEN, BOOK, mine.id, { visibility: 'private' }), null)

  // And it is still exactly as its owner left it.
  const after = await store.getAnnotation(ANNA, BOOK, mine.id)
  assert.equal(after?.visibility, 'link')
})

forEachDriver('changing an annotation never changes its anchor', async (store) => {
  const created = await store.addAnnotation(annotationDraft(ANNA))
  const updated = await store.updateAnnotation(ANNA, BOOK, created.id, {
    note: 'This is the line.',
    visibility: 'author',
  })

  assert.equal(updated?.note, 'This is the line.')
  assert.equal(updated?.visibility, 'author')
  // The five things that say where it is are untouched.
  assert.equal(updated?.paragraphId, created.paragraphId)
  assert.equal(updated?.startOffset, created.startOffset)
  assert.equal(updated?.endOffset, created.endOffset)
  assert.equal(updated?.quote, created.quote)
  assert.equal(updated?.manuscriptSha256, created.manuscriptSha256)
  assert.equal(updated?.createdAt, created.createdAt)
})

/* ------------------------------------------------------------ private links */

forEachDriver('a share token resolves to a locator, and only to a locator', async (store) => {
  const shared = await store.addAnnotation(annotationDraft(ANNA, { visibility: 'link' }))
  assert.match(shared.shareToken ?? '', /^[a-f0-9]{32}$/)

  const ref = await store.resolveShareToken(shared.shareToken as string)
  assert.deepEqual(ref, {
    schema: 1,
    ownerKind: 'reviewer',
    ownerId: 'anna',
    bookSlug: BOOK,
    annotationId: shared.id,
  })
  // The locator carries no quotation, no note and no offsets.
  assert.equal(Object.keys(ref ?? {}).includes('quote'), false)
  assert.equal(Object.keys(ref ?? {}).includes('note'), false)
})

forEachDriver('a token nobody minted resolves to nothing', async (store) => {
  assert.equal(await store.resolveShareToken('f'.repeat(32)), null)
  assert.equal(await store.resolveShareToken('not-a-token'), null)
  assert.equal(await store.resolveShareToken(''), null)
})

forEachDriver('deleting an annotation withdraws its private link first', async (store) => {
  const shared = await store.addAnnotation(annotationDraft(ANNA, { visibility: 'link' }))
  const token = shared.shareToken as string

  assert.notEqual(await store.resolveShareToken(token), null)
  assert.equal(await store.removeAnnotation(ANNA, BOOK, shared.id), true)
  assert.equal(await store.resolveShareToken(token), null, 'the locator is gone too')
  assert.equal(await store.getAnnotation(ANNA, BOOK, shared.id), null)
})

forEachDriver('a link minted once survives narrowing and re-widening the sharing', async (store) => {
  const shared = await store.addAnnotation(annotationDraft(ANNA, { visibility: 'link' }))
  const token = shared.shareToken as string

  const narrowed = await store.updateAnnotation(ANNA, BOOK, shared.id, { visibility: 'private' })
  assert.equal(narrowed?.shareToken, token, 'the same locator is kept')

  const widened = await store.updateAnnotation(ANNA, BOOK, shared.id, { visibility: 'link' })
  assert.equal(widened?.shareToken, token, 'and it is the same link that works again')
})

/* ----------------------------------------------------------- stored objects */

test('a corrupt or foreign object is skipped, never handed on half-formed [fs]', async () => {
  const harness = fsStore()
  try {
    const good = await harness.store.addBookmark(bookmarkDraft(ANNA, 4))
    assert.equal((await harness.store.listBookmarks(ANNA, BOOK)).length, 1)

    const dir = join(harness.dir, `${READING_ROOT}/reviewer/anna/${BOOK}/bookmarks`)
    writeFileSync(join(dir, 'truncated.json'), '{"schema":1,"ownerKind":"rev', 'utf8')
    writeFileSync(join(dir, 'other-schema.json'), '{"schema":9,"id":"x"}', 'utf8')
    writeFileSync(
      join(dir, 'misfiled.json'),
      JSON.stringify({ ...good, id: 'aaaa-bbbb', ownerId: 'ben' }),
      'utf8',
    )

    const rows = await harness.store.listBookmarks(ANNA, BOOK)
    assert.equal(rows.length, 1, 'only the real row comes back')
    assert.equal(rows[0].id, good.id)
  } finally {
    harness.cleanup()
  }
})

test('the fs driver cannot be made to write outside its root [fs]', async () => {
  const harness = fsStore()
  try {
    // Every public path builder refuses the shapes that would be needed, so the
    // escape is unreachable through the store's own API.
    assert.throws(() => bookPrefix({ kind: 'reviewer', id: '..' }, BOOK))
    await assert.rejects(
      () => harness.store.removeBookmark(ANNA, BOOK, '../../../etc/passwd'),
      /invalid record id/,
    )
  } finally {
    harness.cleanup()
  }
})

/* ------------------------------------------------------------ unconfigured */

test('an unconfigured deployment refuses a write loudly and reads as empty', async () => {
  const saved = process.env.REVIEWER_FEEDBACK_DRIVER
  delete process.env.REVIEWER_FEEDBACK_DRIVER
  __resetReadingStore()
  try {
    const store = createReadingStore()
    assert.equal(store.driver, 'unconfigured')
    assert.equal(store.durable, false)

    assert.equal(await store.readPosition(ANNA, BOOK), null)
    assert.deepEqual(await store.listBookmarks(ANNA, BOOK), [])

    await assert.rejects(
      () => store.addBookmark(bookmarkDraft(ANNA)),
      ReadingStorageUnavailableError,
    )
    await assert.rejects(
      () => store.writePosition(positionFor(ANNA)),
      ReadingStorageUnavailableError,
    )
  } finally {
    __resetReadingStore()
    if (saved === undefined) delete process.env.REVIEWER_FEEDBACK_DRIVER
    else process.env.REVIEWER_FEEDBACK_DRIVER = saved
  }
})

test('the fs driver defaults its directory beside the feedback rows', () => {
  const saved = {
    driver: process.env.REVIEWER_FEEDBACK_DRIVER,
    feedbackDir: process.env.REVIEWER_FEEDBACK_DIR,
    readingDir: process.env.REVIEWER_READING_DIR,
  }
  const dir = mkdtempSync(join(tmpdir(), 'mrj-reading-default-'))
  try {
    process.env.REVIEWER_FEEDBACK_DRIVER = 'fs'
    process.env.REVIEWER_FEEDBACK_DIR = dir
    delete process.env.REVIEWER_READING_DIR
    __resetReadingStore()
    const store = createReadingStore()
    assert.equal(store.driver, 'fs')
  } finally {
    __resetReadingStore()
    for (const [key, value] of Object.entries({
      REVIEWER_FEEDBACK_DRIVER: saved.driver,
      REVIEWER_FEEDBACK_DIR: saved.feedbackDir,
      REVIEWER_READING_DIR: saved.readingDir,
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

/* -------------------------------------------------------------- validation */

test('notes are normalised, and an over-long one is refused rather than truncated', () => {
  assert.equal(normalizeNote('  spaced  '), 'spaced')
  assert.equal(normalizeNote(''), null)
  assert.equal(normalizeNote('   '), null)
  assert.equal(normalizeNote(null), null)
  assert.equal(normalizeNote(undefined), null)
  assert.equal(normalizeNote('a\r\nb'), 'a\nb')
  assert.equal(normalizeNote('a\n\n\n\n\nb'), 'a\n\nb')
  assert.equal(normalizeNote(42), undefined, 'not a string is a refusal')
  assert.equal(normalizeNote('x'.repeat(MAX_NOTE_LENGTH + 1)), undefined)
  assert.equal(normalizeNote('x'.repeat(MAX_NOTE_LENGTH))?.length, MAX_NOTE_LENGTH)
})

test('a stored object is accepted only when it really is a row of this schema', () => {
  assert.equal(asPosition(null), null)
  assert.equal(asPosition([]), null)
  assert.equal(asBookmark({ schema: 2 }), null)
  assert.equal(asAnnotation({ schema: 1, ownerKind: 'nobody' }), null)

  const annotation = {
    schema: 1,
    id: 'aaaa-bbbb',
    ownerKind: 'reviewer',
    ownerId: 'anna',
    bookSlug: BOOK,
    chapterSlug: 'chapter-one',
    chapterNumber: 1,
    chapterLabel: 'Chapter One',
    paragraphId: 'chapter-one-p003',
    paragraphOrdinal: 3,
    startOffset: 4,
    endOffset: 16,
    quote: 'said nothing',
    manuscriptSha256: 'b'.repeat(64),
    note: null,
    visibility: 'private',
    shareToken: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  assert.notEqual(asAnnotation(annotation), null)

  // Each of these on its own is enough to reject the object.
  assert.equal(asAnnotation({ ...annotation, endOffset: 4 }), null, 'empty span')
  assert.equal(asAnnotation({ ...annotation, quote: '' }), null, 'no quotation')
  assert.equal(asAnnotation({ ...annotation, visibility: 'public' }), null, 'invented visibility')
  assert.equal(asAnnotation({ ...annotation, shareToken: 'short' }), null, 'malformed token')
  assert.equal(asAnnotation({ ...annotation, ownerId: '../x' }), null, 'unusable owner id')
})

/*
 * The optional sub-paragraph offset.
 *
 * Added so a reader who stops nine lines into a ten-line paragraph comes back
 * to line nine rather than line one. It is optional on purpose: every position
 * written before it existed lacks the field, and those records must keep
 * working exactly as they did, which is what these assert.
 */

test('a position written before the offset existed is still a valid position', () => {
  const legacy = {
    schema: 1,
    ownerKind: 'reviewer',
    ownerId: 'anna-vasquez',
    bookSlug: 'the-backward-becoming',
    bookTitle: 'The Backward Becoming',
    chapterSlug: 'chapter-one',
    chapterNumber: 1,
    chapterLabel: 'Chapter One',
    paragraphId: 'chapter-one-p019',
    paragraphOrdinal: 19,
    updatedAt: '2026-09-13T00:00:00.000Z',
  }

  const parsed = asPosition(legacy)
  assert.ok(parsed, 'a record with no paragraphOffset is still accepted')
  assert.equal(parsed?.paragraphId, 'chapter-one-p019')
  assert.equal(parsed?.paragraphOffset, undefined)
})

test('a position carrying an offset round-trips it', () => {
  const withOffset = {
    schema: 1,
    ownerKind: 'reviewer',
    ownerId: 'anna-vasquez',
    bookSlug: 'the-backward-becoming',
    bookTitle: 'The Backward Becoming',
    chapterSlug: 'chapter-one',
    chapterNumber: 1,
    chapterLabel: 'Chapter One',
    paragraphId: 'chapter-one-p019',
    paragraphOrdinal: 19,
    paragraphOffset: 0.685,
    updatedAt: '2026-09-13T00:00:00.000Z',
  }

  const parsed = asPosition(withOffset)
  assert.ok(parsed)
  assert.equal(parsed?.paragraphOffset, 0.685)
})
