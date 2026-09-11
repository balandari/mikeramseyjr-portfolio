import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

import { clearedReviewerCookie } from '@/lib/reviewer-access'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Sign out. Clears the reviewer cookie and returns to the sign-in page.
 *
 * It touches nothing else. The reviewer's submitted feedback is already stored
 * server-side against their identity and is unaffected; their reading position
 * and bookmark live in this browser's own storage under a namespace only they
 * can address, so signing back in returns them to the same place in the book.
 */
export async function POST(request: NextRequest) {
  const response = NextResponse.redirect(
    new URL('/review/login?signedout=1', request.url),
    303,
  )
  response.headers.set(
    'Cache-Control',
    'private, no-store, no-cache, max-age=0, must-revalidate',
  )
  response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive')
  response.cookies.set(clearedReviewerCookie())
  return response
}
