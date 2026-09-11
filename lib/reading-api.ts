/**
 * The reading API's decisions, independent of which route family is asking.
 *
 * `/review/api/reading` and `/admin/api/reading` are two doors into the same
 * house. They differ in exactly two ways -- which cookie establishes identity,
 * and whether a CSRF token is also required -- and both of those are settled by
 * the route handler *before* it calls in here. Everything after that is
 * identical, so it is written once.
 *
 * This module answers with a plain `{ status, body }`. It builds no response,
 * sets no header and reads no cookie, which is what lets the two route handlers
 * keep their own caching and robots headers and still share every rule.
 *
 * The failure vocabulary is deliberately blunt:
 *
 *   404  this does not exist, or it is not yours, or you may not read that
 *        book. All three answer the same, because telling them apart would turn
 *        an identifier into a way to enumerate other people's notes.
 *   400  the request was understood and refused -- offsets that do not fit the
 *        paragraph, a note past its limit, an invented visibility.
 *   503  there is no durable store configured, so nothing was saved. Said
 *        plainly, never swallowed, and never replaced by writing to the browser.
 */

import {
  addAnnotation,
  addBookmark,
  loadBookReading,
  removeAnnotation,
  removeBookmark,
  savePosition,
  updateAnnotation,
  type BookReading,
  type ReadingFailure,
} from './reading-service.ts'
import type { Viewer } from './reading-access.ts'

if (typeof window !== 'undefined') {
  throw new Error(
    'lib/reading-api is server-only and must not be imported by a client component',
  )
}

export type ApiAnswer = { status: number; body: Record<string, unknown> }

function statusFor(reason: ReadingFailure): number {
  if (reason === 'invalid') return 400
  if (reason === 'storage-unavailable') return 503
  return 404
}

function refusal(reason: ReadingFailure): ApiAnswer {
  if (reason === 'storage-unavailable') {
    return {
      status: 503,
      body: {
        error: 'storage_unavailable',
        message:
          'Reading storage is not configured on this deployment, so that was not saved.',
      },
    }
  }
  return {
    status: statusFor(reason),
    body: { error: reason === 'invalid' ? 'invalid_request' : 'not_found' },
  }
}

/**
 * What the browser is given about a book: everything of the viewer's own, with
 * each anchor already re-checked against the manuscript as it is now.
 *
 * The whole record is returned, quotation included, because the viewer is the
 * person who wrote it and is already reading the book it quotes. What is never
 * returned is anybody else's record, or a storage pathname, or a token for a
 * link the viewer did not create.
 */
export function serializeReading(reading: BookReading): Record<string, unknown> {
  return {
    bookSlug: reading.book.slug,
    position: reading.position,
    bookmarks: reading.bookmarks,
    annotations: reading.annotations,
  }
}

export async function readingGet(viewer: Viewer, bookSlug: string): Promise<ApiAnswer> {
  const result = await loadBookReading(viewer, bookSlug)
  if (!result.ok) return refusal(result.reason)
  return { status: 200, body: { ok: true, ...serializeReading(result.value) } }
}

/**
 * Every mutation, dispatched on an explicit `op`.
 *
 * There is no default branch that guesses. An unrecognised operation is a 400,
 * because a request this endpoint does not understand must not be turned into
 * one it does.
 */
export async function readingPost(
  viewer: Viewer,
  body: Record<string, unknown>,
): Promise<ApiAnswer> {
  const op = typeof body.op === 'string' ? body.op : ''

  if (op === 'position') {
    const result = await savePosition(viewer, {
      bookSlug: body.bookSlug,
      chapterSlug: body.chapterSlug,
      paragraphId: body.paragraphId,
    })
    return result.ok
      ? { status: 200, body: { ok: true, position: result.value } }
      : refusal(result.reason)
  }

  if (op === 'bookmark') {
    const result = await addBookmark(viewer, {
      bookSlug: body.bookSlug,
      chapterSlug: body.chapterSlug,
      paragraphId: body.paragraphId,
    })
    return result.ok
      ? { status: 201, body: { ok: true, bookmark: result.value } }
      : refusal(result.reason)
  }

  if (op === 'annotate') {
    const result = await addAnnotation(viewer, {
      bookSlug: body.bookSlug,
      chapterSlug: body.chapterSlug,
      paragraphId: body.paragraphId,
      startOffset: body.startOffset,
      endOffset: body.endOffset,
      note: body.note,
      visibility: body.visibility,
    })
    return result.ok
      ? { status: 201, body: { ok: true, annotation: result.value } }
      : refusal(result.reason)
  }

  if (op === 'annotation-update') {
    const changes: { note?: unknown; visibility?: unknown } = {}
    if ('note' in body) changes.note = body.note
    if ('visibility' in body) changes.visibility = body.visibility

    const result = await updateAnnotation(viewer, body.bookSlug, body.id, changes)
    return result.ok
      ? { status: 200, body: { ok: true, annotation: result.value } }
      : refusal(result.reason)
  }

  return { status: 400, body: { error: 'unknown_operation' } }
}

export async function readingDelete(
  viewer: Viewer,
  params: { bookSlug: string; bookmarkId: string | null; annotationId: string | null },
): Promise<ApiAnswer> {
  if (params.bookmarkId) {
    const result = await removeBookmark(viewer, params.bookSlug, params.bookmarkId)
    return result.ok ? { status: 200, body: { ok: true } } : refusal(result.reason)
  }

  if (params.annotationId) {
    const result = await removeAnnotation(viewer, params.bookSlug, params.annotationId)
    return result.ok ? { status: 200, body: { ok: true } } : refusal(result.reason)
  }

  return { status: 400, body: { error: 'unknown_operation' } }
}
