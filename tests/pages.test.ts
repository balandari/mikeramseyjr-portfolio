import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
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
   * An invited reader is told where to go on the first screen, in the hero,
   * addressed to them by name. The page used to send them to the footer to look
   * for it (an instruction to search is not a way in), and then to an action in
   * the About section -- which was nearer, but was the last place on the page
   * anyone looks for a door and made a section about Mike be about two things.
   */
  assert.ok(
    !html.includes('the door is in the footer'),
    'the homepage no longer sends an invited reader hunting in the footer',
  )
  assert.ok(
    html.includes('Invited to read? Enter your reviewer code'),
    'the invited reader is addressed by name, in the hero',
  )
  assert.match(
    html,
    /<p class="ms-hero-invite"><a[^>]+href="\/review"/,
    'and it is a real link to /review, which routes by session, inside the hero',
  )

  /*
   * It is in the hero, not somewhere below it: the entrance has to be on the
   * first screen of a phone, and the ink band is that screen.
   */
  const heroEnd = html.indexOf('</section>')
  assert.ok(
    heroEnd > 0 && html.indexOf('ms-hero-invite') < heroEnd,
    'the invitation is inside the hero section, not after it',
  )

  /*
   * The About section is about Mike. The reviewer invitation and the "Open
   * advance reading" control that used to live in it are gone -- the door is in
   * the navigation, the hero, the current-book band and the footer instead.
   */
  assert.ok(
    !html.includes('Open advance reading'),
    'the ambiguous "Open advance reading" action is gone from the homepage',
  )
  assert.ok(
    !html.includes('you can open'),
    'the About section no longer invites advance readers',
  )
  assert.ok(
    html.includes('More about Mike, and how to reach him'),
    'the About section keeps its one way onward',
  )

  /*
   * The current book names the act rather than the destination, and stays
   * quiet beside "About this book".
   */
  assert.match(
    html,
    /<a class="ms-quiet"[^>]*href="\/review\/login"|<a[^>]+href="\/review\/login"[^>]*class="ms-quiet"/,
    'the current-book reviewer action is still the quiet one',
  )
  assert.ok(
    html.includes('Enter reviewer code'),
    'and it says "Enter reviewer code"',
  )
  assert.ok(
    !/>\s*Reviewer access\s*<\/a>/.test(html.slice(html.indexOf('ms-featured'), html.indexOf('shelf-title'))),
    'the current-book band no longer says "Reviewer access"',
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
   * The temporary cover is one thing rendered at two sizes, not two things.
   *
   * `.ms-plate` in the featured band and `.ms-shelf-frame--plate` on the shelf
   * are the same book and the same rule -- they share one declaration in
   * `app/globals.css`, which is what makes both of them ink. The failure this
   * guards is a second representation of The Backward Becoming appearing with
   * its own markup and its own colour, which is exactly how the two would
   * drift apart.
   */
  assert.equal(
    (html.match(/class="ms-plate"/g) ?? []).length,
    1,
    'the large temporary cover is rendered once',
  )
  /*
   * Matched on the full `class` attribute, not on the bare class name. The
   * stylesheet is inlined into this page, so a bare name is found in the CSS
   * as well as in the markup and every count comes out one too high.
   */
  assert.equal(
    (html.match(/class="ms-shelf-frame ms-shelf-frame--plate"/g) ?? []).length,
    1,
    'and the shelf-sized one exactly once -- the same book, not a third copy',
  )
  assert.ok(
    !html.includes('/covers/the-backward-becoming'),
    'The Backward Becoming has no artwork, so nothing pretends it does',
  )

  /*
   * Exactly five images: the portrait, the one real cover, the medallion
   * beside the introduction, and the simplified mark in the header and in the
   * footer.
   *
   * The count has moved as the hero changed and it is restated each time
   * rather than loosened, because the thing it protects has never changed: a
   * plate is type, not an image, so nothing is ever invented to fill a shelf
   * frame, and no decorative filler is ever added to a band to go with its
   * colour. A sixth image here is still a failure.
   *
   * The phone's stationary watermark is *not* among them and never can be --
   * it is painted by pseudo-elements, so it cannot be an `<img>`. Only the
   * desktop logo is an element, and that is the point: on a laptop the
   * medallion is content, with alt text, and on a phone the identity is a
   * decorative layer instead.
   */
  assert.equal((html.match(/<img /g) ?? []).length, 5, 'five images, all of them named here')
  assert.equal(
    (html.match(/<img [^>]*\/covers\//g) ?? []).length,
    1,
    'exactly one image on the page is real cover artwork',
  )

  /*
   * The hero medallion: the full artwork, once, and carrying its own name.
   *
   * This is the logo at full strength, not a watermark -- it is only ever
   * shown on the ink hero, where the medallion's own near-black field matches
   * the band. The stylesheet hides it below 52rem so it never reaches a phone,
   * where the stationary derivative carries the identity instead; that half is
   * asserted in the architecture test below, because a `display: none` leaves
   * no trace in the markup.
   */
  assert.equal(
    (html.match(/class="ms-hero-mark"/g) ?? []).length,
    1,
    'the medallion appears once, in the hero',
  )
  assert.ok(html.includes('/brand/logo-480.webp 480w'), 'as the full accepted artwork at 2x')
  assert.ok(html.includes('/brand/logo-320.png'), 'with a fallback for a browser without WebP')
  assert.ok(
    !html.includes('logo-light'),
    'and never a lightened cut of it -- the hero is ink, so none is needed',
  )
  assert.ok(
    html.includes('sizes="(min-width: 75rem) 15rem, (min-width: 43.75rem) 20vw, 8.75rem"'),
    'at the accepted sizing, which the stylesheet clamp has to agree with',
  )

  /*
   * The two grounds, and the order they come in.
   *
   * The homepage now states a hierarchy in colour: an ink introduction, then
   * the current book on warm tan. Both grounds are fixed rather than derived
   * from `--inv-*`, so the one failure worth pinning is the one a token system
   * makes easy -- the pair silently swapping under a dark system preference,
   * or the featured band drifting back to the relative `--inverse` and taking
   * the hierarchy with it.
   */
  const INK = '<section class="ms-hero ms-section--ink"'
  const TAN = '<section class="ms-section ms-section--paper"'
  assert.ok(html.includes(INK), 'the introduction is on the fixed ink ground')
  assert.ok(html.includes(TAN), 'and the featured book on the fixed tan one')
  assert.ok(
    !html.includes('<section class="ms-section ms-section--inverse"'),
    'neither homepage band uses the scheme-relative inverse ground any more',
  )
  assert.ok(
    html.indexOf(INK) < html.indexOf(TAN),
    'and they arrive in that order: black introduction, then tan book',
  )

  /*
   * The simplified mark, unchanged, in the chrome and nowhere else -- asserted
   * positively and by the exact file the browser is offered, so a change to
   * the hero cannot quietly take the accepted compact marks with it.
   */
  assert.ok(html.includes('class="ms-wordmark-mark"'), 'the header carries the simplified mark')
  assert.ok(html.includes('class="ms-footer-mark"'), 'the footer carries the simplified mark')
  assert.equal(
    (html.match(/\/brand\/mark-96\.png"/g) ?? []).length,
    2,
    'the mark appears exactly twice: header and footer',
  )

  // No motion system, no grain film.
  assert.ok(!html.includes('ms-reveal'))
  assert.ok(!html.includes('ms-rise'))
  assert.ok(!html.includes('ms-grain'))

  for (const s of MANUSCRIPT) assert.ok(!html.includes(s), `homepage must not contain "${s}"`)
})

/*
 * The watermark's architecture, read off the repository rather than a rendered
 * page -- because the things that make it work leave no trace in the markup.
 *
 * Four of them are load-bearing and each would fail silently:
 *
 *   - the *derivative* is what the page paints, never the medallion. The
 *     medallion is a brass ring around a black disc; a stationary layer
 *     crosses tan and cream, where that disc is a coin.
 *   - `clip-path` is what confines the fixed layer to its own surface. Swap it
 *     for `transform`, `filter` or `contain: paint` -- all of which "also
 *     clip" -- and the section becomes a containing block, the layer stops
 *     being viewport-anchored, and the whole effect quietly becomes a
 *     per-section badge.
 *   - `z-index: -1` is what keeps it behind every word, cover and photograph.
 *   - no animation, no transition, no script.
 *
 * Runs without a production build on purpose.
 */
test('the watermark is a derivative, clipped, behind content, and still', () => {
  for (const asset of ['logo-240.webp', 'logo-480.webp', 'logo-320.png']) {
    assert.ok(
      existsSync(join(ROOT, 'public', 'brand', asset)),
      `the full medallion artwork is retained: ${asset}`,
    )
  }
  for (const asset of ['watermark-light-1024.webp', 'watermark-dark-1024.webp']) {
    assert.ok(
      existsSync(join(ROOT, 'public', 'brand', asset)),
      `the watermark derivative is present: ${asset}`,
    )
  }
  assert.ok(
    existsSync(join(ROOT, 'scripts', 'brand', 'build_brand.py')),
    'and so is the generator that derives both',
  )

  const sources = readdirSync(ROOT, { recursive: true, encoding: 'utf8' })
    .filter((p) => /^(app|components)[\\/].*\.(tsx?|css)$/.test(p))
    .map(
      (p) =>
        [
          p.replace(/\\/g, '/'),
          /*
           * Normalised before comparison. On a checkout made with
           * `core.autocrlf=true` -- which is how this worktree is checked out
           * -- these sources are CRLF on disk, and a scan that compares raw
           * text misses any match the tooling wrote with LF.
           */
          readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n'),
        ] as const,
    )
  assert.ok(sources.length > 20, 'the source scan found the app and components trees')
  assert.deepEqual(
    sources.filter(([, text]) => text.includes('logo-light')).map(([p]) => p),
    [],
    'no lightened cut of the medallion was ever introduced',
  )

  assert.ok(
    existsSync(join(ROOT, 'components', 'site', 'AuthorLogo.tsx')),
    'the medallion component exists, because the desktop hero renders it',
  )
  assert.deepEqual(
    sources.filter(([, t]) => t.includes('from "@/components/site/AuthorLogo"')).map(([p]) => p),
    ['app/(site)/page.tsx'],
    'and it has exactly one consumer: the homepage hero',
  )

  const css = sources.find(([p]) => p === 'app/globals.css')?.[1] ?? ''
  const start = css.indexOf('/*\n * The homepage watermark')
  assert.ok(start > 0, 'the watermark rules are where this test expects them')
  const block = css.slice(start, css.indexOf('.ms-hero-title'))
  const decls = block.replace(/\/\*[\s\S]*?\*\//g, '')

  /*
   * Two treatments, split at 52rem, and the split itself is the thing worth
   * asserting -- because the failure mode is not a crash, it is both of them
   * being on at once, or the wrong artwork reaching the wrong surfaces.
   */
  const desktopAt = decls.indexOf('@media (min-width: 52rem)')
  assert.ok(desktopAt > 0, 'the treatments are split at a 52rem breakpoint')
  const phone = decls.slice(0, desktopAt)
  const desktop = decls.slice(desktopAt)

  // Below 52rem: the stationary derivative, on every surface.
  assert.ok(phone.includes('watermark-light-1024.webp'), 'the phone paints the light derivative')
  assert.ok(phone.includes('watermark-dark-1024.webp'), 'and the dark one')
  assert.ok(
    !phone.includes('/brand/logo-'),
    'and never the medallion itself, which would be a coin on tan and cream',
  )
  assert.ok(phone.includes('position: fixed'), 'its layer is anchored to the viewport')
  assert.ok(phone.includes('clip-path: inset(0)'), 'and confined to each surface by clip-path')
  assert.ok(
    !/transform:|contain:|filter:|backdrop-filter:/.test(phone),
    'and by nothing that would make a section a containing block for it',
  )
  assert.ok(phone.includes('z-index: -1'), 'it paints beneath the content of its surface')
  assert.ok(phone.includes('pointer-events: none'), 'and cannot intercept a tap or a click')

  // At 52rem and up: the stationary layer is removed and the hero shows the
  // logo instead -- the full artwork, full strength, as an element.
  assert.ok(
    desktop.includes('content: none'),
    'at 52rem the stationary layer is removed, not merely hidden',
  )
  assert.ok(
    !desktop.includes('watermark-light-1024.webp') &&
      !desktop.includes('watermark-dark-1024.webp'),
    'no derivative reaches any desktop surface',
  )
  assert.ok(
    desktop.includes('.ms-hero-mark') && /\.ms-hero-mark\s*\{\s*display: block/.test(desktop),
    'and the hero medallion is shown from 52rem up',
  )
  assert.ok(
    /\.ms-hero-mark\s*\{\s*display: none/.test(phone),
    'while below it the medallion is hidden, so a phone never gets two marks',
  )
  assert.ok(
    /width:\s*clamp\(8\.75rem, 20vw, 15rem\)/.test(desktop),
    'at the accepted sizing -- 140px at the low end, 240px from 1200px up',
  )
  assert.ok(
    !/opacity/.test(desktop),
    'and at full strength -- the logo is not faded, which is what made it a watermark',
  )

  assert.ok(
    !/animation|transition|@keyframes/.test(decls),
    'neither treatment animates -- no animation and no transition declared',
  )
  assert.ok(
    decls.includes('@media (prefers-reduced-motion: reduce)') &&
      /prefers-reduced-motion[\s\S]*position: absolute/.test(decls),
    'and a reader asking for stillness gets the phone layer travelling with the page',
  )

  const og = sources.find(([p]) => p === 'app/(site)/opengraph-image.tsx')?.[1] ?? ''
  assert.ok(og.includes('OG_MEDALLION'), 'the share image still draws the full dark medallion')
  assert.ok(
    (sources.find(([p]) => p === 'app/(site)/og-medallion.ts')?.[1] ?? '').includes(
      'data:image/png;base64,',
    ),
    'from the generated data URI, which is still there',
  )
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

test('the gate explains itself to somebody who was given only a code', { skip }, async () => {
  const { html } = await get('/review/login')

  // What it is, and the consistent name for it.
  assert.match(html, /<h1[^>]*>Reviewer access<\/h1>/, 'the heading is the site-wide name')
  assert.ok(html.includes('Private reading entrance'), 'it says what this door is')
  assert.ok(!html.includes('<h1>Advance reading</h1>'), 'the old descriptive heading is gone')

  // Whose code, what it opens, and what is remembered.
  assert.ok(html.includes('Enter the private code Mike sent you'), 'whose code, and where from')
  assert.ok(html.includes('open your reading area'), 'what the code opens')
  assert.ok(
    html.includes('books you') && html.includes('been invited to read'),
    'that it opens the books that reader was invited to read',
  )
  assert.ok(
    html.includes('progress will be remembered on this device'),
    'that progress is kept, and where',
  )

  // The field, the act, and the boundary.
  assert.ok(html.includes('Access code'), 'the field is labelled')
  assert.ok(html.includes('Enter reviewer code'), 'the button names the act')
  assert.ok(!html.includes('Open my reading'), 'the old button label is gone')
  assert.ok(
    html.includes('Advance reading is by invitation'),
    'invitation-only is stated on the page itself',
  )

  // The way out of a dead end, through the address that is already public.
  assert.ok(html.includes('mailto:mike@mikeramseyjr.com'), 'a lost code has somewhere to go')
  assert.match(html, /Lost your code, or it isn/, 'and it is named as that')

  /*
   * What a gate must never teach: the shape of a code, how one is checked, or
   * anything about who holds one. The placeholder is four dotted groups and
   * says nothing about the alphabet.
   */
  for (const leak of ['codeHash', 'REVIEWER_AUTH_SECRET', 'fingerprint', 'HMAC', 'roster']) {
    assert.ok(!html.includes(leak), `gate must not mention "${leak}"`)
  }
})

test('the header carries the reviewer door at every width it can', { skip }, async () => {
  const { html } = await get('/')

  /*
   * One link, one route, two labels. The full one is the site-wide name; the
   * compact one is what a phone header has room for. `aria-label` keeps the
   * accessible name the same at both widths, and "Review" is a prefix of it, so
   * the visible word is still contained in the name (WCAG 2.5.3).
   */
  assert.match(
    html,
    /<a[^>]+class="ms-nav-quiet"[^>]*aria-label="Reviewer access"|<a[^>]+aria-label="Reviewer access"[^>]*class="ms-nav-quiet"/,
    'the reviewer link names itself the same way at every width',
  )
  assert.ok(
    html.includes('<span class="ms-nav-label-full">Reviewer access</span>'),
    'the full label is present',
  )
  assert.ok(
    html.includes('<span class="ms-nav-label-compact">Review</span>'),
    'and so is the compact one',
  )
  assert.ok(
    'Reviewer access'.startsWith('Review'),
    'the compact label is contained in the accessible name',
  )
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
