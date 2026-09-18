import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/*
 * Mike's triage metadata: what it may hold, who may touch it, and what a
 * conditional write does when it loses.
 *
 * The record is his, about his handling of what he was shown, and the single
 * thing it must never become is a second copy of what he was shown. So the
 * exclusion scans below run over the **stored bytes** rather than over an object
 * a constructor returned, and the read/write separation is proved by comparing
 * those bytes before and after an operation that must not write.
 */

import {
  AUTHOR_METADATA_ROOT,
  MAX_METADATA_ITEMS,
  MAX_SAVED_VIEWS,
  MAX_VIEW_BOOKS,
  MAX_VIEW_NAME_LENGTH,
  METADATA_WRITE_ATTEMPTS,
  UNTOUCHED,
  __authorMetadataStoreOver,
  __installAuthorMetadataStore,
  __resetAuthorMetadataStore,
  asAuthorMetadata,
  asSavedView,
  authorMetadataPath,
  authorMetadataPrefix,
  createAuthorMetadataStore,
  emptyAuthorMetadata,
  forgetItem,
  isNewSince,
  itemMetadata,
  loadAuthorMetadata,
  markItemOpened,
  putSavedView,
  recordItemsExported,
  removeSavedView,
  serializeAuthorMetadata,
  setItemResolved,
} from '../lib/author-metadata.ts'
import { createReadingObjects, type ReadingObjects } from '../lib/reviewer-reading.ts'
import type { Viewer } from '../lib/reading-access.ts'

const BOOK = 'the-backward-becoming'
const MIKE: Viewer = { kind: 'author', id: 'aa11bb22cc33dd44ee55ff66' }
const ANNA: Viewer = { kind: 'reviewer', id: 'anna', books: [BOOK] }
const ITEM = 'note:d290f1ee-6c54-4b01-90e6-d701748f0851'
const OTHER = 'comment:2d7f0a11-1111-4111-8111-111111111111'

const AT = '2026-09-16T12:00:00.000Z'
const LATER = '2026-09-16T13:00:00.000Z'

/* ------------------------------------------------------------- the harness */

type Harness = { dir: string; cleanup: () => void }

function fsHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'mrj-author-meta-'))
  const saved = {
    driver: process.env.REVIEWER_FEEDBACK_DRIVER,
    readingDir: process.env.REVIEWER_READING_DIR,
  }
  process.env.REVIEWER_FEEDBACK_DRIVER = 'fs'
  process.env.REVIEWER_READING_DIR = dir
  __resetAuthorMetadataStore()

  return {
    dir,
    cleanup() {
      __resetAuthorMetadataStore()
      if (saved.driver === undefined) delete process.env.REVIEWER_FEEDBACK_DRIVER
      else process.env.REVIEWER_FEEDBACK_DRIVER = saved.driver
      if (saved.readingDir === undefined) delete process.env.REVIEWER_READING_DIR
      else process.env.REVIEWER_READING_DIR = saved.readingDir
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Every file beneath a directory, with its bytes. */
function fingerprint(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (at: string) => {
    if (!existsSync(at)) return
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.set(full, readFileSync(full, 'utf8'))
    }
  }
  walk(dir)
  return out
}

async function withStore(body: (harness: Harness) => Promise<void>): Promise<void> {
  const harness = fsHarness()
  try {
    await body(harness)
  } finally {
    harness.cleanup()
  }
}

/* ------------------------------------------------------------------- paths */

test('metadata lives under a versioned, author-scoped prefix', () => {
  assert.equal(AUTHOR_METADATA_ROOT, 'author-meta/v1')
  assert.equal(authorMetadataPrefix(MIKE.id), `author-meta/v1/${MIKE.id}/`)
  assert.equal(authorMetadataPath(MIKE.id, BOOK), `author-meta/v1/${MIKE.id}/${BOOK}.json`)
  for (const bad of ['../escape', 'UPPER', '', 'a/b']) {
    assert.throws(() => authorMetadataPath(MIKE.id, bad), /invalid book slug/)
    assert.throws(() => authorMetadataPath(bad, BOOK), /invalid author id/)
  }
})

/* ---------------------------------------------------- parsing and defaults */

test('an untouched item reads as unresolved, unread and never exported', () => {
  const metadata = emptyAuthorMetadata(BOOK, AT)
  assert.deepEqual(itemMetadata(metadata, ITEM), UNTOUCHED)
  assert.deepEqual(UNTOUCHED, { resolved: false, lastReadAt: null, lastExportedAt: null })
})

/*
 * This test used to bless the opposite rule: a malformed item was dropped and
 * the rest of the document was kept. That is the one conversion this record may
 * not perform. A dropped item does not read as "damaged" anywhere -- it reads
 * as `UNTOUCHED`, and `UNTOUCHED` is a statement, rendered into packets as
 * fact, that Mike has never opened this and never exported it. Whole-document
 * damage was loud and item-level damage was silent, so the smaller the damage
 * the more confidently it lied.
 */
test('a damaged document is refused, and one damaged item damages the document', () => {
  assert.equal(asAuthorMetadata(null, BOOK), null)
  assert.equal(asAuthorMetadata({ schema: 2, bookSlug: BOOK, items: {}, views: [], updatedAt: AT }, BOOK), null)
  // A document for another book read under this one's name is not this one.
  assert.equal(
    asAuthorMetadata({ schema: 1, bookSlug: 'persistent', items: {}, views: [], updatedAt: AT }, BOOK),
    null,
  )

  const document = (items: Record<string, unknown>) => ({
    schema: 1,
    bookSlug: BOOK,
    updatedAt: AT,
    views: [],
    items,
  })

  const sound = asAuthorMetadata(
    document({ [ITEM]: { resolved: true, lastReadAt: AT, lastExportedAt: null } }),
    BOOK,
  )
  assert.ok(sound, 'an undamaged document must still parse')
  assert.deepEqual(Object.keys(sound.items), [ITEM])

  // One damaged entry, in each of the ways an entry can be damaged, alongside a
  // perfectly good one. Every one of them refuses the whole document.
  const damaged: Record<string, unknown>[] = [
    { 'not-an-item-id': { resolved: true, lastReadAt: null, lastExportedAt: null } },
    { [OTHER]: { resolved: 'yes', lastReadAt: null, lastExportedAt: null } },
    { [OTHER]: { resolved: false, lastReadAt: 'not-a-time', lastExportedAt: null } },
    { [OTHER]: { resolved: false, lastReadAt: null, lastExportedAt: 'not-a-time' } },
    { [OTHER]: null },
    { [OTHER]: [] },
    { [OTHER]: 'resolved' },
  ]

  for (const entry of damaged) {
    const items = { [ITEM]: { resolved: true, lastReadAt: AT, lastExportedAt: null }, ...entry }
    assert.equal(
      asAuthorMetadata(document(items), BOOK),
      null,
      `this document was accepted despite ${JSON.stringify(entry)}`,
    )
  }
})

test('an item entry is built from a fixed list, so nothing else survives a round trip', () => {
  const parsed = asAuthorMetadata(
    {
      schema: 1,
      bookSlug: BOOK,
      updatedAt: AT,
      views: [],
      items: {
        [ITEM]: {
          resolved: false,
          lastReadAt: null,
          lastExportedAt: null,
          // Everything a careless `{ ...item }` would drag in.
          body: 'WHAT THE REVIEWER WROTE',
          quote: 'A QUOTATION FROM THE BOOK',
          paragraphText: 'A WHOLE PARAGRAPH',
          reviewerEmail: 'anna@example.test',
          accessCode: 'AAAABBBBCCCCDDDD',
          token: 'a-token',
          path: 'notes/v1/the-backward-becoming/reviewer/anna',
          position: { paragraphId: 'chapter-one-p002' },
        },
      },
    },
    BOOK,
  )

  assert.ok(parsed)

  /*
   * The parsed object first, and the serialized bytes second.
   *
   * Two layers keep this clean -- `asAuthorMetadata` reads a fixed list, and
   * `serializeAuthorMetadata` writes one -- and asserting only on the bytes
   * would let the first layer rot unnoticed behind the second. That matters:
   * the in-memory document is what an operation hands back to its caller, and a
   * caller that serialized it any other way would carry whatever it holds.
   */
  assert.deepEqual(
    Object.keys(parsed.items[ITEM]),
    ['resolved', 'lastReadAt', 'lastExportedAt'],
    'the parsed entry carries a field it may not carry',
  )
  const held = JSON.stringify(parsed)
  for (const forbidden of ['WHAT THE REVIEWER WROTE', 'anna@example.test', 'a-token']) {
    assert.ok(!held.includes(forbidden), `"${forbidden}" survived into the parsed document`)
  }

  const bytes = serializeAuthorMetadata(parsed)
  for (const forbidden of [
    'WHAT THE REVIEWER WROTE',
    'A QUOTATION FROM THE BOOK',
    'A WHOLE PARAGRAPH',
    'anna@example.test',
    'AAAABBBBCCCCDDDD',
    'a-token',
    'notes/v1',
    'chapter-one-p002',
  ]) {
    assert.ok(!bytes.includes(forbidden), `"${forbidden}" survived into author metadata`)
  }
  assert.deepEqual(Object.keys((JSON.parse(bytes) as { items: Record<string, object> }).items[ITEM]), [
    'resolved',
    'lastReadAt',
    'lastExportedAt',
  ])
})

test('a saved view is structural, named, and bounded', () => {
  const good = asSavedView({
    id: 'unresolved-passages',
    name: '  Unresolved   passages  ',
    books: [BOOK],
    kinds: ['note'],
    scopes: ['passage'],
    state: 'new',
  })
  assert.equal(good?.name, 'Unresolved passages', 'whitespace is not normalised')

  // No free-text filter exists, so there is no field a quotation can be pasted
  // into and persisted. An unknown one is refused rather than carried.
  assert.equal(asSavedView({ ...good, kinds: ['note', 'secrets'] }), null)
  assert.equal(asSavedView({ ...good, scopes: ['margin'] }), null)
  assert.equal(asSavedView({ ...good, books: ['NOT A SLUG'] }), null)
  assert.equal(asSavedView({ ...good, state: 'whatever' }), null)
  assert.equal(asSavedView({ ...good, name: '' }), null)
  assert.equal(asSavedView({ ...good, name: 'x'.repeat(200) }), null)

  const parsed = asSavedView({ ...good, quotation: 'WORDS FROM A NOTE' })
  assert.ok(parsed)
  assert.ok(!JSON.stringify(parsed).includes('WORDS FROM A NOTE'))
})

/* ------------------------------------------------------------- New vs read */

test('New is measured against lastReadAt, and nothing else', () => {
  assert.equal(isNewSince(UNTOUCHED, AT), true, 'never opened is always new')
  assert.equal(isNewSince({ ...UNTOUCHED, lastReadAt: AT }, AT), false)
  assert.equal(isNewSince({ ...UNTOUCHED, lastReadAt: AT }, LATER), true, 'edited since he looked')
  // Resolved and exported are separate facts and move neither way.
  assert.equal(isNewSince({ resolved: true, lastReadAt: LATER, lastExportedAt: LATER }, AT), false)
  assert.equal(isNewSince({ resolved: true, lastReadAt: AT, lastExportedAt: LATER }, LATER), true)
})

/* ------------------------------------------------------------ authorisation */

test('a reviewer cannot read or write author metadata, and reaches no store', async () => {
  await withStore(async (harness) => {
    await markItemOpened(MIKE, BOOK, ITEM, AT)
    const before = fingerprint(harness.dir)

    for (const result of [
      await loadAuthorMetadata(ANNA, BOOK, AT),
      await markItemOpened(ANNA, BOOK, ITEM, LATER),
      await setItemResolved(ANNA, BOOK, ITEM, true, LATER),
      await recordItemsExported(ANNA, BOOK, [ITEM], LATER),
      await forgetItem(ANNA, BOOK, ITEM, LATER),
      await removeSavedView(ANNA, BOOK, 'anything', LATER),
    ]) {
      assert.equal(result.ok, false)
      assert.equal(result.ok === false ? result.reason : null, 'forbidden')
    }

    assert.deepEqual(fingerprint(harness.dir), before, 'a reviewer changed author metadata')
  })
})

/* --------------------------------------------------------- read never writes */

test('reading metadata writes nothing, however often it is read', async () => {
  await withStore(async (harness) => {
    await markItemOpened(MIKE, BOOK, ITEM, AT)
    const before = fingerprint(harness.dir)

    for (let i = 0; i < 5; i += 1) {
      const read = await loadAuthorMetadata(MIKE, BOOK, LATER)
      assert.equal(read.ok, true)
    }

    assert.deepEqual(fingerprint(harness.dir), before, 'a read moved the metadata document')
  })
})

test('a book with no document reads as empty at version null, and stays absent', async () => {
  await withStore(async (harness) => {
    const read = await loadAuthorMetadata(MIKE, BOOK, AT)
    assert.equal(read.ok, true)
    if (!read.ok) return
    assert.equal(read.value.version, null)
    assert.deepEqual(read.value.metadata.items, {})
    assert.equal(fingerprint(harness.dir).size, 0, 'reading an absent document created one')
  })
})

/* ------------------------------------------------------------- the writers */

test('only an explicit open moves lastReadAt', async () => {
  await withStore(async () => {
    await setItemResolved(MIKE, BOOK, ITEM, true, AT)
    await recordItemsExported(MIKE, BOOK, [ITEM], AT)

    const before = await loadAuthorMetadata(MIKE, BOOK, AT)
    assert.equal(before.ok && itemMetadata(before.value.metadata, ITEM).lastReadAt, null)

    await markItemOpened(MIKE, BOOK, ITEM, LATER)
    const after = await loadAuthorMetadata(MIKE, BOOK, LATER)
    assert.equal(after.ok && itemMetadata(after.value.metadata, ITEM).lastReadAt, LATER)
    // And opening it changed nothing else.
    assert.equal(after.ok && itemMetadata(after.value.metadata, ITEM).resolved, true)
    assert.equal(after.ok && itemMetadata(after.value.metadata, ITEM).lastExportedAt, AT)
  })
})

test('resolved is reversible, and independent of read and export', async () => {
  await withStore(async () => {
    await setItemResolved(MIKE, BOOK, ITEM, true, AT)
    let read = await loadAuthorMetadata(MIKE, BOOK, AT)
    assert.equal(read.ok && itemMetadata(read.value.metadata, ITEM).resolved, true)
    assert.equal(read.ok && itemMetadata(read.value.metadata, ITEM).lastReadAt, null)

    await setItemResolved(MIKE, BOOK, ITEM, false, LATER)
    read = await loadAuthorMetadata(MIKE, BOOK, LATER)
    assert.equal(read.ok && itemMetadata(read.value.metadata, ITEM).resolved, false)
  })
})

test('an export stamp is per item, and touches nothing else', async () => {
  await withStore(async () => {
    await markItemOpened(MIKE, BOOK, ITEM, AT)
    await recordItemsExported(MIKE, BOOK, [ITEM], LATER)

    const read = await loadAuthorMetadata(MIKE, BOOK, LATER)
    assert.ok(read.ok)
    if (!read.ok) return
    const entry = itemMetadata(read.value.metadata, ITEM)
    assert.equal(entry.lastExportedAt, LATER)
    assert.equal(entry.lastReadAt, AT, 'exporting moved lastReadAt')
    assert.equal(entry.resolved, false, 'exporting resolved something')
    // And an item that was not in the packet was not stamped.
    assert.equal(itemMetadata(read.value.metadata, OTHER).lastExportedAt, null)
  })
})

test('forgetting an item removes its entry entirely', async () => {
  await withStore(async () => {
    await setItemResolved(MIKE, BOOK, ITEM, true, AT)
    await setItemResolved(MIKE, BOOK, OTHER, true, AT)

    await forgetItem(MIKE, BOOK, ITEM, LATER)
    const read = await loadAuthorMetadata(MIKE, BOOK, LATER)
    assert.ok(read.ok)
    if (!read.ok) return
    assert.deepEqual(Object.keys(read.value.metadata.items), [OTHER])
    assert.deepEqual(itemMetadata(read.value.metadata, ITEM), UNTOUCHED)
  })
})

test('a saved view can be added, replaced and removed, and is capped', async () => {
  await withStore(async () => {
    const view = {
      id: 'new-notes',
      name: 'New notes',
      books: [BOOK],
      kinds: ['note'],
      scopes: ['passage'],
      state: 'new',
    }
    assert.equal((await putSavedView(MIKE, BOOK, view, AT)).ok, true)
    assert.equal((await putSavedView(MIKE, BOOK, { ...view, name: 'Renamed' }, LATER)).ok, true)

    let read = await loadAuthorMetadata(MIKE, BOOK, LATER)
    assert.equal(read.ok && read.value.metadata.views.length, 1, 'a replacement added a second')
    assert.equal(read.ok && read.value.metadata.views[0].name, 'Renamed')

    assert.equal((await putSavedView(MIKE, BOOK, { ...view, name: '' }, LATER)).ok, false)

    for (let i = 0; i < MAX_SAVED_VIEWS; i += 1) {
      const outcome = await putSavedView(MIKE, BOOK, { ...view, id: `view-${i}` }, LATER)
      if (!outcome.ok) {
        assert.equal(outcome.reason, 'invalid', 'the cap was reported as something else')
        break
      }
    }
    read = await loadAuthorMetadata(MIKE, BOOK, LATER)
    assert.ok(read.ok && read.value.metadata.views.length <= MAX_SAVED_VIEWS)

    await removeSavedView(MIKE, BOOK, 'new-notes', LATER)
    read = await loadAuthorMetadata(MIKE, BOOK, LATER)
    assert.ok(read.ok && !read.value.metadata.views.some((entry) => entry.id === 'new-notes'))
  })
})

test('a no-op change writes no bytes at all', async () => {
  await withStore(async (harness) => {
    await markItemOpened(MIKE, BOOK, ITEM, AT)
    const before = fingerprint(harness.dir)

    // The same open, again. There is nothing to record, so nothing is recorded.
    assert.equal((await markItemOpened(MIKE, BOOK, ITEM, AT)).ok, true)
    assert.equal((await removeSavedView(MIKE, BOOK, 'never-existed', LATER)).ok, true)
    assert.equal((await forgetItem(MIKE, BOOK, OTHER, LATER)).ok, true)
    assert.equal((await recordItemsExported(MIKE, BOOK, [], LATER)).ok, true)

    assert.deepEqual(fingerprint(harness.dir), before, 'a no-op rewrote the document')
  })
})

/* ------------------------------------------------- conditional concurrency */

test('a write is conditional on the version it read, and a loser retries', async () => {
  /*
   * The interleaving seam: the object layer is asked for the document, and a
   * competing write lands before the conditional put goes out. A metadata
   * change is an intent -- "mark this read" -- so re-deciding it against the
   * newer document gives the same answer, which is why a bounded retry is right
   * here and wrong for a note.
   */
  const objects = memoryObjects()
  const store = __authorMetadataStoreOver(objects)
  __resetAuthorMetadataStore()

  const path = authorMetadataPath(MIKE.id, BOOK)
  await store.writeIfMatch(MIKE.id, emptyAuthorMetadata(BOOK, AT), null)

  const read = await store.read(MIKE.id, BOOK, AT)
  // Somebody else writes. The version the read is holding is now stale.
  await objects.put(path, serializeAuthorMetadata(emptyAuthorMetadata(BOOK, LATER)))

  assert.equal(
    await store.writeIfMatch(MIKE.id, { ...read.metadata, updatedAt: LATER }, read.version),
    false,
    'a conditional write landed against a version that had moved',
  )
})

test('a document that will not stop moving is an honest conflict, not a loop', async () => {
  const objects = memoryObjects()
  const path = authorMetadataPath(MIKE.id, BOOK)
  let writes = 0

  // Every conditional write loses, forever. The bound is what stops this.
  objects.putIfMatch = async () => {
    writes += 1
    return false
  }
  objects.getVersioned = async () => ({
    body: serializeAuthorMetadata(emptyAuthorMetadata(BOOK, AT)),
    version: String(writes),
  })
  objects.get = async () => (path ? null : null)

  __installAuthorMetadataStore(objects)
  try {
    const outcome = await markItemOpened(MIKE, BOOK, ITEM, LATER)
    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false ? outcome.reason : null, 'conflict')
    assert.equal(writes, METADATA_WRITE_ATTEMPTS, 'the retry bound is not the bound it declares')
  } finally {
    __resetAuthorMetadataStore()
  }
})

test('a store that will not answer is unreadable, never an empty document', async () => {
  const objects = memoryObjects()
  objects.getVersioned = async () => {
    throw new Error('the store did not answer')
  }
  __installAuthorMetadataStore(objects)
  try {
    const read = await loadAuthorMetadata(MIKE, BOOK, AT)
    assert.equal(read.ok, false)
    assert.equal(read.ok === false ? read.reason : null, 'unreadable')
  } finally {
    __resetAuthorMetadataStore()
  }
})

test('bytes that are not a document are unreadable, not an empty document', async () => {
  const objects = memoryObjects()
  objects.store.set(authorMetadataPath(MIKE.id, BOOK), '{ "schema": 7 }')
  __installAuthorMetadataStore(objects)
  try {
    const read = await loadAuthorMetadata(MIKE, BOOK, AT)
    assert.equal(read.ok, false)
    assert.equal(read.ok === false ? read.reason : null, 'unreadable')
  } finally {
    __resetAuthorMetadataStore()
  }
})

/*
 * The same refusal, one level down: a document that is structurally a document
 * and whose damage is confined to a single item. This is the case that used to
 * come back `ok` with the item quietly missing, and it is staged through the
 * store rather than through the parser so that what is proved is what a read
 * actually does.
 */
test('a stored document with one damaged item is unreadable at the service too', async () => {
  const objects = memoryObjects()
  objects.store.set(
    authorMetadataPath(MIKE.id, BOOK),
    JSON.stringify({
      schema: 1,
      bookSlug: BOOK,
      updatedAt: AT,
      views: [],
      items: {
        [ITEM]: { resolved: true, lastReadAt: AT, lastExportedAt: AT },
        [OTHER]: { resolved: 'yes', lastReadAt: null, lastExportedAt: null },
      },
    }),
  )
  __installAuthorMetadataStore(objects)
  try {
    const read = await loadAuthorMetadata(MIKE, BOOK, AT)
    assert.equal(read.ok, false, 'the damaged item was silently dropped')
    assert.equal(read.ok === false ? read.reason : null, 'unreadable')

    // And a mutation over the same document refuses for the same reason rather
    // than writing a document with the damaged entry quietly gone.
    const written = await setItemResolved(MIKE, BOOK, ITEM, true, LATER)
    assert.equal(written.ok, false)
    assert.equal(written.ok === false ? written.reason : null, 'unreadable')
  } finally {
    __resetAuthorMetadataStore()
  }
})

test('a saved view filter is a set, its books are capped, and the bytes stay small', async () => {
  const base = {
    id: 'unresolved-passages',
    name: 'Unresolved passages',
    books: [BOOK],
    kinds: ['note'],
    scopes: ['passage'],
    state: 'new',
  }

  // The shape the finding used: ten thousand valid, identical entries in each
  // array. Every value passes its own check, so nothing before this refused
  // them and nothing counted them.
  const flooded = asSavedView({
    ...base,
    books: Array(10_000).fill(BOOK),
    kinds: Array(10_000).fill('note'),
    scopes: Array(10_000).fill('passage'),
  })
  assert.ok(flooded, 'a view of duplicates is normalised, not refused')
  assert.deepEqual(flooded.books, [BOOK])
  assert.deepEqual(flooded.kinds, ['note'])
  assert.deepEqual(flooded.scopes, ['passage'])

  // Order is the order they were first named, not a sort.
  const ordered = asSavedView({
    ...base,
    books: ['persistent', BOOK, 'persistent'],
    kinds: ['comment', 'note', 'comment'],
    scopes: ['book', 'passage', 'book'],
  })
  assert.deepEqual(ordered?.books, ['persistent', BOOK])
  assert.deepEqual(ordered?.kinds, ['comment', 'note'])
  assert.deepEqual(ordered?.scopes, ['book', 'passage'])

  const slugs = (count: number) => Array.from({ length: count }, (_, i) => `book-${i}`)
  assert.equal(asSavedView({ ...base, books: slugs(MAX_VIEW_BOOKS) })?.books.length, MAX_VIEW_BOOKS)
  assert.equal(
    asSavedView({ ...base, books: slugs(MAX_VIEW_BOOKS + 1) }),
    null,
    'one book past the cap was accepted',
  )

  await withStore(async (harness) => {
    // Refused at the operation, with the reason the caller can act on, and
    // nothing written at all.
    const before = fingerprint(harness.dir)
    const over = await putSavedView(MIKE, BOOK, { ...base, books: slugs(MAX_VIEW_BOOKS + 1) }, AT)
    assert.equal(over.ok, false)
    assert.equal(over.ok === false ? over.reason : null, 'invalid')
    assert.deepEqual(fingerprint(harness.dir), before, 'an over-cap view wrote bytes')

    // A document holding the largest views this record permits is still a small
    // object. Without the deduplication above, one view was 650KB on its own.
    for (let i = 0; i < MAX_SAVED_VIEWS; i += 1) {
      const outcome = await putSavedView(
        MIKE,
        BOOK,
        {
          ...base,
          id: `view-${i}`,
          name: 'x'.repeat(MAX_VIEW_NAME_LENGTH),
          books: slugs(MAX_VIEW_BOOKS),
          kinds: ['note', 'comment', 'annotation', 'withdrawal'],
          scopes: ['passage', 'paragraph', 'chapter', 'book'],
        },
        AT,
      )
      assert.equal(outcome.ok, true, `view ${i} of a maximal document was refused`)
    }

    const stored = readFileSync(join(harness.dir, authorMetadataPath(MIKE.id, BOOK)), 'utf8')
    assert.equal(
      asAuthorMetadata(JSON.parse(stored), BOOK)?.views.length,
      MAX_SAVED_VIEWS,
      'the maximal document did not round-trip',
    )
    const CEILING = 512 * 1024
    assert.ok(
      stored.length < CEILING,
      `a maximal saved-view document is ${stored.length} bytes, past the stated ${CEILING}`,
    )
  })
})

/* -------------------------------------------------------------- determinism */

test('two documents holding the same facts serialize identically', () => {
  const one = asAuthorMetadata(
    {
      schema: 1,
      bookSlug: BOOK,
      updatedAt: AT,
      views: [],
      items: {
        [OTHER]: { resolved: false, lastReadAt: null, lastExportedAt: AT },
        [ITEM]: { resolved: true, lastReadAt: AT, lastExportedAt: null },
      },
    },
    BOOK,
  )
  const two = asAuthorMetadata(
    {
      schema: 1,
      bookSlug: BOOK,
      updatedAt: AT,
      views: [],
      items: {
        [ITEM]: { lastExportedAt: null, resolved: true, lastReadAt: AT },
        [OTHER]: { lastReadAt: null, lastExportedAt: AT, resolved: false },
      },
    },
    BOOK,
  )

  assert.ok(one && two)
  assert.equal(serializeAuthorMetadata(one), serializeAuthorMetadata(two))
})

/* ---------------------------------------------------------------- the seams */

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
    async list(prefix) {
      return Array.from(store.keys()).filter((key) => key.startsWith(prefix))
    },
  }
}

test('the configured store is the one these rules were proved against', async () => {
  await withStore(async () => {
    // `createAuthorMetadataStore` is what every operation above reaches for.
    // Proving the rules against a hand-built store and shipping a different one
    // would be proving nothing, so the wiring is asserted rather than assumed.
    assert.equal(createAuthorMetadataStore().driver, createReadingObjects().driver)
  })
})

/* ------------------------------------------------- the accepted read boundary */

/*
 * What a stored document may be, checked where it is *read* rather than only
 * where it is written.
 *
 * Nothing in this module can write a document that breaks any of the four rules
 * below, which is precisely why the write path alone was never a bound: a
 * document that breaks one was written by something else, and that is the moment
 * a confident answer costs the most. Two failure shapes are covered and they are
 * the same failure:
 *
 *   **A refused view was dropped.** The document came back accepted, one view
 *   lighter. A saved view Mike built and can no longer find does not read as
 *   "damaged"; it reads as one he never saved. And a filter past
 *   `MAX_VIEW_BOOKS` -- the exact thing the cap exists to refuse -- got past the
 *   cap by being dropped instead of refusing the document it was in.
 *
 *   **The declared caps were not applied at read time.** `MAX_METADATA_ITEMS`
 *   and `MAX_SAVED_VIEWS` were checked on the way in and nowhere else, so a
 *   stored document holding 5,001 items or 51 views was read back whole and the
 *   bound this record's size rests on was set by whatever wrote the bytes.
 */

const VIEW = {
  id: 'new-notes',
  name: 'New notes',
  books: [BOOK],
  kinds: ['note'],
  scopes: ['passage'],
  state: 'new',
}

function bookSlugs(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `book-${i}`)
}

function savedViews(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({ ...VIEW, id: `view-${i}` }))
}

function storedItems(count: number): Record<string, unknown> {
  const items: Record<string, unknown> = {}
  for (let i = 0; i < count; i += 1) {
    items[`comment:filler-${i}`] = { resolved: false, lastReadAt: null, lastExportedAt: null }
  }
  return items
}

function storedDocument(over: Record<string, unknown>): Record<string, unknown> {
  return { schema: 1, bookSlug: BOOK, updatedAt: AT, items: {}, views: [], ...over }
}

/** Each counterexample, and the largest document of its shape that is still fine. */
const READ_BOUNDARY: {
  what: string
  refused: Record<string, unknown>
  accepted: Record<string, unknown>
}[] = [
  {
    what: 'a malformed saved view beside a sound one',
    refused: storedDocument({ views: [VIEW, { ...VIEW, id: 'broken', state: 'whatever' }] }),
    accepted: storedDocument({ views: [VIEW, { ...VIEW, id: 'broken', state: 'all' }] }),
  },
  {
    what: 'a saved view whose filter names one book past the cap',
    refused: storedDocument({ views: [{ ...VIEW, books: bookSlugs(MAX_VIEW_BOOKS + 1) }] }),
    accepted: storedDocument({ views: [{ ...VIEW, books: bookSlugs(MAX_VIEW_BOOKS) }] }),
  },
  {
    what: 'one saved view past the document cap',
    refused: storedDocument({ views: savedViews(MAX_SAVED_VIEWS + 1) }),
    accepted: storedDocument({ views: savedViews(MAX_SAVED_VIEWS) }),
  },
  {
    what: 'one item past the document cap',
    refused: storedDocument({ items: storedItems(MAX_METADATA_ITEMS + 1) }),
    accepted: storedDocument({ items: storedItems(MAX_METADATA_ITEMS) }),
  },
]

test('a stored document past any declared bound is refused whole, not trimmed', () => {
  for (const { what, refused, accepted } of READ_BOUNDARY) {
    assert.equal(asAuthorMetadata(refused, BOOK), null, `${what} was accepted`)

    /*
     * The other half, and it is what stops this from being satisfied by a parser
     * that refuses everything: the largest document of the same shape that is
     * still within the rule parses, and parses **whole**. A cap proved only by
     * its refusals would be indistinguishable from an off-by-one that refuses
     * the legitimate maximum too.
     */
    const parsed = asAuthorMetadata(accepted, BOOK)
    assert.ok(parsed, `the largest sound document of the shape "${what}" was refused`)
    assert.equal(parsed.views.length, (accepted.views as unknown[]).length, what)
    assert.equal(
      Object.keys(parsed.items).length,
      Object.keys(accepted.items as Record<string, unknown>).length,
      what,
    )
  }
})

test('a stored document past any declared bound is unreadable at the service too', async () => {
  for (const { what, refused, accepted } of READ_BOUNDARY) {
    const objects = memoryObjects()
    objects.store.set(authorMetadataPath(MIKE.id, BOOK), JSON.stringify(refused))
    __installAuthorMetadataStore(objects)
    try {
      const read = await loadAuthorMetadata(MIKE, BOOK, AT)
      assert.equal(read.ok, false, `${what} was read back as a document`)
      assert.equal(read.ok === false ? read.reason : null, 'unreadable', what)

      // A mutation over the same document refuses for the same reason, rather
      // than writing back a document with the offending part quietly gone.
      const written = await setItemResolved(MIKE, BOOK, ITEM, true, LATER)
      assert.equal(written.ok, false, `${what} was written over`)
      assert.equal(written.ok === false ? written.reason : null, 'unreadable', what)
      assert.equal(
        objects.store.get(authorMetadataPath(MIKE.id, BOOK)),
        JSON.stringify(refused),
        `${what} was rewritten by a refused mutation`,
      )
    } finally {
      __resetAuthorMetadataStore()
    }

    // And the sound maximum of the same shape reads back as an ordinary document.
    const sound = memoryObjects()
    sound.store.set(authorMetadataPath(MIKE.id, BOOK), JSON.stringify(accepted))
    __installAuthorMetadataStore(sound)
    try {
      const read = await loadAuthorMetadata(MIKE, BOOK, AT)
      assert.equal(read.ok, true, `the largest sound document of the shape "${what}" was refused`)
    } finally {
      __resetAuthorMetadataStore()
    }
  }
})
