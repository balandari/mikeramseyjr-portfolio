/**
 * Just enough module resolution to import the author surfaces into a plain Node
 * test process.
 *
 * `tests/admin-route-boundary.test.ts` established the pattern and the reason:
 * a source-shaped assertion about a route handler is exactly the kind that
 * keeps passing while the thing it describes stops being true. So the real
 * handler and the real server components are imported and called.
 *
 * **One specifier is redirected**, and only one: `next/headers`, whose
 * `cookies()` and `headers()` read an async-local request store that only a
 * Next server creates. A test sets `globalThis.__adminCookies` and
 * `globalThis.__requestHeaders` to what it wants presented.
 *
 * Everything else is the shipped code running: the session check verifies a
 * genuinely minted token against the genuine secret, the CSRF check genuinely
 * derives and compares, the intent switch, the bounds, the metadata writes, the
 * export and the response headers are all real. `@/...`, `next/server` and
 * `next/navigation` resolve through `tests/loader.mjs`, which is already on the
 * chain.
 */

const DOUBLES = new URL('./author-route-doubles/', import.meta.url)

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'next/headers') {
    return nextResolve(new URL('next-headers.mjs', DOUBLES).href, context)
  }
  return nextResolve(specifier, context)
}
