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

/**
 * Where to send an unauthenticated visitor, as an absolute URL on *their* origin.
 *
 * Route handlers answer with a relative `Location` and name no origin at all
 * (see `lib/redirect.ts`) -- which is what stopped a phone being redirected to
 * `0.0.0.0` after a valid access code. The boundary cannot do the same: Next's
 * middleware adapter parses `Location` into a `URL` itself, and a relative one
 * throws `Invalid URL` and turns every unauthenticated request into a 500.
 *
 * So this builds an absolute URL, but from `request.nextUrl` rather than from
 * `request.url`. That distinction is the whole fix: `nextUrl` carries the host
 * the request actually arrived on -- and, behind Vercel's proxy, the forwarded
 * host -- whereas `request.url` carries the address the server was *bound* to,
 * which with `-H 0.0.0.0` is `0.0.0.0` and is reachable from nothing.
 *
 * `clone()` keeps that origin and replaces only the path and the query, so the
 * destination can never be anywhere but this same site.
 */
function signInUrl(request: NextRequest, path: string, wanted: string | null): URL {
  const destination = request.nextUrl.clone()
  destination.pathname = path
  destination.search = ''
  if (wanted) destination.searchParams.set('next', wanted)
  return destination
}

/** Paths inside `/review` that an unauthenticated visitor must be able to reach. */
function isPublicReviewPath(pathname: string): boolean {
  if (pathname === '/review/login') return true
  // The sign-in submission itself, and the sign-out action, which must work
  // even when the cookie it is clearing is already invalid.
  if (pathname === '/review/api/unlock') return true
  if (pathname === '/review/api/lock') return true

  /*
   * Reviewer onboarding. Every one of these is reached by somebody who does not
   * have a session yet -- that is what they are for -- so each is named
   * exactly, never by prefix. A `startsWith('/review/signin')` would also admit
   * `/review/signinanything`, which is a different path that merely begins with
   * the same letters.
   *
   * None of them discloses anything. The request form and the sign-in form
   * answer identically whatever address is submitted; the two credential pages
   * render nothing that depends on the credential, because the credential
   * arrives in the URL fragment and never reaches this function or any other
   * server code until it is posted back.
   */
  if (pathname === '/review/request') return true
  if (pathname === '/review/api/request') return true
  if (pathname === '/review/activate') return true
  if (pathname === '/review/signin') return true
  if (pathname === '/review/signin/verify') return true
  if (pathname === '/review/api/signin') return true
  if (pathname === '/review/api/credential') return true
  /*
   * A private annotation link.
   *
   * This one is here for a specific reason rather than because it is public.
   * The administrator cookie is scoped to `/admin`, so it is not sent to
   * `/review/shared/...`; if the boundary bounced an unauthenticated visitor
   * straight to the reviewer sign-in form, Mike would be asked for a reviewer
   * access code in order to read a note somebody shared with him. So the page
   * answers for itself and offers both doors.
   *
   * It discloses nothing by being reachable. The page requires a reviewer
   * session and live entitlement to that book before it reads any annotation,
   * and answers identically for a real token, a wrong token, an unentitled
   * reader and no session at all -- so the URL cannot be used to learn whether
   * a note exists.
   */
  if (pathname.startsWith('/review/shared/')) return true
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

    // Carry where they were going, so signing in lands them there rather than
    // at the top. `safeReviewPath` re-checks this value before it is used.
    const wanted = `${pathname}${search}`
    return privately(
      NextResponse.redirect(signInUrl(request, '/review/login', wanted === '/review' ? null : wanted)),
    )
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

    const wanted = `${pathname}${search}`
    return privately(
      NextResponse.redirect(signInUrl(request, '/admin/login', wanted === '/admin' ? null : wanted)),
    )
  }

  return privately(NextResponse.next())
}

/**
 * Unpublished manuscript pages and the roster that governs them must not be
 * cached by a shared cache, kept in back/forward history after sign-out, or
 * indexed.
 *
 * Generic over the response type because the redirects here are plain
 * `Response`s -- a `NextResponse` carrying a relative `Location` throws inside
 * the Edge bundle. See `lib/redirect.ts`.
 */
function privately<T extends Response>(response: T): T {
  response.headers.set(
    'Cache-Control',
    'private, no-store, no-cache, max-age=0, must-revalidate',
  )
  response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive')
  /*
   * No page in either private area should name itself to anywhere a visitor
   * navigates next. It matters most on the two credential pages: the token
   * lives in the URL fragment, which is never sent in a request and never
   * appears in a `Referer` -- and this makes sure the *path* does not travel
   * either. It costs the private area nothing; nothing here depends on being
   * able to see where a click came from.
   */
  response.headers.set('Referrer-Policy', 'no-referrer')
  return response
}

export const config = {
  matcher: ['/review', '/review/:path*', '/admin', '/admin/:path*'],
}
