import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

import next from 'next'

/*
 * Rendered-page smoke tests.
 *
 * Everything else in `tests/` exercises `lib/`. These serve the real production
 * build through Next's own request handler -- in-process, on an ephemeral port,
 * no child process -- and assert on the HTML a visitor would actually receive.
 * They exist because two defects in this project were caught by a person
 * looking at a page after every unit test had passed.
 *
 * They need a production build. Without one they are *skipped*, visibly, with
 * the reason -- never silently passed. Run `npm run build` first.
 */

const ROOT = process.cwd()
const built = existsSync(join(ROOT, '.next', 'BUILD_ID'))
const skip = built ? false : 'no production build in .next -- run `npm run build` first'

const PORTRAIT_ALT =
  'Mike Ramsey Jr — a bearded man in a rust-coloured T-shirt, looking straight at the camera, in front of a softly blurred window.'

/* Distinctive strings from the manuscript that must never reach a public page. */
const MANUSCRIPT = ['Shefali', 'Montu', 'galvanized bucket', 'chicken pot pie']

let server: Server | null = null
let base = ''
let app: ReturnType<typeof next> | null = null

async function get(path: string) {
  const res = await fetch(base + path, { redirect: 'manual' })
  return { status: res.status, headers: res.headers, html: await res.text() }
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

/* ------------------------------------------------------------- homepage */

test('the homepage presents the author, both books and the photograph', { skip }, async () => {
  const { status, html } = await get('/')
  assert.equal(status, 200)

  assert.match(html, /<h1[^>]*>Mike Ramsey Jr<\/h1>/)
  assert.ok(html.includes('I write fiction.'), 'the plain statement is present')
  assert.ok(html.includes('The Backward Becoming'))
  assert.ok(html.includes('PERSISTENT'))
  assert.ok(html.includes('href="/books/the-backward-becoming"'))
  assert.ok(html.includes('href="/books/persistent"'))

  // The invented tagline is gone, and stays gone.
  assert.ok(!html.includes('Ordinary lives'), 'no invented tagline')

  // The photograph, with its real alt text, and both sizes on offer.
  assert.ok(html.includes(`alt="${PORTRAIT_ALT}"`), 'portrait alt text is exact')
  assert.ok(html.includes('mike-ramsey-jr-480.jpg 480w'))
  assert.ok(html.includes('mike-ramsey-jr-960.jpg 960w'))

  // The shelf shows PERSISTENT's real cover, and nothing stands in for the
  // other title's missing one: exactly two images on the page -- the portrait
  // and that cover -- and the plate appears once, in the featured band.
  assert.ok(html.includes('ms-shelf-cover'), 'the shelf row carries the cover')
  assert.ok(html.includes('alt="Front cover of PERSISTENT by Mike Ramsey'))
  assert.equal((html.match(/<img /g) ?? []).length, 2, 'the portrait and one cover, no more')
  assert.equal((html.match(/class="ms-plate"/g) ?? []).length, 1, 'the plate appears once, in the featured band')

  // No motion system, no grain film.
  assert.ok(!html.includes('ms-reveal'))
  assert.ok(!html.includes('ms-rise'))
  assert.ok(!html.includes('ms-grain'))

  for (const s of MANUSCRIPT) assert.ok(!html.includes(s), `homepage must not contain "${s}"`)
})

/* ---------------------------------------------------------- book pages */

test('The Backward Becoming has a public page with its stage and the reviewer route', { skip }, async () => {
  const { status, html } = await get('/books/the-backward-becoming')
  assert.equal(status, 200)
  assert.match(html, /<h1[^>]*>The Backward Becoming<\/h1>/)
  assert.ok(html.includes('Work in progress'))
  assert.ok(html.includes('id="book-reviewers"'), 'the advance-reader band is present')
  assert.ok(html.includes('href="/review/login"'))
  // No cover art exists for this title, and none is invented for it.
  assert.ok(!html.includes('/covers/'), 'no cover file is referenced')
  assert.ok(!html.includes('ms-plate'), 'no typographic plate stands in on the book page')
  for (const s of MANUSCRIPT) assert.ok(!html.includes(s), `book page must not contain "${s}"`)
})

test('PERSISTENT has a public page and no reviewer-access invitation', { skip }, async () => {
  const { status, html } = await get('/books/persistent')
  assert.equal(status, 200)
  assert.match(html, /<h1[^>]*>PERSISTENT<\/h1>/)
  assert.ok(html.includes('Draft complete'))

  // Its canonical cover, with all three derivatives on offer and its alt text.
  assert.ok(html.includes('src="/covers/persistent-640.jpg"'))
  assert.ok(html.includes('/covers/persistent-320.jpg 320w'))
  assert.ok(html.includes('/covers/persistent-1000.jpg 1000w'))
  assert.ok(html.includes('alt="Front cover of PERSISTENT by Mike Ramsey'))
  assert.match(html, /property="og:image" content="[^"]*\/covers\/persistent-640\.jpg"/, 'the cover is the share image for this page')

  // The rule: nothing on this page invites anyone into the reader.
  assert.ok(!html.includes('id="book-reviewers"'), 'no advance-reader band')
  assert.ok(!html.includes('Reading it before'), 'no advance-reader heading')

  // The header and the footer carry the site-wide route on every page -- that
  // is chrome, and it is the same two links everywhere. The page itself must
  // add none. So: exactly the chrome's two on PERSISTENT, and one more on the
  // book that really is in advance reading.
  const count = (s: string) => (s.match(/href="\/review\/login"/g) ?? []).length
  assert.equal(count(html), 2, 'PERSISTENT carries only the chrome\'s two reviewer links')
  const { html: backward } = await get('/books/the-backward-becoming')
  assert.equal(count(backward), 3, 'the book in advance reading carries one more, its own')

  for (const s of MANUSCRIPT) assert.ok(!html.includes(s), `PERSISTENT page must not contain "${s}"`)
})

test('a slug that is not on the shelf is a 404', { skip }, async () => {
  const { status } = await get('/books/not-a-book')
  assert.equal(status, 404)
})

/* ----------------------------------------------------------- about page */

test('the About page carries the photograph with its alt text', { skip }, async () => {
  const { status, html } = await get('/about')
  assert.equal(status, 200)
  assert.ok(html.includes(`alt="${PORTRAIT_ALT}"`))
  assert.ok(html.includes('mailto:mike@mikeramseyjr.com'))
  for (const s of MANUSCRIPT) assert.ok(!html.includes(s))
})

/* ---------------------------------------------------------- share image */

test('the share image is advertised by the homepage and renders as a PNG', { skip }, async () => {
  // Next hashes the image route, so the only honest way to find it is the way
  // a platform would: read it off the page.
  const { html } = await get('/')
  const m = html.match(/<meta property="og:image" content="([^"]+)"/)
  assert.ok(m, 'the homepage advertises an og:image')
  const url = new URL(m[1])
  assert.equal(url.hostname, 'mikeramseyjr.com', 'the image URL is absolute, on the site\'s own domain')

  const res = await fetch(base + url.pathname)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /^image\/png/)
  const bytes = new Uint8Array(await res.arrayBuffer())
  assert.deepEqual(Array.from(bytes.slice(0, 4)), [0x89, 0x50, 0x4e, 0x47], 'PNG signature')
  assert.ok(bytes.length > 5_000, `the image has content (${bytes.length} bytes)`)
})

/* ------------------------------------------------------- reviewer gate */

test('the reviewer gate wears the public site and names no title', { skip }, async () => {
  const { status, headers, html } = await get('/review/login')
  assert.equal(status, 200)

  // Presentation: the gate, the author's name, the way back.
  assert.ok(html.includes('rv-gate'))
  assert.ok(html.includes('rv-root--gate'))
  assert.ok(html.includes('Mike Ramsey Jr'))
  assert.ok(html.includes('Back to mikeramseyjr.com'))
  assert.ok(!html.includes('rv-login-mark'), 'the app-icon mark is gone')

  // Mechanism, untouched.
  assert.ok(html.includes('action="/review/api/unlock"'))
  assert.ok(html.includes('method="post"'))
  assert.ok(html.includes('name="code"'))
  assert.ok(html.includes('name="next"'))
  assert.match(html, /placeholder="(?:•{4}-){3}•{4}"/, 'the placeholder shows four groups')
  assert.ok(html.includes('maxLength="64"') || html.includes('maxlength="64"'))

  // Nothing private before authentication -- in the body *or* the head. The
  // root layout's description and share text name the current book, and a page
  // inherits them unless it says otherwise; this one must say otherwise.
  for (const s of ['Backward', 'Becoming', 'PERSISTENT', 'Bangladesh', 'Calder', ...MANUSCRIPT]) {
    assert.ok(!html.includes(s), `gate must not contain "${s}" anywhere in the document`)
  }
  assert.match(
    html,
    /<meta name="description" content="A private edition for invited readers\."/,
    'the gate carries its own neutral description',
  )
  assert.ok(!/<meta name="keywords"/.test(html), 'no inherited keywords')

  // Still private to search engines.
  assert.match(html, /noindex/)
  assert.match(headers.get('cache-control') ?? '', /no-store/)
})

test('the gate shows its error and signed-out states with the right roles', { skip }, async () => {
  const bad = await get('/review/login?error=1')
  assert.ok(bad.html.includes('role="alert"'))
  assert.ok(bad.html.includes('That code was not recognised'))

  const out = await get('/review/login?signedout=1')
  assert.ok(out.html.includes('role="status"'))
  assert.ok(out.html.includes('signed out on this device'))
})

test('the reader itself still turns an unauthenticated visitor away', { skip }, async () => {
  const { status, headers } = await get('/review')
  assert.equal(status, 307)
  assert.match(headers.get('location') ?? '', /\/review\/login/)
})
