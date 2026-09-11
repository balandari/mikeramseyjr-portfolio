/**
 * Redirect-target hardening for the reviewer gate.
 *
 * The `next` value arrives from a query string or a form field, so it is
 * caller-controlled. Only a same-site path inside `/review` is ever honoured;
 * anything else -- an absolute URL, a protocol-relative `//host` path, a
 * backslash-obscured variant, or a path outside the reader -- collapses to the
 * reviewer's landing page. The gate can therefore never be turned into an open
 * redirect that sends someone from a trusted sign-in form to somewhere else.
 */
export function safeReviewPath(candidate: string | null | undefined): string {
  if (typeof candidate !== 'string' || candidate.length === 0) return '/review'

  // Reject anything that is not a plain, single-slash-rooted path.
  if (!candidate.startsWith('/')) return '/review'
  if (candidate.startsWith('//')) return '/review'
  if (candidate.includes('\\')) return '/review'
  if (candidate.includes('://')) return '/review'

  const path = candidate.split('?')[0].split('#')[0]

  if (path !== '/review' && !path.startsWith('/review/')) return '/review'

  // The sign-in flow is never a post-sign-in destination; it would bounce.
  if (path === '/review/login' || path.startsWith('/review/login/')) return '/review'
  if (path.startsWith('/review/api/')) return '/review'

  return path
}
