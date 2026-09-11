import { clearedReviewerCookie } from '@/lib/reviewer-access'
import { privateSameOriginRedirect } from '@/lib/redirect'

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
export async function POST() {
  const response = privateSameOriginRedirect('/review/login?signedout=1')
  response.cookies.set(clearedReviewerCookie())
  return response
}
