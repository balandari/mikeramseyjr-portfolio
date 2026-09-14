import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PENDING_RECONCILE_LIMIT,
  PENDING_TTL_MS,
  clearPending,
  deviceId,
  judgePending,
  nextSequence,
  pendingAsPosition,
  readPending,
  sweepForeignPending,
  writePending,
  type LocalStore,
  type PendingPosition,
} from '../app/review/reading-local.ts'
import type { ClientPosition } from '../lib/reading-view.ts'

/*
 * The device-local pending place: what the card prefers, and for how long.
 *
 * This is the half of the resume repair that has to be right *before* any
 * network answer arrives, so it is written to be decidable without one. The
 * storage is a plain object standing in for `localStorage`, and `judgePending`
 * takes the clock as an argument -- so expiry is tested by passing a later
 * number, not by sleeping and hoping.
 *
 * The case at the centre of all of this is Mike's: Continue reading showed
 * Chapter Two, he opened Chapter Three, read two screens, pressed Android Back,
 * and the card still said Chapter Two -- while a refresh proved the place had
 * reached storage. So the card was being shown a cached page, and the fix is
 * that this device knows what it has just saved.
 */

const PHONE = 'a1b2c3d4e5f60718'
const LAPTOP = 'b9c8d7e6f5a40312'
const ANNA = 'anna0namespace00'
const BEN = 'ben00namespace00'
const BOOK = 'the-backward-becoming'
const NOW = 1_700_000_000_000

/** A `localStorage` that is an ordinary object, so a test can look inside it. */
function fakeStore(): LocalStore & { map: Map<string, string>; refuse: boolean } {
  const map = new Map<string, string>()
  const store = {
    map,
    refuse: false,
    get length() {
      return map.size
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null
    },
    getItem(key: string) {
      return map.has(key) ? (map.get(key) as string) : null
    },
    setItem(key: string, value: string) {
      if (store.refuse) throw new Error('quota exceeded')
      map.set(key, value)
    },
    removeItem(key: string) {
      map.delete(key)
    },
  }
  return store as LocalStore & { map: Map<string, string>; refuse: boolean }
}

function pending(overrides: Partial<PendingPosition> = {}): PendingPosition {
  return {
    schema: 1,
    identity: ANNA,
    device: PHONE,
    sequence: 10,
    bookSlug: BOOK,
    bookTitle: 'The Backward Becoming',
    chapterSlug: 'chapter-three',
    chapterNumber: 3,
    chapterLabel: 'Chapter Three',
    paragraphId: 'chapter-three-p042',
    paragraphOrdinal: 42,
    paragraphOffset: 0.62,
    recordedAt: NOW,
    attempts: 0,
    ...overrides,
  }
}

function serverPosition(overrides: Partial<ClientPosition> = {}): ClientPosition {
  return {
    bookSlug: BOOK,
    bookTitle: 'The Backward Becoming',
    chapterSlug: 'chapter-two',
    chapterNumber: 2,
    chapterLabel: 'Chapter Two',
    paragraphId: 'chapter-two-p011',
    paragraphOrdinal: 11,
    updatedAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  }
}

/* ------------------------------------------------------- the decisive case */

test('a cached Chapter Two does not outrank a newer local Chapter Three', () => {
  const verdict = judgePending(pending(), serverPosition(), NOW)

  assert.equal(verdict.kind, 'pending')
  assert.equal(verdict.kind === 'pending' && verdict.record.chapterSlug, 'chapter-three')

  // And what the card would render is the chapter the reviewer actually reached.
  const shown = pendingAsPosition(pending())
  assert.equal(shown.chapterLabel, 'Chapter Three')
  assert.equal(shown.paragraphId, 'chapter-three-p042')
  assert.equal(shown.paragraphOffset, 0.62)
  assert.equal(shown.device, PHONE)
  assert.equal(shown.sequence, 10)
})

test('a reconciliation that answers with the old chapter does not undo it', () => {
  /*
   * The fetch beating the leaving page's own write is the ordinary case, not
   * the unusual one -- the write was handed to the browser as the page closed,
   * and this request was made by a page that had already loaded. A "freshest
   * answer wins" card would put the reviewer back in Chapter Two here, which is
   * the original defect with an extra round trip in it.
   */
  const verdict = judgePending(pending(), serverPosition({ device: PHONE, sequence: 9 }), NOW)
  assert.equal(verdict.kind, 'pending')
})

test('the server reporting this device`s own sequence clears the pending place', () => {
  const confirmed = serverPosition({
    chapterSlug: 'chapter-three',
    chapterLabel: 'Chapter Three',
    device: PHONE,
    sequence: 10,
    devices: [{ id: PHONE, seq: 10 }],
  })
  assert.equal(judgePending(pending(), confirmed, NOW).kind, 'confirmed')

  // A later sequence from the same device confirms it too: another tab of this
  // browser has already carried the reading further.
  const later = serverPosition({ device: PHONE, sequence: 11, devices: [{ id: PHONE, seq: 11 }] })
  assert.equal(judgePending(pending(), later, NOW).kind, 'confirmed')

  // And so does a record another device now holds that still carries this
  // device's mark -- the save landed, and was then overtaken.
  const overtaken = serverPosition({
    device: LAPTOP,
    sequence: 3,
    devices: [{ id: PHONE, seq: 10 }, { id: LAPTOP, seq: 3 }],
  })
  assert.equal(judgePending(pending(), overtaken, NOW).kind, 'confirmed')
})

test('another device`s position never confirms this one, and never gets compared', () => {
  // A laptop sequence far larger than the phone's confirms nothing: the two
  // numbers count different things.
  const elsewhere = serverPosition({
    device: LAPTOP,
    sequence: 9_999,
    devices: [{ id: LAPTOP, seq: 9_999 }],
  })
  assert.equal(judgePending(pending(), elsewhere, NOW).kind, 'pending')
})

test('a pending place cannot outrank the server for ever', () => {
  const elsewhere = serverPosition({
    device: LAPTOP,
    sequence: 4,
    devices: [{ id: LAPTOP, seq: 4 }],
  })

  // Out of attempts.
  assert.equal(
    judgePending(pending({ attempts: PENDING_RECONCILE_LIMIT }), elsewhere, NOW).kind,
    'expired',
  )

  // Or out of time, which is the one a card that is never re-opened runs into.
  assert.equal(judgePending(pending(), elsewhere, NOW + PENDING_TTL_MS).kind, 'expired')
  assert.equal(judgePending(pending(), elsewhere, NOW + PENDING_TTL_MS - 1).kind, 'pending')

  // Expiry never beats confirmation: a record the server actually holds is
  // settled, not abandoned.
  const confirmed = serverPosition({ device: PHONE, sequence: 10, devices: [{ id: PHONE, seq: 10 }] })
  assert.equal(
    judgePending(pending({ attempts: PENDING_RECONCILE_LIMIT + 5 }), confirmed, NOW).kind,
    'confirmed',
  )
})

test('no pending record means nothing to prefer and nothing to warn about', () => {
  assert.equal(judgePending(null, serverPosition(), NOW).kind, 'confirmed')
})

/* ------------------------------------------------------------- the storage */

test('a pending place is kept per reader and per book', () => {
  const store = fakeStore()
  writePending(pending(), store)
  writePending(pending({ bookSlug: 'persistent', chapterSlug: 'chapter-one' }), store)

  assert.equal(readPending(ANNA, BOOK, store)?.chapterSlug, 'chapter-three')
  assert.equal(readPending(ANNA, 'persistent', store)?.chapterSlug, 'chapter-one')
  assert.equal(readPending(ANNA, 'another-book', store), null)
})

test('a borrowed browser cannot show one reviewer another reviewer`s place', () => {
  const store = fakeStore()
  writePending(pending(), store)

  // Ben cannot read Anna's record, by key or by content.
  assert.equal(readPending(BEN, BOOK, store), null)

  // A record keyed as Ben's but carrying Anna's identity is refused as well, so
  // a hand-edited or migrated key cannot smuggle one across.
  store.setItem(`mrj.reading.pending.${BEN}.${BOOK}`, JSON.stringify(pending()))
  assert.equal(readPending(BEN, BOOK, store), null)
})

test('signing in as somebody else removes what the previous reader left behind', () => {
  const store = fakeStore()
  writePending(pending(), store)
  writePending(pending({ identity: BEN, bookSlug: BOOK }), store)
  assert.equal(store.map.size, 2)

  sweepForeignPending(BEN, store)

  assert.equal(readPending(ANNA, BOOK, store), null, 'Anna`s place must not survive')
  assert.equal(readPending(BEN, BOOK, store)?.chapterSlug, 'chapter-three')
})

test('clearing removes one reader`s one book and nothing else', () => {
  const store = fakeStore()
  writePending(pending(), store)
  writePending(pending({ bookSlug: 'persistent' }), store)

  clearPending(ANNA, BOOK, store)
  assert.equal(readPending(ANNA, BOOK, store), null)
  assert.equal(readPending(ANNA, 'persistent', store)?.bookSlug, 'persistent')
})

test('a damaged or foreign record reads as nothing at all', () => {
  const store = fakeStore()
  const key = `mrj.reading.pending.${ANNA}.${BOOK}`

  store.setItem(key, 'not json')
  assert.equal(readPending(ANNA, BOOK, store), null)

  store.setItem(key, JSON.stringify({ schema: 2, identity: ANNA }))
  assert.equal(readPending(ANNA, BOOK, store), null)

  store.setItem(key, JSON.stringify(pending({ device: 'nope' })))
  assert.equal(readPending(ANNA, BOOK, store), null)

  store.setItem(key, JSON.stringify(pending({ sequence: -4 })))
  assert.equal(readPending(ANNA, BOOK, store), null)
})

test('a storage that refuses to be written to costs nothing but the shortcut', () => {
  const store = fakeStore()
  store.refuse = true
  // Never throws: reading must not be interrupted because a browser is full or
  // is in a mode that keeps nothing.
  assert.doesNotThrow(() => writePending(pending(), store))
  assert.equal(readPending(ANNA, BOOK, store), null)

  // And no storage at all is the same answer, quietly.
  assert.equal(readPending(ANNA, BOOK, null), null)
  assert.doesNotThrow(() => writePending(pending(), null))
  assert.doesNotThrow(() => clearPending(ANNA, BOOK, null))
  assert.doesNotThrow(() => sweepForeignPending(ANNA, null))
})

/* --------------------------------------------------- the device and counter */

test('the device identity is minted once and then kept', () => {
  const store = fakeStore()
  const first = deviceId(store)
  assert.match(first, /^[a-z0-9]{8,64}$/)
  assert.equal(deviceId(store), first, 'a device must not change identity between saves')

  // A stored value that is not a usable identifier is replaced rather than used.
  store.setItem('mrj.reading.device', 'nonsense!')
  assert.notEqual(deviceId(store), 'nonsense!')
})

test('the counter only ever goes up, and is shared by every tab of the browser', () => {
  const store = fakeStore()
  const first = nextSequence(store)
  const second = nextSequence(store)
  const third = nextSequence(store)

  assert.ok(second > first, `${second} must be greater than ${first}`)
  assert.ok(third > second)

  // "Another tab" is the same storage, and must not restart the count.
  assert.ok(nextSequence(store) > third)

  // A cleared counter resumes above anything the server may already hold for
  // this device, rather than restarting at one and being refused as stale.
  store.removeItem('mrj.reading.seq')
  assert.ok(nextSequence(store) > 1_600_000_000_000)
})
