import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/*
 * F1 at the seam this product actually deploys on.
 *
 * `tests/note-concurrency.test.ts` proves the damaged-revision contract against
 * the in-memory and filesystem object layers. Those are the two seams a laptop
 * has. The one that runs in production is `lib/reviewer-reading-blob.ts`, and a
 * conditional write is exactly the primitive where a filesystem and an object
 * store could silently disagree -- so the proof is owed here too, and the
 * acceptance condition is the strongest form of it:
 *
 *     a damaged revision reaches the provider as **no request at all**.
 *
 * Not "a request that is refused", and not "a request whose refusal is mapped
 * to conflict". No `put`, no `del`. The refusal happens in `NoteStore` before
 * the object layer is asked for anything, and this file asserts that by
 * counting the verbs the SDK receives.
 *
 * ## How it runs without a network
 *
 * The pattern is `tests/blob-refusal-mapping.test.ts`'s, unchanged: a
 * resolve-only hook points `@vercel/blob` at a module that re-exports the real
 * SDK's error classes by file URL and forwards the four verbs to an object this
 * file controls (`__readingBlob`, named apart from the private-store double in
 * `tests/blob-refusal-mapping.test.ts` so the two never collide). The adapter
 * under test is therefore the real one -- the same
 * `get`, `getVersioned`, `putIfMatch` and `delIfMatch` a deployment runs -- and
 * no request is made, no credential exists, and nothing is stored anywhere.
 */

const REAL_SDK = pathToFileURL(
  join(process.cwd(), 'node_modules', '@vercel', 'blob', 'dist', 'index.js'),
).href

type Verbs = { put: number; del: number; get: number; list: number }

type BlobDouble = {
  put(pathname: string, body: string, options: Record<string, unknown>): Promise<unknown>
  get(
    pathname: string,
    options: Record<string, unknown>,
  ): Promise<{ stream: string; blob: { etag: string } } | null>
  del(pathname: string, options: Record<string, unknown>): Promise<unknown>
  list(options: Record<string, unknown>): Promise<{
    blobs: { pathname: string }[]
    hasMore: boolean
    cursor?: string
  }>
}

declare global {
  // eslint-disable-next-line no-var
  var __readingBlob: BlobDouble | undefined
}

const inlineModule = (source: string) =>
  `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`

const BLOB_DOUBLE_URL = inlineModule(`
import * as real from ${JSON.stringify(REAL_SDK)}

export const {
  BlobError,
  BlobNotFoundError,
  BlobPreconditionFailedError,
  BlobStoreNotFoundError,
  BlobServiceNotAvailable,
  BlobServiceRateLimited,
  BlobUnknownError,
  BlobAccessError,
  BlobRequestAbortedError,
} = real

export const put = (...args) => globalThis.__readingBlob.put(...args)
export const get = (...args) => globalThis.__readingBlob.get(...args)
export const del = (...args) => globalThis.__readingBlob.del(...args)
export const list = (...args) => globalThis.__readingBlob.list(...args)
`)

register(
  inlineModule(`export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@vercel/blob') {
    return { url: ${JSON.stringify(BLOB_DOUBLE_URL)}, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}`),
)

// Never sent anywhere: the double below receives every call.
const FAKE_TOKEN = 'blob-token-for-tests-only-not-a-real-one'

const ANNA = { kind: 'reviewer' as const, id: 'anna' }
const BOOK = 'the-backward-becoming'
const SHA = 'c'.repeat(64)
const BODY = 'THE PRIVATE WORDS'

/**
 * A store holding exactly one object, and a tally of what the provider was asked.
 *
 * `etag` moves on every accepted write, which is what makes the conditional
 * primitives behave as they do against the live service.
 */
function oneObjectStore(pathname: string, body: string) {
  const objects = new Map<string, { body: string; etag: string }>()
  objects.set(pathname, { body, etag: '"v1"' })
  const verbs: Verbs = { put: 0, del: 0, get: 0, list: 0 }
  let tick = 1

  const double: BlobDouble = {
    async put(path, next) {
      verbs.put += 1
      tick += 1
      objects.set(path, { body: next, etag: `"v${tick}"` })
      return {}
    },
    async get(path) {
      verbs.get += 1
      const held = objects.get(path)
      if (!held) return null
      return { stream: held.body, blob: { etag: held.etag } }
    },
    async del(path) {
      verbs.del += 1
      objects.delete(path)
      return {}
    },
    async list() {
      verbs.list += 1
      return {
        blobs: Array.from(objects.keys()).map((key) => ({ pathname: key })),
        hasMore: false,
      }
    },
  }

  return { objects, verbs, double }
}

/** The stored note row, with `revision` set to whatever is handed in. */
function rowWithRevision(id: string, revision: unknown): string {
  const row: Record<string, unknown> = {
    schema: 1,
    id,
    ownerKind: 'reviewer',
    ownerId: 'anna',
    bookSlug: BOOK,
    scope: 'chapter',
    body: BODY,
    visibility: 'private',
    status: 'open',
    anchor: {
      scope: 'chapter',
      chapterSlug: 'chapter-one',
      chapterNumber: 1,
      chapterLabel: 'Chapter one',
      manuscriptSha256: SHA,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
  }
  if (revision !== undefined) row.revision = revision
  return `${JSON.stringify(row, null, 2)}\n`
}

async function storeOver(objects: unknown) {
  const notes = (await import('../lib/notes-store.ts')) as typeof import('../lib/notes-store.ts')
  return notes.__noteStoreOver(objects as never)
}

async function blobObjects() {
  const blob = (await import(
    '../lib/reviewer-reading-blob.ts'
  )) as typeof import('../lib/reviewer-reading-blob.ts')
  return blob.createVercelBlobReadingObjects({ token: FAKE_TOKEN })
}

async function pathFor(id: string): Promise<string> {
  const notes = (await import('../lib/notes-store.ts')) as typeof import('../lib/notes-store.ts')
  return notes.notePath(ANNA, BOOK, id)
}

/* ------------------------------------------------------------------ the proof */

test('the Blob seam sends no write for an update against a damaged revision', async () => {
  const id = 'damaged-note-one'
  const path = await pathFor(id)

  for (const damaged of [null, 0, -3, 1.5, '1', '3', 'first', {}, [], true, Number.NaN]) {
    const harness = oneObjectStore(path, rowWithRevision(id, damaged))
    globalThis.__readingBlob = harness.double
    const store = await storeOver(await blobObjects())

    for (const expected of [1, 3, 9]) {
      assert.deepEqual(
        await store.updateNote(ANNA, BOOK, id, { visibility: 'shared', body: 'REWRITTEN' }, expected),
        { outcome: 'conflict' },
        `revision ${JSON.stringify(damaged) ?? String(damaged)} at expected ${expected}`,
      )
    }

    assert.equal(
      harness.verbs.put,
      0,
      `a write reached the provider for revision ${JSON.stringify(damaged) ?? String(damaged)}`,
    )
    assert.equal(harness.verbs.del, 0, 'a delete reached the provider')
    assert.equal(
      harness.objects.get(path)?.body,
      rowWithRevision(id, damaged),
      'the stored object changed',
    )
  }
})

test('the Blob seam sends no delete for a removal against a damaged revision', async () => {
  const id = 'damaged-note-two'
  const path = await pathFor(id)

  for (const damaged of [null, 0, 1.5, '3', 'first', {}, Number.POSITIVE_INFINITY]) {
    const harness = oneObjectStore(path, rowWithRevision(id, damaged))
    globalThis.__readingBlob = harness.double
    const store = await storeOver(await blobObjects())

    for (const expected of [1, 3, 9]) {
      assert.deepEqual(
        await store.removeNote(ANNA, BOOK, id, expected),
        { outcome: 'conflict' },
        `revision ${JSON.stringify(damaged) ?? String(damaged)} at expected ${expected}`,
      )
    }

    assert.equal(
      harness.verbs.del,
      0,
      `a delete reached the provider for revision ${JSON.stringify(damaged) ?? String(damaged)}`,
    )
    assert.equal(harness.verbs.put, 0, 'a write reached the provider')
    assert.ok(harness.objects.has(path), 'the note was removed')
  }
})

test('the Blob seam still writes for a sound revision, and for a legacy row', async () => {
  /*
   * The positive control, and it is not optional: every assertion above is that
   * a request did **not** happen, and an adapter that had stopped working at all
   * would satisfy every one of them. Two rows must still go through -- a row at
   * a sound revision 3, and a row from before the field existed, which is the
   * legacy compatibility F1 is required to preserve.
   */
  for (const [label, stored, expected] of [
    ['a sound revision', rowWithRevision('sound-note', 3), 3],
    ['a legacy row', rowWithRevision('sound-note', undefined), 1],
  ] as const) {
    const path = await pathFor('sound-note')
    const harness = oneObjectStore(path, stored)
    globalThis.__readingBlob = harness.double
    const store = await storeOver(await blobObjects())

    const outcome = await store.updateNote(
      ANNA,
      BOOK,
      'sound-note',
      { visibility: 'shared' },
      expected,
    )
    assert.equal(outcome.outcome, 'updated', `${label} was refused`)
    assert.equal(harness.verbs.put, 1, `${label} did not reach the provider`)
    assert.equal(
      outcome.outcome === 'updated' && outcome.note.revision,
      expected + 1,
      `${label} did not move the revision by one`,
    )
  }
})

test('the Blob seam reports a damaged row as a gap when it is listed', async () => {
  /*
   * The same damage seen from the reading side (F3): a row whose revision
   * cannot be read is not a note this can hand out, and the listing says so
   * rather than quietly returning one fewer.
   */
  const id = 'damaged-note-three'
  const path = await pathFor(id)
  const harness = oneObjectStore(path, rowWithRevision(id, '3'))
  globalThis.__readingBlob = harness.double
  const store = await storeOver(await blobObjects())

  const listing = await store.listNotes(ANNA, BOOK)
  assert.deepEqual(listing.notes, [], 'a row with an unreadable revision was handed out')
  assert.equal(listing.incomplete, true, 'and the gap was not disclosed')
  assert.equal(harness.verbs.put, 0)
  assert.equal(harness.verbs.del, 0)
})

/* ------------------------------------------- C2-2: the revision ceiling */

test('C2-2 the Blob seam sends no write for an update at MAX_SAFE_INTEGER', async () => {
  /*
   * The produced side of the revision boundary. MAX_SAFE_INTEGER is a sound
   * stored revision, and an update from it would have to write 2^53 -- which
   * reads back as corrupt. The refusal is `conflict`, and the provider is asked
   * for nothing.
   */
  const id = 'ceiling-note'
  const path = await pathFor(id)
  const stored = rowWithRevision(id, Number.MAX_SAFE_INTEGER)
  const harness = oneObjectStore(path, stored)
  globalThis.__readingBlob = harness.double
  const store = await storeOver(await blobObjects())

  for (const changes of [{ body: 'REWRITTEN' }, { visibility: 'shared' as const }]) {
    assert.deepEqual(
      await store.updateNote(ANNA, BOOK, id, changes, Number.MAX_SAFE_INTEGER),
      { outcome: 'conflict' },
    )
  }
  assert.equal(harness.verbs.put, 0, 'a write reached the provider at the ceiling')
  assert.equal(harness.verbs.del, 0, 'a delete reached the provider')
  assert.equal(harness.objects.get(path)?.body, stored, 'the stored object changed')

  const read = await store.getNote(ANNA, BOOK, id)
  assert.equal(read?.revision, Number.MAX_SAFE_INTEGER, 'the note stopped reading')
  const listing = await store.listNotes(ANNA, BOOK)
  assert.equal(listing.incomplete, false)
  assert.equal(listing.notes.length, 1)
})

test('C2-2 the Blob seam writes exactly MAX_SAFE_INTEGER from one below it', async () => {
  const id = 'penultimate-note'
  const path = await pathFor(id)
  const harness = oneObjectStore(path, rowWithRevision(id, Number.MAX_SAFE_INTEGER - 1))
  globalThis.__readingBlob = harness.double
  const store = await storeOver(await blobObjects())

  const outcome = await store.updateNote(
    ANNA,
    BOOK,
    id,
    { visibility: 'shared' },
    Number.MAX_SAFE_INTEGER - 1,
  )
  assert.equal(outcome.outcome, 'updated')
  assert.equal(harness.verbs.put, 1, 'the one legitimate write did not reach the provider')
  const written = JSON.parse(harness.objects.get(path)?.body ?? 'null') as { revision: unknown }
  assert.equal(written.revision, Number.MAX_SAFE_INTEGER)
  assert.equal((await store.getNote(ANNA, BOOK, id))?.revision, Number.MAX_SAFE_INTEGER)

  // And the value this code just produced is now the ceiling.
  assert.deepEqual(
    await store.updateNote(ANNA, BOOK, id, { body: 'AGAIN' }, Number.MAX_SAFE_INTEGER),
    { outcome: 'conflict' },
  )
  assert.equal(harness.verbs.put, 1, 'a second write reached the provider at the ceiling')
})
