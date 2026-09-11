import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

import {
  ADMIN_STATE_COOKIE_NAME,
  adminCookie,
  adminRedirectUri,
  clearedAdminStateCookie,
  exchangeGoogleCode,
  isAdminConfigured,
  isAllowedAdminEmail,
  mintAdminToken,
  verifyAdminState,
} from '@/lib/admin-auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Where Google sends the administrator back to.
 *
 * Every branch below is a refusal, and all but one of them report the same
 * generic failure. The exception is `denied`, which is the honest and useful
 * answer to "you signed in successfully, and you are still not allowed in" --
 * it is shown only to somebody who has already proved they control a mailbox,
 * so it discloses nothing a stranger could use, and leaving them staring at a
 * generic error would be unkind and confusing.
 *
 * The order matters: the state is checked before the code is spent, and the
 * allowlist is checked before a session is minted. A Google account that is not
 * on the allowlist never receives a cookie of any kind.
 */
export async function GET(request: NextRequest) {
  if (!isAdminConfigured()) {
    return done(request, '/admin/login?error=unconfigured')
  }

  const url = new URL(request.url)

  // Google reports a refusal -- the visitor cancelled, or declined consent.
  if (url.searchParams.get('error')) {
    return done(request, '/admin/login?error=failed')
  }

  const state = await verifyAdminState(url.searchParams.get('state'))
  if (!state) return done(request, '/admin/login?error=failed')

  /*
   * The signed state proves the value is ours. This proves it is *this
   * browser's*: the nonce was written to an HttpOnly cookie when the sign-in
   * began, and a state minted for somebody else's attempt will not match it.
   */
  const nonce = request.cookies.get(ADMIN_STATE_COOKIE_NAME)?.value
  if (!nonce || nonce !== state.nonce) {
    return done(request, '/admin/login?error=failed')
  }

  const code = url.searchParams.get('code')
  if (!code) return done(request, '/admin/login?error=failed')

  const identity = await exchangeGoogleCode(code, adminRedirectUri(request.url))
  if (!identity) return done(request, '/admin/login?error=failed')

  /*
   * The whole point of this gate. Google has confirmed which verified mailbox
   * this person controls; that is authentication and it is not authorization.
   * Unless the address is exactly one of the configured administrators, the
   * sign-in ends here with no session, no cookie and no access.
   */
  if (!isAllowedAdminEmail(identity.email)) {
    return done(request, '/admin/login?error=denied')
  }

  const token = await mintAdminToken(identity.email)
  if (!token) return done(request, '/admin/login?error=failed')

  const response = done(request, state.next)
  response.cookies.set(adminCookie(token))
  return response
}

/** Redirect, always clearing the one-shot state cookie on the way out. */
function done(request: NextRequest, target: string) {
  const response = NextResponse.redirect(new URL(target, request.url), 303)
  response.cookies.set(clearedAdminStateCookie())
  response.headers.set(
    'Cache-Control',
    'private, no-store, no-cache, max-age=0, must-revalidate',
  )
  response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive')
  return response
}
