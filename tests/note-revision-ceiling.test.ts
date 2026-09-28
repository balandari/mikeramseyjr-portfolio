import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readNoteRevision } from '../lib/note-contract.ts'
import { __noteStoreOver, __resetNoteStore, notePath } from '../lib/notes-store.ts'
import { createReadingObjects, type ReadingObjects } from '../lib/reviewer-reading.ts'
import type { OwnerRef } from '../lib/reading-access.ts'

/*
 * C2-2: the revision this store *writes* must be one it can read back.
 *
 * The partition, on the stored side and on the produced side:
 *
 *   stored revision                 update at that revision
 *   ---------------------------     -------------------------------------------
 *   MAX_SAFE_INTEGER - 1  (sound)   updated; writes MAX_SAFE_INTEGER (sound)
 *   MAX_SAFE_INTEGER      (sound)   conflict; nothing written; row unchanged
 *   MAX_SAFE_INTEGER + 1  (corrupt) conflict (already proved by F1)
 *
 * The middle row is the one C1 got wrong: it wrote 2^53, which the next read
 * classifies as corrupt. This file proves it at the filesystem and in-memory
 * object layers; `tests/note-revision-blob-seam.test.ts` proves the same at the
 * Blob adapter. No note body is printed by any assertion.
 */

const MAX = Number.MAX_SAFE_INTEGER
const ANNA: OwnerRef = { kind: 'reviewer', id: 'anna' }
const BOOK = 'the-backward-becoming'
const SHA = 'c'.repeat(64)

function row(id: string, revision: number): string {
  return `${JSON.stringify(
    {
      schema: 1,
      id,
      ownerKind: 'reviewer',
      ownerId: 'anna',
      bookSlug: BOOK,
      scope: 'chapter',
      body: 'stored words',
      visibility: 'private',
      status: 'open',
      anchor: {
        scope: 'chapter',
        chapterSlug: 'chapter-one',
        chapterNumber: 1,
        chapterLabel: 'Chapter one',
        manuscriptSha256: SHA,
      },
      revision,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
    },
    null,
    2,
  )}\n`
}

function memoryObjects(): ReadingObjects {
  const store = new Map<string, string>()
  const versions = new Map<string, number>()
  let tick = 0
  return {
    driver: 'memory',
    durable: false,
    async get(path) {
      return store.get(path) ?? null
    },
    async getVersioned(path) {
      if (!store.has(path)) return { body: null, version: null }
      return { body: store.get(path) as string, version: String(versions.get(path)) }
    },
    async putIfMatch(path, body, version) {
      const held = store.has(path) ? String(versions.get(path)) : null
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
    async delIfMatch(path, version) {
      if (!store.has(path) || String(versions.get(path)) !== version) return false
      store.delete(path)
      versions.delete(path)
      return true
    },
    async list(prefix) {
      return Array.from(store.keys()).filter((key) => key.startsWith(prefix))
    },
  }
}

type Counts = { putIfMatch: number; put: number; del: number; delIfMatch: number }

function counted(base: ReadingObjects): ReadingObjects & { counts: Counts } {
  const counts: Counts = { putIfMatch: 0, put: 0, del: 0, delIfMatch: 0 }
  return {
    counts,
    driver: base.driver,
    durable: base.durable,
    get: (path) => base.get(path),
    getVersioned: (path) => base.getVersioned(path),
    list: (prefix) => base.list(prefix),
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
    async delIfMatch(path, version) {
      counts.delIfMatch += 1
      return base.delIfMatch(path, version)
    },
  }
}

function forEachDriver(name: string, body: (objects: ReadingObjects) => Promise<void>): void {
  test(`${name} [fs]`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mrj-note-ceiling-'))
    const saved = {
      driver: process.env.REVIEWER_FEEDBACK_DRIVER,
      readingDir: process.env.REVIEWER_READING_DIR,
    }
    process.env.REVIEWER_FEEDBACK_DRIVER = 'fs'
    process.env.REVIEWER_READING_DIR = dir
    __resetNoteStore()
    try {
      await body(createReadingObjects())
    } finally {
      __resetNoteStore()
      if (saved.driver === undefined) delete process.env.REVIEWER_FEEDBACK_DRIVER
      else process.env.REVIEWER_FEEDBACK_DRIVER = saved.driver
      if (saved.readingDir === undefined) delete process.env.REVIEWER_READING_DIR
      else process.env.REVIEWER_READING_DIR = saved.readingDir
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test(`${name} [object store]`, async () => {
    await body(memoryObjects())
  })
}

test('C2-2 contract: MAX_SAFE_INTEGER is sound, and its successor is not', () => {
  // The two facts the store's guard sits between.
  assert.deepEqual(readNoteRevision(MAX), { state: 'sound', revision: MAX })
  assert.deepEqual(readNoteRevision(MAX + 1), { state: 'corrupt' })
})

forEachDriver('C2-2 an update at MAX_SAFE_INTEGER is a conflict and writes nothing', async (base) => {
  const id = 'ceiling-note'
  const path = notePath(ANNA, BOOK, id)
  await base.put(path, row(id, MAX))
  const before = await base.get(path)

  const objects = counted(base)
  const store = __noteStoreOver(objects)

  for (const changes of [{ body: 'rewritten' }, { visibility: 'shared' as const }, {}]) {
    assert.deepEqual(await store.updateNote(ANNA, BOOK, id, changes, MAX), { outcome: 'conflict' })
  }
  assert.deepEqual(objects.counts, { putIfMatch: 0, put: 0, del: 0, delIfMatch: 0 }, 'a write was attempted')
  assert.equal(await base.get(path), before, 'the stored row changed')

  // The note stays readable, listable and exactly as it was.
  const read = await store.getNote(ANNA, BOOK, id)
  assert.equal(read?.revision, MAX)
  assert.equal(read?.visibility, 'private')
  const listing = await store.listNotes(ANNA, BOOK)
  assert.equal(listing.incomplete, false)
  assert.deepEqual(
    listing.notes.map((note) => note.revision),
    [MAX],
  )
})

forEachDriver('C2-2 an update at MAX_SAFE_INTEGER - 1 stores exactly MAX_SAFE_INTEGER', async (base) => {
  const id = 'penultimate-note'
  const path = notePath(ANNA, BOOK, id)
  await base.put(path, row(id, MAX - 1))

  const objects = counted(base)
  const store = __noteStoreOver(objects)

  const outcome = await store.updateNote(ANNA, BOOK, id, { visibility: 'shared' }, MAX - 1)
  assert.equal(outcome.outcome, 'updated')
  assert.equal(outcome.outcome === 'updated' && outcome.note.revision, MAX)
  assert.equal(objects.counts.putIfMatch, 1, 'exactly one conditional write')

  // What was written reads back as sound.
  const stored = JSON.parse((await base.get(path)) as string) as { revision: unknown }
  assert.equal(stored.revision, MAX)
  assert.deepEqual(readNoteRevision(stored.revision), { state: 'sound', revision: MAX })
  assert.equal((await store.getNote(ANNA, BOOK, id))?.revision, MAX)
  const listing = await store.listNotes(ANNA, BOOK)
  assert.equal(listing.incomplete, false)
  assert.equal(listing.notes.length, 1)

  // And the application's own successor is now the ceiling: the next edit is
  // refused with nothing written.
  const afterFirst = await base.get(path)
  assert.deepEqual(await store.updateNote(ANNA, BOOK, id, { body: 'again' }, MAX), {
    outcome: 'conflict',
  })
  assert.equal(objects.counts.putIfMatch, 1, 'the ceiling edit reached the store')
  assert.equal(await base.get(path), afterFirst)
})

forEachDriver('C2-2 stale, missing and deletion semantics are unchanged at the ceiling', async (base) => {
  const id = 'ceiling-note'
  const path = notePath(ANNA, BOOK, id)
  await base.put(path, row(id, MAX))
  const objects = counted(base)
  const store = __noteStoreOver(objects)

  // Stale: a browser holding an older revision is a conflict, as always.
  assert.deepEqual(await store.updateNote(ANNA, BOOK, id, { body: 'x' }, MAX - 1), {
    outcome: 'conflict',
  })
  // Missing: a note that is not there is not-found, not conflict.
  assert.deepEqual(await store.updateNote(ANNA, BOOK, 'no-such-note', { body: 'x' }, MAX), {
    outcome: 'not-found',
  })
  assert.equal(objects.counts.putIfMatch + objects.counts.put, 0)

  // Deletion: a stale delete removes nothing; the current one removes it once.
  assert.deepEqual(await store.removeNote(ANNA, BOOK, id, MAX - 1), { outcome: 'conflict' })
  assert.ok(await base.get(path))
  const removed = await store.removeNote(ANNA, BOOK, id, MAX)
  assert.equal(removed.outcome, 'removed')
  assert.equal(await base.get(path), null)
  // The stale delete is refused on the revision before any conditional removal.
  assert.equal(objects.counts.delIfMatch, 1)
  assert.equal(objects.counts.del, 0)
})
