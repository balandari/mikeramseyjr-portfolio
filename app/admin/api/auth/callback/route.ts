import type { NextRequest } from 'next/server'

import { privateSameOriginRedirect } from '@/lib/redirect'
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
    return done('/admin/login?error=unconfigured')
  }

  const url = new URL(request.url)

  // Google reports a refusal -- the visitor cancelled, or declined consent.
  if (url.searchParams.get('error')) {
    return done('/admin/login?error=failed')
  }

  const state = await verifyAdminState(url.searchParams.get('state'))
  if (!state) return done('/admin/login?error=failed')

  /*
   * The signed state proves the value is ours. This proves it is *this
   * browser's*: the nonce was written to an HttpOnly cookie when the sign-in
   * began, and a state minted for somebody else's attempt will not match it.
   */
  const nonce = request.cookies.get(ADMIN_STATE_COOKIE_NAME)?.value
  if (!nonce || nonce !== state.nonce) {
    return done('/admin/login?error=failed')
  }

  const code = url.searchParams.get('code')
  if (!code) return done('/admin/login?error=failed')

  const identity = await exchangeGoogleCode(code, adminRedirectUri(request.url))
  if (!identity) return done('/admin/login?error=failed')

  /*
   * The whole point of this gate. Google has confirmed which verified mailbox
   * this person controls; that is authentication and it is not authorization.
   * Unless the address is exactly one of the configured administrators, the
   * sign-in ends here with no session, no cookie and no access.
   */
  if (!isAllowedAdminEmail(identity.email)) {
    return done('/admin/login?error=denied')
  }

  const token = await mintAdminToken(identity.email)
  if (!token) return done('/admin/login?error=failed')

  const response = done(state.next)
  response.cookies.set(adminCookie(token))
  return response
}

/**
 * Redirect, always clearing the one-shot state cookie on the way out.
 *
 * Relative, like every other internal redirect here: Google sends the
 * administrator back to whatever origin the callback was registered against,
 * and the answer has to land on that same origin rather than on whichever one
 * this server believes it is running as.
 */
function done(target: string) {
  const response = privateSameOriginRedirect(target)
  response.cookies.set(clearedAdminStateCookie())
  return response
}
