import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/*
 * Deletion, at the service: the revision check, the withdrawal event, and the
 * one ordering that cannot be got wrong.
 *
 * `tests/notes-store.test.ts` proves the conditional removal at the store and
 * `tests/note-routes.test.ts` proves it through a real request. What is left for
 * this file is the part in between -- the decision about whether an event is
 * owed at all, and what happens when the event fails **after** the note is
 * already gone, which is the one failure in this package that cannot be undone.
 */

import { createNote, deleteNote, listSharedReviewerNotes } from '../lib/note-service.ts'
import { __resetNoteStore, createNoteStore } from '../lib/notes-store.ts'
import { __resetReadingStore } from '../lib/reviewer-reading.ts'
import {
  __resetWithdrawalStore,
  createWithdrawalStore,
  bookWithdrawalsPrefix,
} from '../lib/withdrawal-events.ts'
import {
  __resetAuthorMetadataStore,
  itemMetadata,
  loadAuthorMetadata,
  setItemResolved,
} from '../lib/author-metadata.ts'
import { loadAuthorFeedbackSource } from '../lib/author-feedback-source.ts'
import { exportAuthorFeedback } from '../lib/author-export.ts'
import { __resetRosterStore } from '../lib/reviewer-roster.ts'
import { __resetFeedbackStore } from '../lib/reviewer-feedback.ts'
import type { Viewer } from '../lib/reading-access.ts'

const BOOK = 'the-backward-becoming'
const CHAPTER = 'chapter-one'
const ANNA: Viewer = { kind: 'reviewer', id: 'anna', books: [BOOK] }
const MIKE: Viewer = { kind: 'author', id: 'aa11bb22cc33dd44ee55ff66' }
const AT = '2026-09-16T12:00:00.000Z'

const ROSTER = JSON.stringify([
  { id: 'anna', name: 'Anna Reviewer', books: [BOOK], codeHash: 'a'.repeat(64) },
])

const KEYS = [
  'REVIEWER_FEEDBACK_DRIVER',
  'REVIEWER_FEEDBACK_DIR',
  'REVIEWER_READING_DIR',
  'REVIEWER_ROSTER_DRIVER',
  'REVIEWER_ROSTER',
] as const

type World = { dir: string; cleanup: () => void }

function world(): World {
  const dir = mkdtempSync(join(tmpdir(), 'mrj-note-deletion-'))
  const saved = new Map(KEYS.map((key) => [key, process.env[key]]))
  const feedbackDir = join(dir, 'feedback')
  mkdirSync(feedbackDir, { recursive: true })

  process.env.REVIEWER_FEEDBACK_DRIVER = 'fs'
  process.env.REVIEWER_FEEDBACK_DIR = feedbackDir
  process.env.REVIEWER_READING_DIR = join(dir, 'reading')
  process.env.REVIEWER_ROSTER_DRIVER = 'env'
  process.env.REVIEWER_ROSTER = ROSTER
  reset()

  return {
    dir,
    cleanup() {
      reset()
      for (const key of KEYS) {
        const value = saved.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function reset(): void {
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
  body: string,
  over: Record<string, unknown> = {},
): Promise<{ id: string; revision: number }> {
  const created = await createNote(ANNA, {
    bookSlug: BOOK,
    scope: 'chapter',
    chapterSlug: CHAPTER,
    body,
    visibility: 'shared',
    ...over,
  })
  assert.equal(created.ok, true)
  if (!created.ok) throw new Error('unreachable')
  return { id: created.value.id, revision: created.value.revision }
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

/* --------------------------------------------------------- the version check */

test('a delete that says no version is invalid, and removes nothing', async () => {
  await inWorld(async () => {
    const written = await note('STILL HERE')
    for (const bad of [undefined, null, '1', 0, -1, 1.5, Number.NaN, {}]) {
      const outcome = await deleteNote(ANNA, BOOK, written.id, bad)
      assert.equal(outcome.ok, false, `${String(bad)} was accepted as a revision`)
      assert.equal(outcome.ok === false ? outcome.reason : null, 'invalid')
    }
    assert.ok(await createNoteStore().getNote(ANNA, BOOK, written.id))
  })
})

test('a stale delete is a conflict, removes nothing, and records no event', async () => {
  await inWorld(async () => {
    const written = await note('FIRST WORDS')
    const store = createNoteStore()
    const edited = await store.updateNote(ANNA, BOOK, written.id, { body: 'SECOND' }, written.revision)
    assert.equal(edited.outcome, 'updated')

    const outcome = await deleteNote(ANNA, BOOK, written.id, written.revision)
    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false ? outcome.reason : null, 'conflict')

    assert.equal((await store.getNote(ANNA, BOOK, written.id))?.body, 'SECOND')
    const listing = await createWithdrawalStore().list(BOOK)
    assert.deepEqual(listing.events, [], 'a refused delete announced a withdrawal')
  })
})

/* ------------------------------------------------------ the event, and when */

test('a shared note leaves one event; a private one leaves nothing', async () => {
  await inWorld(async () => {
    const shared = await note('SHARED, THEN WITHDRAWN')
    const kept = await note('PRIVATE, THEN GONE', { visibility: 'private' })

    const one = await deleteNote(ANNA, BOOK, shared.id, shared.revision)
    assert.equal(one.ok && one.value.withdrawal, 'recorded')

    const two = await deleteNote(ANNA, BOOK, kept.id, kept.revision)
    assert.equal(two.ok && two.value.withdrawal, 'not-owed')

    const listing = await createWithdrawalStore().list(BOOK)
    assert.equal(listing.events.length, 1)
    assert.equal(listing.events[0].noteId, shared.id)
    // Not even the private note's identifier is anywhere Mike can reach.
    assert.ok(!JSON.stringify(listing).includes(kept.id))
  })
})

test('the stored event holds seven fields and not one word of the note', async () => {
  await inWorld(async (harness) => {
    /*
     * The bytes, not the object.
     *
     * `WithdrawalStore.record` serializes with `JSON.stringify`, so a caller
     * that built an event by spreading a note -- `{ ...note, schema: 1 }`, the
     * shape anybody would reach for -- would write the body straight to disk
     * unless the store normalises on the way out as well as on the way in. This
     * reads the object the real deletion path actually wrote.
     */
    const written = await note('THE EXACT WORDS SHE TOOK BACK', {
      scope: 'paragraph',
      paragraphId: `${CHAPTER}-p002`,
    })
    const removed = await deleteNote(ANNA, BOOK, written.id, written.revision)
    assert.equal(removed.ok && removed.value.withdrawal, 'recorded')

    const events = walk(join(harness.dir, 'reading', 'withdrawals'))
    assert.equal(events.length, 1, 'one retraction, one event')
    const bytes = readFileSync(events[0], 'utf8')

    assert.deepEqual(
      Object.keys(JSON.parse(bytes) as Record<string, unknown>).sort(),
      ['bookSlug', 'chapterSlug', 'noteId', 'revision', 'schema', 'scope', 'withdrawnAt'],
      'the stored event carries a field it may not carry',
    )
    assert.ok(!bytes.includes('THE EXACT WORDS SHE TOOK BACK'), 'the body was written to the event')
    assert.ok(!bytes.includes('anna'), 'the event names the reviewer who withdrew it')
    for (const forbidden of [
      '"body"',
      '"quote"',
      '"paragraphText"',
      '"paragraphId"',
      '"ownerId"',
      '"ownerKind"',
      '"visibility"',
      '"createdAt"',
      '"updatedAt"',
    ]) {
      assert.ok(!bytes.includes(forbidden), `${forbidden} was written to the event`)
    }
  })
})

test('the decision is taken on the row that was removed, not on the request', async () => {
  await inWorld(async () => {
    /*
     * A note that was narrowed to private after it was shared. The delete is
     * made against its current revision, and what decides whether Mike is told
     * is the row the store actually removed -- which is private -- and not what
     * the note used to be or what anything on the request says.
     */
    const written = await note('SHARED, THEN NARROWED')
    const store = createNoteStore()
    const narrowed = await store.updateNote(
      ANNA,
      BOOK,
      written.id,
      { visibility: 'private' },
      written.revision,
    )
    assert.equal(narrowed.outcome, 'updated')
    if (narrowed.outcome !== 'updated') return

    const outcome = await deleteNote(ANNA, BOOK, written.id, narrowed.note.revision)
    assert.equal(outcome.ok && outcome.value.withdrawal, 'not-owed')
    assert.deepEqual((await createWithdrawalStore().list(BOOK)).events, [])
  })
})

test('the event is written after the deletion, never before it', async () => {
  await inWorld(async (harness) => {
    /*
     * The ordering proved by making the **event** impossible and checking that
     * the note is gone anyway. An implementation that wrote the event first
     * would refuse the whole operation here and leave the note in place -- and
     * one that wrote it first and then failed to delete would have told Mike a
     * note was withdrawn that is still in his inbox.
     */
    const written = await note('DELETED EVEN SO')

    // A file where the withdrawals directory for this book must be. The real
    // filesystem driver's `mkdirSync` under it throws ENOTDIR.
    const root = join(harness.dir, 'reading', 'withdrawals', 'v1')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, BOOK), 'not a directory', 'utf8')

    const outcome = await deleteNote(ANNA, BOOK, written.id, written.revision)

    // The reviewer is told their retraction succeeded, because it did.
    assert.equal(outcome.ok, true)
    assert.equal(outcome.ok && outcome.value.withdrawal, 'failed')

    // The note is gone and is not rolled back: re-creating it would resurrect
    // content its author has retracted.
    assert.equal(await createNoteStore().getNote(ANNA, BOOK, written.id), null)
    assert.deepEqual(await listSharedReviewerNotes(MIKE, [BOOK]), {
      notes: [],
      incomplete: false,
    })

    // And the words are nowhere on disk, event or no event.
    for (const file of walk(harness.dir)) {
      assert.ok(
        !readFileSync(file, 'utf8').includes('DELETED EVEN SO'),
        `the withdrawn body survived at ${file}`,
      )
    }
  })
})

test('an event write that fails is a residual, and never a false deletion story', async () => {
  await inWorld(async (harness) => {
    const written = await note('GONE, UNANNOUNCED')
    const root = join(harness.dir, 'reading', 'withdrawals', 'v1')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, BOOK), 'not a directory', 'utf8')

    const outcome = await deleteNote(ANNA, BOOK, written.id, written.revision)
    assert.equal(outcome.ok && outcome.value.withdrawal, 'failed')

    /*
     * The exact residual, stated: the note is deleted and Mike will not be told
     * it was withdrawn. That is a missing event, not a surviving note, and the
     * difference is what makes it survivable.
     */
    assert.equal(await createNoteStore().getNote(ANNA, BOOK, written.id), null)

    // Deleting it again is a plain absence, not a second chance at the event.
    const again = await deleteNote(ANNA, BOOK, written.id, written.revision)
    assert.equal(again.ok, false)
    assert.equal(again.ok === false ? again.reason : null, 'not-found')
  })
})

/* ------------------------------------------- what stops surfacing afterwards */

test('triage recorded against a withdrawn note surfaces nowhere afterwards', async () => {
  await inWorld(async () => {
    const written = await note('MIKE WILL RESOLVE THIS')
    const itemId = `note:${written.id}`

    await setItemResolved(MIKE, BOOK, itemId, true, AT)
    let metadata = await loadAuthorMetadata(MIKE, BOOK, AT)
    assert.ok(metadata.ok && itemMetadata(metadata.value.metadata, itemId).resolved)

    const removed = await deleteNote(ANNA, BOOK, written.id, written.revision)
    assert.equal(removed.ok && removed.value.withdrawal, 'recorded')

    /*
     * The metadata entry is still on disk -- a reviewer's session cannot write
     * Mike's document, and must not be able to. What matters is that it reaches
     * nothing: the source has no row with that item id, so no count, no
     * listing and no packet can carry "Mike resolved this" about a note that no
     * longer exists.
     */
    metadata = await loadAuthorMetadata(MIKE, BOOK, AT)
    assert.ok(metadata.ok && itemMetadata(metadata.value.metadata, itemId).resolved)

    const source = await loadAuthorFeedbackSource(MIKE, [BOOK])
    assert.ok(
      !source.items.some((item) => item.itemId === itemId),
      'a withdrawn note is still in the author source',
    )

    const packet = await exportAuthorFeedback(MIKE, { bookSlugs: [BOOK] }, AT)
    assert.ok(packet.ok)
    if (!packet.ok) return
    assert.ok(
      !packet.itemIds.includes(itemId),
      'a withdrawn note was exported through its stale triage entry',
    )
    assert.ok(!packet.json.includes('MIKE WILL RESOLVE THIS'))
    // The withdrawal is the only remnant, and it is its own item.
    assert.ok(packet.itemIds.includes(`withdrawal:${written.id}`))
  })
})

test('a withdrawal event is where a book prefix says it is', async () => {
  await inWorld(async (harness) => {
    const written = await note('WITHDRAWN')
    await deleteNote(ANNA, BOOK, written.id, written.revision)

    const expected = join(
      harness.dir,
      'reading',
      ...bookWithdrawalsPrefix(BOOK).split('/').filter(Boolean),
      `${written.id}.json`,
    )
    assert.ok(existsSync(expected), `no event at ${expected}`)
  })
})
