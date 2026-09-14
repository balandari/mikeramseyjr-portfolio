import test from 'node:test'
import assert from 'node:assert/strict'

import {
  NOTHING_SENT,
  afterOutcome,
  alreadyOnRecord,
  mayHandOver,
  savePosition,
  savePositionQuietly,
} from '../app/review/reading-client.ts'

/*
 * `savePositionQuietly` must never report a save the server did not make.
 *
 * It used to `await` the request inside a `try` and return `void`, which threw
 * away a `401`, a `500` and a `503` exactly as thoroughly as it threw away a
 * dropped connection. The caller had nothing to go on and the reader was told
 * their place was kept regardless.
 *
 * `fetch` is stubbed here rather than a server being started: the question is
 * how this function reads a response, not whether the route works. The route is
 * covered elsewhere, and the end-to-end behaviour was driven in a browser.
 */

const ENDPOINT = { url: '/review/api/reading' }
const PASSAGE = {
  bookSlug: 'the-backward-becoming',
  chapterSlug: 'chapter-one',
  paragraphId: 'chapter-one-p042',
}

const realFetch = globalThis.fetch

function stubFetch(handler: () => Response | Promise<Response>) {
  globalThis.fetch = (async () => handler()) as typeof globalThis.fetch
}

test.afterEach(() => {
  globalThis.fetch = realFetch
})

test('a 2xx is the only thing reported as stored', async () => {
  for (const status of [200, 201, 204]) {
    stubFetch(() => new Response(null, { status }))
    assert.equal(await savePositionQuietly(ENDPOINT, PASSAGE), 'stored')
  }
})

test('a refusal is reported as a refusal, never as a save', async () => {
  for (const status of [400, 401, 403, 404, 500, 503]) {
    stubFetch(() => new Response(JSON.stringify({ error: 'nope' }), { status }))
    const result = await savePositionQuietly(ENDPOINT, PASSAGE)
    assert.equal(result, 'refused', `HTTP ${status} must not read as a save`)
    assert.notEqual(result, 'stored')
  }
})

test('a network failure is reported, not swallowed', async () => {
  globalThis.fetch = (async () => {
    throw new TypeError('Failed to fetch')
  }) as typeof globalThis.fetch
  assert.equal(await savePositionQuietly(ENDPOINT, PASSAGE), 'unreachable')
})

test('it still never throws at the caller, however the request ends', async () => {
  globalThis.fetch = (async () => {
    throw new Error('anything at all')
  }) as typeof globalThis.fetch
  // Quiet is preserved: reading is not interrupted by a rejected promise.
  await assert.doesNotReject(() => savePositionQuietly(ENDPOINT, PASSAGE))
})

test('the request it sends is the position operation, and carries the passage', async () => {
  const seen: { url: string; body: Record<string, unknown> }[] = []
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), body: JSON.parse(String(init.body)) })
    return new Response(null, { status: 200 })
  }) as unknown as typeof globalThis.fetch

  await savePositionQuietly(ENDPOINT, PASSAGE)

  assert.equal(seen.length, 1)
  const sent = seen[0]
  assert.equal(sent.url, '/review/api/reading')
  assert.equal(sent.body.op, 'position')
  assert.equal(sent.body.bookSlug, PASSAGE.bookSlug)
  assert.equal(sent.body.chapterSlug, PASSAGE.chapterSlug)
  assert.equal(sent.body.paragraphId, PASSAGE.paragraphId)
})

/*
 * What a caller needs to know before deciding to try again.
 *
 * `savePositionQuietly` above answers "did it save", and the tests for it are
 * unchanged. These cover the richer report the reader now uses, and the guard
 * that decides whether a place is worth sending at all -- which is where the
 * suppression defect lived: a place was marked written the moment a request
 * *started*, so a refused or dropped save silently disabled the flush that
 * would have rescued it.
 */

test('a failure that trying again could fix is marked as such, and one that cannot is not', async () => {
  for (const status of [500, 502, 503, 504]) {
    stubFetch(() => new Response(JSON.stringify({ error: 'oh dear' }), { status }))
    const report = await savePosition(ENDPOINT, PASSAGE)
    assert.equal(report.result, 'refused', `HTTP ${status}`)
    assert.equal(report.retryable, true, `HTTP ${status} is worth another attempt`)
    assert.equal(report.status, status)
  }

  for (const status of [400, 401, 403, 404]) {
    stubFetch(() => new Response(JSON.stringify({ error: 'no' }), { status }))
    const report = await savePosition(ENDPOINT, PASSAGE)
    assert.equal(report.result, 'refused', `HTTP ${status}`)
    assert.equal(
      report.retryable,
      false,
      `HTTP ${status} will refuse the identical request identically, for ever`,
    )
  }
})

test('a request that never arrived is retryable, because nothing refused it', async () => {
  globalThis.fetch = (async () => {
    throw new TypeError('Failed to fetch')
  }) as typeof globalThis.fetch

  const report = await savePosition(ENDPOINT, PASSAGE)
  assert.equal(report.result, 'unreachable')
  assert.equal(report.retryable, true)
  assert.equal(report.status, null)
})

test('the ordering metadata is carried, and a stale answer is reported as stale', async () => {
  const sent: Record<string, unknown>[] = []
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)))
    return new Response(
      JSON.stringify({
        ok: true,
        stale: true,
        position: { chapterSlug: 'chapter-three', device: 'a1b2c3d4e5f60718', sequence: 11 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof globalThis.fetch

  const report = await savePosition(ENDPOINT, {
    ...PASSAGE,
    device: 'a1b2c3d4e5f60718',
    sequence: 10,
  })

  assert.equal(sent[0].device, 'a1b2c3d4e5f60718')
  assert.equal(sent[0].sequence, 10)
  // Not a failure: the server holds something newer from this same device.
  assert.equal(report.result, 'stored')
  assert.equal(report.stale, true)
  assert.equal(report.position?.chapterSlug, 'chapter-three')
})

test('a 2xx whose body cannot be read is still a save, and claims nothing more', async () => {
  stubFetch(() => new Response('not json at all', { status: 200 }))
  const report = await savePosition(ENDPOINT, PASSAGE)
  assert.equal(report.result, 'stored')
  assert.equal(report.stale, false)
  assert.equal(report.position, null)
})

test('duplicate suppression tells "on its way" apart from "on record"', () => {
  const key = 'chapter-three-p042@62'
  const other = 'chapter-three-p051@10'

  // Nothing sent: worth sending.
  assert.equal(mayHandOver(key, NOTHING_SENT), true)

  // In flight: not worth sending again, and not yet a save.
  const flying = { confirmed: null, inFlight: key }
  assert.equal(mayHandOver(key, flying), false)
  assert.equal(mayHandOver(other, flying), true)

  // Stored: not worth sending again, for the right reason this time.
  const stored = afterOutcome(flying, key, true)
  assert.deepEqual(stored, { confirmed: key, inFlight: null })
  assert.equal(mayHandOver(key, stored), false)

  /*
   * And the case the whole separation exists for: a failed attempt releases the
   * place. It was sent, it did not land, and the next settle, ceiling or flush
   * on the way out must be free to send it -- which under the old single flag
   * it was not.
   */
  const failed = afterOutcome({ confirmed: null, inFlight: key }, key, false)
  assert.deepEqual(failed, { confirmed: null, inFlight: null })
  assert.equal(mayHandOver(key, failed), true, 'a failed save must not suppress its own rescue')

  // A failure for an older attempt does not release a newer flight.
  const newerFlying = afterOutcome({ confirmed: null, inFlight: other }, key, false)
  assert.equal(newerFlying.inFlight, other)

  // A place the server reports holding is confirmed without this browser
  // sending anything, which is how the arrival check settles it.
  const told = alreadyOnRecord(NOTHING_SENT, key)
  assert.equal(mayHandOver(key, told), false)
})
