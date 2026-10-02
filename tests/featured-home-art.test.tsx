/**
 * The homepage's current-book band, rendered: Mike's approved TBB image.
 *
 * `tests/pages.test.ts` proves the band on the built homepage, with the real
 * featured title. This file proves what that page cannot show: that the
 * approved image belongs to The Backward Becoming alone. Another title in the
 * same study band keeps the plate, the drawn book and the column it had; the
 * default variant is unchanged for every title; and the band's words and
 * actions are the same whichever object stands beside them.
 *
 * Every record here except the real catalog's is a synthetic fixture built in
 * this file. Nothing is written to `content/bookshelf/`.
 *
 * ## The stylesheet
 *
 * `FeaturedBook` imports `FeaturedBook.module.css`, which Node will not load.
 * As in `tests/accepted-home-shelf.test.tsx`, this file registers one load
 * hook of its own from a `data:` URL: a `.css` file becomes a module whose
 * every class name is its own key, and every other URL is handed on to the
 * existing chain -- this repo's loader, then Node. The component is imported
 * dynamically, after registration, inside a function (no top-level `await` at
 * the typecheck's default target).
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
  FeaturedBook: (await import('../components/site/FeaturedBook.tsx')).default,
  loadShelf: (await import('../lib/bookshelf.ts')).loadShelf,
}))()

const TBB_SRC = '/accepted-shelf-r2/tbb-selected.png'

function render(element: ReactElement) {
  const html = ReactDOMServer.renderToStaticMarkup(element)
  const { document } = new JSDOM(`<!doctype html><body>${html}</body>`).window
  return { html, document }
}

async function realBooks() {
  const { loadShelf } = await loaded
  const books = loadShelf()
  const tbb = books.find((b) => b.slug === 'the-backward-becoming')
  const persistent = books.find((b) => b.slug === 'persistent')
  assert.ok(tbb && persistent, 'positive control: the catalog still holds both real titles')
  return { tbb, persistent }
}

/** The band's live words and actions, as a reader receives them. */
function words(document: Document) {
  const band = document.querySelector('section')!
  return {
    sectionClass: band.getAttribute('class'),
    labelledBy: band.getAttribute('aria-labelledby'),
    eyebrow: band.querySelector('.ms-eyebrow')?.textContent,
    title: band.querySelector('h2#featured-title')?.textContent,
    body: band.querySelector('.ms-featured-body')?.textContent,
    actions: Array.from(band.querySelectorAll('a')).map((a) => [a.getAttribute('href'), a.textContent, a.getAttribute('rel')]),
  }
}

/* --------------------------------------------- the real featured title */

test('The Backward Becoming stands in the study band as its approved image, with its own shadow', async () => {
  const { FeaturedBook } = await loaded
  const { tbb } = await realBooks()
  assert.equal(tbb.featured, true, 'positive control: it is the featured title')
  assert.equal(tbb.cover, null, "its catalog record still has no cover: the image is not one")

  const { html, document } = render(<FeaturedBook book={tbb} variant="study" />)

  const images = document.querySelectorAll('img')
  assert.equal(images.length, 1, 'exactly one image in the band')
  const img = images[0]
  assert.equal(img.getAttribute('src'), TBB_SRC, 'the approved file, served directly')
  assert.equal(img.getAttribute('alt'), 'The Backward Becoming by Mike Ramsey Jr, pictured as a black book with its title in gold')
  assert.equal(img.getAttribute('width'), '1181')
  assert.equal(img.getAttribute('height'), '1332')
  assert.equal(img.getAttribute('srcset'), null, 'no responsive derivative')
  assert.equal(img.getAttribute('class'), 'art', 'no plate, frame or shadow class on it')
  assert.ok(!html.includes('_next/image'), 'never through the optimiser')

  // Inside the one settle, in the book's wrapper, with no drawn book or plate.
  assert.equal(img.parentElement?.getAttribute('class'), 'ms-settle')
  assert.equal(img.parentElement?.parentElement?.getAttribute('class'), 'ms-featured-book artBook')
  assert.equal(document.querySelectorAll('.ms-plate, .ms-study-book, .ms-cover').length, 0)

  // The section's own class is untouched; only the inner grid opts in.
  const sectionClass = document.querySelector('section')?.getAttribute('class')
  assert.equal(sectionClass, 'ms-section ms-section--paper ms-study-current')
  assert.equal(document.querySelector('.ms-featured')?.getAttribute('class'), 'ms-featured ms-featured--study artGrid')

  // Heading, then book, then words, in the source order the phone layout reads.
  const order = ['ms-featured-head', 'ms-featured-book', 'ms-featured-body'].map((c) => html.indexOf(`class="${c}`))
  assert.ok(order[0] >= 0 && order[0] < order[1] && order[1] < order[2], 'head, book, body')
})

test('the words and actions beside the book are the same as beside the plate', async () => {
  const { FeaturedBook } = await loaded
  const { tbb } = await realBooks()
  const withArt = render(<FeaturedBook book={tbb} variant="study" />)
  // The same record under a slug with no approved art: the plate, everything else equal.
  const withPlate = render(<FeaturedBook book={{ ...tbb, slug: 'fixture-plate' }} variant="study" />)

  const a = words(withArt.document)
  const b = words(withPlate.document)
  assert.equal(a.title, 'The Backward Becoming')
  assert.equal(a.eyebrow, 'The current book')
  assert.ok(a.body?.includes(tbb.tagline) && a.body.includes(tbb.statusNote))
  for (const detail of tbb.details) assert.ok(a.body?.includes(detail.value), `detail kept: ${detail.label}`)
  assert.deepEqual(a.actions, [
    ['/books/the-backward-becoming', 'About this book', null],
    ['/review/login', 'Enter reviewer code→', 'nofollow'],
  ])
  assert.deepEqual({ ...a, actions: undefined }, { ...b, actions: undefined }, 'identical words either way')
  assert.equal(b.actions[0][0], '/books/fixture-plate')
  assert.deepEqual(a.actions.slice(1), b.actions.slice(1))
})

/* ------------------------------------------------- every other title */

test('another title in the study band keeps its plate, drawn book and column, never TBB art', async () => {
  const { FeaturedBook } = await loaded
  const { persistent } = await realBooks()
  const fixture: ShelfBook = { ...persistent, slug: 'fixture-other', title: 'Fixture other', cover: null, featured: true }

  for (const book of [fixture, persistent]) {
    const { html, document } = render(<FeaturedBook book={book} variant="study" />)
    assert.ok(!html.includes('/accepted-shelf-r2/'), `${book.slug}: no approved TBB art`)
    assert.equal(document.querySelector('.ms-featured')?.getAttribute('class'), 'ms-featured ms-featured--study', `${book.slug}: grid unchanged`)
    assert.equal(document.querySelector('.ms-featured-book')?.getAttribute('class'), 'ms-featured-book', `${book.slug}: wrapper unchanged`)
    assert.ok(document.querySelector('.ms-settle > .ms-study-book.ms-study-book--featured'), `${book.slug}: the drawn book`)
    assert.equal(document.querySelectorAll('.ms-plate').length, 1, `${book.slug}: its plate or cover, once`)
  }
  const plate = render(<FeaturedBook book={fixture} variant="study" />)
  assert.equal(plate.document.querySelectorAll('img').length, 0, 'a title with no cover is a typographic plate')
  assert.equal(plate.document.querySelector('.ms-plate-title')?.textContent, 'Fixture other')
})

test('the default variant is unchanged for every title, The Backward Becoming included', async () => {
  const { FeaturedBook } = await loaded
  const { tbb, persistent } = await realBooks()
  for (const book of [tbb, persistent]) {
    const { html, document } = render(<FeaturedBook book={book} />)
    assert.ok(!html.includes('/accepted-shelf-r2/'), `${book.slug}: no approved art outside the homepage study band`)
    const artClasses = Array.from(document.querySelectorAll('[class]')).filter((el) =>
      ['art', 'artGrid', 'artBook'].some((c) => el.classList.contains(c)),
    )
    assert.equal(artClasses.length, 0, `${book.slug}: no study-art class`)
    assert.equal(document.querySelector('section')?.getAttribute('class'), 'ms-section ms-section--paper')
    assert.equal(document.querySelector('.ms-featured')?.getAttribute('class'), 'ms-featured')
    assert.equal(document.querySelectorAll('.ms-settle > .ms-plate').length, 1, `${book.slug}: its plate, in the settle`)
  }
})

/* ----------------------------------------------------- the stylesheet */

/*
 * jsdom applies no CSS, so the browser captures carry the geometry. What the
 * source can prove: the image is never filtered, masked, clipped or shadowed;
 * it is sized and placed from the measured canvas and material; the overrides
 * reach only the opted-in grid, wrapper and image; and they outrank the
 * compound `globals.css` rules they override without relying on load order.
 */
test('the featured stylesheet sizes the whole image by its material and touches nothing else', () => {
  const css = readFileSync(join(process.cwd(), 'components', 'site', 'FeaturedBook.module.css'), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  assert.ok(!/(^|[\s;{])(filter|mask[\w-]*|clip-path|box-shadow|transform|object-fit|opacity)\s*:/.test(css), 'no effect on the image')
  assert.ok(!/(^|[\s,}])(body|html|header|footer|section|img|:root)\b[^{]*\{/.test(css), 'no global element selector')
  assert.ok(!/ms-study-current|ms-section/.test(css), 'never the band itself')
  assert.match(css, /width: calc\(var\(--tbb-h\) \* 1181 \/ 1153\);/, 'canvas width from material height')
  assert.match(css, /max-width: none;/, 'not capped by the base image rule')
  assert.match(css, /height: auto;/, 'never stretched')
  assert.match(css, /\.artGrid\.artGrid:global\(\.ms-featured\.ms-featured--study\) \{/, 'outranks the globals grid rule')
  assert.match(css, /\.artBook\.artBook:global\(\.ms-featured-book\) \{/, 'outranks the globals wrapper rule')
  assert.match(css, /--tbb-h: clamp\(14rem, 50vw - 8rem, 32rem\);/, 'about 512px of material from 1280px wide')
})
