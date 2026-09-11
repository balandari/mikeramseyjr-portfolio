import test from 'node:test'
import assert from 'node:assert/strict'

import { isSameOriginPath, sameOriginPathOrRoot } from '../lib/same-origin-path.ts'

/*
 * The bug these exist to prevent, in one sentence:
 *
 *   A reviewer on a phone entered a valid access code over
 *   http://192.168.1.111:3000 and was redirected to http://0.0.0.0:3000/review,
 *   which no device can connect to.
 *
 * The cause was every redirect being built as `new URL(path, request.url)`,
 * which is only ever as correct as the origin it derives -- and with the dev
 * server bound to all interfaces, `request.url` says `0.0.0.0`. The fix is to
 * name no origin at all: a relative `Location` is resolved by the browser
 * against the URL that actually reached the server.
 */

/** The host from Mike's screenshot. */
const LAN = '192.168.1.111:3000'

test('a redirect target names no origin at all', () => {
  const target = sameOriginPathOrRoot('/review')

  assert.equal(target, '/review')
  // The three ways an origin could sneak back in.
  assert.ok(!target.includes('://'))
  assert.ok(!target.includes('0.0.0.0'))
  assert.ok(!target.includes(LAN))
})

test('a destination that could leave this origin is refused', () => {
  /*
   * `safeReviewPath` and `safeAdminPath` already constrain these before they
   * arrive. This is the second, independent refusal -- the one that means a
   * mistake upstream cannot turn a sign-in into an open redirect.
   */
  for (const hostile of [
    'https://evil.test/review',
    'http://evil.test',
    '//evil.test',
    '//192.168.1.111:3000/review',
    '/\\evil.test',
    'review',
    '',
  ]) {
    assert.equal(isSameOriginPath(hostile), false, `${hostile} should be refused`)
    assert.equal(
      sameOriginPathOrRoot(hostile),
      '/',
      `${hostile} should collapse to the site root`,
    )
  }
})

test('ordinary internal paths, including queries and fragments, are kept intact', () => {
  for (const path of [
    '/review',
    '/review/the-backward-becoming/chapter-one',
    '/review/login?error=1&next=%2Freview',
    '/admin/login?signedout=1',
    '/review/the-backward-becoming/chapter-one#chapter-one-p012',
  ]) {
    assert.equal(isSameOriginPath(path), true, `${path} should be allowed`)
    assert.equal(sameOriginPathOrRoot(path), path)
  }
})

test('null and non-strings fail closed rather than throwing', () => {
  assert.equal(isSameOriginPath(null), false)
  assert.equal(isSameOriginPath(undefined), false)
  assert.equal(isSameOriginPath(42 as unknown as string), false)
})

/*
 * The response-level behaviour -- the status code, the private headers, and the
 * `Location` a browser actually receives -- is asserted end to end against the
 * real production server, over the LAN host from Mike's screenshot, in
 * `tests/pages.test.ts`. It is not re-stated here: this module is the pure
 * decision, and that one is the wire.
 */
