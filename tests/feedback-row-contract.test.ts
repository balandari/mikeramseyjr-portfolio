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
import { exportAuthorFeedback } from '../lib/author-export.ts'
import { loadAuthorMetadata, __resetAuthorMetadataStore } from '../lib/author-metadata.ts'
import { __resetNoteStore } from '../lib/notes-store.ts'
import { __resetReadingStore } from '../lib/reviewer-reading.ts'
import { __resetWithdrawalStore } from '../lib/withdrawal-events.ts'
import { __resetRosterStore } from '../lib/reviewer-roster.ts'
import type { Viewer } from '../lib/reading-access.ts'

/*
 * C2-3: one definition of a feedback row, on every reader, carried to the
 * author's export.
 *
 * The partition each reader now draws over a line or object that parsed:
 *
 *   not a row (wrong shape, missing/mistyped field)  -> skipped, incomplete
 *   a row, filed under another book                  -> skipped, incomplete
 *   a row, this book, another reviewer (shared file) -> filtered, complete
 *   a row, this book, this reviewer                  -> emitted
 *
 * The first two used to be emitted (shape) or silently dropped (book) by the
 * filesystem driver. No comment text, identity or row body appears in any
 * assertion message.
 */

const BOOK = 'the-backward-becoming'
const OTHER_BOOK = 'a-second-title'
const MIKE: Viewer = { kind: 'author', id: 'aa11bb22cc33dd44ee55ff66' }
const COMMENT = 'A COMPLETE STORED COMMENT'

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

const REQUIRED_FIELDS = [
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
] as const

/** Valid JSON that is not a row, shape by shape. */
function malformedRows(): Array<[label: string, value: unknown]> {
  const out: Array<[string, unknown]> = [
    ['array', [1, 2, 3]],
    ['string', 'a string'],
    ['number', 42],
    ['null', null],
    ['boolean', true],
    ['empty object', {}],
    ['three-key row', { reviewerId: 'anna', bookSlug: BOOK, comment: 'x' }],
    ['schema 2', { ...validRow(), schema: 2 }],
    ['empty id', { ...validRow(), id: '' }],
    ['bad timestamp', { ...validRow(), createdAt: 'yesterday' }],
    ['string chapterNumber', { ...validRow(), chapterNumber: '1' }],
    ['unknown scope', { ...validRow(), scope: 'book' }],
    ['numeric paragraphId', { ...validRow(), paragraphId: 7 }],
    ['string paragraphOrdinal', { ...validRow(), paragraphOrdinal: '2' }],
    ['numeric quote', { ...validRow(), quote: 5 }],
    ['empty comment', { ...validRow(), comment: '' }],
  ]
  for (const field of REQUIRED_FIELDS) {
    const row: Record<string, unknown> = { ...validRow() }
    delete row[field]
    out.push([`missing ${field}`, row])
  }
  return out
}

/* ----------------------------------------------------------- the validator */

test('C2-3 validator: a complete row is a row, in both scopes', () => {
  assert.ok(asFeedbackEntry(validRow()))
  assert.ok(
    asFeedbackEntry(
      validRow({ scope: 'paragraph', paragraphId: 'chapter-one-p002', paragraphOrdinal: 2, quote: 'q' }),
    ),
  )
})

test('C2-3 validator: every malformed shape and every missing field is not a row', () => {
  for (const [label, value] of malformedRows()) {
    assert.equal(asFeedbackEntry(value), null, `${label} was accepted as a row`)
  }
})

/* ----------------------------------------------------- the filesystem driver */

function withFsFeedback(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mrj-feedback-row-'))
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

test('C2-3 fs: a parseable row of the wrong shape is skipped and disclosed', async () => {
  for (const [label, value] of malformedRows()) {
    await withFsFeedback(async (dir) => {
      appendLine(dir, BOOK, validRow())
      appendLine(dir, BOOK, value)
      const listing = await createFeedbackStore().listForReviewer('anna', BOOK)
      assert.equal(listing.incomplete, true, `${label} was not disclosed`)
      assert.deepEqual(
        listing.entries.map((entry) => entry.id),
        [validRow().id],
        `${label}: the valid row did not survive, or the malformed one was emitted`,
      )
    })
  }
})

test('C2-3 fs: a well-formed row naming another book is misfiled, skipped and disclosed', async () => {
  for (const reviewerId of ['anna', 'ben']) {
    await withFsFeedback(async (dir) => {
      appendLine(dir, BOOK, validRow())
      appendLine(
        dir,
        BOOK,
        validRow({ id: '00000000-0000-4000-8000-000000000002', bookSlug: OTHER_BOOK, reviewerId }),
      )
      const listing = await createFeedbackStore().listForReviewer('anna', BOOK)
      assert.equal(listing.incomplete, true, `a misfiled row (${reviewerId === 'anna' ? 'same' : 'other'} reviewer) was not disclosed`)
      assert.deepEqual(listing.entries.map((entry) => entry.bookSlug), [BOOK])
    })
  }
})

test('C2-3 fs: another reviewer’s correctly filed row is filtered, and the answer is complete', async () => {
  await withFsFeedback(async (dir) => {
    appendLine(dir, BOOK, validRow())
    appendLine(dir, BOOK, validRow({ id: '00000000-0000-4000-8000-000000000003', reviewerId: 'ben' }))

    const anna = await createFeedbackStore().listForReviewer('anna', BOOK)
    assert.equal(anna.incomplete, false)
    assert.deepEqual(anna.entries.map((entry) => entry.reviewerId), ['anna'])

    const ben = await createFeedbackStore().listForReviewer('ben', BOOK)
    assert.equal(ben.incomplete, false)
    assert.deepEqual(ben.entries.map((entry) => entry.reviewerId), ['ben'])
  })
})

test('C2-3 fs: rows the driver itself writes still read back complete', async () => {
  await withFsFeedback(async () => {
    const store = createFeedbackStore()
    const { schema, id, createdAt, ...draft } = validRow()
    void schema
    void id
    void createdAt
    const written = await store.add(draft)
    const listing = await store.listForReviewer('anna', BOOK)
    assert.equal(listing.incomplete, false)
    assert.deepEqual(listing.entries, [written])
  })
})

/* -------------------------------------- the Blob driver, over memory objects */

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

test('C2-3 blob: the same malformed shapes are skipped and disclosed', async () => {
  for (const [label, value] of malformedRows()) {
    const backend = memoryBackend()
    backend.objects.set(feedbackPathname(validRow()), JSON.stringify(validRow()))
    backend.objects.set(`${feedbackPrefix('anna', BOOK)}zz-malformed.json`, JSON.stringify(value))
    const listing = await createVercelBlobFeedbackStore({ backend }).listForReviewer('anna', BOOK)
    assert.equal(listing.incomplete, true, `${label} was not disclosed`)
    assert.deepEqual(listing.entries.map((entry) => entry.id), [validRow().id])
  }
})

test('C2-3 blob: a row naming another book under this book’s prefix is disclosed', async () => {
  const backend = memoryBackend()
  backend.objects.set(feedbackPathname(validRow()), JSON.stringify(validRow()))
  backend.objects.set(
    `${feedbackPrefix('anna', BOOK)}zz-misfiled.json`,
    JSON.stringify(validRow({ id: '00000000-0000-4000-8000-000000000004', bookSlug: OTHER_BOOK })),
  )
  const listing = await createVercelBlobFeedbackStore({ backend }).listForReviewer('anna', BOOK)
  assert.equal(listing.incomplete, true)
  assert.deepEqual(listing.entries.map((entry) => entry.bookSlug), [BOOK])
})

test('C2-3 blob: complete rows remain complete', async () => {
  const backend = memoryBackend()
  const store = createVercelBlobFeedbackStore({ backend })
  const { schema, id, createdAt, ...draft } = validRow()
  void schema
  void id
  void createdAt
  const written = await store.add(draft)
  const listing = await store.listForReviewer('anna', BOOK)
  assert.equal(listing.incomplete, false)
  assert.deepEqual(listing.entries, [written])
})

/* ------------------------------------- author source, dashboard and export */

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
  const dir = mkdtempSync(join(tmpdir(), 'mrj-feedback-row-author-'))
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

async function assertRefusedWithoutStamping(label: string): Promise<void> {
  const source = await loadAuthorFeedbackSource(MIKE, [BOOK])
  assert.equal(source.incomplete, true, `${label}: the source claimed completeness`)
  // The per-book file is shared, so every roster reviewer's read of it sees
  // the damage; each such read is a comment-source failure and nothing else.
  const sources = source.failures.map((failure) => failure.source)
  assert.ok(sources.length > 0, `${label}: no failure was recorded`)
  assert.ok(
    sources.every((name) => name === 'comments'),
    `${label}: a failure named a source other than comments`,
  )
  // The valid row, through the legacy adaptation, still reads.
  assert.deepEqual(
    source.items.map((item) => item.body),
    [COMMENT],
    `${label}: the valid row did not survive, or the bad one was emitted`,
  )
  const serialized = JSON.stringify(source.failures)
  assert.ok(!serialized.includes(COMMENT), `${label}: a row body reached the failure list`)

  const board = await loadAuthorBoard(MIKE, [BOOK])
  assert.equal(board.incomplete, true, `${label}: the dashboard claimed completeness`)

  const before = await metadataSnapshot()
  const outcome = await exportAuthorFeedback(MIKE, { bookSlugs: [BOOK] })
  assert.equal(outcome.ok, false, `${label}: the export went ahead`)
  assert.equal(outcome.ok === false && outcome.reason, 'incomplete-source')
  assert.deepEqual(await metadataSnapshot(), before, `${label}: the refused export mutated metadata`)
  const after = (await metadataSnapshot()).metadata as {
    items: Record<string, { lastExportedAt: unknown }>
  }
  for (const [itemId, item] of Object.entries(after.items)) {
    assert.equal(item.lastExportedAt, null, `${label}: ${itemId} was stamped`)
  }
}

test('C2-3 author path: a row missing required fields is disclosed and refuses the export', async () => {
  await inAuthorWorld(async (feedbackDir) => {
    appendLine(feedbackDir, BOOK, validRow())
    // The Judge's exact shape: a reviewer, a book and a comment, and nothing else.
    appendLine(feedbackDir, BOOK, { reviewerId: 'anna', bookSlug: BOOK, comment: 'partial' })
    await assertRefusedWithoutStamping('missing fields')
  })
})

test('C2-3 author path: valid JSON of the wrong shape is disclosed and refuses the export', async () => {
  await inAuthorWorld(async (feedbackDir) => {
    appendLine(feedbackDir, BOOK, validRow())
    appendLine(feedbackDir, BOOK, [1, 2, 3])
    await assertRefusedWithoutStamping('wrong shape')
  })
})

test('C2-3 author path: a misfiled wrong-book row is disclosed and refuses the export', async () => {
  await inAuthorWorld(async (feedbackDir) => {
    appendLine(feedbackDir, BOOK, validRow())
    appendLine(
      feedbackDir,
      BOOK,
      validRow({ id: '00000000-0000-4000-8000-000000000005', bookSlug: OTHER_BOOK }),
    )
    await assertRefusedWithoutStamping('wrong book')
  })
})

test('C2-3 author path: complete rows from two reviewers in one file export and stamp', async () => {
  await inAuthorWorld(async (feedbackDir) => {
    appendLine(feedbackDir, BOOK, validRow())
    appendLine(
      feedbackDir,
      BOOK,
      validRow({ id: '00000000-0000-4000-8000-000000000006', reviewerId: 'ben' }),
    )
    const source = await loadAuthorFeedbackSource(MIKE, [BOOK])
    assert.equal(source.incomplete, false)
    assert.deepEqual(source.failures, [])
    assert.deepEqual(source.items.map((item) => item.reviewerId).sort(), ['anna', 'ben'])

    const board = await loadAuthorBoard(MIKE, [BOOK])
    assert.equal(board.incomplete, false)

    const outcome = await exportAuthorFeedback(MIKE, { bookSlugs: [BOOK] })
    assert.equal(outcome.ok, true, 'a complete source was refused')
    const after = (await metadataSnapshot()).metadata as {
      items: Record<string, { lastExportedAt: unknown }>
    }
    const stamped = Object.values(after.items).filter((item) => typeof item.lastExportedAt === 'string')
    assert.equal(stamped.length, 2, 'the complete export did not stamp both items')
  })
})
