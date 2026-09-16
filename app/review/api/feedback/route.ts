import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

import {
  REVIEWER_COOKIE_NAME,
  reviewerMayRead,
} from '@/lib/reviewer-access'
import { authorizeReviewer } from '@/lib/reviewer-authorization'
import { createFeedbackStore } from '@/lib/reviewer-feedback'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Earlier submitted comments: readable, and closed to new writing.
 *
 * This endpoint used to accept a comment. A comment was immutable the moment it
 * was submitted -- it could not be corrected, withdrawn, or made private, and
 * the reviewer who wrote it was never told that before they pressed Send. The
 * note contract (`lib/note-contract.ts`) replaced it with one record a reviewer
 * owns and can change their mind about, and there is now exactly one composer
 * and one save in the reader.
 *
 * **The old write is closed on the server, not merely hidden in the interface.**
 * Removing a button leaves the endpoint standing, and an endpoint that still
 * accepts an immutable comment from a hand-made request is still a second way
 * to write -- with none of the contract's guarantees and none of its controls.
 * `POST` therefore answers `405` with an `Allow` header naming what is left.
 *
 * **The read path is untouched.** Every row already stored stays exactly as it
 * was stored: nothing here rewrites, migrates, re-serialises or removes one.
 * Reviewers keep their history, the author keeps his inbox, and both surfaces
 * label these rows "Earlier submitted comments" so the retired model is never
 * mistaken for a note.
 */

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}) {
  const response = NextResponse.json(body, { status })
  response.headers.set(
    'Cache-Control',
    'private, no-store, no-cache, max-age=0, must-revalidate',
  )
  response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive')
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value)
  return response
}

/** The signed-in reviewer for this request, or null. */
async function currentReviewer() {
  const store = await cookies()
  return authorizeReviewer(store.get(REVIEWER_COOKIE_NAME)?.value)
}

/**
 * Refused, and said plainly.
 *
 * Not a 404 and not a silent success: a caller that still holds the old shape
 * -- an unreloaded tab, a saved script, somebody probing by hand -- is told
 * exactly what happened and what to do instead. `Allow: GET` is the machine
 * half of the same sentence.
 *
 * Nothing is read from the request. The body is not parsed, the reviewer is not
 * resolved, the manuscript is not consulted and the store is never opened, so
 * there is no path through this handler that can write a row.
 */
export async function POST() {
  return jsonResponse(
    {
      error: 'method_not_allowed',
      message:
        'Submitted comments have been replaced by notes. Reload the reader and write a note instead — you can edit it, change who can see it, or delete it afterwards.',
    },
    405,
    { Allow: 'GET' },
  )
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
