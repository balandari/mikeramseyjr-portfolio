import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/*
 * A note store that could not be read must never render as "you have written
 * nothing", and the two guards the route layer hides must hold on their own.
 *
 * ## Why this file exists
 *
 * `lib/reading-workspace.ts` already states the standard, twenty lines below
 * the code that used to break it: *"A storage failure must not be rendered as
 * 'you have written nothing'. That was a real defect in this codebase once, and
 * the fix was to let the failure propagate rather than swallow it."* Notes were
 * getting none of that. Four surfaces reduced `listOwnNotes` to
 * `notes.ok ? notes.value : []`, so a store that failed and a reader who had
 * never written anything produced the identical page, and nothing tested it.
 *
 * ## How the failure is made real rather than mocked
 *
 * The filesystem driver lists a prefix with `readdirSync`. Putting a **file**
 * where one owner's notes directory should be makes exactly that call throw
 * `ENOTDIR` -- a genuine read failure, from the real driver, scoped to one
 * owner and one book, with every other read in the process still working. It
 * is also the right *kind* of failure: a live Blob read failure **throws**, it
 * does not answer `storage-unavailable`. Those are two different paths and both
 * are exercised below.
 */

import {
  NotesUnreadableError,
  listOwnNotes,
  readOwnNotes,
} from '../lib/note-service.ts'
import { __resetNoteStore, ownerNotesPrefix } from '../lib/notes-store.ts'
import { buildWorkspace } from '../lib/reading-workspace.ts'
import { addAnnotation, updateAnnotation } from '../lib/reading-service.ts'
import { __resetReadingStore } from '../lib/reviewer-reading.ts'
import { findBook, findReleasedChapter } from '../lib/manuscript.ts'
import type { Viewer } from '../lib/reading-access.ts'

const BOOK = 'the-backward-becoming'
const CHAPTER = 'chapter-one'
const ANNA: Viewer = { kind: 'reviewer', id: 'anna', books: [BOOK] }

type Harness = { dir: string; cleanup: () => void }

function readingRoot(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'mrj-note-failure-'))
  const saved = {
    driver: process.env.REVIEWER_FEEDBACK_DRIVER,
    readingDir: process.env.REVIEWER_READING_DIR,
    feedbackDir: process.env.REVIEWER_FEEDBACK_DIR,
  }
  const feedbackDir = join(dir, 'feedback')
  mkdirSync(feedbackDir, { recursive: true })
  process.env.REVIEWER_FEEDBACK_DRIVER = 'fs'
  process.env.REVIEWER_READING_DIR = join(dir, 'reading')
  process.env.REVIEWER_FEEDBACK_DIR = feedbackDir
  __resetNoteStore()
  __resetReadingStore()

  return {
    dir,
    cleanup() {
      __resetNoteStore()
      __resetReadingStore()
      for (const [name, value] of [
        ['REVIEWER_FEEDBACK_DRIVER', saved.driver],
        ['REVIEWER_READING_DIR', saved.readingDir],
        ['REVIEWER_FEEDBACK_DIR', saved.feedbackDir],
      ] as const) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * Break exactly one owner's notes on one book, and nothing else.
 *
 * A regular file where the owner's directory belongs. `existsSync` says the
 * prefix is there, `readdirSync` refuses it, and the store's `list` throws --
 * which is the shape of a real read failure and not a `storage-unavailable`
 * answer. Returns the path so a test can take it away again.
 */
function breakNotesFor(dir: string, viewer: Viewer, bookSlug: string): string {
  const prefix = ownerNotesPrefix({ kind: viewer.kind, id: viewer.id }, bookSlug)
  const full = join(dir, 'reading', prefix.replace(/\/$/, ''))
  rmSync(full, { recursive: true, force: true })
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, 'not a directory', 'utf8')
  return full
}

function paragraphId(): string {
  const book = findBook(BOOK)
  assert.ok(book, 'the manuscript under test is loaded')
  const chapter = findReleasedChapter(book, CHAPTER)
  assert.ok(chapter, 'and has a released first chapter')
  const paragraph = chapter.blocks.find((block) => block.kind === 'paragraph')
  assert.ok(paragraph, 'with a paragraph in it')
  return paragraph.id
}

/* ------------------------------------------- the failure the live store has */

test('a note read that throws is a failure, not an empty list', async () => {
  const harness = readingRoot()
  try {
    // With nothing written at all, an empty list is the truth and is returned.
    const healthy = await listOwnNotes(ANNA, BOOK)
    assert.equal(healthy.ok, true)
    assert.deepEqual(healthy.ok && healthy.value, [])
    assert.deepEqual(await readOwnNotes(ANNA, BOOK), [])

    breakNotesFor(harness.dir, ANNA, BOOK)

    /*
     * `listOwnNotes` lets it through, deliberately: a caller has to be able to
     * tell a store that answered from one that did not. This is the present
     * live mechanism -- a Blob read failure throws; it does not return
     * `storage-unavailable` and become `[]`.
     */
    await assert.rejects(() => listOwnNotes(ANNA, BOOK))

    // And `readOwnNotes`, which every surface uses, turns it into the one
    // error those surfaces are written against. Never `[]`, never `null`.
    await assert.rejects(
      () => readOwnNotes(ANNA, BOOK),
      (error: unknown) => {
        assert.ok(error instanceof NotesUnreadableError)
        assert.equal(error.bookSlug, BOOK)
        assert.equal(error.reason, 'failed')
        return true
      },
    )
  } finally {
    harness.cleanup()
  }
})

test('an unconfigured store answers an honest empty list, which is a different thing', async () => {
  const saved = {
    driver: process.env.REVIEWER_FEEDBACK_DRIVER,
    readingDir: process.env.REVIEWER_READING_DIR,
    feedbackDir: process.env.REVIEWER_FEEDBACK_DIR,
  }
  delete process.env.REVIEWER_FEEDBACK_DRIVER
  delete process.env.REVIEWER_READING_DIR
  delete process.env.REVIEWER_FEEDBACK_DIR
  __resetNoteStore()

  try {
    /*
     * Recorded so the two are never confused. The unconfigured driver's own
     * comment says it: *"Reading nothing is honest: there is no store, so there
     * is nothing in it."* Its `list` answers `[]` and its `get` answers null,
     * so an empty notes list here is the truth and not a swallowed failure --
     * nothing was ever written, because nothing here can write. `[]` in this
     * one case is therefore correct, and `readOwnNotes` returns it rather than
     * raising.
     *
     * The failure this correction is about is the other one: a store that was
     * asked and did not answer. That is proved in the test above, against the
     * real filesystem driver, and it never becomes `[]`.
     */
    const result = await listOwnNotes(ANNA, BOOK)
    assert.equal(result.ok, true)
    assert.deepEqual(result.ok && result.value, [])
    assert.deepEqual(await readOwnNotes(ANNA, BOOK), [])
  } finally {
    __resetNoteStore()
    for (const [name, value] of [
      ['REVIEWER_FEEDBACK_DRIVER', saved.driver],
      ['REVIEWER_READING_DIR', saved.readingDir],
      ['REVIEWER_FEEDBACK_DIR', saved.feedbackDir],
    ] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('a book that is not this viewer’s is an absence, and says so separately', async () => {
  const harness = readingRoot()
  try {
    const stranger: Viewer = { kind: 'reviewer', id: 'anna', books: [] }
    assert.equal(await readOwnNotes(stranger, BOOK), null)

    const unknown: Viewer = { kind: 'reviewer', id: 'anna', books: ['no-such-book'] }
    assert.equal(await readOwnNotes(unknown, 'no-such-book'), null)
  } finally {
    harness.cleanup()
  }
})

/* --------------------------------------------------------- the workspace */

test('the workspace tells an unknown book apart from a note-storage failure', async () => {
  const harness = readingRoot()
  try {
    /*
     * The legitimate skip, unchanged. A roster entry naming a book this
     * deployment has not loaded is passed over silently -- it is not theirs to
     * be told about -- and the books that *are* there still build.
     */
    const withStale = await buildWorkspace(ANNA, [BOOK, 'a-book-nobody-loaded'], {
      base: '/review',
      includeFeedback: true,
    })
    assert.deepEqual(
      withStale.map((entry) => entry.slug),
      [BOOK],
      'the unknown book is skipped, exactly as it was before',
    )
    assert.deepEqual(withStale[0].notes, [], 'and the book that is there reads honestly')

    // Now the same call with this reviewer's notes unreadable on that book.
    breakNotesFor(harness.dir, ANNA, BOOK)

    await assert.rejects(
      () =>
        buildWorkspace(ANNA, [BOOK, 'a-book-nobody-loaded'], {
          base: '/review',
          includeFeedback: true,
        }),
      (error: unknown) => {
        assert.ok(
          error instanceof NotesUnreadableError,
          'a storage failure is not an unloaded book and not an empty list',
        )
        assert.equal(error.bookSlug, BOOK)
        return true
      },
    )
  } finally {
    harness.cleanup()
  }
})

test('the workspace never returns a book whose notes it could not read', async () => {
  const harness = readingRoot()
  try {
    breakNotesFor(harness.dir, ANNA, BOOK)

    let built: Awaited<ReturnType<typeof buildWorkspace>> | null = null
    try {
      built = await buildWorkspace(ANNA, [BOOK], { base: '/review', includeFeedback: false })
    } catch (error) {
      assert.ok(error instanceof NotesUnreadableError)
    }

    assert.equal(
      built,
      null,
      'silently skipping the book would drop every bookmark and highlight in it too',
    )
  } finally {
    harness.cleanup()
  }
})

/* ------------------------------ the inner annotation guard, on its own */

/**
 * Every file beneath a directory, with its bytes. The byte-unchanged proof.
 */
function fingerprintTree(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (current: string, prefix: string) => {
    if (!existsSync(current)) return
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(current, entry.name)
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(full, rel)
      else out.set(rel, createHash('sha256').update(readFileSync(full)).digest('hex'))
    }
  }
  walk(dir, '')
  return out
}

test('updateAnnotation refuses a note field itself, with the route layer out of the way', async () => {
  const harness = readingRoot()
  try {
    /*
     * `lib/reading-api.ts:193` refuses `'note' in body` before this function is
     * ever called, so the route-level proof cannot say whether the inner guard
     * works -- deleting it leaves the whole suite passing. This calls the
     * service directly, which is what any future non-route caller would do, and
     * is the only thing that can tell the two guards apart.
     */
    const created = await addAnnotation(ANNA, {
      bookSlug: BOOK,
      chapterSlug: CHAPTER,
      paragraphId: paragraphId(),
      startOffset: 0,
      endOffset: 6,
    })
    assert.equal(created.ok, true)
    const id = created.ok ? created.value.id : ''
    assert.equal(created.ok && created.value.note, null, 'a new highlight carries no body')

    const root = join(harness.dir, 'reading')
    const before = fingerprintTree(root)
    assert.ok(before.size > 0, 'there is something on disk to protect')

    // Refused by presence, `null` included: erasing a stored body is a write.
    for (const note of [
      'A HAND-MADE BODY',
      '',
      null,
      undefined,
      0,
      { text: 'nested' },
      ['array'],
    ]) {
      const refused = await updateAnnotation(ANNA, BOOK, id, { note })
      assert.equal(refused.ok, false, JSON.stringify(note) ?? 'undefined')
      assert.equal(
        !refused.ok && refused.reason,
        'invalid',
        'and refused as a request this operation does not understand',
      )
    }

    // Refused even beside a change this operation does accept, so the guard
    // cannot be slipped past by burying the field in a legitimate request.
    const both = await updateAnnotation(ANNA, BOOK, id, {
      note: 'SMUGGLED',
      visibility: 'author',
    })
    assert.equal(both.ok, false)

    assert.deepEqual(
      Array.from(fingerprintTree(root).entries()).sort(),
      Array.from(before.entries()).sort(),
      'not one byte of the reading store was rewritten by any of it',
    )

    // And the sharing change it does accept still works, so the guard is a
    // refusal of one field rather than of the whole operation.
    const shared = await updateAnnotation(ANNA, BOOK, id, { visibility: 'author' })
    assert.equal(shared.ok, true)
    assert.equal(shared.ok && shared.value.visibility, 'author')
    assert.equal(shared.ok && shared.value.note, null, 'and still writes no body')
  } finally {
    harness.cleanup()
  }
})
