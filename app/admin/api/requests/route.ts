import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

import { ADMIN_COOKIE_NAME, adminCsrfTokenMatches, verifyAdminToken } from '@/lib/admin-auth'
import { AdminRequestError } from '@/lib/reviewer-admin'
import { RosterConflictError, RosterReadOnlyError } from '@/lib/reviewer-roster'
import { RequestConflictError, listRequests } from '@/lib/reviewer-requests'
import { requestMutationBody } from '@/lib/admin-response'
import {
  approveRequest,
  cancelApproval,
  declineRequest,
  loadRequestViews,
  removeDeclinedRequest,
  sendAccessEmailForRequest,
} from '@/lib/reviewer-onboarding'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Everything Mike can do to an access request.
 *
 * A separate endpoint from `/admin/api/reviewers` rather than four more cases
 * in its switch: that handler returns the roster after every action, this one
 * returns the requests, and a mutation that has to guess which of the two the
 * caller wanted is a mutation waiting to return the wrong thing. The
 * authorisation discipline is identical, and identically re-done here rather
 * than inherited:
 *
 *   1. A valid administrator session, **re-verified in this handler**. The
 *      request boundary checked it too; this does not depend on that.
 *   2. The CSRF token derived from that session, which a page that cannot read
 *      the session cookie cannot produce.
 *   3. A known action. An unknown one is refused, never interpreted.
 *
 * **No response from this endpoint has ever contained a credential.** There is
 * no field to put one in: an activation token exists only between being minted
 * and being written into an email, and Mike is not a recipient of that email.
 * What comes back is whether one is outstanding and when it expires.
 *
 * **A mutation that committed is never reported as a failure.** The operation
 * and the request-list reread that follows it are two separate acts, and only
 * the first is inside the `catch` that produces a refusal. A reread that fails
 * after the change landed answers `ok: true` with `refreshed: false`, and the
 * committed result -- an approval's `delivery` outcome included -- is still in
 * the body. It used not to: the reread sat inside the same `try`, so a
 * transient store failure returned "Nothing further was changed" about an
 * approval that had already created a reviewer and sent their email. See
 * `lib/admin-response.ts`.
 */

type Body = Record<string, unknown>

export async function POST(request: NextRequest) {
  const store = await cookies()
  const token = store.get(ADMIN_COOKIE_NAME)?.value
  const session = await verifyAdminToken(token)

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
  const requestId = typeof body.requestId === 'string' ? body.requestId : ''

  /*
   * Everything inside this `try` either commits or throws. The reread that
   * follows is deliberately outside it -- see the header comment.
   */
  let committed: Record<string, unknown>
  try {
    switch (action) {
      case 'approve': {
        const result = await approveRequest({ requestId, books: body.books, actor })
        committed = { delivery: result.delivery, reviewerId: result.reviewerId }
        break
      }

      /*
       * "Send a new access email". Which email that is -- a long activation
       * link or a fifteen-minute sign-in link -- is decided inside, from the
       * roster, at the operation boundary. The purpose comes back so the
       * dashboard can say which one went.
       */
      case 'send-access-email': {
        const result = await sendAccessEmailForRequest({ requestId, actor })
        committed = { delivery: result.delivery, purpose: result.purpose }
        break
      }

      /*
       * The second way out of an approval that stopped and whose reviewer was
       * revoked afterwards. The first is Restore (on the reviewer card) followed
       * by Finish. Cancelling closes the request and leaves the reviewer revoked
       * and on the roster; it never reactivates and never removes anybody.
       */
      case 'cancel-approval': {
        await cancelApproval({ requestId, actor })
        committed = {}
        break
      }

      case 'decline': {
        await declineRequest({ requestId, actor })
        committed = {}
        break
      }

      case 'remove': {
        await removeDeclinedRequest({ requestId, actor })
        committed = {}
        break
      }

      default:
        return refuse('unknown_action', 400)
    }
  } catch (error) {
    if (error instanceof AdminRequestError) return refuse(error.message, error.status)
    if (error instanceof RequestConflictError) return refuse(error.message, 409)
    if (error instanceof RosterConflictError) return refuse(error.message, 409)
    if (error instanceof RosterReadOnlyError) return refuse(error.message, 409)
    /*
     * A fault in the store or in this code. The message is deliberately not
     * forwarded: it could name a pathname, a driver detail or a
     * credential-shaped string, and none of that belongs in a response body.
     *
     * This is now reachable only when the change did **not** commit.
     */
    return refuse('That could not be completed. Nothing further was changed.', 500)
  }

  return await ok(committed)
}

/**
 * Every successful action answers with the committed result, and with the
 * requests as they now stand **if they can still be read**, so the dashboard
 * never has to guess what changed or patch its own copy.
 *
 * A reread that fails leaves the response a success and says `refreshed: false`.
 */
async function ok(committed: Record<string, unknown>) {
  return privately(
    NextResponse.json(
      await requestMutationBody(committed, async () => loadRequestViews(await listRequests())),
    ),
  )
}

function refuse(error: string, status: number) {
  return privately(NextResponse.json({ ok: false, error }, { status }))
}

function privately(response: NextResponse) {
  response.headers.set('Cache-Control', 'private, no-store, no-cache, max-age=0, must-revalidate')
  response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive')
  return response
}
