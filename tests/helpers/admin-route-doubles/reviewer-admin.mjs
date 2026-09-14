/**
 * The real `lib/reviewer-admin.ts`, with one seam: `loadAdminView`.
 *
 * That function *is* the post-commit dashboard reread for
 * `/admin/api/reviewers`. Making it stall, fail or answer is how a test asks
 * the shipped handler the only question that matters here: when the roster
 * write has already committed, does the one-time access code still come back?
 *
 * Everything else -- `createReviewer`, `replaceReviewerCode`, the error classes
 * the route catches by identity -- is re-exported from the real module, so it
 * is the real module, and `instanceof` still works across the boundary.
 */
export * from '../../../lib/reviewer-admin.ts'

import { loadAdminView as real } from '../../../lib/reviewer-admin.ts'

export function loadAdminView(...args) {
  const override = globalThis.__adminLoadView
  return override ? override(...args) : real(...args)
}
