import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/*
 * What the two Blob adapters -- `lib/private-store.ts` and
 * `lib/reviewer-roster.ts` -- conclude from a refusal, checked against the
 * **real** `@vercel/blob` error classes and without a network, a credential or
 * a store.
 *
 * This is the layer the September 14 live probe found wrong, and it is the
 * layer nothing tested. The rule it has to keep is one sentence:
 *
 *     a refusal may be turned into `false` only when the store definitely did
 *     not write. Everything else rejects.
 *
 * `false` means "nothing was changed by this call", and every caller reads it
 * as an honest conflict and carries on. An outage, a throttle, a bad
 * credential or a lost acknowledgement turned into `false` is a change
 * silently dropped, or -- through `removeDeclinedRequest` -- a claim that a
 * record was removed when it was not. So both directions are tested here: the
 * refusals that must map, and the failures that must never map.
 *
 * ## How it runs without a network
 *
 * A resolve-only hook points `@vercel/blob` at a module that re-exports the
 * real SDK's error classes from its own file, by URL, and forwards `put`,
 * `get`, `del` and `list` to an object this file controls. The classes are
 * therefore genuinely the SDK's -- same constructors, same messages, and
 * `instanceof` holds -- while no request is ever made. It follows the pattern
 * `tests/admin-route-boundary.test.ts` already uses for the roster driver;
 * `node --test` gives each test file its own process, so the hook is local to
 * this one.
 */

const PRIVATE_STORE = pathToFileURL(join(process.cwd(), 'lib', 'private-store.ts')).href
const ROSTER = pathToFileURL(join(process.cwd(), 'lib', 'reviewer-roster.ts')).href
const REAL_SDK = pathToFileURL(
  join(process.cwd(), 'node_modules', '@vercel', 'blob', 'dist', 'index.js'),
).href

type BlobDouble = {
  put(pathname: string, body: string, options: Record<string, unknown>): Promise<unknown>
  get(
    pathname: string,
    options: Record<string, unknown>,
  ): Promise<{ stream: string; blob: { etag: string } } | null>
  del(pathname: string, options: Record<string, unknown>): Promise<unknown>
  list(options: Record<string, unknown>): Promise<{ blobs: { pathname: string }[]; hasMore: boolean }>
}

declare global {
  // eslint-disable-next-line no-var
  var __privateBlob: BlobDouble | undefined
}

const inlineModule = (source: string) =>
  `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`

const BLOB_DOUBLE_URL = inlineModule(`
import * as real from ${JSON.stringify(REAL_SDK)}

// The error classes are the real ones, imported by file URL so this hook does
// not intercept its own import. Only the four verbs are replaced.
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

export const put = (...args) => globalThis.__privateBlob.put(...args)
export const get = (...args) => globalThis.__privateBlob.get(...args)
export const del = (...args) => globalThis.__privateBlob.del(...args)
export const list = (...args) => globalThis.__privateBlob.list(...args)
`)

register(
  inlineModule(`export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@vercel/blob') {
    return { url: ${JSON.stringify(BLOB_DOUBLE_URL)}, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}`),
)

/** The SDK's real classes, reached the same way the code under test reaches them. */
const sdk = async () => (await import('@vercel/blob')) as typeof import('@vercel/blob')

// Never sent anywhere: the double below is what receives every call.
const FAKE_TOKEN = 'blob-token-for-tests-only-not-a-real-one'

const backend = async () => {
  const store = (await import(PRIVATE_STORE)) as typeof import('../lib/private-store.ts')
  return store.createPrivateBlobBackend(FAKE_TOKEN)
}

const rosterBackend = async () => {
  const roster = (await import(ROSTER)) as typeof import('../lib/reviewer-roster.ts')
  return roster.createRosterBlobBackend(FAKE_TOKEN)
}

/** A store that answers every verb by refusing with exactly this error. */
function refusesWith(error: unknown): BlobDouble {
  return {
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
  }
}

/* ------------------------------------------ the refusals that must map */

test('a conditional delete of a missing object is "nothing was removed", not an outage', async () => {
  /*
   * The observed V8 failure, at the layer that has to act on it.
   *
   * The live store answers `del(..., { ifMatch })` on a pathname that is not
   * there with the SDK's `bad_request` branch -- a base `BlobError` carrying
   * the service's own words, "The specified key does not exist." -- and not
   * with the typed `BlobNotFoundError` this code was written against. Before
   * this pass that error was rethrown, so `removeDeclinedRequest` turned an
   * ordinary, definite, nothing-was-written refusal into a 500.
   *
   * It is the safest possible refusal to map: the object is absent, so the
   * call cannot have removed anything, and `false` is precisely true.
   */
  const { BlobError } = await sdk()
  globalThis.__privateBlob = refusesWith(new BlobError('The specified key does not exist.'))

  assert.equal(await (await backend()).deleteIfMatch('reviewer/requests/gone.json', '"etag"'), false)
})

test('the two refusals it already understood still mean "nothing was removed"', async () => {
  const { BlobNotFoundError, BlobPreconditionFailedError } = await sdk()

  globalThis.__privateBlob = refusesWith(new BlobNotFoundError())
  assert.equal(await (await backend()).deleteIfMatch('reviewer/requests/one.json', '"etag"'), false)

  globalThis.__privateBlob = refusesWith(new BlobPreconditionFailedError())
  assert.equal(await (await backend()).deleteIfMatch('reviewer/requests/one.json', '"etag"'), false)
})

test('a lost compare-and-swap is a refusal; a taken pathname is a refusal', async () => {
  const { BlobPreconditionFailedError, BlobError } = await sdk()

  globalThis.__privateBlob = refusesWith(new BlobPreconditionFailedError())
  assert.equal(await (await backend()).putIfMatch('reviewer/roster.json', '{}', '"etag"'), false)

  globalThis.__privateBlob = refusesWith(
    new BlobError('This blob already exists, use allowOverwrite: true if you want to overwrite it.'),
  )
  assert.equal(
    await (await backend()).putIfMatch('reviewer/roster.json', '{}', null),
    false,
    'only for the create case, where the pathname being taken is the whole answer',
  )
  assert.deepEqual(await (await backend()).putIfAbsent('reviewer/roster.json', '{}'), {
    created: false,
    version: null,
  })
})

/* --------------------------------- the failures that must never map */

type Sdk = typeof import('@vercel/blob')

const NEVER_A_REFUSAL: { what: string; make: (blob: Sdk) => unknown }[] = [
  {
    what: 'a genuine outage',
    make: (blob) => new blob.BlobServiceNotAvailable(),
  },
  {
    what: 'throttling, which 20 simultaneous writers can produce on their own',
    make: (blob) => new blob.BlobServiceRateLimited(7),
  },
  {
    what: 'an unknown answer, which is what a lost acknowledgement looks like',
    make: (blob) => new blob.BlobUnknownError(),
  },
  {
    what: 'an aborted request, where the write may well have landed',
    make: (blob) => new blob.BlobRequestAbortedError(),
  },
  {
    what: 'a missing *store*, whose message also says "does not exist"',
    make: (blob) => new blob.BlobStoreNotFoundError(),
  },
  {
    what: 'a rejected credential',
    make: (blob) => new blob.BlobAccessError(),
  },
  {
    what: 'a transport failure that never reached the service',
    make: () => Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNRESET') }),
  },
  {
    what: 'a bad_request the service sent for some other reason',
    make: (blob) => new blob.BlobError('pathname is too long'),
  },
]

for (const { what, make } of NEVER_A_REFUSAL) {
  test(`${what} rejects rather than reporting a conflict`, async () => {
    const blob = await sdk()
    const error = make(blob)
    const store = await backend()
    const roster = await rosterBackend()

    globalThis.__privateBlob = refusesWith(error)

    await assert.rejects(
      () => roster.putObjectIfMatch('roster/v1/roster.json', '{}', '"etag"'),
      'the roster would have reported a dropped change as "somebody else won"',
    )
    await assert.rejects(
      () => roster.putObjectIfMatch('roster/v1/roster.json', '{}', null),
      'and the first-ever roster is not a wider gate than a later one',
    )
    await assert.rejects(
      () => store.deleteIfMatch('reviewer/requests/one.json', '"etag"'),
      'removeIfMatch would have claimed it removed a record it never removed',
    )
    await assert.rejects(
      () => store.putIfMatch('reviewer/roster.json', '{}', '"etag"'),
      'writeIfMatch would have reported a dropped change as "somebody else won"',
    )
    await assert.rejects(
      () => store.putIfMatch('reviewer/roster.json', '{}', null),
      'and the create case is not a wider gate than the conditional one',
    )
    await assert.rejects(
      () => store.putIfAbsent('reviewer/roster.json', '{}'),
      'create would have reported "it was already there" about a store it never reached',
    )
  })
}

test('the throttling refusal carries the provider\'s own retry-after, and is still not a conflict', async () => {
  /*
   * `BlobServiceRateLimited` is the one error in this set that carries a
   * number worth keeping -- `retryAfter`, seconds, from a response header. It
   * is safe to record and useless as an excuse: throttling still says nothing
   * about whether the write landed, so it still rejects.
   */
  const { BlobServiceRateLimited } = await sdk()
  const thrown = new BlobServiceRateLimited(11)

  assert.equal((thrown as { retryAfter?: number }).retryAfter, 11)

  globalThis.__privateBlob = refusesWith(thrown)
  await assert.rejects(
    () => (async () => (await backend()).putIfMatch('reviewer/roster.json', '{}', '"etag"'))(),
    (error: unknown) => error === thrown,
    'the original error reaches the caller intact, with nothing swallowed',
  )
})

/* ------------------- the second shape of a lost compare-and-swap */

/*
 * The V2 finding, at the layer that has to act on it.
 *
 * The September 14 instrumented run put 20 conditional writers on one ETag,
 * ten times over. Of the 190 losers, 77 arrived as the typed
 * `BlobPreconditionFailedError` and 113 arrived as an untyped `bad_request`
 * carrying the service's own sentence:
 *
 *     Vercel Blob: The conditional request cannot succeed due to a conflicting
 *     operation against this resource.
 *
 * The same run read back what survived each round and found, in all ten, the
 * acknowledged winner's own body at the winner's own returned revision -- so
 * no refused writer had persisted anything. That is what licenses the mapping;
 * the message on its own would not.
 */

const CONDITIONAL_CONFLICT =
  'The conditional request cannot succeed due to a conflicting operation against this resource.'

test('the second shape of a lost compare-and-swap is a refusal, in both adapters', async () => {
  const { BlobError } = await sdk()
  globalThis.__privateBlob = refusesWith(new BlobError(CONDITIONAL_CONFLICT))

  assert.equal(
    await (await backend()).putIfMatch('reviewer/roster.json', '{}', '"etag"'),
    false,
    'writeIfMatch turns it into "somebody else wrote first", which is what it is',
  )
  assert.equal(
    await (await rosterBackend()).putObjectIfMatch('roster/v1/roster.json', '{}', '"etag"'),
    false,
    'and the roster agrees, or the two would disagree about what a conflict is',
  )
})

test('the conditional-conflict refusal is not extended to operations that cannot receive it', async () => {
  /*
   * Narrowness, in the two directions it can be lost.
   *
   * A create-if-absent sends no conditional request, so it can never honestly
   * be answered "the conditional request cannot succeed"; if it somehow is,
   * that is a surprise and a surprise must reject. And a conditional *delete*
   * was not part of what the run demonstrated -- V8 showed the typed
   * precondition and the missing-key refusal, and nothing else -- so the
   * mapping deliberately stops at the write.
   */
  const { BlobError } = await sdk()
  globalThis.__privateBlob = refusesWith(new BlobError(CONDITIONAL_CONFLICT))

  await assert.rejects(
    () => (async () => (await backend()).putIfMatch('reviewer/roster.json', '{}', null))(),
    'the create case never sends a conditional request',
  )
  await assert.rejects(
    () =>
      (async () =>
        (await rosterBackend()).putObjectIfMatch('roster/v1/roster.json', '{}', null))(),
    'and neither does the first-ever roster',
  )
  await assert.rejects(
    () => (async () => (await backend()).putIfAbsent('reviewer/roster.json', '{}'))(),
    'nor does create-if-absent',
  )
  await assert.rejects(
    () =>
      (async () => (await backend()).deleteIfMatch('reviewer/requests/one.json', '"etag"'))(),
    'and the conditional delete was never demonstrated, so it is not mapped',
  )
})

test('the mapping matches the sentence, not the words "conflict" or "cannot"', async () => {
  /*
   * The thing that would quietly widen this: a message that merely mentions a
   * conflict. Anything short of the service's actual claim -- that the
   * conditional request cannot succeed -- says nothing about whether the write
   * landed, so it keeps rejecting.
   */
  const { BlobError } = await sdk()
  const near = [
    'A conflicting operation is in progress against this resource.',
    'Conflict.',
    'The request cannot succeed.',
    'This store does not exist.',
  ]

  for (const message of near) {
    globalThis.__privateBlob = refusesWith(new BlobError(message))
    await assert.rejects(
      () => (async () => (await backend()).putIfMatch('reviewer/roster.json', '{}', '"etag"'))(),
      `"${message}" is not the demonstrated refusal and must not be read as one`,
    )
    await assert.rejects(
      () =>
        (async () =>
          (await rosterBackend()).putObjectIfMatch('roster/v1/roster.json', '{}', '"etag"'))(),
      `"${message}" must not be read as a conflict by the roster either`,
    )
  }
})
/* ------- the demonstrated shape is a class plus a complete message ------- */

/*
 * What C3's CF-1 and CF-2 found, and what closes them.
 *
 * The mappings above were written as `message.toLowerCase().includes(...)` over
 * any `Error`. The live run demonstrated something much narrower: the SDK's
 * **base** `BlobError` -- the `bad_request` branch, not a subclass -- carrying
 * one complete sentence. A substring test over arbitrary errors accepts three
 * things the run never demonstrated:
 *
 *   the wrong class       a transport `TypeError` that quotes the service, or
 *                         any wrapper around the SDK's base error
 *   an SDK subclass       an outage, a throttle, an unknown -- all of which
 *                         extend `BlobError` -- if one ever carries the words
 *   a message superset    the sentence with a request id, a prefix, or a
 *                         different case
 *
 * Each of those is an *ambiguous* answer, and ambiguity read as a definite
 * refusal is the forbidden consequence: a write nobody can vouch for reported
 * as a compare-and-swap loss, or a delete nobody can vouch for reported as
 * "nothing was removed". They must all reject.
 *
 * The positives below therefore pin the exact class and the exact sentence,
 * and every negative deliberately *contains* the accepted fragment, so a
 * widening of either half fails a test rather than passing one.
 */

/** Exactly what the live store said, byte for byte, both times. */
const DEMONSTRATED = {
  conditionalConflict:
    'Vercel Blob: The conditional request cannot succeed due to a conflicting operation against this resource.',
  missingObject: 'Vercel Blob: The specified key does not exist.',
} as const

/** The SDK prefixes every message it constructs; this is the tail it adds to. */
const withoutPrefix = (message: string) => message.replace(/^Vercel Blob: /, '')

/** Force an exact message onto an error the SDK builds with a fixed one. */
function carrying<T extends Error>(error: T, message: string): T {
  Object.defineProperty(error, 'message', { value: message, writable: true, configurable: true })
  return error
}

/**
 * Errors that are *not* the demonstrated shape, each one carrying the accepted
 * text so that only the class-and-whole-message rule can reject them.
 */
const WRONG_SHAPE: { what: string; make: (blob: Sdk, message: string) => unknown }[] = [
  {
    what: 'a transport TypeError quoting the service word for word',
    make: (_blob, message) =>
      Object.assign(new TypeError(message), { cause: new Error('socket hang up') }),
  },
  {
    what: 'a plain Error carrying the sentence',
    make: (_blob, message) => new Error(message),
  },
  {
    what: 'a wrapper class extending the SDK base error',
    make: (blob, message) => {
      class WrappedBlobError extends blob.BlobError {}
      return new WrappedBlobError(withoutPrefix(message))
    },
  },
  {
    what: 'an SDK subclass -- an unknown answer -- carrying the sentence',
    make: (blob, message) => carrying(new blob.BlobUnknownError(), message),
  },
  {
    what: 'an SDK subclass -- a missing store -- carrying the sentence',
    make: (blob, message) => carrying(new blob.BlobStoreNotFoundError(), message),
  },
  {
    what: 'the sentence with a request id appended',
    make: (blob, message) => new blob.BlobError(`${withoutPrefix(message)} (request id 01JBQ7)`),
  },
  {
    what: 'the sentence with text in front of it',
    make: (blob, message) => new blob.BlobError(`upstream said: ${withoutPrefix(message)}`),
  },
  {
    what: 'the sentence in a different case',
    make: (blob, message) => new blob.BlobError(withoutPrefix(message).toUpperCase()),
  },
]

for (const { what, make } of WRONG_SHAPE) {
  test(`${what} is not a conditional conflict in either adapter`, async () => {
    const blob = await sdk()
    const error = make(blob, DEMONSTRATED.conditionalConflict)
    globalThis.__privateBlob = refusesWith(error)

    await assert.rejects(
      () => (async () => (await backend()).putIfMatch('reviewer/roster.json', '{}', '"etag"'))(),
      (thrown: unknown) => thrown === error,
      'writeIfMatch would have called an ambiguous answer a definite lost compare-and-swap',
    )
    await assert.rejects(
      () =>
        (async () =>
          (await rosterBackend()).putObjectIfMatch('roster/v1/roster.json', '{}', '"etag"'))(),
      (thrown: unknown) => thrown === error,
      'and the roster must agree, or the two disagree about what a conflict is',
    )
  })

  test(`${what} is not a missing object`, async () => {
    const blob = await sdk()
    const error = make(blob, DEMONSTRATED.missingObject)
    globalThis.__privateBlob = refusesWith(error)

    await assert.rejects(
      () => (async () => (await backend()).deleteIfMatch('reviewer/requests/one.json', '"etag"'))(),
      (thrown: unknown) => thrown === error,
      'removeIfMatch would have claimed it removed a record it never removed',
    )
  })
}

test('the exact demonstrated shape still maps, in both adapters and both mappings', async () => {
  /*
   * The other half of narrowness: the repair must not have closed the finding
   * by refusing everything. These two are what the live run actually recorded.
   */
  const { BlobError } = await sdk()

  const conflict = new BlobError(withoutPrefix(DEMONSTRATED.conditionalConflict))
  assert.equal(conflict.message, DEMONSTRATED.conditionalConflict, 'the pin is the real message')
  globalThis.__privateBlob = refusesWith(conflict)
  assert.equal(await (await backend()).putIfMatch('reviewer/roster.json', '{}', '"etag"'), false)
  assert.equal(
    await (await rosterBackend()).putObjectIfMatch('roster/v1/roster.json', '{}', '"etag"'),
    false,
  )

  const missing = new BlobError(withoutPrefix(DEMONSTRATED.missingObject))
  assert.equal(missing.message, DEMONSTRATED.missingObject, 'and so is this one')
  globalThis.__privateBlob = refusesWith(missing)
  assert.equal(await (await backend()).deleteIfMatch('reviewer/requests/gone.json', '"etag"'), false)
})

/* ------------------------ the real roster consumer ----------------------- */

test('an ambiguous acknowledgement is not retried as a definite conflict', async () => {
  /*
   * CF-1's consequence, at the layer that suffers it.
   *
   * `mutateRoster` retries a `RosterConflictError` up to
   * `ROSTER_MUTATION_ATTEMPTS` times, because a conflict means somebody else
   * wrote and the change should be re-derived against what won. That is right
   * for a *definite* loss and wrong for an unknown: a lost acknowledgement may
   * mean the write landed, and re-applying it four more times is four more
   * writes against a document whose real state nobody has read.
   *
   * The Judge reproduced exactly that -- an ambiguous `TypeError` became a
   * definite conflict and the real consumer issued every configured attempt.
   * The count below is what makes this a test of the consumer and not of the
   * adapter: one attempt, and the original error intact.
   */
  const roster = (await import(ROSTER)) as typeof import('../lib/reviewer-roster.ts')
  const stored = roster.serializeRosterDocument(roster.emptyRoster())

  const ambiguous = Object.assign(new TypeError(DEMONSTRATED.conditionalConflict), {
    cause: new Error('the connection closed before the answer arrived'),
  })
  let writes = 0

  globalThis.__privateBlob = {
    async put() {
      writes += 1
      throw ambiguous
    },
    async get() {
      return { stream: stored, blob: { etag: '"roster-etag-1"' } }
    },
    async del() {
      throw new Error('the roster never deletes')
    },
    async list() {
      return { blobs: [], hasMore: false }
    },
  }

  const store = roster.createVercelBlobRosterStore({ token: FAKE_TOKEN })

  await assert.rejects(
    () =>
      roster.mutateRoster(
        (doc) => ({ reviewers: doc.reviewers, event: null, result: 'unused' }),
        store,
      ),
    (thrown: unknown) => thrown === ambiguous,
    'the unknown reaches the caller intact instead of arriving as RosterConflictError',
  )
  assert.equal(writes, 1, 'and it is attempted once, not ROSTER_MUTATION_ATTEMPTS times')
  assert.equal(roster.ROSTER_MUTATION_ATTEMPTS, 5, 'which is the count that would otherwise apply')
})

test('a real lost compare-and-swap is still retried, and still gives up honestly', async () => {
  /*
   * The preservation half. Narrowing the mapping must not have turned a
   * genuine conflict into an unknown: the demonstrated refusal still means
   * "somebody else wrote", and that is still worth re-deriving the change
   * against.
   */
  const roster = (await import(ROSTER)) as typeof import('../lib/reviewer-roster.ts')
  const { BlobError } = await sdk()
  const stored = roster.serializeRosterDocument(roster.emptyRoster())

  let writes = 0
  globalThis.__privateBlob = {
    async put() {
      writes += 1
      throw new BlobError(withoutPrefix(DEMONSTRATED.conditionalConflict))
    },
    async get() {
      return { stream: stored, blob: { etag: '"roster-etag-1"' } }
    },
    async del() {
      throw new Error('the roster never deletes')
    },
    async list() {
      return { blobs: [], hasMore: false }
    },
  }

  const store = roster.createVercelBlobRosterStore({ token: FAKE_TOKEN })

  await assert.rejects(
    () =>
      roster.mutateRoster(
        (doc) => ({ reviewers: doc.reviewers, event: null, result: 'unused' }),
        store,
      ),
    (thrown: unknown) => thrown instanceof roster.RosterConflictError,
    'a demonstrated conflict is still a conflict',
  )
  assert.equal(writes, roster.ROSTER_MUTATION_ATTEMPTS, 'and it is still re-derived and retried')
})
