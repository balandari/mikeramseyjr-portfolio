/**
 * Just enough module resolution to import the real admin route handlers into a
 * plain Node test process.
 *
 * `tests/admin-post-commit.test.ts` proves the composer, and it proves it well;
 * what it cannot prove is that the handler around the composer behaves. Its
 * check that "the reread happens after the catch" reads the route's *source* --
 * and a source-shaped assertion is exactly the kind that keeps passing while
 * the thing it describes stops being true. The Judge said so: the tests
 * "exercise the response composer and inspect route source ordering; they do
 * not exercise the actual POST-handler/browser transport boundary."
 *
 * So the route modules are imported and called for real. Three specifiers stand
 * in the way of that in a bare Node process, and exactly three are redirected:
 *
 *   - `@/...`         -- the bundler alias, which Node has no opinion about.
 *   - `next/headers`  -- `cookies()` needs a request store only Next provides.
 *   - two `@/lib` modules that own the *reread*, so a test can make that reread
 *     stall, fail, or answer, without touching anything else.
 *
 * Everything else -- the session check, the CSRF check, the action switch, the
 * mutation itself, the `try`/`catch` boundary, the composition, the response
 * headers -- is the shipped code, running.
 *
 * `next/server` resolves on its own once the extension is supplied. Nothing
 * here is imported by the application or by the type check: hooks are `.mjs`,
 * loaded by `module.register()` from the test file that wants them, in that
 * file's own process.
 */

const ROOT = new URL('../../', import.meta.url)
const DOUBLES = new URL('./admin-route-doubles/', import.meta.url)

/** The two modules a test may replace, and the file that replaces each. */
const REDIRECTED = new Map([
  ['@/lib/reviewer-admin', 'reviewer-admin.mjs'],
  ['@/lib/reviewer-requests', 'reviewer-requests.mjs'],
  ['next/headers', 'next-headers.mjs'],
])

export async function resolve(specifier, context, nextResolve) {
  const double = REDIRECTED.get(specifier)
  if (double) return nextResolve(new URL(double, DOUBLES).href, context)

  if (specifier.startsWith('@/')) {
    return nextResolve(new URL(`${specifier.slice(2)}.ts`, ROOT).href, context)
  }

  // Node will not guess an extension for a package subpath the way a bundler
  // does; `next/server.js` is the same file `next/server` means everywhere else.
  if (specifier === 'next/server') return nextResolve('next/server.js', context)

  return nextResolve(specifier, context)
}
