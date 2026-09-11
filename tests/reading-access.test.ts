import test from 'node:test'
import assert from 'node:assert/strict'

import {
  canAccessOwnedRecord,
  canMutateAnnotation,
  canViewAnnotation,
  isAnnotationVisibility,
  listableAnnotations,
  ownsRecord,
  sameOwner,
  viewerMayReadBook,
  viewerOwner,
  type AnnotationVisibility,
  type ShareableRecord,
  type Viewer,
} from '../lib/reading-access.ts'

/*
 * The visibility rules, exhaustively.
 *
 * Every combination of (who is asking) x (whose it is) x (how it was shared) x
 * (did they present the link) is decided here, so that no route handler has to
 * reason about it and none of them can disagree.
 */

const BOOK = 'the-backward-becoming'
const OTHER_BOOK = 'something-else'

const anna: Viewer = { kind: 'reviewer', id: 'anna', books: [BOOK] }
const ben: Viewer = { kind: 'reviewer', id: 'ben', books: [BOOK] }
const carla: Viewer = { kind: 'reviewer', id: 'carla', books: [OTHER_BOOK] }
const mike: Viewer = { kind: 'author', id: 'aa11bb22cc33' }

function annotation(
  overrides: Partial<ShareableRecord> = {},
): ShareableRecord {
  return {
    ownerKind: 'reviewer',
    ownerId: 'anna',
    bookSlug: BOOK,
    visibility: 'private',
    ...overrides,
  }
}

const VISIBILITIES: AnnotationVisibility[] = ['private', 'author', 'link']

/* -------------------------------------------------------------- primitives */

test('a visibility is one of exactly three values', () => {
  for (const value of VISIBILITIES) assert.ok(isAnnotationVisibility(value))
  for (const value of ['public', 'shared', '', null, undefined, 1, {}]) {
    assert.equal(isAnnotationVisibility(value), false, String(value))
  }
})

test('owners are compared on kind as well as id', () => {
  assert.ok(sameOwner({ kind: 'reviewer', id: 'x' }, { kind: 'reviewer', id: 'x' }))
  // The author namespace is separate by construction: the same id string in the
  // other namespace is a different owner.
  assert.equal(sameOwner({ kind: 'reviewer', id: 'x' }, { kind: 'author', id: 'x' }), false)
})

test('a viewer writes only as itself', () => {
  assert.deepEqual(viewerOwner(anna), { kind: 'reviewer', id: 'anna' })
  assert.deepEqual(viewerOwner(mike), { kind: 'author', id: 'aa11bb22cc33' })
})

/* ------------------------------------------------------------ entitlement */

test('a reviewer may read exactly the books their roster entry names', () => {
  assert.ok(viewerMayReadBook(anna, BOOK))
  assert.equal(viewerMayReadBook(anna, OTHER_BOOK), false)
  assert.equal(viewerMayReadBook(anna, ''), false)
})

test('the author may read any named book -- the manuscript decides the rest', () => {
  assert.ok(viewerMayReadBook(mike, BOOK))
  assert.ok(viewerMayReadBook(mike, OTHER_BOOK))
  assert.equal(viewerMayReadBook(mike, ''), false)
})

/* ------------------------------------------------------- own private things */

test('a bookmark or a position is reachable only by its own owner', () => {
  const record = { ownerKind: 'reviewer' as const, ownerId: 'anna', bookSlug: BOOK }
  assert.ok(canAccessOwnedRecord(anna, record))
  assert.equal(canAccessOwnedRecord(ben, record), false)
  // Not even the author. Bookmarks and positions are never shared with anyone.
  assert.equal(canAccessOwnedRecord(mike, record), false)
})

test('ownership is not entitlement -- losing the book loses your own records too', () => {
  const record = { ownerKind: 'reviewer' as const, ownerId: 'anna', bookSlug: BOOK }
  const revokedFromBook: Viewer = { kind: 'reviewer', id: 'anna', books: [] }
  assert.ok(ownsRecord(revokedFromBook, record))
  assert.equal(canAccessOwnedRecord(revokedFromBook, record), false)
})

/* ---------------------------------------------------- annotation visibility */

test('a creator always sees their own annotation, however it is shared', () => {
  for (const visibility of VISIBILITIES) {
    assert.ok(canViewAnnotation(anna, annotation({ visibility })), visibility)
  }
})

test('Mike sees what was shared with the author, and what is on a link', () => {
  assert.ok(canViewAnnotation(mike, annotation({ visibility: 'author' })))
  assert.ok(canViewAnnotation(mike, annotation({ visibility: 'link' })))
})

test('Mike never sees a reviewer’s explicitly private annotation', () => {
  assert.equal(canViewAnnotation(mike, annotation({ visibility: 'private' })), false)
  // Not even holding the link, which is not a thing a private annotation has.
  assert.equal(
    canViewAnnotation(mike, annotation({ visibility: 'private' }), { viaLinkToken: true }),
    false,
  )
})

test('another reviewer sees nothing by listing, whatever the sharing state', () => {
  for (const visibility of VISIBILITIES) {
    assert.equal(canViewAnnotation(ben, annotation({ visibility })), false, visibility)
  }
})

test('a private link opens a link-shared annotation for an entitled reviewer', () => {
  assert.ok(
    canViewAnnotation(ben, annotation({ visibility: 'link' }), { viaLinkToken: true }),
  )
})

test('a private link is a locator, not an authorization', () => {
  // Holding the token is never enough on its own.
  assert.equal(
    canViewAnnotation(ben, annotation({ visibility: 'private' }), { viaLinkToken: true }),
    false,
    'a private annotation stays private even if its link is somehow presented',
  )
  assert.equal(
    canViewAnnotation(ben, annotation({ visibility: 'author' }), { viaLinkToken: true }),
    false,
    'shared with Mike is not shared with every link holder',
  )
  assert.equal(
    canViewAnnotation(carla, annotation({ visibility: 'link' }), { viaLinkToken: true }),
    false,
    'a reviewer not entitled to the book is refused even with the token',
  )
  const revoked: Viewer = { kind: 'reviewer', id: 'ben', books: [] }
  assert.equal(
    canViewAnnotation(revoked, annotation({ visibility: 'link' }), { viaLinkToken: true }),
    false,
    'a reviewer whose entitlement was withdrawn is refused even with the token',
  )
})

test('entitlement is checked before ownership, so a withdrawn book hides even your own notes', () => {
  const withdrawn: Viewer = { kind: 'reviewer', id: 'anna', books: [] }
  for (const visibility of VISIBILITIES) {
    assert.equal(canViewAnnotation(withdrawn, annotation({ visibility })), false, visibility)
  }
})

/* ------------------------------------------------------------- mutation */

test('only the creator may change or delete an annotation', () => {
  const shared = annotation({ visibility: 'author' })
  assert.ok(canMutateAnnotation(anna, shared))
  assert.equal(canMutateAnnotation(ben, shared), false)
  // Mike can read what was shared with him. He cannot edit or retract it.
  assert.equal(canMutateAnnotation(mike, shared), false)
})

test('the author owns the author’s own annotations, and reviewers cannot touch them', () => {
  const mine = annotation({ ownerKind: 'author', ownerId: mike.id, visibility: 'private' })
  assert.ok(canMutateAnnotation(mike, mine))
  assert.equal(canViewAnnotation(anna, mine), false)
  assert.equal(canViewAnnotation(anna, mine, { viaLinkToken: true }), false)
  assert.equal(canMutateAnnotation(anna, mine), false)
})

/* -------------------------------------------------------------- listings */

test('a workspace listing shows a reviewer their own material and nothing else', () => {
  const rows = [
    annotation({ visibility: 'private' }),
    annotation({ visibility: 'author' }),
    annotation({ visibility: 'link' }),
    annotation({ ownerId: 'ben', visibility: 'link' }),
    annotation({ ownerId: 'ben', visibility: 'author' }),
    annotation({ ownerKind: 'author', ownerId: mike.id, visibility: 'author' }),
  ]

  assert.equal(listableAnnotations(anna, rows).length, 3)
  assert.ok(listableAnnotations(anna, rows).every((row) => row.ownerId === 'anna'))
})

test('the author’s listing shows what reviewers shared, plus the author’s own', () => {
  const rows = [
    annotation({ ownerId: 'anna', visibility: 'private' }),
    annotation({ ownerId: 'anna', visibility: 'author' }),
    annotation({ ownerId: 'ben', visibility: 'link' }),
    annotation({ ownerKind: 'author', ownerId: mike.id, visibility: 'private' }),
  ]

  const visible = listableAnnotations(mike, rows)
  assert.equal(visible.length, 3)
  assert.ok(
    !visible.some((row) => row.ownerId === 'anna' && row.visibility === 'private'),
    'the private reviewer annotation is absent',
  )
})
