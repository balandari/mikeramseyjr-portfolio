/**
 * Turning a request's cookies into a `Viewer`, for the two kinds of reader.
 *
 * There is no anonymous `Viewer` and no way to construct one from a request
 * body. Every page and every route handler that touches private reading
 * material starts here, gets either a real viewer or null, and turns null into
 * a redirect or a 401 before anything else happens.
 *
 * Both helpers re-verify from scratch on every call. The reviewer's cookie is
 * checked against the **live roster** -- signature, expiry, entry present,
 * entry active, code not rotated -- so a revoked reviewer stops being a viewer
 * immediately, not when their year-long cookie eventually expires. The
 * administrator's cookie is checked against the signing secret and the
 * allowlist. Neither trusts the request boundary in `middleware.ts` to have
 * done it: that is defence in depth, and this is the enforcement.
 */

import { cookies } from 'next/headers'

import { ADMIN_COOKIE_NAME, verifyAdminToken, type AdminSession } from './admin-auth.ts'
import { authorOwnerId } from './reading-owner.ts'
import { REVIEWER_COOKIE_NAME, type Reviewer } from './reviewer-access.ts'
import { authorizeReviewer } from './reviewer-authorization.ts'
import type { Viewer } from './reading-access.ts'

if (typeof window !== 'undefined') {
  throw new Error(
    'lib/reading-session is server-only and must not be imported by a client component',
  )
}

export type ReviewerContext = { viewer: Viewer; reviewer: Reviewer }
export type AuthorContext = { viewer: Viewer; session: AdminSession }

/**
 * The signed-in reviewer for this request, as a viewer, or null.
 *
 * The books on the viewer are the roster's answer *now*, so every entitlement
 * decision downstream is made against live state rather than against whatever
 * was true when the cookie was minted.
 */
export async function reviewerContext(): Promise<ReviewerContext | null> {
  const store = await cookies()
  const reviewer = await authorizeReviewer(store.get(REVIEWER_COOKIE_NAME)?.value)
  if (!reviewer) return null

  return {
    reviewer,
    viewer: { kind: 'reviewer', id: reviewer.id, books: reviewer.books },
  }
}

/**
 * Mike, as a viewer, or null.
 *
 * The owner id is derived from his administrator address rather than being the
 * address, and a deployment with no administrator secret cannot produce one --
 * which is correct, because it cannot produce an administrator session either.
 */
export async function authorContext(): Promise<AuthorContext | null> {
  const store = await cookies()
  const session = await verifyAdminToken(store.get(ADMIN_COOKIE_NAME)?.value)
  if (!session) return null

  const id = await authorOwnerId(session.email)
  if (!id) return null

  return { session, viewer: { kind: 'author', id } }
}
