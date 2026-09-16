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
 *        paragraph, a note past its limit, an invented visibility, an update
 *        that does not say which revision of a note it was written against.
 *   409  the note is there and it is yours, and what you were editing is not
 *        what is stored. Nothing was written. Distinct from all of the above on
 *        purpose: it is the only refusal here that a second look can resolve,
 *        and the only one a client must **not** retry.
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
import {
  createNote,
  deleteNote,
  listOwnNotes,
  updateNote,
  type NoteFailure,
  type ResolvedNote,
} from './note-service.ts'

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
export function serializeReading(
  reading: BookReading,
  notes: readonly ResolvedNote[] = [],
): Record<string, unknown> {
  return {
    bookSlug: reading.book.slug,
    position: reading.position,
    bookmarks: reading.bookmarks,
    annotations: reading.annotations,
    notes,
  }
}

export async function readingGet(viewer: Viewer, bookSlug: string): Promise<ApiAnswer> {
  const result = await loadBookReading(viewer, bookSlug)
  if (!result.ok) return refusal(result.reason)

  /*
   * Notes travel with the rest of one reader's material, from the same request,
   * because they are the same answer to the same question: what do I have in
   * this book. A second endpoint would be a second chance for the two to
   * disagree about what the reader is looking at.
   */
  const notes = await listOwnNotes(viewer, bookSlug)
  if (!notes.ok) return noteRefusal(notes.reason)

  return { status: 200, body: { ok: true, ...serializeReading(result.value, notes.value) } }
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
      paragraphOffset: body.paragraphOffset,
      device: body.device,
      sequence: body.sequence,
    })
    /*
     * `stale` says this particular save was not what put the place on record --
     * something newer from the same device already had. It is reported beside
     * the position rather than as a failure, because the reader's place *is*
     * kept; see `savePosition`. The position returned is always what is
     * actually stored, so a browser can settle its own pending state from it.
     */
    return result.ok
      ? {
          status: 200,
          body: { ok: true, position: result.value.position, stale: result.value.stale },
        }
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

  /*
   * The highlight shortcut, and the closed door beside it.
   *
   * `annotate` mints a bodyless highlight. The `note` on the request is passed
   * through only so `addAnnotation` can refuse it: absent or null succeeds and
   * is stored private, and anything else is a 400 with nothing written. The
   * legacy annotation body has exactly one remaining relationship with this
   * API, and it is being read back.
   */
  if (op === 'annotate') {
    const result = await addAnnotation(viewer, {
      bookSlug: body.bookSlug,
      chapterSlug: body.chapterSlug,
      paragraphId: body.paragraphId,
      startOffset: body.startOffset,
      endOffset: body.endOffset,
      note: 'note' in body ? body.note : undefined,
      visibility: body.visibility,
    })
    return result.ok
      ? { status: 201, body: { ok: true, annotation: result.value } }
      : refusal(result.reason)
  }

  if (op === 'annotation-update') {
    /*
     * A `note` on this request is refused by its *presence*, not by its value.
     * `null` is refused with the rest: erasing a stored body is a write to it,
     * and this operation no longer writes bodies at all. Sharing still changes.
     */
    if ('note' in body) return { status: 400, body: { error: 'invalid_request' } }

    const changes: { visibility?: unknown } = {}
    if ('visibility' in body) changes.visibility = body.visibility

    const result = await updateAnnotation(viewer, body.bookSlug, body.id, changes)
    return result.ok
      ? { status: 200, body: { ok: true, annotation: result.value } }
      : refusal(result.reason)
  }

  /*
   * The one composer's one save.
   *
   * Every new piece of writing arrives here, whatever its scope and whichever
   * reader sent it. There is no second write path for a comment, and no
   * operation that means "send this to Mike" as a separate act -- who may read
   * a note is a property of the note, set on this same request and changeable
   * afterwards by the person who wrote it.
   */
  if (op === 'note-create') {
    const result = await createNote(viewer, {
      bookSlug: body.bookSlug,
      scope: body.scope,
      chapterSlug: body.chapterSlug,
      paragraphId: body.paragraphId,
      startOffset: body.startOffset,
      endOffset: body.endOffset,
      body: body.body,
      visibility: body.visibility,
    })
    return result.ok
      ? { status: 201, body: { ok: true, note: result.value } }
      : noteRefusal(result.reason)
  }

  if (op === 'note-update') {
    const changes: {
      body?: unknown
      visibility?: unknown
      status?: unknown
      expectedRevision?: unknown
    } = {}
    if ('body' in body) changes.body = body.body
    if ('visibility' in body) changes.visibility = body.visibility
    if ('status' in body) changes.status = body.status
    /*
     * Passed through by presence, exactly as the fields above are, so that a
     * request which omits it reaches the service as "no expected revision"
     * rather than as some value this layer invented. The service refuses it.
     */
    if ('expectedRevision' in body) changes.expectedRevision = body.expectedRevision

    const result = await updateNote(viewer, body.bookSlug, body.id, changes)
    return result.ok
      ? { status: 200, body: { ok: true, note: result.value } }
      : noteRefusal(result.reason)
  }

  return { status: 400, body: { error: 'unknown_operation' } }
}

/**
 * A note failure, in the same vocabulary as every other reading failure.
 *
 * The two failure types are separate so that neither module has to import the
 * other's, and this is the one place that joins them. Three of the four cases
 * are shared and mean the same things by them; the fourth is `conflict`, which
 * only notes have, and which is answered here rather than being flattened into
 * one of the others on its way out.
 */
function noteRefusal(reason: NoteFailure): ApiAnswer {
  if (reason === 'conflict') {
    return {
      status: 409,
      body: {
        error: 'conflict',
        message:
          'This note has changed since it was loaded, so nothing was saved. Reload to see what it says now.',
      },
    }
  }
  return refusal(reason as ReadingFailure)
}

export async function readingDelete(
  viewer: Viewer,
  params: {
    bookSlug: string
    bookmarkId: string | null
    annotationId: string | null
    noteId?: string | null
  },
): Promise<ApiAnswer> {
  if (params.bookmarkId) {
    const result = await removeBookmark(viewer, params.bookSlug, params.bookmarkId)
    return result.ok ? { status: 200, body: { ok: true } } : refusal(result.reason)
  }

  if (params.annotationId) {
    const result = await removeAnnotation(viewer, params.bookSlug, params.annotationId)
    return result.ok ? { status: 200, body: { ok: true } } : refusal(result.reason)
  }

  if (params.noteId) {
    // Delete and retract are one act and one call. Nothing is kept behind.
    const result = await deleteNote(viewer, params.bookSlug, params.noteId)
    return result.ok ? { status: 200, body: { ok: true } } : noteRefusal(result.reason)
  }

  return { status: 400, body: { error: 'unknown_operation' } }
}
