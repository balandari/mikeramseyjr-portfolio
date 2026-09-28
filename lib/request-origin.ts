/**
 * Whether a browser mutation came from this site, or from somewhere else.
 *
 * ## What the cookie does and does not do
 *
 * The reviewer session is `HttpOnly`, `SameSite=Lax` and scoped to `/review`
 * (`lib/reviewer-access.ts`). `SameSite=Lax` withholds the cookie from a
 * cross-**site** POST, which is why a forged submission from an unrelated
 * domain arrives unauthenticated and is refused with 401.
 *
 * `SameSite` is site-based. An origin is scheme, host **and** port, and a site
 * is the registrable domain: `https://anything.example.com` and
 * `https://reader.example.com` are two origins and one site. So a page on a
 * sibling subdomain -- a project on a shared host, a stale subdomain pointed
 * somewhere it should not be, anything at all that can serve HTML under the
 * same registrable domain -- is same-site, gets the cookie attached, and could
 * issue a credentialed `POST` that this endpoint accepted and acted on. CORS
 * does not help: it governs whether the attacker may *read* the answer, and by
 * the time the answer exists the write has happened.
 *
 * ## The check
 *
 * A mutation must carry an `Origin` header that is exactly one canonical
 * serialized origin -- `http` or `https`, a host, an optional non-default port,
 * and nothing else -- and whose scheme, host and effective port are all equal
 * to the request's own. Missing, `null`, malformed, more than one, carrying
 * credentials, a path, a query or a fragment, a different scheme, a different
 * host, a sibling subdomain or a different port: refused, before the body is
 * read and before anything is written.
 *
 * ## Where the request's own origin comes from
 *
 *   - **Scheme:** the parsed request URL. In Next 14.2 that URL is built by the
 *     framework, not by the client's `Origin`: on a Vercel build the server's
 *     config carries `experimental.trustHostHeader`, and the URL is
 *     `https://<Host><path>`; under `next start` it is the listener's scheme
 *     (`socket.encrypted`, or a proxy's `x-forwarded-proto`) with the bound
 *     address. This module reads only the result.
 *   - **Host and port:** the `Host` header, so `localhost`, a LAN address, a
 *     custom domain and an explicit port are all compared as the browser
 *     addressed them. The request URL's own authority is deliberately not used:
 *     under `next start -H 0.0.0.0` it names the bind address, which is the
 *     exact mistake `lib/same-origin-path.ts` records.
 *
 * `x-forwarded-host` and `x-forwarded-proto` are **not** read here as an
 * alternative equality source. A second source the comparison may pass on is
 * a second value somebody other than the browser gets to choose, and this
 * correction draws the boundary on the two values above alone.
 *
 * ## Why the request's own host is a trustworthy thing to compare against
 *
 * The threat is a **browser** that holds the victim's cookie and is made to
 * send a request by a page the attacker controls. In that request:
 *
 *   - `Origin` is set by the browser to the attacking page's origin. The
 *     attacker chooses the page, so the attacker chooses this value -- but only
 *     to something that is genuinely theirs. A page cannot claim an origin it is
 *     not served from.
 *
 *   - `Host` is set by the browser from the URL it was told to fetch, which is
 *     ours or the request does not reach us. `Host` is a forbidden header name:
 *     script cannot set it on `fetch` or `XMLHttpRequest`, and a form cannot
 *     express it at all.
 *
 * So for the request to arrive here with the victim's cookie, `Host` must name
 * this site; and for the attacking page to make `Origin` match it, the attacker
 * would have to be serving that page **from this site**, over the same scheme
 * and port, at which point there is nothing left for this check to defend.
 * That is what makes the equality meaningful: the two values have different
 * authors, and only one of them is the attacker's.
 *
 * A caller that is not a browser can of course forge both -- and gains nothing,
 * because it has no session cookie to forge. Cross-site request forgery is an
 * attack on a browser's willingness to attach credentials, not on the header.
 *
 * Deliberately dependency-free and server-only.
 */

if (typeof window !== 'undefined') {
  throw new Error(
    'lib/request-origin is server-only and must not be imported by a client component',
  )
}

/** A `Host` value: a name, an IPv4 address or a bracketed IPv6 address, and a port. */
const HOST_HEADER = /^(?:[a-z0-9_](?:[a-z0-9_.-]*[a-z0-9_])?|\[[0-9a-f:.]+\])(?::[0-9]{1,5})?$/i

/** The port a URL actually connects to, with the scheme's default filled in. */
function effectivePort(url: URL): string {
  if (url.port !== '') return url.port
  return url.protocol === 'https:' ? '443' : '80'
}

/**
 * The origin this request was addressed to: the request URL's scheme, and the
 * `Host` header's host and port. Null when either is missing or unusable,
 * which refuses the request.
 */
function addressedOrigin(request: Request): URL | null {
  let protocol: string
  try {
    protocol = new URL(request.url).protocol
  } catch {
    return null
  }
  if (protocol !== 'http:' && protocol !== 'https:') return null

  const host = request.headers.get('host')
  if (host === null || !HOST_HEADER.test(host)) return null
  try {
    const target = new URL(`${protocol}//${host}`)
    // The pattern already excludes these; asserted again on the parsed form so
    // nothing but a host and a port can have been read out of the header.
    if (target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
      return null
    }
    return target
  } catch {
    return null
  }
}

/**
 * True only when `Origin` is one canonical serialized origin whose scheme,
 * host and effective port all equal the request's own.
 *
 * Canonical means the header is character for character what a URL parser
 * serializes that origin as -- so a trailing slash, a path, a query, a
 * fragment, credentials, an explicit default port, upper case, surrounding
 * space and a list of several origins are all refused rather than parsed past.
 * A browser only ever sends the canonical form.
 */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get('origin')
  // A browser sends `Origin` on every cross-origin request and on every POST.
  // Absent means this is not a request this endpoint is willing to act on, and
  // absence is refused rather than read as reassurance. `null` is an opaque
  // origin -- a sandboxed frame, a `data:` page -- and names nobody.
  if (origin === null || origin === '' || origin === 'null') return false
  // More than one origin (a repeated header arrives comma-joined), or any
  // whitespace at all, is not one serialized origin.
  if (/[\s,]/.test(origin)) return false

  let supplied: URL
  try {
    supplied = new URL(origin)
  } catch {
    return false
  }
  if (supplied.protocol !== 'http:' && supplied.protocol !== 'https:') return false
  if (supplied.origin !== origin) return false

  const target = addressedOrigin(request)
  if (!target) return false

  return (
    supplied.protocol === target.protocol &&
    supplied.hostname === target.hostname &&
    effectivePort(supplied) === effectivePort(target)
  )
}
