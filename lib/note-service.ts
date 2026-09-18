/**
 * Every operation on notes, in one place, for both kinds of reader.
 *
 * The reviewer's reader and the author's reader are two sessions, two cookies
 * and two route families, and they are the same operations. Written twice they
 * would be two chances to forget a check, so they are written once -- exactly
 * the reasoning `lib/reading-service.ts` records for bookmarks and positions,
 * and this module is its counterpart for notes.
 *
 * Each function takes an already-established `Viewer` and re-derives everything
 * else from trusted sources:
 *
 *   **Identity** is the caller's. The route resolves it from a signed cookie
 *   before calling in; nothing in a request body can name an owner, and the
 *   owner written onto every note is `viewerOwner(viewer)`.
 *
 *   **Book authorization** is re-checked here against the live entitlement the
 *   route just loaded, and again against the manuscript: a book the deployment
 *   has not loaded cannot be written about by anybody, the author included.
 *
 *   **The anchor is built here, never accepted.** The chapter must be released;
 *   the paragraph must exist; the offsets must fit its text. The quotation and
 *   the paragraph text stored on a note are copied *out of the manuscript*, so
 *   a note cannot quote words the book does not contain.
 *
 *   **Visibility fails private.** A missing, misspelled or unrecognised value
 *   is `private`. Sharing is only ever an explicit `'shared'` from someone who
 *   is allowed to share -- which the author never is, because his notes are
 *   private by definition and have no sharing control at all.
 *
 *   **Ownership is enforced by construction.** A note is only read, replaced or
 *   deleted beneath the caller's own prefix, so a guessed identifier reaches
 *   nothing: the path that would name somebody else's note is never built.
 *
 * ## What Package 2 may build on
 *
 * The read interfaces at the foot of this file -- `listSharedReviewerNotes`,
 * `listAuthorNotes` and `listLegacyComments` -- are the stable surface the
 * dashboard, triage and export work will consume. They are deliberately plain:
 * they take a viewer and some book slugs, they answer with resolved rows, and
 * they read no audit history and no private note. Nothing about triage state,
 * saved views, last-read markers, export stamps or tombstones is decided here,
 * because deciding it here is what would force Package 2 to redesign this
 * contract instead of using it.
 */

import {
  findBook,
  findParagraph,
  findReleasedChapter,
  listBookSlugs,
  releasedChapters,
  type ProseParagraph,
  type ReaderBook,
  type ReaderChapter,
} from './manuscript.ts'
import { viewerMayReadBook, viewerOwner, type OwnerRef, type Viewer } from './reading-access.ts'
import { normalizeOffsets } from './reading-anchor.ts'
import {
  AUTHOR_NOTE_SCOPES,
  asExpectedNoteRevision,
  asNoteStatus,
  asNoteVisibility,
  isNoteScope,
  MAX_PARAGRAPH_TEXT_LENGTH,
  normalizeNoteBody,
  REVIEWER_NOTE_SCOPES,
  resolveNoteAnchor,
  type AnchorChapter,
  type NoteAnchor,
  type NoteAnchorState,
  type NoteScope,
  type NoteStatus,
  type NoteVisibility,
} from './note-contract.ts'
import { createNoteStore, sortNotes, type Note } from './notes-store.ts'
import { ReadingStorageUnavailableError } from './reviewer-reading.ts'
import { createFeedbackStore, type FeedbackEntry } from './reviewer-feedback.ts'
import { createWithdrawalStore, type WithdrawalEvent } from './withdrawal-events.ts'

if (typeof window !== 'undefined') {
  throw new Error(
    'lib/note-service is server-only and must not be imported by a client component',
  )
}

/* ----------------------------------------------------------------- results */

/**
 * Why an operation could not be performed.
 *
 * `not-found` deliberately covers both "there is no such thing" and "that is
 * not yours", because telling them apart would turn an identifier into a way to
 * enumerate other people's notes.
 *
 * `conflict` is its own answer and is never merged into any of the others. It
 * means the note exists, the caller may change it, and the version they were
 * looking at is not the version that is stored -- so nothing was written. Told
 * as `not-found` it would read as "your note is gone"; told as
 * `storage-unavailable` it would read as an outage worth retrying; told as
 * success it would be a lie. It is the one failure here that a person can act
 * on, by looking at what the note actually says now.
 */
export type NoteFailure = 'not-found' | 'invalid' | 'storage-unavailable' | 'conflict'

export type NoteResult<T> = { ok: true; value: T } | { ok: false; reason: NoteFailure }

function fail<T>(reason: NoteFailure): NoteResult<T> {
  return { ok: false, reason }
}

function ok<T>(value: T): NoteResult<T> {
  return { ok: true, value }
}

/* -------------------------------------------------------------- the views */

/** A note with its anchor re-checked, and what this viewer may do with it. */
export type ResolvedNote = Note & {
  anchorState: NoteAnchorState
  /** True when the chapter file has moved since. Evidence, never a verdict. */
  manuscriptChanged: boolean
  /**
   * The paragraph to link to now, or null. For a paragraph note whose text has
   * moved within its chapter this is where that text actually is.
   */
  paragraphId: string | null
  /** True when this viewer wrote it. Only its author may change it. */
  own: boolean
}

/** One reviewer's shared note, as the author reads it. */
export type SharedReviewerNote = ResolvedNote & {
  /** The book's title, so a listing reads without re-loading the manuscript. */
  bookTitle: string
}

/** One legacy submitted comment, adapted at read time and never rewritten. */
export type LegacyComment = {
  id: string
  reviewerId: string
  bookSlug: string
  chapterSlug: string
  chapterLabel: string
  scope: 'paragraph' | 'chapter'
  paragraphId: string | null
  paragraphOrdinal: number | null
  quote: string | null
  comment: string
  createdAt: string
  /** True while the chapter it was submitted about is still released. */
  chapterExists: boolean
}

/* ----------------------------------------------------------------- helpers */

/**
 * The book, but only when this viewer may read it and it is actually loaded.
 *
 * The same two refusals `lib/reading-service.ts` makes, in the same order and
 * for the same reasons, and the second does not depend on the first having
 * happened: entitlement against the live roster, then the manifest's own answer
 * to who the manuscript is loaded for. Both answer null, and every caller turns
 * null into the same `not-found` a missing book gets.
 */
function openBook(viewer: Viewer, bookSlug: string): ReaderBook | null {
  if (!viewerMayReadBook(viewer, bookSlug)) return null
  const book = findBook(bookSlug)
  if (!book) return null
  if (book.audience !== 'reviewers' && viewer.kind !== 'author') return null
  return book
}

/** The released chapter reduced to what an anchor re-check needs. */
function anchorChapter(book: ReaderBook, chapterSlug: string): AnchorChapter | null {
  const chapter = findReleasedChapter(book, chapterSlug)
  if (!chapter) return null
  return {
    slug: chapter.slug,
    sha256: chapter.sha256,
    paragraphs: chapter.blocks
      .filter((block): block is ProseParagraph => block.kind === 'paragraph')
      .map((block) => ({ id: block.id, ordinal: block.ordinal, text: block.text })),
  }
}

function resolveNote(viewer: Viewer, book: ReaderBook, note: Note): ResolvedNote {
  const slug = note.anchor.scope === 'book' ? null : note.anchor.chapterSlug
  const resolution = resolveNoteAnchor(
    note.anchor,
    slug === null ? null : anchorChapter(book, slug),
  )
  return {
    ...note,
    anchorState: resolution.state,
    manuscriptChanged: resolution.manuscriptChanged,
    paragraphId: resolution.paragraphId,
    own: note.ownerKind === viewer.kind && note.ownerId === viewer.id,
  }
}

/**
 * May this viewer read this note?
 *
 * Its author always may. Mike additionally sees a reviewer note the reviewer
 * explicitly shared -- and nothing else. There is no state in which one
 * reviewer sees another's note, and no state in which anybody sees one of
 * Mike's: an author note is `private` on the row, and the row is what is asked.
 *
 * Entitlement to the book is **not** part of this test, and that is the one
 * deliberate difference from `canViewAnnotation`. A reviewer's shared note is
 * something they said to the author about an unpublished manuscript; whether
 * they may still open that manuscript today is a separate question, asked
 * separately, and its answer must not silently delete what they told him.
 */
export function canViewNote(viewer: Viewer, note: Note): boolean {
  if (note.ownerKind === viewer.kind && note.ownerId === viewer.id) return true
  if (viewer.kind !== 'author') return false
  return note.ownerKind === 'reviewer' && note.visibility === 'shared'
}

/** The scopes this viewer's composer may use. */
export function scopesFor(viewer: Viewer): readonly NoteScope[] {
  return viewer.kind === 'author' ? AUTHOR_NOTE_SCOPES : REVIEWER_NOTE_SCOPES
}

/* ------------------------------------------------------------ the anchors */

export type NoteInput = {
  bookSlug: unknown
  scope: unknown
  chapterSlug?: unknown
  paragraphId?: unknown
  startOffset?: unknown
  endOffset?: unknown
  body: unknown
  visibility?: unknown
}

/**
 * Build the anchor for one scope, entirely from the verified manuscript.
 *
 * Every scope takes what that scope needs and refuses to invent the rest. A
 * book note gets `{ scope: 'book' }` and no fabricated chapter; a chapter note
 * gets the chapter's fingerprint and no fabricated paragraph; a paragraph note
 * gets the paragraph's **own** text out of the manuscript, not the browser's
 * idea of it.
 */
function buildAnchor(
  book: ReaderBook,
  scope: NoteScope,
  input: NoteInput,
): NoteResult<NoteAnchor> {
  if (scope === 'book') return ok({ scope: 'book' } as NoteAnchor)

  const chapterSlug = typeof input.chapterSlug === 'string' ? input.chapterSlug : ''
  // A draft chapter resolves to null, so an unreleased chapter cannot be
  // written about even by an entitled reader who guesses its slug.
  const chapter = findReleasedChapter(book, chapterSlug)
  if (!chapter) return fail('not-found')

  if (scope === 'chapter') {
    return ok({
      scope: 'chapter',
      chapterSlug: chapter.slug,
      chapterNumber: chapter.number,
      chapterLabel: chapter.label,
      manuscriptSha256: chapter.sha256,
    })
  }

  const paragraph = findParagraph(
    chapter,
    typeof input.paragraphId === 'string' ? input.paragraphId : '',
  )
  if (!paragraph) return fail('invalid')

  if (scope === 'paragraph') {
    // The paragraph, whole, from the manuscript. A paragraph too long to store
    // whole is refused at this scope rather than stored truncated -- comparing
    // a prefix and calling it the paragraph is exactly the loose matching this
    // contract refuses.
    if (paragraph.text.length > MAX_PARAGRAPH_TEXT_LENGTH) return fail('invalid')
    return ok({
      scope: 'paragraph',
      chapterSlug: chapter.slug,
      chapterNumber: chapter.number,
      chapterLabel: chapter.label,
      paragraphId: paragraph.id,
      paragraphOrdinal: paragraph.ordinal,
      paragraphText: paragraph.text,
      manuscriptSha256: chapter.sha256,
    })
  }

  const offsets = normalizeOffsets(input.startOffset, input.endOffset, paragraph.text.length)
  if (!offsets) return fail('invalid')

  return ok({
    scope: 'passage',
    chapterSlug: chapter.slug,
    chapterNumber: chapter.number,
    chapterLabel: chapter.label,
    paragraphId: paragraph.id,
    paragraphOrdinal: paragraph.ordinal,
    startOffset: offsets.start,
    endOffset: offsets.end,
    // The manuscript's characters, not the browser's.
    quote: paragraph.text.slice(offsets.start, offsets.end),
    manuscriptSha256: chapter.sha256,
  })
}

/* --------------------------------------------------------------- mutations */

/**
 * Write one note.
 *
 * The author's note is private, full stop: the visibility on the request is not
 * consulted at all for him, so there is no request shape -- honest, mistaken or
 * hostile -- that produces a shareable author note. A reviewer's visibility is
 * read through `asNoteVisibility`, which fails private.
 */
export async function createNote(
  viewer: Viewer,
  input: NoteInput,
): Promise<NoteResult<ResolvedNote>> {
  const book = openBook(viewer, typeof input.bookSlug === 'string' ? input.bookSlug : '')
  if (!book) return fail('not-found')

  if (!isNoteScope(input.scope)) return fail('invalid')
  const scope: NoteScope = input.scope
  if (!scopesFor(viewer).includes(scope)) return fail('invalid')

  const body = normalizeNoteBody(input.body)
  if (body === null) return fail('invalid')

  const anchor = buildAnchor(book, scope, input)
  if (!anchor.ok) return fail(anchor.reason)

  const owner = viewerOwner(viewer)
  const visibility: NoteVisibility =
    viewer.kind === 'author' ? 'private' : asNoteVisibility(input.visibility)

  try {
    const note = await createNoteStore().addNote({
      ownerKind: owner.kind,
      ownerId: owner.id,
      bookSlug: book.slug,
      scope,
      body,
      visibility,
      status: 'open',
      anchor: anchor.value,
    })
    return ok(resolveNote(viewer, book, note))
  } catch (error) {
    if (error instanceof ReadingStorageUnavailableError) return fail('storage-unavailable')
    throw error
  }
}

export type NoteChangeInput = {
  body?: unknown
  visibility?: unknown
  status?: unknown
  /**
   * The note's `revision` as the caller rendered it. Required on every update.
   *
   * Not optional, and not defaulted. An update with no expected revision is a
   * blind write -- precisely the request this correction exists to stop -- so
   * it is refused as `invalid` rather than being allowed through on an assumed
   * value. See `asExpectedNoteRevision`.
   */
  expectedRevision?: unknown
}

/**
 * Change a note's body, sharing or status.
 *
 * The anchor is not among the things that can change: offsets, quotation,
 * captured paragraph and fingerprint were written when the passage was actually
 * selected in a known version of the text, and rewriting them afterwards would
 * be the silent re-attachment this contract exists to refuse. `createdAt` is
 * likewise carried through; `updatedAt` moves.
 *
 * **Every update is conditional on the revision the caller rendered.** The
 * store re-reads the exact object, requires its revision to be that one, and
 * writes once against the storage version it just read. A mismatch either way
 * is a `conflict`: nothing is written, nothing is retried here or below, and
 * the answer is never reported as success, as absence, or as an outage.
 */
export async function updateNote(
  viewer: Viewer,
  bookSlug: unknown,
  id: unknown,
  changes: NoteChangeInput,
): Promise<NoteResult<ResolvedNote>> {
  const book = openBook(viewer, typeof bookSlug === 'string' ? bookSlug : '')
  if (!book) return fail('not-found')
  if (typeof id !== 'string' || id === '') return fail('not-found')

  const expectedRevision = asExpectedNoteRevision(changes.expectedRevision)
  if (expectedRevision === null) return fail('invalid')

  const patch: { body?: string; visibility?: NoteVisibility; status?: NoteStatus } = {}

  if (changes.body !== undefined) {
    const body = normalizeNoteBody(changes.body)
    if (body === null) return fail('invalid')
    patch.body = body
  }

  if (changes.visibility !== undefined) {
    // An author has no sharing control, so a visibility on his request is a
    // request this endpoint does not understand rather than one it obeys.
    if (viewer.kind === 'author') return fail('invalid')
    if (changes.visibility !== 'private' && changes.visibility !== 'shared') {
      return fail('invalid')
    }
    patch.visibility = changes.visibility
  }

  if (changes.status !== undefined) {
    // `open` / `resolved` is Mike's own triage of his own notes. A reviewer has
    // no such state, and a request that claims one is refused rather than
    // quietly ignored.
    if (viewer.kind !== 'author') return fail('invalid')
    if (changes.status !== 'open' && changes.status !== 'resolved') return fail('invalid')
    patch.status = asNoteStatus(changes.status)
  }

  /*
   * The id's shape is checked here rather than being allowed to throw out of
   * the path builder and be caught below. Catching everything would turn a
   * storage outage into "there is no such note" -- an answer, and a false one.
   * An outage must stay an outage; only a real absence is `not-found`.
   */
  if (!isRecordId(id)) return fail('not-found')

  try {
    const outcome = await createNoteStore().updateNote(
      viewerOwner(viewer),
      book.slug,
      id,
      patch,
      expectedRevision,
    )
    if (outcome.outcome === 'not-found') return fail('not-found')
    // Not retried. A conflict means the words underneath have moved, and the
    // only honest response is to say so -- see `NoteStore.updateNote`.
    if (outcome.outcome === 'conflict') return fail('conflict')
    return ok(resolveNote(viewer, book, outcome.note))
  } catch (error) {
    if (error instanceof ReadingStorageUnavailableError) return fail('storage-unavailable')
    throw error
  }
}

/**
 * What became of the withdrawal event a deletion may owe.
 *
 *   `not-owed`          the note was private. Nothing was written, nothing was
 *                       counted, and there is no trace of it anywhere Mike can
 *                       reach -- which is the whole of what `private` means.
 *   `recorded`          the note was shared, and one bodyless event now says so.
 *   `already-recorded`  an event for this note id was already there. A note id
 *                       is a UUID and is never reused, so this is idempotence
 *                       rather than a second withdrawal.
 *   `failed`            the deletion succeeded and the event did not.
 *
 * `failed` is a **residual, not a failure of the operation**. See `deleteNote`.
 */
export type WithdrawalOutcome = 'not-owed' | 'recorded' | 'already-recorded' | 'failed'

/** A deletion that happened, and what it left behind. */
export type NoteDeletion = { withdrawal: WithdrawalOutcome }

/**
 * Delete or retract one note, bound to the revision the caller rendered.
 *
 * The same call for both, because they are the same act: a reviewer withdrawing
 * a shared note and a reviewer deleting a private one are both "this is no
 * longer mine to have said". Nothing is copied anywhere first, so no retracted
 * body survives where its author cannot reach it.
 *
 * ## The revision is required
 *
 * Exactly as it is on an update, and refused as `invalid` rather than assumed
 * when it is missing. Package 1 documented the hole this closes in so many
 * words: a client still holding revision 1 could delete a note another client
 * of the same person had since edited to revision 2, destroying a body it had
 * never seen, and be told the delete succeeded. A stale delete is now a
 * `conflict`: nothing is removed, nothing is retried here or below, and the
 * answer is never success, never absence, and never an outage.
 *
 * ## Delete first, event second -- and never the other way round
 *
 * An event written before a deletion is a statement that something happened
 * which may then not happen: if the conditional removal is refused, Mike has
 * been told a note was withdrawn while the note is still there, still shared,
 * and still in his inbox. There is no ordering in which that is recoverable, so
 * the event is written only **after** a removal that actually succeeded, and
 * only for a note that was `shared` at that moment.
 *
 * ## When the event fails after the deletion has already happened
 *
 * The deletion **stands**. It is not rolled back -- the note is gone, the words
 * cannot be un-deleted, and re-creating the object would resurrect content its
 * author has retracted, which is the one outcome this whole contract exists to
 * make impossible. It is also not reported to the reviewer as a failure: from
 * their side the act succeeded, and telling them otherwise would invite them to
 * try again at a note that no longer exists.
 *
 * What is recorded instead is the exact residual, honestly and secret-safely:
 * `withdrawal: 'failed'` on this result, and one fixed-string line on the
 * server console naming the operation and nothing else -- no note id, no book,
 * no body, no reviewer, no store path, no error text. The consequence is stated
 * plainly rather than hidden: **the note is deleted and Mike will not be told
 * it was withdrawn.** That is a missing event, not a surviving note.
 */
export async function deleteNote(
  viewer: Viewer,
  bookSlug: unknown,
  id: unknown,
  expectedRevision: unknown,
): Promise<NoteResult<NoteDeletion>> {
  const book = openBook(viewer, typeof bookSlug === 'string' ? bookSlug : '')
  if (!book) return fail('not-found')
  if (!isRecordId(id)) return fail('not-found')

  const revision = asExpectedNoteRevision(expectedRevision)
  if (revision === null) return fail('invalid')

  let removed: Note
  try {
    const outcome = await createNoteStore().removeNote(
      viewerOwner(viewer),
      book.slug,
      id,
      revision,
    )
    if (outcome.outcome === 'not-found') return fail('not-found')
    // Not retried, for the reason `NoteStore.removeNote` records.
    if (outcome.outcome === 'conflict') return fail('conflict')
    removed = outcome.note
  } catch (error) {
    if (error instanceof ReadingStorageUnavailableError) return fail('storage-unavailable')
    // As above: a store that failed is never reported as a note that was not there.
    throw error
  }

  /*
   * Private notes leave nothing at all. Not an event, not a placeholder, not a
   * count, not an error detail -- and the branch is taken on the row that was
   * actually removed rather than on anything the request said, so there is no
   * request shape that can manufacture an event for a note Mike was never
   * allowed to see. An author's own note is private by definition and takes
   * this branch too.
   */
  if (removed.ownerKind !== 'reviewer' || removed.visibility !== 'shared') {
    return ok({ withdrawal: 'not-owed' as const })
  }

  const event: WithdrawalEvent = {
    schema: 1,
    noteId: removed.id,
    bookSlug: removed.bookSlug,
    scope: removed.scope,
    // The chapter, where the scope had one. A book note anchors to nothing and
    // gets nothing; nothing here invents a place.
    chapterSlug: removed.anchor.scope === 'book' ? null : removed.anchor.chapterSlug,
    revision: removed.revision,
    withdrawnAt: new Date().toISOString(),
  }

  try {
    const written = await createWithdrawalStore().record(event)
    return ok({ withdrawal: written })
  } catch {
    /*
     * Fixed string, and nothing from the error, the note or the store in it.
     * The residual is on the returned value, where a caller can act on it; the
     * console line exists so an operator can see that it happened at all.
     */
    console.error('[notes] withdrawal event write failed after a successful deletion')
    return ok({ withdrawal: 'failed' as const })
  }
}

/**
 * Whether this is the shape of an identifier this store ever mints.
 *
 * Checked before a path is built, so a malformed id is a plain "not found"
 * rather than an exception a caller has to guess the meaning of -- and so that
 * catching storage failures never has to double as catching bad input.
 */
function isRecordId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value)
}

/* ------------------------------------------------------------------ reading */

/**
 * This viewer's own notes on one book. Their own prefix, and nothing else.
 *
 * **Two different failures, and neither is an empty list.** An unconfigured
 * store answers `storage-unavailable`, exactly as every other operation here
 * does. Any other failure of the store -- a refused read, a dropped connection,
 * a listing that would not enumerate -- is **thrown**, and is deliberately not
 * caught and flattened into a result: catching everything would mean a caller
 * could no longer tell a store that answered from a store that did not, which
 * is the same mistake in a different disguise. Callers that render notes must
 * handle both, and `readOwnNotes` below is how they do it in one place.
 */
export async function listOwnNotes(
  viewer: Viewer,
  bookSlug: string,
): Promise<NoteResult<ResolvedNote[]>> {
  const book = openBook(viewer, bookSlug)
  if (!book) return fail('not-found')

  try {
    const rows = await createNoteStore().listNotes(viewerOwner(viewer), bookSlug)
    return ok(rows.map((note) => resolveNote(viewer, book, note)))
  } catch (error) {
    if (error instanceof ReadingStorageUnavailableError) return fail('storage-unavailable')
    throw error
  }
}

/**
 * Raised when a viewer's own notes could not be read.
 *
 * It exists for the same reason `FeedbackUnreadableError` does, stated in
 * `lib/reading-workspace.ts`: *"A storage failure must not be rendered as 'you
 * have written nothing'. That was a real defect in this codebase once, and the
 * fix was to let the failure propagate rather than swallow it."* Notes were
 * getting none of that. Four surfaces reduced this call to
 * `notes.ok ? notes.value : []`, so a store that failed and a reader who had
 * written nothing produced the identical page.
 */
export class NotesUnreadableError extends Error {
  readonly bookSlug: string
  /** `storage-unavailable` for a store that answered; `failed` for one that threw. */
  readonly reason: 'storage-unavailable' | 'failed'

  constructor(bookSlug: string, reason: 'storage-unavailable' | 'failed') {
    super('notes could not be read')
    this.name = 'NotesUnreadableError'
    this.bookSlug = bookSlug
    this.reason = reason
  }
}

/**
 * This viewer's own notes on a book whose access has **already been settled**,
 * with the three outcomes kept apart.
 *
 * Every surface that renders notes has already decided, by some other call,
 * that this viewer may read this book -- `loadBookReading` on the reader pages,
 * the workspace's own per-book load. So the three things that can happen here
 * are not the same thing, and this is the one place that says so:
 *
 *   - the notes, when they were read;
 *   - `null`, meaning the **book** is not there for this viewer. Only `openBook`
 *     can answer that, and after a successful book load it means the roster or
 *     the manifest moved underneath this request. The caller decides: a page
 *     about one book takes its own not-found path, a workspace across many
 *     skips that book exactly as it already skips an unloaded one;
 *   - a thrown `NotesUnreadableError` for anything else, which every caller
 *     lets propagate. It is never an empty list and never an absent book.
 */
export async function readOwnNotes(
  viewer: Viewer,
  bookSlug: string,
): Promise<ResolvedNote[] | null> {
  let result: NoteResult<ResolvedNote[]>
  try {
    result = await listOwnNotes(viewer, bookSlug)
  } catch {
    throw new NotesUnreadableError(bookSlug, 'failed')
  }

  if (result.ok) return result.value
  if (result.reason === 'not-found') return null
  throw new NotesUnreadableError(bookSlug, 'storage-unavailable')
}

/* --------------------------------------------- the Package 2 read interface */

/**
 * Every reviewer note shared with the author, across the books he can open.
 *
 * **Roster-independent by construction.** The listing is a prefix on the book,
 * not a walk over whoever is currently a reviewer, so a reviewer who has been
 * removed, revoked, or had this book withdrawn still appears here with exactly
 * what they shared. That is the point: a note is something somebody said about
 * an unpublished manuscript, and the reading arrangement ending is not a reason
 * for it to have gone unsaid.
 *
 * **Private notes never leave this function.** Every row is put past
 * `canViewNote` as the author before it is added, so a reviewer's private
 * passage, paragraph or chapter note is not returned, not counted, and not
 * named -- here or in anything built on top of this.
 */
export async function listSharedReviewerNotes(
  viewer: Viewer,
  bookSlugs: readonly string[],
): Promise<SharedReviewerNote[]> {
  if (viewer.kind !== 'author') return []

  const store = createNoteStore()
  const out: SharedReviewerNote[] = []

  for (const slug of bookSlugs) {
    const book = openBook(viewer, slug)
    if (!book) continue

    for (const note of await store.listBookNotes(slug, 'reviewer')) {
      if (!canViewNote(viewer, note)) continue
      out.push({ ...resolveNote(viewer, book, note), bookTitle: book.title })
    }
  }

  return out
}

/** Mike's own notes across the books he can open. Never anybody else's. */
export async function listAuthorNotes(
  viewer: Viewer,
  bookSlugs: readonly string[],
): Promise<SharedReviewerNote[]> {
  if (viewer.kind !== 'author') return []

  const store = createNoteStore()
  const owner: OwnerRef = viewerOwner(viewer)
  const out: SharedReviewerNote[] = []

  for (const slug of bookSlugs) {
    const book = openBook(viewer, slug)
    if (!book) continue
    for (const note of await store.listNotes(owner, slug)) {
      out.push({ ...resolveNote(viewer, book, note), bookTitle: book.title })
    }
  }

  return out
}

/**
 * The legacy submitted comments for one reviewer and one book.
 *
 * Read through the existing append-only store and **adapted, never rewritten**.
 * Nothing here writes, migrates, re-serialises or re-orders a stored row: the
 * bytes on disk are the bytes a reviewer's comment was written as, and this
 * function only decides how to describe them. They are surfaced everywhere
 * under one label -- "Earlier submitted comments" -- so the old model is never
 * mistaken for the note contract that replaced it.
 */
export async function listLegacyComments(
  bookSlug: string,
  reviewerId: string,
): Promise<LegacyComment[]> {
  const book = findBook(bookSlug)
  if (!book) return []

  const rows = await createFeedbackStore().listForReviewer(reviewerId, bookSlug)
  return rows.map((row) => adaptLegacyComment(book, row))
}

/** One stored feedback row, described as this package describes it. */
export function adaptLegacyComment(book: ReaderBook, row: FeedbackEntry): LegacyComment {
  const chapter: ReaderChapter | null = findReleasedChapter(book, row.chapterSlug)
  return {
    id: row.id,
    reviewerId: row.reviewerId,
    bookSlug: row.bookSlug,
    chapterSlug: row.chapterSlug,
    chapterLabel: chapter?.label ?? row.chapterSlug,
    scope: row.scope,
    paragraphId: row.paragraphId,
    paragraphOrdinal: row.paragraphOrdinal,
    quote: row.quote,
    comment: row.comment,
    createdAt: row.createdAt,
    chapterExists: chapter !== null,
  }
}

/**
 * Every book slug this viewer can actually open, with a released chapter in it.
 *
 * The author's library is every manuscript the site has loaded -- PERSISTENT
 * included, which is his and nobody else's. A reviewer's is their own live
 * entitlements, filtered by `openBook`, which refuses an author-only manuscript
 * whatever the entitlements said.
 */
export function readableBookSlugs(viewer: Viewer): string[] {
  const slugs: string[] = []
  for (const slug of viewer.kind === 'author' ? listBookSlugs() : viewer.books) {
    const book = openBook(viewer, slug)
    if (book && releasedChapters(book).length > 0) slugs.push(slug)
  }
  return slugs
}

/** Re-exported so a caller can order a mixed list the way the store does. */
export { sortNotes }

/* --------------------------------------------------- the note's private link */

/** A note opened from its private link, with where it sits in the book. */
export type OpenedNote = {
  note: ResolvedNote
  book: ReaderBook
  chapter: ReaderChapter | null
}

/**
 * Open one note from its locator: a book slug and a note identifier.
 *
 * **The locator is not a capability.** It carries no token and no signature,
 * and it is not consulted when deciding who may read anything -- it only says
 * *which* note is meant. Everything after that is the ordinary rule: the book
 * has to be one this viewer can open, the note has to exist, and `canViewNote`
 * has to say yes. So the access matrix here is the access matrix everywhere:
 *
 *   - a reviewer's **private** note opens for its owner and for nobody else,
 *     Mike included;
 *   - a reviewer's **shared** note opens for its owner and for Mike;
 *   - one of **Mike's own** notes opens for Mike and for nobody else.
 *
 * A deleted note is simply not there, so its link stops opening -- there is no
 * separate step that has to remember to withdraw it, and nothing to forget.
 *
 * The cross-owner listing is reached **only** when the caller is the author,
 * which is the same restriction `listSharedReviewerNotes` is under and for the
 * same reason: the prefix that would name somebody else's note is never built
 * on a reviewer's path, so a reviewer holding another reviewer's link cannot
 * even cause it to be read, let alone see it.
 */
export async function openNoteByLocator(
  viewer: Viewer,
  bookSlug: unknown,
  noteId: unknown,
): Promise<NoteResult<OpenedNote>> {
  const book = openBook(viewer, typeof bookSlug === 'string' ? bookSlug : '')
  if (!book) return fail('not-found')
  // Checked before a path is built, so a malformed identifier is a plain
  // "not found" rather than an exception that a storage outage would look like.
  if (!isRecordId(noteId)) return fail('not-found')

  const store = createNoteStore()
  let found: Note | null = null

  try {
    found = await store.getNote(viewerOwner(viewer), book.slug, noteId)

    if (!found && viewer.kind === 'author') {
      for (const row of await store.listBookNotes(book.slug, 'reviewer')) {
        if (row.id === noteId) {
          found = row
          break
        }
      }
    }
  } catch (error) {
    if (error instanceof ReadingStorageUnavailableError) return fail('storage-unavailable')
    throw error
  }

  if (!found) return fail('not-found')
  // Belt and braces. The row was already reached only where it could be, and it
  // is put past the visibility rule anyway before a single character is shown.
  if (!canViewNote(viewer, found)) return fail('not-found')

  const slug = found.anchor.scope === 'book' ? null : found.anchor.chapterSlug

  return ok({
    note: resolveNote(viewer, book, found),
    book,
    chapter: slug === null ? null : findReleasedChapter(book, slug),
  })
}
