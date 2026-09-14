import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { createHash } from 'node:crypto'
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

test('a body the handler did not write is unknown, and a refusal it did write is a refusal', async () => {
  const platform = await submitAdminMutation(
    '/admin/api/reviewers',
    {},
    { refusedFallback: REFUSED_FALLBACK, fetchImpl: respondWith(json({ error: 'gateway' }, 500)) },
  )
  assert.equal(platform.kind, 'unknown', 'a 500 with no ok:false is not a promise of anything')

  /*
   * `ok: false` is reserved for the refusals the handler composes itself, and
   * every one of them is a typed refusal raised *before* anything was written:
   * a conflict, a read-only driver, a bad request. This is one of those, quoted
   * as the handler writes it. The generic store-fault answer is deliberately
   * not of this shape any more -- see the lost-acknowledgement test below.
   */
  const handler = await submitAdminMutation(
    '/admin/api/reviewers',
    {},
    {
      refusedFallback: REFUSED_FALLBACK,
      fetchImpl: respondWith(
        json({ ok: false, error: 'The roster changed while you were editing it. Reload and try again.' }, 409),
      ),
    },
  )
  assert.equal(handler.kind, 'refused')
  assert.equal(
    handler.kind === 'refused' && handler.message,
    'The roster changed while you were editing it. Reload and try again.',
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

/* --------------------------------- the storage boundary, with a lost answer */

/*
 * The third way a committed change can be reported as a refusal, and the one
 * neither half above reaches: the **store** answers the write with a failure
 * after the write has landed.
 *
 * `lib/reviewer-roster.ts` awaits the conditional write and rethrows anything
 * that is not a conflict. A rejected acknowledgement is not evidence that the
 * object was not written -- the bytes can be in the store and only the answer
 * lost -- so the handler may not say "Nothing was changed" about it, and the
 * dashboard may not repeat that to Mike. Being told nothing happened is how
 * `create` is pressed again and the second code replaces the first.
 *
 * So this drives the real POST handler, the real `createReviewer`, the real
 * roster store and the real client transport, over a backend held in memory
 * that records the roster bytes it is handed and then rejects. Nothing here
 * reaches a network, a credential or a real store: `@vercel/blob` is resolved,
 * in this test process only, to a module that forwards to the object below.
 */

type StoredObjects = Map<string, string>

type RosterBlobDouble = {
  put(pathname: string, body: string, options: Record<string, unknown>): Promise<unknown>
  get(
    pathname: string,
    options: Record<string, unknown>,
  ): Promise<{ stream: string; blob: { etag: string } } | null>
  list(options: Record<string, unknown>): Promise<{ blobs: { pathname: string }[]; hasMore: boolean }>
}

declare global {
  // eslint-disable-next-line no-var
  var __rosterBlob: RosterBlobDouble | undefined
}

/** The write commits. The answer never comes back. */
function lostAcknowledgement(objects: StoredObjects): RosterBlobDouble {
  return {
    async put(pathname, body) {
      objects.set(pathname, body)
      // Deliberately not a precondition failure and not an "already exists":
      // those two are the only messages the backend is allowed to read as
      // "somebody else won". This one is a store that stopped answering.
      throw new Error('the store did not answer')
    },
    async get(pathname) {
      const body = objects.get(pathname)
      if (body === undefined) return null
      return { stream: body, blob: { etag: createHash('sha256').update(body, 'utf8').digest('hex') } }
    },
    async list() {
      return { blobs: [], hasMore: false }
    },
  }
}

const inlineModule = (source: string) =>
  `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`

const BLOB_DOUBLE_URL = inlineModule(`
export const put = (...args) => globalThis.__rosterBlob.put(...args)
export const get = (...args) => globalThis.__rosterBlob.get(...args)
export const list = (...args) => globalThis.__rosterBlob.list(...args)
export class BlobPreconditionFailedError extends Error {}
`)

/*
 * Registered here rather than in `tests/helpers/`, because it belongs to this
 * one test: nothing else in the suite drives the blob driver through a route
 * handler, and `node --test` gives each test file its own process. It is a
 * resolve-only hook, so every other specifier is untouched.
 */
register(
  inlineModule(`export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@vercel/blob') {
    return { url: ${JSON.stringify(BLOB_DOUBLE_URL)}, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}`),
)

test('a lost write acknowledgement is unknown to the dashboard, never a refusal', async () => {
  const roster = (await import(
    `${ROOT}lib/reviewer-roster.ts`
  )) as typeof import('../lib/reviewer-roster.ts')

  const objects: StoredObjects = new Map()
  globalThis.__rosterBlob = lostAcknowledgement(objects)

  const saved = {
    driver: process.env.REVIEWER_ROSTER_DRIVER,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  }
  process.env.REVIEWER_ROSTER_DRIVER = 'vercel-blob'
  // Never sent anywhere: the double below is what receives it.
  process.env.BLOB_READ_WRITE_TOKEN = 'blob-token-for-tests-only-not-a-real-one'
  roster.__resetRosterStore()

  try {
    const response = await asReviewers({
      action: 'create',
      name: 'Dara Lost',
      email: 'dara.lost@example.com',
      books: [],
    })
    const body = (await response.clone().json()) as Record<string, unknown>

    // The write landed. Read back through the real store over the same
    // backend -- exactly what the next request would see.
    const stored = await roster.createRosterStore().load()
    assert.equal(stored.reviewers.length, 1, 'the roster write never reached the store')
    assert.equal(stored.reviewers[0]?.email, 'dara.lost@example.com')

    assert.equal(response.status, 500)
    assert.equal(
      response.headers.get('Cache-Control'),
      'private, no-store, no-cache, max-age=0, must-revalidate',
      'the answer is still private and uncacheable',
    )

    // Neither a success nor a refusal: the handler does not know which it was.
    assert.equal('ok' in body, false, 'a lost answer must not be asserted either way')
    assert.equal('issued' in body, false, 'and it invents no code it cannot vouch for')
    const serialized = JSON.stringify(body)
    assert.equal(
      serialized.toLowerCase().includes('nothing was changed'),
      false,
      'the handler claimed nothing changed about a write that had already landed',
    )
    assert.equal(
      serialized.includes('the store did not answer'),
      false,
      'the underlying exception must not be forwarded to the browser',
    )

    // And what the dashboard makes of it, through the transport it really uses.
    const outcome = await submitAdminMutation(
      '/admin/api/reviewers',
      { action: 'create' },
      { refusedFallback: REFUSED_FALLBACK, fetchImpl: respondWith(response) },
    )

    assert.equal(outcome.kind, 'unknown', 'the dashboard was told a committed write was refused')
    assert.equal(outcome.kind === 'unknown' && outcome.message, UNKNOWN_OUTCOME)
    assert.match(UNKNOWN_OUTCOME, /reload/i, 'and it is told to reload before retrying')
  } finally {
    if (saved.driver === undefined) delete process.env.REVIEWER_ROSTER_DRIVER
    else process.env.REVIEWER_ROSTER_DRIVER = saved.driver
    if (saved.token === undefined) delete process.env.BLOB_READ_WRITE_TOKEN
    else process.env.BLOB_READ_WRITE_TOKEN = saved.token
    roster.__resetRosterStore()
    globalThis.__rosterBlob = undefined
  }
})
