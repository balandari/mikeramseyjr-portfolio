import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_QUOTE_LENGTH,
  excerptFrom,
  highlightSegments,
  normalizeOffsets,
  resolveAnchor,
  segmentsText,
  type InlineSegment,
} from '../lib/reading-anchor.ts'

/*
 * Anchoring is the part of this feature that can fail silently and wrongly, so
 * it is tested hardest. The failure this file exists to prevent is an
 * annotation quietly re-attaching itself to different words after the
 * manuscript is edited.
 */

const SEGMENTS: InlineSegment[] = [
  { kind: 'text', text: 'She said ' },
  { kind: 'emphasis', text: 'nothing' },
  { kind: 'text', text: ' at all.' },
]

const TEXT = 'She said nothing at all.'

/* ------------------------------------------------------------ reading text */

test('reading text is the segments joined, without the source markup', () => {
  assert.equal(segmentsText(SEGMENTS), TEXT)
  // The asterisks that mark emphasis in the source are not on the page, so
  // offsets must not count them.
  assert.ok(!segmentsText(SEGMENTS).includes('*'))
})

/* ---------------------------------------------------------------- offsets */

test('offsets are accepted only when they describe a real span', () => {
  assert.deepEqual(normalizeOffsets(0, 3, TEXT.length), { start: 0, end: 3 })
  assert.deepEqual(normalizeOffsets(9, 16, TEXT.length), { start: 9, end: 16 })
})

test('an unusable pair of offsets is refused rather than repaired', () => {
  const length = TEXT.length
  assert.equal(normalizeOffsets(5, 5, length), null, 'empty span')
  assert.equal(normalizeOffsets(7, 3, length), null, 'reversed')
  assert.equal(normalizeOffsets(-1, 4, length), null, 'negative start')
  assert.equal(normalizeOffsets(0, length + 1, length), null, 'past the end')
  assert.equal(normalizeOffsets(1.5, 4, length), null, 'not an integer')
  assert.equal(normalizeOffsets('0', 4, length), null, 'not a number')
  assert.equal(normalizeOffsets(null, 4, length), null, 'null')
  assert.equal(
    normalizeOffsets(0, MAX_QUOTE_LENGTH + 1, MAX_QUOTE_LENGTH + 10),
    null,
    'longer than a passage may be',
  )
})

/* ----------------------------------------------------------- anchor state */

test('an anchor whose characters still match is ok', () => {
  assert.equal(resolveAnchor({ startOffset: 9, endOffset: 16, quote: 'nothing' }, TEXT), 'ok')
})

test('an edit that moves the passage never re-attaches the anchor silently', () => {
  // The word at offsets 9..16 is now something else entirely.
  const edited = 'She said everything at all.'
  assert.equal(
    resolveAnchor({ startOffset: 9, endOffset: 16, quote: 'nothing' }, edited),
    'needs-relocation',
  )
})

test('an anchor whose paragraph is gone needs relocation', () => {
  assert.equal(
    resolveAnchor({ startOffset: 9, endOffset: 16, quote: 'nothing' }, null),
    'needs-relocation',
  )
})

test('an anchor past the end of a shortened paragraph needs relocation', () => {
  assert.equal(
    resolveAnchor({ startOffset: 9, endOffset: 16, quote: 'nothing' }, 'She said.'),
    'needs-relocation',
  )
})

test('a one-character difference is enough to require relocation', () => {
  assert.equal(
    resolveAnchor({ startOffset: 9, endOffset: 16, quote: 'nothing' }, 'She said Nothing at all.'),
    'needs-relocation',
  )
})

/* ---------------------------------------------------------------- excerpt */

test('an excerpt collapses wrapping and stops at a word', () => {
  const long = 'The\nfirst  line\nand the second line and a great deal more besides'
  const short = excerptFrom(long, 24)
  assert.ok(!short.includes('\n'))
  assert.ok(short.endsWith('…'))
  assert.ok(short.length <= 25)
  assert.ok(!short.includes('  '))
})

test('a short passage is its own excerpt, with no ellipsis', () => {
  assert.equal(excerptFrom('Short enough.', 80), 'Short enough.')
})

/* ------------------------------------------------------------ highlighting */

function rendered(pieces: ReturnType<typeof highlightSegments>): string {
  return pieces.map((piece) => piece.text).join('')
}

test('highlighting never changes the text, only how it is cut up', () => {
  const pieces = highlightSegments(SEGMENTS, [{ id: 'a', start: 4, end: 16 }])
  assert.equal(rendered(pieces), TEXT)
})

test('a highlight that crosses into emphasis keeps the emphasis', () => {
  const pieces = highlightSegments(SEGMENTS, [{ id: 'a', start: 4, end: 16 }])
  const marked = pieces.filter((piece) => piece.ids.includes('a'))
  assert.equal(marked.map((piece) => piece.text).join(''), 'said nothing')
  assert.ok(
    marked.some((piece) => piece.kind === 'emphasis' && piece.text === 'nothing'),
    'the italic run is still italic inside the highlight',
  )
})

test('two overlapping annotations both mark the run they share', () => {
  const pieces = highlightSegments(SEGMENTS, [
    { id: 'a', start: 0, end: 12 },
    { id: 'b', start: 9, end: 20 },
  ])
  assert.equal(rendered(pieces), TEXT)
  const both = pieces.filter((piece) => piece.ids.length === 2)
  assert.ok(both.length > 0, 'the overlap carries both ids')
  assert.equal(both.map((piece) => piece.text).join(''), 'not')
})

test('a range outside the paragraph is dropped, never clamped onto other text', () => {
  const pieces = highlightSegments(SEGMENTS, [{ id: 'gone', start: 200, end: 260 }])
  assert.equal(rendered(pieces), TEXT)
  assert.ok(
    pieces.every((piece) => piece.ids.length === 0),
    'nothing is marked, because the range names text that is not here',
  )
})

test('an empty or reversed range marks nothing', () => {
  for (const range of [
    { id: 'x', start: 4, end: 4 },
    { id: 'x', start: 9, end: 2 },
    { id: 'x', start: -3, end: 4 },
  ]) {
    const pieces = highlightSegments(SEGMENTS, [range])
    assert.equal(rendered(pieces), TEXT)
    assert.ok(pieces.every((piece) => piece.ids.length === 0))
  }
})

test('no ranges at all returns the paragraph unchanged in shape', () => {
  const pieces = highlightSegments(SEGMENTS, [])
  assert.equal(rendered(pieces), TEXT)
  assert.deepEqual(
    pieces.map((piece) => [piece.kind, piece.text]),
    SEGMENTS.map((segment) => [segment.kind, segment.text]),
  )
})

test('a highlight of the whole paragraph marks every run', () => {
  const pieces = highlightSegments(SEGMENTS, [{ id: 'all', start: 0, end: TEXT.length }])
  assert.equal(rendered(pieces), TEXT)
  assert.ok(pieces.every((piece) => piece.ids.includes('all')))
})
