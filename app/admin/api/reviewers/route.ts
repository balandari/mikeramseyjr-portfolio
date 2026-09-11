import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

import {
  ADMIN_COOKIE_NAME,
  adminCsrfTokenMatches,
  verifyAdminToken,
} from '@/lib/admin-auth'
import {
  AdminRequestError,
  createReviewer,
  loadAdminView,
  renameReviewer,
  replaceReviewerCode,
  restoreReviewer,
  revokeReviewer,
  setReviewerEntitlements,
} from '@/lib/reviewer-admin'
import { RosterConflictError, RosterReadOnlyError } from '@/lib/reviewer-roster'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Every mutation the dashboard can perform.
 *
 * Three things are true of every request that reaches an operation:
 *
 *   1. It carried a valid administrator session, re-verified *here*. The
 *      request boundary checked it too, but this handler does not depend on
 *      that having happened -- the boundary is defence in depth and this is the
 *      enforcement point.
 *   2. It carried the matching CSRF token, which is derived from the session
 *      and cannot be produced by a page that cannot read the session cookie.
 *   3. It named an action this handler knows. An unknown action is refused
 *      rather than interpreted.
 *
 * Anything else is a 401, a 403 or a 400, and nothing is mutated.
 *
 * What comes back never includes a code fingerprint. The plaintext code from an
 * issue or a re-issue is returned exactly once, in the response that performed
 * it, and is never stored, logged or recoverable afterwards.
 */

type Body = Record<string, unknown>

export async function POST(request: NextRequest) {
  const store = await cookies()
  const token = store.get(ADMIN_COOKIE_NAME)?.value
  const session = await verifyAdminToken(token)

  // Fail closed, and say nothing about why. An unauthenticated caller learns
  // that this endpoint exists and refused them, and nothing else.
  if (!session || !token) return refuse('not_authorized', 401)

  let body: Body
  try {
    const parsed: unknown = await request.json()
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return refuse('bad_request', 400)
    }
    body = parsed as Body
  } catch {
    return refuse('bad_request', 400)
  }

  if (!(await adminCsrfTokenMatches(token, typeof body.csrf === 'string' ? body.csrf : null))) {
    return refuse('bad_csrf', 403)
  }

  const actor = session.email
  const action = typeof body.action === 'string' ? body.action : ''

  try {
    switch (action) {
      case 'create': {
        const { issued } = await createReviewer(
          { name: body.name, email: body.email, books: body.books, id: body.id },
          actor,
        )
        return await ok({ issued })
      }

      case 'replace-code': {
        const { issued } = await replaceReviewerCode(body.reviewerId, actor)
        return await ok({ issued })
      }

      case 'set-entitlements': {
        await setReviewerEntitlements(body.reviewerId, body.books, actor)
        return await ok({})
      }

      case 'rename': {
        await renameReviewer(body.reviewerId, body.name, actor)
        return await ok({})
      }

      case 'revoke': {
        await revokeReviewer(body.reviewerId, actor)
        return await ok({})
      }

      case 'restore': {
        await restoreReviewer(body.reviewerId, actor)
        return await ok({})
      }

      default:
        return refuse('unknown_action', 400)
    }
  } catch (error) {
    if (error instanceof AdminRequestError) {
      return refuse(error.message, error.status)
    }
    if (error instanceof RosterConflictError) {
      return refuse(error.message, 409)
    }
    if (error instanceof RosterReadOnlyError) {
      return refuse(error.message, 409)
    }
    /*
     * Anything else is a fault in the store or in this code. The message is
     * deliberately not forwarded: it could name a pathname, a driver detail or
     * a credential-shaped string, and none of that belongs in a response body.
     */
    return refuse('The roster could not be updated. Nothing was changed.', 500)
  }
}

/**
 * A successful mutation answers with the whole roster as it now stands.
 *
 * The dashboard therefore never has to guess what changed or patch its own
 * copy: it re-renders from the server's view of the world after every action,
 * which is the only view that matters.
 */
async function ok(extra: Record<string, unknown>) {
  const view = await loadAdminView()
  return privately(
    NextResponse.json({
      ok: true,
      ...extra,
      view: {
        driver: view.driver,
        writable: view.writable,
        updatedAt: view.updatedAt,
        books: view.books,
        // `codeHash` is stripped. It is a keyed fingerprint and not reversible,
        // but the browser has no use for it, and the narrowest payload is the
        // one that cannot leak.
        reviewers: view.reviewers.map((reviewer) => ({
          id: reviewer.id,
          name: reviewer.name,
          email: reviewer.email,
          books: reviewer.books,
          status: reviewer.status,
          createdAt: reviewer.createdAt,
          codeUpdatedAt: reviewer.codeUpdatedAt,
          lastAccessAt: reviewer.lastAccessAt,
        })),
        audit: view.audit,
      },
    }),
  )
}

function refuse(error: string, status: number) {
  return privately(NextResponse.json({ ok: false, error }, { status }))
}

function privately(response: NextResponse) {
  response.headers.set(
    'Cache-Control',
    'private, no-store, no-cache, max-age=0, must-revalidate',
  )
  response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive')
  return response
}
