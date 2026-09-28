import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

import { readingDelete, readingGet, readingPost } from '@/lib/reading-api'
import { reviewerContext } from '@/lib/reading-session'
import { readBoundedJson, READING_JSON_LIMIT_BYTES } from '@/lib/request-bounds'
import { isSameOriginRequest } from '@/lib/request-origin'

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
 * ## Cross-origin requests
 *
 * The reviewer cookie is `SameSite=Lax` and scoped to `/review`, which keeps
 * it off a cross-**site** POST. That was the whole of the defence here, and it
 * was not enough: `SameSite` is site-based, so any page under the same
 * registrable domain -- a sibling subdomain -- is same-site, does get the
 * cookie attached, and could make this endpoint write. CORS would have let the
 * attacker be refused the *answer* long after the write had happened.
 *
 * `POST` therefore now requires two things of its own, both checked before the
 * body is read and before `readingPost` is called, so a rejected request makes
 * no store call at all:
 *
 *   - an `Origin` that is one canonical serialized origin with this request's
 *     exact scheme, host and effective port (`lib/request-origin.ts`, which
 *     sets out where each of those comes from and why they are worth comparing
 *     against);
 *   - `Content-Type: application/json`, and a body bounded before parsing
 *     (`lib/request-bounds.ts`).
 *
 * `GET` and `DELETE` are unchanged. This correction is scoped to the mutation
 * a credentialed simple POST can reach; `DELETE` is not a simple request, so a
 * browser must ask permission before sending one and this site never answers a
 * preflight.
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

  /*
   * Origin first: before the body is read, before it is parsed, and before any
   * service call. A request from a sibling origin is refused here having cost
   * one header comparison and having written nothing.
   */
  if (!isSameOriginRequest(request)) return jsonResponse({ error: 'forbidden_origin' }, 403)

  const bounded = await readBoundedJson(request, READING_JSON_LIMIT_BYTES)
  if (!bounded.ok) {
    if (bounded.reason === 'too-large') return jsonResponse({ error: 'too_large' }, 413)
    if (bounded.reason === 'unsupported-media-type') {
      return jsonResponse({ error: 'unsupported_media_type' }, 415)
    }
    return jsonResponse({ error: 'bad_request' }, 400)
  }

  const parsed = bounded.value
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return jsonResponse({ error: 'bad_request' }, 400)
  }
  const body = parsed as Record<string, unknown>

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
