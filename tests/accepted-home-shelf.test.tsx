/**
 * The homepage shelf, rendered: Mike's accepted shelf (R2), standing in the
 * full-width lateral room.
 *
 * `tests/pages.test.ts` proves the shelf on the built homepage, with the real
 * two books. This file proves what that page cannot show today, because the
 * catalog holds two titles: that the shelf is generic. Any number of records
 * fills shelves of two, an odd last title keeps the left place, and a title
 * with no approved shelf image stands there as its own cover or plate -- never
 * as another book's art and never as a placeholder.
 *
 * Every record here except the real-catalog test is a synthetic fixture built
 * in this file. Nothing is written to `content/bookshelf/`.
 *
 * ## The stylesheet
 *
 * The component imports `AcceptedHomeShelf.module.css`. Next compiles that;
 * Node refuses a `.css` import outright (`ERR_UNKNOWN_FILE_EXTENSION`), and
 * `tests/loader.mjs` deliberately handles `.tsx` and the `@/` alias only. So
 * this file registers one more load hook of its own, from a `data:` URL: a
 * `.css` file becomes a module whose every class name is its own key, and
 * every other URL is handed straight on to the existing chain -- this repo's
 * loader, then Node. Hooks registered later run first, which is what puts this
 * one in front. The components are imported dynamically, after registration,
 * because a static import would be hoisted above it. (Inside a function, not
 * at the top level: `npm run typecheck` checks this file at the default ES5
 * target, where top-level `await` does not exist.)
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { register } from 'node:module'

import ReactDOMServer from 'react-dom/server'
import { JSDOM } from 'jsdom'

import type { ReactElement } from 'react'

import type { ShelfBook } from '../lib/bookshelf.ts'

const CSS_AS_CLASS_KEYS = `
export async function load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.css')) {
    return {
      format: 'module',
      shortCircuit: true,
      source: 'export default new Proxy({}, { get: (_, key) => (typeof key === "string" ? key : undefined) })',
    }
  }
  return nextLoad(url, context)
}
`
register(`data:text/javascript,${encodeURIComponent(CSS_AS_CLASS_KEYS)}`)

const loaded = (async () => ({
  AcceptedHomeShelf: (await import('../components/site/AcceptedHomeShelf.tsx')).default,
  Bookshelf: (await import('../components/site/Bookshelf.tsx')).default,
  loadShelf: (await import('../lib/bookshelf.ts')).loadShelf,
}))()

const ART = {
  'the-backward-becoming': '/accepted-shelf-r2/tbb-selected.png',
  persistent: '/accepted-shelf-r2/persistent-selected.png',
} as const

function book(slug: string, order: number, overrides: Partial<ShelfBook> = {}): ShelfBook {
  return {
    slug,
    order,
    featured: false,
    title: `Fixture title ${slug}`,
    kind: 'Novel',
    tagline: `Fixture line for ${slug}.`,
    status: 'in-progress',
    statusLabel: `Fixture stage ${slug}`,
    statusNote: 'Fixture note.',
    description: ['Fixture paragraph.'],
    details: [],
    reviewerAccess: false,
    cover: null,
    ...overrides,
  }
}

function render(element: ReactElement) {
  const html = ReactDOMServer.renderToStaticMarkup(element)
  const { document } = new JSDOM(`<!doctype html><body>${html}</body>`).window
  return { html, document }
}

/** Every shelf, as the slugs it holds, in order. */
function shelves(document: Document) {
  return Array.from(document.querySelectorAll('.rows > .row')).map((row) =>
    Array.from(row.querySelectorAll(':scope > .grid > article.item')).map((item) =>
      (item.getAttribute('aria-labelledby') ?? '').replace(/^shelf-book-/, ''),
    ),
  )
}

/* ------------------------------------------------------------ the real two */

test('the real catalog renders as one shelf of two, captioned from the catalog itself', async () => {
  const { AcceptedHomeShelf, loadShelf } = await loaded
  const books = loadShelf()
  assert.deepEqual(
    books.map((b) => b.slug),
    ['the-backward-becoming', 'persistent'],
    'positive control: the catalog still holds the two real titles, in this order',
  )
  const { html, document } = render(<AcceptedHomeShelf books={books} />)

  assert.deepEqual(shelves(document), [['the-backward-becoming', 'persistent']], 'one shelf, catalog order')

  // One heading, live text, the id the band is labelled by.
  const headings = document.querySelectorAll('h2')
  assert.equal(headings.length, 1, 'the shelf has exactly one heading')
  assert.equal(headings[0].id, 'shelf-title')
  assert.equal(headings[0].textContent, 'Everything with a name on it')
  assert.equal(document.querySelector('.eyebrow')?.textContent, 'Bookshelf')

  for (const b of books) {
    const item = document.querySelector(`article[aria-labelledby="shelf-book-${b.slug}"]`)
    assert.ok(item, `${b.slug} is on the shelf`)
    assert.equal(item.querySelector('h3')?.textContent, b.title, `${b.slug}: title from the catalog`)
    assert.equal(item.querySelector('.status')?.textContent, b.statusLabel, `${b.slug}: stage from the catalog`)
    assert.equal(item.querySelector('.tagline')?.textContent, b.tagline, `${b.slug}: line from the catalog`)

    const link = item.querySelector('a')
    assert.equal(link?.getAttribute('href'), `/books/${b.slug}`, `${b.slug}: About links to its real page`)
    assert.equal(link?.textContent, 'About this book→')
    assert.equal(link?.getAttribute('aria-describedby'), `shelf-book-${b.slug}`)

    const images = item.querySelectorAll('img')
    assert.equal(images.length, 1, `${b.slug}: one image`)
    assert.equal(images[0].getAttribute('src'), ART[b.slug as keyof typeof ART], `${b.slug}: its own approved art`)
    assert.ok((images[0].getAttribute('alt') ?? '').startsWith(b.title), `${b.slug}: alt names the book`)
    assert.equal(images[0].getAttribute('loading'), 'lazy')
    assert.equal(images[0].getAttribute('class'), 'image', 'no cover frame and no extra styling hook')
  }

  // Exact intrinsic sizes, so the browser reserves the canvas before it loads.
  assert.match(html, /src="\/accepted-shelf-r2\/tbb-selected\.png"[^>]*width="1181" height="1332"/)
  assert.match(html, /src="\/accepted-shelf-r2\/persistent-selected\.png"[^>]*width="1122" height="1402"/)

  // Placement comes from the measured material, not the canvas bottom.
  const tbb = document.querySelector('article[aria-labelledby="shelf-book-the-backward-becoming"]')
  const style = tbb?.getAttribute('style') ?? ''
  assert.ok(style.includes(`--image-ratio:${1181 / 1153}`), style)
  assert.ok(style.includes(`--material-ratio:${787 / 1153}`), style)
  assert.ok(style.includes(`--material-center:${(274 + 1061) / 2 / 1153}`), style)
  assert.ok(style.includes(`--base-ratio:${1260 / 1153}`), style)

  // Nothing from the proof's own catalog, local detail pages or test items.
  for (const absent of ['ms-shelf-frame', 'details/', 'inputs/', 'PLACEHOLDER', 'placeholder', 'test item', 'A life traced back toward its beginning.']) {
    assert.ok(!html.includes(absent), `the real shelf carries no "${absent}"`)
  }
  // The rooms' layers are decorative.
  for (const scene of Array.from(document.querySelectorAll('.rowScene, .itemScene'))) {
    assert.equal(scene.getAttribute('aria-hidden'), 'true')
  }
  // Each title is rendered once, however many scenes it has.
  assert.equal((html.match(/The Backward Becoming/g) ?? []).length, 2, 'TBB: once as the h3, once in its alt')
})

/* ------------------------------------------------------------- five records */

test('five records fill shelves of two, the odd fifth keeping the left place', async () => {
  const { AcceptedHomeShelf } = await loaded
  const books = [
    book('the-backward-becoming', 1),
    book('persistent', 2),
    book('fixture-three', 3),
    book('fixture-four', 4, {
      cover: { src: '/covers/fixture-four.jpg', alt: 'Fixture four cover' },
    }),
    book('fixture-five', 5),
  ]
  const { html, document } = render(<AcceptedHomeShelf books={books} />)

  assert.deepEqual(shelves(document), [
    ['the-backward-becoming', 'persistent'],
    ['fixture-three', 'fixture-four'],
    ['fixture-five'],
  ])
  assert.equal(document.querySelectorAll('article.item').length, 5)
  assert.equal(document.querySelectorAll('h2').length, 1, 'one heading for any number of shelves')
  assert.equal(document.querySelectorAll('.rowScene').length, 3, 'one shelf scene per shelf')
  assert.equal(document.querySelectorAll('.itemScene').length, 5, 'and one phone scene per title')

  // Only the two real slugs get approved art.
  assert.equal((html.match(/\/accepted-shelf-r2\//g) ?? []).length, 2)
  for (const slug of ['fixture-three', 'fixture-four', 'fixture-five']) {
    const item = document.querySelector(`article[aria-labelledby="shelf-book-${slug}"]`)!
    assert.ok(!item.innerHTML.includes('/accepted-shelf-r2/'), `${slug} never borrows another book's art`)
    assert.ok(item.querySelector('.fallback .ms-shelf-frame'), `${slug} stands as its ordinary frame`)
    assert.equal(item.querySelector('a')?.getAttribute('href'), `/books/${slug}`)
    assert.equal(item.querySelector('h3')?.textContent, `Fixture title ${slug}`)
  }
  assert.equal(document.querySelectorAll('.ms-shelf-frame--plate').length, 2, 'the two without covers are plates')
  assert.equal(
    document.querySelector('article[aria-labelledby="shelf-book-fixture-four"] img.ms-shelf-art')?.getAttribute('src'),
    '/covers/fixture-four.jpg',
    'the one with a flat cover shows its own cover',
  )
})

test('two records are one shelf; one record is one shelf of one', async () => {
  const { AcceptedHomeShelf } = await loaded
  const two = render(<AcceptedHomeShelf books={[book('fixture-a', 1), book('fixture-b', 2)]} />)
  assert.deepEqual(shelves(two.document), [['fixture-a', 'fixture-b']])
  const one = render(<AcceptedHomeShelf books={[book('fixture-a', 1)]} />)
  assert.deepEqual(shelves(one.document), [['fixture-a']])
})

/* ------------------------------------------------------- unknown-art fallback */

test('a title with no approved shelf art stands as its own cover or plate, never as a stand-in', async () => {
  const { AcceptedHomeShelf } = await loaded
  const plate = render(<AcceptedHomeShelf books={[book('fixture-plate', 1)]} />)
  assert.equal(plate.document.querySelectorAll('img').length, 0, 'a plate is type, not an image')
  const frame = plate.document.querySelector('.fallback > .ms-shelf-frame.ms-shelf-frame--plate')
  assert.ok(frame, 'the typographic plate, inside the fallback stand')
  assert.equal(frame.getAttribute('aria-hidden'), 'true')
  assert.equal(
    plate.document.querySelector('.ms-shelf-plate-title')?.textContent,
    'Fixture title fixture-plate',
    'the plate names its own title',
  )
  const ratio = plate.document.querySelector('article.item')?.getAttribute('style') ?? ''
  assert.ok(ratio.includes(`--material-ratio:${2 / 3}`), 'its caption aligns to a 2:3 frame')

  const covered = render(
    <AcceptedHomeShelf
      books={[book('fixture-cover', 1, { cover: { src: '/covers/fixture-cover.jpg', alt: 'Fixture cover' } })]}
    />,
  )
  const images = covered.document.querySelectorAll('img')
  assert.equal(images.length, 1)
  assert.equal(images[0].getAttribute('src'), '/covers/fixture-cover.jpg')
  assert.equal(images[0].getAttribute('class'), 'ms-shelf-art')
  assert.ok(!covered.html.includes('accepted-shelf-r2'), 'no approved art borrowed')
  assert.ok(!/placeholder/i.test(plate.html + covered.html), 'no placeholder of any kind')
})

/* ------------------------------------------------------ the lateral room */

/*
 * jsdom applies no CSS, so the browser captures carry the measured geometry
 * at real widths. What the source can prove: the shelf has no width of its
 * own any more (the old `calc(898 * var(--u))` cap and its side-fade masks are
 * gone), the room is the lateral photograph and never the walnut one, its
 * furnishings are fixed to the band's two edges at one scale that never
 * exceeds the photograph's own pixels, its plain middle spans exactly the
 * columns between them, the books keep their own unit, the phone stage keeps
 * its accepted size, and the only masks are on the scene layers, never on a
 * book.
 */
test('the room fills the band edge to edge, furnishings fixed at its sides, and the books keep their own size', async () => {
  const css = readFileSync(join(process.cwd(), 'components', 'site', 'AcceptedHomeShelf.module.css'), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  // A rule of its own, starting a block -- not the last line of a grouped selector.
  const rule = (selector: string) => {
    const at = css.indexOf(`\n\n${selector} {`)
    assert.ok(at >= 0, `the stylesheet has ${selector}`)
    return css.slice(at, css.indexOf('}', at))
  }

  // No scene cap: the shelf, and so its room, is the band's full width.
  const shelf = rule('.shelf')
  assert.ok(!/max-width/.test(shelf), 'the shelf has no maximum width')
  assert.ok(!css.includes('898 * var(--u)'), 'the old 898-unit scene width is gone everywhere')
  assert.ok(shelf.includes('width: 100%;'))

  // The books keep the accepted unit, independent of the room's width.
  assert.ok(shelf.includes('--u: clamp(1px, (100vw - 64px) / 898, 1.85px);'), 'the books\' unit, 1px to 1.85px')
  assert.ok(shelf.includes('--book-h: calc(275 * var(--u));'), 'the book height comes from that unit alone')
  assert.ok(shelf.includes('--base: calc(280 * var(--u));'))
  // The photograph's scale: 1 at most -- its own pixels -- and fixed from there up.
  assert.ok(shelf.includes('--s: calc(var(--u) / 1.85);'), 'the room is never drawn larger than its pixels')
  assert.ok(rule('.grid').includes('max-width: calc(576 * var(--u));'), 'the content keeps a finite width')

  // The lateral photograph, and never the walnut one.
  assert.ok(!css.includes('walnut-scene.png'), 'the walnut scene is not used')
  assert.equal((css.match(/url\("([^"]+)"\)/g) ?? []).join(), 'url("/accepted-shelf-lateral-r1/scene.png")', 'one photograph, named once')
  const layers = rule('.sceneLeft,\n.sceneMiddle,\n.sceneRight')
  assert.ok(layers.includes('background-size: calc(1942 * var(--s)) calc(809 * var(--s));'), 'all three layers draw it at one scale')
  assert.ok(!/background-size:[^;]*(cover|contain|100%)/.test(css), 'the whole photograph is never stretched to the band')

  // The furnishings fixed to the band's edges, at the photograph's own proportions.
  const left = rule('.sceneLeft')
  assert.ok(left.includes('left: 0;') && left.includes('width: calc(450 * var(--s) + 1px);'), 'columns 0-450 at the left edge')
  assert.ok(left.includes('background-position: 0 calc(-150 * var(--s));'))
  const right = rule('.sceneRight')
  assert.ok(right.includes('right: 0;') && right.includes('width: calc(502 * var(--s) + 1px);'), 'columns 1440-1942 at the right edge')
  assert.ok(right.includes('background-position: 100% calc(-150 * var(--s));'))

  // The middle: exactly columns 450-1440, widened between them, never the side ornaments again.
  const middle = rule('.sceneMiddle')
  assert.ok(middle.includes('left: calc(450 * var(--s));') && middle.includes('right: calc(502 * var(--s));'))
  const size = Number(/background-size: ([\d.]+)% calc\(809 \* var\(--s\)\);/.exec(middle)?.[1])
  const offset = Number(/background-position: ([\d.]+)% calc\(-150 \* var\(--s\)\);/.exec(middle)?.[1])
  assert.ok(Math.abs(size - (1942 / 990) * 100) < 1e-4, `the middle shows 990 columns across its width: ${size}%`)
  assert.ok(Math.abs(offset - (450 / (1942 - 990)) * 100) < 1e-4, `starting at column 450: ${offset}%`)
  assert.ok(!/repeat-x|background-repeat: repeat/.test(css), 'nothing is tiled, so no ornament repeats')

  // Phones: one title per shelf, at the accepted stage width, on the plain wall and desk.
  const phone = css.slice(css.indexOf('@media (max-width: 639px)'))
  assert.ok(phone.includes('width: min(327px, calc(100% - 48px));'), 'the phone stage is unchanged')
  assert.ok(phone.includes('grid-template-columns: 1fr;'), 'one title per shelf')
  assert.ok(/\.itemScene \.sceneLeft,\n\s*\.itemScene \.sceneRight \{\n\s*display: none;/.test(phone), 'no furnishings crowd a phone')

  // Masks: the scene's layers only; nothing touches a book.
  const masked = Array.from(css.matchAll(/([^{}]+)\{[^{}]*mask-image/g)).map((m) => m[1].trim())
  assert.deepEqual(masked, ['.sceneLeft,\n.sceneMiddle,\n.sceneRight'], 'only the room\'s layers fade')
  const image = rule('.image')
  assert.ok(!/filter|mask|clip-path|box-shadow|opacity|transform/.test(image), 'nothing touches a book image')

  // Markup: every scene is the same three decorative layers, middle first.
  const { AcceptedHomeShelf } = await loaded
  const { document } = render(<AcceptedHomeShelf books={[book('fixture-a', 1), book('fixture-b', 2), book('fixture-c', 3)]} />)
  const scenes = Array.from(document.querySelectorAll('.rowScene, .itemScene'))
  assert.equal(scenes.length, 2 + 3)
  for (const scene of scenes) {
    assert.equal(scene.getAttribute('aria-hidden'), 'true')
    assert.deepEqual(Array.from(scene.children).map((c) => c.className), ['sceneMiddle', 'sceneLeft', 'sceneRight'])
    assert.equal(scene.querySelectorAll('img').length, 0, 'the room is a background, never an image element')
  }
})

/* ---------------------------------------------------------- Bookshelf entry */

test('the showcase variant is this shelf, with its note; an empty shelf keeps the heading', async () => {
  const { Bookshelf } = await loaded
  const full = render(<Bookshelf books={[book('fixture-a', 1)]} variant="showcase" />)
  assert.equal(full.document.querySelector('h2')?.id, 'shelf-title')
  assert.deepEqual(shelves(full.document), [['fixture-a']])
  assert.ok(full.html.includes('A title appears here once it exists'), 'the shelf note is kept')
  assert.ok(!full.html.includes('ms-shelf--showcase'), 'the superseded ledge markup is gone')

  const quiet = render(<Bookshelf books={[book('fixture-a', 1)]} variant="showcase" note={false} />)
  assert.ok(!quiet.html.includes('A title appears here once it exists'))

  const empty = render(<Bookshelf books={[]} variant="showcase" />)
  assert.equal(empty.document.querySelector('h2')?.id, 'shelf-title', 'the heading stays')
  assert.ok(empty.html.includes('There is nothing on the shelf yet.'))
  assert.equal(empty.document.querySelectorAll('.rows > .row').length, 0)

  // `/books` is untouched: no variant is the row shelf.
  const rows = render(<Bookshelf books={[book('fixture-a', 1)]} />)
  assert.ok(rows.html.includes('<ul class="ms-shelf">'))
  assert.ok(!rows.html.includes('id="shelf-title"'), 'and carries no shelf heading of its own')
})
