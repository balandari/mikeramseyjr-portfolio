import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

import { privateHeaders, privateSameOriginRedirect } from '@/lib/redirect'
import {
  adminRedirectUri,
  adminStateCookie,
  googleAuthorizationUrl,
  isAdminConfigured,
  mintAdminState,
  safeAdminPath,
} from '@/lib/admin-auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Begin a Google sign-in.
 *
 * A POST rather than a link, so that nothing -- a prefetch, a crawler, a
 * preview fetcher -- can start a sign-in by looking at the page. The state it
 * mints is signed and also written to a short-lived cookie; the callback
 * requires the two to agree, which is what stops somebody sending Mike a
 * prepared link that lands him in their session.
 */
export async function POST(request: NextRequest) {
  if (!isAdminConfigured()) {
    return privateSameOriginRedirect('/admin/login?error=unconfigured')
  }

  const form = await request.formData().catch(() => null)
  const next = safeAdminPath(
    typeof form?.get('next') === 'string' ? (form.get('next') as string) : null,
  )

  const state = await mintAdminState(next)
  if (!state) {
    return privateSameOriginRedirect('/admin/login?error=unconfigured')
  }

  // Google is a different origin, so this one redirect is genuinely absolute --
  // and it is absolute because Google's URL says so, not because this server
  // guessed at its own address.
  const response = privateHeaders(
    NextResponse.redirect(
      new URL(googleAuthorizationUrl(adminRedirectUri(request.url), state.state)),
      303,
    ),
  )
  response.cookies.set(adminStateCookie(state.nonce))
  return response
}
