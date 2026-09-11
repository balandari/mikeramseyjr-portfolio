import test from 'node:test'
import assert from 'node:assert/strict'

import {
  alnumBefore,
  caretAfterGrouping,
  groupAccessCode,
} from '../lib/access-code-format.ts'
import { normalizeAccessCode } from '../lib/reviewer-access.ts'

/*
 * The field groups a code as it is typed. These check two things, and the
 * second matters more than the first:
 *
 *   1. It groups sensibly, from any input a reviewer might give it.
 *   2. It cannot change what the server accepts. Whatever this produces
 *      normalises to exactly what the raw input normalised to, so the
 *      fingerprint compared against the roster is unchanged.
 *
 * The code below is a shape, not a real one -- it is valid against nothing.
 */

const PRINTED = 'ABCD-EFGH-JKLM-NPQR'
const RAW = 'ABCDEFGHJKLMNPQR'

/* -------------------------------------------------------------- grouping */

test('a bare run of characters is grouped in fours', () => {
  assert.equal(groupAccessCode(RAW), PRINTED)
})

test('a code that is already grouped is left as it reads', () => {
  assert.equal(groupAccessCode(PRINTED), PRINTED)
})

test('lower case, spaces and stray punctuation all arrive at the same place', () => {
  // Everything a reviewer might plausibly paste out of a message.
  for (const input of [
    'abcdefghjklmnpqr',
    'abcd-efgh-jklm-npqr',
    'ABCD EFGH JKLM NPQR',
    '  abcd efgh-JKLM npqr  ',
    'ABCD--EFGH..JKLM__NPQR',
    'abcd\nefgh\tjklm npqr',
  ]) {
    assert.equal(groupAccessCode(input), PRINTED, `"${input}" should group to the printed form`)
  }
})

test('a partial code is grouped as far as it goes, with no trailing dash', () => {
  /*
   * A trailing dash would sit directly under the caret and be the first thing
   * the next keystroke deleted, which makes the field feel like it is fighting
   * back. So a group is only closed once there is something to follow it.
   */
  const steps: [string, string][] = [
    ['A', 'A'],
    ['AB', 'AB'],
    ['ABC', 'ABC'],
    ['ABCD', 'ABCD'],
    ['ABCDE', 'ABCD-E'],
    ['ABCDEFGH', 'ABCD-EFGH'],
    ['ABCDEFGHJ', 'ABCD-EFGH-J'],
    ['ABCDEFGHJKLM', 'ABCD-EFGH-JKLM'],
    ['ABCDEFGHJKLMN', 'ABCD-EFGH-JKLM-N'],
  ]
  for (const [typed, shown] of steps) {
    assert.equal(groupAccessCode(typed), shown, `"${typed}" should show as "${shown}"`)
  }
})

test('an empty field stays empty rather than becoming a dash', () => {
  assert.equal(groupAccessCode(''), '')
  assert.equal(groupAccessCode('---'), '')
  assert.equal(groupAccessCode('   '), '')
})

test('a longer or shorter code is grouped rather than truncated', () => {
  // Nothing here assumes sixteen characters. Truncating would silently destroy
  // a code, which is the one thing this must never do.
  assert.equal(groupAccessCode('ABCDEFGHJKLMNPQRSTVW'), 'ABCD-EFGH-JKLM-NPQR-STVW')
  assert.equal(groupAccessCode('ABCDEFGHJKLM'), 'ABCD-EFGH-JKLM')
})

test('regrouping is idempotent', () => {
  // The value is re-derived from scratch on every keystroke, so formatting an
  // already-formatted value must be a no-op -- otherwise dashes would breed.
  let value = RAW
  for (let i = 0; i < 5; i += 1) value = groupAccessCode(value)
  assert.equal(value, PRINTED)
})

/* ------------------------------------------- the security semantics hold */

test('grouping cannot change what the server accepts', () => {
  /*
   * The important one. Whatever the field shows, the server normalises it the
   * same way it always has -- so the value fingerprinted against the roster is
   * identical whether the reviewer typed the dashes, pasted them, or typed
   * none at all.
   */
  for (const input of [
    RAW,
    PRINTED,
    'abcdefghjklmnpqr',
    'abcd efgh jklm npqr',
    'ABCD--EFGH..JKLM__NPQR',
  ]) {
    assert.equal(
      normalizeAccessCode(groupAccessCode(input)),
      normalizeAccessCode(input),
      `grouping changed what "${input}" normalises to`,
    )
    // And that value is the code itself, with nothing added or lost.
    assert.equal(normalizeAccessCode(groupAccessCode(input)), RAW)
  }
})

test('the dashes the field adds are exactly the ones normalisation removes', () => {
  assert.equal(normalizeAccessCode(PRINTED), RAW)
  assert.equal(normalizeAccessCode(groupAccessCode(RAW)), RAW)
})

/* ----------------------------------------------------------------- caret */

test('the caret counts real characters, not offsets', () => {
  // Dashes move as the value grows, so the caret is tracked by how many actual
  // characters precede it.
  assert.equal(alnumBefore('ABCD-EFGH', 0), 0)
  assert.equal(alnumBefore('ABCD-EFGH', 4), 4)
  // The offset after the dash still has four real characters before it.
  assert.equal(alnumBefore('ABCD-EFGH', 5), 4)
  assert.equal(alnumBefore('ABCD-EFGH', 9), 8)
  // A raw paste, before any grouping has happened.
  assert.equal(alnumBefore('abcdefgh', 6), 6)
})

test('typing the fourth character leaves the caret past the new dash', () => {
  /*
   * Otherwise the next keystroke lands before the separator and the reviewer
   * has to step over it by hand every four characters.
   */
  assert.equal(caretAfterGrouping('ABCD-E', 4), 5)
  assert.equal(caretAfterGrouping('ABCD-EFGH-J', 8), 10)
})

test('the caret lands in the right place mid-string and at the ends', () => {
  assert.equal(caretAfterGrouping('ABCD-EFGH', 0), 0)
  assert.equal(caretAfterGrouping('ABCD-EFGH', 1), 1)
  assert.equal(caretAfterGrouping('ABCD-EFGH', 6), 7)
  assert.equal(caretAfterGrouping('ABCD-EFGH', 8), 9)
  // More characters asked for than exist: the end, not an overflow.
  assert.equal(caretAfterGrouping('ABCD-EFGH', 99), 9)
  assert.equal(caretAfterGrouping('', 3), 0)
  assert.equal(caretAfterGrouping('ABCD', -1), 0)
})

test('a character typed in the middle keeps the caret with it', () => {
  // "ABCD-EFGH" with an X inserted at offset 2 -> "ABXCD-EFGH", and the caret
  // belongs immediately after the X, which is the third real character.
  const raw = 'ABXCD-EFGH'
  const formatted = groupAccessCode(raw)
  assert.equal(formatted, 'ABXC-DEFG-H')
  assert.equal(caretAfterGrouping(formatted, alnumBefore(raw, 3)), 3)
})

test('deleting from the middle keeps the caret where the character was', () => {
  const raw = 'ACD-EFGH'
  const formatted = groupAccessCode(raw)
  assert.equal(formatted, 'ACDE-FGH')
  // One real character precedes the deletion point.
  assert.equal(caretAfterGrouping(formatted, alnumBefore(raw, 1)), 1)
})
