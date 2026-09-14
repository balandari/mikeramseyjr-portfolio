import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  REFRESH_DEADLINE_MS,
  REFRESH_FAILED,
  REFRESH_TIMED_OUT,
} from '../lib/admin-response.ts'
import {
  SESSION_ENDED,
  UNKNOWN_OUTCOME,
  submitAdminMutation,
} from '../app/admin/mutation-transport.ts'

/*
 * The two ends of the post-commit boundary, each exercised where it actually
 * lives.
 *
 * `tests/admin-post-commit.test.ts` covers the composer, and covers a reread
 * that *rejects*. Two holes were left, and both of them lose a credential:
 *
 *   1. A reread that never settles at all. `await refresh()` with no deadline
 *      holds the invocation open until the platform kills it, and a killed
 *      invocation sends nothing -- so the stall destroys the only plaintext
 *      copy of a code whose verifier is already on the roster. A reread that
 *      *fails* had been made survivable; a reread that never answers had not.
 *
 *   2. The browser saying "Nothing was changed" about a response it never got.
 *      A response can be lost after the write commits, and the tab is the one
 *      place that cannot tell the difference. Being told nothing happened is
 *      how Mike presses the button again and the second code replaces the
 *      first.
 *
 * The first is proved through the **real POST handlers**, imported and called,
 * against a real on-disk roster and real request records -- not by reading
 * their source. The second is proved through the **real client transport** the
 * dashboard sends every mutation with.
 */

/* ----------------------------------------------------- the real handlers */

register('./helpers/admin-route-hooks.mjs', import.meta.url)

const ADMIN = 'mike@example.com'
const ROOT = pathToFileURL(join(process.cwd(), '/')).href

let dir = ''
let token = ''
let csrf = ''
let reviewersPOST: (request: Request) => Promise<Response>
let requestsPOST: (request: Request) => Promise<Response>

type Jar = Record<string, string>
declare global {
  // eslint-disable-next-line no-var
  var __adminCookies: Jar | undefined
  // eslint-disable-next-line no-var
  var __adminLoadView: (() => Promise<unknown>) | undefined
  // eslint-disable-next-line no-var
  var __adminListRequests: (() => Promise<unknown>) | undefined
}

/** A reread that answers nothing, ever: the case with no deadline was fatal. */
const neverSettles = () => new Promise<never>(() => {})

test.before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'admin-route-boundary-'))

  process.env.ADMIN_AUTH_SECRET = 'admin-secret-for-tests-only-not-a-real-one'
  process.env.ADMIN_ALLOWED_EMAILS = ADMIN
  process.env.REVIEWER_AUTH_SECRET = 'reviewer-secret-for-tests-only-not-a-real-one'
  process.env.SITE_ORIGIN = 'https://example.test'
  process.env.AUTHOR_ALERT_EMAIL = ADMIN
  process.env.EMAIL_FROM = 'Test <test@example.test>'
  // One fs driver serves both the roster and the private store, so the
  // mutations below really write and really read.
  process.env.REVIEWER_ROSTER_DRIVER = 'fs'
  process.env.REVIEWER_ROSTER_DIR = dir

  const auth = (await import(`${ROOT}lib/admin-auth.ts`)) as typeof import('../lib/admin-auth.ts')
  const minted = await auth.mintAdminToken(ADMIN)
  assert.ok(minted, 'the test session could not be minted')
  token = minted
  const derived = await auth.adminCsrfToken(token)
  assert.ok(derived, 'the test CSRF token could not be derived')
  csrf = derived
  globalThis.__adminCookies = { [auth.ADMIN_COOKIE_NAME]: token }

  reviewersPOST = (await import(`${ROOT}app/admin/api/reviewers/route.ts`)).POST
  requestsPOST = (await import(`${ROOT}app/admin/api/requests/route.ts`)).POST
})

test.after(() => {
  globalThis.__adminCookies = undefined
  globalThis.__adminLoadView = undefined
  globalThis.__adminListRequests = undefined
  if (dir) rmSync(dir, { recursive: true, force: true })
})

test.afterEach(() => {
  globalThis.__adminLoadView = undefined
  globalThis.__adminListRequests = undefined
})

function post(
  handler: (request: Request) => Promise<Response>,
  body: Record<string, unknown>,
  path: string,
) {
  return handler(
    new Request(`https://example.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, csrf }),
    }) as never,
  )
}

const asReviewers = (body: Record<string, unknown>) =>
  post(reviewersPOST, body, '/admin/api/reviewers')
const asRequests = (body: Record<string, unknown>) =>
  post(requestsPOST, body, '/admin/api/requests')

test('the real reviewers handler returns a one-time code when the reread never settles', async () => {
  /*
   * The whole defect, end to end and unsimulated: the roster write commits to
   * disk, and the dashboard reread then hangs forever. Before the deadline this
   * call did not return at all -- on Vercel the invocation would be terminated
   * and no response would ever reach the browser, taking the only copy of the
   * code with it.
   */
  globalThis.__adminLoadView = neverSettles

  const started = Date.now()
  const response = await asReviewers({
    action: 'create',
    name: 'Anna Stalled',
    email: 'anna.stalled@example.com',
    books: [],
  })
  const elapsed = Date.now() - started
  const body = (await response.json()) as Record<string, unknown>

  assert.equal(response.status, 200, 'a committed mutation is not a failure')
  assert.equal(body.ok, true)
  assert.equal(body.refreshed, false)
  assert.equal(body.refreshError, REFRESH_TIMED_OUT, 'and it says why it is stale')
  assert.equal('view' in body, false, 'no half-built view is invented')

  const issued = body.issued as { code?: string } | null
  assert.ok(issued && typeof issued.code === 'string' && issued.code.length > 0)
  assert.ok(
    JSON.stringify(body).includes(issued.code as string),
    'the plaintext code is in the bytes of the answer the browser receives',
  )

  assert.ok(
    elapsed >= REFRESH_DEADLINE_MS - 250,
    `the deadline was not actually awaited (${elapsed}ms)`,
  )
  assert.ok(elapsed < REFRESH_DEADLINE_MS + 5_000, `the deadline did not bound it (${elapsed}ms)`)
})

test('the reviewer it created is really on the roster, stalled reread or not', async () => {
  // The committed half of the previous test, read back through the real module
  // rather than assumed from the response.
  const admin = (await import(
    `${ROOT}lib/reviewer-admin.ts`
  )) as typeof import('../lib/reviewer-admin.ts')
  const view = await admin.loadAdminView()
  assert.ok(view, 'the roster could not be read back')
  assert.ok(
    view.reviewers.some((reviewer) => reviewer.email === 'anna.stalled@example.com'),
    'the mutation that was reported as committed did commit',
  )
})

test('the real reviewers handler survives a reread that rejects', async () => {
  globalThis.__adminLoadView = async () => {
    throw new Error('the store could not be read')
  }

  const response = await asReviewers({
    action: 'create',
    name: 'Bea Broken',
    email: 'bea.broken@example.com',
    books: [],
  })
  const body = (await response.json()) as Record<string, unknown>

  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.refreshError, REFRESH_FAILED, 'a rejection is not a timeout')
  assert.ok((body.issued as { code?: string } | null)?.code)
})

test('a reviewer mutation that did not commit is still a plain refusal', async () => {
  /*
   * The other half of the contract, and the reason `refused` may still say
   * "Nothing was changed": when the handler refuses, nothing did change, and
   * saying so is a fact rather than a guess.
   */
  const response = await asReviewers({ action: 'rename', reviewerId: 'nobody', name: 'X' })
  const body = (await response.json()) as Record<string, unknown>

  assert.equal(body.ok, false)
  assert.ok(response.status >= 400)
  assert.equal('issued' in body, false)
})

test('the real requests handler returns a committed action when the reread never settles', async () => {
  const requests = (await import(
    `${ROOT}lib/reviewer-requests.ts`
  )) as typeof import('../lib/reviewer-requests.ts')

  const submitted = await requests.submitRequest({
    name: 'Carla Waiting',
    email: 'carla.waiting@example.com',
    message: 'I would like to read it.',
  })
  const requestId = submitted.request.id

  globalThis.__adminListRequests = neverSettles

  const started = Date.now()
  const response = await asRequests({ action: 'decline', requestId })
  const elapsed = Date.now() - started
  const body = (await response.json()) as Record<string, unknown>

  assert.equal(response.status, 200, 'the decline committed, so it is not a failure')
  assert.equal(body.ok, true)
  assert.equal(body.refreshed, false)
  assert.equal(body.refreshError, REFRESH_TIMED_OUT)
  assert.equal('requests' in body, false)
  assert.ok(
    elapsed >= REFRESH_DEADLINE_MS - 250 && elapsed < REFRESH_DEADLINE_MS + 5_000,
    `the requests reread was not bounded by the deadline (${elapsed}ms)`,
  )

  // And it really declined, which is what makes the success honest.
  const after = await requests.loadRequest(requestId)
  assert.equal(after?.status, 'declined')
})

test('an unauthenticated caller is refused by both handlers, before anything', async () => {
  const saved = globalThis.__adminCookies
  globalThis.__adminCookies = {}
  try {
    for (const [name, response] of [
      ['reviewers', await asReviewers({ action: 'create', name: 'X', email: 'x@example.com' })],
      ['requests', await asRequests({ action: 'decline', requestId: 'abc' })],
    ] as const) {
      assert.equal(response.status, 401, `${name} admitted an unauthenticated caller`)
      const body = (await response.json()) as Record<string, unknown>
      assert.equal(body.ok, false)
      assert.equal(body.error, 'not_authorized')
    }
  } finally {
    globalThis.__adminCookies = saved
  }
})

/* ------------------------------------------ the real browser transport */

/*
 * `app/admin/mutation-transport.ts` is what `Dashboard.tsx` sends every
 * mutation through. These drive it with the responses a lost answer actually
 * looks like, and assert the one thing it must never do: claim that nothing
 * changed when it cannot know.
 */

const REFUSED_FALLBACK = 'That could not be saved. Nothing was changed.'

function respondWith(response: Response | Error): typeof fetch {
  return (async () => {
    if (response instanceof Error) throw response
    return response
  }) as unknown as typeof fetch
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('a rejected fetch is unknown, never "nothing was changed"', async () => {
  const outcome = await submitAdminMutation(
    '/admin/api/reviewers',
    { action: 'create' },
    { refusedFallback: REFUSED_FALLBACK, fetchImpl: respondWith(new TypeError('Failed to fetch')) },
  )

  assert.equal(outcome.kind, 'unknown')
  assert.equal(outcome.kind === 'unknown' && outcome.message, UNKNOWN_OUTCOME)
  assert.ok(
    !UNKNOWN_OUTCOME.toLowerCase().includes('nothing was changed'),
    'the ambiguous wording must not assert that nothing changed',
  )
  assert.match(UNKNOWN_OUTCOME, /reload/i, 'and it must say to reload before retrying')
})

test('a response that is not JSON is unknown', async () => {
  // A truncated body, a proxy error page, an empty 200 -- all the same shape:
  // an answer nothing in the handler wrote.
  for (const response of [
    new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    new Response('', { status: 200 }),
    new Response('{"ok": tru', { status: 200, headers: { 'content-type': 'application/json' } }),
  ]) {
    const outcome = await submitAdminMutation(
      '/admin/api/reviewers',
      {},
      { refusedFallback: REFUSED_FALLBACK, fetchImpl: respondWith(response) },
    )
    assert.equal(outcome.kind, 'unknown', `status ${response.status} was not treated as unknown`)
  }
})

test('a 500 the handler did not write is unknown, and one it did write is a refusal', async () => {
  const platform = await submitAdminMutation(
    '/admin/api/reviewers',
    {},
    { refusedFallback: REFUSED_FALLBACK, fetchImpl: respondWith(json({ error: 'gateway' }, 500)) },
  )
  assert.equal(platform.kind, 'unknown', 'a 500 with no ok:false is not a promise of anything')

  const handler = await submitAdminMutation(
    '/admin/api/reviewers',
    {},
    {
      refusedFallback: REFUSED_FALLBACK,
      fetchImpl: respondWith(
        json({ ok: false, error: 'The roster could not be updated. Nothing was changed.' }, 500),
      ),
    },
  )
  assert.equal(handler.kind, 'refused')
  assert.equal(
    handler.kind === 'refused' && handler.message,
    'The roster could not be updated. Nothing was changed.',
    'the handler knows it did not commit, so its own words are kept',
  )
})

test('a committed mutation whose refresh was unavailable is a success, and says it is stale', async () => {
  const issued = { reviewerId: 'anna', name: 'Anna', code: 'ABCD-EFGH-JKMN' }
  const outcome = await submitAdminMutation(
    '/admin/api/reviewers',
    {},
    {
      refusedFallback: REFUSED_FALLBACK,
      fetchImpl: respondWith(
        json({ ok: true, issued, refreshed: false, refreshError: REFRESH_TIMED_OUT }),
      ),
    },
  )

  assert.equal(outcome.kind, 'ok')
  assert.equal(outcome.kind === 'ok' && outcome.refreshed, false)
  assert.deepEqual(
    outcome.kind === 'ok' ? outcome.payload.issued : null,
    issued,
    'the one-time code reaches the dashboard through the transport unchanged',
  )
})

test('a 401 is a refusal, because the session check happens before anything is touched', async () => {
  for (const response of [
    json({ ok: false, error: 'not_authorized' }, 401),
    new Response('', { status: 401 }),
  ]) {
    const outcome = await submitAdminMutation(
      '/admin/api/reviewers',
      {},
      { refusedFallback: REFUSED_FALLBACK, fetchImpl: respondWith(response) },
    )
    assert.equal(outcome.kind, 'refused')
    assert.equal(outcome.kind === 'refused' && outcome.message, SESSION_ENDED)
  }
})

test('the dashboard sends every mutation through this transport, and asserts nothing else', () => {
  const source = readFileSync(join(process.cwd(), 'app', 'admin', 'Dashboard.tsx'), 'utf8')

  assert.match(source, /submitAdminMutation\(\s*'\/admin\/api\/reviewers'/)
  assert.match(source, /submitAdminMutation\(\s*'\/admin\/api\/requests'/)

  // The two sentences the repair exists to delete: a claim about the server,
  // made where the server could not be heard.
  assert.ok(
    !source.includes('you may be offline. Nothing was changed.'),
    'the offline branch still asserts that nothing changed',
  )
  assert.ok(
    !/catch\s*\{\s*setError\(/.test(source),
    'a transport failure is still being turned into an error banner',
  )

  // And the stale sentence in the admin address hint, which said reviewers
  // never sign in with an email address. They do, once they have proved it.
  assert.ok(
    !source.includes('Reviewers sign in with their code, never with this'),
    'the dashboard still claims an address is never used to sign in',
  )
  assert.match(source, /they can sign in by email as well as with their code/)
})
