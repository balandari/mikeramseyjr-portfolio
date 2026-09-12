/**
 * Passage anchoring: how a highlight, a note or a bookmark says *where* it is.
 *
 * This module is deliberately dependency-free -- no Node builtins, no Next, no
 * React -- so the same decisions run in the browser, in a server render, in a
 * route handler, and directly under `node --test`. Everything here is a pure
 * function of its arguments.
 *
 * ## What identifies a passage, and what must never identify one
 *
 * An anchor is (book, chapter, paragraph id, character offsets) together with
 * the exact quotation that was captured and the fingerprint of the chapter file
 * it was captured from.
 *
 *   - The **paragraph id** is `chapterSlug-pNNN`. It is derived from the
 *     paragraph's ordinal within the chapter, which is computed after the
 *     source has been folded into blocks -- so re-wrapping the manuscript's
 *     lines cannot renumber it.
 *
 *   - The **character offsets** are measured against the paragraph's *reading
 *     text*: its inline segments joined, which is exactly the run of characters
 *     the reader displays and exactly what a browser selection measures. They
 *     are not byte offsets and not source offsets.
 *
 *   - **Visual line numbers are never used, and could not be.** A line is a
 *     consequence of viewport width, text size, the reader's chosen theme and
 *     the font that happened to load. The same paragraph is four lines on a
 *     phone and two on a laptop, and changes under a reader who rotates their
 *     device. An identity that moves when a device is turned sideways is not an
 *     identity.
 *
 *   - The **quotation** is stored with the anchor, and the **chapter
 *     fingerprint** (`sha256` from the manuscript manifest) records which
 *     version of the text the offsets were measured in.
 *
 * ## What happens when the manuscript is edited underneath an anchor
 *
 * `resolveAnchor` re-reads the paragraph and compares. An anchor is `ok` only
 * when the paragraph still exists, the offsets still fit, and the characters at
 * those offsets are still *character for character* the quotation that was
 * captured. Anything else is `needs-relocation`: the saved quotation is shown,
 * the item is labelled as needing relocation, and it is never drawn over
 * whatever text now occupies those offsets.
 *
 * The fingerprint alone is not used to decide this, and that is deliberate in
 * both directions. A changed fingerprint does not condemn an anchor -- editing
 * chapter three's last line must not orphan every note in the chapter -- and an
 * unchanged fingerprint is not accepted as proof either, because the comparison
 * that actually matters is cheap and exact. The fingerprint is recorded so that
 * a later tool can tell *which* version an anchor was made against.
 */

/**
 * One run of the paragraph's text, as the manuscript module produces it.
 *
 * The kinds are presentational and this module does not care which is which:
 * offsets are measured against `segmentsText`, the concatenation of every run's
 * characters, which is exactly what a browser selection measures against. A
 * mark added to the manuscript format therefore changes nothing here.
 */
export type InlineSegment = {
  kind: 'text' | 'emphasis' | 'strong' | 'code'
  text: string
  /** The mark this run sits inside, when the manuscript nested one. */
  within?: 'emphasis' | 'strong'
}

/** Longest quotation an anchor may capture. A note is for a passage, not a chapter. */
export const MAX_QUOTE_LENGTH = 1200

/** Longest note a reviewer may attach to a passage. */
export const MAX_NOTE_LENGTH = 4000

/** Longest excerpt stored beside a bookmark, so a list reads without the book. */
export const MAX_EXCERPT_LENGTH = 180

/**
 * Whether an anchor still points at the text it was made against.
 *
 * There is no third state on purpose. "Probably still right" is the thing this
 * module exists to refuse.
 */
export type AnchorState = 'ok' | 'needs-relocation'

/** The stored location of a passage, independent of any storage driver. */
export type PassageAnchor = {
  chapterSlug: string
  paragraphId: string
  paragraphOrdinal: number
  /** Inclusive character offset into the paragraph's reading text. */
  startOffset: number
  /** Exclusive character offset into the paragraph's reading text. */
  endOffset: number
  /** The captured quotation, copied from the manuscript when the anchor was made. */
  quote: string
  /** `sha256` of the chapter file the offsets were measured in. */
  manuscriptSha256: string
}

/**
 * The paragraph's reading text: its segments joined.
 *
 * This is the string the reader displays, so it is the string a browser
 * selection measures against, so it is the string offsets mean. It is not the
 * manuscript source -- the source carries the asterisks that mark emphasis, and
 * those are not on the page.
 */
export function segmentsText(segments: InlineSegment[]): string {
  return segments.map((segment) => segment.text).join('')
}

/**
 * Accept a pair of offsets only if it describes a real, non-empty span inside
 * a paragraph of the given length. Returns null rather than repairing: a
 * selection this module cannot make sense of must not be silently turned into
 * a different one.
 */
export function normalizeOffsets(
  start: unknown,
  end: unknown,
  length: number,
): { start: number; end: number } | null {
  if (typeof start !== 'number' || typeof end !== 'number') return null
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null
  if (start < 0 || end < 0) return null
  if (start >= end) return null
  if (end > length) return null
  if (end - start > MAX_QUOTE_LENGTH) return null
  return { start, end }
}

/**
 * Decide whether an anchor still describes the passage it was made against.
 *
 * `paragraphText` is null when the paragraph is no longer in the chapter at
 * all -- it was deleted, or the chapter was shortened past it.
 */
export function resolveAnchor(
  anchor: Pick<PassageAnchor, 'startOffset' | 'endOffset' | 'quote'>,
  paragraphText: string | null,
): AnchorState {
  if (paragraphText === null) return 'needs-relocation'
  if (anchor.endOffset > paragraphText.length) return 'needs-relocation'
  if (anchor.startOffset >= anchor.endOffset) return 'needs-relocation'
  if (anchor.startOffset < 0) return 'needs-relocation'
  return paragraphText.slice(anchor.startOffset, anchor.endOffset) === anchor.quote
    ? 'ok'
    : 'needs-relocation'
}

/**
 * A short, single-line excerpt for a list.
 *
 * Whitespace is collapsed because a manuscript paragraph may have been
 * hard-wrapped, and a bookmark list is not the place to reproduce the wrapping.
 * The ellipsis is the single character, not three dots.
 */
export function excerptFrom(text: string, limit: number = MAX_EXCERPT_LENGTH): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  // Prefer to break at a word so the excerpt does not end mid-word; fall back
  // to a hard cut when there is no space in range (a very long token).
  const cut = flat.slice(0, limit)
  const space = cut.lastIndexOf(' ')
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/* ------------------------------------------------------------- highlighting */

/** One annotation's span within a paragraph, for rendering. */
export type HighlightRange = { id: string; start: number; end: number }

/** One run of paragraph text, carrying the ids of every annotation covering it. */
export type HighlightPiece = {
  kind: InlineSegment['kind']
  within?: InlineSegment['within']
  text: string
  /** Annotation ids covering this run. Empty for unmarked prose. */
  ids: string[]
}

/**
 * Split a paragraph's segments so that every highlighted span is its own run.
 *
 * Emphasis is preserved: a highlight that begins mid-italic produces an
 * emphasised marked run and an emphasised unmarked one, rather than flattening
 * the italics to make the marking simpler. Overlapping annotations are not
 * merged either -- a run covered by two notes carries both ids, so tapping it
 * can offer both.
 *
 * Ranges outside the paragraph are dropped rather than clamped. A clamped range
 * would draw a mark over text nobody selected, which is precisely the silent
 * re-attachment this feature must never perform.
 */
export function highlightSegments(
  segments: InlineSegment[],
  ranges: HighlightRange[],
): HighlightPiece[] {
  const total = segmentsText(segments).length

  const usable = ranges.filter(
    (range) =>
      Number.isInteger(range.start) &&
      Number.isInteger(range.end) &&
      range.start >= 0 &&
      range.end <= total &&
      range.start < range.end,
  )

  // Every point at which the set of covering annotations, or the segment, can
  // change. Sorted and de-duplicated, these are the cut points.
  const cuts = new Set<number>([0, total])
  let running = 0
  for (const segment of segments) {
    running += segment.text.length
    cuts.add(running)
  }
  for (const range of usable) {
    cuts.add(range.start)
    cuts.add(range.end)
  }

  const points = Array.from(cuts).sort((a, b) => a - b)
  const pieces: HighlightPiece[] = []

  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index]
    const to = points[index + 1]
    if (to <= from) continue

    // Which segment this run falls in. A run never straddles one, because every
    // segment boundary is a cut point.
    let offset = 0
    let kind: InlineSegment['kind'] = 'text'
    let within: InlineSegment['within']
    let text = ''
    for (const segment of segments) {
      const segmentEnd = offset + segment.text.length
      if (from >= offset && from < segmentEnd) {
        kind = segment.kind
        within = segment.within
        text = segment.text.slice(from - offset, to - offset)
        break
      }
      offset = segmentEnd
    }
    if (text === '') continue

    pieces.push({
      kind,
      within,
      text,
      ids: usable
        .filter((range) => range.start <= from && range.end >= to)
        .map((range) => range.id),
    })
  }

  return pieces
}
