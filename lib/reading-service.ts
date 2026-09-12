/**
 * Every operation on private reading material, in one place.
 *
 * The reviewer reader and the author reader are two different sessions, two
 * different cookies and two different route families -- but they are the same
 * operations. Writing them twice would mean two chances to forget a check, and
 * the check most easily forgotten is the one that matters.
 *
 * So each function here takes an already-established `Viewer` and re-derives
 * everything else from trusted sources:
 *
 *   **Identity** is the caller's. The route resolves it from a signed cookie
 *   before calling in; nothing in a request body can name an owner, and the
 *   owner written onto every record is `viewerOwner(viewer)`.
 *
 *   **Book authorization** is re-checked here, against the live roster entry the
 *   route just loaded, and then again against the manuscript: a book that is not
 *   loaded on this deployment cannot be read by anybody, including the author.
 *
 *   **The passage** is re-resolved from the verified manuscript. The chapter must
 *   be released; the paragraph must exist; the offsets must fit its text. The
 *   quotation stored on a record is *copied out of the manuscript at those
 *   offsets* and never taken from the request, so a record cannot quote text the
 *   book does not contain.
 *
 *   **Ownership** is enforced by construction. A record is only ever read,
 *   replaced or deleted beneath the caller's own storage prefix, so a guessed or
 *   stolen identifier reaches nothing: the path that would name somebody else's
 *   record is never built.
 *
 *   **Visibility** is `lib/reading-access.ts`, applied again at the moment of
 *   answering, including for a private link.
 *
 * Every outcome is one of a small set of named results, so a route handler maps
 * a result to a status code and never decides policy of its own.
 */

import {
  findBook,
  findParagraph,
  findReleasedChapter,
  listBookSlugs,
  releasedChapters,
  type ReaderBook,
  type ReaderChapter,
  type ProseParagraph,
} from './manuscript.ts'
import {
  canMutateAnnotation,
  canViewAnnotation,
  viewerMayReadBook,
  viewerOwner,
  type AnnotationVisibility,
  type Viewer,
} from './reading-access.ts'
import {
  MAX_EXCERPT_LENGTH,
  excerptFrom,
  normalizeOffsets,
  resolveAnchor,
  type AnchorState,
} from './reading-anchor.ts'
import {
  ReadingStorageUnavailableError,
  createReadingStore,
  normalizeNote,
  type Annotation,
  type Bookmark,
  type ReadingPosition,
} from './reviewer-reading.ts'

if (typeof window !== 'undefined') {
  throw new Error(
    'lib/reading-service is server-only and must not be imported by a client component',
  )
}

/* ----------------------------------------------------------------- results */

/**
 * Why an operation could not be performed.
 *
 * `not-found` deliberately covers both "there is no such thing" and "that is
 * not yours". A reviewer must not be able to tell the difference, or the
 * identifiers become a way to enumerate other people's notes.
 */
export type ReadingFailure =
  | 'not-found'
  | 'invalid'
  | 'storage-unavailable'

export type ReadingResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: ReadingFailure }

function fail<T>(reason: ReadingFailure): ReadingResult<T> {
  return { ok: false, reason }
}

function ok<T>(value: T): ReadingResult<T> {
  return { ok: true, value }
}

/* ------------------------------------------------------------- resolved views */

/** A bookmark with its anchor re-checked against the manuscript as it is now. */
export type ResolvedBookmark = Bookmark & {
  anchorState: AnchorState
  chapterExists: boolean
}

/** An annotation with its anchor re-checked, and what this viewer may do with it. */
export type ResolvedAnnotation = Annotation & {
  anchorState: AnchorState
  chapterExists: boolean
  /** True when this viewer created it. Only its creator may change it. */
  own: boolean
  /**
   * The private link's path, when there is one and this viewer created it.
   * Never disclosed to anybody else -- a link is its owner's to hand out.
   */
  sharePath: string | null
}

export type BookReading = {
  book: ReaderBook
  position: ReadingPosition | null
  bookmarks: ResolvedBookmark[]
  annotations: ResolvedAnnotation[]
}

/* ---------------------------------------------------------------- helpers */

/**
 * The book, but only when this viewer may read it and it is actually loaded.
 *
 * Two refusals, and the second does not depend on the first having happened.
 *
 *   **Entitlement.** `viewerMayReadBook` against the live roster entry the
 *   route just loaded.
 *
 *   **Audience.** The manifest's own answer to who this manuscript is loaded
 *   for. PERSISTENT is `author-only` -- Mike has not made his line-by-line pass
 *   -- so a reviewer is refused here even if their entitlements somehow named
 *   it: a hand-edited roster, a restored backup, a token minted when the book
 *   was open. `lib/reviewer-authorization.ts` already removes an author-only
 *   slug from a reviewer's entitlements; this is the check that does not trust
 *   it to have.
 *
 * Both answer `null`, which every caller turns into the same `not-found` a
 * missing book gets -- so a reviewer cannot tell an author-only manuscript from
 * one that does not exist.
 */
function openBook(viewer: Viewer, bookSlug: string): ReaderBook | null {
  if (!viewerMayReadBook(viewer, bookSlug)) return null

  // A book the site has not loaded cannot be read by anyone, author included.
  const book = findBook(bookSlug)
  if (!book) return null

  if (book.audience !== 'reviewers' && viewer.kind !== 'author') return null

  return book
}

/**
 * The paragraph's current text, or null when the chapter or paragraph is gone.
 * This is what an anchor is re-checked against.
 */
function currentParagraphText(
  book: ReaderBook,
  chapterSlug: string,
  paragraphId: string,
): string | null {
  const chapter = findReleasedChapter(book, chapterSlug)
  if (!chapter) return null
  return findParagraph(chapter, paragraphId)?.text ?? null
}

function resolveBookmark(book: ReaderBook, bookmark: Bookmark): ResolvedBookmark {
  const text = currentParagraphText(book, bookmark.chapterSlug, bookmark.paragraphId)
  return {
    ...bookmark,
    chapterExists: findReleasedChapter(book, bookmark.chapterSlug) !== null,
    // A bookmark points at a whole paragraph, so it is still valid as long as
    // that paragraph is there; its excerpt is a convenience, not its identity.
    anchorState: text === null ? 'needs-relocation' : 'ok',
  }
}

function resolveAnnotation(
  viewer: Viewer,
  book: ReaderBook,
  annotation: Annotation,
): ResolvedAnnotation {
  const text = currentParagraphText(book, annotation.chapterSlug, annotation.paragraphId)
  const own = canMutateAnnotation(viewer, annotation)
  return {
    ...annotation,
    chapterExists: findReleasedChapter(book, annotation.chapterSlug) !== null,
    anchorState: resolveAnchor(annotation, text),
    own,
    sharePath:
      own && annotation.shareToken && annotation.visibility === 'link'
        ? `/review/shared/${annotation.shareToken}`
        : null,
  }
}

/* ------------------------------------------------------------------ reading */

/**
 * Everything this viewer has in one book: where they are, what they bookmarked,
 * what they annotated.
 *
 * Only the viewer's own material. Annotations shared with the author are
 * gathered separately (`lib/author-inbox.ts`) so that this function has exactly
 * one storage prefix to read and no way to widen.
 */
export async function loadBookReading(
  viewer: Viewer,
  bookSlug: string,
): Promise<ReadingResult<BookReading>> {
  const book = openBook(viewer, bookSlug)
  if (!book) return fail('not-found')

  const owner = viewerOwner(viewer)
  const store = createReadingStore()

  const [position, bookmarks, annotations] = await Promise.all([
    store.readPosition(owner, bookSlug),
    store.listBookmarks(owner, bookSlug),
    store.listAnnotations(owner, bookSlug),
  ])

  return ok({
    book,
    position,
    bookmarks: bookmarks.map((bookmark) => resolveBookmark(book, bookmark)),
    annotations: annotations.map((annotation) =>
      resolveAnnotation(viewer, book, annotation),
    ),
  })
}

/* ----------------------------------------------------------------- position */

export type PositionInput = {
  bookSlug: unknown
  chapterSlug: unknown
  paragraphId: unknown
}

/**
 * Record where this viewer is in one book.
 *
 * This is the **automatic** position, and it is exactly one per person per
 * book. It is not a bookmark and must never be confused with one: nobody asked
 * for it, it has no excerpt to show in a list, it is overwritten continuously,
 * and removing it is meaningless. A bookmark is a deliberate act with a
 * deliberate removal; this is the book remembering itself.
 */
export async function savePosition(
  viewer: Viewer,
  input: PositionInput,
): Promise<ReadingResult<ReadingPosition>> {
  const bookSlug = typeof input.bookSlug === 'string' ? input.bookSlug : ''
  const book = openBook(viewer, bookSlug)
  if (!book) return fail('not-found')

  const chapterSlug = typeof input.chapterSlug === 'string' ? input.chapterSlug : ''
  const chapter = findReleasedChapter(book, chapterSlug)
  if (!chapter) return fail('not-found')

  let paragraphId: string | null = null
  let paragraphOrdinal: number | null = null

  if (typeof input.paragraphId === 'string' && input.paragraphId !== '') {
    const paragraph = findParagraph(chapter, input.paragraphId)
    // A position naming a paragraph that is not in this chapter is not stored
    // as a position with no paragraph -- it is refused, because it is a claim
    // about somewhere that does not exist.
    if (!paragraph) return fail('invalid')
    paragraphId = paragraph.id
    paragraphOrdinal = paragraph.ordinal
  }

  const owner = viewerOwner(viewer)
  const position: ReadingPosition = {
    schema: 1,
    ownerKind: owner.kind,
    ownerId: owner.id,
    bookSlug: book.slug,
    bookTitle: book.title,
    chapterSlug: chapter.slug,
    chapterNumber: chapter.number,
    chapterLabel: chapter.label,
    paragraphId,
    paragraphOrdinal,
    updatedAt: new Date().toISOString(),
  }

  try {
    await createReadingStore().writePosition(position)
  } catch (error) {
    if (error instanceof ReadingStorageUnavailableError) return fail('storage-unavailable')
    throw error
  }

  return ok(position)
}

/**
 * The viewer's position in each of several books, for a workspace listing.
 * Books they may not read are simply not asked about.
 */
export async function loadPositions(
  viewer: Viewer,
  bookSlugs: readonly string[],
): Promise<ReadingPosition[]> {
  const owner = viewerOwner(viewer)
  const store = createReadingStore()
  const found: ReadingPosition[] = []

  for (const bookSlug of bookSlugs) {
    if (!openBook(viewer, bookSlug)) continue
    const position = await store.readPosition(owner, bookSlug)
    if (position) found.push(position)
  }

  return found
}

/* ---------------------------------------------------------------- bookmarks */

export type BookmarkInput = {
  bookSlug: unknown
  chapterSlug: unknown
  paragraphId: unknown
}

/**
 * Save one bookmark.
 *
 * A bookmark needs no comment, which is the point of it being a separate thing
 * from feedback: it is "come back here", not "here is what I think". There may
 * be as many as the reviewer wants in a book -- the store holds one object per
 * bookmark, so they do not overwrite each other and none is ever the bookmark.
 *
 * Placing a second bookmark on a paragraph that already has one is refused as a
 * duplicate rather than written twice, because two identical entries in a list
 * are a defect, not a feature.
 */
export async function addBookmark(
  viewer: Viewer,
  input: BookmarkInput,
): Promise<ReadingResult<ResolvedBookmark>> {
  const resolved = resolvePassage(viewer, input.bookSlug, input.chapterSlug, input.paragraphId)
  if (!resolved.ok) return fail(resolved.reason)

  const { book, chapter, paragraph } = resolved.value
  const owner = viewerOwner(viewer)
  const store = createReadingStore()

  const existing = await store.listBookmarks(owner, book.slug)
  const duplicate = existing.find(
    (bookmark) =>
      bookmark.chapterSlug === chapter.slug && bookmark.paragraphId === paragraph.id,
  )
  if (duplicate) return ok(resolveBookmark(book, duplicate))

  try {
    const bookmark = await store.addBookmark({
      ownerKind: owner.kind,
      ownerId: owner.id,
      bookSlug: book.slug,
      chapterSlug: chapter.slug,
      chapterNumber: chapter.number,
      chapterLabel: chapter.label,
      paragraphId: paragraph.id,
      paragraphOrdinal: paragraph.ordinal,
      // Copied from the manuscript, never from the request.
      excerpt: excerptFrom(paragraph.text, MAX_EXCERPT_LENGTH),
      manuscriptSha256: chapter.sha256,
    })
    // Returned in the same resolved shape a listing uses, so the browser never
    // has to work out for itself whether a record it just made is anchored --
    // and never renders one whose anchor state it does not know.
    return ok(resolveBookmark(book, bookmark))
  } catch (error) {
    if (error instanceof ReadingStorageUnavailableError) return fail('storage-unavailable')
    throw error
  }
}

export async function removeBookmark(
  viewer: Viewer,
  bookSlug: unknown,
  id: unknown,
): Promise<ReadingResult<true>> {
  const slug = typeof bookSlug === 'string' ? bookSlug : ''
  if (!openBook(viewer, slug)) return fail('not-found')
  if (typeof id !== 'string' || id === '') return fail('not-found')

  try {
    // Searched beneath this viewer's own prefix only. Another reviewer's
    // bookmark id therefore finds nothing, and is answered as "not found"
    // rather than as "forbidden".
    const removed = await createReadingStore().removeBookmark(viewerOwner(viewer), slug, id)
    return removed ? ok(true as const) : fail('not-found')
  } catch (error) {
    if (error instanceof ReadingStorageUnavailableError) return fail('storage-unavailable')
    // An invalid id shape throws from the path builder; that is a "not found"
    // to the caller, never a 500 and never a hint that the shape was wrong.
    return fail('not-found')
  }
}

/* -------------------------------------------------------------- annotations */

export type AnnotationInput = {
  bookSlug: unknown
  chapterSlug: unknown
  paragraphId: unknown
  startOffset: unknown
  endOffset: unknown
  note: unknown
  visibility: unknown
}

/**
 * Save one passage annotation: a highlight, with or without a note.
 *
 * The anchor is built here and never trusted from the browser. The paragraph is
 * looked up in the verified manuscript, the offsets are checked to fit its
 * actual text, and the quotation is the manuscript's own characters at those
 * offsets. The chapter's `sha256` is recorded as the version the offsets were
 * measured in.
 */
export async function addAnnotation(
  viewer: Viewer,
  input: AnnotationInput,
): Promise<ReadingResult<ResolvedAnnotation>> {
  const resolved = resolvePassage(viewer, input.bookSlug, input.chapterSlug, input.paragraphId)
  if (!resolved.ok) return fail(resolved.reason)

  const { book, chapter, paragraph } = resolved.value

  const offsets = normalizeOffsets(input.startOffset, input.endOffset, paragraph.text.length)
  if (!offsets) return fail('invalid')

  const note = normalizeNote(input.note)
  if (note === undefined) return fail('invalid')

  const visibility: AnnotationVisibility =
    input.visibility === 'author' || input.visibility === 'link'
      ? input.visibility
      : 'private'

  const owner = viewerOwner(viewer)

  try {
    const annotation = await createReadingStore().addAnnotation({
      ownerKind: owner.kind,
      ownerId: owner.id,
      bookSlug: book.slug,
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
      note,
      visibility,
    })
    return ok(resolveAnnotation(viewer, book, annotation))
  } catch (error) {
    if (error instanceof ReadingStorageUnavailableError) return fail('storage-unavailable')
    throw error
  }
}

export async function updateAnnotation(
  viewer: Viewer,
  bookSlug: unknown,
  id: unknown,
  changes: { note?: unknown; visibility?: unknown },
): Promise<ReadingResult<ResolvedAnnotation>> {
  const slug = typeof bookSlug === 'string' ? bookSlug : ''
  const book = openBook(viewer, slug)
  if (!book) return fail('not-found')
  if (typeof id !== 'string' || id === '') return fail('not-found')

  const patch: { note?: string | null; visibility?: AnnotationVisibility } = {}

  if (changes.note !== undefined) {
    const note = normalizeNote(changes.note)
    if (note === undefined) return fail('invalid')
    patch.note = note
  }

  if (changes.visibility !== undefined) {
    if (
      changes.visibility !== 'private' &&
      changes.visibility !== 'author' &&
      changes.visibility !== 'link'
    ) {
      return fail('invalid')
    }
    patch.visibility = changes.visibility
  }

  const store = createReadingStore()
  const owner = viewerOwner(viewer)

  let existing: Annotation | null
  try {
    existing = await store.getAnnotation(owner, slug, id)
  } catch {
    return fail('not-found')
  }
  if (!existing) return fail('not-found')

  // Belt and braces: the record was read from this viewer's own prefix, and it
  // is put past the ownership rule anyway before anything is written.
  if (!canMutateAnnotation(viewer, existing)) return fail('not-found')

  try {
    const updated = await store.updateAnnotation(owner, slug, id, patch)
    return updated ? ok(resolveAnnotation(viewer, book, updated)) : fail('not-found')
  } catch (error) {
    if (error instanceof ReadingStorageUnavailableError) return fail('storage-unavailable')
    throw error
  }
}

export async function removeAnnotation(
  viewer: Viewer,
  bookSlug: unknown,
  id: unknown,
): Promise<ReadingResult<true>> {
  const slug = typeof bookSlug === 'string' ? bookSlug : ''
  if (!openBook(viewer, slug)) return fail('not-found')
  if (typeof id !== 'string' || id === '') return fail('not-found')

  const store = createReadingStore()
  const owner = viewerOwner(viewer)

  let existing: Annotation | null
  try {
    existing = await store.getAnnotation(owner, slug, id)
  } catch {
    return fail('not-found')
  }
  if (!existing || !canMutateAnnotation(viewer, existing)) return fail('not-found')

  try {
    const removed = await store.removeAnnotation(owner, slug, id)
    return removed ? ok(true as const) : fail('not-found')
  } catch (error) {
    if (error instanceof ReadingStorageUnavailableError) return fail('storage-unavailable')
    throw error
  }
}

/* ------------------------------------------------------------ private links */

export type SharedAnnotation = {
  annotation: ResolvedAnnotation
  book: ReaderBook
  chapter: ReaderChapter | null
}

/**
 * Open an annotation from its private link.
 *
 * The token is a **locator**. It says which record is meant; it says nothing
 * about who may see it. Three independent things must all hold before anything
 * is returned:
 *
 *   1. the caller has a real session -- the route established `viewer` from a
 *      signed cookie before calling in, and there is no anonymous `Viewer`;
 *   2. the caller is entitled to that book right now, from the live roster;
 *   3. the annotation is actually shared by link, and `canViewAnnotation` says
 *      so for this viewer.
 *
 * Every failure is the same `not-found`, so a token cannot be used to learn
 * whether an annotation exists, which book it is in, or who wrote it.
 */
export async function openSharedAnnotation(
  viewer: Viewer,
  token: unknown,
): Promise<ReadingResult<SharedAnnotation>> {
  if (typeof token !== 'string' || token === '') return fail('not-found')

  const store = createReadingStore()
  const ref = await store.resolveShareToken(token)
  if (!ref) return fail('not-found')

  // Entitlement before content: the book is opened as this viewer, so an
  // unentitled reviewer stops here and the annotation is never read.
  const book = openBook(viewer, ref.bookSlug)
  if (!book) return fail('not-found')

  const annotation = await store.getAnnotation(
    { kind: ref.ownerKind, id: ref.ownerId },
    ref.bookSlug,
    ref.annotationId,
  )
  if (!annotation) return fail('not-found')

  // The token matched, so `viaLinkToken` is true -- which makes the `link`
  // state reachable and nothing else. A `private` annotation is still refused,
  // and so is one shared only with the author when the caller is a reviewer.
  if (!canViewAnnotation(viewer, annotation, { viaLinkToken: true })) return fail('not-found')

  return ok({
    annotation: resolveAnnotation(viewer, book, annotation),
    book,
    chapter: findReleasedChapter(book, annotation.chapterSlug),
  })
}

/* ------------------------------------------------------------------ passage */

type Passage = { book: ReaderBook; chapter: ReaderChapter; paragraph: ProseParagraph }

/**
 * Resolve (book, chapter, paragraph) from a request, or say why not.
 *
 * Draft chapters resolve to null, so an unreleased chapter cannot be bookmarked
 * or annotated even by an entitled reviewer who guesses its slug.
 */
function resolvePassage(
  viewer: Viewer,
  bookSlug: unknown,
  chapterSlug: unknown,
  paragraphId: unknown,
): ReadingResult<Passage> {
  const book = openBook(viewer, typeof bookSlug === 'string' ? bookSlug : '')
  if (!book) return fail('not-found')

  const chapter = findReleasedChapter(book, typeof chapterSlug === 'string' ? chapterSlug : '')
  if (!chapter) return fail('not-found')

  const paragraph = findParagraph(chapter, typeof paragraphId === 'string' ? paragraphId : '')
  if (!paragraph) return fail('invalid')

  return ok({ book, chapter, paragraph })
}

/**
 * Every book slug the site has actually loaded a readable manuscript for.
 *
 * A directory with no released chapter is not a readable book. This list is
 * **the author's** library -- it is what `/admin/read` is built from -- so it
 * deliberately includes author-only manuscripts such as PERSISTENT. It is not
 * used to build anything a reviewer sees: a reviewer's library comes from their
 * own entitlements, and the entitlement controls come from
 * `reviewerReadableBookSlugs()`, which excludes them.
 */
export function loadedBookSlugs(): string[] {
  const slugs: string[] = []
  for (const slug of listBookSlugs()) {
    const book = findBook(slug)
    if (book && releasedChapters(book).length > 0) slugs.push(slug)
  }
  return slugs
}
