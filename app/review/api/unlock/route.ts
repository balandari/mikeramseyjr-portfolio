import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

import { mintReviewerToken, reviewerCookie } from '@/lib/reviewer-access'
import {
  identifyReviewerFromStore,
  isReviewerAccessLive,
} from '@/lib/reviewer-authorization'
import { safeReviewPath } from '../../safe-path'

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
 * them would tell an unauthenticated caller which codes exist.
 */

function privateRedirect(request: NextRequest, path: string) {
  // 303, not the default 307: a 307 would replay this POST against the target.
  const response = NextResponse.redirect(new URL(path, request.url), 303)
  response.headers.set(
    'Cache-Control',
    'private, no-store, no-cache, max-age=0, must-revalidate',
  )
  response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive')
  return response
}

export async function POST(request: NextRequest) {
  let submitted = ''
  let next = '/review'

  try {
    const form = await request.formData()
    const code = form.get('code')
    const target = form.get('next')
    submitted = typeof code === 'string' ? code : ''
    next = safeReviewPath(typeof target === 'string' ? target : null)
  } catch {
    // A body we cannot read is not a valid submission.
    return privateRedirect(request, '/review/login?error=1')
  }

  // Fail closed: with no signing secret, no reachable roster, or a roster with
  // nobody active on it, there is nothing a caller could submit that should
  // open the reader.
  if (!(await isReviewerAccessLive())) {
    return privateRedirect(request, '/review/login?error=unavailable')
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
    return privateRedirect(request, '/review/login?error=unavailable')
  }

  if (!reviewer) {
    return privateRedirect(request, `/review/login?error=1&next=${encodeURIComponent(next)}`)
  }

  const token = await mintReviewerToken(reviewer)
  if (!token) {
    return privateRedirect(request, '/review/login?error=unavailable')
  }

  const response = privateRedirect(request, next)
  response.cookies.set(reviewerCookie(token))
  return response
}
