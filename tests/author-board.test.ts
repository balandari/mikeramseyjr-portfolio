import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

/*
 * The one read the author's surfaces share, over real stored bytes.
 *
 * Three questions, and the third is the one this file exists for:
 *
 *   **Does a read stay a read?** Every surface in Package 2-B loads through
 *   `loadAuthorBoard`. If that function -- or anything it calls -- wrote, then
 *   the dashboard, the inbox, every count and every filter would be marking
 *   things read merely by being looked at, which is the single failure this
 *   package was specified to make impossible. It is checked by comparing the
 *   bytes of the whole store before and after, not by inspecting a return value.
 *
 *   **Is a failed read told apart from an empty one?** Three different failures
 *   -- an unreadable feedback source, an unreadable per-book triage document,
 *   and an unreadable saved-view document -- have three different answers, and
 *   none of them is `[]`, `0` or `false`.
 *
 *   **Where does a saved view live?** In exactly one document, named by a
 *   constant. Proved by counting the files on disk that hold it, not by reading
 *   the function that wrote it.
 */

import { dashboardSummary, loadAuthorBoard } from '../lib/author-dashboard.ts'
import {
  SAVED_VIEW_HOME_SLUG,
  MAX_VIEW_CHAPTERS,
  VIEW_CHAPTER_PATTERN,
  asSavedView,
  authorMetadataPath,
  authorMetadataPrefix,
  chapterCoordinate,
  markItemOpened,
  putSavedView,
  setItemResolved,
  __resetAuthorMetadataStore,
} from '../lib/author-metadata.ts'
import { createNote } from '../lib/note-service.ts'
import { listBookSlugs } from '../lib/manuscript.ts'
import { __resetNoteStore } from '../lib/notes-store.ts'
import { __resetReadingStore } from '../lib/reviewer-reading.ts'
import { __resetWithdrawalStore } from '../lib/withdrawal-events.ts'
import { __resetRosterStore } from '../lib/reviewer-roster.ts'
import { __resetFeedbackStore } from '../lib/reviewer-feedback.ts'
import type { Viewer } from '../lib/reading-access.ts'

const BOOK = 'the-backward-becoming'
const OTHER_BOOK = 'persistent'
const CHAPTER = 'chapter-one'

const MIKE: Viewer = { kind: 'author', id: 'aa11bb22cc33dd44ee55ff66' }
const ANNA: Viewer = { kind: 'reviewer', id: 'anna', books: [BOOK] }

const ROSTER = JSON.stringify([
  { id: 'anna', name: 'Anna Reviewer', books: [BOOK], codeHash: 'a'.repeat(64) },
])

/* ------------------------------------------------------------- the harness */

const KEYS = [
  'REVIEWER_FEEDBACK_DRIVER',
  'REVIEWER_FEEDBACK_DIR',
  'REVIEWER_READING_DIR',
  'REVIEWER_ROSTER_DRIVER',
  'REVIEWER_ROSTER',
] as const

type World = { dir: string; reading: string; cleanup: () => void }

function resetStores(): void {
  __resetNoteStore()
  __resetReadingStore()
  __resetWithdrawalStore()
  __resetAuthorMetadataStore()
  __resetRosterStore()
  __resetFeedbackStore()
}

function world(): World {
  const dir = mkdtempSync(join(tmpdir(), 'mrj-author-board-'))
  const saved = new Map(KEYS.map((key) => [key, process.env[key]]))
  const feedbackDir = join(dir, 'feedback')
  const reading = join(dir, 'reading')
  mkdirSync(feedbackDir, { recursive: true })

  process.env.REVIEWER_FEEDBACK_DRIVER = 'fs'
  process.env.REVIEWER_FEEDBACK_DIR = feedbackDir
  process.env.REVIEWER_READING_DIR = reading
  process.env.REVIEWER_ROSTER_DRIVER = 'env'
  process.env.REVIEWER_ROSTER = ROSTER
  resetStores()

  return {
    dir,
    reading,
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

async function inWorld(body: (world: World) => Promise<void>): Promise<void> {
  const harness = world()
  try {
    await body(harness)
  } finally {
    harness.cleanup()
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

async function shared(viewer: Viewer, body: string, over: Record<string, unknown> = {}) {
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
  return created.value
}

/** Put arbitrary bytes where a metadata document lives. */
function corrupt(reading: string, bookSlug: string, bytes: string): void {
  const path = join(reading, authorMetadataPath(MIKE.id, bookSlug))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes, 'utf8')
}

/* ------------------------------------------------- reading stays a read */

test('loading the board and summarising it writes no bytes at all', async () => {
  await inWorld(async (harness) => {
    const note = await shared(ANNA, 'Something Anna shared.')
    // A pre-existing triage document, so there are real bytes to change.
    assert.equal((await setItemResolved(MIKE, BOOK, `note:${note.id}`, true)).ok, true)

    const before = fingerprint(harness.dir)
    assert.ok(before.size > 0, 'the world wrote nothing to compare against')

    const board = await loadAuthorBoard(MIKE)
    const summary = dashboardSummary(board)
    // Everything a surface does with the board, done here, on purpose.
    void board.rows.map((row) => row.itemId).join()
    void summary.newCount
    void summary.myNotes.open
    await loadAuthorBoard(MIKE, [BOOK])

    assert.deepEqual(
      fingerprint(harness.dir),
      before,
      'reading the board changed stored bytes',
    )
    assert.ok(board.rows.length > 0, 'the board read nothing, so it proved nothing')
  })
})

test('opening one item marks exactly that item, and nothing else moves', async () => {
  await inWorld(async (harness) => {
    const one = await shared(ANNA, 'The first.')
    const two = await shared(ANNA, 'The second.')

    const before = await loadAuthorBoard(MIKE)
    assert.equal(before.rows.every((row) => row.lastReadAt === null), true)

    const at = new Date(Date.parse(one.updatedAt) + 1).toISOString()
    assert.equal((await markItemOpened(MIKE, BOOK, `note:${one.id}`, at)).ok, true)

    const after = await loadAuthorBoard(MIKE)
    const opened = after.rows.find((row) => row.itemId === `note:${one.id}`)
    const untouched = after.rows.find((row) => row.itemId === `note:${two.id}`)

    assert.equal(opened?.lastReadAt, at)
    assert.equal(opened?.isNew, false)
    assert.equal(untouched?.lastReadAt, null, 'opening one item marked another')
    assert.equal(untouched?.isNew, true)
    assert.equal(opened?.resolved, false, 'opening an item resolved it')
    assert.equal(opened?.lastExportedAt, null, 'opening an item stamped it as exported')
    void harness
  })
})

/* -------------------------------------------- a failed read is not an empty one */

test('a book whose triage will not read gives rows with no state, not new unresolved rows', async () => {
  await inWorld(async (harness) => {
    const note = await shared(ANNA, 'Something Anna shared.')
    corrupt(harness.reading, BOOK, '{"schema":1,"bookSlug":"' + BOOK + '","items":{"not an id":3}}')

    const board = await loadAuthorBoard(MIKE)
    const row = board.rows.find((entry) => entry.itemId === `note:${note.id}`)

    assert.deepEqual(board.unreadableBooks, [BOOK])
    assert.ok(
      board.failures.some((entry) => entry.source === 'author-metadata' && entry.bookSlug === BOOK),
    )
    assert.ok(row, 'the row was hidden rather than shown without a state')
    assert.equal(row?.triageKnown, false)
    assert.equal(row?.resolved, null)
    assert.equal(row?.isNew, null)

    const summary = dashboardSummary(board)
    assert.equal(summary.newCount, null, 'an unreadable record was counted as a number')
    assert.equal(summary.degraded, true)
  })
})

test('saved views that will not read are null, never an empty list', async () => {
  await inWorld(async (harness) => {
    await shared(ANNA, 'Something Anna shared.')
    corrupt(harness.reading, SAVED_VIEW_HOME_SLUG, 'not a document at all')

    const board = await loadAuthorBoard(MIKE)
    assert.equal(board.savedViews, null, 'an unreadable view list read as "you have saved none"')
    assert.ok(board.failures.some((entry) => entry.source === 'saved-views'))
    assert.equal(dashboardSummary(board).degraded, true)

    // And the readable case is genuinely `[]`, so `null` means one thing only.
    corrupt(
      harness.reading,
      SAVED_VIEW_HOME_SLUG,
      JSON.stringify({
        schema: 1,
        bookSlug: SAVED_VIEW_HOME_SLUG,
        items: {},
        views: [],
        updatedAt: '2026-09-18T00:00:00.000Z',
      }),
    )
    const readable = await loadAuthorBoard(MIKE)
    assert.deepEqual(readable.savedViews, [])
  })
})

test('an empty board and a degraded one are different answers', async () => {
  await inWorld(async () => {
    const empty = await loadAuthorBoard(MIKE)
    assert.equal(empty.rows.length, 0)
    assert.equal(empty.incomplete, false)
    assert.equal(dashboardSummary(empty).degraded, false, 'an empty world read as degraded')
    assert.equal(dashboardSummary(empty).newCount, 0)
  })
})

/* --------------------------------------------- the saved-view ownership rule */

test('the reserved saved-view slug is not, and cannot be, a loaded book', () => {
  for (const slug of listBookSlugs()) {
    assert.notEqual(
      slug,
      SAVED_VIEW_HOME_SLUG,
      `"${slug}" is also the saved-view document's slug, so one would overwrite the other`,
    )
  }
})

test('a saved view naming many books has exactly one durable copy', async () => {
  await inWorld(async (harness) => {
    await shared(ANNA, 'Something Anna shared.')

    const view = {
      id: 'unresolved-passages',
      name: 'Unresolved passages',
      books: [BOOK, OTHER_BOOK],
      chapters: [chapterCoordinate(BOOK, CHAPTER), chapterCoordinate(OTHER_BOOK, 'one')],
      kinds: ['note'],
      scopes: ['chapter'],
      state: 'new',
    }
    assert.equal((await putSavedView(MIKE, SAVED_VIEW_HOME_SLUG, view)).ok, true)

    // Count the files on disk that hold it, rather than trusting the writer.
    const prefix = join(harness.reading, authorMetadataPrefix(MIKE.id))
    const holders: string[] = []
    for (const entry of readdirSync(prefix, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const bytes = readFileSync(join(prefix, entry.name), 'utf8')
      if (bytes.includes('unresolved-passages')) holders.push(entry.name)
    }

    assert.deepEqual(
      holders,
      [`${SAVED_VIEW_HOME_SLUG}.json`],
      'the view was copied into a per-book document, or into more than one file',
    )

    const board = await loadAuthorBoard(MIKE)
    assert.equal(board.savedViews?.length, 1)
    assert.deepEqual(board.savedViews?.[0].books, [BOOK, OTHER_BOOK])
    assert.deepEqual(board.savedViews?.[0].chapters, [
      chapterCoordinate(BOOK, CHAPTER),
      chapterCoordinate(OTHER_BOOK, 'one'),
    ])
  })
})

test('a view in a per-book document is not a saved view of this surface', async () => {
  await inWorld(async (harness) => {
    await shared(ANNA, 'Something Anna shared.')
    /*
     * The schema still permits a `views` array in a book's own document -- it
     * is the same document shape -- so the ownership rule has to be enforced by
     * where the surface *reads* from, not only by where it writes. A stray view
     * under a book is ignored rather than merged in.
     */
    /*
     * Into **every** loaded book, not just one. The ownership rule is that no
     * book document is ever a source of views; seeding one book would be
     * satisfied by a reader that happened to be looking at a different one.
     */
    for (const slug of listBookSlugs()) {
      corrupt(
        harness.reading,
        slug,
        JSON.stringify({
          schema: 1,
          bookSlug: slug,
          items: {},
          views: [
            {
              id: `stray-${slug}`,
              name: `A stray view in ${slug}`,
              books: [slug],
              chapters: [],
              kinds: [],
              scopes: [],
              state: 'all',
            },
          ],
          updatedAt: '2026-09-18T00:00:00.000Z',
        }),
      )
    }

    const board = await loadAuthorBoard(MIKE)
    assert.equal(board.unreadableBooks.length, 0, 'a per-book document did not read')
    assert.deepEqual(board.savedViews, [], 'a per-book view was surfaced as a saved view')
  })
})

/* ------------------------------------------------- the chapter filter's shape */

test('a chapter coordinate is bounded, deduplicated and unambiguous across books', () => {
  const base = {
    id: 'by-chapter',
    name: 'By chapter',
    books: [],
    kinds: [],
    scopes: [],
    state: 'all',
  }
  const coordinate = chapterCoordinate(BOOK, CHAPTER)

  assert.ok(VIEW_CHAPTER_PATTERN.test(coordinate))
  assert.deepEqual(asSavedView({ ...base, chapters: [coordinate, coordinate] })?.chapters, [
    coordinate,
  ])

  // The older shape, which named no chapters at all, still reads.
  assert.deepEqual(asSavedView(base)?.chapters, [])

  // Anything that is not a pair of slugs refuses the whole view, exactly as a
  // bad book slug does -- a bare chapter slug most of all, because that is the
  // ambiguous form this coordinate exists to replace.
  for (const bad of [CHAPTER, `${BOOK}/`, `/${CHAPTER}`, `${BOOK}/${CHAPTER}/extra`, 'UPPER/case', 3]) {
    assert.equal(
      asSavedView({ ...base, chapters: [bad] }),
      null,
      `"${String(bad)}" was accepted as a chapter coordinate`,
    )
  }
  assert.equal(asSavedView({ ...base, chapters: 'not-an-array' }), null)

  const many = (count: number) =>
    Array.from({ length: count }, (_, i) => chapterCoordinate(BOOK, `chapter-${i}`))
  assert.equal(asSavedView({ ...base, chapters: many(MAX_VIEW_CHAPTERS) })?.chapters.length, MAX_VIEW_CHAPTERS)
  assert.equal(
    asSavedView({ ...base, chapters: many(MAX_VIEW_CHAPTERS + 1) }),
    null,
    'one chapter past the cap was accepted',
  )
})

test('a saved view holds no words from anybody, however it is asked to', async () => {
  await inWorld(async (harness) => {
    const QUOTE = 'WORDS-FROM-A-NOTE-THAT-MUST-NOT-PERSIST'
    const outcome = await putSavedView(MIKE, SAVED_VIEW_HOME_SLUG, {
      id: 'sneaky',
      name: 'A view',
      books: [BOOK],
      chapters: [chapterCoordinate(BOOK, CHAPTER)],
      kinds: ['note'],
      scopes: ['chapter'],
      state: 'all',
      // Every shape a body could arrive in, all at once.
      body: QUOTE,
      quotation: QUOTE,
      search: QUOTE,
      items: { 'note:one': QUOTE },
      reviewerEmail: 'anna@example.test',
      reviewerId: 'anna',
      path: 'reading/v1/reviewer/anna/notes',
    })
    assert.equal(outcome.ok, true)

    const stored = readFileSync(
      join(harness.reading, authorMetadataPath(MIKE.id, SAVED_VIEW_HOME_SLUG)),
      'utf8',
    )
    for (const sentinel of [QUOTE, 'anna@example.test', '"anna"', 'reading/v1/reviewer']) {
      assert.ok(
        !stored.includes(sentinel),
        `the stored saved-view document carries ${sentinel}`,
      )
    }
    assert.deepEqual(Object.keys(JSON.parse(stored).views[0]).sort(), [
      'books',
      'chapters',
      'id',
      'kinds',
      'name',
      'scopes',
      'state',
    ])
  })
})
