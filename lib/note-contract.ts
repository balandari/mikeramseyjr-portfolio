/**
 * The note contract: one model for everything anybody writes about a manuscript.
 *
 * Before this module there were two competing ways to write something down. A
 * reviewer could *annotate* a selected passage -- editable, with a sharing
 * control -- or *submit a comment* about a paragraph or a chapter, which was
 * immutable, always went to Mike, and could never be corrected or withdrawn.
 * The two lived in different stores, had different shapes, and were offered by
 * two different composers on the same screen. Which one a reviewer used decided
 * whether they could change their mind afterwards, and nothing on the screen
 * said so.
 *
 * A note is the single answer. One record, one composer, one save. What differs
 * between notes is their **scope** -- how much of the book the note is about --
 * and every scope carries the anchor that scope actually needs, and no other.
 *
 * ## Deliberately dependency-free
 *
 * No Node builtins, no Next, no React, no storage. Everything here is a pure
 * function of its arguments, so the same decisions run in the browser, in a
 * server render, in a route handler and directly under `node --test`. The
 * manuscript is never read from here: a caller supplies the chapter it already
 * verified, and this module decides.
 *
 * ## The four scopes, and what each one anchors to
 *
 *   **passage**    character offsets into a paragraph, the quotation captured
 *                  at those offsets, and the chapter file's fingerprint. The
 *                  same anchor `lib/reading-anchor.ts` already defines, because
 *                  a note about a selected passage and a highlight of one are
 *                  about exactly the same thing.
 *
 *   **paragraph**  the paragraph's **complete text**, and the fingerprint. Not
 *                  the paragraph's identifier: a chapter that gains a paragraph
 *                  renumbers every identifier after it, and a note about the
 *                  eleventh paragraph is not a note about whatever is eleventh
 *                  now. The identifier is kept beside the text as a locator, so
 *                  a link can still be offered, but the text is the identity.
 *
 *   **chapter**    the fingerprint, and nothing else. A chapter note is about
 *                  the chapter, so it stays current while the chapter is
 *                  released. A changed fingerprint says which version it was
 *                  written against -- useful evidence, never on its own a
 *                  reason to call a note lost.
 *
 *   **book**       nothing. A book note is explicitly unanchored, and this
 *                  module stores no invented paragraph, offsets or chapter for
 *                  it. A fabricated anchor would be worse than no anchor: it
 *                  would point somewhere, and be wrong.
 *
 * ## Why an anchor never moves
 *
 * The captured quotation and the captured paragraph text are written once, when
 * the passage was selected in a known version of the text, and are never
 * rewritten. That is what lets a note be exported with the words it was about
 * even after the manuscript has moved on. Re-attaching a note to text that
 * merely resembles the old text is the one thing this contract exists to
 * refuse: comparison is character for character, or it is `needs-relocation`.
 */

import { resolveAnchor, MAX_QUOTE_LENGTH } from './reading-anchor.ts'

/** Whose note it is. Same vocabulary as every other owned reading record. */
export type NoteOwnerKind = 'reviewer' | 'author'

/** How much of the book a note is about. */
export type NoteScope = 'passage' | 'paragraph' | 'chapter' | 'book'

/**
 * Who may read a note.
 *
 *   `private`  only the person who wrote it. Not Mike, not anyone.
 *   `shared`   its author, and Mike.
 *
 * There are two states and there is no third. The old annotation vocabulary had
 * `author` and `link` as separate words for two things a reviewer could not
 * tell apart on a control; the note contract says what it means.
 */
export type NoteVisibility = 'private' | 'shared'

/** Whether Mike has dealt with one of his own notes. Reviewer notes stay `open`. */
export type NoteStatus = 'open' | 'resolved'

/** The scopes the reviewer composer offers. `book` is contract-only for them. */
export const REVIEWER_NOTE_SCOPES: readonly NoteScope[] = ['passage', 'paragraph', 'chapter']

/** The scopes the author composer offers. Mike may write about the whole book. */
export const AUTHOR_NOTE_SCOPES: readonly NoteScope[] = [
  'passage',
  'paragraph',
  'chapter',
  'book',
]

/** Longest note body, in characters. The same bound submitted comments had. */
export const MAX_NOTE_BODY_LENGTH = 4000

/**
 * The revision a note is written at, and the revision an older row reads as.
 *
 * A note's `revision` is the **application's** concurrency token: a monotonic
 * integer that starts here and moves by one on every accepted edit. It is not
 * the storage layer's version, which is opaque, driver-specific and invisible
 * to a browser; the two are checked together and neither replaces the other.
 *
 * `updatedAt` is deliberately *not* this token. It is a clock reading, two
 * edits a millisecond apart can share one, and a clock that steps backwards
 * would make an older note look newer. A counter cannot do either.
 */
export const INITIAL_NOTE_REVISION = 1

/**
 * Longest paragraph text a paragraph anchor will capture.
 *
 * Generous on purpose -- it has to hold the longest paragraph in the manuscript
 * whole, because a paragraph anchor that stored a truncated paragraph would be
 * comparing a prefix and calling it the paragraph. A paragraph longer than this
 * cannot be anchored at paragraph scope; the passage scope still can.
 */
export const MAX_PARAGRAPH_TEXT_LENGTH = 20000

/* ------------------------------------------------------------------ anchors */

export type PassageNoteAnchor = {
  scope: 'passage'
  chapterSlug: string
  /** The chapter's number, so a note sorts and exports without the manuscript. */
  chapterNumber: number
  chapterLabel: string
  /** Locator. The identity is the quotation at the offsets, not this. */
  paragraphId: string
  paragraphOrdinal: number
  /** Inclusive character offset into the paragraph's reading text. */
  startOffset: number
  /** Exclusive character offset into the paragraph's reading text. */
  endOffset: number
  /** The captured quotation, copied from the manuscript server-side. */
  quote: string
  /** `sha256` of the chapter file the offsets were measured in. */
  manuscriptSha256: string
}

export type ParagraphNoteAnchor = {
  scope: 'paragraph'
  chapterSlug: string
  /** The chapter's number, so a note sorts and exports without the manuscript. */
  chapterNumber: number
  chapterLabel: string
  /** Locator, kept so a link can be offered. Never the identity -- see above. */
  paragraphId: string
  paragraphOrdinal: number
  /** The paragraph, whole, exactly as it read when the note was written. */
  paragraphText: string
  manuscriptSha256: string
}

export type ChapterNoteAnchor = {
  scope: 'chapter'
  chapterSlug: string
  chapterNumber: number
  chapterLabel: string
  manuscriptSha256: string
}

/** A book note anchors to nothing, and says so rather than inventing a place. */
export type BookNoteAnchor = { scope: 'book' }

export type NoteAnchor =
  | PassageNoteAnchor
  | ParagraphNoteAnchor
  | ChapterNoteAnchor
  | BookNoteAnchor

/**
 * Whether a note still points at the text it was written about.
 *
 *   `ok`                the anchor resolves, exactly.
 *   `needs-relocation`  it does not. What was captured is shown; nothing is
 *                       drawn over whatever occupies the place now.
 *   `unanchored`        there was never a place. Only a book note is this, and
 *                       it is not a failure -- it is the scope working.
 */
export type NoteAnchorState = 'ok' | 'needs-relocation' | 'unanchored'

/**
 * The chapter an anchor is re-checked against, reduced to what the decision
 * needs. A caller builds this from the verified manuscript; this module never
 * loads one.
 *
 * `null` in place of this value means the chapter is no longer released -- it
 * was withdrawn, renamed, or never existed. That is the one thing that puts a
 * chapter note out of date.
 */
export type AnchorChapter = {
  slug: string
  sha256: string
  paragraphs: readonly { id: string; ordinal: number; text: string }[]
}

/** What a re-check came to, and where the note points now if it still points. */
export type NoteAnchorResolution = {
  state: NoteAnchorState
  /**
   * The paragraph to link to, when there is one and it resolved.
   *
   * For a paragraph anchor whose text has moved within its chapter, this is the
   * paragraph that **currently** holds that exact text -- which may not be the
   * identifier the note was written with. Nothing here is a guess: the text
   * matched character for character, or this is null.
   */
  paragraphId: string | null
  /**
   * True when the chapter file has changed since the note was written.
   *
   * Version evidence, never a verdict. A chapter note with a changed
   * fingerprint is still `ok`; editing one line of a chapter must not put every
   * note in it out of date.
   */
  manuscriptChanged: boolean
}

/**
 * Re-check one anchor against the chapter as it is now.
 *
 * Every scope is decided by its own rule, and no rule is allowed to borrow
 * another's leniency:
 *
 *   **book**       always `unanchored`. There is nothing to check.
 *
 *   **chapter**    `ok` while the chapter is released. A moved fingerprint is
 *                  reported and is not a verdict.
 *
 *   **paragraph**  `ok` when some paragraph of the released chapter reads
 *                  **exactly** as the captured text. The identifier is tried
 *                  first because it is usually right and the comparison is
 *                  cheap; the chapter is then scanned, so a note survives text
 *                  above it being added or removed. An approximate match is
 *                  never accepted.
 *
 *   **passage**    `lib/reading-anchor.ts`'s rule, unchanged: the paragraph
 *                  must still be there, the offsets must still fit, and the
 *                  characters at them must still be the quotation.
 */
export function resolveNoteAnchor(
  anchor: NoteAnchor,
  chapter: AnchorChapter | null,
): NoteAnchorResolution {
  if (anchor.scope === 'book') {
    return { state: 'unanchored', paragraphId: null, manuscriptChanged: false }
  }

  if (chapter === null || chapter.slug !== anchor.chapterSlug) {
    return { state: 'needs-relocation', paragraphId: null, manuscriptChanged: false }
  }

  const manuscriptChanged = chapter.sha256 !== anchor.manuscriptSha256

  if (anchor.scope === 'chapter') {
    return { state: 'ok', paragraphId: null, manuscriptChanged }
  }

  if (anchor.scope === 'paragraph') {
    const named = chapter.paragraphs.find((paragraph) => paragraph.id === anchor.paragraphId)
    if (named && named.text === anchor.paragraphText) {
      return { state: 'ok', paragraphId: named.id, manuscriptChanged }
    }
    // The text is the identity, so a paragraph that moved is still the one this
    // note is about. Exact equality only -- "looks like it" is what this refuses.
    const moved = chapter.paragraphs.find(
      (paragraph) => paragraph.text === anchor.paragraphText,
    )
    if (moved) return { state: 'ok', paragraphId: moved.id, manuscriptChanged }
    return { state: 'needs-relocation', paragraphId: null, manuscriptChanged }
  }

  const paragraph = chapter.paragraphs.find((entry) => entry.id === anchor.paragraphId)
  const state = resolveAnchor(anchor, paragraph ? paragraph.text : null)
  return {
    state,
    paragraphId: state === 'ok' ? anchor.paragraphId : null,
    manuscriptChanged,
  }
}

/* -------------------------------------------------------------- normalising */

export function isNoteScope(value: unknown): value is NoteScope {
  return value === 'passage' || value === 'paragraph' || value === 'chapter' || value === 'book'
}

/**
 * The visibility of a note, failing **private**.
 *
 * Missing, misspelled, `null`, a number, an old vocabulary word, a value from a
 * future schema: every one of them answers `private`. There is no input to this
 * function that widens who can read a note by accident, which is the only safe
 * direction for a default to fail in. Widening is always an explicit,
 * recognised `'shared'`.
 */
export function asNoteVisibility(value: unknown): NoteVisibility {
  return value === 'shared' ? 'shared' : 'private'
}

/** A note's status, defaulting to `open`. Anything unrecognised is `open`. */
export function asNoteStatus(value: unknown): NoteStatus {
  return value === 'resolved' ? 'resolved' : 'open'
}

/**
 * The revision **on a stored row**, reading an old or damaged one as the first.
 *
 * Every note written before this field existed is a valid note that has been
 * edited zero times, so it is revision 1 -- and so is a row whose revision was
 * damaged into a string, a fraction, a negative, `NaN` or an object. Refusing
 * such a row would lose what somebody wrote over a bookkeeping field, which is
 * the trade `asNoteVisibility` and `asNoteStatus` already refuse to make.
 *
 * Reading damage as 1 is safe in the only direction that matters: the client's
 * expected revision must **equal** this, so a damaged row at worst refuses an
 * edit made against a number it no longer reports. It never silently accepts
 * one. The very next accepted edit writes a sound revision back.
 */
export function asNoteRevision(value: unknown): number {
  if (typeof value !== 'number') return INITIAL_NOTE_REVISION
  if (!Number.isSafeInteger(value) || value < INITIAL_NOTE_REVISION) {
    return INITIAL_NOTE_REVISION
  }
  return value
}

/**
 * The revision **a request claims to have rendered**, or null if it claims none.
 *
 * Deliberately stricter than `asNoteRevision`. A stored row is something this
 * codebase already accepted and must not lose; an expected revision is an
 * assertion a caller is making about what they were looking at, and a caller
 * who cannot state it correctly has not made the assertion. Missing, `null`, a
 * string, a fraction or a zero is therefore invalid input rather than a
 * silently assumed 1 -- because assuming 1 is exactly how a blind write gets
 * through on a note that has been edited since.
 */
export function asExpectedNoteRevision(value: unknown): number | null {
  if (typeof value !== 'number') return null
  if (!Number.isSafeInteger(value) || value < INITIAL_NOTE_REVISION) return null
  return value
}

/**
 * Normalise a note's body, or refuse it.
 *
 * `null` means "there is nothing to store", and a note with nothing written in
 * it is not a note -- that is what a highlight is, and a highlight is a
 * different record. So the caller refuses rather than writing a blank row.
 */
export function normalizeNoteBody(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (text === '') return null
  if (text.length > MAX_NOTE_BODY_LENGTH) return null
  return text
}

/* ---------------------------------------------------------- anchor validity */

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function isOrdinal(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * Accept a stored anchor only if it really is one of this contract's anchors.
 *
 * A half-written, hand-edited or foreign-schema anchor is refused rather than
 * handed on with fields missing: these values build links back into the
 * manuscript and are rendered as the words a reviewer wrote about.
 */
export function asNoteAnchor(value: unknown): NoteAnchor | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>

  if (row.scope === 'book') return { scope: 'book' }

  if (!isNonEmptyString(row.chapterSlug)) return null
  if (!isNonEmptyString(row.manuscriptSha256)) return null

  if (row.scope === 'chapter') {
    if (!isOrdinal(row.chapterNumber)) return null
    if (typeof row.chapterLabel !== 'string') return null
    return {
      scope: 'chapter',
      chapterSlug: row.chapterSlug,
      chapterNumber: row.chapterNumber,
      chapterLabel: row.chapterLabel,
      manuscriptSha256: row.manuscriptSha256,
    }
  }

  if (!isOrdinal(row.chapterNumber)) return null
  if (typeof row.chapterLabel !== 'string') return null
  if (!isNonEmptyString(row.paragraphId)) return null
  if (!isOrdinal(row.paragraphOrdinal)) return null

  if (row.scope === 'paragraph') {
    if (!isNonEmptyString(row.paragraphText)) return null
    if (row.paragraphText.length > MAX_PARAGRAPH_TEXT_LENGTH) return null
    return {
      scope: 'paragraph',
      chapterSlug: row.chapterSlug,
      chapterNumber: row.chapterNumber,
      chapterLabel: row.chapterLabel,
      paragraphId: row.paragraphId,
      paragraphOrdinal: row.paragraphOrdinal,
      paragraphText: row.paragraphText,
      manuscriptSha256: row.manuscriptSha256,
    }
  }

  if (row.scope === 'passage') {
    if (typeof row.startOffset !== 'number' || !Number.isInteger(row.startOffset)) return null
    if (typeof row.endOffset !== 'number' || !Number.isInteger(row.endOffset)) return null
    if (row.startOffset < 0 || row.endOffset <= row.startOffset) return null
    if (!isNonEmptyString(row.quote)) return null
    if (row.quote.length > MAX_QUOTE_LENGTH) return null
    return {
      scope: 'passage',
      chapterSlug: row.chapterSlug,
      chapterNumber: row.chapterNumber,
      chapterLabel: row.chapterLabel,
      paragraphId: row.paragraphId,
      paragraphOrdinal: row.paragraphOrdinal,
      startOffset: row.startOffset,
      endOffset: row.endOffset,
      quote: row.quote,
      manuscriptSha256: row.manuscriptSha256,
    }
  }

  return null
}

/** The chapter a note is about, or null for a book note. */
export function anchorChapterSlug(anchor: NoteAnchor): string | null {
  return anchor.scope === 'book' ? null : anchor.chapterSlug
}

/**
 * Where a note sorts: which chapter, then which paragraph.
 *
 * A book note comes first, because it is about everything and does not belong
 * wedged between two paragraphs of chapter four. A chapter note comes before
 * the notes inside that chapter, for the same reason at a smaller scale.
 */
export function anchorOrder(anchor: NoteAnchor): { chapter: number; paragraph: number } {
  if (anchor.scope === 'book') return { chapter: -1, paragraph: -1 }
  if (anchor.scope === 'chapter') return { chapter: anchor.chapterNumber, paragraph: -1 }
  return { chapter: anchor.chapterNumber, paragraph: anchor.paragraphOrdinal }
}

/**
 * The words a note is about, for a list or an export, whatever its scope.
 *
 * Always the **captured** text, never the manuscript as it is now. That is the
 * point of capturing it: a note has to be readable beside the passage it
 * concerned even after that passage has been rewritten or removed.
 */
export function capturedText(anchor: NoteAnchor): string | null {
  if (anchor.scope === 'passage') return anchor.quote
  if (anchor.scope === 'paragraph') return anchor.paragraphText
  return null
}

/** A plain-language name for a scope, used in the reader and in a listing. */
export function scopeLabel(anchor: NoteAnchor): string {
  if (anchor.scope === 'book') return 'the whole book'
  if (anchor.scope === 'chapter') return anchor.chapterLabel || 'this chapter'
  return `paragraph ${anchor.paragraphOrdinal}`
}
