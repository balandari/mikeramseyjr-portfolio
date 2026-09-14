import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEVICE_ID_PATTERN,
  MAX_TRACKED_DEVICES,
  highWaterFor,
  isStaleSequence,
  mergeDeviceSequence,
  normalizeDeviceId,
  normalizeDeviceList,
  normalizeSequence,
  serverHasConfirmed,
} from '../lib/reading-order.ts'

/*
 * The ordering rules on their own, with no store and no browser.
 *
 * Every one of these is decided by arithmetic on values passed in, so there is
 * no clock to wait for and no timing to get lucky with: the same inputs give
 * the same answer every run. The store's behaviour is tested separately in
 * `reading-position-ordering.test.ts`; this is the rulebook both the server and
 * the browser read from, tested once.
 */

const A = 'a1b2c3d4e5f60718'
const B = 'b9c8d7e6f5a40312'

test('a device identifier is bounded, lower-cased, and otherwise refused', () => {
  assert.equal(normalizeDeviceId(A), A)
  assert.equal(normalizeDeviceId(A.toUpperCase()), A)
  assert.equal(normalizeDeviceId(`  ${A}  `), A)

  assert.equal(normalizeDeviceId(''), null)
  assert.equal(normalizeDeviceId('short'), null)
  assert.equal(normalizeDeviceId('a'.repeat(65)), null)
  assert.equal(normalizeDeviceId('has-a-hyphen-in-it'), null)
  assert.equal(normalizeDeviceId('../../etc/passwd'), null)
  assert.equal(normalizeDeviceId(42), null)
  assert.equal(normalizeDeviceId(null), null)
  assert.equal(normalizeDeviceId(undefined), null)
  assert.equal(normalizeDeviceId({ toString: () => A }), null)

  // The pattern is what bounds the record's growth, so it is asserted directly.
  assert.match(A, DEVICE_ID_PATTERN)
})

test('a sequence is a positive safe integer, and nothing else', () => {
  assert.equal(normalizeSequence(1), 1)
  assert.equal(normalizeSequence(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER)

  assert.equal(normalizeSequence(0), null)
  assert.equal(normalizeSequence(-3), null)
  assert.equal(normalizeSequence(1.5), null)
  assert.equal(normalizeSequence(Number.NaN), null)
  assert.equal(normalizeSequence(Number.POSITIVE_INFINITY), null)
  assert.equal(normalizeSequence(Number.MAX_SAFE_INTEGER + 2), null)
  assert.equal(normalizeSequence('7'), null)
})

test('a damaged high-water list is dropped, never a reason to reject a place', () => {
  assert.equal(normalizeDeviceList(undefined), undefined)
  assert.equal(normalizeDeviceList(null), undefined)
  assert.equal(normalizeDeviceList('nonsense'), undefined)
  assert.equal(normalizeDeviceList([]), undefined)
  assert.equal(normalizeDeviceList([{ id: 'bad', seq: 1 }]), undefined)

  // The usable entries survive; the rest are simply not there.
  assert.deepEqual(
    normalizeDeviceList([{ id: A, seq: 4 }, { id: 'nope', seq: 9 }, { id: B, seq: 'x' }]),
    [{ id: A, seq: 4 }],
  )

  // A duplicate identifier cannot be used to inflate the list either.
  assert.deepEqual(
    normalizeDeviceList([{ id: A, seq: 4 }, { id: A, seq: 99 }]),
    [{ id: A, seq: 4 }],
  )
})

test('the list is bounded, and the bound is applied on read as well as on write', () => {
  const many = Array.from({ length: MAX_TRACKED_DEVICES + 6 }, (_, index) => ({
    id: `device${String(index).padStart(10, '0')}`,
    seq: index + 1,
  }))
  const kept = normalizeDeviceList(many)
  assert.ok(kept)
  assert.equal(kept?.length, MAX_TRACKED_DEVICES)
  // The most recent entries are the ones kept.
  assert.equal(kept?.[kept.length - 1].seq, many[many.length - 1].seq)
})

test('a sequence is only ever compared with one from the same device', () => {
  const devices = [{ id: A, seq: 10 }]

  // A's own older save is stale ...
  assert.equal(isStaleSequence(devices, A, 9), true)
  assert.equal(isStaleSequence(devices, A, 10), true)
  assert.equal(isStaleSequence(devices, A, 11), false)

  // ... and B's is not, however small it is beside A's. This is the rule that
  // keeps last-arrival-wins intact across devices.
  assert.equal(isStaleSequence(devices, B, 1), false)
  assert.equal(isStaleSequence(devices, B, 5), false)

  // Nothing to order against is never stale.
  assert.equal(isStaleSequence(undefined, A, 1), false)
  assert.equal(isStaleSequence(devices, null, 5), false)
  assert.equal(isStaleSequence(devices, A, null), false)
})

test('accepting a save keeps every other device`s mark, and moves this one last', () => {
  const first = mergeDeviceSequence(undefined, A, 10)
  assert.deepEqual(first, [{ id: A, seq: 10 }])

  // B taking the position does not erase what is known about A -- which is the
  // whole reason a delayed A9 can still be recognised as old afterwards.
  const second = mergeDeviceSequence(first, B, 5)
  assert.deepEqual(second, [{ id: A, seq: 10 }, { id: B, seq: 5 }])
  assert.equal(highWaterFor(second, A), 10)
  assert.equal(highWaterFor(second, B), 5)
  assert.equal(highWaterFor(second, 'c'.repeat(16)), null)

  // A writing again moves A to the end: the device on record is the last one
  // the bound can ever drop.
  const third = mergeDeviceSequence(second, A, 11)
  assert.deepEqual(third, [{ id: B, seq: 5 }, { id: A, seq: 11 }])
})

test('the bound sheds the least recently active device, never the newest', () => {
  let devices = mergeDeviceSequence(undefined, A, 1)
  for (let index = 0; index < MAX_TRACKED_DEVICES; index += 1) {
    devices = mergeDeviceSequence(devices, `filler${String(index).padStart(10, '0')}`, index + 1)
  }
  assert.equal(devices.length, MAX_TRACKED_DEVICES)
  // A was the oldest and is gone; the last one written is still there.
  assert.equal(highWaterFor(devices, A), null)
  assert.equal(devices[devices.length - 1].id, `filler${String(MAX_TRACKED_DEVICES - 1).padStart(10, '0')}`)
})

test('confirmation is this device`s own mark, and never another device`s', () => {
  const heldByA = { device: A, sequence: 10, devices: [{ id: A, seq: 10 }] }

  assert.equal(serverHasConfirmed(heldByA, A, 10), true)
  assert.equal(serverHasConfirmed(heldByA, A, 9), true)
  assert.equal(serverHasConfirmed(heldByA, A, 11), false)

  // B is waiting on its own save. A record held by A says nothing about it, and
  // B's sequence is never measured against A's.
  assert.equal(serverHasConfirmed(heldByA, B, 5), false)
  assert.equal(serverHasConfirmed(heldByA, B, 20), false)

  // A record held by B that still carries A's mark does confirm A: that is
  // precisely the case where A's save landed and was then overtaken.
  const heldByB = { device: B, sequence: 5, devices: [{ id: A, seq: 10 }, { id: B, seq: 5 }] }
  assert.equal(serverHasConfirmed(heldByB, A, 10), true)
  assert.equal(serverHasConfirmed(heldByB, A, 11), false)

  // A device pushed out of the bounded list while still holding the position is
  // confirmed by the record itself.
  assert.equal(serverHasConfirmed({ device: A, sequence: 10 }, A, 10), true)

  assert.equal(serverHasConfirmed(null, A, 1), false)
  assert.equal(serverHasConfirmed(undefined, A, 1), false)
  // A legacy record carries no ordering at all and confirms nothing.
  assert.equal(serverHasConfirmed({}, A, 1), false)
})
