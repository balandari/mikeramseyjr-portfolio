import test from 'node:test'
import assert from 'node:assert/strict'

/*
 * The rows the author's surfaces render, and the filter they render them
 * through.
 *
 * Everything here is arithmetic over two values, which is the point: a list, a
 * count, a sort and a filter cannot mark anything read or resolved, because
 * there is nothing in `lib/author-inbox-filter.ts` or in the derivation half of
 * `lib/author-feedback-view.ts` that can write. The tests that prove the *whole
 * pipeline* does not write live in `tests/author-board.test.ts`, over real
 * stored bytes; these prove the shape of the answer.
 *
 * Four properties are worth stating before the assertions, because each one has
 * an obvious wrong version that would still pass a looser test:
 *
 *   **New and Resolved are not opposites.** A row can be both. The state filter
 *   therefore selects, and does not partition.
 *
 *   **An unreadable triage document is not an unread item.** Its rows carry
 *   nulls, not `false`, and they are counted out of a state slice rather than
 *   silently dropped from it.
 *
 *   **A chapter coordinate is a pair.** Two books may each have a
 *   `chapter-one`; a filter that stored bare chapter slugs would select the
 *   wrong book's chapter, and that is asserted directly rather than assumed.
 *
 *   **A row names no person.** There is no `reviewerId` field to forget.
 */

import {
  ALL_FEEDBACK,
  authorNoteCounts,
  chapterChoices,
  detailHref,
  filterRows,
  newFeedbackCount,
  sortNewestFirst,
  type InboxRow,
} from '../lib/author-inbox-filter.ts'
import { buildRows, inboxRow, occurredAt } from '../lib/author-feedback-view.ts'
import { emptyAuthorMetadata, type AuthorMetadata } from '../lib/author-metadata.ts'
import type { AuthorFeedbackItem } from '../lib/author-feedback-source.ts'

const BOOK = 'the-backward-becoming'
const OTHER = 'persistent'
const AT = '2026-09-16T12:00:00.000Z'

/** A source row, with only what a test cares about named. */
function item(over: Partial<AuthorFeedbackItem> = {}): AuthorFeedbackItem {
  return {
    itemId: 'note:one',
    kind: 'note',
    sourceId: 'one',
    originator: 'reviewer',
    reviewerId: 'anna',
    reviewerName: 'Anna Reviewer',
    bookSlug: BOOK,
    bookTitle: 'The Backward Becoming',
    scope: 'chapter',
    chapterSlug: 'chapter-one',
    chapterNumber: 1,
    chapterLabel: 'Chapter one',
    paragraphId: null,
    paragraphOrdinal: null,
    captured: null,
    body: 'What they said.',
    revision: 1,
    anchorState: 'ok',
    manuscriptChanged: false,
    createdAt: AT,
    updatedAt: AT,
    withdrawnAt: null,
    authorNoteStatus: null,
    ...over,
  }
}

/** A triage document carrying exactly the entries a test names. */
function metadata(
  bookSlug: string,
  entries: Record<string, { resolved?: boolean; lastReadAt?: string | null; lastExportedAt?: string | null }>,
): AuthorMetadata {
  const doc = emptyAuthorMetadata(bookSlug, AT)
  for (const [id, entry] of Object.entries(entries)) {
    doc.items[id] = {
      resolved: entry.resolved ?? false,
      lastReadAt: entry.lastReadAt ?? null,
      lastExportedAt: entry.lastExportedAt ?? null,
    }
  }
  return doc
}

/* ------------------------------------------------------------------ sorting */

test('rows are newest first, and ties break on the item id', () => {
  const rows = [
    inboxRow(item({ itemId: 'note:b', updatedAt: AT }), null),
    inboxRow(item({ itemId: 'note:a', updatedAt: AT }), null),
    inboxRow(item({ itemId: 'note:older', updatedAt: '2026-09-15T12:00:00.000Z' }), null),
    inboxRow(item({ itemId: 'note:newer', updatedAt: '2026-09-17T12:00:00.000Z' }), null),
  ]

  assert.deepEqual(
    sortNewestFirst(rows).map((row) => row.itemId),
    ['note:newer', 'note:a', 'note:b', 'note:older'],
  )

  // Total and stable: the same rows in any starting order give one sequence.
  const reversed = sortNewestFirst([...rows].reverse()).map((row) => row.itemId)
  assert.deepEqual(reversed, sortNewestFirst(rows).map((row) => row.itemId))
})

test('a row with no time at all sorts last rather than at the epoch', () => {
  const timeless = item({ itemId: 'note:timeless', createdAt: null, updatedAt: null })
  assert.equal(occurredAt(timeless), null)

  const rows = sortNewestFirst([
    inboxRow(timeless, null),
    inboxRow(item({ itemId: 'note:dated', updatedAt: '2000-01-01T00:00:00.000Z' }), null),
  ])
  assert.deepEqual(rows.map((row) => row.itemId), ['note:dated', 'note:timeless'])
})

test('a withdrawal sorts by when it was withdrawn', () => {
  const withdrawal = item({
    itemId: 'withdrawal:gone',
    kind: 'withdrawal',
    originator: null,
    reviewerId: null,
    reviewerName: null,
    body: null,
    captured: null,
    createdAt: null,
    updatedAt: null,
    withdrawnAt: '2026-09-18T12:00:00.000Z',
    anchorState: 'not-applicable',
  })
  assert.equal(occurredAt(withdrawal), '2026-09-18T12:00:00.000Z')
  assert.equal(inboxRow(withdrawal, null).occurredAt, '2026-09-18T12:00:00.000Z')
})

/* ------------------------------------------------------- the derived fields */

test('New is derived from the source time against lastReadAt, and Resolved is separate', () => {
  const doc = metadata(BOOK, {
    'note:one': { resolved: true, lastReadAt: '2026-09-16T11:00:00.000Z' },
  })

  // Resolved on Monday, edited on Tuesday: both resolved and new, which is the
  // truth and is exactly what a "not resolved means new" shortcut would lose.
  const row = inboxRow(item({ updatedAt: AT }), doc)
  assert.equal(row.isNew, true)
  assert.equal(row.resolved, true)
  assert.equal(row.changedSinceRead, true)

  const read = inboxRow(item({ updatedAt: '2026-09-16T10:00:00.000Z' }), doc)
  assert.equal(read.isNew, false)
  assert.equal(read.resolved, true)
  assert.equal(read.changedSinceRead, false)
})

test('changed-since-export is separate from changed-since-read', () => {
  const doc = metadata(BOOK, {
    'note:one': { lastReadAt: AT, lastExportedAt: '2026-09-16T09:00:00.000Z' },
  })
  const row = inboxRow(item({ updatedAt: '2026-09-16T11:00:00.000Z' }), doc)

  assert.equal(row.changedSinceRead, false, 'it has not changed since he read it')
  assert.equal(row.changedSinceExport, true, 'it has changed since it was exported')
  assert.equal(row.lastExportedAt, '2026-09-16T09:00:00.000Z')
})

test('an unreadable triage document gives nulls, never the all-new unresolved guess', () => {
  const row = inboxRow(item(), null)

  assert.equal(row.triageKnown, false)
  assert.equal(row.resolved, null, 'a storage failure was rendered as "not dealt with"')
  assert.equal(row.isNew, null, 'a storage failure was rendered as a state')
  assert.equal(row.lastReadAt, null)
  assert.equal(row.changedSinceRead, false)
  assert.equal(row.changedSinceExport, false)
})

test("one of Mike's own notes keeps its own status and borrows neither New nor Resolved", () => {
  const own = item({
    itemId: 'note:mine',
    originator: 'author',
    reviewerId: null,
    reviewerName: null,
    authorNoteStatus: 'open',
  })
  // Even with a triage entry sitting there, the row does not speak that
  // vocabulary: two competing statuses for one record is the thing to avoid.
  const row = inboxRow(own, metadata(BOOK, { 'note:mine': { resolved: true } }))

  assert.equal(row.triage, 'author')
  assert.equal(row.authorNoteStatus, 'open')
  assert.equal(row.resolved, null)
  assert.equal(row.isNew, null)
  assert.equal(row.attribution, 'You')
})

test('a row carries a display name and no identifier of a person', () => {
  const row = inboxRow(item({ reviewerId: 'anna', reviewerName: 'Anna Reviewer' }), null)

  assert.equal(row.attribution, 'Anna Reviewer')
  assert.ok(!('reviewerId' in row), 'a row has a reviewer id field to leak')
  assert.ok(
    !JSON.stringify(row).includes('"anna"'),
    'the serialized row carries the reviewer id',
  )
})

test('a detail href is built from the book and the item, both escaped', () => {
  assert.equal(detailHref(BOOK, 'note:one'), `/admin/feedback/${BOOK}/note%3Aone`)
  assert.equal(inboxRow(item(), null).detailHref, `/admin/feedback/${BOOK}/note%3Aone`)
})

/* ------------------------------------------------- per-book triage isolation */

test('two books holding one item id are read from their own documents', () => {
  /*
   * The cross-book defect the export's stamp coordinate exists to prevent, at
   * the rendering boundary. An item id names a source kind and a source id but
   * never a book, so a merged map would let one book's entry answer for the
   * other's.
   */
  const shared = 'note:shared-id'
  const items = [
    item({ itemId: shared, bookSlug: BOOK }),
    item({ itemId: shared, bookSlug: OTHER, bookTitle: 'PERSISTENT' }),
  ]
  const byBook = new Map([
    [BOOK, metadata(BOOK, { [shared]: { resolved: true, lastReadAt: '2026-09-17T00:00:00.000Z' } })],
    [OTHER, metadata(OTHER, { [shared]: { resolved: false } })],
  ])

  const rows = buildRows(items, byBook)
  const first = rows.find((row) => row.bookSlug === BOOK)
  const second = rows.find((row) => row.bookSlug === OTHER)

  assert.equal(first?.resolved, true)
  assert.equal(first?.isNew, false)
  assert.equal(second?.resolved, false, "one book's entry answered for another book")
  assert.equal(second?.isNew, true)
})

test('a book absent from the map is unreadable, not empty', () => {
  const rows = buildRows([item()], new Map())
  assert.equal(rows[0].triageKnown, false)

  const present = buildRows([item()], new Map([[BOOK, emptyAuthorMetadata(BOOK, AT)]]))
  assert.equal(present[0].triageKnown, true)
  assert.equal(present[0].resolved, false, 'an empty document is a book he has not touched')
  assert.equal(present[0].isNew, true)
})

/* ---------------------------------------------------------------- filtering */

test('the structural filters select by book, chapter, kind and scope', () => {
  const rows = [
    inboxRow(item({ itemId: 'note:a' }), null),
    inboxRow(
      item({ itemId: 'comment:b', kind: 'comment', scope: 'paragraph', paragraphOrdinal: 2 }),
      null,
    ),
    inboxRow(
      item({
        itemId: 'note:c',
        bookSlug: OTHER,
        bookTitle: 'PERSISTENT',
        chapterSlug: 'chapter-one',
      }),
      null,
    ),
    inboxRow(item({ itemId: 'note:d', scope: 'book', chapterSlug: null, chapterLabel: null }), null),
  ]

  const ids = (filter: Parameters<typeof filterRows>[1]) =>
    filterRows(rows, filter).rows.map((row) => row.itemId)

  assert.deepEqual(ids(ALL_FEEDBACK), ['note:a', 'comment:b', 'note:c', 'note:d'])
  assert.deepEqual(ids({ ...ALL_FEEDBACK, books: [OTHER] }), ['note:c'])
  assert.deepEqual(ids({ ...ALL_FEEDBACK, kinds: ['comment'] }), ['comment:b'])
  assert.deepEqual(ids({ ...ALL_FEEDBACK, scopes: ['book'] }), ['note:d'])
  assert.deepEqual(
    ids({ ...ALL_FEEDBACK, kinds: ['note', 'comment'] }),
    ['note:a', 'comment:b', 'note:c', 'note:d'],
  )
})

test('a chapter filter names a book and a chapter, so one book cannot answer for another', () => {
  const here = inboxRow(item({ itemId: 'note:here', bookSlug: BOOK }), null)
  const there = inboxRow(
    item({ itemId: 'note:there', bookSlug: OTHER, bookTitle: 'PERSISTENT' }),
    null,
  )
  assert.equal(here.chapterCoordinate, `${BOOK}/chapter-one`)
  assert.equal(there.chapterCoordinate, `${OTHER}/chapter-one`)

  // Both rows are in a chapter whose *slug* is `chapter-one`. A bare-slug filter
  // would return both; the coordinate returns exactly one.
  const picked = filterRows([here, there], {
    ...ALL_FEEDBACK,
    chapters: [`${OTHER}/chapter-one`],
  })
  assert.deepEqual(picked.rows.map((row) => row.itemId), ['note:there'])

  // A row with no chapter at all is not in any chapter filter.
  const whole = inboxRow(
    item({ itemId: 'note:book', scope: 'book', chapterSlug: null }),
    null,
  )
  assert.equal(whole.chapterCoordinate, null)
  assert.equal(
    filterRows([whole], { ...ALL_FEEDBACK, chapters: [`${BOOK}/chapter-one`] }).rows.length,
    0,
  )
})

test('new and resolved are overlapping selections, not two halves', () => {
  const doc = metadata(BOOK, {
    'note:both': { resolved: true, lastReadAt: '2026-09-16T11:00:00.000Z' },
    'note:neither': { resolved: false, lastReadAt: '2026-09-17T00:00:00.000Z' },
    'note:new-only': { resolved: false },
    'note:resolved-only': { resolved: true, lastReadAt: '2026-09-17T00:00:00.000Z' },
  })
  const rows = ['note:both', 'note:neither', 'note:new-only', 'note:resolved-only'].map((id) =>
    inboxRow(item({ itemId: id, updatedAt: AT }), doc),
  )

  const news = filterRows(rows, { ...ALL_FEEDBACK, state: 'new' }).rows.map((row) => row.itemId)
  const done = filterRows(rows, { ...ALL_FEEDBACK, state: 'resolved' }).rows.map((row) => row.itemId)

  assert.deepEqual(news, ['note:both', 'note:new-only'])
  assert.deepEqual(done, ['note:both', 'note:resolved-only'])
  /*
   * The two failures a partition would produce, named separately. A row that is
   * resolved *and* edited since he read it is in both slices; a row that is
   * neither is in neither. Deriving one from the other would put every row in
   * exactly one, and both of these assertions exist to catch that.
   */
  assert.ok(news.includes('note:both'), 'a resolved row was excluded from New')
  assert.ok(done.includes('note:both'), 'a new row was excluded from Resolved')
  assert.ok(!news.includes('note:neither'))
  assert.ok(!done.includes('note:neither'))
  assert.equal(
    new Set([...news, ...done]).size,
    3,
    'a row in neither slice was placed in one of them',
  )
})

test("Mike's own notes filter by their own open/resolved status", () => {
  const own = (id: string, status: 'open' | 'resolved') =>
    inboxRow(
      item({ itemId: id, originator: 'author', reviewerId: null, authorNoteStatus: status }),
      metadata(BOOK, { [id]: { resolved: status === 'open' } }),
    )
  const rows = [own('note:open', 'open'), own('note:done', 'resolved')]

  assert.deepEqual(
    filterRows(rows, { ...ALL_FEEDBACK, state: 'new' }).rows.map((row) => row.itemId),
    ['note:open'],
    'reviewer triage metadata decided the state of one of his own notes',
  )
  assert.deepEqual(
    filterRows(rows, { ...ALL_FEEDBACK, state: 'resolved' }).rows.map((row) => row.itemId),
    ['note:done'],
  )
})

test('a row whose triage is unknown is counted out of a state slice, not dropped from it', () => {
  const rows = [
    inboxRow(item({ itemId: 'note:known' }), metadata(BOOK, { 'note:known': { resolved: false } })),
    inboxRow(item({ itemId: 'note:unknown' }), null),
  ]

  const news = filterRows(rows, { ...ALL_FEEDBACK, state: 'new' })
  assert.deepEqual(news.rows.map((row) => row.itemId), ['note:known'])
  assert.equal(news.stateUnknown, 1, 'a row was dropped with nothing to say it had been')

  // `all` has nothing to decide, so nothing is withheld from it.
  const everything = filterRows(rows, ALL_FEEDBACK)
  assert.equal(everything.rows.length, 2)
  assert.equal(everything.stateUnknown, 0)
})

/* ----------------------------------------------------------------- counting */

test('the new count is reviewer-side only, and is null when any of it is unknown', () => {
  const known = inboxRow(item({ itemId: 'note:new' }), metadata(BOOK, {}))
  const read = inboxRow(
    item({ itemId: 'note:read' }),
    metadata(BOOK, { 'note:read': { lastReadAt: '2026-09-17T00:00:00.000Z' } }),
  )
  const mine = inboxRow(
    item({ itemId: 'note:mine', originator: 'author', reviewerId: null, authorNoteStatus: 'open' }),
    metadata(BOOK, {}),
  )

  assert.equal(newFeedbackCount([known, read, mine]), 1, 'his own note was counted as incoming')

  const unknown = inboxRow(item({ itemId: 'note:unknown' }), null)
  assert.equal(
    newFeedbackCount([known, read, unknown]),
    null,
    'a floor was reported as a total',
  )

  // One of his own notes with no readable triage does not make the incoming
  // count unknowable: it was never in that count.
  const mineUnknown = inboxRow(
    item({ itemId: 'note:mine2', originator: 'author', reviewerId: null, authorNoteStatus: 'open' }),
    null,
  )
  assert.equal(newFeedbackCount([known, mineUnknown]), 1)
})

test("Mike's own notes are counted by their own status", () => {
  const own = (id: string, status: 'open' | 'resolved' | null) =>
    inboxRow(
      item({ itemId: id, originator: 'author', reviewerId: null, authorNoteStatus: status }),
      null,
    )
  const counts = authorNoteCounts([
    own('note:a', 'open'),
    own('note:b', 'resolved'),
    own('note:c', null),
    inboxRow(item({ itemId: 'note:theirs' }), null),
  ])
  assert.deepEqual(counts, { open: 2, resolved: 1 })
})

test('the chapter choices are the chapters the rows actually cover, in reading order', () => {
  const rows = [
    inboxRow(item({ itemId: 'note:2', chapterSlug: 'chapter-two', chapterNumber: 2, chapterLabel: 'Chapter two' }), null),
    inboxRow(item({ itemId: 'note:1' }), null),
    inboxRow(item({ itemId: 'note:1b' }), null),
    inboxRow(
      item({
        itemId: 'note:p',
        bookSlug: OTHER,
        bookTitle: 'PERSISTENT',
        chapterSlug: 'one',
        chapterNumber: 1,
        chapterLabel: 'One',
      }),
      null,
    ),
    inboxRow(item({ itemId: 'note:book', scope: 'book', chapterSlug: null }), null),
  ]

  assert.deepEqual(
    chapterChoices(rows).map((choice) => choice.coordinate),
    [`${OTHER}/one`, `${BOOK}/chapter-one`, `${BOOK}/chapter-two`],
  )
})
