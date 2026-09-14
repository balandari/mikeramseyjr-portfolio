import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

import next from 'next'

/*
 * The onboarding routes, served by the real production build.
 *
 * These assert the properties that only exist once everything is wired
 * together: that the new pages are reachable without a session, that the
 * private area is still shut, that no page ever renders a credential, and that
 * every refusal is a refusal rather than a redirect a `fetch` would read as
 * success.
 *
 * They need a production build, and are visibly skipped without one -- the same
 * arrangement `tests/pages.test.ts` uses, and for the same reason: a silently
 * passing test is worse than an obviously skipped one.
 */

const ROOT = process.cwd()
const built = existsSync(join(ROOT, '.next', 'BUILD_ID'))
const skip = built ? false : 'no production build in .next -- run `npm run build` first'

/* Distinctive strings from the manuscript that must never reach a public page. */
const MANUSCRIPT = ['Shefali', 'Montu', 'galvanized bucket', 'chicken pot pie', 'Backward']

let server: Server | null = null
let base = ''
let app: ReturnType<typeof next> | null = null

async function get(path: string) {
  const res = await fetch(base + path, { redirect: 'manual' })
  return { status: res.status, headers: res.headers, html: await res.text() }
}

async function postForm(path: string, body: Record<string, string>) {
  const res = await fetch(base + path, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  })
  return { status: res.status, headers: res.headers, text: await res.text() }
}

test.before(async () => {
  if (skip) return
  app = next({ dev: false, dir: ROOT })
  await app.prepare()
  const handle = app.getRequestHandler()
  server = createServer((req, res) => void handle(req, res))
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  base = `http://127.0.0.1:${port}`
})

test.after(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  if (app) await app.close()
})

/* ------------------------------------------------------- the public doors */

test('the four onboarding pages open without a session', { skip }, async () => {
  for (const path of [
    '/review/request',
    '/review/activate',
    '/review/signin',
    '/review/signin/verify',
  ]) {
    const page = await get(path)
    assert.equal(page.status, 200, `${path} is reachable by somebody with no session`)
    assert.match(page.headers.get('x-robots-tag') ?? '', /noindex/)
    assert.match(page.headers.get('cache-control') ?? '', /no-store/)
    assert.equal(
      page.headers.get('referrer-policy'),
      'no-referrer',
      'the private area names itself to nowhere',
    )
  }
})

test('and the private area is still shut to exactly the same visitor', { skip }, async () => {
  for (const path of ['/review', '/review/my-reading', '/admin']) {
    const page = await get(path)
    assert.equal(page.status, 307, `${path} still turns an unauthenticated visitor away`)
  }
})

test('no onboarding page names a book, a reviewer, or a credential', { skip }, async () => {
  for (const path of [
    '/review/request',
    '/review/activate',
    '/review/signin',
    '/review/signin/verify',
  ]) {
    const page = await get(path)
    for (const secret of MANUSCRIPT) {
      assert.ok(!page.html.includes(secret), `${path} must not contain "${secret}"`)
    }
    // The credential arrives in the fragment, so the server has never seen one
    // and cannot have rendered one.
    assert.doesNotMatch(page.html, /[?&]token=/, `${path} renders no credential in a URL`)
    assert.doesNotMatch(page.html, /[?&]a=[A-Za-z0-9_-]{43}/)
  }
})

test('the request form asks for three things and hides its trap', { skip }, async () => {
  const page = await get('/review/request')
  assert.match(page.html, /name="name"/)
  assert.match(page.html, /name="email"/)
  assert.match(page.html, /name="message"/)
  assert.match(page.html, /name="website"/, 'the honeypot is present')
  assert.match(page.html, /rv-trap/, 'and it is off-screen rather than announced')
  assert.match(page.html, /action="\/review\/api\/request"/)
})

test('the gate offers both new doors', { skip }, async () => {
  const page = await get('/review/login')
  assert.match(page.html, /\/review\/request/)
  assert.match(page.html, /\/review\/signin/)
  // And still gives nothing away.
  for (const secret of MANUSCRIPT) {
    assert.ok(!page.html.includes(secret))
  }
})

/* ------------------------------------------------------------- refusals */

test('a bogus credential mints no session and says nothing useful', { skip }, async () => {
  const result = await postForm('/review/api/credential', {
    purpose: 'activation',
    token: 'x'.repeat(43),
  })

  assert.equal(result.status, 303)
  assert.match(result.headers.get('location') ?? '', /^\/review\/activate\?error=1$/)
  assert.equal(result.headers.get('set-cookie'), null, 'no cookie is ever set by a failure')
})

test('a bogus sign-in credential is refused the same way', { skip }, async () => {
  const result = await postForm('/review/api/credential', {
    purpose: 'signin',
    token: 'y'.repeat(43),
  })

  assert.equal(result.status, 303)
  assert.match(result.headers.get('location') ?? '', /^\/review\/signin\/verify\?error=1$/)
  assert.equal(result.headers.get('set-cookie'), null)
})

test('a submission with nothing in it is answered, not crashed', { skip }, async () => {
  const result = await postForm('/review/api/request', {})
  assert.equal(result.status, 303)
  assert.match(
    result.headers.get('location') ?? '',
    /^\/review\/request\?/,
    'it lands back on the form, whatever the store is doing',
  )
  assert.equal(result.headers.get('set-cookie'), null)
})

test('a sign-in submission never sets a cookie and never says who exists', { skip }, async () => {
  const result = await postForm('/review/api/signin', { email: 'nobody@example.com' })
  assert.equal(result.status, 303)
  assert.match(result.headers.get('location') ?? '', /^\/review\/signin\?/)
  assert.equal(result.headers.get('set-cookie'), null)
})

/* ------------------------------------------------------- the admin door */

test('the requests endpoint refuses an unauthenticated caller with 401', { skip }, async () => {
  const res = await fetch(base + '/admin/api/requests', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'approve', requestId: 'a'.repeat(24), books: [] }),
  })

  assert.equal(res.status, 401, 'a fetch gets an answer it can act on, not a page of HTML')
  const body = (await res.json()) as { error?: string }
  assert.equal(body.error, 'not_authorized')
})

test('and refuses a GET outright', { skip }, async () => {
  const res = await fetch(base + '/admin/api/requests', { redirect: 'manual' })
  assert.ok(res.status === 401 || res.status === 405, `no listing without a session: ${res.status}`)
})
