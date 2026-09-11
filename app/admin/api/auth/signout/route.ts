import { clearedAdminCookie } from '@/lib/admin-auth'
import { privateSameOriginRedirect } from '@/lib/redirect'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * End the administrator session on this device.
 *
 * Deliberately unconditional: it clears the cookie whatever state it was in,
 * including one that is already invalid. A sign-out that could itself fail
 * would be the worst possible thing to get wrong.
 */
export async function POST() {
  const response = privateSameOriginRedirect('/admin/login?signedout=1')
  response.cookies.set(clearedAdminCookie())
  return response
}
