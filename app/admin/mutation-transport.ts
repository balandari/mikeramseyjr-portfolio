/**
 * What the dashboard is allowed to say about a mutation it sent.
 *
 * ## The defect this exists to make impossible
 *
 * The server side of this boundary was repaired first: a committed mutation is
 * no longer reported as a refusal just because the dashboard reread failed, and
 * the reread is now bounded so it cannot swallow the whole invocation
 * (`lib/admin-response.ts`). That leaves the half the browser owns.
 *
 * The dashboard used to answer a rejected `fetch` -- or a response it could not
 * parse -- with:
 *
 *     "That could not be saved -- you may be offline. Nothing was changed."
 *
 * That sentence is a claim about the *server*, made from the one position that
 * cannot see it. A response can be lost after the write has committed: the
 * connection drops on the way back, a proxy truncates it, the invocation is
 * terminated after the store answered, the tab goes to sleep mid-flight. In
 * every one of those the roster changed and the browser was told it did not --
 * and for `create` and `replace-code`, being told to press the button again is
 * how the second code overwrites the first one nobody ever saw.
 *
 * So the three outcomes are kept apart, and the third one is named:
 *
 *   - **`ok`** -- the server answered, and said it committed.
 *   - **`refused`** -- the server answered, and said it did not commit. Only a
 *     refusal the *handler itself* composed counts: `ok: false` with an error
 *     string it wrote, or the session check it performs before touching
 *     anything. Those are the only two cases where "nothing was changed" is a
 *     fact rather than a guess.
 *   - **`unknown`** -- no usable answer arrived. It may have happened. Reload
 *     before retrying; never retry blind.
 *
 * A 500 whose body is the handler's own `{ ok: false, error }` is a refusal,
 * because that handler reaches it only when the mutation did not commit. A 500
 * with no such body -- a platform error page, a truncated stream, an empty
 * response -- is unknown, because nothing in it was written by the code that
 * would know.
 *
 * `app/admin/Dashboard.tsx` routes every mutation through here; it is a module
 * rather than a convention because the convention is what failed. Exercised
 * directly in `tests/admin-route-boundary.test.ts`.
 */

/** The one thing that must never be said when the answer did not arrive. */
export const UNKNOWN_OUTCOME =
  'The reply never arrived, so whether that went through is not known — it may ' +
  'already have been saved. Reload the page and check before trying it again.'

/** A session that ended: the handler refuses before it touches anything. */
export const SESSION_ENDED = 'Your session has ended. Reload the page and sign in again.'

export type MutationOutcome =
  /** The server answered and said it committed. `refreshed` false means stale. */
  | { kind: 'ok'; payload: Record<string, unknown>; refreshed: boolean }
  /** The server answered and said it did not commit. Nothing changed. */
  | { kind: 'refused'; message: string }
  /** No usable answer. It may have committed. Do not retry blind. */
  | { kind: 'unknown'; message: string }

type Json = Record<string, unknown>

/**
 * POST one admin mutation and classify what came back.
 *
 * `refusedFallback` is the wording used when the handler refused but sent no
 * error of its own to quote -- it is a statement that nothing changed, so it is
 * only ever reached from a refusal, never from an unknown.
 */
export async function submitAdminMutation(
  url: string,
  body: Record<string, unknown>,
  options: {
    refusedFallback: string
    fetchImpl?: typeof fetch
  },
): Promise<MutationOutcome> {
  const send = options.fetchImpl ?? fetch

  let response: Response
  try {
    response = await send(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    })
  } catch {
    // The request may have been delivered and answered; only the answer is
    // missing. Nothing here knows which, and nothing here may pretend to.
    return { kind: 'unknown', message: UNKNOWN_OUTCOME }
  }

  let payload: Json | null = null
  try {
    const parsed: unknown = await response.json()
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      payload = parsed as Json
    }
  } catch {
    payload = null
  }

  // The session check happens before the handler touches anything, so a 401 is
  // the one status that is a refusal on its own, body or no body.
  if (response.status === 401) return { kind: 'refused', message: SESSION_ENDED }

  if (payload === null) {
    // Unparseable, empty, or not an object: a body the handler did not write.
    return { kind: 'unknown', message: UNKNOWN_OUTCOME }
  }

  if (payload.ok === true) {
    return { kind: 'ok', payload, refreshed: payload.refreshed !== false }
  }

  if (payload.ok === false) {
    const error = typeof payload.error === 'string' ? payload.error : ''
    if (error === 'not_authorized') return { kind: 'refused', message: SESSION_ENDED }
    return { kind: 'refused', message: error === '' ? options.refusedFallback : error }
  }

  // `ok` is neither true nor false: not this handler's shape. Whatever produced
  // it did not see the mutation, so it cannot report on one.
  return { kind: 'unknown', message: UNKNOWN_OUTCOME }
}
