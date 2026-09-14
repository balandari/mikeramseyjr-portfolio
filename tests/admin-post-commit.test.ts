import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  REFRESH_DEADLINE_MS,
  REFRESH_FAILED,
  REFRESH_TIMED_OUT,
  publicAdminView,
  requestMutationBody,
  reviewerMutationBody,
} from '../lib/admin-response.ts'
import type { AdminView } from '../lib/reviewer-admin.ts'

/*
 * "The write succeeded and the reread did not."
 *
 * Both admin endpoints used to perform their mutation and then, inside the same
 * `try`, reread the whole dashboard. A transient store failure on that reread --
 * after the write had already committed -- fell through to the outer `catch` and
 * answered `500 ... Nothing was changed.` For `create` and `replace-code` that
 * destroyed the only plaintext copy of a code whose verifier was already stored,
 * and told Mike to press the button again.
 *
 * `lib/admin-response.ts` is that ordering made structural, and this is the
 * fault injection: the loader throws, and the committed result must still be
 * there, still be reported as a success, and be distinguishable from a mutation
 * that never happened.
 *
 * Ordering alone was not enough. A reread that *rejects* reaches the `catch`
 * and the response is composed; a reread that never settles reaches nothing at
 * all, and `await refresh()` holds the invocation open until the platform kills
 * it -- which sends no response whatsoever, losing the same code by a different
 * road. So the refresh is raced against a deadline, and the deadline is a
 * failed refresh like any other. That case is covered here at the composer, and
 * through the real POST handlers in `tests/admin-route-boundary.test.ts`.
 *
 * The two routes are covered by covering the exact composition each of them now
 * calls, plus an assertion that each route file actually calls it.
 */

const ROOT = process.cwd()

/** A reread that fails the way a store having a bad minute fails. */
function failingLoader<T>(): () => Promise<T> {
  return async () => {
    throw new Error('the store could not be read')
  }
}

function aView(): AdminView {
  return {
    driver: 'vercel-blob',
    writable: true,
    updatedAt: '2026-09-13T00:00:00.000Z',
    reviewers: [
      {
        id: 'anna',
        name: 'Anna',
        email: 'anna@example.com',
        books: ['the-backward-becoming'],
        status: 'active',
        codeHash: 'a-keyed-fingerprint-nobody-outside-needs',
        createdAt: '2026-01-01T00:00:00.000Z',
        codeUpdatedAt: '2026-01-01T00:00:00.000Z',
        lastAccessAt: null,
        emailVerifiedAt: null,
        credentialEpoch: 0,
        origin: 'admin',
        requestId: null,
      },
    ],
    audit: [],
    books: ['the-backward-becoming'],
  }
}

/* ------------------------------------------------ /admin/api/reviewers */

test('a committed reviewer mutation whose reread fails is still a success', async () => {
  const body = await reviewerMutationBody({ issued: null }, failingLoader<AdminView>())

  assert.equal(body.ok, true, 'the mutation committed, so the answer is a success')
  assert.equal(body.refreshed, false, 'and it says plainly that the view beside it is stale')
  assert.equal(body.refreshError, REFRESH_FAILED)
  assert.equal('view' in body, false, 'no half-built view is invented to fill the gap')
})

test('the one-time access code survives a reread that fails', async () => {
  /*
   * The damaging case, exactly. The verifier is already on the roster; this
   * string is the only copy of the code in existence and it exists only in this
   * response. Losing it here is not a retryable error -- it is an account Mike
   * can never hand over.
   */
  const issued = { reviewerId: 'anna', name: 'Anna', code: 'ABCD-EFGH-JKMN' }

  const body = await reviewerMutationBody({ issued }, failingLoader<AdminView>())

  assert.equal(body.ok, true)
  assert.equal(body.refreshed, false)
  assert.deepEqual(body.issued, issued, 'the code is in the response Mike is about to be shown')
  assert.ok(
    JSON.stringify(body).includes('ABCD-EFGH-JKMN'),
    'and it is really in the bytes, not merely in a field name',
  )
})

test('a code is delivered exactly once: never by the refresh, and never again', async () => {
  const issued = { reviewerId: 'anna', name: 'Anna', code: 'ABCD-EFGH-JKMN' }

  const first = await reviewerMutationBody({ issued }, async () => aView())
  assert.equal(first.refreshed, true)
  assert.deepEqual(first.issued, issued)

  // The very next refresh -- any later action, or the same one retried -- has no
  // committed code of its own, and the view can never supply one.
  const second = await reviewerMutationBody({}, async () => aView())
  assert.equal('issued' in second, false)
  assert.ok(
    !JSON.stringify(second).includes('ABCD-EFGH-JKMN'),
    'nothing the dashboard re-reads can reproduce a spent code',
  )
})

test('the refreshed view never carries a code fingerprint', async () => {
  const body = await reviewerMutationBody({}, async () => aView())

  assert.equal(body.refreshed, true)
  assert.ok(
    !JSON.stringify(body).includes('a-keyed-fingerprint-nobody-outside-needs'),
    'codeHash is stripped before the browser sees the roster',
  )

  const view = publicAdminView(aView())
  const reviewers = view.reviewers as Record<string, unknown>[]
  assert.equal('codeHash' in reviewers[0], false)
  assert.equal(reviewers[0].emailVerifiedAt, null, 'and the fields that do belong are kept')
})

/* ------------------------------------------------- /admin/api/requests */

test('a committed request action whose reread fails is still a success', async () => {
  const delivery = { status: 'accepted', providerId: 'm-1', error: null }

  const body = await requestMutationBody(
    { delivery, reviewerId: 'anna' },
    failingLoader<unknown[]>(),
  )

  assert.equal(body.ok, true, 'the approval committed and the reviewer exists')
  assert.equal(body.refreshed, false)
  assert.equal(body.refreshError, REFRESH_FAILED)
  assert.deepEqual(body.delivery, delivery, 'the mail outcome is not lost with the reread')
  assert.equal(body.reviewerId, 'anna')
  assert.equal('requests' in body, false)
})

test('a request action whose reread succeeds carries the requests', async () => {
  const body = await requestMutationBody({}, async () => [{ id: 'abc', status: 'pending' }])

  assert.equal(body.refreshed, true)
  assert.deepEqual(body.requests, [{ id: 'abc', status: 'pending' }])
})

test('a loader that resolves to nothing is a failed refresh, not an empty dashboard', async () => {
  // A driver answering `null` is a fault, and "there are no reviewers" is a
  // dangerous way to render one.
  const body = await reviewerMutationBody({}, async () => null)
  assert.equal(body.ok, true)
  assert.equal(body.refreshed, false)
  assert.equal('view' in body, false)
})

/* ------------------------------------------------ a reread that never ends */

/** The reread this whole deadline exists for: it never answers, ever. */
function neverSettles<T>(): () => Promise<T> {
  return () => new Promise<T>(() => {})
}

test('a refresh that never settles is abandoned, and the committed code still returns', async () => {
  /*
   * The failure a rejection test cannot reach. Without a deadline this call
   * never resolves -- the test runner would hang and then be killed, which is
   * precisely what the serverless platform does to the real invocation, and a
   * killed invocation sends no response at all.
   */
  const issued = { reviewerId: 'anna', name: 'Anna', code: 'ABCD-EFGH-JKMN' }

  const started = Date.now()
  const body = await reviewerMutationBody({ issued }, neverSettles<AdminView>(), 40)
  const elapsed = Date.now() - started

  assert.equal(body.ok, true, 'the mutation committed, so the answer is a success')
  assert.equal(body.refreshed, false)
  assert.equal(body.refreshError, REFRESH_TIMED_OUT, 'and a stall is named as a stall')
  assert.deepEqual(body.issued, issued)
  assert.ok(JSON.stringify(body).includes('ABCD-EFGH-JKMN'), 'the code is in the bytes')
  assert.ok(elapsed < 2_000, `the deadline did not bound the wait (${elapsed}ms)`)
})

test('a request action whose reread never settles is abandoned the same way', async () => {
  const delivery = { status: 'accepted', providerId: 'm-1', error: null }

  const body = await requestMutationBody({ delivery, reviewerId: 'anna' }, neverSettles<unknown[]>(), 40)

  assert.equal(body.ok, true)
  assert.equal(body.refreshed, false)
  assert.equal(body.refreshError, REFRESH_TIMED_OUT)
  assert.deepEqual(body.delivery, delivery, 'the mail outcome is not lost to a stall either')
  assert.equal('requests' in body, false)
})

test('a slow reread that does answer in time is still a refresh, not a timeout', async () => {
  // The deadline must not turn ordinary latency into a false stale notice.
  const body = await reviewerMutationBody(
    {},
    () => new Promise((resolve) => setTimeout(() => resolve(aView()), 10)),
    500,
  )

  assert.equal(body.refreshed, true)
  assert.ok(body.view, 'a reread that answered inside the deadline is used')
})

test('the deadline is explicit, short, and far below any function deadline', () => {
  assert.equal(typeof REFRESH_DEADLINE_MS, 'number')
  assert.ok(Number.isFinite(REFRESH_DEADLINE_MS) && REFRESH_DEADLINE_MS > 0)
  assert.ok(
    REFRESH_DEADLINE_MS <= 5_000,
    'a post-commit courtesy reread may not approach a function timeout',
  )
  assert.notEqual(REFRESH_TIMED_OUT, REFRESH_FAILED, 'the two causes stay distinguishable')
})

/* ---------------------------------------- and that both routes use it */

test('both admin routes compose their success through this module', () => {
  const reviewers = readFileSync(
    join(ROOT, 'app', 'admin', 'api', 'reviewers', 'route.ts'),
    'utf8',
  )
  const requests = readFileSync(join(ROOT, 'app', 'admin', 'api', 'requests', 'route.ts'), 'utf8')

  assert.match(reviewers, /reviewerMutationBody\(committed, loadAdminView\)/)
  assert.match(requests, /requestMutationBody\(committed, async \(\) =>/)

  // And the reread is outside the catch that produces a refusal: the mutation
  // assigns `committed` and the success is composed after the `catch` block.
  for (const [name, source] of [
    ['reviewers', reviewers],
    ['requests', requests],
  ] as const) {
    const commit = source.indexOf('let committed: Record<string, unknown>')
    const caught = source.indexOf('} catch (error) {', commit)
    const answered = source.indexOf('return await ok(committed)', caught)
    assert.ok(commit > 0, `${name}: the mutation result is captured`)
    assert.ok(caught > commit, `${name}: the mutation is what the catch covers`)
    assert.ok(answered > caught, `${name}: and the reread happens after it, not inside it`)
  }
})
