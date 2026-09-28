import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/*
 * What two clients editing one note may and may not do to each other.
 *
 * `NoteStore.updateNote` used to read a note, build its successor from what it
 * read, and replace the object unconditionally. Both callers were told they had
 * succeeded whatever order the writes landed in, and three things followed --
 * every one of them demonstrated against this class, not argued from it:
 *
 *   1. a **retracted** note came back, still shared, because an edit already in
 *      flight rewrote the object after the delete;
 *   2. a note **narrowed to "Only me"** was returned to `shared` by an
 *      in-flight body edit carrying the record as it was before the narrowing;
 *   3. two concurrent edits **silently discarded** one of them.
 *
 * The first two widen who can read something, which is the one direction this
 * whole contract exists to make impossible. The realistic trigger is not an
 * attacker: it is the same reviewer on a phone and a laptop, or one request
 * retried. The reader's `busy` flag serialises these inside a single tab, and
 * `busy` is client state, not a server guarantee.
 *
 * ## How the interleavings are made deterministic
 *
 * Not by timers. Every test below drives the store through an object layer that
 * **pauses a named operation on a promise the test resolves**, so the second
 * operation is known to have completed in the window between the first one's
 * read and its write. There is no sleep anywhere in this file and no ordering
 * that depends on how fast a machine is.
 *
 * Both drivers are exercised, because a conditional write is exactly the
 * primitive where a filesystem and an object store could silently disagree.
 */

import {
  __noteStoreOver,
  __resetNoteStore,
  createNoteStore,
  notePath,
  type Note,
  type NoteDraft,
  type NoteStore,
  type NoteUpdateOutcome,
  type NoteListing,
} from '../lib/notes-store.ts'
import { createReadingObjects, type ReadingObjects } from '../lib/reviewer-reading.ts'
import type { OwnerRef } from '../lib/reading-access.ts'
import type { NoteAnchor } from '../lib/note-contract.ts'

/**
 * The notes of a listing that was expected to be complete.
 *
 * See `NoteListing`: a listing carries whether every enumerated object could
 * be read as a note. Asserting that here turns each existing case below into
 * a statement about both halves of the answer.
 */
async function completeNotes(
  listing: Promise<NoteListing> | NoteListing,
): Promise<Note[]> {
  const resolved = await listing
  assert.equal(resolved.incomplete, false, 'this listing was expected to be complete')
  return resolved.notes
}

const ANNA: OwnerRef = { kind: 'reviewer', id: 'anna' }
const BOOK = 'the-backward-becoming'
const SHA = 'c'.repeat(64)

/* ------------------------------------------------------------- the drivers */

function memoryObjects(): ReadingObjects {
  const store = new Map<string, string>()
  const versions = new Map<string, number>()
  let tick = 0

  return {
    driver: 'memory',
    durable: false,
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
    /*
     * The conditional removal, with the same version discipline the conditional
     * write above uses: an absent object answers false, because nothing was
     * removed by this call, and a version that has moved answers false without
     * removing anything.
     */
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

type Harness = { objects: ReadingObjects; cleanup: () => void }

function fsObjects(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'mrj-note-conc-'))
  const saved = {
    driver: process.env.REVIEWER_FEEDBACK_DRIVER,
    readingDir: process.env.REVIEWER_READING_DIR,
  }
  process.env.REVIEWER_FEEDBACK_DRIVER = 'fs'
  process.env.REVIEWER_READING_DIR = dir
  __resetNoteStore()
  const objects = createReadingObjects()

  return {
    objects,
    cleanup() {
      __resetNoteStore()
      if (saved.driver === undefined) delete process.env.REVIEWER_FEEDBACK_DRIVER
      else process.env.REVIEWER_FEEDBACK_DRIVER = saved.driver
      if (saved.readingDir === undefined) delete process.env.REVIEWER_READING_DIR
      else process.env.REVIEWER_READING_DIR = saved.readingDir
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** The same test against a real directory and against an in-memory store. */
function forEachDriver(
  name: string,
  body: (objects: ReadingObjects) => Promise<void>,
): void {
  // An interleaving test that stops making progress has stopped proving
  // anything, so a stall is a failure here rather than a hung run.
  const limit = { timeout: 30_000 }

  test(`${name} [fs]`, limit, async () => {
    const harness = fsObjects()
    try {
      await body(harness.objects)
    } finally {
      harness.cleanup()
    }
  })

  test(`${name} [object store]`, limit, async () => {
    await body(memoryObjects())
  })
}

/* --------------------------------------------------- the interleaving seam */

/** A promise the test decides when to resolve. No timers, ever. */
function latch(): { wait: Promise<void>; release: () => void } {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}

type Counts = {
  getVersioned: number
  putIfMatch: number
  put: number
  del: number
  delIfMatch: number
}

/**
 * An object layer that can be stopped between an operation's read and its write.
 *
 * `pauseAfterRead` is resolved by the store the moment a read has returned;
 * whatever the test does next is therefore *known* to happen inside the window
 * a read-modify-write leaves open, and the store does not continue until the
 * test says so. That is the whole mechanism -- there is no race to win and
 * nothing to tune.
 *
 * It pauses after the first read of **either** kind. A conditional update reads
 * through `getVersioned`; the unguarded read-modify-write this replaced read
 * through `get`. Waiting on only one of them would make this harness hang
 * rather than fail against an implementation that used the other, and a test
 * that hangs is a test that has stopped saying anything.
 */
function instrumented(
  base: ReadingObjects,
  hooks: {
    pauseAfterRead?: { reached: () => void; go: Promise<void> }
  } = {},
): ReadingObjects & { counts: Counts } {
  const counts: Counts = { getVersioned: 0, putIfMatch: 0, put: 0, del: 0, delIfMatch: 0 }
  let paused = hooks.pauseAfterRead

  // One pause per harness: the second operation must not wait on a latch the
  // first one already consumed.
  const pauseOnce = async () => {
    if (!paused) return
    const here = paused
    paused = undefined
    here.reached()
    await here.go
  }

  return {
    counts,
    driver: base.driver,
    durable: base.durable,
    async get(path) {
      const answer = await base.get(path)
      await pauseOnce()
      return answer
    },
    async getVersioned(path) {
      counts.getVersioned += 1
      const answer = await base.getVersioned(path)
      await pauseOnce()
      return answer
    },
    async putIfMatch(path, body, version) {
      counts.putIfMatch += 1
      return base.putIfMatch(path, body, version)
    },
    async put(path, body) {
      counts.put += 1
      return base.put(path, body)
    },
    async del(path) {
      counts.del += 1
      return base.del(path)
    },
    // Counted apart from `del`, because the whole point of the repair is that a
    // note's removal no longer goes through the unconditional one.
    async delIfMatch(path, version) {
      counts.delIfMatch += 1
      return base.delIfMatch(path, version)
    },
    list: (prefix) => base.list(prefix),
  }
}

/* ------------------------------------------------------------------ drafts */

function passageAnchor(): Extract<NoteAnchor, { scope: 'passage' }> {
  return {
    scope: 'passage',
    chapterSlug: 'chapter-one',
    chapterNumber: 1,
    chapterLabel: 'Chapter one',
    paragraphId: 'chapter-one-p004',
    paragraphOrdinal: 4,
    startOffset: 0,
    endOffset: 5,
    quote: 'Words',
    manuscriptSha256: SHA,
  }
}

function draft(overrides: Partial<NoteDraft> = {}): NoteDraft {
  return {
    ownerKind: ANNA.kind,
    ownerId: ANNA.id,
    bookSlug: BOOK,
    scope: 'passage',
    body: 'ORIGINAL BODY',
    visibility: 'private',
    status: 'open',
    anchor: passageAnchor(),
    ...overrides,
  }
}

function acceptedNote(outcome: NoteUpdateOutcome): Note {
  assert.equal(outcome.outcome, 'updated', 'this update was expected to be accepted')
  return (outcome as { outcome: 'updated'; note: Note }).note
}

/* ------------------------------------------------- the revision, on its own */

forEachDriver('a new note is revision 1 and each accepted edit moves it by one', async (objects) => {
  const store = __noteStoreOver(objects)
  const note = await store.addNote(draft())
  assert.equal(note.revision, 1)

  const once = acceptedNote(await store.updateNote(ANNA, BOOK, note.id, { body: 'ONE' }, 1))
  assert.equal(once.revision, 2)

  const twice = acceptedNote(await store.updateNote(ANNA, BOOK, note.id, { body: 'TWO' }, 2))
  assert.equal(twice.revision, 3)

  assert.equal((await store.getNote(ANNA, BOOK, note.id))?.revision, 3)
})

/*
 * ## The superseded contract, and why it had to go (F1)
 *
 * A single case used to stand here, called "a row written before revisions
 * existed reads and edits as revision 1". It looped one list over **two
 * different situations** -- a row with no `revision` key at all, and a row
 * whose `revision` had been damaged into a string, a fraction, a negative,
 * `NaN` or an object -- and asserted the same thing about both: that the row
 * reads as revision 1, and that an update claiming revision **1** is accepted
 * and bumps the note to 2.
 *
 * For the first situation that is right, and it is kept below.
 *
 * For the second it asserted the defect. A row whose revision is damaged does
 * not know what version it is, and normalising it to 1 does not refuse an
 * edit -- it manufactures the very token the edit is checked against. The old
 * case could not see that, because its "stale" probe was **9**, a revision the
 * note had never held and which a correct and a broken implementation refuse
 * alike. Had the probe been the revision the note actually held, the case
 * would have shown the true revision being rejected while a stale 1 sailed
 * through. Note also what it locked in on the way past: a note at revision 3
 * accepting a revision-1 edit and being written back as revision **2**.
 *
 * The five cases below replace it. Each one fails against that behaviour and
 * passes against this one, and they are the five the correction is owed:
 * absent reads as 1; a damaged revision cannot update; cannot delete; cannot
 * let a stale browser re-share the latest private words; cannot let a stale
 * browser delete the latest row.
 */

/** Every shape of damage a present `revision` can take. */
const DAMAGED_REVISIONS: unknown[] = [
  null,
  0,
  -3,
  1.5,
  '1',
  '3',
  'first',
  {},
  [],
  true,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 2,
]

/** Rewrite a stored row behind the store’s back, the way damage arrives. */
async function rewriteStoredRow(
  objects: ReadingObjects,
  path: string,
  change: (row: Record<string, unknown>) => void,
): Promise<void> {
  const row = JSON.parse((await objects.get(path)) as string) as Record<string, unknown>
  change(row)
  await objects.put(path, `${JSON.stringify(row, null, 2)}\n`)
}

/** The row exactly as it sits in the store, parsed but not validated. */
async function storedRow(
  objects: ReadingObjects,
  path: string,
): Promise<Record<string, unknown>> {
  return JSON.parse((await objects.get(path)) as string) as Record<string, unknown>
}

/* ---------------------------------- 1: absent is legacy, and still edits */

forEachDriver(
  'a row written before revisions existed reads, edits and deletes as revision 1',
  async (objects) => {
    const store = __noteStoreOver(objects)
    const note = await store.addNote(draft())
    const path = notePath(ANNA, BOOK, note.id)

    await rewriteStoredRow(objects, path, (row) => {
      delete row.revision
    })

    // Compatibility: the note is kept, not dropped, and it reads as the first
    // version of itself -- which is what a note edited zero times is.
    assert.equal((await store.getNote(ANNA, BOOK, note.id))?.revision, 1, 'reads as 1')

    // A revision it never held is still refused.
    assert.deepEqual(await store.updateNote(ANNA, BOOK, note.id, { body: 'NO' }, 9), {
      outcome: 'conflict',
    })

    // And 1 is genuinely accepted: this is the legacy row that still works.
    assert.equal(
      acceptedNote(await store.updateNote(ANNA, BOOK, note.id, { body: 'YES' }, 1)).revision,
      2,
    )

    // Deleting one works too, at the revision the edit above wrote.
    await rewriteStoredRow(objects, path, (row) => {
      delete row.revision
    })
    assert.equal((await store.removeNote(ANNA, BOOK, note.id, 1)).outcome, 'removed')
  },
)

/* ------------------------------------- 2: a damaged revision cannot update */

forEachDriver(
  'a present but damaged revision refuses every update and writes nothing',
  async (objects) => {
    for (const damaged of DAMAGED_REVISIONS) {
      const plain = __noteStoreOver(objects)
      const note = await plain.addNote(draft({ body: 'THE STORED WORDS' }))
      const path = notePath(ANNA, BOOK, note.id)
      await rewriteStoredRow(objects, path, (row) => {
        row.revision = damaged
      })
      const before = await objects.get(path)

      const counted = instrumented(objects)
      const store = __noteStoreOver(counted)

      /*
       * Every expectation a caller could plausibly hold, including the one the
       * old normalisation invented (1) and the one the damaged text looks like
       * (3). None of them may be accepted: the row does not know what version
       * it is, so there is no assertion about it that can be true.
       */
      for (const expected of [1, 2, 3, 9]) {
        assert.deepEqual(
          await store.updateNote(ANNA, BOOK, note.id, { body: 'REWRITTEN' }, expected),
          { outcome: 'conflict' },
          `revision ${JSON.stringify(damaged) ?? String(damaged)} at expected ${expected}`,
        )
      }

      assert.equal(await objects.get(path), before, 'the stored bytes changed')
      assert.equal(counted.counts.put, 0)
      assert.equal(counted.counts.putIfMatch, 0)
      assert.equal(counted.counts.del, 0)
      assert.equal(counted.counts.delIfMatch, 0)

      await objects.del(path)
    }
  },
)

/* ------------------------------------- 3: a damaged revision cannot delete */

forEachDriver(
  'a present but damaged revision refuses every delete and removes nothing',
  async (objects) => {
    for (const damaged of DAMAGED_REVISIONS) {
      const plain = __noteStoreOver(objects)
      const note = await plain.addNote(draft({ body: 'STILL HERE AFTERWARDS' }))
      const path = notePath(ANNA, BOOK, note.id)
      await rewriteStoredRow(objects, path, (row) => {
        row.revision = damaged
      })
      const before = await objects.get(path)

      const counted = instrumented(objects)
      const store = __noteStoreOver(counted)

      for (const expected of [1, 2, 3, 9]) {
        assert.deepEqual(
          await store.removeNote(ANNA, BOOK, note.id, expected),
          { outcome: 'conflict' },
          `revision ${JSON.stringify(damaged) ?? String(damaged)} at expected ${expected}`,
        )
      }

      assert.equal(await objects.get(path), before, 'the note was removed or rewritten')
      assert.equal(counted.counts.del, 0)
      assert.equal(counted.counts.delIfMatch, 0)
      assert.equal(counted.counts.put, 0)
      assert.equal(counted.counts.putIfMatch, 0)

      await objects.del(path)
    }
  },
)

/* ------------- 4 and 5: the stale browser, which is the whole finding ----- */

/*
 * The exact scenario the Judge reproduced against the frozen candidate.
 *
 * A note is written, edited twice so it is genuinely at revision 3, and
 * narrowed to `private` -- so its current body is words its author has
 * decided Mike may not read. Only the bookkeeping field is then damaged, into
 * the string "3": the body, the owner, the book and the visibility on disk are
 * all exactly what the author left.
 *
 * A browser that rendered this note long ago still holds revision 1. Against
 * the frozen candidate the damaged field normalised to 1, matched that stale
 * claim, and the edit was accepted: `outcome: updated`, the latest body, and
 * `visibility: 'shared'`. The reviewer's newest private words were published
 * to the author by a request composed against text the browser had never seen.
 */
async function damagedNoteAtRevisionThree(
  objects: ReadingObjects,
): Promise<{ id: string; path: string; body: string }> {
  const plain = __noteStoreOver(objects)
  const note = await plain.addNote(draft({ body: 'FIRST DRAFT', visibility: 'shared' }))
  const path = notePath(ANNA, BOOK, note.id)

  acceptedNote(
    await plain.updateNote(ANNA, BOOK, note.id, { body: 'SECOND DRAFT' }, 1),
  )
  const latest = acceptedNote(
    await plain.updateNote(
      ANNA,
      BOOK,
      note.id,
      { body: 'THE PRIVATE WORDS', visibility: 'private' },
      2,
    ),
  )
  assert.equal(latest.revision, 3, 'the note really is at revision 3')
  assert.equal(latest.visibility, 'private')

  // Only the bookkeeping field is damaged. Everything else is untouched.
  await rewriteStoredRow(objects, path, (row) => {
    row.revision = '3'
  })

  return { id: note.id, path, body: latest.body }
}

forEachDriver(
  'a stale revision-1 browser cannot re-share the latest private body',
  async (objects) => {
    const { id, path, body } = await damagedNoteAtRevisionThree(objects)
    const counted = instrumented(objects)
    const store = __noteStoreOver(counted)

    const outcome = await store.updateNote(
      ANNA,
      BOOK,
      id,
      { visibility: 'shared' },
      1,
    )

    assert.deepEqual(
      outcome,
      { outcome: 'conflict' },
      'a damaged revision must not authorise a stale write',
    )

    const row = await storedRow(objects, path)
    assert.equal(
      row.visibility,
      'private',
      'the newest words were re-shared with the author',
    )
    assert.equal(row.body, body, 'the stored body changed')
    assert.equal(row.revision, '3', 'the damaged field was rewritten by a refused call')
    assert.equal(counted.counts.put + counted.counts.putIfMatch, 0)
  },
)

forEachDriver(
  'a stale revision-1 browser cannot delete the latest row',
  async (objects) => {
    const { id, path, body } = await damagedNoteAtRevisionThree(objects)
    const counted = instrumented(objects)
    const store = __noteStoreOver(counted)

    assert.deepEqual(
      await store.removeNote(ANNA, BOOK, id, 1),
      { outcome: 'conflict' },
      'a damaged revision must not authorise a stale delete',
    )

    const row = await storedRow(objects, path)
    assert.equal(row.body, body, 'a body the browser never rendered was destroyed')
    assert.equal(counted.counts.del + counted.counts.delIfMatch, 0)
  },
)

/* ------------------------------------------------ the three interleavings */

forEachDriver(
  'a retracted note is not resurrected by an edit that was already in flight',
  async (objects) => {
    const plain = __noteStoreOver(objects)
    const note = await plain.addNote(draft({ body: 'WITHDRAWN LATER', visibility: 'shared' }))

    const at = latch()
    const go = latch()
    const store = __noteStoreOver(
      instrumented(objects, { pauseAfterRead: { reached: at.release, go: go.wait } }),
    )

    // The edit reads the note, and stops there.
    const editing = store.updateNote(
      ANNA,
      BOOK,
      note.id,
      { body: 'EDITED BODY', visibility: 'shared' },
      1,
    )
    await at.wait

    // Its owner retracts it while that edit is in flight. Deletion is deletion.
    assert.equal(
      (await plain.removeNote(ANNA, BOOK, note.id, note.revision)).outcome,
      'removed',
    )

    go.release()
    const outcome = await editing

    assert.deepEqual(outcome, { outcome: 'conflict' }, 'and the caller is told, not thanked')
    assert.equal(await plain.getNote(ANNA, BOOK, note.id), null, 'the note stays retracted')
    assert.deepEqual(await completeNotes(plain.listNotes(ANNA, BOOK)), [])
    assert.deepEqual(await completeNotes(plain.listBookNotes(BOOK, 'reviewer')), [])
    assert.equal(
      await objects.get(notePath(ANNA, BOOK, note.id)),
      null,
      'no object was recreated at the path, still shared, holding the retracted words',
    )
  },
)

forEachDriver(
  'a note narrowed to "Only me" is not re-shared by a stale body save',
  async (objects) => {
    const plain = __noteStoreOver(objects)
    const note = await plain.addNote(draft({ body: 'SHARED AT FIRST', visibility: 'shared' }))

    const at = latch()
    const go = latch()
    const store = __noteStoreOver(
      instrumented(objects, { pauseAfterRead: { reached: at.release, go: go.wait } }),
    )

    /*
     * The reader sends body and visibility together on one request, so the
     * stale save carries the visibility it rendered -- `shared` -- and would
     * write it back over the narrowing. This is the widening direction, and it
     * is the one this contract exists to make impossible.
     */
    const editing = store.updateNote(
      ANNA,
      BOOK,
      note.id,
      { body: 'EDITED BODY', visibility: 'shared' },
      1,
    )
    await at.wait

    const narrowed = acceptedNote(
      await plain.updateNote(ANNA, BOOK, note.id, { visibility: 'private' }, 1),
    )
    assert.equal(narrowed.visibility, 'private')

    go.release()
    assert.deepEqual(await editing, { outcome: 'conflict' })

    const after = await plain.getNote(ANNA, BOOK, note.id)
    assert.equal(after?.visibility, 'private', 'the narrowing stands')
    assert.equal(after?.body, 'SHARED AT FIRST', 'and nothing of the stale save landed')
    assert.equal(after?.revision, 2, 'exactly one edit was accepted')
  },
)

forEachDriver('two concurrent edits do not silently discard one of them', async (objects) => {
  const plain = __noteStoreOver(objects)
  const note = await plain.addNote(draft({ body: 'ORIGINAL BODY' }))

  const at = latch()
  const go = latch()
  const store = __noteStoreOver(
    instrumented(objects, { pauseAfterRead: { reached: at.release, go: go.wait } }),
  )

  const first = store.updateNote(ANNA, BOOK, note.id, { body: 'FIRST EDIT' }, 1)
  await at.wait
  const second = acceptedNote(await plain.updateNote(ANNA, BOOK, note.id, { body: 'SECOND EDIT' }, 1))
  go.release()

  const firstOutcome = await first
  assert.deepEqual(firstOutcome, { outcome: 'conflict' })
  assert.equal(second.body, 'SECOND EDIT')

  // One of the two was refused. Neither was told it had succeeded when it had
  // not, which is the actual defect: a lost update nobody is told about.
  assert.equal((await plain.getNote(ANNA, BOOK, note.id))?.body, 'SECOND EDIT')
})

/* ------------------------------------------- both conflicts write nothing */

forEachDriver('a stale revision writes nothing, is not retried, and is not an absence', async (objects) => {
  const plain = __noteStoreOver(objects)
  const note = await plain.addNote(draft({ body: 'ORIGINAL BODY' }))
  acceptedNote(await plain.updateNote(ANNA, BOOK, note.id, { body: 'MOVED ON' }, 1))

  const counting = instrumented(objects)
  const store = __noteStoreOver(counting)
  const before = (await objects.get(notePath(ANNA, BOOK, note.id))) as string

  const outcome = await store.updateNote(ANNA, BOOK, note.id, { body: 'STALE' }, 1)

  assert.deepEqual(outcome, { outcome: 'conflict' }, 'not not-found, and not success')
  assert.equal(counting.counts.putIfMatch, 0, 'the write was never attempted')
  assert.equal(counting.counts.put, 0, 'and no unconditional write exists to fall back on')
  assert.equal(counting.counts.getVersioned, 1, 'one read, and no retry loop')
  assert.equal(
    await objects.get(notePath(ANNA, BOOK, note.id)),
    before,
    'the stored bytes are untouched',
  )
})

forEachDriver(
  'a storage-version conflict writes nothing and is not retried either',
  async (objects) => {
    const plain = __noteStoreOver(objects)
    const note = await plain.addNote(draft({ body: 'ORIGINAL BODY' }))
    const path = notePath(ANNA, BOOK, note.id)

    const at = latch()
    const go = latch()
    const counting = instrumented(objects, {
      pauseAfterRead: { reached: at.release, go: go.wait },
    })
    const store = __noteStoreOver(counting)

    const editing = store.updateNote(ANNA, BOOK, note.id, { body: 'EDITED' }, 1)
    await at.wait

    /*
     * Something rewrites the object *without* moving the revision -- a row put
     * back by hand, a driver that re-serialised. The application token still
     * agrees, so only the storage version can catch this, and it must: the
     * bytes the edit decided against are no longer the bytes on disk.
     */
    const row = JSON.parse((await objects.get(path)) as string) as Record<string, unknown>
    row.body = 'WRITTEN UNDERNEATH'
    await objects.put(path, `${JSON.stringify(row, null, 2)}\n`)
    const interloper = (await objects.get(path)) as string

    go.release()
    const outcome = await editing

    assert.deepEqual(outcome, { outcome: 'conflict' })
    assert.equal(counting.counts.putIfMatch, 1, 'attempted once, refused, and not tried again')
    assert.equal(await objects.get(path), interloper, 'the conditional write landed nothing')
    assert.equal((await plain.getNote(ANNA, BOOK, note.id))?.body, 'WRITTEN UNDERNEATH')
  },
)

forEachDriver('an update after a deletion fails rather than recreating the note', async (objects) => {
  const store = __noteStoreOver(objects)
  const note = await store.addNote(draft({ body: 'GONE NOW', visibility: 'shared' }))
  assert.equal((await store.removeNote(ANNA, BOOK, note.id, note.revision)).outcome, 'removed')

  // Not a conflict here but a plain absence: there is nothing to read at all,
  // which is what "the link stops opening" is built on.
  assert.deepEqual(await store.updateNote(ANNA, BOOK, note.id, { body: 'BACK' }, 1), {
    outcome: 'not-found',
  })
  assert.equal(await objects.get(notePath(ANNA, BOOK, note.id)), null)
  assert.deepEqual(await completeNotes(store.listBookNotes(BOOK, 'reviewer')), [])
})

/*
 * The other direction of the pair, and the one that had no behavioral proof.
 *
 * The suite already stages a **write that races a delete** (the retraction
 * tests above): the edit reads, the delete lands, and the edit's `putIfMatch`
 * finds no such revision. This is a **delete that races a write**: the delete
 * reads at revision 1, an edit lands at revision 2 inside that window, and the
 * removal must find that the object it decided to remove is no longer the
 * object on the store.
 *
 * Deliberately no operation counts here. A count says which method was called,
 * which is a claim about the implementation's shape; what has to be true is
 * that the newer note is still readable and the caller was told its delete did
 * not happen. Those hold whatever the removal is spelled, and they fail for any
 * implementation that removes unconditionally -- which is exactly the
 * discrimination the conditional-delete mutant needs and did not have.
 */
forEachDriver(
  'a delete that races a write removes nothing and the newer note survives',
  async (objects) => {
    const plain = __noteStoreOver(objects)
    const note = await plain.addNote(draft({ body: 'ORIGINAL BODY', visibility: 'shared' }))
    assert.equal(note.revision, 1)

    const at = latch()
    const go = latch()
    const store = __noteStoreOver(
      instrumented(objects, { pauseAfterRead: { reached: at.release, go: go.wait } }),
    )

    // The delete reads the note at revision 1, and stops there.
    const deleting = store.removeNote(ANNA, BOOK, note.id, 1)
    await at.wait

    // A newer edit lands while that delete is in flight. Its author has never
    // seen a retraction, and the words they just wrote are on the store.
    const newer = acceptedNote(
      await plain.updateNote(ANNA, BOOK, note.id, { body: 'NEWER BODY' }, 1),
    )
    assert.equal(newer.revision, 2)

    go.release()
    const outcome = await deleting

    assert.deepEqual(
      outcome,
      { outcome: 'conflict' },
      'the delete reported a removal that must not have happened',
    )

    const survivor = await plain.getNote(ANNA, BOOK, note.id)
    assert.equal(survivor?.revision, 2, 'the newer note did not survive the racing delete')
    assert.equal(survivor?.body, 'NEWER BODY', 'the newer words were lost')
    assert.notEqual(
      await objects.get(notePath(ANNA, BOOK, note.id)),
      null,
      'the object itself was removed underneath the newer write',
    )
    // And it is still the shared note it was, readable exactly where it was.
    assert.deepEqual(
      (await completeNotes(plain.listBookNotes(BOOK, 'reviewer'))).map((row) => row.body),
      ['NEWER BODY'],
    )

    // Re-deleting at the revision that is actually current now succeeds, so the
    // refusal above was about the race and not about deletion having broken.
    assert.equal((await plain.removeNote(ANNA, BOOK, note.id, 2)).outcome, 'removed')
    assert.equal(await objects.get(notePath(ANNA, BOOK, note.id)), null)
  },
)

/* --------------------------------------------- nothing is written blindly */

test('the note store has no unconditional write on any edit path', async () => {
  const harness = fsObjects()
  try {
    const counting = instrumented(harness.objects)
    const store = __noteStoreOver(counting)

    const note = await store.addNote(draft())
    const afterCreate = counting.counts.put

    acceptedNote(await store.updateNote(ANNA, BOOK, note.id, { body: 'A' }, 1))
    acceptedNote(await store.updateNote(ANNA, BOOK, note.id, { visibility: 'shared' }, 2))
    await store.updateNote(ANNA, BOOK, note.id, { body: 'STALE' }, 1)
    // Revision 3 by now: two accepted edits on top of the first write.
    await store.removeNote(ANNA, BOOK, note.id, 3)

    assert.equal(
      counting.counts.put,
      afterCreate,
      'every edit after the first write went through putIfMatch',
    )
    assert.equal(counting.counts.putIfMatch, 2, 'two accepted edits, and the stale one never tried')
    // And the removal is conditional too, so there is no unconditional write
    // *or* removal left on any note path.
    assert.equal(counting.counts.del, 0, 'a note was removed unconditionally')
    assert.equal(counting.counts.delIfMatch, 1, 'the removal did not go through delIfMatch')
  } finally {
    harness.cleanup()
  }
})

test('the configured store is the one these rules were proved against', async () => {
  const harness = fsObjects()
  try {
    // `createNoteStore` is what every route and every page uses. Proving the
    // rules against a hand-built store and shipping a different one would be
    // proving nothing, so the wiring is asserted rather than assumed.
    const store: NoteStore = createNoteStore()
    assert.equal(store.driver, harness.objects.driver)
    const note = await store.addNote(draft())
    assert.equal(note.revision, 1)
    assert.deepEqual(await store.updateNote(ANNA, BOOK, note.id, { body: 'X' }, 4), {
      outcome: 'conflict',
    })
    assert.equal(acceptedNote(await store.updateNote(ANNA, BOOK, note.id, { body: 'X' }, 1)).body, 'X')
  } finally {
    harness.cleanup()
  }
})
