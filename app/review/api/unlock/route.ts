import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

import {
  identifyReviewer,
  isReviewerAccessConfigured,
  mintReviewerToken,
  reviewerCookie,
} from '@/lib/reviewer-access'
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

  // Fail closed: with no signing secret and no roster there is nothing a caller
  // could submit that should open the reader.
  if (!isReviewerAccessConfigured()) {
    return privateRedirect(request, '/review/login?error=unavailable')
  }

  const reviewer = await identifyReviewer(submitted)
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
