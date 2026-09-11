/**
 * What reviewers have sent Mike: shared annotations, and submitted feedback.
 *
 * This is the one place in the codebase that reads across reviewers, and it is
 * the only place that legitimately can: the author is entitled to what was
 * shared with him. It is therefore written to be obviously narrow.
 *
 *   - The list of reviewers comes from the roster, which the administrator
 *     dashboard already reads under the same session.
 *   - For each reviewer, only the books that reviewer is entitled to are
 *     consulted, from that reviewer's own prefix, one book at a time.
 *   - Every annotation is then put past `canViewAnnotation` **as the author**.
 *     A reviewer's explicitly private annotation fails that test and is dropped,
 *     so it is never rendered, never counted, and never named.
 *
 * Feedback is different in kind and is treated differently: a comment is
 * submitted *to Mike* deliberately, so every submitted comment is his to read.
 * It is read through the existing append-only store and passed through
 * unchanged -- shown, never edited, never removed.
 */

import { findBook, findReleasedChapter } from './manuscript.ts'
import { canViewAnnotation, type Viewer } from './reading-access.ts'
import { createReadingStore, type Annotation } from './reviewer-reading.ts'
import { createFeedbackStore } from './reviewer-feedback.ts'
import { loadAdminView } from './reviewer-admin.ts'
import { resolveAnchorFor } from './reading-anchor-server.ts'

if (typeof window !== 'undefined') {
  throw new Error(
    'lib/author-inbox is server-only and must not be imported by a client component',
  )
}

export type InboxAnnotation = {
  id: string
  reviewerId: string
  reviewerName: string
  bookSlug: string
  bookTitle: string
  chapterSlug: string
  chapterLabel: string
  paragraphId: string
  paragraphOrdinal: number
  quote: string
  note: string | null
  visibility: Annotation['visibility']
  createdAt: string
  anchorOk: boolean
  /** Where to open the passage, in the author's own reading routes. */
  href: string
}

export type InboxComment = {
  id: string
  reviewerId: string
  reviewerName: string
  bookSlug: string
  bookTitle: string
  chapterSlug: string
  chapterLabel: string
  paragraphId: string | null
  paragraphOrdinal: number | null
  quote: string | null
  comment: string
  createdAt: string
  href: string
}

export type AuthorInbox = {
  annotations: InboxAnnotation[]
  comments: InboxComment[]
  /** True when the roster could not be read, so "nothing here" is not claimed. */
  incomplete: boolean
}

/**
 * Everything reviewers have shared with the author.
 *
 * A failure to read the roster, or one reviewer's records, sets `incomplete`
 * rather than being swallowed. An empty inbox and an unreadable one look the
 * same on a page unless the page is told the difference, and "no one has said
 * anything about your book" is not a thing to tell somebody by accident.
 */
export async function loadAuthorInbox(viewer: Viewer): Promise<AuthorInbox> {
  if (viewer.kind !== 'author') return { annotations: [], comments: [], incomplete: false }

  let reviewers: { id: string; name: string; books: string[] }[]
  try {
    const view = await loadAdminView()
    reviewers = view.reviewers.map((entry) => ({
      id: entry.id,
      name: entry.name,
      books: entry.books,
    }))
  } catch {
    return { annotations: [], comments: [], incomplete: true }
  }

  const store = createReadingStore()
  const feedback = createFeedbackStore()

  const annotations: InboxAnnotation[] = []
  const comments: InboxComment[] = []
  let incomplete = false

  for (const reviewer of reviewers) {
    for (const bookSlug of reviewer.books) {
      const book = findBook(bookSlug)
      if (!book) continue

      try {
        const rows = await store.listAnnotations({ kind: 'reviewer', id: reviewer.id }, bookSlug)
        for (const row of rows) {
          // The author's visibility test, applied to every row without
          // exception. A `private` annotation never gets past this line.
          if (!canViewAnnotation(viewer, row)) continue

          const chapter = findReleasedChapter(book, row.chapterSlug)
          annotations.push({
            id: row.id,
            reviewerId: reviewer.id,
            reviewerName: reviewer.name,
            bookSlug: book.slug,
            bookTitle: book.title,
            chapterSlug: row.chapterSlug,
            chapterLabel: chapter?.label ?? row.chapterLabel,
            paragraphId: row.paragraphId,
            paragraphOrdinal: row.paragraphOrdinal,
            quote: row.quote,
            note: row.note,
            visibility: row.visibility,
            createdAt: row.createdAt,
            anchorOk: resolveAnchorFor(book, row) === 'ok',
            href: `/admin/read/${book.slug}/${row.chapterSlug}#${row.paragraphId}`,
          })
        }
      } catch {
        incomplete = true
      }

      try {
        const rows = await feedback.listForReviewer(reviewer.id, bookSlug)
        for (const row of rows) {
          const chapter = findReleasedChapter(book, row.chapterSlug)
          comments.push({
            id: row.id,
            reviewerId: reviewer.id,
            reviewerName: reviewer.name,
            bookSlug: book.slug,
            bookTitle: book.title,
            chapterSlug: row.chapterSlug,
            chapterLabel: chapter?.label ?? row.chapterSlug,
            paragraphId: row.paragraphId,
            paragraphOrdinal: row.paragraphOrdinal,
            quote: row.quote,
            comment: row.comment,
            createdAt: row.createdAt,
            href: row.paragraphId
              ? `/admin/read/${book.slug}/${row.chapterSlug}#${row.paragraphId}`
              : `/admin/read/${book.slug}/${row.chapterSlug}`,
          })
        }
      } catch {
        incomplete = true
      }
    }
  }

  // Newest first: this is a thing Mike checks, so the order is the order things
  // arrived, unlike the workspace, which is ordered as the book is read.
  annotations.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  comments.sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  return { annotations, comments, incomplete }
}
