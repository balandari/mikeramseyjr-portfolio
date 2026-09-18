/**
 * `cookies()` and `headers()`, outside Next.
 *
 * The real ones read an async-local request store that only a Next server
 * creates. What the code then does with the values is entirely real:
 * `verifyAdminToken` verifies a genuinely minted token against the genuine
 * secret, `adminCsrfTokenMatches` genuinely derives and compares, and the
 * detail page's `Sec-Fetch-Dest` decision reads whatever the test presented.
 *
 * A test sets `globalThis.__adminCookies` and `globalThis.__requestHeaders`.
 * An unset `__requestHeaders` presents an empty header store, which is a real
 * request shape -- a client that sent no `Sec-Fetch-*` at all.
 */

export async function cookies() {
  const jar = globalThis.__adminCookies ?? {}
  return {
    get(name) {
      const value = jar[name]
      return typeof value === 'string' ? { name, value } : undefined
    },
  }
}

export async function headers() {
  const store = globalThis.__requestHeaders ?? {}
  return {
    get(name) {
      const value = store[String(name).toLowerCase()]
      return typeof value === 'string' ? value : null
    },
  }
}
