import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  DURATION,
  __resetGsap,
  duration,
  isCompactViewport,
  loadGsap,
  prefersReducedMotion,
} from '../components/motion/motion.ts'

/*
 * The motion layer is defined as much by what it refuses to do as by what it
 * does, so most of this file is refusals.
 *
 * The list is not a style preference. A reading surface that hijacks scrolling,
 * reveals prose paragraph by paragraph, or keeps a phone's compositor busy is a
 * worse place to read a novel, and every one of those is a thing a motion
 * library makes easy to add later. These tests are here to make adding one
 * noisy.
 */

const ROOT = process.cwd()

function source(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
}

/**
 * The same file with its comments removed.
 *
 * The "must not contain" checks below are about what the code *does*, and these
 * files explain themselves at length -- `motion.ts` says in prose that it adds
 * no grain and no particles, which is the opposite of a violation and would
 * otherwise trip a search for the word.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const MOTION = source('components/motion/motion.ts')
const COVER = source('components/motion/CoverSettle.tsx')
const RIBBON = source('components/motion/BookmarkRibbon.tsx')
const SCENE = source('components/motion/SceneBackground.tsx')
const REVIEW_CSS = source('app/review/review.css')

/** Every motion file, comments stripped, for the refusals. */
const ALL_MOTION = [MOTION, COVER, RIBBON, SCENE].map(code).join('\n')

/** Drive the media queries without a browser. */
function withMatchMedia<T>(answers: Record<string, boolean>, run: () => T): T {
  const previous = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = {
    matchMedia: (query: string) => ({ matches: answers[query] ?? false }),
  }
  try {
    return run()
  } finally {
    if (previous === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = previous
  }
}

const REDUCED = '(prefers-reduced-motion: reduce)'
const NARROW = '(max-width: 47.999rem)'
const COARSE = '(pointer: coarse)'

/* ------------------------------------------------------------ the policy */

test('a reader who asks for stillness gets it', () => {
  assert.equal(withMatchMedia({ [REDUCED]: true }, prefersReducedMotion), true)
  assert.equal(withMatchMedia({ [REDUCED]: false }, prefersReducedMotion), false)
})

test('with no window at all, nothing claims a preference', () => {
  // Server rendering. Everything must resolve to "do not animate".
  assert.equal(prefersReducedMotion(), false)
  assert.equal(isCompactViewport(), false)
})

test('a phone is recognised by either a narrow viewport or a coarse pointer', () => {
  assert.equal(withMatchMedia({ [NARROW]: true }, isCompactViewport), true)
  assert.equal(withMatchMedia({ [COARSE]: true }, isCompactViewport), true)
  assert.equal(withMatchMedia({}, isCompactViewport), false)
})

test('a phone gets a shorter version of the same gesture, never an extra one', () => {
  for (const step of Object.keys(DURATION) as (keyof typeof DURATION)[]) {
    assert.ok(
      DURATION[step].compact < DURATION[step].full,
      `${step} should be shorter on a phone`,
    )
    assert.equal(withMatchMedia({ [NARROW]: true }, () => duration(step)), DURATION[step].compact)
    assert.equal(withMatchMedia({}, () => duration(step)), DURATION[step].full)
  }
})

test('nothing here runs for longer than a moment', () => {
  // "Restrained" as a number. A second-long fade is the outer limit; anything
  // beyond it stops reading as a transition and starts reading as an effect.
  for (const step of Object.keys(DURATION) as (keyof typeof DURATION)[]) {
    assert.ok(DURATION[step].full <= 1, `${step} is too long to be restrained`)
  }
})

test('GSAP is never even fetched for a reader who asked for stillness', async () => {
  __resetGsap()
  const result = await withMatchMedia({ [REDUCED]: true }, () => loadGsap())
  assert.equal(result, null)
  __resetGsap()
})

test('GSAP is never fetched on the server', async () => {
  __resetGsap()
  assert.equal(await loadGsap(), null)
  __resetGsap()
})

/* ------------------------------------------------------------ the refusals */

test('nothing in the motion layer touches scrolling', () => {
  /*
   * The hard rule. No scroll-driven timelines, no pinning, no hijacking, and
   * no reading of a scroll position to drive an animation. A reader's place in
   * a page belongs to the reader.
   */
  for (const forbidden of [
    'ScrollTrigger',
    'ScrollSmoother',
    'ScrollToPlugin',
    'scrollTrigger',
    'window.scrollTo',
    'scrollBy',
    'scrollIntoView',
    'onWheel',
    "'wheel'",
    "'scroll'",
    'preventDefault',
  ]) {
    assert.ok(!ALL_MOTION.includes(forbidden), `the motion layer must not use "${forbidden}"`)
  }
})

test('nothing loops, repeats or runs forever', () => {
  for (const forbidden of ['repeat: -1', 'repeat:-1', 'yoyo', 'setInterval', 'requestAnimationFrame']) {
    assert.ok(!ALL_MOTION.includes(forbidden), `the motion layer must not use "${forbidden}"`)
  }
})

test('nothing here makes noise, particles or grain', () => {
  for (const forbidden of ['Audio(', 'autoplay', 'particle', 'Particle', 'grain', 'canvas', 'WebGL']) {
    assert.ok(!ALL_MOTION.includes(forbidden), `the motion layer must not use "${forbidden}"`)
  }
})

test('only transform and opacity are animated', () => {
  /*
   * Both are compositor properties, so an animation here cannot cause layout
   * and cannot reflow the text beside it. Animating a width, a height, a margin
   * or a colour could.
   */
  for (const forbidden of [
    'width:',
    'height:',
    'margin',
    'padding',
    'top:',
    'left:',
    'backgroundColor:',
    'color:',
    'filter:',
    'blur',
  ]) {
    for (const [name, file] of [
      ['CoverSettle', code(COVER)],
      ['BookmarkRibbon', code(RIBBON)],
    ] as const) {
      assert.ok(!file.includes(forbidden), `${name} must not animate "${forbidden}"`)
    }
  }
})

test('the reader never animates a block of prose', () => {
  // No paragraph-by-paragraph reveals, ever. The ribbon is a marker beside a
  // paragraph; it is not the paragraph.
  for (const forbidden of ['.rv-para"', "'.rv-para'", 'rv-prose', 'stagger']) {
    assert.ok(!ALL_MOTION.includes(forbidden), `the motion layer must not reach "${forbidden}"`)
  }
})

/* ------------------------------------------------- the static page is real */

test('every animated element is fully visible before any script runs', () => {
  /*
   * The rule that matters most. Nothing is hidden by CSS waiting to be revealed
   * by JavaScript, so no-JS, reduced motion, a blocked chunk and a failed
   * import all produce the finished page rather than a blank one.
   */

  // The ribbon's stylesheet draws it at full size and full opacity.
  const ribbonCss = REVIEW_CSS.slice(REVIEW_CSS.indexOf('\n.rv-ribbon {'))
  assert.match(ribbonCss, /transform:\s*scaleY\(1\)/)
  assert.match(ribbonCss, /opacity:\s*1/)

  // The cover's wrapper has no opacity or transform of its own at all: it is
  // simply there.
  assert.ok(!/\.ms-settle\s*\{[^}]*opacity/.test(source('app/globals.css')))

  // And each component writes the finished state before deciding to animate,
  // or animates only from a state it sets itself at that moment.
  assert.match(RIBBON, /element\.style\.opacity = active \? '1' : '0'/)
  assert.match(COVER, /fromTo\(/)
})

test('a failed motion import is never allowed to break a page', () => {
  // A motion library is the last thing that should be able to take a page of
  // prose down with it.
  assert.match(MOTION, /\.catch\(\(\) => null\)/)
  for (const [name, file] of [
    ['CoverSettle', COVER],
    ['BookmarkRibbon', RIBBON],
    ['SceneBackground', SCENE],
  ] as const) {
    assert.match(file, /if \(cancelled \|\| !gsap\)|if \(!gsap\)/, `${name} must handle a null gsap`)
  }
})

test('GSAP is loaded lazily, never imported at the top of a component', () => {
  // It must be its own chunk, not part of the first load of a page that may
  // never animate.
  assert.match(MOTION, /import\('gsap'\)/)
  for (const [name, file] of [
    ['motion.ts', MOTION],
    ['CoverSettle', COVER],
    ['BookmarkRibbon', RIBBON],
    ['SceneBackground', SCENE],
  ] as const) {
    assert.ok(
      !/^import .*from 'gsap'/m.test(file),
      `${name} must not import gsap statically`,
    )
  }
})

/* ------------------------------------------------------------ the scene seam */

test('the scene seam ships with no artwork, and renders nothing without one', () => {
  // The seam exists; the scenes are Mike's to choose. Inventing a placeholder
  // is the fastest way to end up shipping one.
  assert.match(SCENE, /if \(!scene\) return null/)

  // Nothing in the repository supplies a scene to it.
  const reader = source('app/review/[book]/[chapter]/ChapterReader.tsx')
  assert.ok(!reader.includes('SceneBackground'), 'no scene is wired into the reader yet')

  // And it references no image file of its own.
  assert.ok(!/\.(png|jpe?g|webp|avif|svg)/i.test(code(SCENE)), 'the seam names no artwork')
})

test('artwork stays peripheral to an opaque reading surface', () => {
  // A page of prose over a picture is unreadable at some point on some screen.
  const sceneCss = REVIEW_CSS.slice(REVIEW_CSS.indexOf('\n.rv-scene {'))
  // Painted at the very back.
  assert.match(sceneCss, /z-index:\s*0/)
  assert.match(sceneCss, /pointer-events:\s*none/)
  // Dimmed before the column is even reached...
  assert.match(sceneCss, /\.rv-scene-scrim[\s\S]*background:\s*var\(--rv-bg\)/)
  // ...and the column states its own opaque ground above it.
  assert.match(sceneCss, /\.rv-page[\s\S]*background:\s*var\(--rv-bg\)/)
})

test('the scene layer is only ever faded, never moved', () => {
  const sceneCss = REVIEW_CSS.slice(REVIEW_CSS.indexOf('\n.rv-scene-pane {'))
  assert.match(sceneCss, /will-change:\s*opacity/)
  assert.ok(!/transform:/.test(sceneCss.slice(0, sceneCss.indexOf('}'))), 'panes are not transformed')
  // No parallax: nothing in the component reads a position to move it by.
  assert.ok(!code(SCENE).includes('translate'))
})
