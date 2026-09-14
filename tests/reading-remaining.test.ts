import test from 'node:test'
import assert from 'node:assert/strict'

import { remainingReadingLabel } from '../lib/reading-remaining.ts'

/*
 * The remaining-time line, which is arithmetic and nothing else.
 *
 * These cover the wording rules and the honesty rules. What they deliberately
 * do NOT cover is where the line appears, when React re-renders it, or how it
 * looks in either theme -- none of that is decidable here, and a source-only
 * test that claimed it would be lying. Those were checked in a browser and the
 * figures are in the report.
 */

test('it counts down in whole minutes from the chapter estimate', () => {
  assert.equal(remainingReadingLabel(22, 0), 'About 22 min left')
  assert.equal(remainingReadingLabel(22, 0.5), 'About 11 min left')
  assert.equal(remainingReadingLabel(10, 0.1), 'About 9 min left')
})

test('it rounds up, so the estimate is never optimistic', () => {
  // 8.2 minutes left must read as nine, not eight.
  assert.equal(remainingReadingLabel(10, 0.18), 'About 9 min left')
  // Exactly one minute stays one minute.
  assert.equal(remainingReadingLabel(10, 0.9), 'About 1 min left')
})

test('one minute is singular, and the end is words rather than a zero', () => {
  assert.equal(remainingReadingLabel(20, 0.96), 'About 1 min left')
  assert.equal(remainingReadingLabel(20, 1), 'Almost finished')
  assert.equal(remainingReadingLabel(1, 1), 'Almost finished')
})

test('it never shows seconds, a percentage, or the approximation sign', () => {
  const samples: string[] = []
  for (let i = 0; i <= 100; i += 1) {
    const label = remainingReadingLabel(37, i / 100)
    if (label) samples.push(label)
  }
  assert.ok(samples.length > 0)
  for (const label of samples) {
    assert.ok(!label.includes('%'), `"${label}" must not contain a percentage`)
    assert.ok(!label.includes('≈'), `"${label}" must not contain the approximation sign`)
    assert.ok(!/\bsec/i.test(label), `"${label}" must not mention seconds`)
    assert.ok(!/\d+\.\d/.test(label), `"${label}" must not carry a fraction of a minute`)
    assert.match(label, /^(About \d+ min left|About 1 min left|Almost finished)$/)
  }
})

test('the displayed value only ever decreases as the reader advances', () => {
  let previous = Number.POSITIVE_INFINITY
  for (let i = 0; i <= 100; i += 1) {
    const label = remainingReadingLabel(45, i / 100)
    assert.ok(label)
    const value = label === 'Almost finished' ? 0 : Number(label.match(/\d+/)?.[0])
    assert.ok(value <= previous, `"${label}" went up from ${previous}`)
    previous = value
  }
})

test('a chapter with no usable estimate is given no invented one', () => {
  assert.equal(remainingReadingLabel(0, 0.5), null)
  assert.equal(remainingReadingLabel(-5, 0.5), null)
  assert.equal(remainingReadingLabel(Number.NaN, 0.5), null)
  assert.equal(remainingReadingLabel(20, Number.NaN), null)
})

test('progress outside 0..1 is clamped rather than producing nonsense', () => {
  assert.equal(remainingReadingLabel(20, -3), 'About 20 min left')
  assert.equal(remainingReadingLabel(20, 4), 'Almost finished')
})

/*
 * The end of a chapter, which is a different fact from the end of the estimate.
 *
 * Mike found the bar still reading `Almost finished` with the page at its
 * absolute bottom -- nothing left to be almost finished with. The cause is that
 * `Math.ceil` reaches zero a little before the last line, and that moment was
 * being printed as though it meant the reader had arrived. It does not, and it
 * cannot: the estimate knows two numbers and neither of them is where the page
 * stops. So the page says when it stops, and says it in its own words.
 */

test('`Chapter complete` is the page`s own report, never a rounded estimate', () => {
  // At the bottom, whatever the arithmetic would otherwise have said.
  assert.equal(remainingReadingLabel(22, 1, true), 'Chapter complete')
  assert.equal(remainingReadingLabel(22, 0.9, true), 'Chapter complete')
  assert.equal(remainingReadingLabel(1, 0, true), 'Chapter complete')

  // And never from the estimate alone. This is the exact defect: the rounded
  // figure has run out, the page has not.
  assert.equal(remainingReadingLabel(20, 1), 'Almost finished')
  assert.equal(remainingReadingLabel(20, 0.999), 'About 1 min left')
  assert.equal(remainingReadingLabel(20, 0.96), 'About 1 min left')
})

test('the estimate keeps every one of its own words just above the bottom', () => {
  // Slightly above the bottom is still an ordinary remaining-time message.
  assert.equal(remainingReadingLabel(22, 0.5, false), 'About 11 min left')
  assert.equal(remainingReadingLabel(10, 0.9, false), 'About 1 min left')
  assert.equal(remainingReadingLabel(10, 1, false), 'Almost finished')
})

test('a chapter with no usable estimate says nothing, even at the bottom', () => {
  // `Chapter complete` is about the page, but this line is the estimate's slot,
  // and a chapter that was never given one is still not given anything here.
  assert.equal(remainingReadingLabel(0, 1, true), null)
  assert.equal(remainingReadingLabel(Number.NaN, 1, true), null)
})
