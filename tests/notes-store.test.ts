import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/*
 * The note store, exercised through both drivers.
 *
 * Every behavioural test below runs twice: once against a real directory on
 * disk, and once against an in-memory object layer standing in for the blob
 * store. The rules live in the store rather than in a driver, so a rule proved
 * against one and not the other is not a rule -- and the recursive listing the
 * author's roster-independent read depends on is exactly the primitive where
 * the two drivers could silently disagree.
 */

import {
  NOTES_ROOT,
  __noteStoreOver,
  __resetNoteStore,
  asNote,
  bookNotesPrefix,
  createNoteStore,
  notePath,
  ownerNotesPrefix,
  type Note,
  type NoteDraft,
  type NoteStore,
  type NoteUpdateOutcome,
} from '../lib/notes-store.ts'
import type { ReadingObjects } from '../lib/reviewer-reading.ts'
import type { OwnerRef } from '../lib/reading-access.ts'
import type { NoteAnchor } from '../lib/note-contract.ts'

const ANNA: OwnerRef = { kind: 'reviewer', id: 'anna' }
const BEN: OwnerRef = { kind: 'reviewer', id: 'ben' }
const MIKE: OwnerRef = { kind: 'author', id: 'aa11bb22cc33dd44ee55ff66' }
const BOOK = 'the-backward-becoming'
const SHA = 'c'.repeat(64)

/* --------------------------------------------------------- in-memory driver */

function memoryObjects(): ReadingObjects & { store: Map<string, string> } {
  const store = new Map<string, string>()
  const versions = new Map<string, number>()
  let tick = 0

  return {
    driver: 'memory',
    durable: false,
    store,
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
    // Prefix match with no delimiter, which is what the blob service does.
    async list(prefix) {
      return Array.from(store.keys()).filter((key) => key.startsWith(prefix))
    },
  }
}

function fsStore(): { store: NoteStore; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'mrj-notes-'))
  const saved = {
    driver: process.env.REVIEWER_FEEDBACK_DRIVER,
    readingDir: process.env.REVIEWER_READING_DIR,
  }
  process.env.REVIEWER_FEEDBACK_DRIVER = 'fs'
  process.env.REVIEWER_READING_DIR = dir
  __resetNoteStore()

  return {
    store: createNoteStore(),
    dir,
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

/** The note from an update that was expected to be accepted, or a clear failure. */
async function updated(outcome: Promise<NoteUpdateOutcome>): Promise<Note> {
  const settled = await outcome
  assert.equal(settled.outcome, 'updated', 'this update was expected to be accepted')
  return (settled as { outcome: 'updated'; note: Note }).note
}

function forEachDriver(name: string, body: (store: NoteStore) => Promise<void>): void {
  test(`${name} [fs]`, async () => {
    const harness = fsStore()
    try {
      await body(harness.store)
    } finally {
      harness.cleanup()
    }
  })

  test(`${name} [object store]`, async () => {
    await body(__noteStoreOver(memoryObjects()))
  })
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

function draft(owner: OwnerRef, overrides: Partial<NoteDraft> = {}): NoteDraft {
  return {
    ownerKind: owner.kind,
    ownerId: owner.id,
    bookSlug: BOOK,
    scope: 'passage',
    body: 'Something worth saying.',
    visibility: 'private',
    status: 'open',
    anchor: passageAnchor(),
    ...overrides,
  }
}

/* ------------------------------------------------------------------- paths */

test('every note path begins at the book, then the owner', () => {
  assert.equal(bookNotesPrefix(BOOK, 'reviewer'), `${NOTES_ROOT}/${BOOK}/reviewer/`)
  assert.equal(ownerNotesPrefix(ANNA, BOOK), `${NOTES_ROOT}/${BOOK}/reviewer/anna/`)
  assert.equal(
    notePath(MIKE, BOOK, 'abc-123'),
    `${NOTES_ROOT}/${BOOK}/author/${MIKE.id}/abc-123.json`,
  )
})

test('a prefix always ends in a slash, so one owner cannot reach another by name', () => {
  // `anna` must not be able to list `annabel`'s notes by sharing four letters.
  assert.ok(ownerNotesPrefix(ANNA, BOOK).endsWith('/'))
  assert.ok(!ownerNotesPrefix({ kind: 'reviewer', id: 'annabel' }, BOOK).startsWith(
    ownerNotesPrefix(ANNA, BOOK),
  ))
})

test('a path refuses to be built from anything that is not a safe segment', () => {
  for (const id of ['../escape', 'Anna', '', 'a/b', 'a'.repeat(65)]) {
    assert.throws(() => ownerNotesPrefix({ kind: 'reviewer', id }, BOOK), /note storage/)
  }
  for (const slug of ['../escape', 'Book', '', 'a/b']) {
    assert.throws(() => bookNotesPrefix(slug, 'reviewer'), /note storage/)
  }
  for (const id of ['../escape', 'A-B', 'a/b']) {
    assert.throws(() => notePath(ANNA, BOOK, id), /note storage/)
  }
})

/* --------------------------------------------------------------- lifecycle */

forEachDriver('a note is written once and read back whole', async (store) => {
  const note = await store.addNote(draft(ANNA, { body: 'The tide is doing the work here.' }))

  assert.equal(note.schema, 1)
  assert.equal(note.ownerKind, 'reviewer')
  assert.equal(note.ownerId, 'anna')
  assert.equal(note.visibility, 'private')
  assert.equal(note.status, 'open')
  assert.equal(note.createdAt, note.updatedAt)

  const read = await store.getNote(ANNA, BOOK, note.id)
  assert.deepEqual(read, note)
})

forEachDriver('editing preserves the creation time and moves the update time', async (store) => {
  const note = await store.addNote(draft(ANNA))

  assert.equal(note.revision, 1, 'a new note is the first version of itself')

  // A visible gap, so the two timestamps cannot be equal by accident.
  await new Promise((resolve) => setTimeout(resolve, 5))
  const outcome = await store.updateNote(ANNA, BOOK, note.id, { body: 'Reworded.' }, 1)

  assert.equal(outcome.outcome, 'updated')
  const edited = (outcome as { outcome: 'updated'; note: Note }).note
  assert.equal(edited.createdAt, note.createdAt, 'when it was written does not change')
  assert.notEqual(edited.updatedAt, note.updatedAt, 'when it was revised does')
  assert.ok(Date.parse(edited.updatedAt) > Date.parse(edited.createdAt))
  assert.equal(edited.body, 'Reworded.')
  assert.equal(edited.revision, 2, 'and an accepted edit moves the revision by one')
  // The anchor is written once. Nothing about an edit may move it.
  assert.deepEqual(edited.anchor, note.anchor)
})

forEachDriver('a visibility change takes effect and is readable back', async (store) => {
  const note = await store.addNote(draft(ANNA, { visibility: 'private' }))
  const shared = await updated(store.updateNote(ANNA, BOOK, note.id, { visibility: 'shared' }, 1))
  assert.equal(shared.visibility, 'shared')
  assert.equal((await store.getNote(ANNA, BOOK, note.id))?.visibility, 'shared')

  const back = await updated(store.updateNote(ANNA, BOOK, note.id, { visibility: 'private' }, 2))
  assert.equal(back.visibility, 'private')
  assert.equal((await store.getNote(ANNA, BOOK, note.id))?.visibility, 'private')
})

forEachDriver("an author's note is private however it is written or edited", async (store) => {
  // Even asked for directly, and even asked for on an edit.
  const note = await store.addNote(draft(MIKE, { visibility: 'shared' }))
  assert.equal(note.visibility, 'private')

  const edited = await updated(store.updateNote(MIKE, BOOK, note.id, { visibility: 'shared' }, 1))
  assert.equal(edited.visibility, 'private')
  assert.equal((await store.getNote(MIKE, BOOK, note.id))?.visibility, 'private')
})

forEachDriver("an author's note carries an open/resolved status", async (store) => {
  const note = await store.addNote(draft(MIKE))
  assert.equal(note.status, 'open')

  const resolved = await updated(store.updateNote(MIKE, BOOK, note.id, { status: 'resolved' }, 1))
  assert.equal(resolved.status, 'resolved')

  const reopened = await updated(store.updateNote(MIKE, BOOK, note.id, { status: 'open' }, 2))
  assert.equal(reopened.status, 'open')
})

/* --------------------------------------------------------------- isolation */

forEachDriver("one reviewer's listing never reaches another's notes", async (store) => {
  const mine = await store.addNote(draft(ANNA, { body: 'Mine.' }))
  await store.addNote(draft(BEN, { body: "Ben's." }))

  const listed = await store.listNotes(ANNA, BOOK)
  assert.equal(listed.length, 1)
  assert.equal(listed[0].id, mine.id)
})

forEachDriver('a guessed identifier reaches nothing of anybody else’s', async (store) => {
  const bens = await store.addNote(draft(BEN))

  assert.equal(await store.getNote(ANNA, BOOK, bens.id), null)
  assert.equal(await store.removeNote(ANNA, BOOK, bens.id), false)
  assert.deepEqual(await store.updateNote(ANNA, BOOK, bens.id, { body: 'not yours' }, 1), {
    outcome: 'not-found',
  })

  // And Ben's note is untouched by any of it.
  assert.equal((await store.getNote(BEN, BOOK, bens.id))?.body, draft(BEN).body)
})

forEachDriver("the author's notes are invisible to a reviewer listing", async (store) => {
  await store.addNote(draft(MIKE, { body: "Mike's own." }))
  assert.deepEqual(await store.listNotes(ANNA, BOOK), [])
  assert.deepEqual(await store.listBookNotes(BOOK, 'reviewer'), [])

  const his = await store.listBookNotes(BOOK, 'author')
  assert.equal(his.length, 1)
})

/* ----------------------------------------- the roster-independent listing */

forEachDriver(
  'every reviewer note on a book is listable without naming a single reviewer',
  async (store) => {
    await store.addNote(draft(ANNA, { body: 'Anna shared.', visibility: 'shared' }))
    await store.addNote(draft(BEN, { body: 'Ben shared.', visibility: 'shared' }))
    await store.addNote(draft(BEN, { body: 'Ben kept.', visibility: 'private' }))
    await store.addNote(draft(MIKE, { body: "Mike's own." }))

    /*
     * The listing that makes a shared note outlive the roster. It is built from
     * the book alone -- no reviewer id appears in the prefix -- so a reviewer
     * who has been revoked, removed, or had this book withdrawn is still here.
     */
    const rows = await store.listBookNotes(BOOK, 'reviewer')
    assert.equal(rows.length, 3, "and Mike's own note is not among them")
    assert.deepEqual(
      rows.map((row) => row.ownerId).sort(),
      ['anna', 'ben', 'ben'],
    )
    // It returns rows and decides nothing; filtering is the caller's, and is
    // proved at the service and route level.
    assert.equal(rows.filter((row) => row.visibility === 'private').length, 1)
  },
)

forEachDriver('notes are returned in reading order, book note first', async (store) => {
  await store.addNote(
    draft(ANNA, {
      scope: 'passage',
      anchor: { ...passageAnchor(), chapterNumber: 2, paragraphOrdinal: 7 },
      body: 'second chapter',
    }),
  )
  await store.addNote(
    draft(ANNA, { scope: 'book', anchor: { scope: 'book' }, body: 'whole book' }),
  )
  await store.addNote(
    draft(ANNA, {
      scope: 'chapter',
      anchor: {
        scope: 'chapter',
        chapterSlug: 'chapter-one',
        chapterNumber: 1,
        chapterLabel: 'Chapter one',
        manuscriptSha256: SHA,
      },
      body: 'first chapter, whole',
    }),
  )
  await store.addNote(draft(ANNA, { body: 'first chapter, paragraph four' }))

  assert.deepEqual(
    (await store.listNotes(ANNA, BOOK)).map((note) => note.body),
    ['whole book', 'first chapter, whole', 'first chapter, paragraph four', 'second chapter'],
  )
})

/* ------------------------------------------------------------------ delete */

forEachDriver('a deleted note leaves nothing of its body behind', async (store) => {
  const note = await store.addNote(draft(ANNA, { body: 'Withdrawn later.', visibility: 'shared' }))
  assert.equal(await store.removeNote(ANNA, BOOK, note.id), true)

  assert.equal(await store.getNote(ANNA, BOOK, note.id), null)
  assert.deepEqual(await store.listNotes(ANNA, BOOK), [])
  // Not to its owner, not to the author's cross-reviewer listing, not anywhere.
  assert.deepEqual(await store.listBookNotes(BOOK, 'reviewer'), [])
  assert.equal(await store.removeNote(ANNA, BOOK, note.id), false)
})

test('a deleted note leaves no object on disk that still holds its words', async () => {
  const harness = fsStore()
  try {
    const note = await harness.store.addNote(draft(ANNA, { body: 'Please forget this.' }))
    await harness.store.removeNote(ANNA, BOOK, note.id)

    const { readdirSync, existsSync } = await import('node:fs')
    const walk = (dir: string): string[] => {
      if (!existsSync(dir)) return []
      const out: string[] = []
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) out.push(...walk(full))
        else out.push(full)
      }
      return out
    }

    for (const file of walk(harness.dir)) {
      assert.ok(
        !readFileSync(file, 'utf8').includes('Please forget this.'),
        `the retracted body survived at ${file}`,
      )
    }
  } finally {
    harness.cleanup()
  }
})

/* -------------------------------------------------------------- validation */

test('a stored row with a damaged visibility is kept, and fails private', () => {
  const base: Note = {
    schema: 1,
    id: 'abc-123',
    ownerKind: 'reviewer',
    ownerId: 'anna',
    bookSlug: BOOK,
    scope: 'passage',
    body: 'Still worth reading.',
    visibility: 'shared',
    status: 'open',
    anchor: passageAnchor(),
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }

  for (const damaged of [undefined, null, '', 'author', 'link', 'public', 7]) {
    const row = asNote({ ...base, visibility: damaged })
    assert.ok(row, 'losing what somebody wrote would be the worse failure')
    assert.equal(row.visibility, 'private', 'but damage never widens who can read it')
  }

  assert.equal(asNote({ ...base, visibility: 'shared' })?.visibility, 'shared')
})

test('an author row is private on read whatever its stored visibility says', () => {
  const row = asNote({
    schema: 1,
    id: 'abc-123',
    ownerKind: 'author',
    ownerId: MIKE.id,
    bookSlug: BOOK,
    scope: 'book',
    body: 'Mine.',
    visibility: 'shared',
    status: 'open',
    anchor: { scope: 'book' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  })
  assert.equal(row?.visibility, 'private')
})

test('an object that is not a note of this schema is skipped, not repaired', () => {
  const base = {
    schema: 1,
    id: 'abc-123',
    ownerKind: 'reviewer',
    ownerId: 'anna',
    bookSlug: BOOK,
    scope: 'passage',
    body: 'text',
    visibility: 'private',
    status: 'open',
    anchor: passageAnchor(),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }

  const bad: unknown[] = [
    null,
    'a note',
    [],
    { ...base, schema: 2 },
    { ...base, id: 'NOT/A/PATH' },
    { ...base, ownerKind: 'stranger' },
    { ...base, ownerId: '../escape' },
    { ...base, bookSlug: '../escape' },
    { ...base, scope: 'sentence' },
    { ...base, body: '' },
    { ...base, anchor: null },
    { ...base, createdAt: 'whenever' },
    { ...base, updatedAt: 'whenever' },
    // The row and its anchor disagree about what the note is about.
    { ...base, scope: 'chapter' },
  ]

  for (const value of bad) assert.equal(asNote(value), null, JSON.stringify(value) ?? 'null')
})

/* --------------------------------------------------------- driver agreement */

test('both drivers list a prefix that spans a level the same way', async () => {
  const harness = fsStore()
  try {
    const memory = __noteStoreOver(memoryObjects())
    for (const store of [harness.store, memory]) {
      await store.addNote(draft(ANNA, { visibility: 'shared' }))
      await store.addNote(draft(BEN, { visibility: 'shared' }))
      const rows = await store.listBookNotes(BOOK, 'reviewer')
      assert.equal(rows.length, 2, `${store.driver} did not see across owners`)
    }
  } finally {
    harness.cleanup()
  }
})
