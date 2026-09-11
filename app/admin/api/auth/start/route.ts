import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

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
    return privateRedirect(request, '/admin/login?error=unconfigured')
  }

  const form = await request.formData().catch(() => null)
  const next = safeAdminPath(
    typeof form?.get('next') === 'string' ? (form.get('next') as string) : null,
  )

  const state = await mintAdminState(next)
  if (!state) {
    return privateRedirect(request, '/admin/login?error=unconfigured')
  }

  const response = privateRedirect(
    request,
    googleAuthorizationUrl(adminRedirectUri(request.url), state.state),
  )
  response.cookies.set(adminStateCookie(state.nonce))
  return response
}

function privateRedirect(request: NextRequest, target: string) {
  // 303, not the default 307: a 307 would replay this POST against the target.
  const url = target.startsWith('http') ? new URL(target) : new URL(target, request.url)
  const response = NextResponse.redirect(url, 303)
  response.headers.set(
    'Cache-Control',
    'private, no-store, no-cache, max-age=0, must-revalidate',
  )
  response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive')
  return response
}
