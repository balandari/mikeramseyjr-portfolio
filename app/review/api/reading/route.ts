import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

import { readingDelete, readingGet, readingPost } from '@/lib/reading-api'
import { reviewerContext } from '@/lib/reading-session'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * A reviewer's own reading records: resume position, bookmarks, annotations.
 *
 * Identity is established here, from the signed cookie, against the live
 * roster -- never from the request body. A revoked reviewer, or one whose
 * access code has been rotated, is not a reviewer here even with a cookie that
 * has not yet expired, because `reviewerContext()` re-checks the roster on
 * every call rather than trusting the token's claims.
 *
 * Everything after identity is `lib/reading-api.ts`, which is the same code the
 * author's endpoint runs. Nothing about policy is decided in this file.
 *
 * ## Cross-site requests
 *
 * The reviewer cookie is `SameSite=Lax` and scoped to `/review`, so it is not
 * attached to a cross-site `POST` or `DELETE` at all -- which is what makes a
 * forged submission from another origin arrive unauthenticated and be refused
 * with 401. This endpoint additionally accepts only a JSON body, which a plain
 * cross-origin HTML form cannot produce. That is the same posture the existing
 * feedback endpoint has, deliberately unchanged.
 */

function jsonResponse(body: unknown, status: number) {
  const response = NextResponse.json(body, { status })
  response.headers.set(
    'Cache-Control',
    'private, no-store, no-cache, max-age=0, must-revalidate',
  )
  response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive')
  return response
}

export async function GET(request: NextRequest) {
  const context = await reviewerContext()
  if (!context) return jsonResponse({ error: 'not_authorized' }, 401)

  const answer = await readingGet(
    context.viewer,
    request.nextUrl.searchParams.get('book') ?? '',
  )
  return jsonResponse(answer.body, answer.status)
}

export async function POST(request: NextRequest) {
  const context = await reviewerContext()
  if (!context) return jsonResponse({ error: 'not_authorized' }, 401)

  let body: Record<string, unknown>
  try {
    const parsed: unknown = await request.json()
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
    body = parsed as Record<string, unknown>
  } catch {
    return jsonResponse({ error: 'bad_request' }, 400)
  }

  try {
    const answer = await readingPost(context.viewer, body)
    return jsonResponse(answer.body, answer.status)
  } catch {
    // A reviewer's note is never written to a log; only the failure is.
    console.error('[review] reading write failed')
    return jsonResponse({ error: 'write_failed' }, 500)
  }
}

export async function DELETE(request: NextRequest) {
  const context = await reviewerContext()
  if (!context) return jsonResponse({ error: 'not_authorized' }, 401)

  const search = request.nextUrl.searchParams
  try {
    const answer = await readingDelete(context.viewer, {
      bookSlug: search.get('book') ?? '',
      bookmarkId: search.get('bookmark'),
      annotationId: search.get('annotation'),
      noteId: search.get('note'),
      // The revision the browser rendered. Required for a note delete, and
      // judged in `readingDelete` rather than here, so both doors refuse an
      // unversioned delete identically.
      noteRevision: search.get('revision'),
    })
    return jsonResponse(answer.body, answer.status)
  } catch {
    console.error('[review] reading delete failed')
    return jsonResponse({ error: 'write_failed' }, 500)
  }
}
