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

/** One submitted comment, as the workspace shows it back. Never editable. */
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
  feedback: WorkspaceFeedback[]
  /** Chapter order and labels, so items group and sort as the book does. */
  chapters: { slug: string; number: number; label: string }[]
}
