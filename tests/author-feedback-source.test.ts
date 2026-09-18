import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/*
 * The one normalized source over everything Mike is entitled to see.
 *
 * Two questions are asked of it here and they are different questions:
 *
 *   **what gets in** -- a reviewer's shared note, Mike's own notes, a permitted
 *   legacy annotation, an immutable submitted comment, a bodyless withdrawal --
 *   and, far more importantly, what never does. A reviewer's private note at
 *   any scope, a private highlight, a reading position, an address, a code, a
 *   token, a path. Those are scanned for **by name over a serialized source**,
 *   which is the only form of the question that a future refactor cannot pass
 *   by accident.
 *
 *   **what an unreadable store does to the answer.** A book the manifest does
 *   not hold is a local fact and a legitimate not-found. A store that was asked
 *   and did not answer is an incompleteness, and the two must never be merged:
 *   "nobody has said anything about your book" and "the store did not answer"
 *   look identical on a page unless something insists they are told apart.
 */

import {
  loadAuthorFeedbackSource,
  itemOrderKey,
  type AuthorFeedbackItem,
} from '../lib/author-feedback-source.ts'
import { createNote, deleteNote } from '../lib/note-service.ts'
import { addAnnotation, updateAnnotation } from '../lib/reading-service.ts'
import { __resetNoteStore } from '../lib/notes-store.ts'
import { __resetReadingStore, createReadingStore } from '../lib/reviewer-reading.ts'
import { __resetWithdrawalStore } from '../lib/withdrawal-events.ts'
import { __resetAuthorMetadataStore } from '../lib/author-metadata.ts'
import { __resetRosterStore } from '../lib/reviewer-roster.ts'
import { __resetFeedbackStore, createFeedbackStore } from '../lib/reviewer-feedback.ts'
import type { Viewer } from '../lib/reading-access.ts'

const BOOK = 'the-backward-becoming'
const CHAPTER = 'chapter-one'
const PARAGRAPH = `${CHAPTER}-p002`

const ANNA: Viewer = { kind: 'reviewer', id: 'anna', books: [BOOK] }
const BEN: Viewer = { kind: 'reviewer', id: 'ben', books: [BOOK] }
const MIKE: Viewer = { kind: 'author', id: 'aa11bb22cc33dd44ee55ff66' }

const ROSTER = JSON.stringify([
  { id: 'anna', name: 'Anna Reviewer', books: [BOOK], codeHash: 'a'.repeat(64) },
  { id: 'ben', name: 'Ben Reviewer', books: [BOOK], codeHash: 'b'.repeat(64) },
])

/** A second book in the manifest, for the requested-book boundary below. */
const OTHER_BOOK = 'persistent'

/** The same roster, with Anna carrying a second book on her entry. */
const TWO_BOOK_ROSTER = JSON.stringify([
  { id: 'anna', name: 'Anna Reviewer', books: [BOOK, OTHER_BOOK], codeHash: 'a'.repeat(64) },
  { id: 'ben', name: 'Ben Reviewer', books: [BOOK], codeHash: 'b'.repeat(64) },
])

/* ------------------------------------------------------------- the harness */

type World = { dir: string; cleanup: () => void }

const KEYS = [
  'REVIEWER_FEEDBACK_DRIVER',
  'REVIEWER_FEEDBACK_DIR',
  'REVIEWER_READING_DIR',
  'REVIEWER_ROSTER_DRIVER',
  'REVIEWER_ROSTER',
] as const

function world(): World {
  const dir = mkdtempSync(join(tmpdir(), 'mrj-author-source-'))
  const saved = new Map(KEYS.map((key) => [key, process.env[key]]))
  const feedbackDir = join(dir, 'feedback')
  mkdirSync(feedbackDir, { recursive: true })

  process.env.REVIEWER_FEEDBACK_DRIVER = 'fs'
  process.env.REVIEWER_FEEDBACK_DIR = feedbackDir
  process.env.REVIEWER_READING_DIR = join(dir, 'reading')
  process.env.REVIEWER_ROSTER_DRIVER = 'env'
  process.env.REVIEWER_ROSTER = ROSTER
  resetStores()

  return {
    dir,
    cleanup() {
      resetStores()
      for (const key of KEYS) {
        const value = saved.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function resetStores(): void {
  __resetNoteStore()
  __resetReadingStore()
  __resetWithdrawalStore()
  __resetAuthorMetadataStore()
  __resetRosterStore()
  __resetFeedbackStore()
}

async function inWorld(body: (world: World) => Promise<void>): Promise<void> {
  const harness = world()
  try {
    await body(harness)
  } finally {
    harness.cleanup()
  }
}

async function note(
  viewer: Viewer,
  body: string,
  over: Record<string, unknown> = {},
): Promise<{ id: string; revision: number }> {
  const created = await createNote(viewer, {
    bookSlug: BOOK,
    scope: 'chapter',
    chapterSlug: CHAPTER,
    body,
    visibility: 'shared',
    ...over,
  })
  assert.equal(created.ok, true, `creating "${body}" failed`)
  if (!created.ok) throw new Error('unreachable')
  return { id: created.value.id, revision: created.value.revision }
}

function bodies(items: AuthorFeedbackItem[]): (string | null)[] {
  return items.map((item) => item.body)
}

/** Swap the roster this world was started with, for the tests that need two books. */
function withRoster(roster: string): void {
  process.env.REVIEWER_ROSTER = roster
  __resetRosterStore()
}

/**
 * One legacy annotation and one legacy comment on a named book.
 *
 * Written through the stores rather than through `addAnnotation` and the
 * feedback route, because these are *legacy* rows: they exist on books whose
 * present-day audience rules would refuse to create them, which is precisely
 * the situation the scope check has to survive.
 */
async function legacyRowsOn(bookSlug: string): Promise<{ comment: string; note: string }> {
  const comment = `LEGACY COMMENT ON ${bookSlug.toUpperCase()}`
  const highlight = `LEGACY HIGHLIGHT ON ${bookSlug.toUpperCase()}`

  await createFeedbackStore().add({
    reviewerId: 'anna',
    bookSlug,
    chapterSlug: CHAPTER,
    chapterNumber: 1,
    scope: 'chapter',
    paragraphId: null,
    paragraphOrdinal: null,
    quote: null,
    comment,
  })

  await createReadingStore().addAnnotation({
    ownerKind: 'reviewer',
    ownerId: 'anna',
    bookSlug,
    chapterSlug: CHAPTER,
    chapterNumber: 1,
    chapterLabel: 'Chapter one',
    paragraphId: `${CHAPTER}-p002`,
    paragraphOrdinal: 2,
    startOffset: 0,
    endOffset: 5,
    quote: 'Words',
    manuscriptSha256: 'c'.repeat(64),
    note: highlight,
    visibility: 'author',
  })

  return { comment, note: highlight }
}

/**
 * `loadAuthorFeedbackSource`, with the scope invariant checked on the way out.
 *
 * Every source this suite builds goes through here, so the rule is enforced
 * over all of them rather than over the two or three a scope test remembers to
 * look at: **a source's `books` describes its items exactly**. If an item can
 * appear whose book is not in `books`, then `books` is not the answer to "what
 * is this about", and every packet that names it is wrong about its own scope.
 *
 * It is a wrapper rather than an assertion inside the module because this is a
 * property of the result, and a test that can only be satisfied by the result
 * being right is worth more here than a guard the same refactor could delete.
 */
async function loadSource(
  viewer: Viewer,
  bookSlugs?: readonly string[],
): Promise<Awaited<ReturnType<typeof loadAuthorFeedbackSource>>> {
  const source = await loadAuthorFeedbackSource(viewer, bookSlugs)
  const named = new Set(source.books.map((book) => book.slug))

  for (const item of source.items) {
    assert.ok(
      named.has(item.bookSlug),
      `item ${item.itemId} belongs to ${item.bookSlug}, which this source does not name`,
    )
  }
  assert.equal(
    named.size,
    source.books.length,
    'the same book is named twice in one source',
  )

  return source
}

/* ------------------------------------------------------------ what gets in */

test('a reviewer session gets an empty, complete source and reaches no store', async () => {
  await inWorld(async () => {
    await note(ANNA, 'SHARED WITH MIKE')
    const source = await loadSource(ANNA)
    assert.deepEqual(source.items, [])
    assert.equal(source.incomplete, false)
    assert.deepEqual(source.books, [])
  })
})

test('the source carries shared notes, Mike own notes, and their provenance', async () => {
  await inWorld(async () => {
    await note(ANNA, 'SHARED WITH MIKE')
    await note(MIKE, 'MIKE OWN NOTE', { visibility: 'private' })

    const source = await loadSource(MIKE, [BOOK])
    assert.equal(source.incomplete, false, JSON.stringify(source.failures))

    const shared = source.items.find((item) => item.body === 'SHARED WITH MIKE')
    assert.ok(shared)
    assert.equal(shared.kind, 'note')
    assert.equal(shared.originator, 'reviewer')
    assert.equal(shared.reviewerId, 'anna')
    assert.equal(shared.reviewerName, 'Anna Reviewer', 'the roster names were not applied')
    assert.equal(shared.authorNoteStatus, null, 'a reviewer note carried an author status')
    assert.ok(shared.itemId.startsWith('note:'))

    const own = source.items.find((item) => item.body === 'MIKE OWN NOTE')
    assert.ok(own)
    assert.equal(own.originator, 'author')
    assert.equal(own.reviewerId, null, 'Mike own note named a reviewer')
    assert.equal(own.authorNoteStatus, 'open', 'his Package 1 status was dropped')
  })
})

test('a private reviewer note is in no part of the source, at any scope', async () => {
  await inWorld(async () => {
    await note(ANNA, 'ANNA PRIVATE CHAPTER', { visibility: 'private' })
    await note(ANNA, 'ANNA PRIVATE PARAGRAPH', {
      visibility: 'private',
      scope: 'paragraph',
      paragraphId: PARAGRAPH,
    })
    await note(ANNA, 'ANNA SHARED ONE', {})

    const source = await loadSource(MIKE, [BOOK])
    const serialized = JSON.stringify(source)

    for (const secret of ['ANNA PRIVATE CHAPTER', 'ANNA PRIVATE PARAGRAPH']) {
      assert.ok(!serialized.includes(secret), `"${secret}" reached the author source`)
    }
    assert.ok(serialized.includes('ANNA SHARED ONE'), 'the shared note was lost as well')
    // Not counted either: a count of two would say a private note exists.
    assert.equal(source.items.filter((item) => item.reviewerId === 'anna').length, 1)
  })
})

test('a private highlight never enters, and a shared one does', async () => {
  await inWorld(async () => {
    const privateHighlight = await addAnnotation(ANNA, {
      bookSlug: BOOK,
      chapterSlug: CHAPTER,
      paragraphId: PARAGRAPH,
      startOffset: 0,
      endOffset: 8,
    })
    assert.equal(privateHighlight.ok, true)

    const shareable = await addAnnotation(ANNA, {
      bookSlug: BOOK,
      chapterSlug: CHAPTER,
      paragraphId: PARAGRAPH,
      startOffset: 9,
      endOffset: 20,
    })
    assert.equal(shareable.ok, true)
    if (!shareable.ok || !privateHighlight.ok) return

    const shared = await updateAnnotation(ANNA, BOOK, shareable.value.id, { visibility: 'author' })
    assert.equal(shared.ok, true)

    const source = await loadSource(MIKE, [BOOK])
    const ids = source.items.map((item) => item.sourceId)
    assert.ok(ids.includes(shareable.value.id), 'a shared highlight did not reach the source')
    assert.ok(
      !ids.includes(privateHighlight.value.id),
      'a private highlight reached the author source',
    )
  })
})

test('a withdrawal is bodyless, names nobody, and replaces the note it stood for', async () => {
  await inWorld(async () => {
    const written = await note(ANNA, 'SHARED THEN WITHDRAWN')
    const removed = await deleteNote(ANNA, BOOK, written.id, written.revision)
    assert.equal(removed.ok, true)
    assert.equal(removed.ok && removed.value.withdrawal, 'recorded')

    const source = await loadSource(MIKE, [BOOK])
    const serialized = JSON.stringify(source)
    assert.ok(!serialized.includes('SHARED THEN WITHDRAWN'), 'the withdrawn body survived')

    const event = source.items.find((item) => item.kind === 'withdrawal')
    assert.ok(event, 'no withdrawal reached the source')
    assert.equal(event.body, null)
    assert.equal(event.captured, null)
    assert.equal(event.originator, null, 'a withdrawal named who wrote it')
    assert.equal(event.reviewerId, null)
    assert.equal(event.reviewerName, null)
    assert.equal(event.paragraphId, null)
    assert.ok(event.withdrawnAt)
    // And the note itself is not also there.
    assert.equal(source.items.filter((item) => item.sourceId === written.id).length, 1)
  })
})

test('deleting a private note leaves nothing in the source at all', async () => {
  await inWorld(async () => {
    const written = await note(ANNA, 'PRIVATE THEN GONE', { visibility: 'private' })
    const removed = await deleteNote(ANNA, BOOK, written.id, written.revision)
    assert.equal(removed.ok && removed.value.withdrawal, 'not-owed')

    const source = await loadSource(MIKE, [BOOK])
    assert.deepEqual(source.items.filter((item) => item.kind === 'withdrawal'), [])
    assert.ok(!JSON.stringify(source).includes(written.id))
  })
})

test('nothing in the source carries an address, a code, a token or a path', async () => {
  await inWorld(async () => {
    await note(ANNA, 'SOMETHING SHARED')
    await note(BEN, 'SOMETHING ELSE SHARED')
    const source = await loadSource(MIKE, [BOOK])
    const serialized = JSON.stringify(source)

    for (const forbidden of [
      '@',
      'codeHash',
      'accessCode',
      'token',
      'notes/v1',
      'reading/v1',
      'withdrawals/v1',
      'author-meta/v1',
      'BLOB_READ_WRITE_TOKEN',
      'a'.repeat(64),
    ]) {
      assert.ok(!serialized.includes(forbidden), `"${forbidden}" reached the author source`)
    }
  })
})

/* ------------------------------------------------- not-found versus failure */

test('a book the manifest does not hold is not-found, and not an incompleteness', async () => {
  await inWorld(async () => {
    const source = await loadSource(MIKE, [BOOK, 'a-book-nobody-loaded'])
    assert.deepEqual(source.notFound, ['a-book-nobody-loaded'])
    assert.equal(source.incomplete, false, 'an unloaded book was reported as a store failure')
    assert.deepEqual(source.failures, [])
    assert.deepEqual(
      source.books.map((book) => book.slug),
      [BOOK],
    )
  })
})

test('a store that will not answer makes the source incomplete, never empty', async () => {
  await inWorld(async (harness) => {
    await note(ANNA, 'STILL SHARED')

    // A file where one reviewer's annotations directory should be. The real
    // filesystem driver's `readdirSync` throws ENOTDIR -- a genuine read
    // failure from the real driver, scoped to one owner and one book.
    const { writeFileSync, mkdirSync: mkdir } = await import('node:fs')
    const prefix = join(
      harness.dir,
      'reading',
      'reading',
      'v1',
      'reviewer',
      'anna',
      BOOK,
    )
    mkdir(prefix, { recursive: true })
    writeFileSync(join(prefix, 'annotations'), 'not a directory', 'utf8')

    const source = await loadSource(MIKE, [BOOK])
    assert.equal(source.incomplete, true, 'a refused read was reported as no annotations')
    assert.ok(source.failures.some((failure) => failure.source === 'annotations'))
    // The failure list is safe to print: a name and a slug, and nothing else.
    for (const failure of source.failures) {
      assert.deepEqual(Object.keys(failure).sort(), ['bookSlug', 'source'])
    }
    // And what could be read is still there. Incomplete is not empty.
    assert.ok(bodies(source.items).includes('STILL SHARED'))
  })
})

/* ---------------------------------------------------------------- ordering */

test('the order is total, stable, and computed from the rows alone', async () => {
  await inWorld(async () => {
    await note(ANNA, 'BOOK SCOPE IS NOT OFFERED TO A REVIEWER', { scope: 'chapter' })
    await note(MIKE, 'WHOLE BOOK', { scope: 'book', visibility: 'private' })
    await note(ANNA, 'ON A PARAGRAPH', { scope: 'paragraph', paragraphId: PARAGRAPH })

    const first = await loadSource(MIKE, [BOOK])
    const second = await loadSource(MIKE, [BOOK])
    assert.deepEqual(
      first.items.map((item) => item.itemId),
      second.items.map((item) => item.itemId),
      'two reads of the same records answered in different orders',
    )

    // A book note sorts first, then a chapter note, then a paragraph note.
    assert.equal(first.items[0].body, 'WHOLE BOOK')
    assert.equal(first.items[first.items.length - 1].body, 'ON A PARAGRAPH')

    // The key is a pure function of the row.
    for (const item of first.items) {
      assert.equal(itemOrderKey(item), itemOrderKey({ ...item }))
    }
  })
})

/* ------------------------------------------ the requested books bound it */

/*
 * The roster names every book a reviewer was ever given; a request names the
 * books Mike is asking about. They are different lists, and the legacy
 * annotation and comment paths are reached through the first one -- so without
 * an explicit scope check they answer a question nobody asked.
 *
 * `persistent` is author-only today, so a reviewer roster entry naming it is a
 * stale or hand-edited row rather than something the grant flow produces. That
 * is what makes it the right fixture: the defect does not need a normal path to
 * reach it, and it becomes a normal path the day a second reviewer-visible book
 * exists.
 */
test('a restricted source carries nothing from a book that was not requested', async () => {
  await inWorld(async () => {
    withRoster(TWO_BOOK_ROSTER)
    await note(ANNA, 'SHARED ON THE REQUESTED BOOK')
    const legacy = await legacyRowsOn(OTHER_BOOK)

    const source = await loadSource(MIKE, [BOOK])
    assert.equal(source.incomplete, false, JSON.stringify(source.failures))
    assert.deepEqual(source.books.map((book) => book.slug), [BOOK])

    const serialized = JSON.stringify(source)
    for (const secret of [legacy.comment, legacy.note]) {
      assert.ok(!serialized.includes(secret), `"${secret}" reached a source that excluded its book`)
    }
    assert.ok(
      !source.items.some((item) => item.bookSlug === OTHER_BOOK),
      'an item from an unrequested book is in the source',
    )
    assert.ok(serialized.includes('SHARED ON THE REQUESTED BOOK'), 'the requested book was lost')
  })
})

test('the same legacy rows do arrive once the book is actually requested', async () => {
  await inWorld(async () => {
    withRoster(TWO_BOOK_ROSTER)
    const legacy = await legacyRowsOn(OTHER_BOOK)

    // The mirror of the test above, so that "excluded" is proved to mean
    // out-of-scope rather than simply unreadable, unwritten or lost.
    const source = await loadSource(MIKE, [BOOK, OTHER_BOOK])
    assert.equal(source.incomplete, false, JSON.stringify(source.failures))
    assert.deepEqual(source.books.map((book) => book.slug), [BOOK, OTHER_BOOK])

    const onOther = source.items.filter((item) => item.bookSlug === OTHER_BOOK)
    assert.deepEqual(
      onOther.map((item) => item.body).sort(),
      [legacy.comment, legacy.note].sort(),
      'the legacy comment and annotation did not arrive when their book was requested',
    )
  })
})

test('a book requested twice is one book, read once, with no duplicated item', async () => {
  await inWorld(async () => {
    withRoster(TWO_BOOK_ROSTER)
    await note(ANNA, 'SHARED ONCE')
    await note(MIKE, 'MIKE OWN NOTE', { visibility: 'private' })
    await legacyRowsOn(BOOK)

    const once = await loadSource(MIKE, [BOOK])
    const twice = await loadSource(MIKE, [BOOK, BOOK, BOOK])

    assert.deepEqual(twice.books.map((book) => book.slug), [BOOK], 'the book was listed twice')
    assert.deepEqual(
      twice.items.map((item) => item.itemId),
      once.items.map((item) => item.itemId),
      'asking twice changed what came back',
    )

    const ids = twice.items.map((item) => item.itemId)
    assert.equal(new Set(ids).size, ids.length, 'an item appears more than once')
  })
})

test('a not-found book among the requested ones does not disturb the rest', async () => {
  await inWorld(async () => {
    withRoster(TWO_BOOK_ROSTER)
    await note(ANNA, 'STILL HERE')

    const source = await loadSource(MIKE, [BOOK, 'no-such-book', BOOK])
    assert.deepEqual(source.books.map((book) => book.slug), [BOOK])
    assert.deepEqual(source.notFound, ['no-such-book'])
    assert.equal(source.incomplete, false, 'a missing book was reported as an unreadable store')
    assert.ok(source.items.some((item) => item.body === 'STILL HERE'))
  })
})
