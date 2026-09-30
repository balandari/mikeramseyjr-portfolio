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
   * The author's-study treatment Mike approved supersedes the old cap that held
   * this photograph to a shelf cover's width: it is now larger, square and in a
   * fine brass frame of its own. `.ms-portrait--home` is still the homepage's
   * alone -- the About page keeps its own plate (see the About test).
   *
   * The sizing is asserted on the portrait itself, found by its class *and* its
   * alt text, so it cannot pass against another image's `sizes` -- the row
   * shelf's cover used to carry the identical string.
   */
  const portraitTags = html.match(/<img [^>]*>/g)?.filter((tag) => tag.includes(`alt="${PORTRAIT_ALT}"`)) ?? []
  assert.equal(portraitTags.length, 1, 'the homepage shows the photograph exactly once')
  const portraitTag = portraitTags[0]
  assert.ok(
    portraitTag.includes('class="ms-portrait ms-portrait--home"'),
    'that image is the homepage portrait',
  )
  assert.ok(
    portraitTag.includes('sizes="(min-width: 64rem) 20rem, (min-width: 44rem) 30vw, 12rem"'),
    "and it asks for the frame's width: 12rem on a phone, up to 20rem beside the text",
  )
  assert.ok(
    portraitTag.includes('mike-ramsey-jr-480.jpg 480w') && portraitTag.includes('mike-ramsey-jr-960.jpg 960w'),
    'with both real sizes of the photograph on offer',
  )
  assert.match(
    html,
    /<div class="ms-study-portrait"><img [^>]*alt="Mike Ramsey Jr — a bearded man/,
    'inside the brass frame',
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
   * On the homepage the shelf is the author's-study showcase: each title a
   * book on its ledge, then its words, one link to its page as before. Both
   * frames stand inside the same book wrapper, so the real cover and the
   * stand-in keep equal standing; the real cover asks for the showcase's
   * width and is still one whole, unwrapped image.
   */
  assert.equal((html.match(/<ul class="ms-shelf ms-shelf--showcase">/g) ?? []).length, 1, 'the homepage shelf is the showcase')
  assert.equal(
    (html.match(/<div class="ms-shelf-plinth"><span class="ms-study-book ms-study-book--shelf"><span class="ms-shelf-frame/g) ?? []).length,
    2,
    'both titles stand as books of the same kind, frame inside book inside plinth',
  )
  assert.match(
    html,
    /<img [^>]*class="ms-shelf-art"[^>]*sizes="\(min-width: 89rem\) 16rem, \(min-width: 52rem\) 18vw, 9\.5rem"|<img [^>]*sizes="\(min-width: 89rem\) 16rem, \(min-width: 52rem\) 18vw, 9\.5rem"[^>]*class="ms-shelf-art"/,
    'the real cover asks for the showcase width',
  )
  assert.match(
    html,
    /<span class="ms-study-book ms-study-book--featured"><div class="ms-plate" aria-hidden="true">/,
    'the current book is the same plate, drawn as a book',
  )
  for (const status of ['Work in progress', 'Draft complete']) {
    assert.ok(
      (html.match(new RegExp(`<span class="ms-badge"><span class="ms-badge-dot" aria-hidden="true"></span>${status}</span>`, 'g')) ?? []).length >= 1,
      `the "${status}" stage is still shown as a badge`,
    )
  }

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
   * Exactly five images: the portrait, the one real cover, the art-directed
   * hero scene, and the simplified mark in the header and in the footer.
   *
   * The count has moved as the hero changed and it is restated each time
   * rather than loosened, because the thing it protects has never changed: a
   * plate is type, not an image, so nothing is ever invented to fill a shelf
   * frame. A sixth image here is still a failure.
   *
   * The hero scene is decorative and therefore has an empty alt; the author
   * name and every action remain real content above it. `<picture>` swaps the
   * source, so desktop and mobile never become two image elements.
   *
   * Beside the scene there is now exactly one other decorative layer, and it
   * is named here: the desktop-only left manuscript texture
   * (`hero-v02-left-texture.webp`, Mike's chosen hybrid hero). It is a CSS
   * background on an empty, `aria-hidden` element, not an image element, so
   * it leaves this count at five. No other decorative image is added beside
   * the scene.
   */
  assert.equal((html.match(/<img /g) ?? []).length, 5, 'five images, all of them named here')
  assert.equal(
    (html.match(/<div class="ms-hero-texture" aria-hidden="true"><\/div>/g) ?? []).length,
    1,
    'the one texture layer is an empty decorative element in the hero, not an image',
  )
  assert.ok(
    !/<img [^>]*hero-v02/.test(html),
    'and the texture never becomes an image element',
  )
  assert.equal(
    (html.match(/<img [^>]*\/covers\//g) ?? []).length,
    1,
    'exactly one image on the page is real cover artwork',
  )

  /* The hero uses one art-directed picture with a mobile source, not two imgs. */
  assert.equal(
    (html.match(/class="ms-hero-art"/g) ?? []).length,
    1,
    'the art-directed scene appears once, in the hero',
  )
  assert.ok(
    html.includes('mobile-hero-v01.png') && html.includes('hero-v01.png'),
    'both approved compositions are offered by the same picture',
  )
  assert.ok(
    html.includes('media="(max-width: 51.999rem)"'),
    'the dedicated portrait composition is selected below the design breakpoint',
  )
  assert.match(
    html,
    /<picture class="ms-hero-art" aria-hidden="true">[\s\S]*?<img[^>]+alt=""/,
    'the scene is decorative; the live hero copy carries the meaning',
  )
  assert.ok(
    !html.includes('class="ms-hero-mark"'),
    'the old standalone medallion is not layered over the medallion in the scene',
  )
  assert.ok(
    html.includes('/_next/image?url=%2Fhero%2Fhero-v01.png') &&
      html.includes('/_next/image?url=%2Fhero%2Fmobile-hero-v01.png'),
    'both compositions are served through Next image optimisation',
  )
  assert.ok(
    !/(src|srcSet|srcset)="\/hero\//.test(html),
    'and neither full-size PNG is offered to the browser directly',
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
  /*
   * `ms-hero--home` is part of the pinned opening tag: it is the modifier that
   * keeps the scene's hero rules off `/about` and the book pages, which render
   * a plain `section.ms-hero`.
   */
  /*
   * The author's-study bands below the hero keep the same fixed grounds and add
   * a homepage-only modifier each: the current book on tan, the shelf on ink,
   * the author on tan -- in that order, and in both colour schemes, because
   * none of them is built from a scheme-relative token.
   */
  const INK = '<section class="ms-hero ms-hero--home ms-section--ink"'
  const TAN = '<section class="ms-section ms-section--paper ms-study-current"'
  const SHELF = '<section class="ms-section ms-section--ink ms-study-shelf"'
  const AUTHOR = '<section class="ms-section ms-section--paper ms-study-author"'
  assert.ok(html.includes(INK), 'the introduction is on the fixed ink ground')
  assert.ok(html.includes(TAN), 'and the featured book on the fixed tan one')
  assert.ok(html.includes(SHELF), 'the shelf is on the fixed ink ground')
  assert.ok(html.includes(AUTHOR), 'and the author on the fixed tan one')
  assert.ok(
    !html.includes('<section class="ms-section ms-section--inverse"'),
    'neither homepage band uses the scheme-relative inverse ground any more',
  )
  assert.ok(
    html.indexOf(INK) < html.indexOf(TAN) &&
      html.indexOf(TAN) < html.indexOf(SHELF) &&
      html.indexOf(SHELF) < html.indexOf(AUTHOR),
    'and they arrive in that order: black introduction, tan book, ink shelf, tan author',
  )
  assert.equal(
    (html.match(/<section class="ms-section[ "]/g) ?? []).length,
    3,
    'and those three are the only lower bands',
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
 * The hero art and the remaining watermark architecture, read off the
 * repository rather than a rendered page.
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
test('the hero is art-directed and the remaining watermark stays behind content', () => {
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
  for (const asset of ['hero-v01.png', 'mobile-hero-v01.png', 'hero-v02-left-texture.webp']) {
    assert.ok(
      existsSync(join(ROOT, 'public', 'hero', asset)),
      `the responsive hero composition is present: ${asset}`,
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

  assert.deepEqual(
    sources.filter(([, t]) => t.includes('from "@/components/site/AuthorLogo"')).map(([p]) => p),
    [],
    'the standalone medallion is no longer layered over the new hero scene',
  )

  const css = sources.find(([p]) => p === 'app/globals.css')?.[1] ?? ''
  const start = css.indexOf('/*\n * The hero is art-directed')
  assert.ok(start > 0, 'the responsive hero rules are where this test expects them')
  const block = css.slice(start, css.indexOf('.ms-hero-title'))
  const decls = block.replace(/\/\*[\s\S]*?\*\//g, '')

  /*
   * The scene uses a dedicated mobile source, while the CSS preserves that art
   * direction: a mobile crop below 52rem and a height-sized, right-anchored
   * desktop scene above it.
   */
  const desktopAt = decls.indexOf('@media (min-width: 52rem)')
  assert.ok(desktopAt > 0, 'the treatments are split at a 52rem breakpoint')
  const phone = decls.slice(0, desktopAt)
  const desktop = decls.slice(desktopAt)

  // Below 52rem: the following surfaces keep the watermark, but the hero opts
  // out because its portrait artwork already contains the full mark.
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
  assert.ok(
    /body:has\(\.ms-hero\) \.ms-hero--home::before\s*\{\s*content: none/.test(phone),
    'the homepage hero watermark is removed rather than doubled over the new artwork',
  )
  assert.ok(
    !/\.ms-hero::before\s*\{\s*content: none/.test(phone),
    'and only the homepage hero: below 52rem `/about` and book heroes keep theirs',
  )
  assert.ok(
    /\.ms-hero-art-img\s*\{[\s\S]*?object-fit: cover/.test(phone),
    'the portrait composition fills the phone hero',
  )

  // At 52rem and up: the stationary layer is removed and the wide hero scene
  // stays at its natural proportion, anchored to the right.
  assert.ok(
    desktop.includes('content: none'),
    'at 52rem the stationary layer is removed, not merely hidden',
  )
  assert.ok(
    !desktop.includes('watermark-light-1024.webp') &&
      !desktop.includes('watermark-dark-1024.webp'),
    'no derivative reaches any desktop surface',
  )
  assert.match(desktop, /\.ms-hero-art-img\s*\{[\s\S]*?width: auto;[\s\S]*?height: 100%/)
  assert.ok(desktop.includes('object-position: right center'), 'the scene stays anchored right')
  assert.ok(
    /\.ms-hero-copy\s*\{[\s\S]*?max-width: min\(var\(--measure\), 54vw\)/.test(desktop),
    'the live copy keeps a protected measure beside the focal artwork',
  )

  /*
   * The hybrid's left texture is a desktop layer only: phones hide the element
   * and name no texture file, so they never request it. It is painted without
   * a blend mode, cannot intercept a click, and only the homepage hero has it.
   */
  assert.ok(/\.ms-hero-texture\s*\{\s*display: none;/.test(phone), 'phones hide the texture layer')
  assert.ok(!phone.includes('hero-v02-left-texture'), 'and never name its file')
  const texture = /\.ms-hero--home \.ms-hero-texture\s*\{([^}]*)\}/.exec(desktop)?.[1] ?? ''
  assert.ok(
    texture.includes('url("/hero/hero-v02-left-texture.webp")'),
    'the desktop homepage hero paints the texture derivative',
  )
  assert.ok(texture.includes('pointer-events: none'), 'the texture cannot intercept a click')
  assert.ok(!/mix-blend-mode/.test(decls), 'and no hero layer uses a blend mode')

  /*
   * `/about` and every book page render `section.ms-hero` too, so the scene's
   * hero rules are scoped to the homepage modifier, and the released watermark
   * selector groups still name the plain hero. Dropping `.ms-hero::before` from
   * either group would bring a fixed watermark back into the `/about` and book
   * heroes on a laptop, or leave it fixed for a reader who asked for stillness.
   */
  const reducedAt = desktop.indexOf('@media (prefers-reduced-motion: reduce)')
  assert.ok(reducedAt > 0, 'the reduced-motion treatment follows the 52rem block')
  const wide = desktop.slice(0, reducedAt)
  const reduced = desktop.slice(reducedAt)
  assert.ok(
    /\.ms-hero--home\s*\{\s*min-height: clamp\(31rem, 37vw, 36rem\)/.test(wide),
    'the desktop minimum height belongs to the homepage hero',
  )
  const selectorGroup = (text: string, declaration: RegExp) =>
    (new RegExp(`([^{}]+)\\{\\s*${declaration.source}`).exec(text)?.[1] ?? '')
      .split(',')
      .map((s) => s.trim())
  const WATERMARKED = [
    'body:has(.ms-hero) .ms-hero::before',
    'body:has(.ms-hero) .ms-section::before',
    'body:has(.ms-hero) .ms-footer::before',
  ]
  assert.deepEqual(
    selectorGroup(wide, /content: none;/),
    WATERMARKED,
    'at 52rem the stationary layer is removed from every hero, not only the homepage one',
  )
  assert.deepEqual(
    selectorGroup(reduced, /position: absolute;/),
    WATERMARKED,
    'and with reduced motion every hero layer travels with the page',
  )

  const allDecls = css.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.ok(
    !/(^|[\s,}])\.ms-hero\s*\{[^}]*(min-height|overflow|isolation)/.test(allDecls),
    'no plain `.ms-hero` rule carries the homepage-only height, overflow or isolation',
  )
  const homeSource = sources.find(([p]) => p === 'app/(site)/page.tsx')?.[1] ?? ''
  assert.equal(
    (homeSource.match(/className="ms-hero ms-hero--home ms-section--ink"/g) ?? []).length,
    1,
    'the homepage hero carries the modifier',
  )
  for (const p of ['app/(site)/about/page.tsx', 'app/(site)/books/[slug]/page.tsx']) {
    const text = sources.find(([q]) => q === p)?.[1] ?? ''
    assert.ok(text.includes('<section className="ms-hero"'), `${p} still renders a plain hero`)
    assert.ok(!text.includes('ms-hero--home'), `${p} never takes the homepage modifier`)
  }

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

/*
 * The author's-study lower bands and the stationary watermark, read off the
 * stylesheet. The released watermark still covers every lower `.ms-section`
 * band and the footer below 52rem (the test above pins its selector groups),
 * and the new texture and light must live with it rather than replace it:
 *
 *   - no band rule and no footer rule may use the element's `::before`, which
 *     is the watermark's layer;
 *   - none may take a property that makes the band the fixed layer's
 *     containing block (`transform`, `perspective`, `filter`,
 *     `backdrop-filter`, `contain`, `will-change`), nor fix its own texture;
 *   - the grounds stay the fixed ink and tan -- never `--inv-*`, `--paper` or
 *     the page's `--bg` -- so the order holds in both schemes;
 *   - the only raster texture is the hero's own file, and only from 52rem up,
 *     so a phone is never sent it.
 *
 * Runs without a production build on purpose.
 */
test('the author\'s-study bands keep the watermark, their fixed grounds and a phone-light texture', () => {
  const css = readFileSync(join(ROOT, 'app', 'globals.css'), 'utf8').replace(/\r\n/g, '\n')
  const start = css.indexOf("/* ------------------------------------------------ homepage: author's study */")
  const end = css.indexOf('/* ----------------------------------------------------------------- motion */')
  assert.ok(start > 0 && end > start, 'the author\'s-study rules are where this test expects them')
  const study = css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '')

  // Innermost rules only: `@media` wrappers are not rules of their own here.
  const rules = Array.from(study.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map(([, selector, body]) => ({
    selectors: selector.trim().split(',').map((s) => s.trim()),
    body,
  }))
  assert.ok(rules.length > 30, 'the rule scan found the author\'s-study rules')

  const BAND = /(\.ms-study-(current|shelf|author)|\.ms-footer)(::?[\w-]+)?$/
  const bandRules = rules.filter((r) => r.selectors.some((s) => BAND.test(s)))
  assert.ok(bandRules.length >= 5, 'the band and footer rules were found')
  for (const { selectors, body } of bandRules) {
    const where = selectors.join(', ')
    assert.ok(
      !selectors.some((s) => /(\.ms-study-(current|shelf|author)|\.ms-footer)::before$/.test(s)),
      `no band or footer ::before is used by the new treatment: ${where}`,
    )
    assert.ok(
      !/(^|[\s;])(transform|perspective|filter|backdrop-filter|contain|will-change|container-type|content-visibility)\s*:/.test(body),
      `a band or the footer would become the watermark's containing block: ${where}`,
    )
    assert.ok(!/position:\s*fixed|background-attachment:\s*fixed/.test(body), `nothing on a band is fixed: ${where}`)
    assert.ok(!/clip-path|--wm-/.test(body), `the watermark's clip and cut are left alone: ${where}`)
    assert.ok(
      !/var\(--(inv-[\w-]+|paper|bg)\)/.test(body),
      `a band is grounded in a scheme-relative token: ${where}`,
    )
  }

  // The grounds are the fixed classes themselves, not a new colour.
  for (const [band, ground] of [
    ['ms-study-current', 'ms-section--paper'],
    ['ms-study-shelf', 'ms-section--ink'],
    ['ms-study-author', 'ms-section--paper'],
  ]) {
    assert.ok(study.includes(`.${ground}.${band} {`), `.${band} is styled on its fixed .${ground} ground`)
  }
  assert.ok(!/background(-color)?:\s*(#|rgb)/.test(bandRules.map((r) => r.body).join('\n')), 'no band paints a ground colour of its own')

  // Raster texture: the hero's own derivative, reused, and only from 52rem up.
  const wideAt = study.indexOf('@media (min-width: 52rem)')
  assert.ok(wideAt > 0, 'the shelf texture sits in a 52rem block')
  const urls = Array.from(study.matchAll(/url\("(\/[^"]+)"\)/g)).map((m) => ({ url: m[1], at: m.index ?? 0 }))
  assert.deepEqual(urls.map((u) => u.url), ['/hero/hero-v02-left-texture.webp'], 'the only file the lower bands name is the hero\'s texture')
  assert.ok(urls.every((u) => u.at > wideAt), 'and phones never see it named')
  assert.ok(existsSync(join(ROOT, 'public', 'hero', 'hero-v02-left-texture.webp')))

  // The same selector groups the hero test pins are still the only watermark layer.
  assert.equal(
    (css.match(/::before\s*\{[^}]*position:\s*fixed/g) ?? []).length,
    1,
    'there is still exactly one fixed pseudo-element layer: the released watermark',
  )
  assert.ok(!/ms-grain|ms-reveal|ms-rise/.test(study), 'and no retired grain film or reveal returns under a new name')
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

  // The modifier is the homepage's alone. This page is about him and keeps its
  // own plate; if the modifier ever leaks here, that is a regression.
  assert.ok(!html.includes('ms-portrait--home'), 'the About portrait is not capped')
  assert.ok(
    html.includes('class="ms-portrait"') && html.includes('sizes="(min-width: 52rem) 15rem, min(20rem, 100vw)"'),
    'and keeps its default class and sizing',
  )
})

/*
 * The author's-study presentation is opt-in from the homepage only. The shared
 * components keep their defaults everywhere else: the row shelf on `/books`,
 * the plain portrait on `/about`, and no study band, book or frame on any of
 * them. Matched on full attributes, never on bare names.
 */
test("the author's-study treatment never reaches /books, /about or a book page", { skip }, async () => {
  const books = await get('/books')
  assert.equal(books.status, 200)
  assert.equal((books.html.match(/<ul class="ms-shelf">/g) ?? []).length, 1, '/books keeps the row shelf')
  assert.equal((books.html.match(/class="ms-shelf-frame/g) ?? []).length, 2, 'with a frame on each row')
  assert.ok(
    books.html.includes('sizes="(min-width: 64rem) 10rem, (min-width: 30rem) 26vw, 6rem"'),
    'and the row cover keeps its default sizes',
  )

  for (const path of ['/books', '/about', '/books/persistent', '/books/the-backward-becoming']) {
    const { status, html } = await get(path)
    assert.equal(status, 200)
    for (const marker of [
      'class="ms-shelf ms-shelf--showcase"',
      'class="ms-study-book',
      'class="ms-study-portrait"',
      'class="ms-shelf-plinth"',
      'ms-featured--study',
      'ms-study-current',
      'ms-study-shelf',
      'ms-study-author',
    ]) {
      assert.ok(!html.includes(marker), `${path} must not carry ${marker}`)
    }
  }
})

/*
 * The homepage scene is scoped by `ms-hero--home`; `/about` and a book page
 * render a plain `section.ms-hero` and none of the scene's markup. Matched on
 * full attributes, because the stylesheet inlined into every page names the
 * modifier and the scene classes too.
 */
test('the homepage hero scene never reaches About or a book page', { skip }, async () => {
  for (const [path, labelledBy] of [
    ['/about', 'about-title'],
    ['/books/persistent', 'book-title'],
  ] as const) {
    const { status, html } = await get(path)
    assert.equal(status, 200)
    assert.ok(
      html.includes(`<section class="ms-hero" aria-labelledby="${labelledBy}"`),
      `${path} renders a plain hero`,
    )
    assert.ok(!html.includes('class="ms-hero ms-hero--home'), `${path} has no homepage modifier`)
    assert.ok(!html.includes('class="ms-hero-art"'), `${path} carries no hero scene`)
    assert.ok(!html.includes('class="ms-hero-shade"'), `${path} carries no hero shade`)
    assert.ok(!html.includes('class="ms-hero-texture"'), `${path} carries no hero texture`)
    assert.ok(!html.includes('hero-v01.png'), `${path} requests neither hero composition`)
  }
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
