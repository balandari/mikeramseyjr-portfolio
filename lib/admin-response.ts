/**
 * What an administrative mutation answers with, once it has already committed.
 *
 * ## The defect this exists to make impossible
 *
 * Both admin endpoints used to do this:
 *
 *     try {
 *       await theMutation()      // commits
 *       return await ok({...})   // ok() re-reads the whole dashboard
 *     } catch {
 *       return refuse('... Nothing was changed.', 500)
 *     }
 *
 * The dashboard reread lived *inside* the mutation's catch, so a transient
 * store failure on the reread -- after the write had landed -- produced a 500
 * saying **nothing was changed**. For `create` and `replace-code` that is the
 * worst possible lie: the verifier is already stored, the plaintext code exists
 * only in that response, and Mike is told to press the button again.
 *
 * So the two acts are separated here and the separation is a module rather than
 * a convention, because a convention is what failed:
 *
 *   1. **The committed result is authoritative.** It is placed in the response
 *      first, and nothing that happens afterwards can remove it or turn the
 *      response into a refusal.
 *   2. **The dashboard refresh is best effort.** It is attempted, it is allowed
 *      to fail, and its failure is *reported* -- never promoted into a failure
 *      of the mutation.
 *   3. **The two are distinguishable.** `ok: true` with `refreshed: false` means
 *      "it happened, and the view beside it is stale". A refusal still means,
 *      and now only means, "it did not happen".
 *   4. **The refresh has a deadline.** A reread that *rejects* was already
 *      survivable; a reread that never settles was not. `await refresh()` with
 *      no bound holds the invocation open until the platform terminates it, and
 *      a terminated invocation sends no response at all -- so a stall destroyed
 *      exactly what a rejection no longer could. The refresh is therefore raced
 *      against `REFRESH_DEADLINE_MS`, well below any function deadline, and an
 *      expiry is just another failed refresh: the committed result goes back
 *      with `refreshed: false`.
 *
 * Nothing here reads or writes storage itself: it takes the committed result and
 * a loader, and composes one body. That is what makes the exact post-commit
 * behaviour of both routes testable without a browser, a session or a build --
 * see `tests/admin-post-commit.test.ts`, and through the real POST handlers in
 * `tests/admin-route-boundary.test.ts`.
 */

import type { AdminView } from './reviewer-admin.ts'

/** A refresh that failed is named, briefly, and never with a store message. */
export const REFRESH_FAILED = 'view_unavailable'

/** A refresh that never answered. Distinguished only so the cause is legible. */
export const REFRESH_TIMED_OUT = 'view_timeout'

/**
 * How long a post-commit dashboard reread may take before it is abandoned.
 *
 * Short on purpose, and far below any serverless function deadline: by the time
 * this expires the response Mike is waiting for already exists and is already
 * correct, and every further second spent waiting for a view he can reload for
 * himself is a second the platform may decide to kill the invocation instead --
 * taking a one-time access code with it.
 *
 * The abandoned read is not cancelled. It is a read; letting it finish into
 * nothing costs nothing, and there is no write to leave half-done.
 */
export const REFRESH_DEADLINE_MS = 2_500

export type CommittedBody = Record<string, unknown> & {
  ok: true
  /** False when the mutation committed and the dashboard reread did not. */
  refreshed: boolean
}

/**
 * Compose the body for a mutation that has **already committed**.
 *
 * `committed` is whatever that operation produced and Mike may never be able to
 * see again -- a one-time plaintext access code, a mail delivery outcome. It is
 * spread into the body before the refresh is attempted and is never removed.
 *
 * `refresh` may reject, may return `null`, and may never settle at all. All
 * three are the same answer: the body still says `ok: true`, carries
 * `committed`, and reports `refreshed: false`. The third is why `deadlineMs`
 * exists -- an unbounded wait is the one failure that produces no response.
 */
async function afterCommit<T>(
  committed: Record<string, unknown>,
  refresh: () => Promise<T | null>,
  attach: (value: T) => Record<string, unknown>,
  deadlineMs: number = REFRESH_DEADLINE_MS,
): Promise<CommittedBody> {
  let value: T | null = null
  let expired = false

  try {
    const attempt = refresh()
    /*
     * The loser of this race is never awaited again, so its eventual rejection
     * would be nobody's: absorbed here, before the race, so an abandoned read
     * that fails later cannot take the process down after the response has
     * already gone.
     */
    const settled = Promise.resolve(attempt).then(
      (result) => ({ ok: true as const, result }),
      () => ({ ok: false as const, result: null }),
    )
    const answer = await Promise.race([settled, expiresIn(deadlineMs)])
    if (answer === DEADLINE) {
      expired = true
    } else if (answer.ok) {
      value = answer.result
    }
  } catch {
    // A loader that throws synchronously, before it ever returns a promise.
    value = null
  }

  if (expired) {
    return { ok: true, ...committed, refreshed: false, refreshError: REFRESH_TIMED_OUT }
  }

  if (value === null || value === undefined) {
    return { ok: true, ...committed, refreshed: false, refreshError: REFRESH_FAILED }
  }

  return { ok: true, ...committed, refreshed: true, ...attach(value) }
}

/** The value the race resolves to when the deadline wins. */
const DEADLINE = Symbol('refresh-deadline')

/**
 * A promise that resolves to `DEADLINE` after `ms`.
 *
 * The timer is unreferenced so that a refresh which answers promptly -- the
 * ordinary case, every time -- cannot hold a process open waiting for a timeout
 * nobody is going to need.
 */
function expiresIn(ms: number): Promise<typeof DEADLINE> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(DEADLINE), ms)
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      ;(timer as { unref: () => void }).unref()
    }
  })
}

/**
 * The reviewer dashboard's view, with the one field the browser must not be
 * given.
 *
 * `codeHash` is a keyed fingerprint and is not reversible, but the browser has
 * no use for it and the narrowest payload is the one that cannot leak.
 */
export function publicAdminView(view: AdminView): Record<string, unknown> {
  return {
    driver: view.driver,
    writable: view.writable,
    updatedAt: view.updatedAt,
    books: view.books,
    reviewers: view.reviewers.map((reviewer) => ({
      id: reviewer.id,
      name: reviewer.name,
      email: reviewer.email,
      books: reviewer.books,
      status: reviewer.status,
      createdAt: reviewer.createdAt,
      codeUpdatedAt: reviewer.codeUpdatedAt,
      lastAccessAt: reviewer.lastAccessAt,
      // Whether this address has been proved, and therefore whether email
      // sign-in is available to them. A timestamp, never a credential.
      emailVerifiedAt: reviewer.emailVerifiedAt,
      origin: reviewer.origin,
    })),
    audit: view.audit,
  }
}

/**
 * `/admin/api/reviewers`: the committed result, then the roster if it can be
 * read.
 */
export function reviewerMutationBody(
  committed: Record<string, unknown>,
  loadView: () => Promise<AdminView | null>,
  deadlineMs: number = REFRESH_DEADLINE_MS,
): Promise<CommittedBody> {
  return afterCommit(
    committed,
    loadView,
    (view) => ({ view: publicAdminView(view) }),
    deadlineMs,
  )
}

/**
 * `/admin/api/requests`: the committed result, then the requests if they can be
 * read.
 */
export function requestMutationBody<R>(
  committed: Record<string, unknown>,
  loadRequests: () => Promise<R[] | null>,
  deadlineMs: number = REFRESH_DEADLINE_MS,
): Promise<CommittedBody> {
  return afterCommit(committed, loadRequests, (requests) => ({ requests }), deadlineMs)
}
