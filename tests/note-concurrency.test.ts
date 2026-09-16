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
} from '../lib/notes-store.ts'
import { createReadingObjects, type ReadingObjects } from '../lib/reviewer-reading.ts'
import type { OwnerRef } from '../lib/reading-access.ts'
import type { NoteAnchor } from '../lib/note-contract.ts'

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

type Counts = { getVersioned: number; putIfMatch: number; put: number; del: number }

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
  const counts: Counts = { getVersioned: 0, putIfMatch: 0, put: 0, del: 0 }
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

forEachDriver('a row written before revisions existed reads and edits as revision 1', async (objects) => {
  const store = __noteStoreOver(objects)
  const note = await store.addNote(draft())
  const path = notePath(ANNA, BOOK, note.id)

  for (const damaged of [undefined, null, 0, -3, 1.5, '7', 'first', {}, Number.NaN]) {
    const row = JSON.parse((await objects.get(path)) as string) as Record<string, unknown>
    if (damaged === undefined) delete row.revision
    else row.revision = damaged
    await objects.put(path, `${JSON.stringify(row, null, 2)}\n`)

    // Compatibility: the note is kept, not dropped, and it reads as the first
    // version of itself -- which is what a note edited zero times is.
    assert.equal((await store.getNote(ANNA, BOOK, note.id))?.revision, 1, String(damaged))

    // And the damage never waves an edit through: it is 1 that is accepted,
    // and the value that was on disk that is not.
    assert.deepEqual(
      await store.updateNote(ANNA, BOOK, note.id, { body: 'NO' }, 9),
      { outcome: 'conflict' },
      String(damaged),
    )
    assert.equal(
      acceptedNote(await store.updateNote(ANNA, BOOK, note.id, { body: 'YES' }, 1)).revision,
      2,
      String(damaged),
    )
  }
})

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
    assert.equal(await plain.removeNote(ANNA, BOOK, note.id), true)

    go.release()
    const outcome = await editing

    assert.deepEqual(outcome, { outcome: 'conflict' }, 'and the caller is told, not thanked')
    assert.equal(await plain.getNote(ANNA, BOOK, note.id), null, 'the note stays retracted')
    assert.deepEqual(await plain.listNotes(ANNA, BOOK), [])
    assert.deepEqual(await plain.listBookNotes(BOOK, 'reviewer'), [])
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
  assert.equal(await store.removeNote(ANNA, BOOK, note.id), true)

  // Not a conflict here but a plain absence: there is nothing to read at all,
  // which is what "the link stops opening" is built on.
  assert.deepEqual(await store.updateNote(ANNA, BOOK, note.id, { body: 'BACK' }, 1), {
    outcome: 'not-found',
  })
  assert.equal(await objects.get(notePath(ANNA, BOOK, note.id)), null)
  assert.deepEqual(await store.listBookNotes(BOOK, 'reviewer'), [])
})

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
    await store.removeNote(ANNA, BOOK, note.id)

    assert.equal(
      counting.counts.put,
      afterCreate,
      'every edit after the first write went through putIfMatch',
    )
    assert.equal(counting.counts.putIfMatch, 2, 'two accepted edits, and the stale one never tried')
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
