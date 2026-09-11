import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

import { clearedAdminCookie } from '@/lib/admin-auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * End the administrator session on this device.
 *
 * Deliberately unconditional: it clears the cookie whatever state it was in,
 * including one that is already invalid. A sign-out that could itself fail
 * would be the worst possible thing to get wrong.
 */
export async function POST(request: NextRequest) {
  const response = NextResponse.redirect(
    new URL('/admin/login?signedout=1', request.url),
    303,
  )
  response.cookies.set(clearedAdminCookie())
  response.headers.set(
    'Cache-Control',
    'private, no-store, no-cache, max-age=0, must-revalidate',
  )
  response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive')
  return response
}
