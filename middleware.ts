import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

import { REVIEWER_COOKIE_NAME, verifyReviewerToken } from '@/lib/reviewer-access'

/**
 * The outer boundary for the private reviewer area.
 *
 * This is defence in depth, not the enforcement point. Every page and every
 * route handler under `/review` verifies the cookie again for itself, and it is
 * those checks that decide what a reviewer may see. What this adds is that an
 * unauthorized request is turned away at the edge, before the manuscript module
 * is ever loaded in a server render.
 *
 * The matcher covers `/review` and nothing else, so the portfolio's own routes
 * -- `/`, `/app`, `/app/learning`, the static assets -- never enter this
 * function at all and behave exactly as they did before.
 */

/** Paths inside `/review` that an unauthenticated visitor must be able to reach. */
function isPublicReviewPath(pathname: string): boolean {
  if (pathname === '/review/login') return true
  // The sign-in submission itself, and the sign-out action, which must work
  // even when the cookie it is clearing is already invalid.
  if (pathname === '/review/api/unlock') return true
  if (pathname === '/review/api/lock') return true
  return false
}

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl

  if (isPublicReviewPath(pathname)) {
    return privately(NextResponse.next())
  }

  const token = request.cookies.get(REVIEWER_COOKIE_NAME)?.value
  const reviewer = await verifyReviewerToken(token)

  if (!reviewer) {
    // An API caller gets an answer it can act on. Redirecting a `fetch` to the
    // sign-in page would hand it a 200 and a page of HTML, which reads as
    // success to everything except a human.
    if (pathname.startsWith('/review/api/')) {
      return privately(
        NextResponse.json({ error: 'not_authorized' }, { status: 401 }) as NextResponse,
      )
    }

    const destination = new URL('/review/login', request.url)
    // Carry where they were going, so signing in lands them there rather than
    // at the top. `safeReviewPath` re-checks this value before it is used.
    const wanted = `${pathname}${search}`
    if (wanted !== '/review') destination.searchParams.set('next', wanted)
    return privately(NextResponse.redirect(destination))
  }

  return privately(NextResponse.next())
}

/**
 * Unpublished manuscript pages must not be cached by a shared cache, kept in
 * back/forward history after sign-out, or indexed.
 */
function privately(response: NextResponse): NextResponse {
  response.headers.set(
    'Cache-Control',
    'private, no-store, no-cache, max-age=0, must-revalidate',
  )
  response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive')
  return response
}

export const config = {
  matcher: ['/review', '/review/:path*'],
}
