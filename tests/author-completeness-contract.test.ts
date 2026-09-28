import test from 'node:test'
import assert from 'node:assert/strict'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/*
 * One contract, in four findings: **a shortened answer is never a complete one.**
 *
 * The Judge's Phase 2 verdict found the same defect wearing four different
 * costumes, and this file proves each one against the exact state it used to
 * produce. The shape is always identical: something the store could not read,
 * or an entitlement somebody edited, was converted into a confident,
 * successful-looking, *shorter* answer -- and the export stamped it `ok: true`.
 *
 *   **F2** Removing a reviewer's current access to a book stopped the author
 *          from ever discovering the annotations and immutable comments that
 *          are still stored under that reviewer and that book. The rows were
 *          never deleted; the loop simply stopped asking. `incomplete` stayed
 *          false, so nothing said anything was missing.
 *
 *   **F3** A row that was enumerated and then would not read -- malformed
 *          bytes, an object that vanished between the listing and the read, a
 *          row filed in the wrong place -- was skipped in silence at every
 *          listing boundary. The author source could only see a failure that
 *          *threw*, so a shortened list and a short history were the same
 *          value.
 *
 *   **F4** A `REVIEWER_ROSTER` that is present and damaged became
 *          `emptyRoster()`, which is the value a deployment with no reviewers
 *          gets. A damaged access list therefore read as "nobody has been given
 *          access", the legacy history behind it was never discovered, and the
 *          export stamped the packet complete.
 *
 *   **F8** A reviewer entitled to the same book twice produced the same stored
 *          row twice: two items, two contributions to the count, two entries in
 *          the packet, and one row identity claimed by both.
 *
 * Every case below asserts the **whole** consequence, not just the flag: what
 * the source says, what the dashboard board says, and what the export does --
 * including that a refused export leaves no `lastExportedAt` stamp behind. A
 * refusal that still stamped would be the same lie one layer down.
 */

import { loadAuthorFeedbackSource } from '../lib/author-feedback-source.ts'
import { loadAuthorBoard } from '../lib/author-dashboard.ts'
import { exportAuthorFeedback } from '../lib/author-export.ts'
import { loadAuthorMetadata, __resetAuthorMetadataStore } from '../lib/author-metadata.ts'
import { __resetNoteStore } from '../lib/notes-store.ts'
import { __resetReadingStore, createReadingStore } from '../lib/reviewer-reading.ts'
import { __resetWithdrawalStore } from '../lib/withdrawal-events.ts'
import {
  __resetRosterStore,
  RosterUnreadableError,
  createRosterStore,
  parseRosterDocument,
} from '../lib/reviewer-roster.ts'
import { __resetFeedbackStore, createFeedbackStore } from '../lib/reviewer-feedback.ts'
import type { Viewer } from '../lib/reading-access.ts'

const BOOK = 'the-backward-becoming'
const CHAPTER = 'chapter-one'

const MIKE: Viewer = { kind: 'author', id: 'aa11bb22cc33dd44ee55ff66' }

/** Anna, entitled to the book. The state history was written under. */
const ROSTER_WITH_BOOK = JSON.stringify([
  { id: 'anna', name: 'Anna Reviewer', books: [BOOK], codeHash: 'a'.repeat(64) },
])

/** Anna, still a reviewer, with that entitlement taken away. F2's whole input. */
const ROSTER_WITHOUT_BOOK = JSON.stringify([
  { id: 'anna', name: 'Anna Reviewer', books: [], codeHash: 'a'.repeat(64) },
])

/** Anna, entitled to the same book twice. F8's whole input. */
const ROSTER_WITH_DUPLICATE = JSON.stringify([
  { id: 'anna', name: 'Anna Reviewer', books: [BOOK, BOOK], codeHash: 'a'.repeat(64) },
])

const KEYS = [
  'REVIEWER_FEEDBACK_DRIVER',
  'REVIEWER_FEEDBACK_DIR',
  'REVIEWER_READING_DIR',
  'REVIEWER_ROSTER_DRIVER',
  'REVIEWER_ROSTER',
] as const

type World = { dir: string; feedbackDir: string; cleanup: () => void }

function resetStores(): void {
  __resetNoteStore()
  __resetReadingStore()
  __resetWithdrawalStore()
  __resetAuthorMetadataStore()
  __resetRosterStore()
  __resetFeedbackStore()
}

function world(): World {
  const dir = mkdtempSync(join(tmpdir(), 'mrj-completeness-'))
  const saved = new Map(KEYS.map((key) => [key, process.env[key]]))
  const feedbackDir = join(dir, 'feedback')
  mkdirSync(feedbackDir, { recursive: true })

  process.env.REVIEWER_FEEDBACK_DRIVER = 'fs'
  process.env.REVIEWER_FEEDBACK_DIR = feedbackDir
  process.env.REVIEWER_READING_DIR = join(dir, 'reading')
  process.env.REVIEWER_ROSTER_DRIVER = 'env'
  process.env.REVIEWER_ROSTER = ROSTER_WITH_BOOK
  resetStores()

  return {
    dir,
    feedbackDir,
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

/** Point the roster at a different document, as an administrator would. */
function setRoster(value: string): void {
  process.env.REVIEWER_ROSTER = value
  __resetRosterStore()
}

const COMMENT = 'AN IMMUTABLE COMMENT ANNA SUBMITTED'
const HIGHLIGHT = 'A LEGACY ANNOTATION ANNA SHARED'

/**
 * One immutable comment and one author-visible legacy annotation, stored
 * directly, exactly as they would have been stored when Anna had the book.
 */
async function writeLegacyHistory(): Promise<void> {
  await createFeedbackStore().add({
    reviewerId: 'anna',
    bookSlug: BOOK,
    chapterSlug: CHAPTER,
    chapterNumber: 1,
    scope: 'chapter',
    paragraphId: null,
    paragraphOrdinal: null,
    quote: null,
    comment: COMMENT,
  })

  await createReadingStore().addAnnotation({
    ownerKind: 'reviewer',
    ownerId: 'anna',
    bookSlug: BOOK,
    chapterSlug: CHAPTER,
    chapterNumber: 1,
    chapterLabel: 'Chapter one',
    paragraphId: `${CHAPTER}-p002`,
    paragraphOrdinal: 2,
    startOffset: 0,
    endOffset: 5,
    quote: 'Words',
    manuscriptSha256: 'c'.repeat(64),
    note: HIGHLIGHT,
    visibility: 'author',
  })
}

/** The one file under `root` whose text contains `needle`. */
function findFileContaining(root: string, needle: string): string {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (readFileSync(path, 'utf8').includes(needle)) found.push(path)
    }
  }
  walk(root)
  assert.equal(found.length, 1, `expected exactly one file holding ${needle}`)
  return found[0]
}

/** Every item body in a source, for a plain membership assertion. */
async function bodiesFor(books: readonly string[] = [BOOK]): Promise<(string | null)[]> {
  const source = await loadAuthorFeedbackSource(MIKE, books)
  return source.items.map((item) => item.body)
}

/** The `lastExportedAt` stamp on every item this book's metadata knows about. */
async function stamps(): Promise<Record<string, string | null>> {
  const loaded = await loadAuthorMetadata(MIKE, BOOK)
  assert.equal(loaded.ok, true, 'the metadata document could not be read')
  if (!loaded.ok) throw new Error('unreachable')
  const out: Record<string, string | null> = {}
  for (const [itemId, item] of Object.entries(loaded.value.metadata.items)) {
    out[itemId] = item.lastExportedAt
  }
  return out
}

/* ====================================================================== F2 */

test('F2: retained legacy history survives the entitlement being taken away', async () => {
  await inWorld(async () => {
    await writeLegacyHistory()

    // The state the history was written in: both rows reach Mike.
    const before = await bodiesFor()
    assert.deepEqual(
      [...before].sort(),
      [COMMENT, HIGHLIGHT].sort(),
      'the fixture itself is wrong: Mike cannot see the history to begin with',
    )

    /*
     * The only thing that changes. Nothing is deleted, nothing is moved, and
     * Anna is still on the roster -- `lib/reviewer-admin.ts` replaces the
     * `books` array, and this is that array replaced.
     */
    setRoster(ROSTER_WITHOUT_BOOK)

    const after = await loadAuthorFeedbackSource(MIKE, [BOOK])
    assert.deepEqual(
      after.items.map((item) => item.body).sort(),
      [COMMENT, HIGHLIGHT].sort(),
      'taking the book back hid history that is still stored',
    )
    assert.equal(
      after.incomplete,
      false,
      'and it is genuinely complete -- this is not a gap being disclosed, it is no gap',
    )

    // Provenance is intact: the rows are still attributed to Anna, and still
    // scoped to the one book that was asked about.
    for (const item of after.items) {
      assert.equal(item.reviewerId, 'anna')
      assert.equal(item.bookSlug, BOOK)
    }
  })
})

test('F2: a reviewer with no entitlement to a book never yields another reviewer’s rows', async () => {
  await inWorld(async () => {
    await writeLegacyHistory()

    // Ben is on the roster and has never had this book, and has written
    // nothing. Discovery is now driven by the requested books rather than by
    // entitlements, so this is the case that proves the widened loop did not
    // widen what it can *see*.
    setRoster(
      JSON.stringify([
        { id: 'anna', name: 'Anna Reviewer', books: [], codeHash: 'a'.repeat(64) },
        { id: 'ben', name: 'Ben Reviewer', books: [], codeHash: 'b'.repeat(64) },
      ]),
    )

    const source = await loadAuthorFeedbackSource(MIKE, [BOOK])
    assert.equal(source.incomplete, false)
    assert.deepEqual(
      source.items.map((item) => item.reviewerId),
      ['anna', 'anna'],
      'a reviewer with an empty prefix contributed rows from somewhere',
    )
  })
})

/* ====================================================================== F3 */

test('F3: a malformed stored comment is disclosed, and refuses the export', async () => {
  await inWorld(async (harness) => {
    await writeLegacyHistory()

    // One malformed line beside the valid one, in the append-only file that
    // holds this book's comments. Nothing rewrites this file, so a line that
    // will not parse is damage.
    appendFileSync(join(harness.feedbackDir, `${BOOK}.ndjson`), '{ not json at all\n', 'utf8')
    __resetFeedbackStore()

    const source = await loadAuthorFeedbackSource(MIKE, [BOOK])

    // The readable rows still read. That half never regressed and is asserted
    // so that a future "fix" cannot satisfy this test by refusing everything.
    assert.deepEqual(
      source.items.map((item) => item.body).sort(),
      [COMMENT, HIGHLIGHT].sort(),
    )

    assert.equal(source.incomplete, true, 'the discarded row was not disclosed')
    assert.deepEqual(
      source.failures.map((failure) => failure.source),
      ['comments'],
      'the failure names the source that was short',
    )

    // The failure list is safe to render: a source name and a book slug, and
    // nothing out of the row itself.
    const serialized = JSON.stringify(source.failures)
    assert.ok(!serialized.includes('not json'), 'the damaged bytes leaked into the failure')
    assert.ok(!serialized.includes(COMMENT), 'a row body leaked into the failure')

    // The dashboard carries it, which is what puts the banner on the page and
    // disables the export button. `tests/author-inbox-render.test.tsx` owns the
    // other half: given this flag, the inbox shows an alert, does not print an
    // empty-inbox state over it, and disables "Make the file".
    const board = await loadAuthorBoard(MIKE, [BOOK])
    assert.equal(board.incomplete, true)
    const boardFailures = JSON.stringify(board.failures)
    assert.ok(!boardFailures.includes(COMMENT), 'a row body reached the board failure list')
    assert.ok(!boardFailures.includes('not json'), 'damaged bytes reached the board failure list')

    // And the export refuses rather than stamping a packet that is short.
    const outcome = await exportAuthorFeedback(MIKE, { bookSlugs: [BOOK] })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false && outcome.reason, 'incomplete-source')

    for (const [itemId, stamp] of Object.entries(await stamps())) {
      assert.equal(stamp, null, `${itemId} was stamped by a refused export`)
    }
  })
})

test('F3: an annotation object that will not read is disclosed, and refuses the export', async () => {
  await inWorld(async (harness) => {
    await writeLegacyHistory()

    // Damage the stored annotation object itself, leaving the listing intact:
    // the object is enumerated and then will not parse. The file is found by
    // its contents rather than by a hand-built path, so this case keeps
    // working if the storage layout is ever versioned again.
    const stored = findFileContaining(harness.dir, HIGHLIGHT)
    writeFileSync(stored, '{"schema":1,', 'utf8')
    __resetReadingStore()

    const source = await loadAuthorFeedbackSource(MIKE, [BOOK])
    assert.deepEqual(
      source.items.map((item) => item.body),
      [COMMENT],
      'the readable comment should still read',
    )
    assert.equal(source.incomplete, true, 'the unreadable annotation was not disclosed')
    assert.deepEqual(
      source.failures.map((failure) => failure.source),
      ['annotations'],
    )

    const outcome = await exportAuthorFeedback(MIKE, { bookSlugs: [BOOK] })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false && outcome.reason, 'incomplete-source')
    for (const [itemId, stamp] of Object.entries(await stamps())) {
      assert.equal(stamp, null, `${itemId} was stamped by a refused export`)
    }
  })
})

test('F3: a complete source still exports and still stamps', async () => {
  /*
   * The positive control for the two cases above. Without it they could both be
   * satisfied by an export that refuses unconditionally, which would be a
   * different way of being useless.
   */
  await inWorld(async () => {
    await writeLegacyHistory()

    const source = await loadAuthorFeedbackSource(MIKE, [BOOK])
    assert.equal(source.incomplete, false)

    const outcome = await exportAuthorFeedback(MIKE, { bookSlugs: [BOOK] })
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.equal(outcome.stamped, 'recorded')
    assert.equal(outcome.packet.items.length, 2)

    for (const [itemId, stamp] of Object.entries(await stamps())) {
      assert.ok(stamp !== null, `${itemId} was exported and not stamped`)
    }
  })
})

/* ====================================================================== F4 */

test('F4: a present but malformed roster is a failure, not an empty roster', async () => {
  await inWorld(async () => {
    await writeLegacyHistory()

    for (const damaged of [
      '{ not json',
      '{"schema":1,"reviewers":[]}', // a document rather than the bare array
      '"a string"',
      '[{"id":"anna"}]', // an entry the parser rejects
      '[{"id":"anna","name":"Anna","codeHash":"' + 'a'.repeat(64) + '","books":["NOT A SLUG"]}]',
    ]) {
      setRoster(damaged)

      await assert.rejects(
        () => createRosterStore().load(),
        RosterUnreadableError,
        `a roster of ${damaged.slice(0, 24)}… was read as a roster`,
      )

      const source = await loadAuthorFeedbackSource(MIKE, [BOOK])
      assert.equal(source.incomplete, true, `${damaged.slice(0, 24)}… read as an empty roster`)
      assert.deepEqual(source.failures.map((failure) => failure.source), ['roster'])

      // Nothing about the damaged configuration reaches the failure list.
      const serialized = JSON.stringify(source.failures)
      assert.ok(!serialized.includes('anna'), 'a reviewer id leaked into the failure')
      assert.ok(!serialized.includes('a'.repeat(64)), 'a code hash leaked into the failure')

      const outcome = await exportAuthorFeedback(MIKE, { bookSlugs: [BOOK] })
      assert.equal(outcome.ok, false)
      assert.equal(outcome.ok === false && outcome.reason, 'incomplete-source')
      for (const [itemId, stamp] of Object.entries(await stamps())) {
        assert.equal(stamp, null, `${itemId} was stamped while the roster was damaged`)
      }
    }
  })
})

test('F4: an absent or explicitly empty roster is still an empty roster', async () => {
  /*
   * The positive control. A deployment that has given nobody access is a
   * legitimate configuration, and it must not start raising: if both states
   * failed, the correction would have replaced one wrong answer with another.
   */
  await inWorld(async () => {
    for (const legitimate of ['', '   ', '[]']) {
      setRoster(legitimate)
      const doc = await createRosterStore().load()
      assert.deepEqual(doc.reviewers, [], `${JSON.stringify(legitimate)} did not read as empty`)

      const source = await loadAuthorFeedbackSource(MIKE, [BOOK])
      assert.equal(source.incomplete, false, 'an empty roster is not an incompleteness')
      assert.deepEqual(source.failures, [])
    }
  })
})

/* ====================================================================== F8 */

test('F8: duplicate book entitlements collapse at the roster parser', async () => {
  const doc = parseRosterDocument(
    JSON.stringify({
      schema: 1,
      updatedAt: new Date(0).toISOString(),
      reviewers: [
        {
          id: 'anna',
          name: 'Anna Reviewer',
          codeHash: 'a'.repeat(64),
          books: [BOOK, BOOK, 'persistent', BOOK],
        },
      ],
    }),
  )

  assert.ok(doc, 'the duplicate entitlement was rejected rather than canonicalised')
  assert.deepEqual(
    doc.reviewers[0].books,
    [BOOK, 'persistent'],
    'duplicates collapse, and the order they were granted in is kept',
  )
})

test('F8: a duplicate entitlement yields one row, one count and one export item', async () => {
  await inWorld(async () => {
    await writeLegacyHistory()
    setRoster(ROSTER_WITH_DUPLICATE)

    const source = await loadAuthorFeedbackSource(MIKE, [BOOK])
    assert.equal(source.incomplete, false)

    const ids = source.items.map((item) => item.itemId)
    assert.equal(
      new Set(ids).size,
      ids.length,
      'the same row identity was claimed twice in one source',
    )
    assert.deepEqual(
      source.items.map((item) => item.body).sort(),
      [COMMENT, HIGHLIGHT].sort(),
      'one stored record produced more than one row',
    )

    const board = await loadAuthorBoard(MIKE, [BOOK])
    assert.equal(board.rows.length, 2, 'the duplicate reached the dashboard count')

    const outcome = await exportAuthorFeedback(MIKE, { bookSlugs: [BOOK] })
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.equal(outcome.packet.items.length, 2, 'the duplicate reached the packet')
    assert.equal(new Set(outcome.itemIds).size, outcome.itemIds.length)
  })
})

test('F8: canonicalising duplicates does not merge distinct books or reviewers', async () => {
  const doc = parseRosterDocument(
    JSON.stringify({
      schema: 1,
      updatedAt: new Date(0).toISOString(),
      reviewers: [
        {
          id: 'anna',
          name: 'Anna Reviewer',
          codeHash: 'a'.repeat(64),
          books: [BOOK, 'persistent'],
        },
        { id: 'ben', name: 'Ben Reviewer', codeHash: 'b'.repeat(64), books: [BOOK] },
      ],
    }),
  )

  assert.ok(doc)
  assert.equal(doc.reviewers.length, 2, 'two reviewers became one')
  assert.deepEqual(doc.reviewers[0].books, [BOOK, 'persistent'], 'two books became one')
  assert.deepEqual(doc.reviewers[1].books, [BOOK])
})
