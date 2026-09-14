import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  __readingStoreOver,
  __resetReadingStore,
  asPosition,
  createReadingStore,
  positionPath,
  type ReadingObjects,
  type ReadingPosition,
  type ReadingStore,
} from '../lib/reviewer-reading.ts'
import { MAX_TRACKED_DEVICES, highWaterFor } from '../lib/reading-order.ts'
import type { OwnerRef } from '../lib/reading-access.ts'

/*
 * Ordering in the durable store, which is where it has to be right.
 *
 * The defect these exist for is not hypothetical and is not a race this test
 * has to win a coin toss to reproduce: the store used to write a position
 * unconditionally, so a request delayed on a phone's connection overwrote the
 * newer one that had overtaken it, and the reviewer was handed back a place
 * they had already read past. Every case below is driven in an exact order and
 * decided by arithmetic -- there is no sleep anywhere in this file, and no test
 * here depends on which of two things happens first by chance.
 *
 * Both drivers are exercised: a real directory on disk through the `fs` driver,
 * and an in-memory object layer standing in for the blob store. The rules live
 * in the store, not in a driver, and this is what makes that claim real.
 */

const ANNA: OwnerRef = { kind: 'reviewer', id: 'anna' }
const BOOK = 'the-backward-becoming'

/** Two devices. Random-looking, because that is what the browser mints. */
const PHONE = 'a1b2c3d4e5f60718'
const LAPTOP = 'b9c8d7e6f5a40312'

/* --------------------------------------------------------- the object layers */

type Memory = ReadingObjects & {
  store: Map<string, string>
  calls: string[]
  /** Runs once, immediately before the next conditional write is decided. */
  interpose: ((path: string) => void) | null
}

/**
 * An in-memory layer whose revision is a counter rather than a digest.
 *
 * Stricter than either real driver on purpose: two writes of identical bytes
 * are two revisions here, so a conditional write cannot accidentally succeed
 * against a different write that happened to produce the same content.
 */
function memoryObjects(): Memory {
  const store = new Map<string, string>()
  const versions = new Map<string, number>()
  const calls: string[] = []
  let tick = 0

  const layer: Memory = {
    driver: 'memory',
    durable: false,
    store,
    calls,
    interpose: null,
    async get(path) {
      calls.push(`get ${path}`)
      return store.has(path) ? (store.get(path) as string) : null
    },
    async getVersioned(path) {
      calls.push(`getVersioned ${path}`)
      if (!store.has(path)) return { body: null, version: null }
      return { body: store.get(path) as string, version: String(versions.get(path) ?? 0) }
    },
    async putIfMatch(path, body, version) {
      calls.push(`putIfMatch ${path}`)
      if (layer.interpose) {
        const run = layer.interpose
        layer.interpose = null
        run(path)
      }
      const held = store.has(path) ? String(versions.get(path) ?? 0) : null
      if (held !== version) return false
      tick += 1
      store.set(path, body)
      versions.set(path, tick)
      return true
    },
    async put(path, body) {
      calls.push(`put ${path}`)
      tick += 1
      store.set(path, body)
      versions.set(path, tick)
    },
    async del(path) {
      calls.push(`del ${path}`)
      store.delete(path)
      versions.delete(path)
    },
    async list(prefix) {
      calls.push(`list ${prefix}`)
      return Array.from(store.keys()).filter((key) => key.startsWith(prefix))
    },
  }

  return layer
}

function fsStore(): { store: ReadingStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'mrj-order-'))
  const saved = {
    driver: process.env.REVIEWER_FEEDBACK_DRIVER,
    readingDir: process.env.REVIEWER_READING_DIR,
  }
  process.env.REVIEWER_FEEDBACK_DRIVER = 'fs'
  process.env.REVIEWER_READING_DIR = dir
  __resetReadingStore()

  return {
    store: createReadingStore(),
    cleanup() {
      if (saved.driver === undefined) delete process.env.REVIEWER_FEEDBACK_DRIVER
      else process.env.REVIEWER_FEEDBACK_DRIVER = saved.driver
      if (saved.readingDir === undefined) delete process.env.REVIEWER_READING_DIR
      else process.env.REVIEWER_READING_DIR = saved.readingDir
      __resetReadingStore()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Run one body against both drivers, so a rule cannot be true of only one. */
async function bothDrivers(
  body: (store: ReadingStore, label: string) => Promise<void>,
): Promise<void> {
  await body(__readingStoreOver(memoryObjects()), 'memory')
  const disk = fsStore()
  try {
    await body(disk.store, 'fs')
  } finally {
    disk.cleanup()
  }
}

/* ------------------------------------------------------------------ records */

function place(chapter: string, ordinal: number): ReadingPosition {
  return {
    schema: 1,
    ownerKind: ANNA.kind,
    ownerId: ANNA.id,
    bookSlug: BOOK,
    bookTitle: 'The Backward Becoming',
    chapterSlug: chapter,
    chapterNumber: chapter === 'chapter-one' ? 1 : 2,
    chapterLabel: chapter === 'chapter-one' ? 'Chapter One' : 'Chapter Two',
    paragraphId: `${chapter}-p${String(ordinal).padStart(3, '0')}`,
    paragraphOrdinal: ordinal,
    updatedAt: new Date(1_700_000_000_000 + ordinal * 1000).toISOString(),
  }
}

/* -------------------------------------------------------------------- tests */

test('a delayed save from the same device is refused, and the newer place stands', async () => {
  await bothDrivers(async (store, label) => {
    const a10 = await store.savePosition(place('chapter-three', 40), {
      device: PHONE,
      sequence: 10,
    })
    assert.equal(a10.outcome, 'stored', label)

    const a9 = await store.savePosition(place('chapter-one', 3), {
      device: PHONE,
      sequence: 9,
    })
    assert.equal(a9.outcome, 'stale', label)

    const held = await store.readPosition(ANNA, BOOK)
    assert.equal(held?.chapterSlug, 'chapter-three', label)
    assert.equal(held?.paragraphOrdinal, 40, label)
    // And the mark did not move backwards either.
    assert.equal(highWaterFor(held?.devices, PHONE), 10, label)
  })
})

test('the same sequence twice is refused the second time', async () => {
  await bothDrivers(async (store, label) => {
    await store.savePosition(place('chapter-two', 20), { device: PHONE, sequence: 7 })
    const again = await store.savePosition(place('chapter-one', 1), {
      device: PHONE,
      sequence: 7,
    })
    assert.equal(again.outcome, 'stale', label)
    assert.equal((await store.readPosition(ANNA, BOOK))?.paragraphOrdinal, 20, label)
  })
})

test('A10, then B5, then a delayed A9 leaves B5 on record', async () => {
  await bothDrivers(async (store, label) => {
    // 1. The phone saves its tenth place.
    assert.equal(
      (await store.savePosition(place('chapter-three', 40), { device: PHONE, sequence: 10 }))
        .outcome,
      'stored',
      label,
    )

    // 2. The laptop saves its fifth, and takes the position. Five is smaller
    //    than ten and that must not matter in the slightest.
    assert.equal(
      (await store.savePosition(place('chapter-one', 5), { device: LAPTOP, sequence: 5 }))
        .outcome,
      'stored',
      label,
    )
    assert.equal((await store.readPosition(ANNA, BOOK))?.chapterSlug, 'chapter-one', label)

    // 3. The phone's delayed ninth finally arrives.
    const delayed = await store.savePosition(place('chapter-two', 9), {
      device: PHONE,
      sequence: 9,
    })
    assert.equal(delayed.outcome, 'stale', label)

    // B5 is still what a reader is offered.
    const held = await store.readPosition(ANNA, BOOK)
    assert.equal(held?.chapterSlug, 'chapter-one', label)
    assert.equal(held?.paragraphOrdinal, 5, label)
    assert.equal(held?.device, LAPTOP, label)

    // And the server still remembers both devices, not only the one on record.
    assert.equal(highWaterFor(held?.devices, PHONE), 10, label)
    assert.equal(highWaterFor(held?.devices, LAPTOP), 5, label)
  })
})

test('a smaller sequence from another device still wins, because arrival decides', async () => {
  await bothDrivers(async (store, label) => {
    await store.savePosition(place('chapter-three', 99), { device: PHONE, sequence: 5000 })
    const laptop = await store.savePosition(place('chapter-one', 2), {
      device: LAPTOP,
      sequence: 1,
    })
    assert.equal(laptop.outcome, 'stored', label)
    assert.equal((await store.readPosition(ANNA, BOOK))?.paragraphOrdinal, 2, label)
  })
})

test('the ordering decision is retaken inside the conditional write, not carried over it', async () => {
  const objects = memoryObjects()
  const store = __readingStoreOver(objects)
  const path = positionPath(ANNA, BOOK)

  /*
   * The interleaving that a read-then-write cannot survive.
   *
   * This save reads a store with nothing in it, so on that reading its sequence
   * is perfectly acceptable. Between that read and its write, another caller
   * records a *newer* save from the same device. The conditional write must
   * then fail, and -- this is the part that matters -- the retry must decide
   * again against what is there now rather than reusing the decision it already
   * made. Carrying the decision over the loop would overwrite the newer place
   * with the older one, which is precisely the defect in a tighter window.
   */
  objects.interpose = () => {
    objects.store.set(
      path,
      `${JSON.stringify(
        { ...place('chapter-three', 40), device: PHONE, sequence: 10, devices: [{ id: PHONE, seq: 10 }] },
        null,
        2,
      )}\n`,
    )
    // A revision the pending write cannot possibly be holding.
    objects.calls.push('interposed')
  }

  const result = await store.savePosition(place('chapter-one', 1), {
    device: PHONE,
    sequence: 9,
  })

  assert.equal(result.outcome, 'stale')
  const held = await store.readPosition(ANNA, BOOK)
  assert.equal(held?.chapterSlug, 'chapter-three')
  assert.equal(held?.paragraphOrdinal, 40)

  // It really did go round again: two decisions, one interposition.
  assert.equal(objects.calls.filter((call) => call.startsWith('getVersioned')).length, 2)
  assert.equal(objects.calls.filter((call) => call === 'interposed').length, 1)
})

test('a position is never written unconditionally, by any path', async () => {
  const objects = memoryObjects()
  const store = __readingStoreOver(objects)

  await store.savePosition(place('chapter-one', 4), { device: PHONE, sequence: 1 })
  await store.savePosition(place('chapter-two', 8), { device: PHONE, sequence: 2 })
  // Including the legacy entry point, which has no ordering to give.
  await store.writePosition(place('chapter-two', 9))

  const path = positionPath(ANNA, BOOK)
  assert.equal(
    objects.calls.filter((call) => call === `put ${path}`).length,
    0,
    'the position must only ever be written through the conditional path',
  )
  assert.equal(objects.calls.filter((call) => call === `putIfMatch ${path}`).length, 3)
})

test('a legacy record with no ordering is readable, writable, and keeps its place', async () => {
  await bothDrivers(async (store, label) => {
    // Written exactly as a pre-ordering deployment wrote it.
    await store.writePosition(place('chapter-two', 30))

    const legacy = await store.readPosition(ANNA, BOOK)
    assert.ok(legacy, label)
    assert.equal(legacy?.paragraphOrdinal, 30, label)
    assert.equal(legacy?.device, undefined, label)
    assert.equal(legacy?.devices, undefined, label)

    // A device that has never been seen is not stale against a record that
    // remembers nothing, so an ordered save lands on top of a legacy one.
    const ordered = await store.savePosition(place('chapter-three', 44), {
      device: PHONE,
      sequence: 3,
    })
    assert.equal(ordered.outcome, 'stored', label)
    assert.equal(highWaterFor((await store.readPosition(ANNA, BOOK))?.devices, PHONE), 3, label)
  })
})

test('a save with no ordering does not erase the marks that order everybody else', async () => {
  await bothDrivers(async (store, label) => {
    await store.savePosition(place('chapter-three', 40), { device: PHONE, sequence: 10 })
    await store.writePosition(place('chapter-one', 2))

    const held = await store.readPosition(ANNA, BOOK)
    assert.equal(held?.paragraphOrdinal, 2, label)
    // The phone's mark survives, so its delayed ninth is still recognisable.
    assert.equal(highWaterFor(held?.devices, PHONE), 10, label)

    const delayed = await store.savePosition(place('chapter-two', 9), {
      device: PHONE,
      sequence: 9,
    })
    assert.equal(delayed.outcome, 'stale', label)
  })
})

test('malformed ordering is dropped rather than refused, and the place is still kept', async () => {
  await bothDrivers(async (store, label) => {
    const result = await store.savePosition(place('chapter-two', 22), {
      device: '../../somewhere-else',
      sequence: -1,
    })
    assert.equal(result.outcome, 'stored', label)

    const held = await store.readPosition(ANNA, BOOK)
    assert.equal(held?.paragraphOrdinal, 22, label)
    assert.equal(held?.device, undefined, label)
  })
})

test('a record whose ordering metadata is damaged still yields the place', () => {
  const damaged = {
    ...place('chapter-two', 19),
    device: 'not a device id',
    sequence: 'not a number',
    devices: 'not a list',
  }
  const parsed = asPosition(damaged)
  assert.ok(parsed, 'a damaged ordering field must never cost a reader their place')
  assert.equal(parsed?.paragraphOrdinal, 19)
  assert.equal(parsed?.device, undefined)
  assert.equal(parsed?.sequence, undefined)
  assert.equal(parsed?.devices, undefined)
})

test('the retained per-device metadata cannot be grown without bound', async () => {
  const store = __readingStoreOver(memoryObjects())

  for (let index = 0; index < MAX_TRACKED_DEVICES + 12; index += 1) {
    await store.savePosition(place('chapter-one', 1), {
      device: `device${String(index).padStart(10, '0')}`,
      sequence: index + 1,
    })
  }

  const held = await store.readPosition(ANNA, BOOK)
  assert.equal(held?.devices?.length, MAX_TRACKED_DEVICES)
  // The device that actually holds the position is never the one evicted.
  assert.equal(highWaterFor(held?.devices, held?.device ?? ''), held?.sequence)
})
