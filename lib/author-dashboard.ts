/**
 * The one read the author's surfaces share.
 *
 * The dashboard and the feedback inbox ask the same two questions -- what is
 * there, and what has Mike done with it -- so they ask them through one
 * function rather than two that could drift apart and disagree about a count.
 * Everything it returns is a **read**: `loadAuthorFeedbackSource` and
 * `loadAuthorMetadata` are the only calls in this file, and neither of them
 * writes. Nothing here can move `lastReadAt`, `resolved` or `lastExportedAt`,
 * and no surface built on it can either.
 *
 * ## A failed read is never an empty one
 *
 * Three different failures are kept apart, because they mean different things
 * and a surface has to say different things about them:
 *
 *   **`incomplete`** -- a feedback source did not answer. Some rows that exist
 *   are missing from `rows`, and there is no way to know which. An export must
 *   refuse; a list may still show what it has, clearly labelled.
 *
 *   **`unreadableBooks`** -- a book's triage document did not read. The rows are
 *   all there; what is missing is Mike's own record of handling them, so those
 *   rows carry `triageKnown: false` rather than the all-new, all-unresolved
 *   guess a default would produce.
 *
 *   **`savedViews: null`** -- the saved-view document did not read. Not `[]`,
 *   which says "you have never saved a view" and invites Mike to save one over
 *   whatever is actually there.
 *
 * Each of the three is separately visible, and none of them is ever flattened
 * into a shorter list, a smaller number or a success.
 */

import {
  loadAuthorFeedbackSource,
  type AuthorSourceBook,
  type AuthorSourceFailure,
} from './author-feedback-source.ts'
import { buildRows, type BookMetadata } from './author-feedback-view.ts'
import {
  authorNoteCounts,
  newFeedbackCount,
  DASHBOARD_PREVIEW_LIMIT,
  type InboxRow,
} from './author-inbox-filter.ts'
import {
  loadAuthorMetadata,
  SAVED_VIEW_HOME_SLUG,
  type AuthorMetadata,
  type SavedView,
} from './author-metadata.ts'
import type { Viewer } from './reading-access.ts'

if (typeof window !== 'undefined') {
  throw new Error(
    'lib/author-dashboard is server-only and must not be imported by a client component',
  )
}

/** Everything the author's surfaces render, and every way the read fell short. */
export type AuthorBoard = {
  rows: InboxRow[]
  books: AuthorSourceBook[]
  /** Requested slugs the manifest does not hold. A local fact, not a failure. */
  notFound: string[]
  /** A feedback source did not answer. An export of this set must refuse. */
  incomplete: boolean
  /** Which sources failed, by name. Safe to print: see `AuthorSourceFailure`. */
  failures: AuthorSourceFailure[]
  /** Books whose triage document would not read. Their rows say so. */
  unreadableBooks: string[]
  /** Null when the saved-view document would not read. Never `[]` for that. */
  savedViews: SavedView[] | null
  /** True when there is no durable store configured at all. */
  storageUnavailable: boolean
}

/**
 * Read the source, then one triage document per book, then the saved views.
 *
 * The metadata documents are read **per book and kept apart**, exactly as
 * `exportAuthorFeedback` reads them: an item id names a source kind and a source
 * id but never a book, so two books holding an entry for the same id must not
 * be merged into one map where one silently answers for both.
 */
export async function loadAuthorBoard(
  viewer: Viewer,
  bookSlugs?: readonly string[],
): Promise<AuthorBoard> {
  const source = await loadAuthorFeedbackSource(viewer, bookSlugs)

  const metadata = new Map<string, BookMetadata>()
  const unreadableBooks: string[] = []
  const failures = [...source.failures]
  let storageUnavailable = false

  for (const book of source.books) {
    const loaded = await loadAuthorMetadata(viewer, book.slug)
    if (loaded.ok) {
      metadata.set(book.slug, loaded.value.metadata)
      continue
    }
    if (loaded.reason === 'storage-unavailable') storageUnavailable = true
    metadata.set(book.slug, null)
    unreadableBooks.push(book.slug)
    failures.push({ source: 'author-metadata', bookSlug: book.slug })
  }

  /*
   * The saved views, from the one document that owns them.
   *
   * `SAVED_VIEW_HOME_SLUG` is a reserved slug and never a book, so this read is
   * outside the per-book loop above and its failure is reported on its own: a
   * view list that cannot be read has nothing to do with whether a book's
   * triage can be, and conflating them would disable the wrong surface.
   */
  let savedViews: SavedView[] | null = null
  const home = await loadAuthorMetadata(viewer, SAVED_VIEW_HOME_SLUG)
  if (home.ok) {
    savedViews = home.value.metadata.views
  } else {
    if (home.reason === 'storage-unavailable') storageUnavailable = true
    failures.push({ source: 'saved-views', bookSlug: null })
  }

  return {
    rows: buildRows(source.items, metadata),
    books: source.books,
    notFound: [...source.notFound],
    incomplete: source.incomplete,
    failures,
    unreadableBooks,
    savedViews,
    storageUnavailable,
  }
}

/** What the dashboard shows about feedback, computed from a board and nothing else. */
export type DashboardSummary = {
  /** Null when any reviewer row's triage could not be read. Never a floor. */
  newCount: number | null
  /** Newest first, at most `DASHBOARD_PREVIEW_LIMIT`. Reviewer-side rows only. */
  preview: InboxRow[]
  /** How many reviewer-side rows there are in total. */
  total: number
  myNotes: {
    open: number
    resolved: number
    /** Newest first, at most `DASHBOARD_PREVIEW_LIMIT`. */
    preview: InboxRow[]
  }
  /**
   * True when something about this read fell short, in any of its three ways.
   *
   * The dashboard uses it to decide between "there is nothing here" and "some
   * of this could not be read". Those are different sentences and the page must
   * never print the first when the second is true.
   */
  degraded: boolean
}

/**
 * Summarise a board for the dashboard.
 *
 * Pure, and takes no viewer: it is arithmetic over rows that were already read.
 * Rendering this summary marks nothing read and resolves nothing -- there is
 * nothing here that could.
 */
export function dashboardSummary(board: AuthorBoard): DashboardSummary {
  const incoming = board.rows.filter((row) => row.triage === 'reviewer')
  const own = board.rows.filter((row) => row.triage === 'author')

  return {
    newCount: newFeedbackCount(board.rows),
    preview: incoming.slice(0, DASHBOARD_PREVIEW_LIMIT),
    total: incoming.length,
    myNotes: {
      ...authorNoteCounts(board.rows),
      preview: own.slice(0, DASHBOARD_PREVIEW_LIMIT),
    },
    degraded:
      board.incomplete ||
      board.unreadableBooks.length > 0 ||
      board.savedViews === null ||
      board.storageUnavailable,
  }
}

/** Re-exported so a surface needs one import for the shape and the read. */
export type { AuthorMetadata, InboxRow, SavedView }
