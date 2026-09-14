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
  invalidateReviewerCredentials,
  loadAdminView,
  renameReviewer,
  replaceReviewerCode,
  restoreReviewer,
  revokeReviewer,
  setReviewerEntitlements,
} from '@/lib/reviewer-admin'
import { RosterConflictError, RosterReadOnlyError } from '@/lib/reviewer-roster'
import { reviewerMutationBody } from '@/lib/admin-response'
import { sendAccessEmailToReviewer, setReviewerEmail } from '@/lib/reviewer-onboarding'

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
 *
 * **A mutation that committed is never reported as a failure.** The operation
 * and the dashboard reread that follows it are two separate acts, and only the
 * first one is inside the `catch` that produces a refusal. A reread that fails
 * after the write landed answers `ok: true` with `refreshed: false` and the
 * committed result -- the one-time code included -- still in the body. It used
 * not to: the reread was inside the same `try`, so a transient store failure
 * returned "Nothing was changed" about a change that had already happened, and
 * destroyed the only copy of a freshly issued code on the way. See
 * `lib/admin-response.ts`.
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

  /*
   * Everything inside this `try` either commits or throws. The dashboard reread
   * is deliberately outside it -- see the header comment.
   */
  let committed: Record<string, unknown>
  try {
    switch (action) {
      case 'create': {
        const { issued } = await createReviewer(
          { name: body.name, email: body.email, books: body.books, id: body.id },
          actor,
        )
        committed = { issued }
        break
      }

      case 'replace-code': {
        const { issued } = await replaceReviewerCode(body.reviewerId, actor)
        committed = { issued }
        break
      }

      case 'set-entitlements': {
        await setReviewerEntitlements(body.reviewerId, body.books, actor)
        committed = {}
        break
      }

      case 'rename': {
        await renameReviewer(body.reviewerId, body.name, actor)
        committed = {}
        break
      }

      case 'revoke': {
        await revokeReviewer(body.reviewerId, actor)
        committed = {}
        break
      }

      case 'restore': {
        await restoreReviewer(body.reviewerId, actor)
        committed = {}
        break
      }

      /*
       * Kill every outstanding emailed link for one reviewer, without revoking
       * them and without ending their sessions. It advances their credential
       * epoch inside one conditional roster mutation, so the change and the
       * kill commit together. See `invalidateReviewerCredentials`.
       */
      case 'invalidate-credentials': {
        await invalidateReviewerCredentials(body.reviewerId, actor)
        committed = {}
        break
      }

      /*
       * Adding or correcting an address. Not an edit: it un-verifies the
       * address and advances the credential epoch, so every outstanding emailed
       * link dies with the change rather than beside it.
       * The reviewer's id, entitlements and reading data are untouched, because
       * none of them was ever keyed on an address.
       */
      case 'set-email': {
        await setReviewerEmail(
          { reviewerId: typeof body.reviewerId === 'string' ? body.reviewerId : '', email: body.email, actor },
          {},
        )
        committed = {}
        break
      }

      /*
       * Send a reviewer the access email they can actually use. An unverified
       * address gets an activation link -- the migration path for everybody
       * already here with a code; a verified one gets a fifteen-minute sign-in
       * link, because an activation link would be refused the instant they
       * pressed it.
       *
       * Only the id is passed. The reviewer is resolved from the roster inside
       * the operation, so a dashboard rendered a minute ago cannot decide which
       * message goes out.
       */
      case 'send-access-email': {
        const result = await sendAccessEmailToReviewer(
          { reviewerId: typeof body.reviewerId === 'string' ? body.reviewerId : '', actor },
          {},
        )
        committed = { delivery: result.delivery, purpose: result.purpose }
        break
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
     *
     * This is now reachable only when the mutation did **not** commit.
     */
    return refuse('The roster could not be updated. Nothing was changed.', 500)
  }

  return await ok(committed)
}

/**
 * A successful mutation answers with the committed result, and with the whole
 * roster as it now stands **if that can still be read**.
 *
 * The dashboard therefore never has to guess what changed or patch its own
 * copy: it re-renders from the server's view of the world after every action,
 * which is the only view that matters. When that view cannot be loaded, the
 * response says so with `refreshed: false` and stays a success, because the
 * mutation it is reporting has already happened.
 */
async function ok(committed: Record<string, unknown>) {
  return privately(NextResponse.json(await reviewerMutationBody(committed, loadAdminView)))
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
