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
import { capturedText, scopeLabel } from './note-contract.ts'
import {
  listSharedReviewerNotes,
  readableBookSlugs,
  type SharedReviewerNote,
} from './note-service.ts'

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

/**
 * One reviewer note shared with the author.
 *
 * Gathered by book rather than by reviewer, so it survives the reading
 * arrangement that produced it: a reviewer who has finished, been revoked, or
 * had this book withdrawn is still here with exactly what they shared. When the
 * roster can name them it does; when it cannot, the note is still shown and
 * `reviewerName` falls back to the identifier. A note is never dropped because
 * the person who wrote it is no longer on a list.
 */
export type InboxNote = {
  id: string
  reviewerId: string
  reviewerName: string
  bookSlug: string
  bookTitle: string
  scope: SharedReviewerNote['scope']
  /** How the note names its own place, in plain language. */
  where: string
  /** The words it was written about, as captured. Null for a chapter or book note. */
  captured: string | null
  body: string
  createdAt: string
  updatedAt: string
  anchorOk: boolean
  /** True when the chapter file has moved since. Evidence, never a verdict. */
  manuscriptChanged: boolean
  /** Where to open it, in the author's own reading routes. */
  href: string
}

export type AuthorInbox = {
  /** Reviewer notes written under the note contract, and shared with Mike. */
  notes: InboxNote[]
  annotations: InboxAnnotation[]
  /** The retired model. Labelled "Earlier submitted comments" wherever shown. */
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
  if (viewer.kind !== 'author') {
    return { notes: [], annotations: [], comments: [], incomplete: false }
  }

  /*
   * Notes first, and deliberately before the roster is consulted.
   *
   * `listSharedReviewerNotes` reads a prefix on the book, so what a reviewer
   * shared is here whether or not the roster can be read and whether or not it
   * still names them. An unreadable roster costs the notes their author's
   * display name and nothing else -- it cannot make a shared note disappear.
   */
  let notes: InboxNote[] = []
  let incomplete = false
  try {
    notes = await gatherNotes(viewer)
  } catch {
    /*
     * The same stance the rest of this file takes: an unreadable section is an
     * absence *with a reason*, never a confident empty list. "Nothing has been
     * shared with you yet" is not a thing to tell somebody by accident when the
     * truth is that the store could not be reached.
     */
    incomplete = true
  }

  let reviewers: { id: string; name: string; books: string[] }[]
  try {
    const view = await loadAdminView()
    reviewers = view.reviewers.map((entry) => ({
      id: entry.id,
      name: entry.name,
      books: entry.books,
    }))
  } catch {
    return { notes, annotations: [], comments: [], incomplete: true }
  }

  const named = new Map(reviewers.map((reviewer) => [reviewer.id, reviewer.name]))
  for (const note of notes) {
    note.reviewerName = named.get(note.reviewerId) ?? note.reviewerId
  }

  const store = createReadingStore()
  const feedback = createFeedbackStore()

  const annotations: InboxAnnotation[] = []
  const comments: InboxComment[] = []

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

  return { notes, annotations, comments, incomplete }
}

/**
 * Shared reviewer notes, described for the inbox.
 *
 * Nothing here decides who may see what: `listSharedReviewerNotes` has already
 * put every row past the visibility rule as the author, so a private reviewer
 * note -- at passage, paragraph or chapter scope -- never reaches this loop, is
 * never counted in the header above, and is never named anywhere on this page.
 */
async function gatherNotes(viewer: Viewer): Promise<InboxNote[]> {
  const shared = await listSharedReviewerNotes(viewer, readableBookSlugs(viewer))

  const rows = shared.map((note) => ({
    id: note.id,
    reviewerId: note.ownerId,
    // Replaced with the roster's display name when the roster can be read.
    reviewerName: note.ownerId,
    bookSlug: note.bookSlug,
    bookTitle: note.bookTitle,
    scope: note.scope,
    where: scopeLabel(note.anchor),
    captured: capturedText(note.anchor),
    body: note.body,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    anchorOk: note.anchorState !== 'needs-relocation',
    manuscriptChanged: note.manuscriptChanged,
    href: noteHref(note),
  }))

  // Newest first: this is a thing Mike checks, so it is ordered as things
  // arrived rather than as the book is read.
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/**
 * Where a note opens, in the author's own routes.
 *
 * A note whose anchor no longer resolves gets the chapter rather than a
 * paragraph fragment, and a book note gets the book. Nothing links to a place
 * that is not there: a dead fragment silently lands a reader at the top of a
 * chapter and lets them think that is where the note was about.
 */
function noteHref(note: SharedReviewerNote): string {
  const base = `/admin/read/${note.bookSlug}`
  if (note.anchor.scope === 'book') return base
  const chapter = `${base}/${note.anchor.chapterSlug}`
  return note.paragraphId ? `${chapter}#${note.paragraphId}` : chapter
}
