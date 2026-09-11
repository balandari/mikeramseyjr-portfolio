/**
 * Re-checking an anchor against a loaded book.
 *
 * `lib/reading-anchor.ts` is deliberately pure and knows nothing about the
 * manuscript module; this is the one-line bridge between them, so that every
 * caller that needs "is this anchor still right?" asks the same question in the
 * same way rather than reaching for `findParagraph` and comparing by hand.
 */

import { findParagraph, findReleasedChapter, type ReaderBook } from './manuscript.ts'
import { resolveAnchor, type AnchorState } from './reading-anchor.ts'

export function resolveAnchorFor(
  book: ReaderBook,
  anchor: {
    chapterSlug: string
    paragraphId: string
    startOffset: number
    endOffset: number
    quote: string
  },
): AnchorState {
  const chapter = findReleasedChapter(book, anchor.chapterSlug)
  const text = chapter ? (findParagraph(chapter, anchor.paragraphId)?.text ?? null) : null
  return resolveAnchor(anchor, text)
}
