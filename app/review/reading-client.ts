/**
 * The browser's half of the reading API.
 *
 * One module, used by the reviewer's reader, the reviewer's workspace and the
 * author's reader, so that "how do I save a bookmark" has exactly one answer no
 * matter which of the three is asking. The only thing that differs between them
 * is the `endpoint` -- `/review/api/reading` or `/admin/api/reading` -- and, for
 * the author, a CSRF token that the server issued to that session.
 *
 * Nothing here decides anything. Every request is re-authorised on the server
 * from a signed cookie; if this file were replaced wholesale by an attacker's
 * version it could not reach a record it was not already entitled to, because
 * the endpoint never takes an owner from a request body.
 *
 * What it *does* take care of is honesty in the interface: a call that fails
 * returns a failure the caller must handle, rather than a cheerful default. A
 * bookmark that was not stored is never shown as stored.
 */

import type {
  ClientAnnotation,
  ClientBookmark,
  ClientPosition,
  Visibility,
} from '@/lib/reading-view'

// Re-exported so a component can import the record shapes and the calls that
// produce them from one place.
export type {
  ClientAnnotation,
  ClientBookmark,
  ClientPosition,
  Visibility,
  WorkspaceBook,
  WorkspaceFeedback,
} from '@/lib/reading-view'

/** Everything one reader has in one book, as the endpoint returns it. */
export type ReadingSnapshot = {
  position: ClientPosition | null
  bookmarks: ClientBookmark[]
  annotations: ClientAnnotation[]
}

/** Where to send reading requests, and what the session requires with them. */
export type ReadingEndpoint = {
  /** `/review/api/reading` or `/admin/api/reading`. */
  url: string
  /** Present for the author's endpoint, which requires it on every mutation. */
  csrf?: string
}

export type ReadingOutcome<T> = { ok: true; value: T } | { ok: false; message: string }

/**
 * Turn a response into an outcome with something a person can read.
 *
 * 503 is called out by name because it is the one failure that means "this was
 * genuinely not kept anywhere" -- the deployment has no durable store -- and
 * saying so plainly is the difference between a reviewer knowing to write their
 * note down elsewhere and losing it.
 */
async function outcome<T>(
  response: Response,
  pick: (body: Record<string, unknown>) => T,
): Promise<ReadingOutcome<T>> {
  if (response.ok) {
    try {
      const body = (await response.json()) as Record<string, unknown>
      return { ok: true, value: pick(body) }
    } catch {
      return { ok: false, message: 'That could not be read back. Please try again.' }
    }
  }

  if (response.status === 401) {
    return { ok: false, message: 'Your session has ended. Reload the page and sign in again.' }
  }
  if (response.status === 503) {
    return {
      ok: false,
      message:
        'Reading storage is not configured on this deployment, so that was NOT saved. Please let Mike know.',
    }
  }
  if (response.status === 404) {
    return { ok: false, message: 'That is no longer there.' }
  }
  return { ok: false, message: 'That could not be saved. Please try again.' }
}

async function send(
  endpoint: ReadingEndpoint,
  method: 'POST' | 'DELETE',
  payload: Record<string, unknown>,
  query?: Record<string, string>,
): Promise<Response> {
  if (method === 'DELETE') {
    const search = new URLSearchParams(query ?? {})
    if (endpoint.csrf) search.set('csrf', endpoint.csrf)
    return fetch(`${endpoint.url}?${search.toString()}`, {
      method,
      credentials: 'same-origin',
    })
  }

  return fetch(endpoint.url, {
    method,
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(endpoint.csrf ? { ...payload, csrf: endpoint.csrf } : payload),
  })
}

export async function fetchReading(
  endpoint: ReadingEndpoint,
  bookSlug: string,
): Promise<ReadingOutcome<ReadingSnapshot>> {
  const response = await fetch(
    `${endpoint.url}?book=${encodeURIComponent(bookSlug)}`,
    { credentials: 'same-origin' },
  )
  return outcome(response, (body) => ({
    position: (body.position ?? null) as ClientPosition | null,
    bookmarks: (body.bookmarks ?? []) as ClientBookmark[],
    annotations: (body.annotations ?? []) as ClientAnnotation[],
  }))
}

export async function saveBookmark(
  endpoint: ReadingEndpoint,
  passage: { bookSlug: string; chapterSlug: string; paragraphId: string },
): Promise<ReadingOutcome<ClientBookmark>> {
  const response = await send(endpoint, 'POST', { op: 'bookmark', ...passage })
  return outcome(response, (body) => body.bookmark as ClientBookmark)
}

export async function deleteBookmark(
  endpoint: ReadingEndpoint,
  bookSlug: string,
  id: string,
): Promise<ReadingOutcome<true>> {
  const response = await send(endpoint, 'DELETE', {}, { book: bookSlug, bookmark: id })
  return outcome(response, () => true as const)
}

export async function saveAnnotation(
  endpoint: ReadingEndpoint,
  input: {
    bookSlug: string
    chapterSlug: string
    paragraphId: string
    startOffset: number
    endOffset: number
    note: string | null
    visibility: Visibility
  },
): Promise<ReadingOutcome<ClientAnnotation>> {
  const response = await send(endpoint, 'POST', { op: 'annotate', ...input })
  return outcome(response, (body) => body.annotation as ClientAnnotation)
}

export async function updateAnnotationRecord(
  endpoint: ReadingEndpoint,
  bookSlug: string,
  id: string,
  changes: { note?: string | null; visibility?: Visibility },
): Promise<ReadingOutcome<ClientAnnotation>> {
  const response = await send(endpoint, 'POST', {
    op: 'annotation-update',
    bookSlug,
    id,
    ...changes,
  })
  return outcome(response, (body) => body.annotation as ClientAnnotation)
}

export async function deleteAnnotation(
  endpoint: ReadingEndpoint,
  bookSlug: string,
  id: string,
): Promise<ReadingOutcome<true>> {
  const response = await send(endpoint, 'DELETE', {}, { book: bookSlug, annotation: id })
  return outcome(response, () => true as const)
}

/**
 * Record the automatic reading position.
 *
 * Deliberately fire-and-forget, and deliberately silent: this is the one write
 * nobody asked for. A reviewer who loses their place because the network
 * hiccuped should not be shown an error about something they never did -- and
 * the next scroll will try again anyway.
 */
export async function savePositionQuietly(
  endpoint: ReadingEndpoint,
  passage: { bookSlug: string; chapterSlug: string; paragraphId: string | null },
): Promise<void> {
  try {
    await send(endpoint, 'POST', { op: 'position', ...passage })
  } catch {
    // See above.
  }
}

/**
 * The same write, for a page that is going away.
 *
 * `sendBeacon` hands the request to the browser to deliver after the page is
 * gone, which `fetch` cannot promise during `pagehide`. It is same-origin, so
 * the JSON content type needs no preflight. When it is unavailable, or refuses
 * (the queue is bounded), the ordinary write is used as the fallback rather
 * than the position being dropped.
 */
export function beaconPosition(
  endpoint: ReadingEndpoint,
  passage: { bookSlug: string; chapterSlug: string; paragraphId: string | null },
): void {
  const payload = JSON.stringify(
    endpoint.csrf
      ? { op: 'position', ...passage, csrf: endpoint.csrf }
      : { op: 'position', ...passage },
  )

  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([payload], { type: 'application/json' })
      if (navigator.sendBeacon(endpoint.url, blob)) return
    }
  } catch {
    // Fall through to the ordinary write.
  }

  void savePositionQuietly(endpoint, passage)
}
