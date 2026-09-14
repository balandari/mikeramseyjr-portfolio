/**
 * `cookies()`, outside Next.
 *
 * The real one reads an async-local request store that only a Next server
 * creates. The handlers use it for exactly one thing -- fetching the admin
 * session cookie -- and everything they then do with that value is real:
 * `verifyAdminToken` verifies a genuinely minted token against the genuine
 * secret, and `adminCsrfTokenMatches` genuinely derives and compares.
 *
 * A test sets `globalThis.__adminCookies` to the jar it wants presented.
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
