import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

import { ADMIN_COOKIE_NAME, adminCsrfTokenMatches, verifyAdminToken } from '@/lib/admin-auth'
import { readingDelete, readingGet, readingPost } from '@/lib/reading-api'
import { authorContext } from '@/lib/reading-session'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Mike's own reading records, under the protected `/admin` route family.
 *
 * It lives here rather than under `/review` for one concrete reason: the
 * administrator cookie is scoped to `/admin`, and author reading must not be a
 * reason to widen that scope. A cookie that is only ever sent to `/admin` is a
 * cookie that cannot be replayed against anything else on the domain.
 *
 * Three things are true of everything this endpoint does:
 *
 *   - **It is the author, not a reviewer.** The viewer's owner kind is `author`,
 *     so every storage path it builds begins `reading/v1/author/...`. No
 *     reviewer identity is created, no reviewer prefix is constructed, and no
 *     reviewer's last-opened time is touched -- `authorContext()` verifies the
 *     administrator cookie and never calls `authorizeReviewer`, which is the
 *     function that records a reviewer's access.
 *
 *   - **It cannot write reviewer feedback.** There is no feedback operation
 *     here at all. Reviewer feedback is submitted through `/review/api/feedback`
 *     by an authenticated reviewer, and nothing in the author's route family
 *     can reach it.
 *
 *   - **Mutations carry the session's CSRF token**, exactly as the reviewer
 *     dashboard's mutations do. The administrator session is a long-lived
 *     browser credential for a privileged area; the same protection applies.
 */

type Body = Record<string, unknown>

function jsonResponse(body: unknown, status: number) {
  const response = NextResponse.json(body, { status })
  response.headers.set(
    'Cache-Control',
    'private, no-store, no-cache, max-age=0, must-revalidate',
  )
  response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive')
  return response
}

/** The session cookie's raw value, needed to check a CSRF token against it. */
async function adminToken(): Promise<string | null> {
  const store = await cookies()
  const value = store.get(ADMIN_COOKIE_NAME)?.value
  if (!value) return null
  return (await verifyAdminToken(value)) ? value : null
}

export async function GET(request: NextRequest) {
  const context = await authorContext()
  if (!context) return jsonResponse({ error: 'not_authorized' }, 401)

  const answer = await readingGet(
    context.viewer,
    request.nextUrl.searchParams.get('book') ?? '',
  )
  return jsonResponse(answer.body, answer.status)
}

export async function POST(request: NextRequest) {
  const context = await authorContext()
  const token = await adminToken()
  if (!context || !token) return jsonResponse({ error: 'not_authorized' }, 401)

  let body: Body
  try {
    const parsed: unknown = await request.json()
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return jsonResponse({ error: 'bad_request' }, 400)
    }
    body = parsed as Body
  } catch {
    return jsonResponse({ error: 'bad_request' }, 400)
  }

  if (!(await adminCsrfTokenMatches(token, typeof body.csrf === 'string' ? body.csrf : null))) {
    return jsonResponse({ error: 'bad_csrf' }, 403)
  }

  try {
    const answer = await readingPost(context.viewer, body)
    return jsonResponse(answer.body, answer.status)
  } catch {
    console.error('[admin] reading write failed')
    return jsonResponse({ error: 'write_failed' }, 500)
  }
}

export async function DELETE(request: NextRequest) {
  const context = await authorContext()
  const token = await adminToken()
  if (!context || !token) return jsonResponse({ error: 'not_authorized' }, 401)

  const search = request.nextUrl.searchParams
  if (!(await adminCsrfTokenMatches(token, search.get('csrf')))) {
    return jsonResponse({ error: 'bad_csrf' }, 403)
  }

  try {
    const answer = await readingDelete(context.viewer, {
      bookSlug: search.get('book') ?? '',
      bookmarkId: search.get('bookmark'),
      annotationId: search.get('annotation'),
      noteId: search.get('note'),
    })
    return jsonResponse(answer.body, answer.status)
  } catch {
    console.error('[admin] reading delete failed')
    return jsonResponse({ error: 'write_failed' }, 500)
  }
}
