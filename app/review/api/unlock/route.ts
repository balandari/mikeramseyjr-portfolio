import type { NextRequest } from 'next/server'

import { mintReviewerToken, reviewerCookie } from '@/lib/reviewer-access'
import {
  identifyReviewerFromStore,
  isReviewerAccessLive,
} from '@/lib/reviewer-authorization'
import { privateSameOriginRedirect } from '@/lib/redirect'
import { createPrivateStore } from '@/lib/private-store'
import { allowCredentialAttempt } from '@/lib/rate-limit'
import { safeReviewPath } from '../../safe-path'
import { readBoundedForm, UNLOCK_FORM_LIMIT_BYTES } from '@/lib/request-bounds'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * The only endpoint that reads a submitted access code.
 *
 * The code is fingerprinted and compared on the server, is never echoed back to
 * the browser, never written to a log, never placed in a URL, a header or a
 * response body, and never stored anywhere in its submitted form. What the
 * browser receives is either an opaque signed cookie or a redirect back to the
 * sign-in page with a generic failure flag.
 *
 * The failure flag is deliberately generic. "That code is not valid" and "that
 * reviewer has been removed" are the same answer here, because distinguishing
 * them would tell an unauthenticated caller which codes exist. A submission
 * refused by the limiter is answered the same way, for the same reason.
 *
 * ## The brake, which this route did not have
 *
 * This is the site's oldest public write, and it was the one endpoint the
 * rate-limiting work never reached: an invalid submission performed **two
 * roster-backed reads** and nothing counted them. The proposed Firewall rule
 * covered `/review/api/request` and `/review/api/signin` and not this.
 *
 * It now applies the credential route's policy, through the credential route's
 * own function (`allowCredentialAttempt`), and applies it **before either roster
 * read**. So at or beyond the limit this endpoint costs the store the limiter's
 * single read, no writes, and no roster read at all. When the limiter is
 * unavailable it admits rather than refusing: this endpoint sends no mail, and a
 * legitimate code holder must not be locked out because a counter is missing.
 */

/**
 * Every answer this endpoint gives is a redirect to a path on this same origin,
 * emitted relative so it is correct through localhost, a LAN address and the
 * production domain alike. See `lib/redirect.ts` -- building an absolute URL
 * from `request.url` is what sent a phone to `0.0.0.0` after a valid code.
 */
function privateRedirect(path: string) {
  return privateSameOriginRedirect(path)
}

export async function POST(request: NextRequest) {
  let submitted = ''
  let next = '/review'

  /*
   * Bounded and typed before parsing, and before either roster read. A body
   * we cannot read, one that is too large, and one sent as a type no form on
   * this site produces are one answer: not a valid submission.
   */
  const bounded = await readBoundedForm(request, UNLOCK_FORM_LIMIT_BYTES)
  if (!bounded.ok) return privateRedirect('/review/login?error=1')
  {
    const form = bounded.value
    const code = form.get('code')
    const target = form.get('next')
    submitted = typeof code === 'string' ? code : ''
    next = safeReviewPath(typeof target === 'string' ? target : null)
  }

  /*
   * The brake, before anything reads the roster.
   *
   * Deliberately the first thing after the body: `isReviewerAccessLive()` and
   * `identifyReviewerFromStore()` are the two roster reads a hammered invalid
   * submission used to buy for nothing, and the acceptance condition for this
   * repair is that at or beyond the limit neither of them happens.
   */
  const limiterStore = (() => {
    try {
      return createPrivateStore()
    } catch {
      return null
    }
  })()
  if (!(await allowCredentialAttempt(request.headers, limiterStore))) {
    return privateRedirect(`/review/login?error=1&next=${encodeURIComponent(next)}`)
  }

  // Fail closed: with no signing secret, no reachable roster, or a roster with
  // nobody active on it, there is nothing a caller could submit that should
  // open the reader.
  if (!(await isReviewerAccessLive())) {
    return privateRedirect('/review/login?error=unavailable')
  }

  /*
   * Only active reviewers are compared against. A revoked reviewer's code is
   * therefore refused with the same generic message an unknown code gets --
   * which is the point: a revoked reader must not be able to learn that their
   * code was once real, and a stranger must not be able to map which codes
   * exist by watching how the answers differ.
   */
  let reviewer = null
  try {
    reviewer = await identifyReviewerFromStore(submitted)
  } catch {
    // The roster could not be read. That is not "wrong code", and saying so
    // would send someone to re-type a code that is perfectly good.
    return privateRedirect('/review/login?error=unavailable')
  }

  if (!reviewer) {
    return privateRedirect(`/review/login?error=1&next=${encodeURIComponent(next)}`)
  }

  const token = await mintReviewerToken(reviewer)
  if (!token) {
    return privateRedirect('/review/login?error=unavailable')
  }

  const response = privateRedirect(next)
  response.cookies.set(reviewerCookie(token))
  return response
}
