/**
 * The row the author's surfaces render, and the filter they render it through.
 *
 * Split out of `lib/author-feedback-view.ts` for one reason, and it is a real
 * one rather than a tidiness one: the inbox's filter controls run **in the
 * browser**, and every module that can reach storage in this codebase refuses
 * to load there -- `lib/author-metadata.ts`, `lib/author-feedback-source.ts`
 * and `lib/author-export.ts` all throw on `typeof window !== 'undefined'`. A
 * client component that imported any of them would take the whole storage graph
 * to the browser or crash on the way. So the shape and the predicate live here,
 * where there is nothing to reach with: **no import of anything but types**, no
 * store, no viewer, no fetch, no clock.
 *
 * Which also makes the guarantee easy to state and easy to check: filtering,
 * sorting and counting cannot mark anything read or resolved, because there is
 * nothing in this file that could write.
 *
 * ## What a row may carry, and what it may not
 *
 * `attribution` is a display name the roster gave, `You` for Mike's own note, or
 * null. There is deliberately **no `reviewerId` field**: an identifier that is
 * never projected cannot be forgotten in one template. Addresses, access codes,
 * tokens, storage paths, reading positions and private notes never reach
 * `lib/author-feedback-source.ts` in the first place, so they cannot reach a row
 * either.
 *
 * ## New and Resolved are not opposites
 *
 * **New** is derived -- the source changed after Mike last opened it, or he
 * never has. **Resolved** is a reversible choice of his. An item he resolved and
 * a reviewer then edited is both, which is the truth, and is why the state
 * filter's `new` and `resolved` are two overlapping selections rather than two
 * halves of one partition.
 *
 * **Mike's own notes use neither.** They keep the Package 1 `open` / `resolved`
 * status stored on the note itself; their `resolved` and `isNew` are null,
 * because reviewer triage metadata is about what other people wrote and applying
 * it here would invent a second, competing status for a record that has one.
 */

import type { AuthorAnchorState, AuthorItemKind, OriginatorRole } from './author-feedback-source.ts'
import type { AuthorSourceKind, SavedViewScope, SavedViewState } from './author-metadata.ts'

/** Which triage vocabulary a row speaks. */
export type TriageKind = 'reviewer' | 'author'

/** One row, exactly as a surface renders it. Nothing here identifies a person. */
export type InboxRow = {
  itemId: string
  kind: AuthorItemKind
  originator: OriginatorRole | null
  /** A display name, `You`, or null. Never an id, an address or a credential. */
  attribution: string | null
  bookSlug: string
  bookTitle: string
  chapterSlug: string | null
  /** `<book>/<chapter>`, or null where the row has no chapter. */
  chapterCoordinate: string | null
  chapterLabel: string | null
  chapterNumber: number | null
  scope: SavedViewScope
  paragraphOrdinal: number | null
  /** The permitted quotation or paragraph context. Null where there is none. */
  captured: string | null
  /** What was written. Null for a withdrawal and a wordless highlight. */
  body: string | null
  revision: number | null
  anchorState: AuthorAnchorState
  manuscriptChanged: boolean | null
  createdAt: string | null
  updatedAt: string | null
  withdrawnAt: string | null
  /** The one time this row sorts and compares by. */
  occurredAt: string | null
  authorNoteStatus: 'open' | 'resolved' | null
  triage: TriageKind
  /** False when this book's triage document could not be read. */
  triageKnown: boolean
  /** Null for one of Mike's own notes, and null when the triage is unknown. */
  resolved: boolean | null
  /** Null for one of Mike's own notes, and null when the triage is unknown. */
  isNew: boolean | null
  lastReadAt: string | null
  lastExportedAt: string | null
  /** Edited since Mike last opened it. False when he never has -- that is `isNew`. */
  changedSinceRead: boolean
  /** Edited since it last left in a packet. False when it never has. */
  changedSinceExport: boolean
  /** The bounded author detail surface for this row. */
  detailHref: string
}

/** A filter, in exactly the vocabulary a saved view stores. */
export type InboxFilter = {
  /** Book slugs. Empty means every book. */
  books: string[]
  /** `<book>/<chapter>` coordinates. Empty means every chapter. */
  chapters: string[]
  /** Source kinds. Empty means every kind. */
  kinds: AuthorSourceKind[]
  /** Note scopes. Empty means every scope. */
  scopes: SavedViewScope[]
  state: SavedViewState
}

/** Everything, filtered by nothing. */
export const ALL_FEEDBACK: InboxFilter = {
  books: [],
  chapters: [],
  kinds: [],
  scopes: [],
  state: 'all',
}

/** The dashboard preview's length. Small on purpose: the inbox is the list. */
export const DASHBOARD_PREVIEW_LIMIT = 5

/** Where this row's bounded author detail surface lives. */
export function detailHref(bookSlug: string, itemId: string): string {
  return `/admin/feedback/${encodeURIComponent(bookSlug)}/${encodeURIComponent(itemId)}`
}

/**
 * One row's identity, which is a **coordinate and never a scalar**.
 *
 * An item id names a source kind and a source id but never a book, so two books
 * may each hold a `note:same-id` -- the source adapters build the id that way
 * and carry `bookSlug` beside it. Anything that identifies a row by the id
 * alone therefore merges two different rows: one book's triage is applied to the
 * other's, two list children collide on one React key, and a total order over
 * rows does not exist.
 *
 * The pair is the identity, and the separator is the same injective one
 * `chapterCoordinate` uses for a chapter: `BOOK_SLUG_PATTERN` and
 * `ITEM_ID_PATTERN` both admit no `/`, so the first `/` splits a key back into
 * exactly the pair it was built from and two distinct pairs cannot collide.
 *
 * Every client-side map key, busy key, list key and tie break uses this one
 * helper, so there is a single place where that claim has to hold.
 */
export function rowKey(bookSlug: string, itemId: string): string {
  return `${bookSlug}/${itemId}`
}

/**
 * Newest first, with a stable tie break on the row's whole coordinate.
 *
 * A row with no time at all sorts after every row that has one, rather than
 * being given `''` and floated to one end as though it happened at the epoch.
 * The tie break is `bookSlug` and then `itemId`, because an item id is unique
 * only **inside** a book: two books holding the same id at the same instant
 * compared equal under the old id-only tie break, which is not a total order and
 * let two renders of the same rows produce different sequences.
 */
export function sortNewestFirst(rows: readonly InboxRow[]): InboxRow[] {
  return [...rows].sort((a, b) => {
    if (a.occurredAt !== b.occurredAt) {
      if (a.occurredAt === null) return 1
      if (b.occurredAt === null) return -1
      return a.occurredAt < b.occurredAt ? 1 : -1
    }
    if (a.bookSlug !== b.bookSlug) return a.bookSlug < b.bookSlug ? -1 : 1
    return a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0
  })
}

/**
 * Does this row match the state slice?
 *
 * `true`, `false`, or **`null` for "there is no way to tell"** -- a reviewer row
 * whose book's triage document would not read. Null is not folded into false,
 * because a row silently dropped from a list is indistinguishable from a row
 * that was never there.
 */
function matchesState(row: InboxRow, state: SavedViewState): boolean | null {
  if (state === 'all') return true
  if (row.triage === 'author') {
    return state === 'new' ? row.authorNoteStatus === 'open' : row.authorNoteStatus === 'resolved'
  }
  if (!row.triageKnown) return null
  return state === 'new' ? row.isNew === true : row.resolved === true
}

/** Everything except the state slice: structural, and always answerable. */
function matchesStructure(row: InboxRow, filter: InboxFilter): boolean {
  if (filter.books.length > 0 && !filter.books.includes(row.bookSlug)) return false
  if (filter.chapters.length > 0) {
    if (row.chapterCoordinate === null) return false
    if (!filter.chapters.includes(row.chapterCoordinate)) return false
  }
  if (filter.kinds.length > 0 && !filter.kinds.includes(row.kind as AuthorSourceKind)) return false
  if (filter.scopes.length > 0 && !filter.scopes.includes(row.scope)) return false
  return true
}

export type FilterOutcome = {
  rows: InboxRow[]
  /**
   * Rows that passed every structural filter and could not be placed in the
   * state slice, because their book's triage document would not read. Counted
   * rather than dropped so a surface can say so.
   */
  stateUnknown: number
}

/** Apply a filter. The matching rows keep the order they were given in. */
export function filterRows(rows: readonly InboxRow[], filter: InboxFilter): FilterOutcome {
  const kept: InboxRow[] = []
  let stateUnknown = 0

  for (const row of rows) {
    if (!matchesStructure(row, filter)) continue
    const state = matchesState(row, filter.state)
    if (state === null) {
      stateUnknown += 1
      continue
    }
    if (state) kept.push(row)
  }

  return { rows: kept, stateUnknown }
}

/**
 * How many pieces of reviewer feedback are new.
 *
 * Reviewer-side rows only -- Mike's own notes are his, not incoming -- and
 * **null** when any reviewer row's triage could not be read. A number there
 * would be a floor presented as a total, on the one surface whose whole job is
 * to be honest about what is waiting.
 */
export function newFeedbackCount(rows: readonly InboxRow[]): number | null {
  let count = 0
  for (const row of rows) {
    if (row.triage === 'author') continue
    if (!row.triageKnown) return null
    if (row.isNew === true) count += 1
  }
  return count
}

/** Mike's own notes, counted by their own status. */
export function authorNoteCounts(rows: readonly InboxRow[]): { open: number; resolved: number } {
  let open = 0
  let resolved = 0
  for (const row of rows) {
    if (row.triage !== 'author') continue
    if (row.authorNoteStatus === 'resolved') resolved += 1
    else open += 1
  }
  return { open, resolved }
}

export type ChapterChoice = {
  coordinate: string
  bookSlug: string
  bookTitle: string
  label: string
  number: number | null
}

/** The chapter coordinates the rows actually cover, in book-then-chapter order. */
export function chapterChoices(rows: readonly InboxRow[]): ChapterChoice[] {
  const seen = new Map<string, ChapterChoice>()
  for (const row of rows) {
    if (row.chapterCoordinate === null || seen.has(row.chapterCoordinate)) continue
    seen.set(row.chapterCoordinate, {
      coordinate: row.chapterCoordinate,
      bookSlug: row.bookSlug,
      bookTitle: row.bookTitle,
      label: row.chapterLabel ?? row.chapterSlug ?? row.chapterCoordinate,
      number: row.chapterNumber,
    })
  }
  const choices = Array.from(seen.values())
  choices.sort((a, b) => {
    if (a.bookSlug !== b.bookSlug) return a.bookSlug < b.bookSlug ? -1 : 1
    const left = a.number ?? Number.MAX_SAFE_INTEGER
    const right = b.number ?? Number.MAX_SAFE_INTEGER
    if (left !== right) return left - right
    return a.coordinate < b.coordinate ? -1 : 1
  })
  return choices
}
