/**
 * Is this a path that can name nothing but this origin?
 *
 * Deliberately dependency-free -- it imports nothing at all -- so the same
 * function runs in the Edge request boundary, in Node route handlers, and
 * directly under `node --test` without a framework anywhere near it.
 *
 * It exists because of a real failure. Every redirect on this site used to be
 * built as `new URL(path, request.url)`, which produces an absolute `Location`
 * and is therefore only ever as correct as the origin it derives. With the
 * development server bound to all interfaces (`-H 0.0.0.0`), `request.url`
 * resolves to `http://0.0.0.0:3000/…`: a reviewer on a phone entered a valid
 * access code over `http://192.168.1.111:3000` and was redirected to
 * `http://0.0.0.0:3000/review`, which no device can connect to. The sign-in had
 * worked. The destination did not exist.
 *
 * The answer is to name no origin at all. HTTP has allowed a relative
 * `Location` since RFC 7231 §7.1.2, and browsers resolve it against the URL
 * that actually reached the server -- so one response is correct through
 * `localhost`, a LAN address, a `.local` hostname, a proxy, and the eventual
 * production domain, with nothing to configure.
 *
 * It also avoids the obvious alternative, which is worse: deriving an origin
 * from the `Host` or `X-Forwarded-Host` header means honouring a value the
 * *client* sent, and that is how host-header redirect poisoning works. A
 * relative `Location` cannot carry a destination off this origin, because it
 * never names one.
 *
 * What is still checked is the path itself. Callers pass values that have
 * already been through `safeReviewPath` or `safeAdminPath`; this is the second,
 * independent refusal, so a mistake upstream cannot turn a sign-in into an open
 * redirect.
 */
export function isSameOriginPath(candidate: string | null | undefined): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) return false
  // Must be rooted, or it resolves against the current directory.
  if (!candidate.startsWith('/')) return false
  // `//host/…` is protocol-relative and leaves the site.
  if (candidate.startsWith('//')) return false
  // Some browsers normalise a backslash into a separator, producing the above.
  if (candidate.includes('\\')) return false
  // An absolute URL by any other name.
  if (candidate.includes('://')) return false
  return true
}

/** The path, or the site root when it is not one this origin can serve. */
export function sameOriginPathOrRoot(candidate: string | null | undefined): string {
  return isSameOriginPath(candidate) ? (candidate as string) : '/'
}
