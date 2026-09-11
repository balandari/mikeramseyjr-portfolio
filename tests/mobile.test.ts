import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/*
 * Mobile invariants, held in place.
 *
 * This site is read on a phone. Not "also" on a phone -- primarily. A reviewer
 * reads a chapter in bed, and Mike revokes somebody's access standing in a
 * kitchen. So the things that make that work are asserted rather than left to
 * whoever edits the stylesheet next.
 *
 * These read the stylesheets directly rather than a rendered page, because the
 * properties that matter here are declarations, not computed values, and a
 * declaration is exactly what a later edit would remove. The rendered-page
 * checks that complement these live in `pages.test.ts`.
 *
 * Every number below was measured in a real browser at 390x844 before it was
 * written down. The 44px figure is the long-standing touch-target minimum; the
 * 16px figure is the point below which iOS Safari zooms the viewport when a
 * field takes focus, which cannot be undone by the reader.
 */

const ROOT = process.cwd()

function css(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
}

const GLOBALS = css('app/globals.css')
const REVIEW = css('app/review/review.css')
const LOGIN = css('app/review/login/login.css')
const ADMIN = css('app/admin/admin.css')

/** The declarations inside one top-level rule, by exact selector. */
function block(source: string, selector: string): string {
  const index = source.indexOf(`\n${selector} {`)
  assert.notEqual(index, -1, `no rule for "${selector}"`)
  const start = source.indexOf('{', index)
  const end = source.indexOf('}', start)
  assert.notEqual(end, -1, `unterminated rule for "${selector}"`)
  return source.slice(start + 1, end)
}

/**
 * A length declaration resolved to px, wherever it appears in a block.
 *
 * `rem` counts. The root font size is the browser's default 16px and this
 * project never changes it, so `1rem` and `16px` are the same declaration
 * written two ways; a test that accepted only one would be asserting a coding
 * style rather than a size.
 */
function len(declarations: string, property: string): number {
  const match = declarations.match(new RegExp(`(?:^|;|\\s)${property}:\\s*([0-9.]+)(px|rem)`))
  assert.ok(match, `"${property}" is not declared as a length here`)
  return match[2] === 'rem' ? Number(match[1]) * 16 : Number(match[1])
}

/** The tappable height of a control, however the stylesheet spells it. */
function tapHeight(declarations: string): number {
  const min = declarations.match(/min-height:\s*([0-9.]+)(px|rem)/)
  const fixed = declarations.match(/(?:^|;|\s)height:\s*([0-9.]+)(px|rem)/)
  const match = min ?? fixed
  assert.ok(match, 'no height is declared for this control')
  return match[2] === 'rem' ? Number(match[1]) * 16 : Number(match[1])
}

/* -------------------------------------------------------------- targets */

test('every tapped control in the reader is at least 44px tall', () => {
  // The two controls a reviewer actually uses, in the middle of running prose,
  // where a mis-tap closes the row instead of doing what was meant.
  assert.ok(tapHeight(block(REVIEW, '.rv-para-btn')) >= 44)
  // The one thing in the fixed dock a thumb is aimed at.
  assert.ok(tapHeight(block(REVIEW, '.rv-dock-cta')) >= 44)
  assert.ok(tapHeight(block(REVIEW, '.rv-icon-btn')) >= 44)
  // The gate is the first control a reviewer ever touches.
  assert.ok(tapHeight(block(LOGIN, '.rv-gate .rv-code')) >= 44)
})

test('every tapped control in the dashboard is at least 44px tall', () => {
  assert.ok(tapHeight(block(ADMIN, '.ad-btn')) >= 44)
  // "Small" is about width and type. It is never about the target: these are
  // New code, Rename and Revoke.
  assert.ok(tapHeight(block(ADMIN, '.ad-btn--small')) >= 44)
  // A checkbox is ~18px. The whole row is the target, not the box.
  assert.ok(tapHeight(block(ADMIN, '.ad-book')) >= 44)
  assert.ok(tapHeight(block(ADMIN, '.ad-input')) >= 44)
})

test('no text field is small enough to make iOS zoom the page', () => {
  assert.ok(len(block(ADMIN, '.ad-input'), 'font-size') >= 16)
  assert.ok(len(block(REVIEW, '.rv-textarea'), 'font-size') >= 16)
  assert.ok(len(block(LOGIN, '.rv-gate .rv-code'), 'font-size') >= 16)
})

/* ------------------------------------------------------------ safe areas */

test('the site asks for the safe-area insets it depends on', () => {
  // Every `env(safe-area-inset-*)` in these stylesheets resolves to 0px unless
  // the viewport meta carries `viewport-fit=cover`. It was missing, so the
  // reader's dock sat under the home indicator on a notched phone and the
  // padding that was supposed to prevent it did nothing at all.
  for (const [name, layout] of [
    ['root', 'app/layout.tsx'],
    ['site', 'app/(site)/layout.tsx'],
    ['admin', 'app/admin/layout.tsx'],
  ] as const) {
    const source = readFileSync(join(ROOT, layout), 'utf8')
    assert.match(source, /viewportFit:\s*['"]cover['"]/, `${name} layout must set viewportFit`)
  }
})

test('both sticky bars clear the top inset, and the dock clears the bottom one', () => {
  // With `viewport-fit=cover` on, content runs under the notch. These two are
  // the first thing on the screen, so they are what would run under it.
  assert.match(block(REVIEW, '.rv-bar'), /env\(safe-area-inset-top/)
  assert.match(block(GLOBALS, '.ms-header'), /env\(safe-area-inset-top/)

  // And these are what would be swallowed by the home indicator.
  assert.match(block(REVIEW, '.rv-dock'), /env\(safe-area-inset-bottom/)
  assert.match(block(REVIEW, '.rv-sheet'), /env\(safe-area-inset-bottom/)
  assert.match(block(ADMIN, '.ad-sheet'), /env\(safe-area-inset-bottom/)
  assert.match(block(ADMIN, '.ad-shell'), /env\(safe-area-inset-bottom/)
})

test('the reader measures its sticky bar rather than assuming a height', () => {
  // The bar is `--rv-bar-h` plus the top inset, so a hard-coded 64 would scroll
  // a bookmarked paragraph to a spot partly underneath it.
  const reader = readFileSync(join(ROOT, 'app/review/[book]/[chapter]/ChapterReader.tsx'), 'utf8')
  assert.match(reader, /function headerOffset\(\)/)
  assert.match(reader, /querySelector<HTMLElement>\('\.rv-bar'\)/)
  // Nothing still reaches for the constant directly except the fallback.
  const uses = reader.match(/HEADER_OFFSET/g) ?? []
  assert.equal(uses.length, 2, 'HEADER_OFFSET should survive only as the declared fallback')
})

/* ------------------------------------------------------- no sideways page */

test('nothing in the dashboard may widen the viewport', () => {
  // Long addresses and long slugs are the usual culprits.
  assert.match(block(ADMIN, '.ad-root'), /overflow-x:\s*hidden/)
  for (const selector of ['.ad-email', '.ad-name', '.ad-book', '.ad-code']) {
    assert.match(
      block(ADMIN, selector),
      /overflow-wrap:\s*anywhere/,
      `${selector} must wrap rather than push`,
    )
  }
  // The bar's title is the other way a narrow screen breaks: it must give way
  // to the sign-out button rather than shove it off the edge.
  assert.match(block(ADMIN, '.ad-bar-title'), /min-width:\s*0/)
})

/* --------------------------------------------------------- reduced motion */

test('every stylesheet that animates also answers prefers-reduced-motion', () => {
  for (const [name, source] of [
    ['globals.css', GLOBALS],
    ['review.css', REVIEW],
    ['login.css', LOGIN],
  ] as const) {
    if (!/animation:|transition:/.test(source)) continue
    assert.match(
      source,
      /@media \(prefers-reduced-motion: reduce\)/,
      `${name} animates but never answers prefers-reduced-motion`,
    )
  }
})

/* -------------------------------------------------------- hover is never it */

test('nothing is revealed by hover alone on a phone', () => {
  /*
   * The reader does reveal a paragraph's controls on hover -- but only inside
   * the wide-viewport block, where a tap reveals them too. On a narrow screen
   * the rule is `display: none` until the paragraph is opened by tapping it.
   *
   * This asserts the shape that makes that safe: the `opacity: 0` that hover
   * undoes lives after the wide breakpoint, and the tap-driven class is always
   * listed alongside `:hover` wherever `:hover` reveals something.
   */
  const wideAt = REVIEW.indexOf('@media (min-width: 768px)')
  assert.notEqual(wideAt, -1)

  // `exec` in a loop rather than spreading `matchAll`: this project's tsconfig
  // sets no `target`, so iterating the iterator would not compile.
  const pattern = /([^{}]*:hover[^{}]*)\{([^}]*)\}/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(REVIEW)) !== null) {
    const [, selector, body] = match
    if (!/opacity:|visibility:|display:/.test(body)) continue

    assert.ok(match.index > wideAt, `a hover reveal sits outside the wide block: ${selector.trim()}`)
    assert.match(
      selector,
      /rv-para--open|rv-para--active|focus-within/,
      `hover must not be the only way to reach: ${selector.trim()}`,
    )
  }
})
