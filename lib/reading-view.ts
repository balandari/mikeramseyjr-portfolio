/**
 * The shapes that cross from the server to the browser.
 *
 * This module is pure -- no Node builtins, no Next, no React -- so a server
 * module and a client component can both import it without either dragging the
 * other's dependencies along. That matters here: the workspace is assembled on
 * the server and rendered in the browser, and if the two described their data
 * separately they would eventually describe it differently.
 *
 * Nothing in these shapes is secret to the person receiving them. A viewer is
 * only ever sent records they are entitled to see, decided by
 * `lib/reading-access.ts` before serialisation -- so the quotation, the note and
 * the private link are all things the recipient already has the right to. What
 * never appears here is a storage pathname, a credential, another person's
 * record, or a share token for a link the viewer did not create.
 */

import type { AnchorState } from './reading-anchor.ts'

export type Visibility = 'private' | 'author' | 'link'

export type ClientPosition = {
  bookSlug: string
  bookTitle: string
  chapterSlug: string
  chapterNumber: number
  chapterLabel: string
  paragraphId: string | null
  paragraphOrdinal: number | null
  /** 0 to 1 through the paragraph. Absent on older records. */
  paragraphOffset?: number
  /**
   * Which of the reader's own devices wrote this, and that device's counter.
   *
   * Ordering metadata, described in `lib/reading-order.ts`. It is the reader's
   * own, it names nobody, and it authorizes nothing -- it travels only so a
   * browser can tell whether the save it is still waiting on has landed.
   * Absent on every record written before ordering existed.
   */
  device?: string
  sequence?: number
  /** The newest sequence accepted from each recent device, oldest first. */
  devices?: { id: string; seq: number }[]
  updatedAt: string
}

export type ClientBookmark = {
  id: string
  bookSlug: string
  chapterSlug: string
  chapterNumber: number
  chapterLabel: string
  paragraphId: string
  paragraphOrdinal: number
  excerpt: string
  createdAt: string
  anchorState: AnchorState
  chapterExists: boolean
}

export type ClientAnnotation = {
  id: string
  bookSlug: string
  chapterSlug: string
  chapterNumber: number
  chapterLabel: string
  paragraphId: string
  paragraphOrdinal: number
  startOffset: number
  endOffset: number
  quote: string
  note: string | null
  visibility: Visibility
  shareToken: string | null
  sharePath: string | null
  createdAt: string
  updatedAt: string
  anchorState: AnchorState
  chapterExists: boolean
  own: boolean
}

/**
 * One note, as the browser receives it.
 *
 * The same shape whoever wrote it and whatever its scope. A reader never has to
 * work out for itself whether a note still points at the text it was written
 * about: the server has already re-checked the anchor and says so here.
 */
export type ClientNote = {
  id: string
  ownerKind: 'reviewer' | 'author'
  ownerId: string
  bookSlug: string
  scope: 'passage' | 'paragraph' | 'chapter' | 'book'
  body: string
  visibility: 'private' | 'shared'
  status: 'open' | 'resolved'
  anchor: ClientNoteAnchor
  /**
   * Which version of this note the browser is holding.
   *
   * Sent back on every update so the server can refuse a save composed against
   * a version that is no longer stored. It is a counter, not a timestamp, and
   * it is the reader's own note's -- it names nobody and authorizes nothing.
   */
  revision: number
  createdAt: string
  updatedAt: string
  anchorState: 'ok' | 'needs-relocation' | 'unanchored'
  manuscriptChanged: boolean
  /** Where it points now, or null. For a moved paragraph note, where the text is. */
  paragraphId: string | null
  own: boolean
}

/** The anchor as it crosses to the browser. One shape per scope, and no other. */
export type ClientNoteAnchor =
  | {
      scope: 'passage'
      chapterSlug: string
      chapterNumber: number
      chapterLabel: string
      paragraphId: string
      paragraphOrdinal: number
      startOffset: number
      endOffset: number
      quote: string
      manuscriptSha256: string
    }
  | {
      scope: 'paragraph'
      chapterSlug: string
      chapterNumber: number
      chapterLabel: string
      paragraphId: string
      paragraphOrdinal: number
      paragraphText: string
      manuscriptSha256: string
    }
  | {
      scope: 'chapter'
      chapterSlug: string
      chapterNumber: number
      chapterLabel: string
      manuscriptSha256: string
    }
  | { scope: 'book' }

/**
 * One submitted comment, as the workspace shows it back. Never editable.
 *
 * The retired model. New writing is a note; these rows are history, are shown
 * under the label "Earlier submitted comments" wherever they appear, and are
 * never rewritten.
 */
export type WorkspaceFeedback = {
  id: string
  scope: 'paragraph' | 'chapter'
  chapterSlug: string
  chapterLabel: string
  paragraphId: string | null
  paragraphOrdinal: number | null
  quote: string | null
  comment: string
  createdAt: string
}

/** Everything one person has in one book, ready to render. */
export type WorkspaceBook = {
  slug: string
  title: string
  /** `/review/<slug>` or `/admin/read/<slug>` -- the prefix for every link back. */
  base: string
  position: ClientPosition | null
  bookmarks: ClientBookmark[]
  annotations: ClientAnnotation[]
  notes: ClientNote[]
  feedback: WorkspaceFeedback[]
  /** Chapter order and labels, so items group and sort as the book does. */
  chapters: { slug: string; number: number; label: string }[]
}
