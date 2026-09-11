/**
 * Assembling one person's whole workspace.
 *
 * The reviewer's "My reading" and the author's own reading both need the same
 * thing: for each book they may open, where they are, what they bookmarked,
 * what they annotated, and -- for a reviewer -- every comment they have
 * submitted. Building that in one place means the two views cannot drift, and
 * means the scoping is written once.
 *
 * Everything is gathered per book, from that book's own prefix, for that one
 * viewer. There is no call anywhere in this file that reads more broadly and
 * filters afterwards, because a filter is a thing that can be forgotten and a
 * prefix that is never constructed is not.
 *
 * Submitted feedback is read through the existing, append-only feedback store
 * and is passed through **unchanged**. It is durable history: the workspace
 * shows it and offers no way to edit or remove it.
 */

import { findBook, findReleasedChapter, releasedChapters } from './manuscript.ts'
import { loadBookReading } from './reading-service.ts'
import type { Viewer } from './reading-access.ts'
import type { WorkspaceBook, WorkspaceFeedback } from './reading-view.ts'
import { createFeedbackStore } from './reviewer-feedback.ts'

if (typeof window !== 'undefined') {
  throw new Error(
    'lib/reading-workspace is server-only and must not be imported by a client component',
  )
}

export type WorkspaceOptions = {
  /** `/review` for a reviewer, `/admin/read` for the author. */
  base: string
  /**
   * Whether to include submitted reviewer feedback.
   *
   * False for the author reading his own books: the author submits no reviewer
   * feedback and has none to show. What reviewers sent *him* is a different
   * thing entirely, gathered by `lib/author-inbox.ts`, and is never mixed in
   * here as though he had written it.
   */
  includeFeedback: boolean
}

/**
 * One viewer's workspace across the books they may open.
 *
 * Books with nothing in them are still returned, so the workspace shows a
 * reviewer every title they have been given rather than only the ones they have
 * already marked up.
 */
export async function buildWorkspace(
  viewer: Viewer,
  bookSlugs: readonly string[],
  options: WorkspaceOptions,
): Promise<WorkspaceBook[]> {
  const out: WorkspaceBook[] = []

  for (const slug of bookSlugs) {
    const reading = await loadBookReading(viewer, slug)
    // A book this viewer may not read, or one the site has not loaded, is
    // skipped silently -- it is not theirs to be told about.
    if (!reading.ok) continue

    const { book, position, bookmarks, annotations } = reading.value

    out.push({
      slug: book.slug,
      title: book.title,
      base: `${options.base}/${book.slug}`,
      position,
      bookmarks,
      annotations,
      feedback: options.includeFeedback ? await feedbackFor(viewer, book.slug) : [],
      chapters: releasedChapters(book).map((chapter) => ({
        slug: chapter.slug,
        number: chapter.number,
        label: chapter.label,
      })),
    })
  }

  return out
}

/**
 * This reviewer's own submitted comments on one book.
 *
 * Scoped at the store boundary by reviewer and by book, exactly as the reader's
 * own listing is, so no shape of call here can widen it. An author viewer has
 * no reviewer id and is never asked.
 */
async function feedbackFor(viewer: Viewer, bookSlug: string): Promise<WorkspaceFeedback[]> {
  if (viewer.kind !== 'reviewer') return []

  const book = findBook(bookSlug)
  if (!book) return []

  let rows
  try {
    rows = await createFeedbackStore().listForReviewer(viewer.id, bookSlug)
  } catch {
    /*
     * A storage failure must not be rendered as "you have written nothing".
     * That was a real defect in this codebase once, and the fix was to let the
     * failure propagate rather than swallow it. Here the workspace has other
     * sections to show, so the failure is contained -- but it is contained as
     * an *absence with a reason*, not as a confident empty list: the caller
     * sees no comments and the page says which section could not be read.
     */
    throw new FeedbackUnreadableError(bookSlug)
  }

  return rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    chapterSlug: row.chapterSlug,
    chapterLabel: findReleasedChapter(book, row.chapterSlug)?.label ?? row.chapterSlug,
    paragraphId: row.paragraphId,
    paragraphOrdinal: row.paragraphOrdinal,
    quote: row.quote,
    comment: row.comment,
    createdAt: row.createdAt,
  }))
}

/**
 * Raised when submitted feedback could not be read.
 *
 * It exists so the page can say "your comments could not be loaded" instead of
 * showing an empty list that reads as "you have never commented". Those are
 * very different statements to make to somebody who has spent an evening
 * writing notes on a manuscript.
 */
export class FeedbackUnreadableError extends Error {
  readonly bookSlug: string

  constructor(bookSlug: string) {
    super('reviewer feedback could not be read')
    this.name = 'FeedbackUnreadableError'
    this.bookSlug = bookSlug
  }
}
