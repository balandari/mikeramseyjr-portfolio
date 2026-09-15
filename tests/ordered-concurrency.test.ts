import test from 'node:test'
import assert from 'node:assert/strict'

import { ORDERED_READ_CONCURRENCY, mapOrderedLimited } from '../lib/ordered-concurrency.ts'

/*
 * The mapper on its own, away from any store.
 *
 * It has three promises and they are all assertable without pretending to be a
 * network: never more than `limit` calls in flight, output in input order
 * whatever order the calls settle in, and a rejection that rejects rather than
 * being smoothed into a shorter list. The call sites in
 * `tests/refresh-concurrency.test.ts` then prove those promises survive the
 * journey into `listAudit`, `listRequests` and `loadRequestViews`.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** `0 .. n - 1`, without an iterator this project's target cannot spread. */
const upTo = (n: number): number[] => Array.from({ length: n }, (_unused, index) => index)

/**
 * A promise plus its own settle functions, so a test can decide exactly when
 * and in what order a call resolves or rejects instead of racing timers.
 */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Counts genuine overlap, and remembers the order calls actually settled in. */
function meter() {
  let inFlight = 0
  let peak = 0
  const settled: number[] = []
  return {
    get peak(): number {
      return peak
    },
    settled,
    async call<T>(index: number, delayMs: number, produce: () => T): Promise<T> {
      inFlight += 1
      if (inFlight > peak) peak = inFlight
      await sleep(delayMs)
      inFlight -= 1
      settled.push(index)
      return produce()
    },
  }
}

test('the authorised fan-out is exactly eight', () => {
  assert.equal(ORDERED_READ_CONCURRENCY, 8)
})

test('an empty input is an empty answer and no work at all', async () => {
  let calls = 0
  const answer = await mapOrderedLimited([], ORDERED_READ_CONCURRENCY, async () => {
    calls += 1
    return 1
  })
  assert.deepEqual(answer, [])
  assert.equal(calls, 0)
})

test('never more than the limit is in flight', async () => {
  const items = upTo(40)
  const track = meter()

  await mapOrderedLimited(items, ORDERED_READ_CONCURRENCY, (item, index) =>
    track.call(index, 4, () => item),
  )

  assert.equal(track.peak, ORDERED_READ_CONCURRENCY)
})

test('a smaller limit is honoured just as exactly', async () => {
  const track = meter()
  await mapOrderedLimited(upTo(20), 3, (item, index) => track.call(index, 3, () => item))
  assert.equal(track.peak, 3)
})

test('fewer items than the limit start fewer calls, not more', async () => {
  const track = meter()
  await mapOrderedLimited(upTo(5), ORDERED_READ_CONCURRENCY, (item, index) =>
    track.call(index, 3, () => item),
  )
  assert.equal(track.peak, 5)
})

test('the answer is in input order however the calls settle', async () => {
  const items = upTo(24)
  const track = meter()

  // The first call of every group of eight waits longest, so the group settles
  // backwards and the settle order can never coincide with the input order.
  const answer = await mapOrderedLimited(items, ORDERED_READ_CONCURRENCY, (item, index) =>
    track.call(index, (ORDERED_READ_CONCURRENCY - (index % ORDERED_READ_CONCURRENCY)) * 4, () =>
      item * 10,
    ),
  )

  assert.notDeepEqual(track.settled, items, 'the calls settled in order, so this proves nothing')
  assert.deepEqual(
    answer,
    items.map((item) => item * 10),
  )
})

test('the index handed to the mapper is the input index', async () => {
  const seen: Array<[string, number]> = []
  await mapOrderedLimited(['a', 'b', 'c'], 2, async (item, index) => {
    await sleep(index === 0 ? 8 : 1)
    seen.push([item, index])
    return index
  })
  assert.deepEqual(new Map(seen), new Map([['a', 0], ['b', 1], ['c', 2]]))
})

test('a rejection rejects, and is not smoothed into a shorter answer', async () => {
  const boom = new Error('store unavailable')
  await assert.rejects(
    () =>
      mapOrderedLimited(upTo(20), ORDERED_READ_CONCURRENCY, async (item) => {
        if (item === 13) throw boom
        return item
      }),
    (error: unknown) => error === boom,
  )
})

test('a mapper that throws before it ever returns a promise still rejects', async () => {
  await assert.rejects(
    () =>
      mapOrderedLimited([1, 2, 3], 2, (item) => {
        if (item === 2) throw new Error('thrown synchronously')
        return Promise.resolve(item)
      }),
    /thrown synchronously/,
  )
})

test('nothing new is started once a call has failed', async () => {
  const started: number[] = []
  await assert.rejects(
    () =>
      mapOrderedLimited(upTo(10), 1, async (item) => {
        started.push(item)
        if (item === 3) throw new Error('store unavailable')
        return item
      }),
    /store unavailable/,
  )
  // One at a time, so the fourth call is the last one that can have begun.
  assert.deepEqual(started, [0, 1, 2, 3])
})

test('no index beyond the already-in-flight window starts once a failure is observed', async () => {
  // Resolver-controlled, concurrency four: this is the case `limit: 1` cannot
  // exercise, because with one worker the catch block's own return already
  // stops the loop before the post-failure guard is ever reached.
  const limit = 4
  const started: number[] = []
  const controls = new Map<number, ReturnType<typeof deferred<number>>>()

  const resultPromise = mapOrderedLimited(upTo(20), limit, (item, index) => {
    started.push(index)
    if (index < limit) {
      const control = deferred<number>()
      controls.set(index, control)
      return control.promise
    }
    // Anything claimed beyond the initial in-flight batch settles at once, so
    // a missing guard shows up as an extra `started` entry rather than a
    // worker left waiting on a control nobody will ever resolve.
    return Promise.resolve(item)
  })

  // The initial batch of workers claims its indices synchronously, before the
  // call above even returns control here.
  assert.deepEqual(started, [0, 1, 2, 3])

  controls.get(1)!.reject(new Error('store unavailable'))
  await Promise.resolve()
  // Let the rest of the in-flight batch settle. If the guard were removed,
  // each of these would loop back around and claim index 4, 5, 6...
  controls.get(0)!.resolve(0)
  controls.get(2)!.resolve(2)
  controls.get(3)!.resolve(3)

  await assert.rejects(() => resultPromise, /store unavailable/)
  assert.deepEqual(started, [0, 1, 2, 3])
})

test('when two calls fail, the lowest index is the one reported', async () => {
  const early = new Error('the later item, failing first')
  const lowest = new Error('the earlier item, failing second')

  await assert.rejects(
    () =>
      mapOrderedLimited(upTo(8), ORDERED_READ_CONCURRENCY, async (item) => {
        if (item === 5) {
          await sleep(4)
          throw early
        }
        if (item === 2) {
          await sleep(40)
          throw lowest
        }
        return item
      }),
    (error: unknown) => error === lowest,
  )
})

test('when a lower index fails first and a higher index fails later, the lower index still wins', async () => {
  // The mirror of the case above: here the lowest index is also the first to
  // fail, so this is the only case that can tell "lowest index wins" apart
  // from "last observed failure wins".
  const lowest = new Error('the earlier index, failing first')
  const later = new Error('the later index, failing second')
  const controls = new Map<number, ReturnType<typeof deferred<number>>>()

  const resultPromise = mapOrderedLimited(upTo(8), ORDERED_READ_CONCURRENCY, (_item, index) => {
    const control = deferred<number>()
    controls.set(index, control)
    return control.promise
  })

  controls.get(2)!.reject(lowest)
  await Promise.resolve()
  controls.get(5)!.reject(later)
  await Promise.resolve()
  controls.forEach((control, index) => {
    if (index !== 2 && index !== 5) control.resolve(index)
  })

  await assert.rejects(() => resultPromise, (error: unknown) => error === lowest)
})

test('a limit that is not a positive integer is refused outright', async () => {
  for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      () => mapOrderedLimited([1, 2, 3], limit, async (item) => item),
      (error: unknown) => error instanceof RangeError,
      `limit ${String(limit)} should have been refused`,
    )
  }
})
