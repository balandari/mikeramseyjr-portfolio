import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/*
 * The leaving path, asserted in the source.
 *
 * These are deliberately source-level, and that is a limitation worth saying
 * out loud rather than dressing up: what they establish is that the code is
 * wired the way the repair requires -- the order of two calls, the events that
 * are listened for, the handler on a link. What they cannot establish is what a
 * phone actually does with a page that is being torn down, which is the whole
 * difficulty of this area and is why Mike's Android Back checklist stays a
 * human acceptance test.
 *
 * `tests/mobile.test.ts` and `tests/motion.test.ts` read this same file the
 * same way, for the same reason, so this is the house style for a claim about
 * a component no test in this project can mount.
 */

const ROOT = process.cwd()

function source(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
}

const READER = source('app/review/[book]/[chapter]/ChapterReader.tsx')
const CARD = source('app/review/ResumeCard.tsx')

/**
 * A component with its prose removed.
 *
 * These files explain themselves at length, and a comment that *names* the
 * thing it refuses to do would otherwise read as the thing being done. What is
 * being asserted is the code.
 */
function code(component: string): string {
  return component.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** Every `<Link …>` opening tag in a component, as its raw text. */
function linkTags(component: string): string[] {
  const tags: string[] = []
  let index = component.indexOf('<Link')
  while (index !== -1) {
    const end = component.indexOf('>', index)
    if (end === -1) break
    tags.push(component.slice(index, end + 1))
    index = component.indexOf('<Link', end)
  }
  return tags
}

test('every link out of the reader takes the place before it begins navigating', () => {
  const leaving = linkTags(READER).filter(
    (tag) => tag.includes('bookBase') || tag.includes('workspaceHref'),
  )

  assert.ok(leaving.length >= 8, `expected the reader's navigation links, found ${leaving.length}`)
  for (const tag of leaving) {
    assert.match(
      tag,
      /onPointerDown=\{captureBeforeLeaving\}/,
      `a link out of the reader must capture the place first:\n${tag}`,
    )
  }
})

test('capturing takes the same measurement the leave flush takes', () => {
  // Not a second implementation of "where is the reader": the same one, a beat
  // earlier, while the chapter is still laid out and nothing has moved.
  assert.match(
    READER,
    /const captureBeforeLeaving = useCallback\(\(\) => \{\s*flushRef\.current\(\)\s*\}, \[\]\)/,
  )
})

test('the local record is written before the place is handed to the browser', () => {
  const leave = READER.slice(READER.indexOf('function onLeave()'))
  const persist = leave.indexOf('persistPending(')
  const beacon = leave.indexOf('beaconPosition(')

  assert.ok(persist > -1, 'the leave flush must write the device-local record')
  assert.ok(beacon > -1, 'the leave flush must still hand the place to the browser')
  assert.ok(
    persist < beacon,
    'the local record must be written first: `sendBeacon` means queued, not stored, and the ' +
      'page it was queued from is about to stop existing',
  )
})

test('the leave flush is still reached by every way out of a chapter', () => {
  for (const wiring of [
    "window.addEventListener('pagehide', onLeave)",
    "window.addEventListener('popstate', onLeave)",
    "document.addEventListener('visibilitychange', onHide)",
    'flushRef.current = onLeave',
  ]) {
    assert.ok(READER.includes(wiring), `the leave flush lost its wiring: ${wiring}`)
  }
  // Hidden is the half that matters; coming back must not write anything.
  assert.match(READER, /if \(document\.visibilityState === 'hidden'\) onLeave\(\)/)
})

test('the contents menu still replaces rather than pushing', () => {
  /*
   * Accepted behaviour, re-asserted because this pass added a handler to the
   * same links. Pushing would walk a reviewer back through every chapter they
   * sampled instead of out of the book, which Mike reported and which was
   * fixed before this repair existed.
   */
  const toc = READER.slice(READER.indexOf("<Sheet open={sheet === 'contents'}"))
  const entry = toc.slice(toc.indexOf('<Link'), toc.indexOf('</Link>'))
  assert.match(entry, /href=\{`\$\{bookBase\}\/\$\{entry\.slug\}`\}/)
  assert.match(entry, /\breplace\b/)
  assert.match(entry, /onPointerDown=\{captureBeforeLeaving\}/)
})

test('sub-paragraph restoration is intact, on arrival and on confirmation', () => {
  // The resume scroll still carries the offset, which is what puts a reader
  // back on their line rather than at the paragraph's first one.
  assert.match(
    READER,
    /scrollToParagraph\(mark, 'auto', initial\.position\?\.paragraphOffset \?\? 0\)/,
  )
  // And so does the correction the arrival check makes.
  assert.match(READER, /scrollToParagraph\(truth\.paragraphId, 'auto', offset\)/)
  // The offset is still measured and still sent.
  assert.match(READER, /pendingOffsetRef\.current = past < 0 \? 0 : past > 1 \? 1 : past/)
})

test('the resume link still carries no fragment', () => {
  /*
   * A fragment is an explicit request for a paragraph, and a chapter honours it
   * over the saved place -- which is finer than a paragraph. Accepted repair,
   * re-asserted because this card was rewritten.
   */
  assert.match(CARD, /const href = `\$\{base\}\/\$\{shown\.bookSlug\}\/\$\{shown\.chapterSlug\}`/)
  assert.ok(!CARD.includes('#${'), 'the resume link must not carry a paragraph fragment')
})

test('the card corrects itself without refreshing the route', () => {
  /*
   * `router.refresh()` would re-render the whole page to fix one line, throwing
   * away the cached document the reviewer is looking at -- and with it the
   * scroll position the router restored for them, which is the cost the
   * accepted work already refused to pay once.
   */
  const body = code(CARD)
  assert.ok(!body.includes('useRouter'), 'the card must not reach for the router')
  assert.ok(!body.includes('router.refresh'), 'the card must not refresh the route')
  assert.ok(body.includes('fetchReading('), 'the card corrects itself with one small request')
})

test('the client router cache is left exactly as it is', () => {
  /*
   * Turning it off for dynamic routes fixed the stale card once and cost the
   * restored scroll position of the page being returned to: Mike came back to
   * the bottom of his library. It must not come back by accident.
   */
  const config = code(source('next.config.mjs'))
  assert.ok(!config.includes('staleTimes'), 'staleTimes must not be reintroduced')
})
