/**
 * The real `lib/reviewer-requests.ts`, with one seam: `listRequests`.
 *
 * `/admin/api/requests` composes its post-commit reread out of
 * `loadRequestViews(await listRequests())`, so this is that route's reread, and
 * the same three behaviours -- stall, fail, answer -- are what a test needs to
 * drive it.
 *
 * `lib/reviewer-onboarding.ts` imports this module by its *relative* path, which
 * is not redirected, so every mutation the route performs goes on using the real
 * `listRequests` and the real everything else. Only the route's own reread is
 * replaceable.
 */
export * from '../../../lib/reviewer-requests.ts'

import { listRequests as real } from '../../../lib/reviewer-requests.ts'

export function listRequests(...args) {
  const override = globalThis.__adminListRequests
  return override ? override(...args) : real(...args)
}
