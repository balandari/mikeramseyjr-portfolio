import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { fakeDriver, runProbe } from '../scripts/blob-probe.mjs'

/*
 * The probe, exercised without a credential and without a network.
 *
 * It is a script that writes to a real store, so it has to be right before it
 * is ever pointed at one. Running it against a fake implementing the documented
 * semantics proves the probe's own logic: a green fake run and a red live run
 * would then mean the service differs from its documentation, which is exactly
 * the distinction the probe exists to draw.
 *
 * The safety refusals are checked from the source, because they are refusals to
 * do something this test must not do either.
 */

test('the probe passes against a store that behaves as the documentation describes', async () => {
  const outcome = await runProbe(fakeDriver(), { rounds: 3, writers: 8 })

  assert.equal(outcome.passed, true, JSON.stringify(outcome.checks, null, 2))
  assert.deepEqual(
    outcome.checks.map((check: { id: string }) => check.id),
    ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8'],
    'all eight assumptions are covered, in order',
  )
  assert.deepEqual(outcome.leftover, [], 'and it removes everything it wrote')
  assert.match(outcome.prefix, /^probe\//, 'under a prefix no application code reads')
})

test('the probe fails loudly when a store lets two writers create one pathname', async () => {
  // A store that has forgotten create-if-absent. V1 must catch it; nothing else
  // in this system would.
  const broken = fakeDriver()
  const honest = broken.put.bind(broken)
  broken.put = async (
    pathname: string,
    body: string,
    options: { allowOverwrite?: boolean; ifMatch?: string } = {},
  ) => {
    if (options.ifMatch === undefined) return honest(pathname, body, { allowOverwrite: true })
    return honest(pathname, body, options)
  }

  const outcome = await runProbe(broken, { rounds: 1, writers: 4 })
  assert.equal(outcome.passed, false)

  const v1 = outcome.checks.find((check: { id: string }) => check.id === 'V1')
  assert.equal(v1.pass, false, 'V1 is the check that catches it')
})

/* ------------------------------------------------------------------ V8 */

/*
 * The missing-object half of V8, which used to be printed and not judged.
 *
 * `lib/private-store.ts:deleteIfMatch` requires that a conditional delete naming
 * an object that does not exist does **not** report success: it turns any
 * refusal into `false`, and every caller reads `false` as an honest conflict.
 * `removeDeclinedRequest` is the one that matters -- it removes a request
 * conditionally on the revision it read, and a `true` it did not earn would let
 * a stale second Remove claim it removed a record that had already been replaced
 * at the same pathname by somebody else's new request.
 *
 * The probe recorded what the service did and then left it out of the pass
 * predicate, so V8 could print PASS having proved nothing about it.
 */

test('the fake store refuses a conditional delete of a missing object', async () => {
  const driver = fakeDriver()
  await driver.put('probe/spec/present.json', '{}\n', { allowOverwrite: false })

  let kind = 'resolved-successfully'
  try {
    await driver.del('probe/spec/absent.json', { ifMatch: '"anything"' })
  } catch (error) {
    kind = driver.classify(error)
  }

  assert.equal(kind, 'notfound', 'which is one of the two answers deleteIfMatch accepts')
})

test('V8 fails when a conditional delete of a missing object quietly succeeds', async () => {
  /*
   * A provider that does the plausible wrong thing: treats a delete of something
   * absent as already done, and says so by resolving. Everything else about it
   * is correct, so V8 is the only check that can catch it -- and before this
   * pass, it did not.
   */
  const lenient = fakeDriver()
  const honestDel = lenient.del.bind(lenient)
  lenient.del = async (pathname: string, options: { ifMatch?: string } = {}) => {
    try {
      return await honestDel(pathname, options)
    } catch (error) {
      if ((error as { name?: string }).name === 'BlobNotFoundError') return undefined
      throw error
    }
  }

  const outcome = await runProbe(lenient, { rounds: 1, writers: 4 })

  const v8 = outcome.checks.find((check: { id: string }) => check.id === 'V8')
  assert.equal(v8.pass, false, 'V8 is the check that catches it')
  assert.equal(outcome.passed, false, 'and the probe as a whole fails closed')
  assert.match(
    v8.detail,
    /UNSUPPORTED/,
    'and says so in the words an operator has to act on, not as a footnote',
  )
  assert.match(v8.detail, /resolved-successfully/, 'naming exactly what the provider did')
})

test('V8 still fails when the stale-revision delete is not refused', async () => {
  // The half that was already judged, kept judged.
  const careless = fakeDriver()
  const honestDel = careless.del.bind(careless)
  careless.del = async (pathname: string, options: { ifMatch?: string } = {}) => {
    if (options.ifMatch !== undefined) return honestDel(pathname, {})
    return honestDel(pathname, options)
  }

  const outcome = await runProbe(careless, { rounds: 1, writers: 4 })
  const v8 = outcome.checks.find((check: { id: string }) => check.id === 'V8')
  assert.equal(v8.pass, false)
})

test('the probe refuses to touch a live store without an explicit isolation statement', () => {
  const source = readFileSync(join(process.cwd(), 'scripts', 'blob-probe.mjs'), 'utf8')

  // It must never reach for the application's own token. Naming it in the
  // refusal message is the point; reading it would be the defect.
  assert.match(source, /process\.env\.BLOB_PROBE_TOKEN/)
  assert.doesNotMatch(
    source,
    /process\.env\.BLOB_READ_WRITE_TOKEN/,
    'the probe never reads the application token',
  )

  // And it must require somebody to say, in a sentence, that the store is safe.
  assert.match(source, /yes-this-store-holds-no-production-data/)
  assert.match(source, /Refusing to run/)

  // Nothing it prints may carry a token or a provider body.
  assert.doesNotMatch(source, /console\.log\(.*token/i)
})
