/**
 * Turning the author's source rows into the rows his surfaces render.
 *
 * `lib/author-feedback-source.ts` answers *what exists*; `lib/author-metadata.ts`
 * answers *what Mike has done with it*. This module is the join. The row shape
 * and the filter it is rendered through live in `lib/author-inbox-filter.ts`,
 * which the browser can load; this half stays on the server because
 * `lib/author-metadata.ts` refuses to load anywhere else.
 *
 * It is still **pure**: it reads no store, takes no `Viewer`, and writes
 * nothing. Everything below is a function of the two values it is handed, which
 * is what lets the dashboard, the inbox and the tests agree about what a row is
 * without any of them reaching storage to find out -- and what makes "listing
 * marks nothing read" a property of the code rather than a promise about it.
 * The one function that writes `lastReadAt` is `markItemOpened`, reached from an
 * item's detail page and from nowhere else.
 *
 * ## An unreadable triage document is not an unread item
 *
 * A book whose metadata could not be read is passed as `null`, and every row
 * from it gets `triageKnown: false` with `resolved` and `isNew` **null** --
 * never `false`, never `true`. A `false` there renders as "you have not dealt
 * with this and it is not new", which is a confident statement about Mike's own
 * work made out of a storage failure; a `true` is the same lie pointing the
 * other way. The row is still shown, clearly identified, because hiding it
 * would be a third guess.
 */

import type { AuthorFeedbackItem, AuthorSourceBook } from './author-feedback-source.ts'
import {
  detailHref,
  sortNewestFirst,
  type InboxRow,
} from './author-inbox-filter.ts'
import {
  chapterCoordinate,
  isNewSince,
  itemMetadata,
  UNTOUCHED,
  type AuthorMetadata,
  type SavedViewScope,
} from './author-metadata.ts'

/**
 * One book's triage document as the caller read it.
 *
 * `null` means the read failed, and that is not the same as an empty document:
 * an empty document is a book Mike has not touched, a `null` is a book whose
 * record could not be read at all.
 */
export type BookMetadata = AuthorMetadata | null

/**
 * The single time a row happened.
 *
 * `updatedAt` where the kind has one, the withdrawal time where it is a
 * withdrawal, and `createdAt` as the last resort. Null only when the row
 * genuinely carries no time, and a null is left null rather than given a
 * plausible one.
 */
export function occurredAt(item: AuthorFeedbackItem): string | null {
  return item.updatedAt ?? item.withdrawnAt ?? item.createdAt ?? null
}

function laterThan(later: string | null, earlier: string | null): boolean {
  if (later === null || earlier === null) return false
  const a = Date.parse(later)
  const b = Date.parse(earlier)
  if (Number.isNaN(a) || Number.isNaN(b)) return false
  return a > b
}

/**
 * One source row plus one triage document, as a renderable row.
 *
 * `metadata` is the document for **this row's own book**, or null when that
 * book's document could not be read. It is never another book's: an item id
 * names a source kind and a source id but not a book, so two books holding the
 * same id must never be looked up in one merged map -- the same defect the
 * export's stamp coordinate exists to prevent.
 */
export function inboxRow(item: AuthorFeedbackItem, metadata: BookMetadata): InboxRow {
  const at = occurredAt(item)
  const known = metadata !== null
  const entry = metadata === null ? UNTOUCHED : itemMetadata(metadata, item.itemId)
  const isAuthorNote = item.originator === 'author'

  return {
    itemId: item.itemId,
    kind: item.kind,
    originator: item.originator,
    attribution: isAuthorNote ? 'You' : item.reviewerName,
    bookSlug: item.bookSlug,
    bookTitle: item.bookTitle,
    chapterSlug: item.chapterSlug,
    chapterCoordinate:
      item.chapterSlug === null ? null : chapterCoordinate(item.bookSlug, item.chapterSlug),
    chapterLabel: item.chapterLabel,
    chapterNumber: item.chapterNumber,
    scope: item.scope as SavedViewScope,
    paragraphOrdinal: item.paragraphOrdinal,
    captured: item.captured,
    body: item.body,
    revision: item.revision,
    anchorState: item.anchorState,
    manuscriptChanged: item.manuscriptChanged,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    withdrawnAt: item.withdrawnAt,
    occurredAt: at,
    authorNoteStatus: item.authorNoteStatus,
    triage: isAuthorNote ? 'author' : 'reviewer',
    triageKnown: known,
    // One of Mike's own notes has its own status and borrows neither of these.
    resolved: !known || isAuthorNote ? null : entry.resolved,
    isNew: !known || isAuthorNote ? null : isNewSince(entry, at ?? ''),
    lastReadAt: known ? entry.lastReadAt : null,
    lastExportedAt: known ? entry.lastExportedAt : null,
    changedSinceRead: known && laterThan(at, entry.lastReadAt),
    changedSinceExport: known && laterThan(at, entry.lastExportedAt),
    detailHref: detailHref(item.bookSlug, item.itemId),
  }
}

/**
 * Build every row, newest first.
 *
 * `metadata` maps a book slug to that book's document, or to `null` for a book
 * whose document would not read. A slug that is **absent from the map** is
 * treated as unreadable rather than as empty, because an absent entry means
 * nobody read it, and "nobody read it" is not "there was nothing in it".
 */
export function buildRows(
  items: readonly AuthorFeedbackItem[],
  metadata: ReadonlyMap<string, BookMetadata>,
): InboxRow[] {
  return sortNewestFirst(
    items.map((item) =>
      inboxRow(item, metadata.has(item.bookSlug) ? (metadata.get(item.bookSlug) as BookMetadata) : null),
    ),
  )
}

/** The books the source actually read, in the order it read them. */
export function bookChoices(books: readonly AuthorSourceBook[]): { slug: string; title: string }[] {
  return books.map((book) => ({ slug: book.slug, title: book.title }))
}
