/**
 * One ordered, concurrency-limited map. Nothing else.
 *
 * ## Why this exists
 *
 * Three dashboard read loops each walked their objects one at a time: the forty
 * audit objects behind `listAudit`, every request record behind `listRequests`,
 * and the outstanding-activation check behind `loadRequestViews`. All three are
 * governed by the same 2,500 ms post-commit refresh deadline in
 * `lib/admin-response.ts`, and on 2026-09-14 the audit one was measured at
 * 3,746.7 / 3,342.2 / 3,770.0 ms against it.
 *
 * The individual reads were not slow — median 77.3 ms, minimum 71.1 ms, three
 * samples above 200 ms out of a hundred and twenty. Forty of them in a row is
 * simply forty round trips. So the correction is not a faster read, a cache, a
 * page size or a different store: it is to stop waiting for each one before
 * asking for the next.
 *
 * ## What it promises, and why each promise is load-bearing
 *
 *   **Never more than `limit` in flight.** A dashboard refresh must not turn
 *   into an unbounded fan-out against a shared store — that trades one failure
 *   mode for a worse one, and the worse one arrives under load. Eight is the
 *   authorised cap (`ORDERED_READ_CONCURRENCY`); the parameter exists so the
 *   bound is visible at every call site rather than hidden in here.
 *
 *   **Output order is input order, always.** Every caller sorts, slices or
 *   indexes its results afterwards, so a result array shuffled by whichever
 *   read happened to answer first would be a silent defect rather than a
 *   visible one. Results are written into their own slot by index; completion
 *   order is never observable.
 *
 *   **A rejection rejects.** This is deliberately *not* an `allSettled`: two of
 *   the three callers must propagate a storage failure rather than answer with
 *   a shorter list, because "the audit log is empty" and "who is waiting" are
 *   both wrong answers when the truth is "the store did not say". A caller that
 *   wants per-item tolerance catches inside its own `map` — which is exactly
 *   what `loadRequestViews` does, so one request's failure stays that request's
 *   failure.
 *
 * ## The one thing it does NOT do
 *
 * It does not reorder, batch, retry, cache, or parallelise anything a caller
 * did not hand it, and it must never be used for writes, mutations, credential
 * spending, mail, or compare-and-swap work. Those are ordered against each
 * other for reasons that have nothing to do with speed.
 */

/**
 * The authorised fan-out for a dashboard read loop.
 *
 * Exactly eight, and a constant rather than a literal so the three call sites
 * cannot drift apart from each other or from the runbook's V9 screen.
 */
export const ORDERED_READ_CONCURRENCY = 8

/**
 * Map `items` through `map`, at most `limit` at a time, answering in input
 * order.
 *
 * On a rejection no further work is started, the calls already in flight are
 * allowed to settle — an abandoned rejection is nobody's, and an unhandled one
 * takes the process down — and the rejection reported is the one from the
 * **lowest index** observed to fail. That last rule is what keeps the error a
 * caller sees identical to the error the serial loop it replaced would have
 * thrown, in the ordinary case where one read fails.
 */
export async function mapOrderedLimited<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('a concurrency limit must be a positive integer')
  }

  const results: R[] = new Array<R>(items.length)
  if (items.length === 0) return results

  let next = 0
  /*
   * A container rather than a nullable local: this is written from inside the
   * workers below, and `at < 0` reads as "nothing has failed" without asking
   * the type checker to reason about assignments it cannot see.
   */
  const failure: { at: number; error: unknown } = { at: -1, error: null }

  /**
   * One worker, taking the next unclaimed index until there is none left or a
   * failure has been recorded. It never rejects: a rejection is recorded and
   * the worker stops, so `Promise.all` below is only ever waiting for workers
   * to finish, never racing them.
   */
  const worker = async (): Promise<void> => {
    for (;;) {
      if (failure.at >= 0) return
      const index = next
      if (index >= items.length) return
      next += 1

      try {
        results[index] = await map(items[index], index)
      } catch (error) {
        if (failure.at < 0 || index < failure.at) {
          failure.at = index
          failure.error = error
        }
        return
      }
    }
  }

  const workers: Promise<void>[] = []
  for (let slot = 0; slot < Math.min(limit, items.length); slot += 1) workers.push(worker())
  await Promise.all(workers)

  if (failure.at >= 0) throw failure.error
  return results
}
