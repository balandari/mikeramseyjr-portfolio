/**
 * One normalized source over everything Mike is entitled to see.
 *
 * ## Why one source rather than four readers
 *
 * There are four kinds of thing a reviewer can have left him, and they arrived
 * in four different years: notes under the note contract, submitted comments
 * under the retired model, shared annotations and highlights from before notes
 * existed, and -- new in this package -- bodyless withdrawal events. Before this
 * module each surface that wanted "what has been said about this book" joined
 * them itself, which meant each surface got its own chance to forget a
 * visibility check, its own idea of what an unreadable store means, and its own
 * ordering.
 *
 * So the join is written once, here. It decides nothing about presentation and
 * builds no page: it answers with rows, in a stable total order, each carrying
 * its own provenance, plus the one fact every caller above needs and no caller
 * can reconstruct -- **whether the answer is complete**.
 *
 * ## What may be in it, and what may never be
 *
 * In: a reviewer's note they explicitly **shared**; Mike's own notes, keeping
 * their Package 1 `open` / `resolved` status; a reviewer's legacy annotation
 * that `canViewAnnotation` admits as the author; every submitted comment, which
 * was sent to him deliberately and immutably; and a withdrawal event, which is
 * bodyless by construction.
 *
 * Never, under any circumstance: a reviewer's **private** note at any scope, a
 * reviewer's private highlight, a reading position, an email address, an access
 * code, a code hash, a token, a credential or a storage path. Private material
 * does not reach this module's output, its counts, its failure list, or
 * anything built on it -- each is dropped at the one place that can see it,
 * before a row is built, and `tests/author-feedback-source.test.ts` scans a
 * serialized source for every one of those by name.
 *
 * The roster is consulted for **only** two fields -- a reviewer's id and their
 * display name -- and that is the whole of what leaves it. Not their address,
 * not their status, not their code hash. A reviewer the roster cannot name is
 * still here with exactly what they shared; the name simply falls back to the
 * identifier, as the inbox has always done.
 *
 * ## Not-found and failure are different answers
 *
 * A book that resolves to nothing is a **local** fact: `findBook` reads the
 * manifest this deployment built at compile time, and an unloaded or
 * unreleased book is that manifest's own answer, decided without touching a
 * store. That is a legitimate `not-found`, it is listed by slug, and it does
 * **not** make the source incomplete.
 *
 * A store that was asked and did not answer is a different thing entirely. It
 * sets `incomplete` and names which source failed, and every caller above --
 * the export in particular -- refuses rather than presenting a short list as a
 * complete one. The two are never merged, because "nobody has said anything
 * about your book" and "the store did not answer" look identical on a page
 * unless something insists they are told apart.
 *
 * ## Bounded reads
 *
 * Every read here is **sequential**: one object, then the next. That satisfies
 * the eight-in-flight bound trivially and is stated as what it is -- there is
 * no limiter on this path, no fan-out, and no concurrency result being claimed.
 * `lib/ordered-concurrency.ts` exists and is deliberately not used here; if this
 * is ever parallelised it is the thing to use, and the bound would then need
 * its own discriminating test.
 *
 * No audit history is read. The roster document is loaded directly rather than
 * through `loadAdminView`, which also reads the audit log -- an inbox has no
 * business asking who was admitted when.
 */

import { findBook, findReleasedChapter, type ReaderBook } from './manuscript.ts'
import { canViewAnnotation, type Viewer } from './reading-access.ts'
import { capturedText, type NoteScope } from './note-contract.ts'
import {
  listAuthorNotes,
  listSharedReviewerNotes,
  readableBookSlugs,
  type SharedReviewerNote,
} from './note-service.ts'
import { createReadingStore, type Annotation } from './reviewer-reading.ts'
import { createFeedbackStore } from './reviewer-feedback.ts'
import { createRosterStore } from './reviewer-roster.ts'
import { createWithdrawalStore, type WithdrawalEvent } from './withdrawal-events.ts'

if (typeof window !== 'undefined') {
  throw new Error(
    'lib/author-feedback-source is server-only and must not be imported by a client component',
  )
}

/** What kind of record a row came from. Provenance, never inferred later. */
export type AuthorItemKind = 'note' | 'comment' | 'annotation' | 'withdrawal'

/** Who wrote it. A withdrawal names nobody -- see `lib/withdrawal-events.ts`. */
export type OriginatorRole = 'reviewer' | 'author'

/** Whether a row's anchor still points where it was written. */
export type AuthorAnchorState = 'ok' | 'needs-relocation' | 'unanchored' | 'not-applicable'

/**
 * One thing Mike can see, described the same way whatever it came from.
 *
 * Every field is nullable where the kind genuinely has nothing to put in it,
 * rather than being filled with a plausible default. A chapter note has no
 * paragraph; a withdrawal has no body; a highlight may have no words. Inventing
 * a value for any of those would make an export say something nobody wrote.
 */
export type AuthorFeedbackItem = {
  /** Stable and type-prefixed: `note:<id>`, `comment:<id>`, and so on. */
  itemId: string
  kind: AuthorItemKind
  /** The record's own identifier in the store it came from. */
  sourceId: string
  /** Who wrote it, or null for a withdrawal, which names nobody. */
  originator: OriginatorRole | null
  /**
   * The reviewer's stable id, when there is one this row may name.
   *
   * Null for Mike's own notes and null for every withdrawal. It is a
   * non-secret identifier, never an address; the export replaces it with a
   * packet-local pseudonym before anything is rendered.
   */
  reviewerId: string | null
  /** The roster's display name, when the roster could be read. */
  reviewerName: string | null
  bookSlug: string
  bookTitle: string
  scope: NoteScope
  chapterSlug: string | null
  chapterNumber: number | null
  chapterLabel: string | null
  paragraphId: string | null
  paragraphOrdinal: number | null
  /** The permitted captured quotation or paragraph context. Null where none. */
  captured: string | null
  /** What was written. Null for a withdrawal and for a wordless highlight. */
  body: string | null
  /** The note contract's revision, where the kind has one. */
  revision: number | null
  anchorState: AuthorAnchorState
  /** True when the chapter file has moved since. Evidence, never a verdict. */
  manuscriptChanged: boolean | null
  createdAt: string | null
  updatedAt: string | null
  /** Set only on a withdrawal. */
  withdrawnAt: string | null
  /** Mike's Package 1 status on his **own** notes. Null on everything else. */
  authorNoteStatus: 'open' | 'resolved' | null
}

/** A book this source actually read. */
export type AuthorSourceBook = { slug: string; title: string }

/**
 * Which source failed, by name.
 *
 * Names only -- `notes`, `roster`, `annotations`, `comments`, `withdrawals` --
 * with the book slug where one applies, and never an error message, a store
 * path, a credential, or anything a provider said. A failure list is a thing
 * that gets printed; it must be safe to print.
 */
export type AuthorSourceFailure = { source: string; bookSlug: string | null }

export type AuthorFeedbackSource = {
  items: AuthorFeedbackItem[]
  books: AuthorSourceBook[]
  /** Slugs that resolved to no loaded book. A local fact, not a failure. */
  notFound: string[]
  /** True when any required source did not answer. An export must refuse. */
  incomplete: boolean
  failures: AuthorSourceFailure[]
}

/* ------------------------------------------------------------------ ordering */

const KIND_RANK: Readonly<Record<AuthorItemKind, number>> = {
  note: 0,
  annotation: 1,
  comment: 2,
  withdrawal: 3,
}

/**
 * Where a row sorts. Total, stable, and computed from the row alone.
 *
 * Book, then chapter, then paragraph, then kind, then when it happened, then
 * the source id -- which is unique within its kind, so no two rows can tie. A
 * book-scope row sorts first within its book, and a chapter-scope row before
 * the paragraphs inside that chapter, exactly as `anchorOrder` does it for
 * notes; this is that rule widened to four kinds rather than a second rule.
 *
 * Determinism is the point: the export's pseudonyms are assigned from this
 * order, so an order that depended on which read finished first would make two
 * exports of the same records differ.
 */
export function itemOrderKey(item: AuthorFeedbackItem): string {
  const chapter = item.scope === 'book' ? -1 : (item.chapterNumber ?? 0)
  const paragraph =
    item.scope === 'book' || item.scope === 'chapter' ? -1 : (item.paragraphOrdinal ?? 0)
  const at = item.withdrawnAt ?? item.createdAt ?? ''
  return [
    item.bookSlug,
    pad(chapter),
    pad(paragraph),
    String(KIND_RANK[item.kind]),
    at,
    item.sourceId,
  ].join('\u0000')
}

/** A signed integer as a fixed-width, lexicographically ordered string. */
function pad(value: number): string {
  const sign = value < 0 ? '0' : '1'
  const magnitude = Math.abs(Math.trunc(value))
  return `${sign}${String(value < 0 ? 999999 - magnitude : magnitude).padStart(6, '0')}`
}

export function sortAuthorItems(items: AuthorFeedbackItem[]): AuthorFeedbackItem[] {
  return items.sort((a, b) => {
    const left = itemOrderKey(a)
    const right = itemOrderKey(b)
    return left < right ? -1 : left > right ? 1 : 0
  })
}

/* ------------------------------------------------------------- the adapters */

function noteItem(note: SharedReviewerNote, originator: OriginatorRole): AuthorFeedbackItem {
  // Narrowed once, here, rather than asserted at each field: a book note
  // anchors to nothing, and there is no chapter on it to read.
  const anchored = note.anchor.scope === 'book' ? null : note.anchor
  return {
    itemId: `note:${note.id}`,
    kind: 'note',
    sourceId: note.id,
    originator,
    reviewerId: originator === 'reviewer' ? note.ownerId : null,
    reviewerName: null,
    bookSlug: note.bookSlug,
    bookTitle: note.bookTitle,
    scope: note.scope,
    chapterSlug: anchored ? anchored.chapterSlug : null,
    chapterNumber: anchored ? anchored.chapterNumber : null,
    chapterLabel: anchored ? anchored.chapterLabel : null,
    paragraphId:
      note.anchor.scope === 'passage' || note.anchor.scope === 'paragraph'
        ? (note.paragraphId ?? note.anchor.paragraphId)
        : null,
    paragraphOrdinal:
      note.anchor.scope === 'passage' || note.anchor.scope === 'paragraph'
        ? note.anchor.paragraphOrdinal
        : null,
    // The **captured** words, never the manuscript as it reads now. That is the
    // whole point of capturing them.
    captured: capturedText(note.anchor),
    body: note.body,
    revision: note.revision,
    anchorState: note.anchorState,
    manuscriptChanged: note.manuscriptChanged,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    withdrawnAt: null,
    authorNoteStatus: originator === 'author' ? note.status : null,
  }
}

function annotationItem(
  row: Annotation,
  book: ReaderBook,
  anchorOk: boolean,
): AuthorFeedbackItem {
  const chapter = findReleasedChapter(book, row.chapterSlug)
  return {
    itemId: `annotation:${row.id}`,
    kind: 'annotation',
    sourceId: row.id,
    originator: 'reviewer',
    reviewerId: row.ownerId,
    reviewerName: null,
    bookSlug: book.slug,
    bookTitle: book.title,
    // A legacy annotation is always about a selected passage.
    scope: 'passage',
    chapterSlug: row.chapterSlug,
    chapterNumber: row.chapterNumber,
    chapterLabel: chapter?.label ?? row.chapterLabel,
    paragraphId: row.paragraphId,
    paragraphOrdinal: row.paragraphOrdinal,
    captured: row.quote,
    // A highlight with nothing written about it is a complete record and its
    // body is genuinely null. It is not turned into an empty string.
    body: row.note,
    revision: null,
    anchorState: anchorOk ? 'ok' : 'needs-relocation',
    manuscriptChanged: chapter ? chapter.sha256 !== row.manuscriptSha256 : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    withdrawnAt: null,
    authorNoteStatus: null,
  }
}

function withdrawalItem(event: WithdrawalEvent, book: ReaderBook): AuthorFeedbackItem {
  const chapter = event.chapterSlug ? findReleasedChapter(book, event.chapterSlug) : null
  return {
    itemId: `withdrawal:${event.noteId}`,
    kind: 'withdrawal',
    sourceId: event.noteId,
    // Nobody. The event carries no reviewer, so nothing here invents one.
    originator: null,
    reviewerId: null,
    reviewerName: null,
    bookSlug: event.bookSlug,
    bookTitle: book.title,
    scope: event.scope,
    chapterSlug: event.chapterSlug,
    chapterNumber: chapter?.number ?? null,
    chapterLabel: chapter?.label ?? null,
    // The event has no paragraph and no words, and this is where that stays
    // true: nothing below may fill any of these from anywhere.
    paragraphId: null,
    paragraphOrdinal: null,
    captured: null,
    body: null,
    revision: event.revision,
    anchorState: 'not-applicable',
    manuscriptChanged: null,
    createdAt: null,
    updatedAt: null,
    withdrawnAt: event.withdrawnAt,
    authorNoteStatus: null,
  }
}

/* -------------------------------------------------------------- the loading */

/**
 * Everything Mike may see, across the books he can open.
 *
 * Reviewer sessions get an empty, complete source and reach no store at all:
 * the first line refuses anything that is not the author, before a prefix is
 * built or a driver is touched.
 *
 * ## The requested books bound the whole source
 *
 * The books are settled once, at the top, from the request with repeats
 * removed, and every row below comes from one of them. `books` therefore
 * describes the items exactly: **every `item.bookSlug` is in `books`**, and a
 * source restricted to one book holds nothing from another. This is the
 * property an export depends on to say what its packet is about. The legacy
 * annotations and comments used to reach it through a walk over each
 * reviewer's current entitlements, which knows nothing about what was
 * requested and had to be filtered back down; they are now read for these
 * books directly, so the scope is structural rather than a guard.
 */
/** The same slugs, first occurrence kept and every later repeat dropped. */
function uniqueSlugs(slugs: readonly string[]): string[] {
  const seen = new Set<string>()
  const kept: string[] = []
  for (const slug of slugs) {
    if (seen.has(slug)) continue
    seen.add(slug)
    kept.push(slug)
  }
  return kept
}

export async function loadAuthorFeedbackSource(
  viewer: Viewer,
  bookSlugs?: readonly string[],
): Promise<AuthorFeedbackSource> {
  if (viewer.kind !== 'author') {
    return { items: [], books: [], notFound: [], incomplete: false, failures: [] }
  }

  /*
   * The requested books, with every repeat after the first dropped.
   *
   * A caller may name the same book twice -- a saved view built from two
   * filters, a query string with a repeated parameter -- and without this the
   * book, its items, its metadata read and its stamp attempt would all appear
   * twice in a source that is supposed to be normalized. First occurrence wins,
   * so the order the caller asked in is the order they get back.
   */
  const requested = uniqueSlugs(bookSlugs ?? readableBookSlugs(viewer))
  const items: AuthorFeedbackItem[] = []
  const books: AuthorSourceBook[] = []
  const notFound: string[] = []
  const failures: AuthorSourceFailure[] = []

  const note = (source: string, bookSlug: string | null) => {
    failures.push({ source, bookSlug })
  }

  for (const slug of requested) {
    const book = findBook(slug)
    // The manifest's own answer, decided without a store. See the module
    // comment: this is a legitimate not-found and not an incompleteness.
    if (!book) {
      notFound.push(slug)
      continue
    }
    books.push({ slug: book.slug, title: book.title })
  }

  /*
   * The scope of this source: exactly the books Mike asked for and could open.
   *
   * Everything below reads through this and nothing reads around it. The notes
   * and the withdrawals are asked for these books by name; the legacy
   * annotations and comments are now iterated over this same list rather than
   * over each reviewer's entitlements, so no row from a book nobody requested
   * can enter the source at all. That used to need a separate membership test
   * applied inside the loop, because the loop was driven by the roster, which
   * knows every book a reviewer was ever given and knows nothing about what
   * was requested. Driving the loop from this list instead makes the scope a
   * property of the structure rather than of a guard somebody has to remember.
   */
  const readable = books.map((book) => book.slug)

  /*
   * Shared reviewer notes, first and roster-independently.
   *
   * `listSharedReviewerNotes` reads a prefix on the book and puts every row
   * past `canViewNote` as the author, so a reviewer who has been removed,
   * revoked or had this book withdrawn is still here with exactly what they
   * shared -- and a private note is not, at any scope.
   */
  try {
    const listing = await listSharedReviewerNotes(viewer, readable)
    // A listed object that would not read is a gap, not a note nobody wrote.
    if (listing.incomplete) note('notes', null)
    for (const shared of listing.notes) items.push(noteItem(shared, 'reviewer'))
  } catch {
    note('notes', null)
  }

  /* Mike's own notes, which keep their Package 1 open/resolved status. */
  try {
    const listing = await listAuthorNotes(viewer, readable)
    if (listing.incomplete) note('author-notes', null)
    for (const own of listing.notes) items.push(noteItem(own, 'author'))
  } catch {
    note('author-notes', null)
  }

  /*
   * Withdrawal events, per book.
   *
   * `incomplete` from the listing is carried rather than discarded: an event
   * that was listed and could not be read is a gap in what Mike is being shown,
   * and is never flattened into "no withdrawals".
   */
  const withdrawals = createWithdrawalStore()
  for (const book of books) {
    try {
      const listing = await withdrawals.list(book.slug)
      if (listing.incomplete) note('withdrawals', book.slug)
      const loaded = findBook(book.slug)
      if (!loaded) continue
      for (const event of listing.events) items.push(withdrawalItem(event, loaded))
    } catch {
      note('withdrawals', book.slug)
    }
  }

  /*
   * The roster, for two fields and no more: a reviewer's id and their display
   * name. Loaded directly rather than through `loadAdminView`, which would also
   * read the audit log.
   */
  let reviewers: { id: string; name: string; books: string[] }[] = []
  try {
    const doc = await createRosterStore().load()
    reviewers = doc.reviewers.map((entry) => ({
      id: entry.id,
      name: entry.name,
      books: [...entry.books],
    }))
  } catch {
    /*
     * A required source: the legacy annotations and comments below are read per
     * reviewer, so a roster that will not answer means they cannot be read at
     * all -- which is an incompleteness, not an absence.
     *
     * This now also catches `RosterUnreadableError`, which is what a **present
     * but malformed** `REVIEWER_ROSTER` raises. It used to arrive here as a
     * successful empty document, so a damaged access list read exactly like a
     * deployment with no reviewers: no failure recorded, no legacy history
     * discovered, and an export stamped complete. Nothing about which reviewer,
     * which address, or what the damaged text said is recorded -- the failure
     * is named by source only, exactly like every other entry in this list.
     */
    note('roster', null)
  }

  const named = new Map(reviewers.map((entry) => [entry.id, entry.name]))
  const store = createReadingStore()
  const feedback = createFeedbackStore()

  /*
   * ## Why this walks the requested books and not the reviewer’s `books`
   *
   * It used to be `for (const slug of reviewer.books)`, and that made the
   * author's view of **history** depend on a **current** entitlement. The two
   * are different facts. `lib/reviewer-admin.ts` replaces a reviewer’s `books`
   * array when their access changes, so taking a book back was enough to stop
   * this loop ever asking the store about it -- and the retained annotations
   * and immutable comments underneath were still there, unread, while the
   * source reported `incomplete: false` and the export stamped a packet that
   * was missing them. A submitted comment is documented as append-only
   * history that is visible to Mike always; a reading arrangement ending is
   * not a reason for what somebody said to have gone unsaid. The notes path
   * above has always been roster-independent for exactly this reason, and this
   * is the same rule reaching the two legacy stores.
   *
   * **Isolation is unchanged.** Every read below is still scoped to one
   * reviewer and one book at the store boundary -- the prefix is built from
   * this reviewer's id, and a comment listing is filtered to this reviewer's
   * rows -- so a reviewer who never had this book contributes nothing, because
   * their prefix holds nothing, not because a roster field said so. Every
   * annotation still goes past `canViewAnnotation` as the author.
   *
   * **Requested-book scope is unchanged, and is now structural.** `readable`
   * is exactly the books Mike asked for and could open, so no row from any
   * other book can enter the source at all. That is what the per-row `inScope`
   * guard was for, and iterating the list directly says the same thing without
   * depending on anybody remembering the guard.
   *
   * **The limit, stated:** a reviewer removed from the roster **entirely** is
   * still not discovered here, because these two stores are laid out
   * owner-first and there is no book-wide prefix to enumerate. Reaching those
   * rows needs a storage change, which is deliberately not in this correction.
   */
  for (const reviewer of reviewers) {
    for (const slug of readable) {
      const book = findBook(slug)
      if (!book) continue

      try {
        const listing = await store.listAnnotations({ kind: 'reviewer', id: reviewer.id }, slug)
        // A row that would not read is a gap in what Mike is being shown. A
        // row withheld by the visibility test below is not -- see the note in
        // `listSharedReviewerNotes`.
        if (listing.incomplete) note('annotations', slug)
        for (const row of listing.annotations) {
          // The author's visibility test, applied to every row without
          // exception. A `private` annotation never gets past this line.
          if (!canViewAnnotation(viewer, row)) continue
          const chapter = findReleasedChapter(book, row.chapterSlug)
          const anchorOk = chapter !== null
          items.push(annotationItem(row, book, anchorOk))
        }
      } catch {
        note('annotations', slug)
      }

      try {
        const comments = await feedback.listForReviewer(reviewer.id, slug)
        if (comments.incomplete) note('comments', slug)
        for (const row of comments.entries) {
          const chapter = findReleasedChapter(book, row.chapterSlug)
          items.push({
            itemId: `comment:${row.id}`,
            kind: 'comment',
            sourceId: row.id,
            originator: 'reviewer',
            reviewerId: row.reviewerId,
            reviewerName: null,
            bookSlug: book.slug,
            bookTitle: book.title,
            scope: row.scope,
            chapterSlug: row.chapterSlug,
            chapterNumber: chapter?.number ?? null,
            chapterLabel: chapter?.label ?? row.chapterSlug,
            paragraphId: row.paragraphId,
            paragraphOrdinal: row.paragraphOrdinal,
            captured: row.quote,
            body: row.comment,
            revision: null,
            // A submitted comment carries no anchor fingerprint, so there is
            // nothing to re-check and nothing is claimed about it.
            anchorState: chapter ? 'ok' : 'needs-relocation',
            manuscriptChanged: null,
            createdAt: row.createdAt,
            // Immutable by construction: what was submitted is what is stored.
            updatedAt: row.createdAt,
            withdrawnAt: null,
            authorNoteStatus: null,
          })
        }
      } catch {
        note('comments', slug)
      }
    }
  }

  for (const item of items) {
    if (item.reviewerId !== null) item.reviewerName = named.get(item.reviewerId) ?? null
  }

  return {
    items: sortAuthorItems(items),
    books,
    notFound,
    incomplete: failures.length > 0,
    failures,
  }
}
