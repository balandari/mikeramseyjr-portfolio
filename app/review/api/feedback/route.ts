import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

import {
  REVIEWER_COOKIE_NAME,
  reviewerMayRead,
} from '@/lib/reviewer-access'
import { authorizeReviewer } from '@/lib/reviewer-authorization'
import { findBook, findParagraph, findReleasedChapter } from '@/lib/manuscript'
import {
  FeedbackStorageUnavailableError,
  createFeedbackStore,
  normalizeComment,
  type FeedbackDraft,
} from '@/lib/reviewer-feedback'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Reviewer feedback: submit one comment, or read back your own.
 *
 * Attribution is established entirely on the server. The reviewer comes from
 * the signed cookie, never from the request body; the book and chapter are
 * re-resolved from the verified manuscript; and the quoted passage is copied
 * out of that manuscript by paragraph identifier rather than accepted from the
 * browser. The only thing this endpoint takes from the caller is which passage
 * they mean and what they wanted to say about it.
 *
 * That is what makes a stored row trustworthy: it cannot name a reviewer who
 * did not write it, a book that reviewer may not read, a chapter that is not
 * released, a paragraph that does not exist, or a passage the book does not
 * contain.
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

/** The signed-in reviewer for this request, or null. */
async function currentReviewer() {
  const store = await cookies()
  return authorizeReviewer(store.get(REVIEWER_COOKIE_NAME)?.value)
}

export async function POST(request: NextRequest) {
  const reviewer = await currentReviewer()
  if (!reviewer) {
    return jsonResponse({ error: 'not_authorized' }, 401)
  }

  let body: Record<string, unknown>
  try {
    const parsed: unknown = await request.json()
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
    body = parsed as Record<string, unknown>
  } catch {
    return jsonResponse({ error: 'bad_request' }, 400)
  }

  const bookSlug = typeof body.bookSlug === 'string' ? body.bookSlug : ''
  const chapterSlug = typeof body.chapterSlug === 'string' ? body.chapterSlug : ''

  // Entitlement first, and answered as "not found" rather than "forbidden": a
  // reviewer must not be able to discover which books exist by probing.
  if (!reviewerMayRead(reviewer, bookSlug)) {
    return jsonResponse({ error: 'not_found' }, 404)
  }

  const book = findBook(bookSlug)
  if (!book) return jsonResponse({ error: 'not_found' }, 404)

  /*
   * An author-only manuscript is not a reviewer's to comment on. Their
   * entitlements can no longer name one (`lib/reviewer-authorization.ts`), so
   * this is the second refusal rather than the first -- and the one that does
   * not assume the first ran. Same 404 as a book that is not here.
   */
  if (book.audience !== 'reviewers') return jsonResponse({ error: 'not_found' }, 404)

  const chapter = findReleasedChapter(book, chapterSlug)
  if (!chapter) return jsonResponse({ error: 'not_found' }, 404)

  const comment = normalizeComment(body.comment)
  if (comment === null) {
    return jsonResponse({ error: 'invalid_comment' }, 400)
  }

  const scope = body.scope === 'paragraph' ? 'paragraph' : 'chapter'

  let paragraphIdentifier: string | null = null
  let paragraphOrdinal: number | null = null
  let quote: string | null = null

  if (scope === 'paragraph') {
    const requested = typeof body.paragraphId === 'string' ? body.paragraphId : ''
    const paragraph = findParagraph(chapter, requested)
    if (!paragraph) {
      return jsonResponse({ error: 'unknown_paragraph' }, 400)
    }
    paragraphIdentifier = paragraph.id
    paragraphOrdinal = paragraph.ordinal
    // The passage is copied from the manuscript, not from the request.
    quote = paragraph.text
  }

  const draft: FeedbackDraft = {
    reviewerId: reviewer.id,
    bookSlug: book.slug,
    chapterSlug: chapter.slug,
    chapterNumber: chapter.number,
    scope,
    paragraphId: paragraphIdentifier,
    paragraphOrdinal,
    quote,
    comment,
  }

  try {
    const entry = await createFeedbackStore().add(draft)
    return jsonResponse({ ok: true, entry }, 201)
  } catch (error) {
    if (error instanceof FeedbackStorageUnavailableError) {
      // Say so plainly. A comment that was not stored is never reported as
      // stored, and is never quietly kept in the browser instead.
      return jsonResponse(
        {
          error: 'storage_unavailable',
          message:
            'Feedback storage is not configured on this deployment, so your comment was not saved.',
        },
        503,
      )
    }
    // The reviewer's words are never written to a log; only the failure is.
    console.error('[review] feedback write failed')
    return jsonResponse({ error: 'write_failed' }, 500)
  }
}

/**
 * This reviewer's own feedback for one book. Scoped to the signed-in reviewer
 * at the store boundary as well as here, so no request shape can widen it.
 */
export async function GET(request: NextRequest) {
  const reviewer = await currentReviewer()
  if (!reviewer) {
    return jsonResponse({ error: 'not_authorized' }, 401)
  }

  const bookSlug = request.nextUrl.searchParams.get('book') ?? ''
  if (!reviewerMayRead(reviewer, bookSlug)) {
    return jsonResponse({ error: 'not_found' }, 404)
  }

  const entries = await createFeedbackStore().listForReviewer(reviewer.id, bookSlug)
  return jsonResponse({ ok: true, entries }, 200)
}
