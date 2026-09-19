import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  OPERATION,
  fakeDriver,
  forgetSecrets,
  liveDriver,
  redact,
  rememberSecret,
  runProbe,
  scrubSecrets,
} from '../scripts/blob-probe.mjs'

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
    ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9'],
    'all nine assumptions are covered, in order',
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

/* ------------------------------------------------- the live classifier */

/*
 * These drive `liveDriver()` itself. Constructing it imports `@vercel/blob`
 * and nothing else; the token below is never sent anywhere, because no method
 * on the driver is ever called. `classify()` is a pure function of an error
 * object, so the real SDK's real error classes can be handed to it with no
 * network, no credential and no store.
 */

test("the live classifier reads the service's missing-object refusal as notfound", async () => {
  /*
   * The observed V8 failure, in one line. Against the real service a
   * conditional delete naming a pathname that is not there does not raise the
   * typed `BlobNotFoundError`: it arrives on the SDK's `bad_request` branch as
   * a base `BlobError` carrying the service's own words --
   *
   *     Vercel Blob: The specified key does not exist.
   *
   * -- which the classifier read as "other", i.e. unrecognised, which V8 turns
   * into UNSUPPORTED. It is not unrecognised. It is the honest refusal
   * `lib/private-store.ts:deleteIfMatch` requires, wearing a different coat.
   */
  const { BlobError } = await import('@vercel/blob')
  const driver = await liveDriver('this-token-is-never-used-no-method-is-called')

  assert.equal(
    // Named, because the sentence is only this answer on the operation that
    // demonstrated it: V8's conditional delete.
    driver.classify(new BlobError('The specified key does not exist.'), OPERATION.CONDITIONAL_DELETE),
    'notfound',
    'the refusal V8 observed against the live store',
  )
})

test('the live classifier does not mistake a missing *store* for a missing object', async () => {
  /*
   * The narrowness that matters. `BlobStoreNotFoundError`'s message is
   * "This store does not exist." -- a credential or configuration failure that
   * shares three words with the refusal above. Reading it as `notfound` would
   * let `removeIfMatch` answer `false`, an honest conflict, about an outage,
   * which is the exact class of silent failure this driver exists to refuse.
   */
  const { BlobStoreNotFoundError, BlobServiceNotAvailable, BlobUnknownError, BlobServiceRateLimited } =
    await import('@vercel/blob')
  const driver = await liveDriver('this-token-is-never-used-no-method-is-called')

  assert.equal(driver.classify(new BlobStoreNotFoundError()), 'other', 'a missing store is not a missing object')
  assert.equal(driver.classify(new BlobServiceNotAvailable()), 'other', 'an outage stays unrecognised')
  assert.equal(driver.classify(new BlobUnknownError()), 'other', 'an unknown answer stays unknown')
  assert.equal(driver.classify(new BlobServiceRateLimited(3)), 'other', 'throttling is not a conflict')
})

test('the live classifier still reads the refusals it already recognised', async () => {
  const { BlobPreconditionFailedError, BlobNotFoundError, BlobError } = await import('@vercel/blob')
  const driver = await liveDriver('this-token-is-never-used-no-method-is-called')

  assert.equal(driver.classify(new BlobPreconditionFailedError()), 'precondition')
  assert.equal(driver.classify(new BlobNotFoundError()), 'notfound')
  assert.equal(
    driver.classify(
      new BlobError('This blob already exists, use allowOverwrite: true if you want to overwrite it.'),
    ),
    'exists',
  )
})

/* --------------------------------------- what the probe reports, and apart */

test('a classification miss is reported apart from the atomicity verdict', async () => {
  /*
   * The harness defect the September 14 run exposed. Every V2 round reported
   * exactly one winner -- the property under test held -- and the check still
   * printed FAIL, because one flag carried both "exactly one winner" and
   * "every loser was recognised". An operator reading that output cannot tell
   * a broken store from an unrecognised error shape.
   *
   * The pass predicate still requires both. What changes is that the record
   * says which one gave way.
   */
  const strange = fakeDriver()
  const honest = strange.put.bind(strange)
  strange.put = async (
    pathname: string,
    body: string,
    options: { allowOverwrite?: boolean; ifMatch?: string } = {},
  ) => {
    try {
      return await honest(pathname, body, options)
    } catch (error) {
      if (options.ifMatch === undefined) throw error
      // The same refusal, in a coat the classifier has never seen.
      const disguised = new Error('the service said something else entirely')
      disguised.name = 'BlobUnknownError'
      throw disguised
    }
  }

  const outcome = await runProbe(strange, { rounds: 2, writers: 6 })
  const v2 = outcome.checks.find((check: { id: string }) => check.id === 'V2')

  assert.equal(v2.pass, false, 'the probe still fails closed on an unrecognised refusal')
  assert.equal(v2.facts.everyRoundHadOneWinner, true, 'atomicity held, and the record says so')
  assert.equal(v2.facts.everyRefusalRecognised, false, 'and names classification as what gave way')
  assert.deepEqual(v2.facts.winnersPerRound, [1, 1], 'the winner counts stand on their own')
  assert.match(v2.detail, /exactly one winner every round: yes/)
})

test('the probe collects the distinct shapes a refusal arrives in, with counts', async () => {
  /*
   * The September 14 V2 failure was not one shape. 63 of 190 losers arrived as
   * a correctly typed precondition and 127 did not, and the output recorded
   * only the word "other" for each -- so the one thing needed to decide what
   * the service was doing was the one thing not kept. A set of distinct
   * (class, message) pairs with counts is that thing.
   */
  const mixed = fakeDriver()
  const honest = mixed.put.bind(mixed)
  let refusal = 0
  mixed.put = async (
    pathname: string,
    body: string,
    options: { allowOverwrite?: boolean; ifMatch?: string } = {},
  ) => {
    try {
      return await honest(pathname, body, options)
    } catch (error) {
      if (options.ifMatch === undefined) throw error
      refusal += 1
      if (refusal % 2 === 0) throw error
      const throttled = new Error('Too many requests please lower the number of concurrent requests.')
      throttled.name = 'BlobServiceRateLimited'
      throw throttled
    }
  }

  const outcome = await runProbe(mixed, { rounds: 1, writers: 6 })
  const v2 = outcome.checks.find((check: { id: string }) => check.id === 'V2')

  const shapes = v2.facts.shapes as {
    kind: string
    className: string
    message: string
    count: number
  }[]

  assert.equal(shapes.length, 2, 'both shapes were kept, not collapsed into one word')
  const throttled = shapes.find((shape) => shape.className === 'BlobServiceRateLimited')
  const precondition = shapes.find((shape) => shape.className === 'BlobPreconditionFailedError')

  assert.ok(throttled, 'the unrecognised shape is kept verbatim enough to act on')
  assert.equal(throttled.kind, 'other')
  assert.match(throttled.message, /Too many requests/)
  assert.ok(precondition, 'and the recognised one is kept too, not filtered away')
  assert.equal(precondition.kind, 'precondition')
  assert.equal(throttled.count + precondition.count, 5, 'every refusal is accounted for')
  assert.equal(v2.facts.refusals, 5)
  assert.equal(v2.facts.unrecognised, throttled.count)
})

test('nothing token-shaped can reach the probe output', async () => {
  const leaky = fakeDriver()
  const honest = leaky.put.bind(leaky)
  leaky.put = async (
    pathname: string,
    body: string,
    options: { allowOverwrite?: boolean; ifMatch?: string } = {},
  ) => {
    try {
      return await honest(pathname, body, options)
    } catch (error) {
      if (options.ifMatch === undefined) throw error
      throw new Error(
        'refused for token vercel_blob_rw_AbCdEfGhIjKlMnOp_0123456789abcdefghij on this request',
      )
    }
  }

  const outcome = await runProbe(leaky, { rounds: 1, writers: 4 })
  const v2 = outcome.checks.find((check: { id: string }) => check.id === 'V2')
  const printed = JSON.stringify(v2)

  assert.equal(printed.includes('vercel_blob_rw_'), false, 'a token-shaped run is redacted')
  assert.match(printed, /REDACTED/, 'and the redaction is visible rather than silent')
})

test('V2 catches a refused writer that actually persisted, which a winner count cannot', async () => {
  /*
   * The inference this check exists to replace.
   *
   * "Every round had exactly one winner" is a statement about acknowledgements.
   * A store can refuse a writer and keep its bytes anyway -- the answer is
   * lost, or the refusal is a lie -- and the winner count is identical either
   * way. That is precisely the reasoning the September 14 intake ruled out, and
   * ruling it out means having something better, not having nothing.
   *
   * The something better is reading the object back and comparing it with what
   * the acknowledged winner said it wrote. Below is a store that acknowledges
   * exactly one writer per round and then quietly keeps a *refused* writer's
   * body. Its winner counts are perfect. V2 must still fail.
   */
  const treacherous = fakeDriver()
  const honest = treacherous.put.bind(treacherous)
  let acknowledgedOne = false
  let keptARefusedWrite = false

  treacherous.put = async (
    pathname: string,
    body: string,
    options: { allowOverwrite?: boolean; ifMatch?: string } = {},
  ) => {
    if (options.ifMatch === undefined) return honest(pathname, body, options)
    try {
      const result = await honest(pathname, body, options)
      acknowledgedOne = true
      return result
    } catch (error) {
      if (acknowledgedOne && !keptARefusedWrite) {
        keptARefusedWrite = true
        // Refused to the caller's face, and stored all the same.
        await honest(pathname, body, { allowOverwrite: true })
      }
      throw error
    }
  }

  const outcome = await runProbe(treacherous, { rounds: 1, writers: 4 })
  const v2 = outcome.checks.find((check: { id: string }) => check.id === 'V2')

  assert.equal(keptARefusedWrite, true, 'the rigged store did the thing it was rigged to do')
  assert.deepEqual(v2.facts.winnersPerRound, [1], 'and its winner count is perfect')
  assert.equal(v2.facts.everyRoundHadOneWinner, true)
  assert.equal(v2.facts.everyRefusalRecognised, true, 'and every refusal is a recognised one')
  assert.equal(v2.facts.everyRoundKeptTheWinner, false, 'the read-back is what catches it')
  assert.equal(v2.pass, false, 'and V2 fails closed on it')
  assert.match(v2.detail, /AT LEAST ONE ROUND kept a revision the acknowledged winner did not write/)
})

test('V2 says what survived was read back, not inferred, when it passes', async () => {
  const outcome = await runProbe(fakeDriver(), { rounds: 3, writers: 5 })
  const v2 = outcome.checks.find((check: { id: string }) => check.id === 'V2')

  assert.equal(v2.pass, true)
  assert.equal(v2.facts.everyRoundKeptTheWinner, true)
  assert.equal(v2.facts.survivors.length, 3, 'one reading per round, kept')
  for (const survivor of v2.facts.survivors as {
    bodyIsTheWinners: boolean
    revisionIsTheWinners: boolean
  }[]) {
    assert.equal(survivor.bodyIsTheWinners, true)
    assert.equal(survivor.revisionIsTheWinners, true)
  }
  assert.match(v2.detail, /no refused writer persisted anything/)
  assert.match(v2.detail, /Read back from the store, not/)
})

test('the live classifier reads the second shape of a lost compare-and-swap', async () => {
  /*
   * The V2 finding itself: 113 of 190 losers in the September 14 run arrived
   * as this, and 77 as the typed class. Both are the same answer.
   */
  const { BlobError } = await import('@vercel/blob')
  const driver = await liveDriver('this-token-is-never-used-no-method-is-called')

  assert.equal(
    driver.classify(
      new BlobError(
        'The conditional request cannot succeed due to a conflicting operation against this resource.',
      ),
      // Named, for the same reason: V2's conditional write is where this
      // sentence was demonstrated, and it is that answer nowhere else.
      OPERATION.CONDITIONAL_WRITE,
    ),
    'precondition',
  )

  // And nothing looser. These say nothing about whether the write landed.
  for (const near of ['A conflicting operation is in progress.', 'Conflict.', 'The request cannot succeed.']) {
    assert.equal(
      driver.classify(new BlobError(near), OPERATION.CONDITIONAL_WRITE),
      'other',
      `"${near}" must stay unrecognised`,
    )
  }
})

/* ------------------- the demonstrated shape, in the probe ----------------- */

/*
 * CF-1 and CF-2, at the classifier.
 *
 * The probe's two message mappings were `includes()` over any `Error`, and the
 * probe is what vouches for the adapters: a refusal it classifies as
 * `precondition` is counted by V2 as a recognised, definite loser, and one it
 * classifies as `notfound` is what V8 accepts as an honest refusal. Widening
 * either would let the probe pass on a run in which the service answered
 * ambiguously.
 *
 * The demonstrated shape is a class plus a complete message: the SDK's base
 * `BlobError`, and the sentence the September 14 run recorded, whole. Every
 * negative below *contains* the accepted fragment, so only the class-and-
 * whole-message rule can reject it.
 */

const DEMONSTRATED_CONFLICT =
  'Vercel Blob: The conditional request cannot succeed due to a conflicting operation against this resource.'
const DEMONSTRATED_MISSING = 'Vercel Blob: The specified key does not exist.'

/** The SDK prefixes every message it constructs; this is the tail it adds to. */
const tailOf = (message: string) => message.replace(/^Vercel Blob: /, '')

const wrongShapes = (blob: typeof import('@vercel/blob'), message: string) => {
  class WrappedBlobError extends blob.BlobError {}
  const withMessage = <T extends Error>(error: T): T => {
    Object.defineProperty(error, 'message', { value: message, writable: true, configurable: true })
    return error
  }
  return [
    { what: 'a transport TypeError quoting the service', error: new TypeError(message) },
    { what: 'a plain Error carrying the sentence', error: new Error(message) },
    { what: 'a wrapper class around the SDK base error', error: new WrappedBlobError(tailOf(message)) },
    { what: 'an SDK subclass carrying the sentence', error: withMessage(new blob.BlobUnknownError()) },
    {
      what: 'a missing store carrying the sentence',
      error: withMessage(new blob.BlobStoreNotFoundError()),
    },
    {
      what: 'the sentence with a request id appended',
      error: new blob.BlobError(`${tailOf(message)} (request id 01JBQ7)`),
    },
    {
      what: 'the sentence with text in front of it',
      error: new blob.BlobError(`upstream said: ${tailOf(message)}`),
    },
    { what: 'the sentence in a different case', error: new blob.BlobError(tailOf(message).toUpperCase()) },
  ]
}

test('the live classifier accepts the conditional conflict only in its demonstrated shape', async () => {
  const blob = await import('@vercel/blob')
  const driver = await liveDriver('this-token-is-never-used-no-method-is-called')

  const demonstrated = new blob.BlobError(tailOf(DEMONSTRATED_CONFLICT))
  assert.equal(demonstrated.message, DEMONSTRATED_CONFLICT, 'the pin is the real message')
  assert.equal(
    driver.classify(demonstrated, OPERATION.CONDITIONAL_WRITE),
    'precondition',
    'the observed refusal still maps',
  )

  for (const { what, error } of wrongShapes(blob, DEMONSTRATED_CONFLICT)) {
    assert.equal(
      driver.classify(error, OPERATION.CONDITIONAL_WRITE),
      'other',
      `${what} is ambiguous and must stay unrecognised, not be counted as a definite loser`,
    )
  }
})

test('the live classifier accepts the missing-object refusal only in its demonstrated shape', async () => {
  const blob = await import('@vercel/blob')
  const driver = await liveDriver('this-token-is-never-used-no-method-is-called')

  const demonstrated = new blob.BlobError(tailOf(DEMONSTRATED_MISSING))
  assert.equal(demonstrated.message, DEMONSTRATED_MISSING, 'and so is this one')
  assert.equal(
    driver.classify(demonstrated, OPERATION.CONDITIONAL_DELETE),
    'notfound',
    'the observed refusal still maps',
  )
  assert.equal(
    driver.classify(demonstrated, OPERATION.CONDITIONAL_WRITE),
    'notfound',
    'and V9 of the P3.1 live run demonstrated the same shape on the conditional write',
  )

  for (const operation of [OPERATION.CONDITIONAL_DELETE, OPERATION.CONDITIONAL_WRITE]) {
    for (const { what, error } of wrongShapes(blob, DEMONSTRATED_MISSING)) {
      assert.equal(
        driver.classify(error, operation),
        'other',
        `${what} says nothing about whether the object was there, on ${operation}`,
      )
    }
  }
})

/* --------------------- CF-3: one sanitizer, both paths -------------------- */

/*
 * `shape()` redacted and `describe()` did not.
 *
 * `describe()` is the printable half -- it fills the V5, V6, V7 and V8 detail
 * strings, which are what the console prints and what a saved run keeps. The
 * structured ledger being safe said nothing about the line beside it, and the
 * saved PowerShell runner's own second redaction covers the Blob token prefix
 * but not every Bearer or opaque pattern the script's sanitizer handles, and
 * direct CLI use has no second pass at all.
 *
 * No actual leak was alleged and no real credential is needed to test this:
 * synthetic token-shaped and Bearer-shaped text is enough, because the
 * question is whether the sanitizer runs, not what it would have caught.
 */

const SYNTHETIC_SECRETS = [
  {
    what: 'a Blob read-write token',
    text: 'refused for vercel_blob_rw_AbCdEfGhIjKlMnOp_0123456789abcdefghij on this request',
    fragment: 'vercel_blob_rw_',
  },
  {
    what: 'an Authorization header quoted back',
    text: 'upstream rejected Bearer eyJhbGciOiJIUzI1NiJ9.c3ludGhldGlj.not-a-real-signature',
    fragment: 'eyJhbGciOiJIUzI1NiJ9',
  },
  {
    what: 'a long opaque value',
    text: 'store key AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKK was not accepted',
    fragment: 'AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKK',
  },
]

test('describe() is sanitized by the same redaction as shape(), on both drivers', async () => {
  const live = await liveDriver('this-token-is-never-used-no-method-is-called')
  const fake = fakeDriver()

  for (const { what, text, fragment } of SYNTHETIC_SECRETS) {
    const error = new Error(text)
    for (const [name, driver] of [
      ['live', live],
      ['fake', fake],
    ] as const) {
      const printable = driver.describe(error)
      const structured = driver.shape(error)

      assert.equal(
        printable.includes(fragment),
        false,
        `${what} survived ${name} describe(), which is the printable V5-V8 path`,
      )
      assert.equal(
        structured.message.includes(fragment),
        false,
        `${what} survived ${name} shape()`,
      )
      assert.match(printable, /REDACTED/, 'and the redaction is visible rather than silent')
      assert.equal(
        printable.endsWith(structured.message),
        true,
        'the two paths print the same sanitized text, so neither can drift',
      )
    }
  }
})

test('nothing token-shaped reaches a printed probe detail either', async () => {
  /*
   * The same thing one level up: a store that answers a *delete* with
   * token-shaped text, so the value has to travel through `describe()` into
   * V8's detail string and out to the console.
   */
  const leaky = fakeDriver()
  const honestDel = leaky.del.bind(leaky)
  leaky.del = async (pathname: string, options: { ifMatch?: string } = {}) => {
    try {
      return await honestDel(pathname, options)
    } catch {
      throw new Error(
        'refused for vercel_blob_rw_AbCdEfGhIjKlMnOp_0123456789abcdefghij against this store',
      )
    }
  }

  const outcome = await runProbe(leaky, { rounds: 1, writers: 4 })
  const v8 = outcome.checks.find((check: { id: string }) => check.id === 'V8')

  assert.equal(v8.detail.includes('vercel_blob_rw_'), false, 'the printable detail is redacted')
  assert.match(v8.detail, /REDACTED/, 'and says so')
  assert.equal(
    JSON.stringify(outcome).includes('vercel_blob_rw_'),
    false,
    'and nothing else in the run kept it either',
  )
})

/* ======================================================================== */
/* C5: CF-1 operation scope, CF-3 token boundaries, and exact-value cover    */
/* ======================================================================== */

/*
 * A resolve-only hook, so the *real* adapter can be driven with no network.
 *
 * It is module-level: `register()` runs when this file is evaluated, before
 * any test body, so it is in force for every test above as well as below. That
 * is safe, and the reason is worth stating rather than assuming. The double
 * re-exports the SDK's genuine error classes from the SDK's own file by URL --
 * same constructors, same messages, and `Object.getPrototypeOf(error) ===
 * BlobError.prototype` still holds, which is the whole basis of the
 * demonstrated-shape rule -- and replaces only `put`, `get`, `del` and `list`.
 * Nothing above this line calls a verb: those tests hand error objects to
 * `classify()`, `describe()` and `shape()`, which are pure.
 *
 * What it buys is the one check this file could not otherwise make. CF-1 is a
 * disagreement between the probe and `lib/private-store.ts`, and the only
 * honest way to test a disagreement is to run both. The adapter is unmodified
 * and stays unmodified; it is imported and called exactly as the application
 * calls it. This follows the pattern `tests/blob-refusal-mapping.test.ts` and
 * `tests/admin-route-boundary.test.ts` already use, and `node --test` gives
 * each test file its own process, so the hook is local to this one.
 */

type ProbeBlobDouble = {
  put(pathname: string, body: string, options: Record<string, unknown>): Promise<unknown>
  get(pathname: string, options: Record<string, unknown>): Promise<null>
  del(pathname: string, options: Record<string, unknown>): Promise<unknown>
  list(options: Record<string, unknown>): Promise<{ blobs: never[]; hasMore: boolean }>
}

declare global {
  // eslint-disable-next-line no-var
  var __probeBlob: ProbeBlobDouble | undefined
}

const REAL_SDK_URL = pathToFileURL(
  join(process.cwd(), 'node_modules', '@vercel', 'blob', 'dist', 'index.js'),
).href
const PRIVATE_STORE_URL = pathToFileURL(join(process.cwd(), 'lib', 'private-store.ts')).href

const asInlineModule = (source: string) =>
  `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`

const BLOB_DOUBLE_URL = asInlineModule(`
import * as real from ${JSON.stringify(REAL_SDK_URL)}

export const {
  BlobError,
  BlobNotFoundError,
  BlobPreconditionFailedError,
  BlobStoreNotFoundError,
  BlobServiceNotAvailable,
  BlobServiceRateLimited,
  BlobUnknownError,
  BlobAccessError,
  BlobRequestAbortedError,
} = real

const store = () => {
  if (!globalThis.__probeBlob) throw new Error('no blob double is installed')
  return globalThis.__probeBlob
}
export const put = (...args) => store().put(...args)
export const get = (...args) => store().get(...args)
export const del = (...args) => store().del(...args)
export const list = (...args) => store().list(...args)
`)

register(
  asInlineModule(`export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@vercel/blob') {
    return { url: ${JSON.stringify(BLOB_DOUBLE_URL)}, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}`),
)

/** Never sent anywhere: the double receives every call. */
const ADAPTER_TOKEN = 'adapter-double-token-not-a-real-one'

/** A store that answers every verb by refusing with exactly this error. */
const refusesWith = (error: unknown): ProbeBlobDouble => ({
  async put() {
    throw error
  },
  async get() {
    return null
  },
  async del() {
    throw error
  },
  async list() {
    return { blobs: [], hasMore: false }
  },
})

const EVERY_OPERATION = [
  OPERATION.CREATE,
  OPERATION.CONDITIONAL_WRITE,
  OPERATION.CONDITIONAL_DELETE,
] as const

/* --------------------------- CF-1: one meaning, one operation ------------- */

test('a demonstrated sentence is recognised only on the operation that demonstrated it', async () => {
  /*
   * CF-1 in one table.
   *
   * Both sentences are untyped: a base `BlobError` and nothing but words, so
   * each means what it was *demonstrated* to mean, where it was demonstrated,
   * and nowhere else. Read anywhere else it is an assumption wearing the
   * clothes of evidence, so it maps to `other`, which V2, V8 and V9 all read
   * as a failure.
   *
   * Which is where, as of September 19:
   *
   *   conflict sentence    V2's conditional write. Nowhere else -- in
   *                        particular not a delete, which is the CF-1 finding.
   *   missing-object       V8's conditional delete, and now V9's conditional
   *                        write: the P3.1 live run recorded the same base
   *                        class and the same complete sentence from a stale
   *                        `put(..., { ifMatch })` against a deleted object,
   *                        and recorded in the same run that the object stayed
   *                        absent. Two operations, each demonstrated.
   *
   * Neither is accepted from a create, which sends no conditional request at
   * all and so cannot honestly receive either answer.
   */
  const { BlobError } = await import('@vercel/blob')
  const driver = await liveDriver('this-token-is-never-used-no-method-is-called')

  const expected = [
    {
      what: 'the conditional-conflict sentence',
      error: () => new BlobError(tailOf(DEMONSTRATED_CONFLICT)),
      [OPERATION.CREATE]: 'other',
      [OPERATION.CONDITIONAL_WRITE]: 'precondition',
      [OPERATION.CONDITIONAL_DELETE]: 'other',
    },
    {
      what: 'the missing-object sentence',
      error: () => new BlobError(tailOf(DEMONSTRATED_MISSING)),
      [OPERATION.CREATE]: 'other',
      [OPERATION.CONDITIONAL_WRITE]: 'notfound',
      [OPERATION.CONDITIONAL_DELETE]: 'notfound',
    },
  ] as const

  for (const row of expected) {
    for (const operation of EVERY_OPERATION) {
      assert.equal(
        driver.classify(row.error(), operation),
        row[operation],
        `${row.what} on ${operation}`,
      )
    }
  }
})

test('the conflict sentence is refused by BOTH of V8\'s delete branches', async () => {
  /*
   * Said separately from the table because it is the exact finding. V8 asks a
   * conditional delete twice -- once with a stale ETag against an object that
   * is there, once against a pathname that never existed -- and the write-only
   * conflict sentence must be unrecognised in both, not merely in one.
   */
  const { BlobError } = await import('@vercel/blob')
  const driver = await liveDriver('this-token-is-never-used-no-method-is-called')
  const conflict = () => new BlobError(tailOf(DEMONSTRATED_CONFLICT))

  assert.equal(driver.classify(conflict(), OPERATION.CONDITIONAL_DELETE), 'other')
  assert.notEqual(driver.classify(conflict(), OPERATION.CONDITIONAL_DELETE), 'precondition')
  assert.notEqual(driver.classify(conflict(), OPERATION.CONDITIONAL_DELETE), 'notfound')
})

test('a typed refusal carries its meaning on every operation', async () => {
  /*
   * The other half of the rule, and the reason the repair is a narrowing of
   * two message mappings rather than a redesign. A typed class is the SDK
   * saying which refusal this is; it does not need an operation to be read,
   * and nothing here takes one away.
   */
  const { BlobPreconditionFailedError, BlobNotFoundError } = await import('@vercel/blob')
  const driver = await liveDriver('this-token-is-never-used-no-method-is-called')

  for (const operation of EVERY_OPERATION) {
    assert.equal(driver.classify(new BlobPreconditionFailedError(), operation), 'precondition')
    assert.equal(driver.classify(new BlobNotFoundError(), operation), 'notfound')
  }
})

test('the preexisting existence heuristic is neither widened nor narrowed', async () => {
  /*
   * Carried forward exactly as it was, on purpose. It is a named nonblocking
   * residual, not part of this repair, and quietly scoping it to `create`
   * would have been an unrequested behaviour change in a check nobody asked
   * about.
   */
  const { BlobError } = await import('@vercel/blob')
  const driver = await liveDriver('this-token-is-never-used-no-method-is-called')
  const exists = () =>
    new BlobError('This blob already exists, use allowOverwrite: true if you want to overwrite it.')

  for (const operation of EVERY_OPERATION) {
    assert.equal(driver.classify(exists(), operation), 'exists', `unchanged on ${operation}`)
  }
  assert.equal(driver.classify(exists(), undefined), 'exists', 'and unchanged without one')
})

test('an absent or unrecognised operation maps neither sentence', async () => {
  /*
   * Fail closed, because the alternative is to fail open. A call site that
   * forgets to say which operation it is asking about gets `other` -- unknown
   * -- and every check that depends on a definite answer fails and says so.
   * Nothing silently keeps the old global behaviour.
   */
  const { BlobError } = await import('@vercel/blob')
  const driver = await liveDriver('this-token-is-never-used-no-method-is-called')

  for (const sentence of [DEMONSTRATED_CONFLICT, DEMONSTRATED_MISSING]) {
    for (const operation of [undefined, null, '', 'delete', 'write', 'CONDITIONAL_WRITE']) {
      assert.equal(
        driver.classify(new BlobError(tailOf(sentence)), operation),
        'other',
        `"${String(operation)}" is not an operation this classifier knows`,
      )
    }
  }
})

test('the wrong class or a longer message stays unrecognised on every operation', async () => {
  const blob = await import('@vercel/blob')
  const driver = await liveDriver('this-token-is-never-used-no-method-is-called')

  for (const sentence of [DEMONSTRATED_CONFLICT, DEMONSTRATED_MISSING]) {
    for (const { what, error } of wrongShapes(blob, sentence)) {
      for (const operation of EVERY_OPERATION) {
        assert.equal(
          driver.classify(error, operation),
          'other',
          `${what} must stay unrecognised, including on ${operation}`,
        )
      }
    }
  }
})

/* ------------- CF-1: the probe and the adapter, on the same errors -------- */

const ADAPTER_SITES = [
  {
    what: 'putIfAbsent -- create-if-absent',
    operation: OPERATION.CREATE,
    call: (backend: Awaited<ReturnType<typeof privateBackend>>) =>
      backend.putIfAbsent('reviewer/probe-agreement.json', '{}'),
  },
  {
    what: 'putIfMatch with an ETag -- conditional write',
    operation: OPERATION.CONDITIONAL_WRITE,
    call: (backend: Awaited<ReturnType<typeof privateBackend>>) =>
      backend.putIfMatch('reviewer/probe-agreement.json', '{}', '"etag"'),
  },
  {
    what: 'deleteIfMatch -- conditional delete',
    operation: OPERATION.CONDITIONAL_DELETE,
    call: (backend: Awaited<ReturnType<typeof privateBackend>>) =>
      backend.deleteIfMatch('reviewer/probe-agreement.json', '"etag"'),
  },
] as const

const privateBackend = async () => {
  const store = (await import(PRIVATE_STORE_URL)) as typeof import('../lib/private-store.ts')
  return store.createPrivateBlobBackend(ADAPTER_TOKEN)
}

/** Did the adapter treat this refusal as a definite "nothing was written"? */
const adapterAccepted = async (
  site: (typeof ADAPTER_SITES)[number],
  error: unknown,
): Promise<boolean> => {
  globalThis.__probeBlob = refusesWith(error)
  try {
    await site.call(await privateBackend())
    return true
  } catch {
    return false
  }
}

/*
 * The second adapter the probe vouches for, added because V9 vouches for it.
 *
 * `lib/private-store.ts` is the reviewer-roster/request store. The object
 * layer V9 actually models is `lib/reviewer-reading-blob.ts`: it is what
 * `NoteStore.updateNote` writes through, and its conditional put is the exact
 * call V9 makes. P3.1 demonstrated the missing-object sentence *there*, on
 * that operation, so that is where the correction landed.
 *
 * The two drivers therefore deliberately differ on one cell of the table
 * below -- the missing-object sentence at a conditional write -- and the
 * difference is pinned rather than papered over. `lib/private-store.ts` was a
 * read-only control in the slice that made this change, and widening its
 * mapping was neither demonstrated at that driver nor authorised.
 */
const READING_BLOB_URL = pathToFileURL(
  join(process.cwd(), 'lib', 'reviewer-reading-blob.ts'),
).href

const readingAccepted = async (error: unknown): Promise<boolean> => {
  const mod = (await import(READING_BLOB_URL)) as typeof import('../lib/reviewer-reading-blob.ts')
  globalThis.__probeBlob = refusesWith(error)
  try {
    return (
      (await mod
        .createVercelBlobReadingObjects({ token: ADAPTER_TOKEN })
        .putIfMatch('notes/v1/a-book/reviewer/mike/n1.json', '{}', '"etag"')) === false
    )
  } catch {
    return false
  }
}

test('the probe recognises a sentence exactly where the real adapter accepts it', async () => {
  /*
   * The agreement CF-1 broke, checked by running both.
   *
   * The probe is what vouches for the adapters, so a shape the probe calls
   * definite and the adapter rethrows -- or the reverse -- is a proof gate
   * pointing at the wrong thing. `lib/private-store.ts` is imported unchanged
   * and driven through the double above.
   *
   * The absolute answer is pinned as well as the agreement, deliberately: two
   * implementations that are wrong in the same direction agree perfectly, and
   * agreement alone would not notice.
   */
  const { BlobError } = await import('@vercel/blob')

  const table = [
    {
      what: 'the conditional-conflict sentence',
      sentence: DEMONSTRATED_CONFLICT,
      accepted: {
        [OPERATION.CREATE]: false,
        [OPERATION.CONDITIONAL_WRITE]: true,
        [OPERATION.CONDITIONAL_DELETE]: false,
      },
      // `lib/reviewer-reading-blob.ts:putIfMatch` does not map this sentence.
      // V2 demonstrated it at the other store's driver; nothing demonstrated
      // it here, so it propagates.
      byReadingDriver: false,
    },
    {
      what: 'the missing-object sentence',
      sentence: DEMONSTRATED_MISSING,
      accepted: {
        [OPERATION.CREATE]: false,
        // Unchanged, and unchanged on purpose: `lib/private-store.ts` was a
        // read-only control in the slice that added the reading driver's
        // mapping, and P3.1 demonstrated the shape at the reading driver.
        [OPERATION.CONDITIONAL_WRITE]: false,
        [OPERATION.CONDITIONAL_DELETE]: true,
      },
      // The P3.1 cell. This is the one the correction changed.
      byReadingDriver: true,
    },
  ] as const

  const driver = await liveDriver('this-token-is-never-used-no-method-is-called')

  for (const row of table) {
    const anyAdapter = new Set<string>()

    for (const site of ADAPTER_SITES) {
      const error = new BlobError(tailOf(row.sentence))
      const byAdapter = await adapterAccepted(site, error)

      assert.equal(
        byAdapter,
        row.accepted[site.operation],
        `${row.what} at ${site.what}: the adapter's own answer is pinned`,
      )
      if (byAdapter) anyAdapter.add(site.operation)
    }

    const atReading = await readingAccepted(new BlobError(tailOf(row.sentence)))
    assert.equal(
      atReading,
      row.byReadingDriver,
      `${row.what} at reviewer-reading-blob putIfMatch: its own answer is pinned too`,
    )
    if (atReading) anyAdapter.add(OPERATION.CONDITIONAL_WRITE)

    /*
     * The agreement, restated for two adapters rather than one.
     *
     * The classifier is the union of what the adapters it vouches for accept,
     * so a shape is recognised on an operation exactly when *some* adapter
     * accepts it there -- and, just as importantly, is `other` on every
     * operation where none does. Both directions are checked, and every
     * adapter's absolute answer is pinned above, so two implementations
     * wrong in the same direction still fail this.
     */
    for (const operation of EVERY_OPERATION) {
      const byProbe = driver.classify(new BlobError(tailOf(row.sentence)), operation) !== 'other'
      assert.equal(
        byProbe,
        anyAdapter.has(operation),
        `${row.what} on ${operation}: the probe recognises exactly what some adapter accepts`,
      )
    }
  }

  globalThis.__probeBlob = undefined
})

test('every ambiguous shape is rethrown by the adapter and unrecognised by the probe', async () => {
  const blob = await import('@vercel/blob')
  const driver = await liveDriver('this-token-is-never-used-no-method-is-called')

  for (const sentence of [DEMONSTRATED_CONFLICT, DEMONSTRATED_MISSING]) {
    for (const { what, error } of wrongShapes(blob, sentence)) {
      for (const site of ADAPTER_SITES) {
        assert.equal(
          await adapterAccepted(site, error),
          false,
          `${what} must reach the caller at ${site.what}`,
        )
        assert.equal(
          driver.classify(error, site.operation),
          'other',
          `${what} must stay unrecognised at ${site.what}`,
        )
      }

      assert.equal(
        await readingAccepted(error),
        false,
        `${what} must reach the caller at reviewer-reading-blob putIfMatch too`,
      )
    }
  }

  globalThis.__probeBlob = undefined
})

/* --------------- CF-1: the two whole-probe counterexamples --------------- */

/*
 * The Judge's own reproductions, carried in so they cannot come back.
 *
 * An honest fake with the live classifier bolted on, and a single delete
 * branch answering with the conditional-WRITE refusal shape. Before this pass
 * V8 -- and the whole probe -- passed on both, which is a proof gate reporting
 * PASS on evidence licensed for a different operation.
 */
const hybridDriver = async ({ replaceStale = false, replaceMissing = false } = {}) => {
  const { BlobError, BlobNotFoundError, BlobPreconditionFailedError } = await import('@vercel/blob')
  const live = await liveDriver('this-token-is-never-used-no-method-is-called')
  const hybrid = fakeDriver()
  const honestPut = hybrid.put.bind(hybrid)
  const honestDelete = hybrid.del.bind(hybrid)

  hybrid.classify = live.classify
  hybrid.describe = live.describe
  hybrid.shape = live.shape
  hybrid.put = async (pathname: string, body: string, options: Record<string, unknown> = {}) => {
    try {
      return await honestPut(pathname, body, options)
    } catch (error) {
      if ((error as Error)?.name === 'BlobPreconditionFailedError') {
        throw new BlobPreconditionFailedError()
      }
      throw error
    }
  }
  hybrid.del = async (pathname: string, options: Record<string, unknown> = {}) => {
    try {
      return await honestDelete(pathname, options)
    } catch (error) {
      const name = (error as Error)?.name
      const isStale = pathname.endsWith('/v8.json') && name === 'BlobPreconditionFailedError'
      const isMissing =
        pathname.endsWith('/v8-never-written.json') && name === 'BlobNotFoundError'
      if ((replaceStale && isStale) || (replaceMissing && isMissing)) {
        throw new BlobError(tailOf(DEMONSTRATED_CONFLICT))
      }
      if (isStale) throw new BlobPreconditionFailedError()
      if (isMissing) throw new BlobNotFoundError()
      throw error
    }
  }
  return hybrid
}

test('V8 fails when its stale delete alone receives the write-only conflict shape', async () => {
  const outcome = await runProbe(await hybridDriver({ replaceStale: true }), {
    rounds: 1,
    writers: 4,
    prefix: 'probe/c5-stale-operation-scope',
  })
  const v8 = outcome.checks.find((check: { id: string }) => check.id === 'V8')

  assert.equal(v8.facts.staleKind, 'other', 'the delete did not borrow a write-only meaning')
  assert.equal(v8.pass, false)
  assert.equal(outcome.passed, false, 'and the whole probe fails closed')
})

test('V8 fails when its missing delete alone receives the write-only conflict shape', async () => {
  const outcome = await runProbe(await hybridDriver({ replaceMissing: true }), {
    rounds: 1,
    writers: 4,
    prefix: 'probe/c5-missing-operation-scope',
  })
  const v8 = outcome.checks.find((check: { id: string }) => check.id === 'V8')

  assert.equal(v8.facts.missingKind, 'other')
  assert.equal(v8.facts.missingHonest, false, 'an unrecognised refusal is not an honest one')
  assert.equal(v8.pass, false)
  assert.equal(outcome.passed, false)
})

test('V8 still passes on the shapes that were actually demonstrated', async () => {
  /*
   * The positive control the two above need. With the honest typed refusals in
   * place -- which is what the fake raises -- nothing about this repair makes
   * V8 harder to satisfy.
   */
  const outcome = await runProbe(await hybridDriver(), {
    rounds: 1,
    writers: 4,
    prefix: 'probe/c5-operation-scope-control',
  })
  const v8 = outcome.checks.find((check: { id: string }) => check.id === 'V8')

  assert.equal(v8.facts.staleKind, 'precondition')
  assert.equal(v8.facts.missingKind, 'notfound')
  assert.equal(v8.pass, true)
  assert.equal(outcome.passed, true)
})

/* ------------------- CF-3: the token alphabet, at its edges --------------- */

/** The exact value CC found and Challenge reproduced: 40 characters, hyphen ends. */
const DEMONSTRATED_HYPHEN_CASE = `-${'A'.repeat(38)}-`

test('the boundary the old word-boundary pattern could not see', () => {
  /*
   * CF-3, stated as the two regexes rather than described.
   *
   * `-` is in the URL-safe alphabet and is not a regex word character, so
   * `\b` finds no boundary at a hyphen endpoint. The only run it could anchor
   * in this value is the 38-character interior, and 38 is below the threshold,
   * so the whole 40-character value went through untouched.
   */
  assert.equal(DEMONSTRATED_HYPHEN_CASE.length, 40)
  assert.equal(
    /\b[A-Za-z0-9_-]{40,}\b/.test(DEMONSTRATED_HYPHEN_CASE),
    false,
    'the pattern that missed it',
  )
  assert.equal(
    /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/.test(DEMONSTRATED_HYPHEN_CASE),
    true,
    'and the lookarounds that do not',
  )
  assert.equal(
    redact(`provider echoed key ${DEMONSTRATED_HYPHEN_CASE} in its diagnostic`).includes(
      DEMONSTRATED_HYPHEN_CASE,
    ),
    false,
  )
})

test('every endpoint, length and separator around the 40-character threshold', () => {
  /*
   * Generated rather than listed, because the defect was a single uncovered
   * combination of endpoint character and length and the way to stop that
   * happening twice is to stop choosing the combinations by hand.
   *
   * The separators are all characters *outside* the token alphabet, so each
   * one genuinely ends the run rather than extending it. The rule being
   * checked is the whole rule: a run of the alphabet is redacted exactly when
   * it reaches 40 characters, whichever characters it begins and ends on.
   */
  const endpoints = ['-', '_', 'A', '9']
  const separators = [' ', ':', '=', '(', ',', '"', '/', '.', '%', '|']
  const lengths = [38, 39, 40, 41, 44]
  let checked = 0

  for (const endpoint of endpoints) {
    for (const length of lengths) {
      const value = `${endpoint}${'A'.repeat(length - 2)}${endpoint}`
      assert.equal(value.length, length, 'the generator built what it meant to')

      for (const left of separators) {
        for (const right of separators) {
          const text = `store key${left}${value}${right}rejected`
          const redacted = redact(text)
          const shouldGo = length >= 40

          assert.equal(
            redacted.includes(value),
            !shouldGo,
            `${length} chars, "${endpoint}" endpoints, "${left}"/"${right}" separators`,
          )
          if (shouldGo) {
            assert.match(redacted, /REDACTED/, 'and the removal is visible, never silent')
          }
          checked += 1
        }
      }
    }
  }

  assert.equal(checked, endpoints.length * lengths.length * separators.length ** 2)
})

test('two short runs either side of a separator are both left alone', () => {
  /*
   * The other direction of the same rule. A separator genuinely divides: two
   * 39-character runs are two runs, not one 79-character one, and neither
   * reaches the threshold.
   */
  const left = `-${'A'.repeat(37)}-`
  const right = `_${'B'.repeat(37)}_`
  assert.equal(left.length, 39)
  assert.equal(right.length, 39)

  const redacted = redact(`between ${left}.${right} here`)
  assert.equal(redacted.includes(left), true)
  assert.equal(redacted.includes(right), true)
  assert.doesNotMatch(redacted, /REDACTED/)
})

test('the named secret families and benign text are unchanged by the new boundaries', () => {
  /*
   * The controls the repair must not cost. The first three are the families
   * already accepted as closed; the last is the reason redaction is bounded at
   * all -- a probe whose diagnostics are all markers diagnoses nothing.
   */
  for (const value of [
    'vercel_blob_rw_SYNTHETIC_TOKEN_1234567890',
    'Bearer SYNTHETIC.BEARER.VALUE-1234567890',
    'A'.repeat(44),
  ]) {
    assert.equal(redact(`provider ${value}`).includes(value), false, value.slice(0, 20))
  }

  for (const benign of [
    'The conditional request was rejected by the provider.',
    'Vercel Blob: The specified key does not exist.',
    'BlobPreconditionFailedError: precondition failed',
    'stale delete refused as "precondition"; current delete succeeded: true',
  ]) {
    assert.equal(redact(benign), benign, 'ordinary diagnostics stay printable')
  }
})

/* ------------- exact-value replacement of the supplied probe token -------- */

/*
 * What this covers, and what it does not.
 *
 * It covers the one value this process was handed -- the token given to
 * `liveDriver()` -- and that value's `encodeURIComponent` form, because a
 * token can reach a diagnostic through a URL. That is the claim, and it is the
 * whole claim: no arbitrary undisclosed secret, no other transformation, no
 * environment sweep, no clipboard, no file. Every value below is synthetic and
 * injected by the test itself.
 *
 * It exists because patterns answer "does this look like a token" and the
 * value that matters is the one nobody predicted the shape of. The synthetic
 * token used here is deliberately invisible to all three existing patterns:
 * its `:` `/` and `+` characters break every run of the token alphabet well
 * below 40 characters.
 */

const SYNTHETIC_PROBE_TOKEN = 'probe-secret:AB/12+zz'
const SYNTHETIC_PROBE_TOKEN_ENCODED = encodeURIComponent(SYNTHETIC_PROBE_TOKEN)

test('the synthetic token is genuinely invisible to the existing patterns', () => {
  /*
   * The premise of every test below. If a pattern already caught this value,
   * none of them would be evidence of anything.
   */
  forgetSecrets()
  const text = `provider said ${SYNTHETIC_PROBE_TOKEN} and ${SYNTHETIC_PROBE_TOKEN_ENCODED}`

  assert.notEqual(SYNTHETIC_PROBE_TOKEN_ENCODED, SYNTHETIC_PROBE_TOKEN, 'the two forms differ')
  assert.equal(redact(text).includes(SYNTHETIC_PROBE_TOKEN), true)
  assert.equal(redact(text).includes(SYNTHETIC_PROBE_TOKEN_ENCODED), true)
})

test('the token supplied to liveDriver is replaced in every occurrence and both forms', async () => {
  forgetSecrets()
  await liveDriver(SYNTHETIC_PROBE_TOKEN)

  const repeated = `${SYNTHETIC_PROBE_TOKEN} then ${SYNTHETIC_PROBE_TOKEN} then ${SYNTHETIC_PROBE_TOKEN}`
  const redacted = redact(`provider echoed ${repeated}`)

  assert.equal(redacted.includes(SYNTHETIC_PROBE_TOKEN), false, 'no occurrence survives')
  assert.match(redacted, /REDACTED/, 'and the removal is visible')
  assert.equal(
    redact(`callback url ...?token=${SYNTHETIC_PROBE_TOKEN_ENCODED}&x=1`).includes(
      SYNTHETIC_PROBE_TOKEN_ENCODED,
    ),
    false,
    'the percent-encoded form goes too',
  )
})

test('the exact value is removed before the message is truncated', async () => {
  /*
   * Order matters here and is easy to get wrong. `redact()` cuts at 200
   * characters; if it cut first, a token sitting past the cut would be gone
   * from the output by luck rather than by design -- and a token sitting just
   * *before* the cut would survive in a half-formed state. Exact replacement
   * runs before the patterns, the whitespace collapse and the cut.
   */
  forgetSecrets()
  await liveDriver(SYNTHETIC_PROBE_TOKEN)

  const far = `${'padding words '.repeat(30)}${SYNTHETIC_PROBE_TOKEN} tail`
  assert.equal(far.indexOf(SYNTHETIC_PROBE_TOKEN) > 200, true, 'the value really is past the cut')
  assert.equal(redact(far).includes(SYNTHETIC_PROBE_TOKEN), false)

  const near = `${'pad '.repeat(40)}${SYNTHETIC_PROBE_TOKEN}`
  assert.equal(redact(near).includes(SYNTHETIC_PROBE_TOKEN), false)
})

test('the exact value is removed from the structured, printable and serialized paths', async () => {
  forgetSecrets()
  const live = await liveDriver(SYNTHETIC_PROBE_TOKEN)
  const fake = fakeDriver()
  const error = new Error(`upstream rejected ${SYNTHETIC_PROBE_TOKEN} for this request`)

  for (const [name, driver] of [
    ['live', live],
    ['fake', fake],
  ] as const) {
    assert.equal(
      driver.describe(error).includes(SYNTHETIC_PROBE_TOKEN),
      false,
      `${name} describe() is the printable V5-V8 path`,
    )
    assert.equal(
      driver.shape(error).message.includes(SYNTHETIC_PROBE_TOKEN),
      false,
      `${name} shape() is the structured ledger`,
    )
  }

  const leaky = fakeDriver()
  const honestDel = leaky.del.bind(leaky)
  leaky.del = async (pathname: string, options: { ifMatch?: string } = {}) => {
    try {
      return await honestDel(pathname, options)
    } catch {
      throw new Error(`refused for ${SYNTHETIC_PROBE_TOKEN} against this store`)
    }
  }

  const outcome = await runProbe(leaky, { rounds: 1, writers: 4, prefix: 'probe/c5-exact-value' })
  const v8 = outcome.checks.find((check: { id: string }) => check.id === 'V8')

  assert.equal(v8.detail.includes(SYNTHETIC_PROBE_TOKEN), false, 'the printed detail')
  assert.equal(
    JSON.stringify(outcome).includes(SYNTHETIC_PROBE_TOKEN),
    false,
    'and the whole serialized outcome',
  )
})

test('scrubSecrets keeps the shape of the text it is given', async () => {
  /*
   * Why there are two functions rather than one. The CLI prints multi-line
   * check details, so the sanitizer it uses at that boundary must not collapse
   * newlines or cut at 200 characters -- `redact()` does both, by design, for
   * a single provider message. `scrubSecrets()` changes nothing but the
   * secret, which is what makes it safe to put every printed line through.
   */
  forgetSecrets()
  await liveDriver(SYNTHETIC_PROBE_TOKEN)

  const multiline = `first line\n  second ${SYNTHETIC_PROBE_TOKEN} line\n  third line`
  const scrubbed = scrubSecrets(multiline)

  assert.equal(scrubbed.includes(SYNTHETIC_PROBE_TOKEN), false)
  assert.equal(scrubbed.split('\n').length, 3, 'the lines survive')
  assert.match(scrubbed, /^first line\n/, 'and so does the leading text')
  assert.match(scrubbed, /third line$/)

  const long = 'x'.repeat(400)
  assert.equal(scrubSecrets(long).length, 400, 'nothing is truncated')
})

test('with no token supplied, nothing is replaced and no diagnostic is harmed', () => {
  /*
   * The absent-token case, which is the fake path's whole life and which a
   * careless implementation breaks loudly: registering an empty string would
   * match at every position of every message and replace the entire output
   * with markers.
   */
  forgetSecrets()
  for (const nothing of [undefined, null, '', '   ', '\n\t']) {
    rememberSecret(nothing)
  }

  const benign = 'stale delete refused as "precondition"; current delete succeeded: true'
  assert.equal(scrubSecrets(benign), benign, 'untouched')
  assert.equal(redact(benign), benign)
  assert.equal(
    redact(`provider said ${SYNTHETIC_PROBE_TOKEN}`).includes(SYNTHETIC_PROBE_TOKEN),
    true,
    'and a value that was never supplied is not treated as though it had been',
  )

  // The patterns still do their own work with nothing registered at all.
  assert.equal(redact(`provider ${'A'.repeat(44)}`).includes('A'.repeat(44)), false)
})

test('a supplied value is forgotten again when the tests ask for it', async () => {
  forgetSecrets()
  await liveDriver(SYNTHETIC_PROBE_TOKEN)
  assert.equal(redact(`x ${SYNTHETIC_PROBE_TOKEN}`).includes(SYNTHETIC_PROBE_TOKEN), false)

  forgetSecrets()
  assert.equal(redact(`x ${SYNTHETIC_PROBE_TOKEN}`).includes(SYNTHETIC_PROBE_TOKEN), true)
})

test('every line the CLI prints, including its failure line, goes through the scrubber', () => {
  /*
   * Checked from the source, the way the safety refusals above are, because
   * the CLI is the one path these tests cannot drive: running `main()` would
   * mean running a probe from inside the test process and reading its console.
   *
   * What the source has to show is that no console write in the CLI bypasses
   * `scrubSecrets()` -- including the last-resort handler, which runs when
   * something unanticipated happened and is therefore the worst possible place
   * to be trusting an assumption about what a string can contain.
   */
  const source = readFileSync(join(process.cwd(), 'scripts', 'blob-probe.mjs'), 'utf8')

  assert.match(source, /const say = \(line\) => console\.log\(scrubSecrets\(line\)\)/)
  assert.match(source, /console\.error\(scrubSecrets\(`probe failed: /)

  // Exactly one `console.log(` in the file, and it is the one inside `say`.
  assert.equal((source.match(/console\.log\(/g) ?? []).length, 1)

  /*
   * And every `console.error(` is one of exactly two kinds: the failure line,
   * which is scrubbed, or one of the three fixed refusals -- the usage line and
   * the two "Refusing to run" messages -- which are literals written in this
   * repository, quote no provider text, and interpolate nothing but the
   * isolation phrase. Nothing else may print to stderr.
   */
  const errorCalls = source.split('console.error(').slice(1)
  assert.equal(errorCalls.length, 4, 'the CLI writes to stderr in four places')

  const allowed = ["scrubSecrets(", "'Usage:", "'Refusing to run:", '`Refusing to run:']
  for (const call of errorCalls) {
    const opening = call.replace(/^\s+/, '').slice(0, 24)
    assert.equal(
      allowed.some((prefix) => opening.startsWith(prefix)),
      true,
      `unaccounted-for console.error: ${opening}`,
    )
  }
  assert.equal(
    errorCalls.filter((call) => call.trimStart().startsWith('scrubSecrets(')).length,
    1,
    'exactly one of them carries text this script did not write, and it is scrubbed',
  )
})

/* ------------------------------------------------------------------ V9 */

/*
 * The deleted-object conditional put.
 *
 * `NoteStore.updateNote` writes with `putIfMatch` against the storage version
 * it read, and the whole reason it does is the interleaving Package 1 names
 * first: an edit already in flight when its note is retracted must **not** put
 * the note back. That rests on one provider behaviour nothing else in this
 * system would catch --
 *
 *     a conditional put naming the revision of an object that has since been
 *     deleted must be refused, and must create nothing.
 *
 * -- and V8 does not reach it: V8 is about a conditional *delete*. V9 is the
 * write-side half, and these tests are the probe's own logic checked against a
 * fake that behaves as documented, plus two mutants that behave as a broken
 * store would.
 *
 * Neither runs the live probe and neither contacts Blob. Live provider
 * behaviour for a conditional put against an already deleted object remains
 * **unverified** until a separately authorised isolated run.
 */

test('V9 passes against a store that refuses a conditional put on a deleted object', async () => {
  const outcome = await runProbe(fakeDriver(), { rounds: 1, writers: 4 })
  const v9 = outcome.checks.find((check: { id: string }) => check.id === 'V9')

  assert.ok(v9, 'V9 was not run at all')
  assert.equal(v9.pass, true, JSON.stringify(v9, null, 2))
  assert.equal(v9.facts.goneFirst, true, 'the object was not actually deleted first')
  assert.equal(v9.facts.refusedHonestly, true)
  assert.equal(v9.facts.stillAbsent, true, 'asking created the object again')
  assert.equal(v9.facts.staleKind, 'precondition')
})

test('V9 fails when a store accepts a conditional put against a deleted object', async () => {
  /*
   * Mutant 1: the store forgets that `ifMatch` names a revision that has to
   * still be there, and treats a conditional put on a missing object as an
   * ordinary create. This is the shape that resurrects a retracted note, and V9
   * is the only check in the file that would see it.
   */
  const broken = fakeDriver()
  const honest = broken.put.bind(broken)
  broken.put = async (
    pathname: string,
    body: string,
    options: { allowOverwrite?: boolean; ifMatch?: string } = {},
  ) => {
    if (options.ifMatch !== undefined) {
      const current = await broken.get(pathname)
      // Absent: accept anyway, and mint it. Exactly the defect.
      if (!current) return honest(pathname, body, { allowOverwrite: true })
    }
    return honest(pathname, body, options)
  }

  const outcome = await runProbe(broken, { rounds: 1, writers: 4 })
  const v9 = outcome.checks.find((check: { id: string }) => check.id === 'V9')

  assert.equal(outcome.passed, false, 'a store that recreates a deleted object passed the probe')
  assert.equal(v9.pass, false, 'V9 is the check that catches it')
  assert.equal(v9.facts.staleKind, 'resolved-successfully', 'the write was not even refused')
  assert.equal(v9.facts.stillAbsent, false, 'the object came back and V9 did not notice')
  assert.match(String(v9.detail), /UNSUPPORTED/, 'the failure does not say what it means')
})

test('V9 fails when a store refuses the put and creates the object anyway', async () => {
  /*
   * Mutant 2: the store raises a precondition failure -- the *right* refusal --
   * and writes the object regardless. A check that judged only the error would
   * print PASS here, which is the failure mode V8 had before its missing-object
   * half was put into its predicate. `stillAbsent` is what catches it.
   */
  const broken = fakeDriver()
  const honest = broken.put.bind(broken)
  broken.put = async (
    pathname: string,
    body: string,
    options: { allowOverwrite?: boolean; ifMatch?: string } = {},
  ) => {
    if (options.ifMatch !== undefined) {
      const current = await broken.get(pathname)
      if (!current) {
        await honest(pathname, body, { allowOverwrite: true })
        const error = new Error('precondition failed')
        error.name = 'BlobPreconditionFailedError'
        throw error
      }
    }
    return honest(pathname, body, options)
  }

  const outcome = await runProbe(broken, { rounds: 1, writers: 4 })
  const v9 = outcome.checks.find((check: { id: string }) => check.id === 'V9')

  assert.equal(v9.facts.staleKind, 'precondition', 'the refusal itself looked correct')
  assert.equal(v9.facts.refusedHonestly, true, 'the refusal itself looked correct')
  assert.equal(v9.facts.stillAbsent, false, 'the object was recreated behind the refusal')
  assert.equal(v9.pass, false, 'V9 passed a store that recreated the object behind a refusal')
})

/* ================= P3.1: V9 against the shape the live store actually used ============= */

/*
 * The live answer, wired into the probe's own logic.
 *
 * P3.1 ran V9 against an isolated store and the store refused the stale
 * conditional put -- `goneFirst=true`, `stillAbsent=true`, nothing
 * resurrected -- but refused it as a base `BlobError` carrying
 * "Vercel Blob: The specified key does not exist.", which the classifier
 * accepted only from a conditional *delete*. V9 therefore recorded `other`
 * and failed a store that had behaved correctly.
 *
 * These three tests are the mapping and its limits, executed rather than read
 * off the source: the live shape now classifies `notfound` and V9 passes on
 * it, and V9 still fails the moment the object is not actually absent --
 * which is the half of the predicate a message can never establish.
 */

/** A fake whose stale conditional put refuses exactly the way the live store did. */
const liveShapeDriver = async ({ recreate = false } = {}) => {
  const { BlobError } = await import('@vercel/blob')
  const live = await liveDriver('this-token-is-never-used-no-method-is-called')
  const store = fakeDriver()
  const honest = store.put.bind(store)

  // The classifier under test is the live one; everything else stays honest.
  store.classify = live.classify
  store.describe = live.describe
  store.shape = live.shape
  store.put = async (
    pathname: string,
    body: string,
    options: { allowOverwrite?: boolean; ifMatch?: string } = {},
  ) => {
    if (options.ifMatch !== undefined && !(await store.get(pathname))) {
      // Optionally mint the object anyway, behind the same honest-looking
      // refusal: the defect `stillAbsent` exists to catch.
      if (recreate) await honest(pathname, body, { allowOverwrite: true })
      throw new BlobError(tailOf(DEMONSTRATED_MISSING))
    }
    return honest(pathname, body, options)
  }
  return store
}

test('V9 passes on the exact refusal shape the live store used', async () => {
  const outcome = await runProbe(await liveShapeDriver(), {
    rounds: 1,
    writers: 4,
    prefix: 'probe/p3-1-live-shape',
  })
  const v9 = outcome.checks.find((check: { id: string }) => check.id === 'V9')

  assert.equal(v9.facts.staleKind, 'notfound', 'the demonstrated live shape is recognised')
  assert.equal(v9.facts.goneFirst, true)
  assert.equal(v9.facts.refusedHonestly, true)
  assert.equal(v9.facts.stillAbsent, true, 'and nothing was created by asking')
  assert.equal(v9.pass, true)
  assert.doesNotMatch(String(v9.detail), /UNSUPPORTED/)
})

test('V9 still fails on that same shape if the object comes back', async () => {
  /*
   * The half of V9 the classification cannot carry. A store that says the key
   * does not exist and mints it anyway has told the truth about the request
   * and lied about the outcome; `stillAbsent` is the only thing in the
   * predicate that can see it, and widening the classifier must not have
   * quietly removed it.
   */
  const outcome = await runProbe(await liveShapeDriver({ recreate: true }), {
    rounds: 1,
    writers: 4,
    prefix: 'probe/p3-1-live-shape-recreated',
  })
  const v9 = outcome.checks.find((check: { id: string }) => check.id === 'V9')

  assert.equal(v9.facts.staleKind, 'notfound', 'the refusal itself still looked correct')
  assert.equal(v9.facts.refusedHonestly, true, 'and so did the honesty flag on its own')
  assert.equal(v9.facts.stillAbsent, false, 'but the object was recreated behind the refusal')
  assert.equal(v9.pass, false, 'V9 passed a store that resurrected a retracted note')
  assert.match(String(v9.detail), /UNSUPPORTED/)
  assert.equal(outcome.passed, false, 'and the whole probe fails closed')
})

test('the missing-object sentence is still not accepted from V8 in the wrong class', async () => {
  /*
   * The narrowing survives the widening. V9's new licence is for the exact
   * demonstrated shape on the conditional write, and for nothing else: a
   * transport error or a subclass quoting the same words is still ambiguous
   * on every operation, including the one just licensed.
   */
  const blob = await import('@vercel/blob')
  const driver = await liveDriver('this-token-is-never-used-no-method-is-called')

  for (const { what, error } of wrongShapes(blob, DEMONSTRATED_MISSING)) {
    assert.equal(
      driver.classify(error, OPERATION.CONDITIONAL_WRITE),
      'other',
      `${what} on a conditional write says nothing about whether the object was there`,
    )
  }
  assert.equal(
    driver.classify(new blob.BlobError(tailOf(DEMONSTRATED_MISSING)), OPERATION.CREATE),
    'other',
    'and a create, which sends no conditional request, is still not licensed',
  )
})

/* ============== the retained hardening: early prefix, and cleanup on a throw ========== */

/*
 * Two properties of `runProbe` itself, both proven by running it.
 *
 * The probe writes to a real store, so the two ways a run can strand objects
 * matter more than anything it reports. Before this hardening the unique
 * prefix was printed only in the summary -- which an unexpected throw never
 * reaches -- and the clean-up sweep sat after the scenarios rather than in a
 * `finally`, so the same throw skipped it. An operator was left with objects
 * in a store and no record of where to look for them.
 *
 * Neither test contacts a provider: both run against the script's own
 * in-process fake.
 */

/** A fake that records every pathname it has ever created, and can be made to throw. */
const countingDriver = (throwOnGetOf: string | null = null) => {
  const store = fakeDriver()
  const honestPut = store.put.bind(store)
  const honestGet = store.get.bind(store)
  const created = new Set<string>()
  let puts = 0
  let thrown = false

  store.put = async (pathname: string, body: string, options: Record<string, unknown> = {}) => {
    puts += 1
    const result = await honestPut(pathname, body, options)
    created.add(pathname)
    return result
  }
  store.get = async (pathname: string) => {
    if (throwOnGetOf !== null && !thrown && pathname.endsWith(throwOnGetOf)) {
      thrown = true
      // An unexpected class: not a Blob refusal, not anything `classify()`
      // knows, and deliberately on a directly awaited `get` rather than one
      // inside `Promise.allSettled` -- a rejection there is recorded as an
      // ordinary failure and never escapes, which would make this vacuous.
      //
      // It fires **once**, so the fault is transient: the sweep that follows
      // gets honest answers, and what it then leaves behind is a property of
      // the sweep having run at all rather than of the injection persisting.
      throw new TypeError('the socket closed while reading back')
    }
    return honestGet(pathname)
  }

  return {
    store,
    created,
    puts: () => puts,
    async live() {
      const alive: string[] = []
      for (const pathname of Array.from(created)) if (await honestGet(pathname)) alive.push(pathname)
      return alive
    },
  }
}

test('the unique prefix is emitted before the first scenario writes anything', async () => {
  const probe = countingDriver()
  const emitted: { line: string; putsSoFar: number }[] = []

  const outcome = await runProbe(probe.store, {
    rounds: 1,
    writers: 3,
    prefix: 'probe/early-prefix-proof',
    emit: (line: string) => emitted.push({ line, putsSoFar: probe.puts() }),
  })

  assert.ok(emitted.length >= 1, 'nothing was emitted at all')
  assert.equal(emitted[0].putsSoFar, 0, 'the prefix was disclosed after objects already existed')
  assert.match(emitted[0].line, /probe\/early-prefix-proof/)
  assert.ok(probe.puts() > 0, 'the run has to have written something for this to mean anything')
  assert.equal(outcome.prefix, 'probe/early-prefix-proof', 'and it is the prefix actually used')
})

test('an unexpected throw mid-run still reaches the clean-up sweep', async () => {
  /*
   * The injection is a `TypeError` raised by V2's read-back `get`. It is not
   * a refusal, the classifier has no answer for it, and nothing in `runProbe`
   * catches it -- so it escapes, exactly as an unanticipated provider or
   * transport fault would.
   *
   * What has to be true afterwards is that the objects written before the
   * throw are gone. The assertion is over the fake's own contents, read
   * directly, not over anything the probe reported: a run that throws reports
   * nothing.
   */
  const probe = countingDriver('/v2-round-0.json')

  await assert.rejects(
    () =>
      runProbe(probe.store, {
        rounds: 1,
        writers: 3,
        prefix: 'probe/throw-path-cleanup-proof',
      }),
    (thrown: unknown) => thrown instanceof TypeError,
    'the unexpected error still reaches the caller -- it is not swallowed by the sweep',
  )

  assert.ok(probe.created.size > 0, 'the throw came too early to prove anything')
  assert.deepEqual(
    await probe.live(),
    [],
    'objects written before the throw were stranded in the store',
  )
})
