import test from 'node:test'
import assert from 'node:assert/strict'

/*
 * The note contract, as pure decisions.
 *
 * Everything here is a function of its arguments, so these are exhaustive
 * rather than representative: every scope, every way a manuscript can move
 * underneath an anchor, and every shape of visibility a request or a damaged
 * row could carry. The rules that matter most -- fail private, and never
 * re-attach to text that merely resembles the old text -- are asserted against
 * the inputs that would break them rather than the inputs that confirm them.
 */

import {
  AUTHOR_NOTE_SCOPES,
  MAX_NOTE_BODY_LENGTH,
  MAX_PARAGRAPH_TEXT_LENGTH,
  REVIEWER_NOTE_SCOPES,
  anchorOrder,
  asNoteAnchor,
  asNoteStatus,
  asNoteVisibility,
  capturedText,
  isNoteScope,
  normalizeNoteBody,
  resolveNoteAnchor,
  scopeLabel,
  type AnchorChapter,
  type NoteAnchor,
} from '../lib/note-contract.ts'

const SHA = 'a'.repeat(64)
const MOVED = 'b'.repeat(64)

const FIRST = 'The tide went out further than anyone remembered.'
const SECOND = 'He counted the boats twice and got two different answers.'
const THIRD = 'Nothing in the logbook admitted to either count.'

function chapter(
  paragraphs: readonly string[],
  sha: string = SHA,
  slug = 'chapter-one',
): AnchorChapter {
  return {
    slug,
    sha256: sha,
    paragraphs: paragraphs.map((text, index) => ({
      id: `${slug}-p${String(index + 1).padStart(3, '0')}`,
      ordinal: index + 1,
      text,
    })),
  }
}

function passageAnchor(overrides: Record<string, unknown> = {}): NoteAnchor {
  return {
    scope: 'passage',
    chapterSlug: 'chapter-one',
    chapterNumber: 1,
    chapterLabel: 'Chapter one',
    paragraphId: 'chapter-one-p001',
    paragraphOrdinal: 1,
    startOffset: 4,
    endOffset: 8,
    quote: FIRST.slice(4, 8),
    manuscriptSha256: SHA,
    ...overrides,
  } as NoteAnchor
}

function paragraphAnchor(overrides: Record<string, unknown> = {}): NoteAnchor {
  return {
    scope: 'paragraph',
    chapterSlug: 'chapter-one',
    chapterNumber: 1,
    chapterLabel: 'Chapter one',
    paragraphId: 'chapter-one-p002',
    paragraphOrdinal: 2,
    paragraphText: SECOND,
    manuscriptSha256: SHA,
    ...overrides,
  } as NoteAnchor
}

function chapterAnchor(overrides: Record<string, unknown> = {}): NoteAnchor {
  return {
    scope: 'chapter',
    chapterSlug: 'chapter-one',
    chapterNumber: 1,
    chapterLabel: 'Chapter one',
    manuscriptSha256: SHA,
    ...overrides,
  } as NoteAnchor
}

/* ------------------------------------------------------------------ scopes */

test('the reviewer composer offers three scopes and the author four', () => {
  assert.deepEqual([...REVIEWER_NOTE_SCOPES], ['passage', 'paragraph', 'chapter'])
  assert.deepEqual([...AUTHOR_NOTE_SCOPES], ['passage', 'paragraph', 'chapter', 'book'])
  // The contract supports `book`; the reviewer composer simply does not offer it.
  assert.ok(isNoteScope('book'))
})

test('nothing but the four scopes is a scope', () => {
  for (const value of ['sentence', 'Passage', '', null, undefined, 0, {}, ['passage']]) {
    assert.equal(isNoteScope(value), false, JSON.stringify(value))
  }
})

/* -------------------------------------------------------- fail-private rule */

test('visibility fails private for every value that is not exactly "shared"', () => {
  assert.equal(asNoteVisibility('shared'), 'shared')

  for (const value of [
    undefined,
    null,
    '',
    'private',
    'Shared',
    'SHARED',
    ' shared',
    'shared ',
    'author',
    'link',
    'public',
    'everyone',
    0,
    1,
    true,
    {},
    ['shared'],
  ]) {
    assert.equal(asNoteVisibility(value), 'private', JSON.stringify(value) ?? 'undefined')
  }
})

test('status defaults to open, and only an exact "resolved" resolves', () => {
  assert.equal(asNoteStatus('resolved'), 'resolved')
  for (const value of [undefined, null, '', 'open', 'Resolved', 'done', 0, {}]) {
    assert.equal(asNoteStatus(value), 'open')
  }
})

/* -------------------------------------------------------------------- body */

test('a note body is normalised, and an empty one is refused', () => {
  assert.equal(normalizeNoteBody('  hello  '), 'hello')
  assert.equal(normalizeNoteBody('a\r\nb'), 'a\nb')
  assert.equal(normalizeNoteBody('a\n\n\n\n\nb'), 'a\n\nb')
  // A note with nothing in it is not a note; that is what a highlight is.
  assert.equal(normalizeNoteBody(''), null)
  assert.equal(normalizeNoteBody('   \n\n  '), null)
  assert.equal(normalizeNoteBody(null), null)
  assert.equal(normalizeNoteBody(42), null)
  assert.equal(normalizeNoteBody('x'.repeat(MAX_NOTE_BODY_LENGTH)), 'x'.repeat(MAX_NOTE_BODY_LENGTH))
  assert.equal(normalizeNoteBody('x'.repeat(MAX_NOTE_BODY_LENGTH + 1)), null)
})

/* ------------------------------------------------------------ book anchors */

test('a book note is unanchored, and carries no invented place', () => {
  const anchor = asNoteAnchor({ scope: 'book' })
  assert.deepEqual(anchor, { scope: 'book' })

  const resolution = resolveNoteAnchor({ scope: 'book' }, chapter([FIRST]))
  assert.equal(resolution.state, 'unanchored')
  assert.equal(resolution.paragraphId, null)
  assert.equal(resolution.manuscriptChanged, false)
  assert.equal(capturedText({ scope: 'book' }), null)
  assert.equal(scopeLabel({ scope: 'book' }), 'the whole book')
})

test('a book anchor drops any passage or chapter fields smuggled onto it', () => {
  const anchor = asNoteAnchor({
    scope: 'book',
    chapterSlug: 'chapter-one',
    paragraphId: 'chapter-one-p001',
    quote: 'not mine to carry',
    startOffset: 0,
    endOffset: 4,
  })
  assert.deepEqual(anchor, { scope: 'book' })
})

/* --------------------------------------------------------- chapter anchors */

test('a chapter note stays current while its chapter is released', () => {
  const unchanged = resolveNoteAnchor(chapterAnchor(), chapter([FIRST, SECOND]))
  assert.equal(unchanged.state, 'ok')
  assert.equal(unchanged.manuscriptChanged, false)
})

test('a changed chapter file is version evidence, not a lost chapter note', () => {
  const edited = resolveNoteAnchor(chapterAnchor(), chapter([FIRST, 'rewritten'], MOVED))
  assert.equal(edited.state, 'ok', 'editing a chapter must not orphan the note about it')
  assert.equal(edited.manuscriptChanged, true, 'but which version it was written against is recorded')
})

test('a chapter note needs relocating only when the chapter is no longer released', () => {
  const withdrawn = resolveNoteAnchor(chapterAnchor(), null)
  assert.equal(withdrawn.state, 'needs-relocation')

  const renamed = resolveNoteAnchor(chapterAnchor(), chapter([FIRST], SHA, 'chapter-two'))
  assert.equal(renamed.state, 'needs-relocation')
})

/* ------------------------------------------------------- paragraph anchors */

test('a paragraph note is current while its stored text is still in the chapter', () => {
  const here = resolveNoteAnchor(paragraphAnchor(), chapter([FIRST, SECOND, THIRD]))
  assert.equal(here.state, 'ok')
  assert.equal(here.paragraphId, 'chapter-one-p002')
})

test('a paragraph note follows its text when the paragraphs above it change', () => {
  /*
   * A paragraph inserted at the top renumbers every identifier after it. The
   * note is about the words, not about "the second paragraph", so it follows
   * the words -- and reports where they are now rather than where they were.
   */
  const shifted = resolveNoteAnchor(
    paragraphAnchor(),
    chapter(['A new opening.', FIRST, SECOND, THIRD]),
  )
  assert.equal(shifted.state, 'ok')
  assert.equal(shifted.paragraphId, 'chapter-one-p003')
})

test('a paragraph note is never re-attached to text that merely resembles it', () => {
  const nearly = `${SECOND} `
  const almost = SECOND.replace('twice', 'three times')

  for (const text of [nearly, almost, SECOND.toUpperCase(), SECOND.slice(0, -1)]) {
    const resolution = resolveNoteAnchor(paragraphAnchor(), chapter([FIRST, text, THIRD]))
    assert.equal(resolution.state, 'needs-relocation', JSON.stringify(text))
    assert.equal(resolution.paragraphId, null)
  }
})

test('a paragraph note whose paragraph is gone needs relocating, and says so', () => {
  const removed = resolveNoteAnchor(paragraphAnchor(), chapter([FIRST, THIRD]))
  assert.equal(removed.state, 'needs-relocation')
  assert.equal(removed.paragraphId, null)

  // What it was about is still readable, which is the whole point of capturing it.
  assert.equal(capturedText(paragraphAnchor()), SECOND)
})

test('a paragraph note survives its identifier being reused by different text', () => {
  /*
   * The adversarial shape: the identifier the note carries still exists, and
   * now holds somebody else's words. Matching on the identifier would draw the
   * note over text nobody wrote it about.
   */
  const reused = resolveNoteAnchor(
    paragraphAnchor(),
    chapter([FIRST, 'Entirely different prose.', SECOND]),
  )
  assert.equal(reused.state, 'ok')
  assert.equal(reused.paragraphId, 'chapter-one-p003', 'it followed its own text, not its id')
})

/* --------------------------------------------------------- passage anchors */

test('a passage note is current while the characters at its offsets are its quotation', () => {
  const here = resolveNoteAnchor(passageAnchor(), chapter([FIRST, SECOND]))
  assert.equal(here.state, 'ok')
  assert.equal(here.paragraphId, 'chapter-one-p001')
})

test('a passage note needs relocating when its paragraph is edited underneath it', () => {
  const edited = resolveNoteAnchor(
    passageAnchor(),
    chapter(['Something else entirely at those offsets.', SECOND], MOVED),
  )
  assert.equal(edited.state, 'needs-relocation')
  assert.equal(edited.paragraphId, null)
  assert.equal(edited.manuscriptChanged, true)
})

test('a passage note needs relocating when its paragraph is gone', () => {
  assert.equal(resolveNoteAnchor(passageAnchor(), chapter([SECOND])).state, 'needs-relocation')
  assert.equal(resolveNoteAnchor(passageAnchor(), null).state, 'needs-relocation')
})

test('a passage note keeps its quotation whatever the manuscript now says', () => {
  assert.equal(capturedText(passageAnchor()), FIRST.slice(4, 8))
})

/* ------------------------------------------------------- anchor validation */

test('a half-written anchor is refused rather than handed on with fields missing', () => {
  const bad: unknown[] = [
    null,
    'passage',
    [],
    { scope: 'sentence' },
    { scope: 'chapter' },
    { scope: 'chapter', chapterSlug: 'chapter-one' },
    { scope: 'chapter', chapterSlug: 'chapter-one', manuscriptSha256: SHA },
    { ...(paragraphAnchor() as object), paragraphText: '' },
    { ...(paragraphAnchor() as object), paragraphText: 'x'.repeat(MAX_PARAGRAPH_TEXT_LENGTH + 1) },
    { ...(passageAnchor() as object), quote: '' },
    { ...(passageAnchor() as object), startOffset: -1 },
    { ...(passageAnchor() as object), endOffset: 4 },
    { ...(passageAnchor() as object), startOffset: 1.5 },
    { ...(passageAnchor() as object), manuscriptSha256: '' },
  ]

  for (const value of bad) {
    assert.equal(asNoteAnchor(value), null, JSON.stringify(value) ?? 'null')
  }
})

test('a well-formed anchor of each scope round-trips through validation', () => {
  for (const anchor of [passageAnchor(), paragraphAnchor(), chapterAnchor(), { scope: 'book' } as NoteAnchor]) {
    assert.deepEqual(asNoteAnchor(JSON.parse(JSON.stringify(anchor))), anchor)
  }
})

/* ------------------------------------------------------------------ order */

test('a book note sorts first, then a chapter note, then the notes inside it', () => {
  const order = [
    anchorOrder({ scope: 'book' }),
    anchorOrder(chapterAnchor({ chapterNumber: 1 })),
    anchorOrder(paragraphAnchor({ chapterNumber: 1, paragraphOrdinal: 2 })),
    anchorOrder(passageAnchor({ chapterNumber: 2, paragraphOrdinal: 1 })),
  ]
  assert.deepEqual(order, [
    { chapter: -1, paragraph: -1 },
    { chapter: 1, paragraph: -1 },
    { chapter: 1, paragraph: 2 },
    { chapter: 2, paragraph: 1 },
  ])
})

test('a scope names its own place in plain language', () => {
  assert.equal(scopeLabel(chapterAnchor()), 'Chapter one')
  assert.equal(scopeLabel(paragraphAnchor()), 'paragraph 2')
  assert.equal(scopeLabel(passageAnchor()), 'paragraph 1')
})
