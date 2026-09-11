/**
 * Who may see, and who may change, a piece of private reading material.
 *
 * Every rule that decides visibility lives here, as pure functions over plain
 * values. Nothing in this file reads a cookie, touches a store, or knows what a
 * request is. That is the point: the rules can be exercised exhaustively under
 * `node --test`, and every route handler and every server render calls the same
 * function rather than re-deriving the rule in its own words.
 *
 * These functions are *not* the only enforcement. Each caller independently
 * establishes who the viewer is from a signed cookie, re-checks book
 * entitlement against the live roster, and scopes its storage reads to the
 * owner's own prefix, so a record belonging to somebody else is never fetched
 * in the first place. What lives here is the final, explicit answer to "may
 * this viewer see this record?", asked again after all of that.
 *
 * ## The three sharing states
 *
 *   `private`  Only the person who wrote it. Nobody else, including Mike.
 *   `author`   The creator and Mike.
 *   `link`     The creator, Mike, and anyone who both holds the private link
 *              *and* is independently entitled to that book.
 *
 * A private link is a **locator, not an authorization**. Holding the token is
 * never sufficient: `canViewAnnotation` still requires a real author session or
 * a reviewer the roster currently entitles to that exact book. A token that
 * leaks discloses nothing to a stranger, and nothing to a revoked reviewer,
 * because neither can satisfy the second half of the test.
 *
 * ## What is deliberately not built here
 *
 * There is no book club, no membership, no notification, no moderation queue
 * and no public discussion. There is also no per-person share target: sharing
 * is to Mike or by link, and a reviewer's workspace therefore lists their own
 * material and nothing of anyone else's. A later discussion layer can reference
 * an annotation by its stable id and re-use this same function unchanged --
 * adding a state to `AnnotationVisibility` and a branch below, not redesigning
 * the anchors.
 */

/** Whose material it is: a reviewer's, or Mike's own. */
export type OwnerKind = 'reviewer' | 'author'

/**
 * A record's owner.
 *
 * The author's id is a keyed, non-reversible derivation of the administrator's
 * address rather than the address itself (see `lib/reading-owner.ts`), so it is
 * safe in a storage pathname and discloses nothing.
 */
export type OwnerRef = { kind: OwnerKind; id: string }

export type AnnotationVisibility = 'private' | 'author' | 'link'

/** Everything the rules need to know about who is asking. */
export type Viewer =
  | { kind: 'reviewer'; id: string; books: readonly string[] }
  | { kind: 'author'; id: string }

/** The minimum an annotation must state for these rules to decide about it. */
export type ShareableRecord = {
  ownerKind: OwnerKind
  ownerId: string
  bookSlug: string
  visibility: AnnotationVisibility
}

/** The minimum a bookmark or a position must state. Both are always private. */
export type OwnedRecord = {
  ownerKind: OwnerKind
  ownerId: string
  bookSlug: string
}

export function isAnnotationVisibility(value: unknown): value is AnnotationVisibility {
  return value === 'private' || value === 'author' || value === 'link'
}

/** The owner a viewer writes as. Their own material, and only their own. */
export function viewerOwner(viewer: Viewer): OwnerRef {
  return { kind: viewer.kind, id: viewer.id }
}

export function sameOwner(a: OwnerRef, b: OwnerRef): boolean {
  return a.kind === b.kind && a.id === b.id
}

/**
 * Whether this viewer may open this book at all.
 *
 * Mike may read every manuscript the site has actually loaded -- which is
 * checked by the caller against the manuscript module, because a book that is
 * not loaded cannot be read by anybody. A reviewer may read exactly the books
 * their live roster entry names, so a revoked or re-scoped reviewer loses
 * access the moment the roster says so.
 */
export function viewerMayReadBook(viewer: Viewer, bookSlug: string): boolean {
  if (bookSlug === '') return false
  if (viewer.kind === 'author') return true
  return viewer.books.includes(bookSlug)
}

/** True when this viewer is the person who created the record. */
export function ownsRecord(viewer: Viewer, record: OwnedRecord): boolean {
  return sameOwner(viewerOwner(viewer), { kind: record.ownerKind, id: record.ownerId })
}

/**
 * May this viewer see this annotation?
 *
 * `viaLinkToken` says that the caller arrived holding the annotation's private
 * link and that the token matched. It widens nothing on its own: it only makes
 * the `link` state reachable, and only for a viewer who is separately entitled
 * to the book.
 */
export function canViewAnnotation(
  viewer: Viewer,
  annotation: ShareableRecord,
  options: { viaLinkToken?: boolean } = {},
): boolean {
  // Entitlement to the book comes first and is never bypassed -- not by
  // ownership, not by a token, not by being the author. A reviewer whose
  // entitlement to a book was withdrawn stops seeing even their own notes on
  // it, which is the correct meaning of withdrawing access to a manuscript.
  if (!viewerMayReadBook(viewer, annotation.bookSlug)) return false

  if (ownsRecord(viewer, annotation)) return true

  if (viewer.kind === 'author') {
    // Mike sees what was shared with him, and what was put on a link. He does
    // not see a reviewer's explicitly private annotations -- that is the whole
    // meaning of the word on the control the reviewer chose.
    return annotation.visibility === 'author' || annotation.visibility === 'link'
  }

  // Another reviewer, never by listing: only by holding the link, and only when
  // the annotation is actually on a link.
  return options.viaLinkToken === true && annotation.visibility === 'link'
}

/**
 * May this viewer change or delete this annotation?
 *
 * Only its creator, always. Mike can read what a reviewer shared with him; he
 * cannot edit it, retract it, or re-share it. A reviewer's recorded opinion is
 * theirs.
 */
export function canMutateAnnotation(viewer: Viewer, annotation: ShareableRecord): boolean {
  return viewerMayReadBook(viewer, annotation.bookSlug) && ownsRecord(viewer, annotation)
}

/**
 * May this viewer read or remove this bookmark, or this reading position?
 *
 * Bookmarks and positions are never shared. There is no visibility control on
 * them because there is no state in which anyone else may see one.
 */
export function canAccessOwnedRecord(viewer: Viewer, record: OwnedRecord): boolean {
  return viewerMayReadBook(viewer, record.bookSlug) && ownsRecord(viewer, record)
}

/**
 * The annotations a viewer's workspace lists.
 *
 * Their own, plus -- for Mike -- what reviewers explicitly shared with the
 * author. Link-shared annotations are deliberately *not* listed for anyone but
 * their creator and Mike: a link is something its creator hands to a particular
 * person, not a publication, and a reviewer who was never given the link has no
 * business finding it in a list.
 */
export function listableAnnotations<T extends ShareableRecord>(
  viewer: Viewer,
  annotations: readonly T[],
): T[] {
  return annotations.filter((annotation) => canViewAnnotation(viewer, annotation))
}
