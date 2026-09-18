/**
 * Mike's own workflow metadata: what he has read, what he has dealt with, what
 * he has exported, and the views he has saved.
 *
 * ## Whose record this is, and what it may not become
 *
 * Everything else in this codebase that describes a reviewer's note belongs to
 * the reviewer: they wrote it, they can change it, and they can take it back.
 * This record belongs to **Mike**, and it is about his handling of what he was
 * shown -- not about what he was shown. That distinction is the whole design
 * constraint, because a triage record is exactly the place where a retracted
 * note's words would quietly survive.
 *
 * So there is a closed list of what an item's metadata may carry:
 *
 *   a stable, type-prefixed item id    `note:<id>`, `comment:<id>`, ...
 *   `resolved`                         a reversible choice of Mike's
 *   `lastReadAt`                       when he explicitly opened it
 *   `lastExportedAt`                   when it last left in a packet
 *
 * and nothing else. No body, no quotation, no paragraph text, no anchor
 * payload, no reading position, no email, no access code, no token, no
 * credential, no storage path. `asAuthorMetadata` builds every field it returns
 * from that fixed list rather than spreading what it was handed, so a caller
 * cannot widen a stored document by passing a larger object, and
 * `tests/author-metadata.test.ts` scans the serialized bytes for each exclusion
 * by name.
 *
 * A **saved view** is the one place free text appears, and it is Mike's own: a
 * name he typed for a filter he built. Its filters are deliberately structural
 * -- book slugs, `<book>/<chapter>` coordinates, source kinds, scopes, and a
 * New/Resolved/All state -- and there is no free-text "search" filter, because
 * a search filter is a field into which a quotation from a note can be pasted
 * and then persisted. A view that cannot hold a quotation cannot leak one.
 *
 * A saved view lives in **one** document and never in a per-book one: see
 * `SAVED_VIEW_HOME_SLUG`, which states the ownership rule and why.
 *
 * ## The layout, and why one document per book
 *
 *   author-meta/v1/<authorId>/<bookSlug>.json
 *
 * One object, read with `getVersioned` and written with `putIfMatch` against
 * exactly the version that was read -- the pattern `lib/notes-store.ts` uses
 * for an edit and `lib/reviewer-reading.ts` uses for a position. One document
 * per book, rather than one per item, for three reasons that all point the same
 * way:
 *
 *   **A multi-item change is one write.** Stamping `lastExportedAt` on
 *   forty items in one packet is one conditional write that either lands whole
 *   or does not land at all. Spread across forty objects it would be forty
 *   writes, any subset of which could fail -- a partial cross-object update,
 *   which is precisely what this record must never silently accept.
 *
 *   **Reading is one read.** A dashboard asking "what is new" reads one object
 *   per book rather than walking a prefix, so the eight-in-flight bound is not
 *   even in question on this path.
 *
 *   **It is bounded.** An entry is four short fields under a bounded key, the
 *   number of items on a book is the number of things reviewers have written
 *   about it, and the item count, the view count, a view's name, and the
 *   filters inside a view are all capped below (`MAX_METADATA_ITEMS`,
 *   `MAX_SAVED_VIEWS`, `MAX_VIEW_NAME_LENGTH`, `MAX_VIEW_BOOKS`, and the kind
 *   and scope enums over deduplicated arrays) with a refusal rather than a
 *   silent truncation. Every one of those is needed for the sentence to be
 *   true: capping the number of views while leaving the arrays inside a view
 *   unbounded caps nothing, because one view can then be any size at all.
 *
 * `<authorId>` is on the path even though there is one author, for the same
 * reason every reading record carries its owner: the prefix that would name
 * somebody else's record is then never constructed, rather than merely never
 * reached. It is the keyed, non-reversible derivation `lib/reading-owner.ts`
 * produces, not an address.
 *
 * ## Reviewers cannot reach any of this
 *
 * Every operation here takes a `Viewer` and answers `forbidden` for anything
 * that is not the author, before a path is built. There is no reviewer route
 * that imports this module, no reviewer session that can name this prefix, and
 * no request shape that supplies the owner -- the owner is taken from the
 * established viewer, exactly as it is for notes.
 *
 * ## An unreadable record is not an empty one
 *
 * A store that will not answer produces `unreadable`, never a document full of
 * defaults. Defaults here would read as "nothing has been dealt with and
 * everything is new", which is a confident statement about Mike's own work that
 * nobody is in a position to make.
 */

import { viewerOwner, type Viewer } from './reading-access.ts'
import { createReadingObjects, type ReadingObjects } from './reviewer-reading.ts'
import { ReadingStorageUnavailableError } from './reviewer-reading.ts'

if (typeof window !== 'undefined') {
  throw new Error(
    'lib/author-metadata is server-only and must not be imported by a client component',
  )
}

/** Layout version. A later layout is a new prefix, never a reinterpretation. */
export const AUTHOR_METADATA_PREFIX_VERSION = 'v1'

/** Root of every object this store writes. */
export const AUTHOR_METADATA_ROOT = `author-meta/${AUTHOR_METADATA_PREFIX_VERSION}`

const OWNER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/
const BOOK_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * A stable item id: a source kind, a colon, and that source's own identifier.
 *
 * Type-prefixed so that two sources cannot collide on one key, and so that a
 * key on its own says what it refers to without a lookup. The identifier half
 * is a record id from the store it came from; it is not a body, a path or a
 * person.
 */
export const ITEM_ID_PATTERN = /^(note|comment|annotation|withdrawal):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** The most items one book's metadata document may carry. */
export const MAX_METADATA_ITEMS = 5000

/** The most saved views one book's metadata document may carry. */
export const MAX_SAVED_VIEWS = 50

/** The longest a saved view's name may be. */
export const MAX_VIEW_NAME_LENGTH = 80

/**
 * The most distinct books one saved view's filter may name.
 *
 * `kinds` and `scopes` are bounded by their own enums once duplicates are gone
 * -- there are four of each and no fifth -- but a book slug is any string
 * matching a pattern, so that array is the one that needs a number. Fifty is
 * far past any bookshelf this is for and still keeps a maximal view small.
 */
export const MAX_VIEW_BOOKS = 50

/**
 * The most distinct chapters one saved view's filter may name.
 *
 * A chapter coordinate is two pattern-checked slugs, so like `books` it is an
 * open set and needs a number of its own. Two hundred is past any single book's
 * chapter count here (the largest loaded manuscript has twenty-nine) and still
 * keeps a maximal view small enough to serialize without thought.
 */
export const MAX_VIEW_CHAPTERS = 200

/**
 * One chapter, named unambiguously across books.
 *
 * A chapter slug is only unique **inside** its book -- two books may each have
 * a `chapter-one` -- so a filter that stored bare chapter slugs would select
 * chapters of books it never named. The coordinate is therefore the pair, and
 * the separator is the same injective one `lib/author-export.ts` uses for a
 * stamp: `BOOK_SLUG_PATTERN` admits no `/`, so the first `/` splits a
 * coordinate back into exactly the pair it was built from, and two distinct
 * pairs cannot collide.
 */
export const VIEW_CHAPTER_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9-]{0,63}$/

/** The coordinate for one chapter of one book. See `VIEW_CHAPTER_PATTERN`. */
export function chapterCoordinate(bookSlug: string, chapterSlug: string): string {
  return `${bookSlug}/${chapterSlug}`
}

/**
 * The one document every saved view lives in.
 *
 * ## The ownership rule, stated once
 *
 * A saved view has **exactly one durable copy**, and it is in
 * `author-meta/v1/<authorId>/saved-views.json` -- decided by this constant and
 * by nothing else. Not by the books the view names, not by the book being
 * looked at when it was saved, not by a first or a smallest slug. A view naming
 * forty books is one object in one document, and deleting it is one write.
 *
 * The alternative -- a copy under each book a view names -- was rejected
 * outright. A view is a filter *across* books, so per-book copies would have to
 * be written n times, deleted n times, and reconciled when the n disagreed;
 * a view naming no book at all (meaning "everything") would have no home; and a
 * partial write would leave a view that exists for some books and not others,
 * which is not a state this product has any honest way to render.
 *
 * `saved-views` is a **reserved slug**: it matches `BOOK_SLUG_PATTERN`, so the
 * committed store, parser and path builder need no special case, and
 * `tests/author-saved-views.test.ts` asserts no loaded manuscript slug is equal
 * to it -- the same guard `tests/manuscript.test.ts` keeps over reserved route
 * segments. The document's `items` map is never written: nothing stamps,
 * resolves or marks read against a slug that is not a book, because every one
 * of those paths is driven by `AuthorFeedbackSource.books`, which comes from
 * the manuscript manifest.
 */
export const SAVED_VIEW_HOME_SLUG = 'saved-views'

/** What Mike has done with one item. Four fields, and no fifth. */
export type AuthorItemMetadata = {
  /** Mike's reversible choice. Never set by reading, listing or exporting. */
  resolved: boolean
  /** ISO 8601, UTC. When he explicitly opened this item. Null until he has. */
  lastReadAt: string | null
  /** ISO 8601, UTC. When it was last included in a generated packet. */
  lastExportedAt: string | null
}

/** Which New/Resolved slice a saved view is about. */
export type SavedViewState = 'all' | 'new' | 'resolved'

/** The kinds of thing the author's source can hold. */
export type AuthorSourceKind = 'note' | 'comment' | 'annotation' | 'withdrawal'

/** A note's scope, repeated here so this module needs no contract import. */
export type SavedViewScope = 'passage' | 'paragraph' | 'chapter' | 'book'

/**
 * One saved filter, named by Mike.
 *
 * Structural only -- see the module comment. Every filter is a set of
 * identifiers or enumerated values; there is no free-text field a quotation
 * could be pasted into and persisted.
 */
export type SavedView = {
  id: string
  name: string
  books: string[]
  /**
   * `<bookSlug>/<chapterSlug>` coordinates. Empty means every chapter.
   *
   * Structural, like every other filter here: a coordinate names where a thing
   * sits, never what it says.
   */
  chapters: string[]
  kinds: AuthorSourceKind[]
  scopes: SavedViewScope[]
  state: SavedViewState
}

/** One book's author metadata document, as stored. */
export type AuthorMetadata = {
  schema: 1
  bookSlug: string
  /** Keyed by stable item id. */
  items: Record<string, AuthorItemMetadata>
  views: SavedView[]
  /** ISO 8601, UTC. Moves on every accepted write. */
  updatedAt: string
}

/** A document together with the storage revision it was read at. */
export type VersionedAuthorMetadata = {
  metadata: AuthorMetadata
  /** Null exactly when no document has been written for this book yet. */
  version: string | null
}

/**
 * Why a metadata operation could not be performed.
 *
 *   `forbidden`             the caller is not the author.
 *   `invalid`              the request was understood and refused.
 *   `conflict`             the document moved underneath a conditional write.
 *                          Nothing was written.
 *   `storage-unavailable`  there is no durable store configured.
 *   `unreadable`           the store was there and would not answer. Never an
 *                          empty document, and never a guess.
 */
export type AuthorMetadataFailure =
  | 'forbidden'
  | 'invalid'
  | 'conflict'
  | 'storage-unavailable'
  | 'unreadable'

export type AuthorMetadataResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: AuthorMetadataFailure }

function fail<T>(reason: AuthorMetadataFailure): AuthorMetadataResult<T> {
  return { ok: false, reason }
}

function ok<T>(value: T): AuthorMetadataResult<T> {
  return { ok: true, value }
}

/* --------------------------------------------------------------- the paths */

function assertAuthor(authorId: string): void {
  if (!OWNER_ID_PATTERN.test(authorId)) {
    throw new Error('invalid author id for metadata storage')
  }
}

function assertBookSlug(bookSlug: string): void {
  if (!BOOK_SLUG_PATTERN.test(bookSlug)) {
    throw new Error('invalid book slug for metadata storage')
  }
}

/** Every metadata document belonging to one author. */
export function authorMetadataPrefix(authorId: string): string {
  assertAuthor(authorId)
  return `${AUTHOR_METADATA_ROOT}/${authorId}/`
}

export function authorMetadataPath(authorId: string, bookSlug: string): string {
  assertBookSlug(bookSlug)
  return `${authorMetadataPrefix(authorId)}${bookSlug}.json`
}

/* -------------------------------------------------------------- validation */

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function isIsoOrNull(value: unknown): value is string | null {
  if (value === null || value === undefined) return true
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function isKind(value: unknown): value is AuthorSourceKind {
  return (
    value === 'note' || value === 'comment' || value === 'annotation' || value === 'withdrawal'
  )
}

function isScope(value: unknown): value is SavedViewScope {
  return value === 'passage' || value === 'paragraph' || value === 'chapter' || value === 'book'
}

function isState(value: unknown): value is SavedViewState {
  return value === 'all' || value === 'new' || value === 'resolved'
}

/** An empty document for a book nothing has been recorded about yet. */
export function emptyAuthorMetadata(bookSlug: string, at: string): AuthorMetadata {
  return { schema: 1, bookSlug, items: {}, views: [], updatedAt: at }
}

/**
 * Accept a stored object only if it really is a metadata document.
 *
 * Unlike a note, nothing here is normalised into existence: this record holds
 * no words, so a damaged one is not evidence of anything and is refused. The
 * refusal becomes `unreadable` above -- an explicit failure -- rather than an
 * empty document, which would tell Mike he had dealt with nothing.
 *
 * Items are **not** an exception. A malformed entry -- a key that is not a
 * valid item id, a non-object value, a `resolved` that is not a boolean, a
 * timestamp that is not a timestamp -- makes the whole document unreadable,
 * exactly as damage anywhere else in it does.
 *
 * The earlier version dropped such an entry and kept the rest, on the reasoning
 * that losing one item's triage is smaller than losing five hundred, and that a
 * dropped item can only make Mike look at something again. That reasoning is
 * wrong about what the reader is told. A dropped item does not read as "this
 * item's triage was damaged": it reads as `resolved: false`, never opened,
 * never exported -- the all-new, unresolved guess -- and a packet renders that
 * guess as fact. An unreadable source must stay an explicit failure, and
 * item-level damage is no less damage for being small. Nothing this module
 * writes can produce a malformed entry, so a document holding one has been
 * damaged from outside, which is precisely when a confident answer is worst.
 */
export function asAuthorMetadata(value: unknown, bookSlug: string): AuthorMetadata | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>

  if (row.schema !== 1) return null
  if (typeof row.bookSlug !== 'string' || row.bookSlug !== bookSlug) return null
  if (typeof row.updatedAt !== 'string' || Number.isNaN(Date.parse(row.updatedAt))) return null
  if (typeof row.items !== 'object' || row.items === null || Array.isArray(row.items)) return null
  if (!Array.isArray(row.views)) return null

  /*
   * The declared caps, applied **at read time** and not only on the way in.
   *
   * A cap that lives only on the write path caps what this module writes, which
   * was never the thing in doubt: nothing here can produce an over-cap document.
   * A document that holds one has been written by something else, and accepting
   * it would let the bound this record's size claims rest on be set by whatever
   * wrote the bytes. Refused, and refused whole -- the same rule the items below
   * follow, for the same reason: a silently trimmed document is a different
   * document that still answers.
   */
  if (Object.keys(row.items as Record<string, unknown>).length > MAX_METADATA_ITEMS) return null
  if (row.views.length > MAX_SAVED_VIEWS) return null

  const items: Record<string, AuthorItemMetadata> = {}
  for (const [key, raw] of Object.entries(row.items as Record<string, unknown>)) {
    // Every one of these is a refusal of the document, not a skip of the entry.
    // See the module comment: a skipped entry becomes the all-new guess.
    if (!ITEM_ID_PATTERN.test(key)) return null
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
    const entry = raw as Record<string, unknown>
    if (typeof entry.resolved !== 'boolean') return null
    if (!isIsoOrNull(entry.lastReadAt)) return null
    if (!isIsoOrNull(entry.lastExportedAt)) return null
    // Field by field, from a fixed list. Nothing else on the stored entry is
    // read, so nothing else on it can survive a round trip through this store.
    items[key] = {
      resolved: entry.resolved,
      lastReadAt: (entry.lastReadAt as string | null | undefined) ?? null,
      lastExportedAt: (entry.lastExportedAt as string | null | undefined) ?? null,
    }
  }

  /*
   * Views are not an exception either, and for the same reason items are not.
   *
   * A view that `asSavedView` refuses -- a damaged one, or one whose filter is
   * past `MAX_VIEW_BOOKS` -- used to be dropped while the document around it was
   * accepted. That is the items defect wearing a different hat: the view does
   * not come back as "damaged", it comes back as *absent*, and a saved view Mike
   * built and cannot find reads as one he never saved. Worse, the drop is
   * exactly how an over-cap filter would get past the bound instead of being
   * refused by it. So one refused view refuses the document.
   */
  const views: SavedView[] = []
  for (const raw of row.views) {
    const view = asSavedView(raw)
    if (!view) return null
    views.push(view)
  }

  return { schema: 1, bookSlug, items, views, updatedAt: row.updatedAt }
}

/**
 * One saved view, or null. Structural fields only; see the module comment.
 *
 * Normalizing, not merely checking: the three filter arrays come back as sets,
 * in first-occurrence order, and a view naming more than `MAX_VIEW_BOOKS`
 * distinct books is refused outright rather than truncated to fit. A truncated
 * filter is a different filter that still answers, which is worse than a
 * refusal the caller can see.
 */
export function asSavedView(value: unknown): SavedView | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>

  if (typeof row.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(row.id)) return null
  if (typeof row.name !== 'string') return null
  const name = row.name.replace(/\s+/g, ' ').trim()
  if (name === '' || name.length > MAX_VIEW_NAME_LENGTH) return null
  if (!Array.isArray(row.books) || !Array.isArray(row.kinds) || !Array.isArray(row.scopes)) {
    return null
  }
  if (!isState(row.state)) return null

  const books = row.books.filter(
    (slug): slug is string => typeof slug === 'string' && BOOK_SLUG_PATTERN.test(slug),
  )
  if (books.length !== row.books.length) return null

  /*
   * `chapters` is the one field added after this schema was accepted, so its
   * absence is the older shape and is read as "every chapter" rather than as
   * damage. A `chapters` that is *present* gets exactly the treatment every
   * other filter gets: an array or nothing, every entry a valid coordinate or
   * the whole view is refused, deduplicated, and capped by a refusal.
   */
  const rawChapters = row.chapters === undefined ? [] : row.chapters
  if (!Array.isArray(rawChapters)) return null
  const chapters = rawChapters.filter(
    (value): value is string => typeof value === 'string' && VIEW_CHAPTER_PATTERN.test(value),
  )
  if (chapters.length !== rawChapters.length) return null
  const kinds = row.kinds.filter(isKind)
  if (kinds.length !== row.kinds.length) return null
  const scopes = row.scopes.filter(isScope)
  if (scopes.length !== row.scopes.length) return null

  /*
   * Each filter is a **set**, and is stored as one.
   *
   * A filter naming the same book twice filters for exactly what it filters for
   * naming it once, so a repeat carries no meaning at all -- it is only bytes.
   * Every value here is already pattern- or enum-checked above, so ten thousand
   * of them were ten thousand valid entries and the document grew without any
   * cap noticing: the item and view counts were capped, the arrays inside a
   * view were not. Deduplicating first is what makes the cap below meaningful,
   * and what makes `kinds` and `scopes` bounded by their enums rather than by
   * how many times a caller repeated one.
   */
  const uniqueBooks = Array.from(new Set(books))
  if (uniqueBooks.length > MAX_VIEW_BOOKS) return null
  const uniqueChapters = Array.from(new Set(chapters))
  if (uniqueChapters.length > MAX_VIEW_CHAPTERS) return null

  return {
    id: row.id,
    name,
    books: uniqueBooks,
    chapters: uniqueChapters,
    kinds: Array.from(new Set(kinds)),
    scopes: Array.from(new Set(scopes)),
    state: row.state,
  }
}

/**
 * The bytes one document is stored as.
 *
 * Keys are emitted in a fixed order -- the document's own fields in declaration
 * order, item keys sorted, each item's three fields in declaration order -- so
 * that two documents holding the same facts serialize identically. That is what
 * lets a test assert "this write changed nothing" by comparing bytes.
 */
export function serializeAuthorMetadata(metadata: AuthorMetadata): string {
  const items: Record<string, AuthorItemMetadata> = {}
  for (const key of Object.keys(metadata.items).sort()) {
    const entry = metadata.items[key]
    items[key] = {
      resolved: entry.resolved,
      lastReadAt: entry.lastReadAt,
      lastExportedAt: entry.lastExportedAt,
    }
  }
  const ordered = {
    schema: metadata.schema,
    bookSlug: metadata.bookSlug,
    items,
    views: metadata.views.map((view) => ({
      id: view.id,
      name: view.name,
      books: [...view.books],
      chapters: [...view.chapters],
      kinds: [...view.kinds],
      scopes: [...view.scopes],
      state: view.state,
    })),
    updatedAt: metadata.updatedAt,
  }
  return `${JSON.stringify(ordered, null, 2)}\n`
}

/* ---------------------------------------------------------------- the reads */

/** What Mike has done with an item he has never touched. */
export const UNTOUCHED: AuthorItemMetadata = {
  resolved: false,
  lastReadAt: null,
  lastExportedAt: null,
}

export function itemMetadata(
  metadata: AuthorMetadata,
  itemId: string,
): AuthorItemMetadata {
  return metadata.items[itemId] ?? UNTOUCHED
}

/**
 * Is this item **New**?
 *
 * New when its source's `updatedAt` is later than the author's `lastReadAt`, or
 * when there is no `lastReadAt` at all. Deliberately not "not resolved":
 * `resolved` is a separate, reversible choice, and an item Mike resolved and a
 * reviewer then edited is both resolved and new again, which is the truth.
 *
 * Exporting is not in this decision anywhere. A packet is a copy, not a reading.
 */
export function isNewSince(entry: AuthorItemMetadata, sourceUpdatedAt: string): boolean {
  if (entry.lastReadAt === null) return true
  const read = Date.parse(entry.lastReadAt)
  const updated = Date.parse(sourceUpdatedAt)
  if (Number.isNaN(read) || Number.isNaN(updated)) return true
  return updated > read
}

/* --------------------------------------------------------------- the store */

export class AuthorMetadataStore {
  readonly objects: ReadingObjects

  constructor(objects: ReadingObjects) {
    this.objects = objects
  }

  get driver(): string {
    return this.objects.driver
  }

  /**
   * One book's document and the revision it was read at.
   *
   * A book with no document yet answers an empty document at version `null`,
   * which is the state a first conditional write names. That is not the same as
   * an unreadable store: absence is answered by the store, and a store that
   * would not answer **throws**, which the service above turns into `unreadable`
   * rather than into an empty document.
   */
  async read(authorId: string, bookSlug: string, now: string): Promise<VersionedAuthorMetadata> {
    const path = authorMetadataPath(authorId, bookSlug)
    const current = await this.objects.getVersioned(path)
    if (current.body === null) {
      return { metadata: emptyAuthorMetadata(bookSlug, now), version: null }
    }
    const parsed = asAuthorMetadata(parseJson(current.body), bookSlug)
    if (!parsed) {
      // Bytes are there and are not a document. Refused loudly: reading it as
      // empty would silently discard whatever triage it was meant to hold.
      throw new AuthorMetadataCorruptError(bookSlug)
    }
    return { metadata: parsed, version: current.version }
  }

  /**
   * Write one document, conditionally on the revision it was read at.
   *
   * `version === null` means "nothing must be there", which every driver
   * implements as create-if-absent, so two first writes cannot both land.
   * Resolves false when the precondition failed; nothing is written and nothing
   * is retried here.
   */
  async writeIfMatch(
    authorId: string,
    metadata: AuthorMetadata,
    version: string | null,
  ): Promise<boolean> {
    const path = authorMetadataPath(authorId, metadata.bookSlug)
    return this.objects.putIfMatch(path, serializeAuthorMetadata(metadata), version)
  }
}

/** Raised when a metadata object exists and is not a metadata document. */
export class AuthorMetadataCorruptError extends Error {
  readonly bookSlug: string

  constructor(bookSlug: string) {
    super('author metadata could not be read')
    this.name = 'AuthorMetadataCorruptError'
    this.bookSlug = bookSlug
  }
}

/* ----------------------------------------------------------------- factory */

let store: AuthorMetadataStore | null = null

/** The configured metadata store for this process. The notes store's driver. */
export function createAuthorMetadataStore(): AuthorMetadataStore {
  if (store) return store
  store = new AuthorMetadataStore(createReadingObjects())
  return store
}

/** Test seam. Resets the memoised store so a test can drive each driver. */
export function __resetAuthorMetadataStore(): void {
  store = null
}

/** Test seam. Builds a store over an arbitrary object layer. */
export function __authorMetadataStoreOver(objects: ReadingObjects): AuthorMetadataStore {
  return new AuthorMetadataStore(objects)
}

/**
 * Test seam. Makes an arbitrary object layer the **configured** store.
 *
 * The operations below are the surface P2-B will call, and they reach the store
 * through `createAuthorMetadataStore()` rather than taking one, because a
 * caller that could pass a store could pass somebody else's. That leaves a
 * failure a test cannot otherwise stage -- a store that answers a read by
 * throwing -- so this installs one, and `__resetAuthorMetadataStore` takes it
 * away again.
 */
export function __installAuthorMetadataStore(objects: ReadingObjects): void {
  store = new AuthorMetadataStore(objects)
}

/* -------------------------------------------------------------- operations */

/**
 * How many times a conditional metadata write is re-decided before giving up.
 *
 * A retry is justified here and is **not** justified for a note, and the
 * difference is what is being re-decided. A note edit is somebody's words
 * composed against a body they were looking at; applied again to a body that
 * has changed it would overwrite text its writer never saw. A metadata change
 * is an *intent* -- "mark this one read", "resolve this one", "stamp these as
 * exported" -- and re-applying that intent to a newer document gives the same
 * answer, exactly the reasoning `savePosition` records for a reading position.
 *
 * Bounded, and the bound is visible: three attempts, then an honest `conflict`.
 * There is no unbounded loop against a shared store anywhere in this file.
 */
export const METADATA_WRITE_ATTEMPTS = 3

function authorIdOf(viewer: Viewer): string | null {
  if (viewer.kind !== 'author') return null
  return viewerOwner(viewer).id
}

/**
 * Read one book's metadata, as the author.
 *
 * The **only** read in this module, and it writes nothing. A dashboard, an
 * inbox, a count or a list that calls this leaves every `lastReadAt` exactly as
 * it found it -- see `markItemOpened`, which is the sole writer of that field.
 */
export async function loadAuthorMetadata(
  viewer: Viewer,
  bookSlug: string,
  now: string = new Date().toISOString(),
): Promise<AuthorMetadataResult<VersionedAuthorMetadata>> {
  const authorId = authorIdOf(viewer)
  if (authorId === null) return fail('forbidden')
  if (!BOOK_SLUG_PATTERN.test(bookSlug)) return fail('invalid')

  try {
    return ok(await createAuthorMetadataStore().read(authorId, bookSlug, now))
  } catch (error) {
    if (error instanceof ReadingStorageUnavailableError) return fail('storage-unavailable')
    // Everything else -- a refused read, a dropped connection, bytes that are
    // not a document -- is `unreadable`. Never an empty document.
    return fail('unreadable')
  }
}

/**
 * Read, apply an intent, and write once -- up to `METADATA_WRITE_ATTEMPTS`.
 *
 * `change` receives the document as it currently stands and returns the
 * document that should replace it, or `null` to mean "nothing to do", which
 * writes nothing at all and reports the unchanged document. That is what keeps
 * a no-op read-only: marking an already-read item read again touches no bytes.
 */
async function mutate(
  viewer: Viewer,
  bookSlug: string,
  now: string,
  change: (current: AuthorMetadata) => AuthorMetadata | null,
): Promise<AuthorMetadataResult<AuthorMetadata>> {
  const authorId = authorIdOf(viewer)
  if (authorId === null) return fail('forbidden')
  if (!BOOK_SLUG_PATTERN.test(bookSlug)) return fail('invalid')

  const store = createAuthorMetadataStore()

  for (let attempt = 0; attempt < METADATA_WRITE_ATTEMPTS; attempt += 1) {
    let current: VersionedAuthorMetadata
    try {
      current = await store.read(authorId, bookSlug, now)
    } catch (error) {
      if (error instanceof ReadingStorageUnavailableError) return fail('storage-unavailable')
      return fail('unreadable')
    }

    const next = change(current.metadata)
    if (next === null) return ok(current.metadata)

    if (Object.keys(next.items).length > MAX_METADATA_ITEMS) return fail('invalid')
    if (next.views.length > MAX_SAVED_VIEWS) return fail('invalid')

    let written: boolean
    try {
      written = await store.writeIfMatch(authorId, next, current.version)
    } catch (error) {
      if (error instanceof ReadingStorageUnavailableError) return fail('storage-unavailable')
      throw error
    }
    if (written) return ok(next)
  }

  // Three reads and three refused writes. Something else is writing this
  // document continuously; saying `conflict` is the honest end of it.
  return fail('conflict')
}

/** The document with one item's entry replaced, and `updatedAt` moved. */
function withItem(
  metadata: AuthorMetadata,
  itemId: string,
  entry: AuthorItemMetadata,
  now: string,
): AuthorMetadata {
  return {
    ...metadata,
    items: { ...metadata.items, [itemId]: entry },
    updatedAt: now,
  }
}

/**
 * Mark one item read, because Mike explicitly opened it.
 *
 * This is the **only** function anywhere that writes `lastReadAt`. It is called
 * from an item's author detail or locator and from nowhere else -- not from a
 * dashboard's load, not from an inbox listing, not from a count, and not from
 * an export. A list that marked its contents read would silently empty the one
 * signal telling Mike what he has not looked at yet.
 */
export async function markItemOpened(
  viewer: Viewer,
  bookSlug: string,
  itemId: string,
  at: string = new Date().toISOString(),
): Promise<AuthorMetadataResult<AuthorMetadata>> {
  if (!ITEM_ID_PATTERN.test(itemId)) return fail('invalid')
  if (Number.isNaN(Date.parse(at))) return fail('invalid')

  return mutate(viewer, bookSlug, at, (current) => {
    const entry = itemMetadata(current, itemId)
    if (entry.lastReadAt === at) return null
    return withItem(current, itemId, { ...entry, lastReadAt: at }, at)
  })
}

/**
 * Set or clear one item's `resolved` state.
 *
 * Reversible in both directions and independent of everything else: resolving
 * an item does not mark it read, and reading one does not resolve it.
 */
export async function setItemResolved(
  viewer: Viewer,
  bookSlug: string,
  itemId: string,
  resolved: boolean,
  at: string = new Date().toISOString(),
): Promise<AuthorMetadataResult<AuthorMetadata>> {
  if (!ITEM_ID_PATTERN.test(itemId)) return fail('invalid')
  if (typeof resolved !== 'boolean') return fail('invalid')
  if (Number.isNaN(Date.parse(at))) return fail('invalid')

  return mutate(viewer, bookSlug, at, (current) => {
    const entry = itemMetadata(current, itemId)
    if (entry.resolved === resolved && current.items[itemId]) return null
    return withItem(current, itemId, { ...entry, resolved }, at)
  })
}

/**
 * Stamp `lastExportedAt` on every item a packet actually contained.
 *
 * **Per item, and after the fact.** The ordering is fixed and is stated in
 * `lib/author-export.ts`: the packet and both renderings are generated first,
 * and only a generation that produced all three reaches this call. A refusal or
 * a failure records nothing, because a stamp is a claim that a copy exists, and
 * a copy that was never produced does not exist.
 *
 * Nothing about `resolved` or `lastReadAt` moves here. Exporting is not reading
 * and is not triage.
 */
export async function recordItemsExported(
  viewer: Viewer,
  bookSlug: string,
  itemIds: readonly string[],
  at: string = new Date().toISOString(),
): Promise<AuthorMetadataResult<AuthorMetadata>> {
  if (Number.isNaN(Date.parse(at))) return fail('invalid')
  for (const itemId of itemIds) {
    if (!ITEM_ID_PATTERN.test(itemId)) return fail('invalid')
  }
  if (itemIds.length === 0) return mutate(viewer, bookSlug, at, () => null)

  return mutate(viewer, bookSlug, at, (current) => {
    const items = { ...current.items }
    for (const itemId of itemIds) {
      items[itemId] = { ...itemMetadata(current, itemId), lastExportedAt: at }
    }
    return { ...current, items, updatedAt: at }
  })
}

/**
 * Forget everything recorded about one item.
 *
 * Called when a shared note is withdrawn: after the withdrawal event is the only
 * author-visible remnant, the per-item triage that named it must stop existing
 * too, or the record of "Mike resolved this on Tuesday" would outlive the note
 * it was about and keep pointing at it.
 */
export async function forgetItem(
  viewer: Viewer,
  bookSlug: string,
  itemId: string,
  at: string = new Date().toISOString(),
): Promise<AuthorMetadataResult<AuthorMetadata>> {
  if (!ITEM_ID_PATTERN.test(itemId)) return fail('invalid')
  if (Number.isNaN(Date.parse(at))) return fail('invalid')

  return mutate(viewer, bookSlug, at, (current) => {
    if (!current.items[itemId]) return null
    const items = { ...current.items }
    delete items[itemId]
    return { ...current, items, updatedAt: at }
  })
}

/** Add or replace one saved view. Refused past `MAX_SAVED_VIEWS`. */
export async function putSavedView(
  viewer: Viewer,
  bookSlug: string,
  view: unknown,
  at: string = new Date().toISOString(),
): Promise<AuthorMetadataResult<AuthorMetadata>> {
  const clean = asSavedView(view)
  if (!clean) return fail('invalid')
  if (Number.isNaN(Date.parse(at))) return fail('invalid')

  return mutate(viewer, bookSlug, at, (current) => {
    const views = current.views.filter((existing) => existing.id !== clean.id)
    views.push(clean)
    return { ...current, views, updatedAt: at }
  })
}

/** Remove one saved view by id. */
export async function removeSavedView(
  viewer: Viewer,
  bookSlug: string,
  viewId: string,
  at: string = new Date().toISOString(),
): Promise<AuthorMetadataResult<AuthorMetadata>> {
  if (typeof viewId !== 'string' || viewId === '') return fail('invalid')
  if (Number.isNaN(Date.parse(at))) return fail('invalid')

  return mutate(viewer, bookSlug, at, (current) => {
    const views = current.views.filter((existing) => existing.id !== viewId)
    if (views.length === current.views.length) return null
    return { ...current, views, updatedAt: at }
  })
}
