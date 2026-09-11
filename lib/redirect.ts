import { NextResponse } from 'next/server'

import { sameOriginPathOrRoot } from './same-origin-path.ts'

/**
 * Redirecting somewhere inside this site, without guessing at its origin.
 *
 * The reasoning, and the phone that proved it was needed, is written up in
 * `lib/same-origin-path.ts`. This module is only the plumbing: it emits a
 * relative `Location`, which the browser resolves against whatever URL actually
 * reached the server.
 *
 * There are two shapes of it, and the difference is not cosmetic:
 *
 *   `sameOriginRedirect`     a `NextResponse`, for route handlers, which need
 *                            `response.cookies.set(…)` to attach or clear a
 *                            session cookie on the way out.
 *
 *   `sameOriginRedirectEdge` a plain `Response`, for `middleware.ts`.
 *                            `NextResponse`'s constructor parses a `Location`
 *                            header into a URL, and in the Edge middleware
 *                            bundle a relative one throws `Invalid URL` and
 *                            turns every unauthenticated request into a 500.
 *                            The boundary sets no cookies, so it does not need
 *                            the richer type.
 */

export { isSameOriginPath, sameOriginPathOrRoot } from './same-origin-path.ts'

/**
 * The headers every private redirect carries: never cached by a shared cache,
 * never kept in back/forward history after sign-out, never indexed.
 */
export function privateHeaders<T extends Response>(response: T): T {
  response.headers.set(
    'Cache-Control',
    'private, no-store, no-cache, max-age=0, must-revalidate',
  )
  response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive')
  return response
}

/**
 * A redirect to a path on this same origin, for a route handler.
 *
 * 303 by default, and deliberately: a 307 would replay the original POST
 * against the target, which is wrong for every sign-in and sign-out here.
 *
 * Built by hand rather than with `NextResponse.redirect`, which requires an
 * absolute URL and would put us straight back where we started.
 */
export function sameOriginRedirect(path: string, status: 303 | 307 = 303): NextResponse {
  return new NextResponse(null, {
    status,
    headers: { Location: sameOriginPathOrRoot(path) },
  })
}

/** The same thing for the Edge boundary, as a plain `Response`. See above. */
export function sameOriginRedirectEdge(path: string, status: 303 | 307 = 307): Response {
  return new Response(null, {
    status,
    headers: { Location: sameOriginPathOrRoot(path) },
  })
}

/** The route-handler redirect with the private headers already on it. */
export function privateSameOriginRedirect(
  path: string,
  status: 303 | 307 = 303,
): NextResponse {
  return privateHeaders(sameOriginRedirect(path, status))
}
