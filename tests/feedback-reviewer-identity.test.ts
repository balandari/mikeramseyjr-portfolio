import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { asFeedbackEntry } from '../lib/feedback-entry.ts'
import {
  __resetFeedbackStore,
  createFeedbackStore,
  type FeedbackEntry,
} from '../lib/reviewer-feedback.ts'
import {
  createVercelBlobFeedbackStore,
  feedbackPathname,
  feedbackPrefix,
  type FeedbackBlobBackend,
} from '../lib/reviewer-feedback-blob.ts'
import { loadAuthorFeedbackSource } from '../lib/author-feedback-source.ts'
import { loadAuthorBoard } from '../lib/author-dashboard.ts'
import { loadAuthorInbox } from '../lib/author-inbox.ts'
import { exportAuthorFeedback } from '../lib/author-export.ts'
import { loadAuthorMetadata, __resetAuthorMetadataStore } from '../lib/author-metadata.ts'
import { __resetNoteStore } from '../lib/notes-store.ts'
import { __resetReadingStore } from '../lib/reviewer-reading.ts'
import { __resetWithdrawalStore } from '../lib/withdrawal-events.ts'
import { __resetRosterStore } from '../lib/reviewer-roster.ts'
import type { Viewer } from '../lib/reading-access.ts'

/*
 * C3-1: a stored comment row attributed to an identity no reviewer can hold is
 * damage, and the answer that omits it is short.
 *
 * The shared row validator used to accept any string as `reviewerId`. The
 * filesystem driver keeps every reviewer's rows for a book in one file and
 * filters other reviewers' rows out in silence, so a complete row attributed to
 * `""` was read as "somebody else's" and vanished: the listing said complete,
 * the author source said complete, and the export stamped the shortened packet.
 *
 * Two partitions, kept apart on purpose:
 *
 *   **discriminating** -- fail against the frozen C2 validator, pass after the
 *   correction: the validator itself, the filesystem listing, the author
 *   source / dashboard / inbox, and the export's refusal without a stamp.
 *
 *   **consistency and preservation** -- pass on both: the Blob driver over an
 *   in-memory backend (C2 already fails closed there through its prefix-owner
 *   check), valid rows and valid other-reviewer filtering in a correctly filed
 *   shared file, legacy adaptation, and the privacy of what a failure records.
 *
 * No identity under test, comment text or row body appears in an assertion
 * message; cases are named by label only.
 */

const BOOK = 'the-backward-becoming'
const MIKE: Viewer = { kind: 'author', id: 'aa11bb22cc33dd44ee55ff66' }
const COMMENT = 'A COMPLETE STORED COMMENT'
const DAMAGED_COMMENT = 'A COMMENT UNDER A DAMAGED ATTRIBUTION'

function validRow(overrides: Partial<FeedbackEntry> = {}): FeedbackEntry {
  return {
    schema: 1,
    id: '00000000-0000-4000-8000-000000000001',
    createdAt: '2026-02-01T00:00:00.000Z',
    reviewerId: 'anna',
    bookSlug: BOOK,
    chapterSlug: 'chapter-one',
    chapterNumber: 1,
    scope: 'chapter',
    paragraphId: null,
    paragraphOrdinal: null,
    quote: null,
    comment: COMMENT,
    ...overrides,
  }
}

/** An otherwise complete row whose only fault is its attribution. */
function damagedRow(reviewerId: string): FeedbackEntry {
  return validRow({
    id: '00000000-0000-4000-8000-0000000000d1',
    reviewerId,
    comment: DAMAGED_COMMENT,
  })
}

/** The Judge's exact identity, then nonempty identities outside the domain. */
const INVALID_IDENTITIES: Array<[label: string, reviewerId: string]> = [
  ['empty', ''],
  ['punctuation', 'Bad!'],
  ['upper case', 'Anna'],
  ['leading hyphen', '-x'],
  ['leading underscore', '_x'],
  ['sixty-five characters', 'a'.repeat(65)],
  ['trailing newline', 'anna\n'],
  ['internal space', 'an na'],
  ['path traversal', '../anna'],
]

/** The two identities the author-path controls use: empty, and nonempty. */
const AUTHOR_PATH_IDENTITIES = INVALID_IDENTITIES.filter(([label]) =>
  ['empty', 'punctuation'].includes(label),
)

/* ============================================ discriminating: the validator */

test('C3-1 discriminating: the shared validator rejects an empty reviewer identity', () => {
  assert.equal(asFeedbackEntry(damagedRow('')), null, 'empty identity was accepted as a row')
})

test('C3-1 discriminating: the shared validator rejects every nonempty pattern-invalid identity', () => {
  for (const [label, reviewerId] of INVALID_IDENTITIES) {
    if (reviewerId === '') continue
    assert.equal(asFeedbackEntry(damagedRow(reviewerId)), null, `${label} identity was accepted as a row`)
  }
})

/* ====================================== discriminating: the filesystem path */

function withFsFeedback(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mrj-feedback-identity-'))
  const saved = {
    driver: process.env.REVIEWER_FEEDBACK_DRIVER,
    dir: process.env.REVIEWER_FEEDBACK_DIR,
  }
  process.env.REVIEWER_FEEDBACK_DRIVER = 'fs'
  process.env.REVIEWER_FEEDBACK_DIR = dir
  __resetFeedbackStore()
  return run(dir).finally(() => {
    __resetFeedbackStore()
    if (saved.driver === undefined) delete process.env.REVIEWER_FEEDBACK_DRIVER
    else process.env.REVIEWER_FEEDBACK_DRIVER = saved.driver
    if (saved.dir === undefined) delete process.env.REVIEWER_FEEDBACK_DIR
    else process.env.REVIEWER_FEEDBACK_DIR = saved.dir
    rmSync(dir, { recursive: true, force: true })
  })
}

function appendLine(dir: string, book: string, value: unknown): void {
  appendFileSync(join(dir, `${book}.ndjson`), `${JSON.stringify(value)}\n`, 'utf8')
}

async function assertFsListingShort(label: string, reviewerId: string): Promise<void> {
  await withFsFeedback(async (dir) => {
    appendLine(dir, BOOK, validRow())
    appendLine(dir, BOOK, damagedRow(reviewerId))
    // Every roster-shaped reader of the shared file sees the damage, not only
    // the one whose identity the row resembles.
    for (const reader of ['anna', 'ben']) {
      const listing = await createFeedbackStore().listForReviewer(reader, BOOK)
      assert.equal(listing.incomplete, true, `${label}: the ${reader === 'anna' ? 'first' : 'second'} reader's listing claimed completeness`)
      assert.ok(
        listing.entries.every((entry) => entry.id !== damagedRow(reviewerId).id),
        `${label}: the damaged row was emitted`,
      )
    }
    const anna = await createFeedbackStore().listForReviewer('anna', BOOK)
    assert.deepEqual(
      anna.entries.map((entry) => entry.id),
      [validRow().id],
      `${label}: the valid row did not survive`,
    )
  })
}

test('C3-1 discriminating: fs listing is incomplete for the Judge exact empty-identity path', async () => {
  await assertFsListingShort('empty', '')
})

test('C3-1 discriminating: fs listing is incomplete for every nonempty pattern-invalid identity', async () => {
  for (const [label, reviewerId] of INVALID_IDENTITIES) {
    if (reviewerId === '') continue
    await assertFsListingShort(label, reviewerId)
  }
})

/* ======================== discriminating: author source, board, inbox, export */

const WORLD_KEYS = [
  'REVIEWER_FEEDBACK_DRIVER',
  'REVIEWER_FEEDBACK_DIR',
  'REVIEWER_READING_DIR',
  'REVIEWER_ROSTER_DRIVER',
  'REVIEWER_ROSTER',
] as const

function resetStores(): void {
  __resetNoteStore()
  __resetReadingStore()
  __resetWithdrawalStore()
  __resetAuthorMetadataStore()
  __resetRosterStore()
  __resetFeedbackStore()
}

async function inAuthorWorld(run: (feedbackDir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mrj-feedback-identity-author-'))
  const saved = new Map(WORLD_KEYS.map((key) => [key, process.env[key]]))
  const feedbackDir = join(dir, 'feedback')
  mkdirSync(feedbackDir, { recursive: true })
  process.env.REVIEWER_FEEDBACK_DRIVER = 'fs'
  process.env.REVIEWER_FEEDBACK_DIR = feedbackDir
  process.env.REVIEWER_READING_DIR = join(dir, 'reading')
  process.env.REVIEWER_ROSTER_DRIVER = 'env'
  process.env.REVIEWER_ROSTER = JSON.stringify([
    { id: 'anna', name: 'Reviewer A', books: [BOOK], codeHash: 'a'.repeat(64) },
    { id: 'ben', name: 'Reviewer B', books: [BOOK], codeHash: 'b'.repeat(64) },
  ])
  resetStores()
  try {
    await run(feedbackDir)
  } finally {
    resetStores()
    for (const key of WORLD_KEYS) {
      const value = saved.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * The stored metadata document and its storage version, read at a fixed clock
 * so that an absent document synthesises the same value on every read. Any
 * write between two snapshots moves the version or the document.
 */
async function metadataSnapshot(): Promise<{ metadata: unknown; version: unknown }> {
  const loaded = await loadAuthorMetadata(MIKE, BOOK, '2026-01-01T00:00:00.000Z')
  assert.equal(loaded.ok, true, 'the metadata document could not be read')
  if (!loaded.ok) throw new Error('unreachable')
  return { metadata: loaded.value.metadata, version: loaded.value.version }
}

function stampedCount(metadata: unknown): number {
  const items = (metadata as { items: Record<string, { lastExportedAt: unknown }> }).items
  return Object.values(items).filter((item) => item.lastExportedAt !== null).length
}

test('C3-1 discriminating: the author source, dashboard and inbox stay incomplete on the fs path', async () => {
  for (const [label, reviewerId] of AUTHOR_PATH_IDENTITIES) {
    await inAuthorWorld(async (feedbackDir) => {
      appendLine(feedbackDir, BOOK, validRow())
      appendLine(feedbackDir, BOOK, damagedRow(reviewerId))

      const source = await loadAuthorFeedbackSource(MIKE, [BOOK])
      assert.equal(source.incomplete, true, `${label}: the author source claimed completeness`)
      const sources = source.failures.map((failure) => failure.source)
      assert.ok(sources.length > 0, `${label}: no failure was recorded`)
      assert.ok(
        sources.every((name) => name === 'comments'),
        `${label}: a failure named a source other than comments`,
      )
      assert.deepEqual(
        source.items.map((item) => item.body),
        [COMMENT],
        `${label}: the valid row did not survive, or the damaged one was emitted`,
      )

      const board = await loadAuthorBoard(MIKE, [BOOK])
      assert.equal(board.incomplete, true, `${label}: the dashboard claimed completeness`)

      const inbox = await loadAuthorInbox(MIKE)
      assert.equal(inbox.incomplete, true, `${label}: the inbox claimed completeness`)
      assert.ok(
        inbox.comments.every((comment) => JSON.stringify(comment).includes(DAMAGED_COMMENT) === false),
        `${label}: the inbox rendered the damaged row`,
      )
    })
  }
})

test('C3-1 discriminating: the export refuses and records no stamp or metadata change on the fs path', async () => {
  for (const [label, reviewerId] of AUTHOR_PATH_IDENTITIES) {
    await inAuthorWorld(async (feedbackDir) => {
      appendLine(feedbackDir, BOOK, validRow())
      appendLine(feedbackDir, BOOK, damagedRow(reviewerId))

      const before = await metadataSnapshot()
      const outcome = await exportAuthorFeedback(MIKE, { bookSlugs: [BOOK] })
      assert.equal(outcome.ok, false, `${label}: the export went ahead`)
      assert.equal(outcome.ok === false && outcome.reason, 'incomplete-source', `${label}: wrong refusal`)
      const after = await metadataSnapshot()
      assert.deepEqual(after, before, `${label}: the refused export mutated metadata`)
      assert.equal(stampedCount(after.metadata), 0, `${label}: an item was stamped`)
    })
  }
})

/* ============== consistency: the Blob driver over an in-memory backend */

function memoryBackend(): FeedbackBlobBackend & { objects: Map<string, string> } {
  const objects = new Map<string, string>()
  return {
    objects,
    async putObject(pathname, body) {
      if (objects.has(pathname)) throw new Error('already exists')
      objects.set(pathname, body)
    },
    async listPathnames(prefix) {
      return Array.from(objects.keys()).filter((key) => key.startsWith(prefix))
    },
    async readObject(pathname) {
      return objects.get(pathname) ?? null
    },
  }
}

test('C3-1 consistency: the Blob driver over memory is incomplete for the same invalid identities', async () => {
  for (const [label, reviewerId] of INVALID_IDENTITIES) {
    const backend = memoryBackend()
    backend.objects.set(feedbackPathname(validRow()), JSON.stringify(validRow()))
    backend.objects.set(
      `${feedbackPrefix('anna', BOOK)}zz-damaged-attribution.json`,
      JSON.stringify(damagedRow(reviewerId)),
    )
    const listing = await createVercelBlobFeedbackStore({ backend }).listForReviewer('anna', BOOK)
    assert.equal(listing.incomplete, true, `${label}: the Blob listing claimed completeness`)
    assert.deepEqual(
      listing.entries.map((entry) => entry.id),
      [validRow().id],
      `${label}: the valid row did not survive, or the damaged one was emitted`,
    )
  }
})

/* ============================================================ preservation */

test('C3-1 preservation: valid identities across the domain are rows', () => {
  for (const reviewerId of ['anna', 'a', '0', 'a'.repeat(64), 'reviewer-anna-0001', 'r_1-x']) {
    assert.ok(asFeedbackEntry(validRow({ reviewerId })), 'a valid identity was refused')
  }
})

test('C3-1 preservation: valid other-reviewer filtering in a correctly filed shared file stays complete', async () => {
  await withFsFeedback(async (dir) => {
    appendLine(dir, BOOK, validRow())
    appendLine(dir, BOOK, validRow({ id: '00000000-0000-4000-8000-000000000002', reviewerId: 'ben' }))
    appendLine(
      dir,
      BOOK,
      validRow({ id: '00000000-0000-4000-8000-000000000003', reviewerId: 'reviewer-anna-0001' }),
    )

    const anna = await createFeedbackStore().listForReviewer('anna', BOOK)
    assert.equal(anna.incomplete, false)
    assert.deepEqual(anna.entries.map((entry) => entry.id), [validRow().id])

    const ben = await createFeedbackStore().listForReviewer('ben', BOOK)
    assert.equal(ben.incomplete, false)
    assert.deepEqual(ben.entries.map((entry) => entry.id), ['00000000-0000-4000-8000-000000000002'])
  })
})

test('C3-1 preservation: rows each driver writes read back complete', async () => {
  const { schema, id, createdAt, ...draft } = validRow()
  void schema
  void id
  void createdAt

  await withFsFeedback(async () => {
    const store = createFeedbackStore()
    const written = await store.add(draft)
    const listing = await store.listForReviewer('anna', BOOK)
    assert.equal(listing.incomplete, false)
    assert.deepEqual(listing.entries, [written])
  })

  const blob = createVercelBlobFeedbackStore({ backend: memoryBackend() })
  const written = await blob.add(draft)
  const listing = await blob.listForReviewer('anna', BOOK)
  assert.equal(listing.incomplete, false)
  assert.deepEqual(listing.entries, [written])
})

test('C3-1 preservation: valid legacy adaptation reaches the author, and the export still stamps', async () => {
  await inAuthorWorld(async (feedbackDir) => {
    appendLine(feedbackDir, BOOK, validRow())
    appendLine(feedbackDir, BOOK, validRow({ id: '00000000-0000-4000-8000-000000000002', reviewerId: 'ben' }))

    const source = await loadAuthorFeedbackSource(MIKE, [BOOK])
    assert.equal(source.incomplete, false)
    assert.deepEqual(source.failures, [])
    const comments = source.items.filter((item) => item.kind === 'comment')
    assert.equal(comments.length, 2)
    for (const item of comments) {
      assert.equal(item.originator, 'reviewer')
      assert.equal(item.body, COMMENT)
      assert.equal(item.bookSlug, BOOK)
      assert.equal(item.anchorState, 'ok')
      assert.equal(item.revision, null)
      assert.ok(item.reviewerName, 'a roster reviewer was not named')
    }
    assert.deepEqual(comments.map((item) => item.reviewerId).sort(), ['anna', 'ben'])

    assert.equal((await loadAuthorBoard(MIKE, [BOOK])).incomplete, false)
    const inbox = await loadAuthorInbox(MIKE)
    assert.equal(inbox.incomplete, false)

    const outcome = await exportAuthorFeedback(MIKE, { bookSlugs: [BOOK] })
    assert.equal(outcome.ok, true, 'a complete source was refused')
    assert.equal(stampedCount((await metadataSnapshot()).metadata), 2)
  })
})

test('C3-1 preservation: what a failure records carries no identity, comment or row body', async () => {
  for (const [label, reviewerId] of AUTHOR_PATH_IDENTITIES) {
    await inAuthorWorld(async (feedbackDir) => {
      appendLine(feedbackDir, BOOK, validRow())
      appendLine(feedbackDir, BOOK, damagedRow(reviewerId))
      const source = await loadAuthorFeedbackSource(MIKE, [BOOK])
      const serialized = JSON.stringify(source.failures)
      assert.ok(!serialized.includes(COMMENT), `${label}: a comment reached the failure list`)
      assert.ok(!serialized.includes(DAMAGED_COMMENT), `${label}: the damaged comment reached the failure list`)
      assert.ok(!serialized.includes(damagedRow(reviewerId).id), `${label}: a row id reached the failure list`)
      if (reviewerId !== '') {
        assert.ok(!serialized.includes(reviewerId), `${label}: the identity reached the failure list`)
      }
      // A private reviewer surface is never widened by the damage: the
      // second reviewer's own listing still never carries the first's row.
      const ben = await createFeedbackStore().listForReviewer('ben', BOOK)
      assert.ok(ben.entries.every((entry) => entry.reviewerId === 'ben'), `${label}: another reviewer's row leaked`)
    })
  }
})
