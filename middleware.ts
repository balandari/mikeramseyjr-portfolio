import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

import { ADMIN_COOKIE_NAME, verifyAdminToken } from '@/lib/admin-auth'
import { REVIEWER_COOKIE_NAME, verifyReviewerClaims } from '@/lib/reviewer-access'

/**
 * The outer boundary for the two private areas: the reviewer reader and the
 * administration dashboard.
 *
 * This is defence in depth, not the enforcement point. Every page and every
 * route handler under `/review` and `/admin` verifies for itself, and it is
 * those checks that decide what anyone may see. What this adds is that an
 * unauthorized request is turned away at the edge, before the manuscript module
 * or the roster store is ever loaded in a server render.
 *
 * What it checks, and what it deliberately does not:
 *
 *   `/review` -- the reviewer cookie's *integrity* only: shape, version,
 *   signature, expiry. It does not load the roster. Since the roster became
 *   runtime state in a private blob store, reading it needs a storage driver
 *   and a credential, and this function runs on the Edge runtime on every
 *   request. So the question "is this token genuine?" is answered here, and
 *   "may this person still read anything?" is answered by
 *   `authorizeReviewer()` inside each page and route handler, in the Node
 *   runtime, against the live roster. Revocation is immediate because that is
 *   where it is enforced -- and that is where it was already enforced before
 *   this split, because every page always re-checked for itself.
 *
 *   `/admin` -- the administrator cookie, fully: its signature, its expiry and
 *   the allowlist, all of which are decidable from configuration alone with no
 *   I/O. There is nothing here that has to wait for a page.
 *
 * The matcher covers those two areas and nothing else, so the public site's own
 * routes never enter this function at all.
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

/**
 * Paths inside `/admin` that an unauthenticated visitor must be able to reach:
 * the sign-in page and the whole OAuth handshake, which by definition happens
 * before there is a session.
 */
function isPublicAdminPath(pathname: string): boolean {
  if (pathname === '/admin/login') return true
  if (pathname.startsWith('/admin/api/auth/')) return true
  return false
}

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl

  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    return adminBoundary(request, pathname, search)
  }

  return reviewBoundary(request, pathname, search)
}

async function reviewBoundary(request: NextRequest, pathname: string, search: string) {
  if (isPublicReviewPath(pathname)) {
    return privately(NextResponse.next())
  }

  const token = request.cookies.get(REVIEWER_COOKIE_NAME)?.value
  const claims = await verifyReviewerClaims(token)

  if (!claims) {
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

async function adminBoundary(request: NextRequest, pathname: string, search: string) {
  if (isPublicAdminPath(pathname)) {
    return privately(NextResponse.next())
  }

  const session = await verifyAdminToken(request.cookies.get(ADMIN_COOKIE_NAME)?.value)

  if (!session) {
    if (pathname.startsWith('/admin/api/')) {
      return privately(
        NextResponse.json({ error: 'not_authorized' }, { status: 401 }) as NextResponse,
      )
    }

    const destination = new URL('/admin/login', request.url)
    const wanted = `${pathname}${search}`
    if (wanted !== '/admin') destination.searchParams.set('next', wanted)
    return privately(NextResponse.redirect(destination))
  }

  return privately(NextResponse.next())
}

/**
 * Unpublished manuscript pages and the roster that governs them must not be
 * cached by a shared cache, kept in back/forward history after sign-out, or
 * indexed.
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
  matcher: ['/review', '/review/:path*', '/admin', '/admin/:path*'],
}
