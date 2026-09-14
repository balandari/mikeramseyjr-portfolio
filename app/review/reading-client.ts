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
    // `no-store` as well as the endpoint's own `Cache-Control`, because this is
    // the one request whose entire purpose is to be newer than something the
    // page was already given. A reading position answered from any cache, at
    // any layer, is the defect this call exists to correct.
    { credentials: 'same-origin', cache: 'no-store' },
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

/** A place in a chapter: which paragraph, and how far through it. */
export type PositionPassage = {
  bookSlug: string
  chapterSlug: string
  paragraphId: string | null
  /** 0 to 1. Omitted at the top of a paragraph, and by older callers. */
  paragraphOffset?: number
  /**
   * This device, and this device's own counter for this save.
   *
   * Ordering only — `lib/reading-order.ts` says what the server does with
   * them, and why neither can ever be evidence of who is asking. Both are
   * optional: a save without them is the unordered, last-arrival-wins write
   * this endpoint has always accepted.
   */
  device?: string
  sequence?: number
}

/** What a position write is known to have done. Never a guess. */
export type PositionSaveResult =
  /** The server answered 2xx. The place is stored. */
  | 'stored'
  /** The server answered, and refused. The place is NOT stored. */
  | 'refused'
  /** No answer: offline, aborted, DNS, the tab went away mid-flight. */
  | 'unreachable'
  /** Handed to the browser to deliver as the page closes. Outcome unknowable. */
  | 'handed-off'

/**
 * Record the automatic reading position.
 *
 * Still quiet -- this is the one write nobody asked for, and a reviewer must
 * not be interrupted mid-sentence because a packet went missing. But quiet is
 * not the same as pretending.
 *
 * This used to `await` the request inside a `try` and return `void`, which
 * discarded two different things at once: a thrown network error *and* a
 * perfectly well-formed `401`, `500` or `503` saying the place had not been
 * stored. The caller could not tell a save from a refusal, so the interface
 * went on implying the place was kept when the server had said it was not.
 *
 * It now returns what actually happened and lets the caller decide what, if
 * anything, to say. `response.ok` is the only thing treated as success.
 */
export async function savePositionQuietly(
  endpoint: ReadingEndpoint,
  passage: PositionPassage,
): Promise<PositionSaveResult> {
  return (await savePosition(endpoint, passage)).result
}

/**
 * Everything the same write is known to have done.
 *
 * `savePositionQuietly` above answers the one question most callers have and is
 * left exactly as it was. This answers the three more a caller needs before it
 * can decide whether to try again:
 *
 *   **Is trying again worth anything?** A `401` will refuse identically for as
 *   long as the session stays ended, and a `400` will refuse identically
 *   forever; retrying either is a loop with no exit. A dropped connection or a
 *   `5xx` is the opposite — the very thing a second attempt is for. Conflating
 *   the two is how a client ends up hammering a refusal or abandoning a
 *   recoverable failure, and this is the distinction that stops both.
 *
 *   **Did this save put the place on record?** A save the server refused as
 *   older than one it already holds from this device is not an error and not a
 *   loss; `stale` says so, and the position it answers with is the newer one.
 *
 *   **What does the server hold now?** Returned whenever it said, so a browser
 *   can settle its own pending state against the record rather than against a
 *   guess.
 */
export type PositionSaveReport = {
  result: PositionSaveResult
  /** The HTTP status, or null when nothing was heard back. */
  status: number | null
  /** True when a later attempt could plausibly succeed. */
  retryable: boolean
  /** True when the server refused this as older than one it already had. */
  stale: boolean
  /** What the server says is on record, when it said. */
  position: ClientPosition | null
}

export async function savePosition(
  endpoint: ReadingEndpoint,
  passage: PositionPassage,
): Promise<PositionSaveReport> {
  let response: Response
  try {
    response = await send(endpoint, 'POST', { op: 'position', ...passage })
  } catch {
    // Never reached the server, or never got back. Unknown, so: not stored --
    // and worth another go, because nothing has refused anything.
    return { result: 'unreachable', status: null, retryable: true, stale: false, position: null }
  }

  if (!response.ok) {
    return {
      result: 'refused',
      status: response.status,
      /*
       * 5xx is the server failing at something it agreed to do, which is the
       * one refusal a second attempt can fix. 4xx is the server understanding
       * the request and declining it -- ended session, invented paragraph,
       * a book this reader may not read -- and every one of those will decline
       * the identical request identically.
       */
      retryable: response.status >= 500,
      stale: false,
      position: null,
    }
  }

  let stale = false
  let position: ClientPosition | null = null
  try {
    const body = (await response.json()) as Record<string, unknown>
    stale = body.stale === true
    position = (body.position ?? null) as ClientPosition | null
  } catch {
    // A 2xx with a body this cannot read is still a 2xx: the write happened.
    // Nothing more is claimed about it than that.
  }

  return { result: 'stored', status: response.status, retryable: false, stale, position }
}

/**
 * What is known about the last places handed to the network.
 *
 * Two questions that were being answered by one value, which is the whole of
 * the defect this separates:
 *
 *   `confirmed`  the server answered 2xx for this place. It is stored.
 *   `inFlight`   handed over, and no answer yet.
 *
 * A place that is neither is a place worth sending — including one that was
 * sent and failed. The old single "already written" flag was set the moment a
 * request *started*, so a refused or dropped save went on marking its place as
 * written, and every later opportunity to save it — the settle, the ceiling,
 * and the flush on the way out, which is the last one anybody gets — found
 * nothing to do. A failed save silently suppressed its own rescue.
 */
export type SaveGuard = {
  confirmed: string | null
  inFlight: string | null
}

export const NOTHING_SENT: SaveGuard = { confirmed: null, inFlight: null }

/** Whether this place is worth handing to the network. */
export function mayHandOver(key: string, guard: SaveGuard): boolean {
  return key !== guard.confirmed && key !== guard.inFlight
}

/**
 * The guard after an attempt has ended, whichever way it ended.
 *
 * `stored` confirms the place and releases the flight. Anything else releases
 * the flight and confirms nothing — so the place becomes sendable again, which
 * is exactly what a failure should leave behind.
 */
export function afterOutcome(guard: SaveGuard, key: string, stored: boolean): SaveGuard {
  return {
    confirmed: stored ? key : guard.confirmed,
    inFlight: guard.inFlight === key ? null : guard.inFlight,
  }
}

/** The guard once a place is known to be on record without this browser sending it. */
export function alreadyOnRecord(guard: SaveGuard, key: string): SaveGuard {
  return { confirmed: key, inFlight: guard.inFlight === key ? null : guard.inFlight }
}

/**
 * The same write, for a page that is going away.
 *
 * `sendBeacon` hands the request to the browser to deliver after the page is
 * gone, which `fetch` cannot promise during `pagehide`. It is same-origin, so
 * the JSON content type needs no preflight. When it is unavailable, or refuses
 * (the queue is bounded), the ordinary write is used as the fallback rather
 * than the position being dropped.
 *
 * **`true` from `sendBeacon` means queued, not stored.** The page is closing;
 * there is nobody left to tell if the server then refuses it. That is reported
 * honestly as `handed-off` and must never be shown to a reader as a save.
 */
export function beaconPosition(
  endpoint: ReadingEndpoint,
  passage: PositionPassage,
  /**
   * Told the outcome *only* when the fallback runs.
   *
   * The beacon proper can never report: the page is on its way out. The
   * fallback is an ordinary request and does know, and there are two moments
   * where the page survives to hear it -- a backgrounded tab that comes back,
   * and `pagehide` on a page the browser then restores. Reporting there is free
   * honesty; the alternative is a reader whose place was refused being told
   * nothing because the code assumed it was already gone.
   */
  report?: (report: PositionSaveReport) => void,
): PositionSaveResult {
  const payload = JSON.stringify(
    endpoint.csrf
      ? { op: 'position', ...passage, csrf: endpoint.csrf }
      : { op: 'position', ...passage },
  )

  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([payload], { type: 'application/json' })
      if (navigator.sendBeacon(endpoint.url, blob)) return 'handed-off'
    }
  } catch {
    // Fall through to the ordinary write.
  }

  void savePosition(endpoint, passage).then((outcome) => report?.(outcome))
  return 'handed-off'
}
