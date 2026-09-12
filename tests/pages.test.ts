import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest, type Server } from 'node:http'
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

  /*
   * On this page the photograph is held to the shelf's own cover measure, so it
   * cannot outrank the books it sits below. The cap lives in `.ms-portrait--home`
   * and the homepage is the only place that asks for it -- the About page keeps
   * the larger plate deliberately.
   */
  assert.ok(
    html.includes('ms-portrait ms-portrait--home'),
    'the homepage portrait is capped to a shelf cover',
  )
  assert.ok(
    html.includes('sizes="(min-width: 64rem) 10rem, (min-width: 30rem) 26vw, 6rem"'),
    'and asks the browser for a cover-sized file, not a 20rem one',
  )

  /*
   * An invited reader is told where to go and given the control, in the same
   * breath. The page used to send them to the footer to look for it, which is
   * an instruction to search rather than a way in.
   */
  assert.ok(
    !html.includes('the door is in the footer'),
    'the homepage no longer sends an invited reader hunting in the footer',
  )
  assert.ok(html.includes('Open advance reading'), 'the advance-reading action is on the page')
  assert.match(
    html,
    /<a[^>]+href="\/review"[^>]*class="ms-btn ms-btn--ghost"|<a[^>]+class="ms-btn ms-btn--ghost"[^>]*href="\/review"/,
    'and it is a real control pointing at /review, which routes by session',
  )

  /*
   * Every shelf row carries a cover frame, and every frame is the same box --
   * the real artwork in one, a compact typographic plate in the other. That is
   * what stops the one finished cover on this site from being the smallest
   * thing on the page while the stand-in is the largest.
   */
  assert.equal(
    (html.match(/class="ms-shelf-frame/g) ?? []).length,
    2,
    'both shelf rows carry a cover frame',
  )
  assert.ok(html.includes('ms-shelf-art'), 'the real cover is inside its frame')
  assert.ok(html.includes('ms-shelf-frame--plate'), 'the title without art gets a plate')
  assert.ok(html.includes('alt="Front cover of PERSISTENT by Mike Ramsey'))

  /*
   * Exactly five images, and this list is all of them: the portrait, the one
   * real cover, the medallion beside the introduction, and the simplified mark
   * in the header and in the footer.
   *
   * This used to assert two, which was the same guarantee when identity was
   * text only. The point of the count has not changed -- a plate is type, not
   * an image, so nothing has been invented to fill a shelf frame -- so the
   * count is restated rather than loosened, and each of the three new ones is
   * named below. A sixth image appearing here is still a failure.
   */
  assert.equal((html.match(/<img /g) ?? []).length, 5, 'five images, all of them named here')
  assert.equal(
    (html.match(/<img [^>]*\/covers\//g) ?? []).length,
    1,
    'exactly one image on the page is real cover artwork',
  )

  // The medallion: present, once, and asking for a file no larger than the
  // 240px the stylesheet will ever draw it at.
  assert.equal(
    (html.match(/class="ms-hero-mark"/g) ?? []).length,
    1,
    'the author medallion appears once, in the hero',
  )
  assert.ok(html.includes('/brand/logo-480.webp 480w'), 'the medallion offers its 2x file')
  assert.ok(html.includes('/brand/logo-320.png'), 'and a fallback for a browser without WebP')
  assert.ok(
    html.includes('sizes="(min-width: 75rem) 15rem, (min-width: 43.75rem) 20vw, 8.75rem"'),
    'the medallion is capped at 15rem, below the featured cover',
  )

  // The simplified mark, in the chrome and nowhere else on this page.
  assert.ok(html.includes('class="ms-wordmark-mark"'), 'the header carries the simplified mark')
  assert.ok(html.includes('class="ms-footer-mark"'), 'the footer carries the simplified mark')
  assert.equal(
    (html.match(/\/brand\/mark-96\.png"/g) ?? []).length,
    2,
    'the mark appears exactly twice: header and footer',
  )

  // The ceremonial logo never doubles as the interface mark, in either
  // direction. They are different files and they stay different files.
  assert.ok(!html.includes('logo-480.webp" class="ms-wordmark-mark'))
  assert.equal(
    (html.match(/class="ms-plate"/g) ?? []).length,
    1,
    'the large plate appears once, in the featured band',
  )

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

  // The cap is the homepage's alone. This page is about him, so the larger
  // plate stays; if the modifier ever leaks here, that is a regression.
  assert.ok(!html.includes('ms-portrait--home'), 'the About portrait is not capped')
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

/* -------------------------------------------------------- administration */

test('the dashboard turns an unauthenticated visitor away', { skip }, async () => {
  const { status, headers } = await get('/admin')
  assert.equal(status, 307)
  assert.match(headers.get('location') ?? '', /\/admin\/login/)
  // Never cached, never indexed -- even the redirect.
  assert.match(headers.get('cache-control') ?? '', /no-store/)
  assert.match(headers.get('x-robots-tag') ?? '', /noindex/)

  // The trailing-slash form normalises first, and then meets the same gate.
  // Next answers 308 to `/admin` before the middleware runs, so this asserts
  // the normalisation rather than pretending the boundary saw it.
  const slash = await get('/admin/')
  assert.equal(slash.status, 308)
  assert.match(slash.headers.get('location') ?? '', /\/admin$/)
})

test('the dashboard API refuses an unauthenticated caller with 401, not a page', { skip }, async () => {
  const res = await fetch(`${base}/admin/api/reviewers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'revoke', reviewerId: 'anna' }),
    redirect: 'manual',
  })
  // Redirecting a fetch to a sign-in page would hand it a 200 and some HTML,
  // which reads as success to everything except a human.
  assert.equal(res.status, 401)
  assert.equal((await res.json()).error, 'not_authorized')
})

test('the admin gate names no reviewer, no title and no address', { skip }, async () => {
  const { status, headers, html } = await get('/admin/login')
  assert.equal(status, 200)

  // It says who it is for, and offers exactly one way in. It used to be
  // headed "Reviewers", which is the one thing the person signing in here is
  // not; it is now "Author access" and nothing about what it authorises moved.
  assert.ok(html.includes('Author access'))
  assert.ok(!/<h1[^>]*>Reviewers<\/h1>/.test(html), 'the gate is not named after reviewers')
  assert.ok(html.includes('Sign in with the Google account'))

  // There is no password field here, and there never will be.
  assert.ok(!/type="password"/.test(html))

  // Nothing about the manuscripts, the shelf, or who is allowed in.
  for (const s of ['Backward', 'Becoming', 'PERSISTENT', 'Bangladesh', 'Calder', ...MANUSCRIPT]) {
    assert.ok(!html.includes(s), `the admin gate must not contain "${s}"`)
  }

  // No address anywhere in the document. Checked by shape rather than by
  // looking for a bare "@", which the inlined stylesheet's `@media` supplies.
  assert.equal(html.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g), null, 'an address reached the gate')

  assert.match(html, /noindex/)
  assert.match(headers.get('cache-control') ?? '', /no-store/)
})

test('the admin gate offers a way in only when there is one', { skip }, async () => {
  /*
   * Whether this environment has a Google client configured is not this test's
   * business -- a developer's `.env.local` may or may not, and asserting one
   * branch would make the suite depend on which. What must always hold is that
   * the two states are consistent: a sign-in button exists precisely when
   * sign-in could work, and the "not configured" notice appears precisely when
   * it could not. Never both, and never neither.
   */
  const { html } = await get('/admin/login')
  const hasButton = html.includes('action="/admin/api/auth/start"')
  const saysUnconfigured = html.includes('Administration is not configured')

  assert.notEqual(
    hasButton,
    saysUnconfigured,
    'the gate must either offer sign-in or say it is unconfigured, never both or neither',
  )
})

test('the admin gate explains a denied account without leaking who is allowed', { skip }, async () => {
  const { html } = await get('/admin/login?error=denied')
  assert.ok(html.includes('role="alert"'))
  assert.ok(html.includes('not an administrator of this site'))
  // It does not say which address would have worked.
  assert.equal(html.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g), null)
})

/* ------------------------------------------------------------- viewport */

test('every area ships the viewport that makes safe-area insets real', { skip }, async () => {
  // The reader's dock, its sheets and the gate's foot all pad themselves with
  // `env(safe-area-inset-*)`. Without `viewport-fit=cover` every one of those
  // resolves to 0px and the dock sits under the home indicator.
  for (const path of ['/', '/about', '/books/persistent', '/review/login', '/admin/login']) {
    const { html } = await get(path)
    const meta = html.match(/<meta name="viewport" content="([^"]+)"/)
    assert.ok(meta, `${path} has no viewport meta`)
    assert.match(meta[1], /viewport-fit=cover/, `${path} is missing viewport-fit=cover`)
    assert.match(meta[1], /width=device-width/, `${path} is missing width=device-width`)
    // Never `maximum-scale` or `user-scalable=no`: a reader must always be able
    // to pinch a page of prose larger.
    assert.ok(!/maximum-scale/.test(meta[1]), `${path} caps zoom`)
    assert.ok(!/user-scalable\s*=\s*no/.test(meta[1]), `${path} disables zoom`)
  }
})

/* ------------------------------------------------- redirects over a LAN host */

/**
 * A request with an arbitrary `Host`, the way a phone on the Wi-Fi sends one.
 *
 * `fetch` will not let a caller set `Host`, so this goes through `node:http`
 * directly. The host below is the address from Mike's own screenshot.
 */
const LAN_HOST = '192.168.1.111:3000'

function lanRequest(
  path: string,
  options: { method?: string; body?: string; contentType?: string; cookie?: string } = {},
): Promise<{ status: number; location: string | null }> {
  const { port } = server!.address() as AddressInfo
  const headers: Record<string, string> = { Host: LAN_HOST }
  if (options.contentType) headers['content-type'] = options.contentType
  if (options.body) headers['content-length'] = String(Buffer.byteLength(options.body))
  if (options.cookie) headers.cookie = options.cookie

  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers },
      (res) => {
        res.resume()
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, location: res.headers.location ?? null }),
        )
      },
    )
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

test('no redirect ever names an origin, over a LAN host', { skip }, async () => {
  /*
   * The regression. Opened from a phone at http://192.168.1.111:3000, a valid
   * access code used to redirect to http://0.0.0.0:3000/review -- the sign-in
   * succeeded and the destination did not exist. Every redirect on the site is
   * now relative, so it resolves against whatever origin actually reached the
   * server.
   */
  const cases = [
    { what: 'the reader, unauthenticated', res: await lanRequest('/review') },
    { what: 'a chapter, unauthenticated', res: await lanRequest('/review/the-backward-becoming/chapter-one') },
    { what: 'the dashboard, unauthenticated', res: await lanRequest('/admin') },
    {
      what: 'signing out of the reader',
      res: await lanRequest('/review/api/lock', { method: 'POST' }),
    },
    {
      what: 'signing out of the dashboard',
      res: await lanRequest('/admin/api/auth/signout', { method: 'POST' }),
    },
    {
      what: 'submitting a code',
      res: await lanRequest('/review/api/unlock', {
        method: 'POST',
        contentType: 'application/x-www-form-urlencoded',
        body: 'code=NOT-A-REAL-CODE-AT-ALL&next=%2Freview',
      }),
    },
  ]

  for (const { what, res } of cases) {
    assert.ok(res.status >= 300 && res.status < 400, `${what}: expected a redirect, got ${res.status}`)
    assert.ok(res.location, `${what}: no Location header`)

    // The failure, stated directly: nothing may ever be sent to the address the
    // server happens to be bound to.
    assert.ok(!res.location!.includes('0.0.0.0'), `${what}: Location points at 0.0.0.0`)

    /*
     * Two shapes are acceptable, and both keep the visitor on the origin they
     * arrived on. Route handlers answer relative and name no origin at all.
     * The boundary has to answer absolute -- Next's middleware adapter parses
     * `Location` into a URL and a relative one throws -- so it is required to
     * echo the request's own host rather than the server's bound address.
     */
    if (res.location!.startsWith('/')) {
      assert.ok(!res.location!.includes('://'), `${what}: relative Location names a scheme`)
      continue
    }

    const target = new URL(res.location!)
    assert.equal(target.host, LAN_HOST, `${what}: Location left the visitor's origin — ${res.location}`)
  }
})

test('a code submitted over a LAN host lands inside the reader', { skip }, async () => {
  // The exact flow from the phone: POST the form, and see where it is sent.
  const res = await lanRequest('/review/api/unlock', {
    method: 'POST',
    contentType: 'application/x-www-form-urlencoded',
    body: 'code=NOT-A-REAL-CODE-AT-ALL&next=%2Freview',
  })
  assert.equal(res.status, 303, 'a 303, so the POST is not replayed at the target')
  // An unknown code goes back to the gate, still relative, still generic.
  assert.ok(res.location!.startsWith('/review/login'))
})
