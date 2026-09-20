#!/usr/bin/env node
/**
 * The live-store probe: nine assumptions about Vercel Blob, checked against a
 * real store rather than against its documentation.
 *
 * Everything in `lib/private-store.ts` rests on three primitives, and the whole
 * reviewer-account design rests on `lib/private-store.ts`:
 *
 *   create-if-absent is atomic     `put(..., { allowOverwrite: false })`
 *   compare-and-swap works         `put(..., { ifMatch })`, `del(..., { ifMatch })`
 *   a read sees the latest write   `get(..., { useCache: false })`
 *
 * The SDK documents all three. What the documentation does **not** state is
 * whether the service enforces the first under genuine concurrency, what the
 * "already exists" refusal actually looks like, or what a conditional delete
 * does to a pathname that is not there. Those are assumptions until somebody
 * watches the real thing do them, and this script is that somebody.
 *
 * The last of those three is a **requirement**, not a curiosity: a conditional
 * delete of a missing object must not report success, because
 * `lib/private-store.ts:deleteIfMatch` turns any refusal into `false` and every
 * caller reads `false` as an honest conflict. A provider that silently resolved
 * would make `removeIfMatch()` claim it removed the revision it named when it
 * removed nothing. V8 checks that as part of its pass condition and fails closed
 * when the provider cannot support it, naming exactly what it did instead.
 *
 * ## Safety, which is the first thing this script is about
 *
 * It writes. So it refuses to run against anything it has not been told, in so
 * many words, is an isolated store:
 *
 *   - It reads **`BLOB_PROBE_TOKEN`**, never `BLOB_READ_WRITE_TOKEN`. Sharing
 *     the variable with the application is how a probe ends up in production.
 *   - It refuses unless `BLOB_PROBE_ISOLATED=yes-this-store-holds-no-production-data`
 *     is set, which is a sentence an operator has to mean.
 *   - Every object it writes lives under `probe/<iso timestamp>-<random>/`, a
 *     prefix no application code reads or lists, and it deletes them afterwards
 *     and reports anything it could not delete.
 *   - It never prints a token, and never prints anything derived from one.
 *
 * Run it against the fake first. The fake implements the semantics the docs
 * describe, so a green fake run means the probe's own logic is right and a red
 * live run means the service differs from its documentation -- which is exactly
 * the distinction worth having.
 *
 *     node scripts/blob-probe.mjs --fake     # no credential, no network
 *     node scripts/blob-probe.mjs --live     # needs the two variables above
 *
 * Exit code 0 when every check passed **and** the clean-up sweep left nothing
 * behind, 1 otherwise. `tests/blob-probe.test.ts` runs the fake path, so the
 * script cannot rot unnoticed.
 */

import { randomBytes } from 'node:crypto'

/** How many simultaneous writers each concurrency check uses. */
const WRITERS = 20
/** How many times the concurrency checks repeat, to catch a rare double win. */
const ROUNDS = 10

/* ------------------------------------------------------ what a refusal was */

/**
 * The exact secret values this process was actually handed.
 *
 * Patterns answer "does this look like a secret". They cannot answer "is this
 * the very string we were given", and a token whose shape nobody anticipated
 * is precisely the one a pattern misses. So the one value this script is known
 * to hold is compared against literally as well.
 *
 * The scope is exactly that, said plainly because the opposite is easy to
 * imply: this holds the probe token `liveDriver()` was given and that token's
 * `encodeURIComponent` form, because a token can reach a diagnostic through a
 * URL. It is **not** protection against arbitrary undisclosed secrets, and it
 * does not follow a value through any other transformation -- not base64, not
 * hashing, not splitting, not re-encoding. Anything else is only as covered as
 * the patterns below make it.
 */
const knownSecrets = new Set()

/**
 * Remember one exact value, and the percent-encoded form of it.
 *
 * Blank input is ignored rather than stored. An empty string occurs at every
 * position of every message, so registering one would replace the whole output
 * with markers -- destroying the diagnostics this is meant to keep safe *and*
 * readable. The live CLI cannot reach here blank, because it refuses an empty
 * `BLOB_PROBE_TOKEN` before a driver is built; the fake path and the tests can,
 * and doing nothing is the right answer for them.
 */
export function rememberSecret(value) {
  const exact = String(value ?? '').trim()
  if (exact === '') return
  knownSecrets.add(exact)
  const encoded = encodeURIComponent(exact)
  if (encoded !== exact) knownSecrets.add(encoded)
}

/** Forget every remembered value, so a test can inject its own and clean up. */
export function forgetSecrets() {
  knownSecrets.clear()
}

/**
 * Exact-value replacement, and nothing else.
 *
 * Kept separate from `redact()` because this is the only sanitizing step that
 * is safe to run over text whose shape carries meaning: it does not collapse
 * whitespace and it does not truncate. That is what lets the CLI put every
 * line it prints through it without turning a multi-line check detail into a
 * single 200-character line.
 *
 * Longest first, so a value that contains another is replaced whole rather
 * than left holding a redacted fragment.
 */
export function scrubSecrets(text) {
  let output = String(text ?? '')
  for (const secret of [...knownSecrets].sort((one, two) => two.length - one.length)) {
    output = output.split(secret).join('[REDACTED probe token]')
  }
  return output
}

/**
 * A message safe to print, and visibly so.
 *
 * Provider messages are the service's words, not ours, and this script runs
 * next to a credential. Anything token-shaped is replaced with the word
 * REDACTED rather than dropped, so a reader can tell the difference between
 * "nothing was there" and "something was taken out".
 *
 * Exact values come out **first** -- before the patterns, and before the
 * whitespace collapse and the 200-character cut. A supplied token therefore
 * cannot survive by being shaped unlike a token, and cannot survive by sitting
 * past the truncation point of a long message.
 *
 * The opaque-value pattern bounds itself with the token alphabet rather than
 * with `\b`, and that is a repair, not a flourish. `-` is in the URL-safe
 * alphabet and is not a regex word character, so no word boundary exists at a
 * hyphen endpoint: `\b[A-Za-z0-9_-]{40,}\b` let a 40-character value that
 * began and ended with a hyphen straight through, because the only run `\b`
 * could anchor was the 38-character interior and 38 is short of the threshold.
 * The lookarounds ask what the alphabet actually poses -- is the neighbouring
 * character one that could have been part of this run -- so the whole run gets
 * measured, whichever character it starts and ends on.
 */
export function redact(text) {
  return scrubSecrets(text)
    .replace(/vercel_blob_rw_[A-Za-z0-9_-]+/g, '[REDACTED token]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(
      /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/g,
      '[REDACTED long opaque value]',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

/**
 * What "the demonstrated provider shape" means, for the two mappings below.
 *
 * A demonstrated provider shape is a **class plus a full message**: the SDK's
 * base `BlobError` itself -- not a subclass, not a wrapper around one -- and
 * the complete sentence the live run recorded, compared whole. So the negative
 * controls that keep it honest are the demonstrated fragment arriving in the
 * *wrong class*, and the demonstrated sentence arriving inside a *longer*
 * message; both must stay unrecognised.
 *
 * `Object.getPrototypeOf` rather than `instanceof` because every typed class
 * on this SDK extends `BlobError`, so `instanceof` would widen to an outage, a
 * throttle or a missing store the moment one of them carried these words.
 *
 * If the service ever rewords these, the match stops holding and the error
 * becomes `other` -- unrecognised -- which V2, V8 and V9 all read as a
 * failure. Message drift must fail toward unknown, never toward a definite
 * answer.
 *
 * The *rule* is shared with the code this probe vouches for, and nothing
 * else is. `lib/private-store.ts:isDemonstratedBlobRefusal` and
 * `lib/reviewer-reading-blob.ts`'s own predicate apply this same test --
 * base class plus the complete sentence, compared whole -- so none of the
 * three can drift into matching on a phrase.
 *
 * Which sentence is accepted where is deliberately **not** shared, and the
 * two adapters are not identical. `lib/private-store.ts:putIfMatch` accepts
 * the conditional-conflict sentence on a conditional write and rethrows the
 * missing-object sentence there; its `deleteIfMatch` accepts the
 * missing-object sentence on a conditional delete.
 * `lib/reviewer-reading-blob.ts:putIfMatch` -- the adapter V9 models --
 * accepts the missing-object sentence on its conditional write, the shape
 * the September 19 P3.1 run demonstrated there, and does not accept the
 * conflict sentence at all. `classify()` below is the operation-scoped
 * union of those, so the probe recognises every shape some adapter
 * recognises without crediting any adapter with a shape it rethrows.
 */
export function isDemonstratedBlobRefusal(error, blobErrorClass, message) {
  return (
    error instanceof Error &&
    Object.getPrototypeOf(error) === blobErrorClass.prototype &&
    error.message === message
  )
}

/**
 * Which operation a refusal came back from.
 *
 * The classifier needs to be told, because the two demonstrated shapes below
 * were demonstrated by *particular* operations and each means what it means
 * only there. Without it there is one global answer per error, and a refusal
 * whose meaning was established for a conditional write gets read by a
 * conditional delete as though it had been established there too.
 *
 * That is not a hypothetical. The conditional-conflict sentence says a
 * conditional *request* could not succeed; observed on a write, it is a
 * definite lost compare-and-swap. Arriving on a delete it has never been
 * demonstrated to mean that, and `lib/private-store.ts:deleteIfMatch` does not
 * read it that way -- it accepts a typed precondition or not-found refusal and
 * the exact missing-object sentence, and rethrows everything else. A probe that
 * accepted it would report delete semantics as PASS on evidence licensed for a
 * different operation, which is a false-positive proof gate.
 *
 * An unrecognised or absent operation maps neither shape, so a caller that
 * forgets to say gets `other` -- unknown -- and the checks that depend on a
 * definite answer fail closed rather than quietly passing.
 */
export const OPERATION = Object.freeze({
  /** `put(..., { allowOverwrite: false })` -- create-if-absent. */
  CREATE: 'create',
  /** `put(..., { ifMatch })` -- compare-and-swap write. */
  CONDITIONAL_WRITE: 'conditional-write',
  /** `del(..., { ifMatch })` -- compare-and-swap delete. */
  CONDITIONAL_DELETE: 'conditional-delete',
})

/** The complete sentence the September 14 V8 run recorded, verbatim. */
const MISSING_OBJECT_MESSAGE = 'Vercel Blob: The specified key does not exist.'

/** The complete sentence the September 14 V2 run recorded, verbatim. */
const CONDITIONAL_CONFLICT_MESSAGE =
  'Vercel Blob: The conditional request cannot succeed due to a conflicting operation against this resource.'

/**
 * The SDK's own error-code to error-class map, read backwards.
 *
 * `@vercel/blob@2.8.0` reads the service's `error.code`, picks a class from it,
 * and then **discards the code**: nothing on the thrown object carries it. So
 * the code cannot be read off an error, only inferred from which class arrived
 * -- and two of the classes are reached from more than one code, which is why
 * those two entries name both.
 *
 * It is labelled "inferred" everywhere it is printed, because that is what it
 * is. The one genuinely-supplied number the SDK does keep is `retryAfter` on a
 * rate-limit refusal, and that is recorded separately and verbatim.
 */
const INFERRED_SERVICE_CODE = {
  BlobStoreSuspendedError: 'store_suspended',
  BlobAccessError: 'forbidden',
  BlobOidcEnvironmentNotAllowedError: 'oidc_environment_not_allowed',
  BlobContentTypeNotAllowedError: 'content_type_not_allowed',
  BlobPathnameMismatchError: 'client_token_pathname_mismatch',
  BlobClientTokenExpiredError: 'client_token_expired',
  BlobFileTooLargeError: 'file_too_large',
  BlobNotFoundError: 'not_found',
  BlobStoreNotFoundError: 'store_not_found',
  BlobServiceNotAvailable: 'service_unavailable',
  BlobServiceRateLimited: 'rate_limited',
  BlobPreconditionFailedError: 'precondition_failed',
  BlobUnknownError: 'unknown_error | not_allowed',
  BlobError: 'bad_request | client_token_not_allowed',
  BlobRequestAbortedError: 'none -- the request never got an answer',
}

/**
 * One refusal, reduced to what is safe to keep and enough to act on.
 *
 * `infer` is false for the fake, which is not the SDK and whose error names
 * therefore stand for no service code at all. Printing one for it would be
 * inventing evidence about a store that does not exist.
 */
function shapeOf(error, className, infer) {
  const name = className ?? 'Error'
  const retryAfter = typeof error?.retryAfter === 'number' ? error.retryAfter : null
  return {
    className: name,
    message: redact(error?.message),
    inferredServiceCode: infer ? (INFERRED_SERVICE_CODE[name] ?? null) : null,
    retryAfter,
  }
}

/**
 * The set of distinct shapes a population of refusals arrived in.
 *
 * The September 14 live run is the reason this exists. 190 V2 losers were
 * printed as 127 repetitions of the word "other" and 63 silences, and the one
 * fact needed to decide what the service was doing -- *which* errors those
 * were -- was the one fact not kept. A count per distinct (kind, class,
 * message) is that fact, and it is small enough to print in full.
 */
function shapeLedger() {
  const seen = new Map()
  return {
    add(driver, error, kind) {
      const shape = driver.shape(error)
      const key = `${kind}|${shape.className}|${shape.message}`
      const already = seen.get(key)
      if (already) {
        already.count += 1
        return
      }
      seen.set(key, { kind, ...shape, count: 1 })
    },
    entries() {
      return [...seen.values()].sort((one, two) => two.count - one.count)
    },
    /** One line per shape, indented to sit under a check's detail. */
    lines() {
      return this.entries().map((shape) => {
        const code = shape.inferredServiceCode ? `; inferred code: ${shape.inferredServiceCode}` : ''
        const retry = shape.retryAfter === null ? '' : `; retry-after: ${shape.retryAfter}s`
        return `  x${shape.count}  [${shape.kind}] ${shape.className}: ${shape.message}${code}${retry}`
      })
    },
  }
}

/* ------------------------------------------------------------- the drivers */

/**
 * What a probe driver has to do. Deliberately the same shape for the fake and
 * the live store, so the checks below are written once.
 */

/**
 * The documented semantics, in a map.
 *
 * Every mutation is one synchronous section with no `await` in it, so
 * create-if-absent and compare-and-swap are atomic in this process. That makes
 * the fake a model of what the docs promise -- it cannot tell you what the
 * service does, and the header says so.
 */
export function fakeDriver() {
  const objects = new Map()
  let counter = 0
  const nextEtag = () => `"fake-${(counter += 1)}"`

  const conflict = (name, message) => {
    const error = new Error(message)
    error.name = name
    return error
  }

  return {
    name: 'fake',
    async put(pathname, body, options = {}) {
      const { allowOverwrite = false, ifMatch } = options
      if (ifMatch !== undefined) {
        const current = objects.get(pathname)
        if (!current || current.etag !== ifMatch) {
          throw conflict('BlobPreconditionFailedError', 'precondition failed')
        }
        const etag = nextEtag()
        objects.set(pathname, { body, etag })
        return { etag }
      }
      if (!allowOverwrite && objects.has(pathname)) {
        throw conflict('BlobError', 'This blob already exists, use allowOverwrite: true to overwrite it')
      }
      const etag = nextEtag()
      objects.set(pathname, { body, etag })
      return { etag }
    },
    async get(pathname) {
      const current = objects.get(pathname)
      return current ? { body: current.body, etag: current.etag } : null
    },
    async del(pathname, options = {}) {
      const current = objects.get(pathname)
      if (options.ifMatch !== undefined) {
        if (!current) throw conflict('BlobNotFoundError', 'not found')
        if (current.etag !== options.ifMatch) {
          throw conflict('BlobPreconditionFailedError', 'precondition failed')
        }
      }
      objects.delete(pathname)
    },
    /*
     * The fake takes an operation and does not need one, and both halves of
     * that are worth saying.
     *
     * It takes one so that the two drivers stay one interface and the checks
     * below can go on being written once. It does not need one because every
     * refusal it raises is typed or is its own "already exists" wording: it has
     * no untyped provider sentence whose meaning depends on which operation
     * produced it, because it is not the provider. Ignoring the argument here
     * is therefore honest, not lax -- there is nothing for it to scope.
     */
    classify(error, _operation) {
      if (error?.name === 'BlobPreconditionFailedError') return 'precondition'
      if (error?.name === 'BlobNotFoundError') return 'notfound'
      const message = error instanceof Error ? error.message.toLowerCase() : ''
      if (message.includes('already exists') || message.includes('allowoverwrite')) return 'exists'
      return 'other'
    },
    describe(error) {
      // Printable detail goes through the same `redact()` as `shape()`. The
      // fake's messages are this file's own, but the detail strings it feeds
      // are the same V5-V9 fields the live driver fills, and one sanitizer for
      // both is what stops the two paths drifting.
      return `${error?.name ?? 'Error'}: ${redact(error?.message)}`
    },
    shape(error) {
      // The fake sets `name`, because it has no classes to be an instance of.
      return shapeOf(error, error?.name ?? 'Error', false)
    },
  }
}

/**
 * The real store, reached exactly the way `lib/private-store.ts` reaches it:
 * private access, no random suffix, JSON content type, and every read with
 * `useCache: false`.
 */
export async function liveDriver(token) {
  /*
   * The one exact value this process is known to hold. Registered here, at the
   * single point the token is supplied, so that every sanitized path below is
   * checked against the literal string as well as against token shapes.
   */
  rememberSecret(token)

  const blob = await import('@vercel/blob')
  const { put, get, del, BlobError, BlobPreconditionFailedError, BlobNotFoundError } = blob

  /*
   * The service's way of saying the object is not there, when it does not use
   * the typed class for it.
   *
   * V8 of the September 14 run recorded exactly this: a conditional delete of
   * a pathname that was never written came back on the SDK's `bad_request`
   * branch as a base `BlobError` carrying the service's own words, and the
   * classifier answered "other" -- unrecognised -- which V8 reads as
   * UNSUPPORTED. The refusal was honest all along: it did not resolve, and the
   * probe confirmed in the same breath that nothing was created by asking.
   *
   * V9 of the September 19 P3.1 run then recorded the **same class and the
   * same complete sentence** from a conditional *write* against an object
   * deleted after its ETag was read -- and recorded, in the same run, that the
   * write was refused and the object stayed absent (`goneFirst = true`,
   * `stillAbsent = true`). So this sentence is now demonstrated on two
   * operations rather than one, and the classifier accepts it on exactly those
   * two. It is still not accepted from a create, which sends no conditional
   * request and has never been seen to receive this answer.
   *
   * Matched on that class and that complete sentence and nothing else.
   * `BlobStoreNotFoundError` says "This store does not exist.", which is a
   * credential or configuration failure and has to stay unrecognised; the
   * wider "does not exist" would have taken it too, and so would a wrapper
   * quoting the service. `lib/private-store.ts` keeps the same predicate, so
   * the probe and the code it vouches for cannot drift apart.
   */
  const looksLikeMissingObject = (error) =>
    isDemonstratedBlobRefusal(error, BlobError, MISSING_OBJECT_MESSAGE)

  /*
   * The service's second way of refusing a lost compare-and-swap.
   *
   * The September 14 instrumented run is what found this. Of 190 V2 losers,
   * 77 arrived as the typed `BlobPreconditionFailedError` and 113 arrived on
   * the `bad_request` branch carrying the service's own sentence:
   *
   *     Vercel Blob: The conditional request cannot succeed due to a
   *     conflicting operation against this resource.
   *
   * Two shapes, one meaning. It says, in the service's own words, that the
   * conditional request **cannot succeed** -- a statement about the outcome of
   * the request, not a transport failure, not a timeout, and not an unknown.
   * It is not throttling: `BlobServiceRateLimited` says "Too many requests"
   * and did not appear in that run at all. It is not a generic fault:
   * `BlobUnknownError` says "Unknown error" and did not appear either.
   *
   * It is mapped here because the same run *demonstrated* the property that
   * matters, rather than inferring it: every round's surviving revision was
   * the acknowledged winner's own returned ETag, so no refused writer
   * persisted anything. That demonstration is a pass condition of V2 above,
   * so this mapping cannot survive a run in which it stops being true.
   *
   * And it is the demonstrated *shape* -- the base class carrying the complete
   * sentence -- not the phrase. A transport `TypeError` that never got an
   * answer can quote the service verbatim and still say nothing about whether
   * the write landed; classified `precondition` it would be counted as a
   * recognised, definite loser and V2 would pass on it.
   */
  const looksLikeConditionalConflict = (error) =>
    isDemonstratedBlobRefusal(error, BlobError, CONDITIONAL_CONFLICT_MESSAGE)

  const common = {
    token,
    access: 'private',
    contentType: 'application/json; charset=utf-8',
    addRandomSuffix: false,
  }

  return {
    name: 'vercel-blob',
    async put(pathname, body, options = {}) {
      const { allowOverwrite = false, ifMatch } = options
      const result = await put(pathname, body, {
        ...common,
        ...(ifMatch === undefined ? { allowOverwrite } : { ifMatch }),
      })
      return { etag: result.etag ?? null }
    },
    async get(pathname) {
      const result = await get(pathname, { token, access: 'private', useCache: false })
      if (!result?.stream) return null
      return { body: await new Response(result.stream).text(), etag: result.blob?.etag ?? null }
    },
    async del(pathname, options = {}) {
      await del(pathname, options.ifMatch === undefined ? { token } : { token, ifMatch: options.ifMatch })
    },
    /*
     * What a refusal was, given what was asked.
     *
     * The first three answers do not depend on the operation and are unchanged.
     * A typed `BlobPreconditionFailedError` or `BlobNotFoundError` carries its
     * meaning in its class, on any operation; the "already exists" wording is
     * the preexisting create/existence heuristic, left exactly as wide as it
     * was rather than widened or narrowed here.
     *
     * The last two are the ones that need the operation, because each is an
     * *untyped* base `BlobError` recognised only by a sentence, and each
     * sentence was demonstrated by one operation:
     *
     *   missing-object      demonstrated by V8's conditional delete, and --
     *                       since September 19 -- by V9's conditional write
     *   conditional-conflict demonstrated by V2's conditional write
     *
     * So each is licensed only where it was demonstrated, and the
     * missing-object sentence now has two such places rather than one. What
     * licensed the second is not the words: it is that the same run recorded
     * the object absent before the stale write and absent after it, so the
     * refusal provably created nothing. The mapping is that observation, not
     * a reading of the sentence.
     *
     * The conflict sentence is still not accepted from a delete -- neither the
     * stale branch nor the missing branch -- which is the difference between
     * proving delete semantics and assuming them. Neither sentence is accepted
     * from a create, which sends no conditional request at all. Those fall
     * through to `other`, and `other` is a failure for V2, V8 and V9 alike, so
     * the probe reports "I could not tell" rather than a definite answer it
     * did not earn.
     *
     * This mirrors the adapters it vouches for. `lib/private-store.ts`
     * `putIfMatch` accepts the conflict sentence and its `deleteIfMatch`
     * accepts the missing-object sentence; `lib/reviewer-reading-blob.ts`
     * `putIfMatch` -- the driver V9 actually models -- accepts the
     * missing-object sentence on its conditional branch, which is the shape
     * P3.1 demonstrated there. The classifier is the union of what those
     * adapters accept, and `tests/blob-probe.test.ts` pins every cell of that
     * table in both directions so the two cannot drift apart.
     */
    classify(error, operation) {
      if (error instanceof BlobPreconditionFailedError) return 'precondition'
      if (error instanceof BlobNotFoundError) return 'notfound'
      const message = error instanceof Error ? error.message.toLowerCase() : ''
      if (message.includes('already exists') || message.includes('allowoverwrite')) return 'exists'
      if (
        (operation === OPERATION.CONDITIONAL_DELETE ||
          operation === OPERATION.CONDITIONAL_WRITE) &&
        looksLikeMissingObject(error)
      ) {
        return 'notfound'
      }
      if (operation === OPERATION.CONDITIONAL_WRITE && looksLikeConditionalConflict(error)) {
        return 'precondition'
      }
      return 'other'
    },
    describe(error) {
      /*
       * Never the token, and never a body: a class name and a sanitized
       * message.
       *
       * `shape()` redacted and this did not, and this is the one that reaches
       * printable V5-V9 details and the console. Provider-controlled text
       * printed next to a credential is the whole risk; the structured ledger
       * being safe says nothing about the line beside it. Both paths run the
       * same `redact()` now, so a token-shaped or Bearer-shaped value cannot
       * survive one by surviving neither.
       */
      return `${error?.constructor?.name ?? 'Error'}: ${redact(error?.message)}`
    },
    shape(error) {
      return shapeOf(error, error?.constructor?.name ?? 'Error', true)
    },
  }
}

/* -------------------------------------------------------------- the checks */

function settle(results) {
  const wins = results.filter((one) => one.status === 'fulfilled').length
  const failures = results.filter((one) => one.status === 'rejected').map((one) => one.reason)
  return { wins, failures }
}

/**
 * V1 to V9, in the order the architecture numbers them. Each returns a plain
 * record so the caller can print, save or assert over them.
 *
 * V1 to V8 are unchanged and are the cases the September 14 live run settled.
 * V9 is this package's addition -- the conditional **write** against an object
 * that was deleted, which is the other half of the pair V8 opened and the one
 * `NoteStore.updateNote` rests on. The September 19 P3.1 isolated live run
 * exercised it against the real service for the first time and recorded what
 * it does: the write is **refused** and the object **stays absent**, but the
 * refusal arrives as a base `BlobError` carrying the missing-object sentence
 * rather than as either typed class. That is a fact about the provider, not a
 * relaxation of this check -- V9's pass predicate is unchanged and still
 * requires `goneFirst && refusedHonestly && stillAbsent`.
 */
export async function runProbe(driver, options = {}) {
  const rounds = options.rounds ?? ROUNDS
  const writers = options.writers ?? WRITERS
  const root = options.prefix ?? `probe/${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`
  const written = new Set()
  const checks = []

  const at = (name) => {
    const path = `${root}/${name}.json`
    written.add(path)
    return path
  }
  const body = (what) => `${JSON.stringify({ probe: what, at: new Date().toISOString() })}\n`

  const record = (id, title, pass, detail, facts = {}) => {
    checks.push({ id, title, pass, detail, facts })
  }

  /**
   * One concurrency round's worth of bookkeeping, for V1 and V2 alike.
   *
   * Two questions, kept apart, because the September 14 run showed what
   * happens when they are not:
   *
   *   did exactly one writer win, every round?   -- the property under test
   *   was every loser's refusal recognised?      -- the classifier's own health
   *
   * Both must hold for the check to pass, and that has not changed. What has
   * changed is that the record says which one gave way. On September 14 every
   * round reported exactly one winner and V2 still printed FAIL, because one
   * flag carried both; an operator reading that could not tell a store that
   * had lost compare-and-swap from a store whose refusals simply had an
   * unfamiliar shape. Those call for opposite responses.
   */
  const concurrency = (expected, operation) => {
    const winnersPerRound = []
    const ledger = shapeLedger()
    let refusals = 0
    let unrecognised = 0

    return {
      round(wins, failures) {
        winnersPerRound.push(wins)
        for (const error of failures) {
          const kind = driver.classify(error, operation)
          refusals += 1
          if (kind !== expected) unrecognised += 1
          ledger.add(driver, error, kind)
        }
      },
      finish(id, title, extra = {}) {
        const everyRoundHadOneWinner = winnersPerRound.every((count) => count === 1)
        const everyRefusalRecognised = unrecognised === 0
        const shapes = ledger.entries()
        const detail = [
          `${rounds} rounds of ${writers} writers`,
          `winners per round: ${winnersPerRound.join(', ')}` +
            ` (exactly one winner every round: ${everyRoundHadOneWinner ? 'yes' : 'NO'})`,
          `refusals: ${refusals}; recognised as "${expected}": ${refusals - unrecognised};` +
            ` unrecognised: ${unrecognised}` +
            ` (every refusal recognised: ${everyRefusalRecognised ? 'yes' : 'NO'})`,
          ...(shapes.length > 0 ? ['distinct refusal shapes:', ...ledger.lines()] : []),
          /*
           * Said here rather than left to the reader, because it is the
           * inference the evidence most invites and least supports. One winner
           * a round is a statement about acknowledgements, not about bytes: a
           * write can land and its answer be lost, and that writer is counted
           * a loser. Only the refusal's own shape can say whether it wrote.
           */
          ...(unrecognised > 0
            ? [
                'note: the winner count does not establish that the rejected writes',
                '      persisted nothing. These refusals are unclassified, not proven',
                '      to have written nothing.',
              ]
            : []),
          ...(extra.lines ?? []),
        ].join('\n')

        const extraHolds = extra.holds ?? true
        record(id, title, everyRoundHadOneWinner && everyRefusalRecognised && extraHolds, detail, {
          everyRoundHadOneWinner,
          everyRefusalRecognised,
          winnersPerRound,
          refusals,
          unrecognised,
          shapes,
          ...(extra.facts ?? {}),
        })
      },
    }
  }

  /*
   * The unique prefix, disclosed before the first scenario writes anything.
   *
   * The summary at the end prints it too, and that was the only place it was
   * printed. A run that ends in an unexpected throw never reaches the summary,
   * so the one fact an operator needs in order to clean up by hand -- which
   * prefix to sweep -- was the fact that went missing exactly when it was
   * needed. It is emitted through the caller's own sink rather than written to
   * the console here, so it crosses the same `scrubSecrets()` boundary as every
   * other printed line and this file still has exactly one `console.log`.
   */
  const emit = typeof options.emit === 'function' ? options.emit : () => {}
  emit(`prefix:       ${root}`)

  /*
   * The scenario body runs inside `try`, with the existing clean-up sweep
   * below in `finally`, so the sweep runs after a pass, after a recorded FAIL
   * and after an unexpected throw alike. The sweep's own code is unchanged;
   * only its enclosing block moved, and `leftover` moved above the `try` so
   * the return can still read it.
   *
   * The scenario bodies are deliberately NOT re-indented. Re-indenting would
   * add ~350 lines of whitespace to a diff whose every other line is
   * load-bearing, and indentation changes no behaviour.
   */
  const leftover = []

  try {
  /* V1 -- create-if-absent is atomic under concurrent writers. */
  {
    const tally = concurrency('exists', OPERATION.CREATE)
    for (let round = 0; round < rounds; round += 1) {
      const path = at(`v1-round-${round}`)
      const results = await Promise.allSettled(
        Array.from({ length: writers }, () => driver.put(path, body('v1'), { allowOverwrite: false })),
      )
      const { wins, failures } = settle(results)
      tally.round(wins, failures)
    }
    tally.finish(
      'V1',
      'create-if-absent is atomic: of N simultaneous puts to one new pathname, exactly one succeeds',
    )
  }

  /* V2 -- ifMatch is a genuine compare-and-swap. */
  {
    const tally = concurrency('precondition', OPERATION.CONDITIONAL_WRITE)
    /*
     * What survived each round, read back rather than assumed.
     *
     * A winner count is a statement about *acknowledgements*, and the one
     * inference it cannot support is the one everybody wants from it: that
     * every writer who was refused wrote nothing. A write can land and its
     * answer be lost, and that writer is counted a loser.
     *
     * So each writer sends its own distinguishable body, and after the round
     * the object is read back and compared against what the acknowledged
     * winner said it wrote -- both the content and the exact revision the
     * winner's own success response returned. If a refused writer had
     * persisted, the surviving revision would be that writer's and not the
     * winner's, and this would say so.
     *
     * The limit, stated rather than left implicit: this shows that the
     * revision left in the store is the acknowledged winner's, which is what
     * "one write persisted" means for this object. It rests on V4 -- checked
     * separately, on this same store -- for the fact that a stale ETag is
     * actually refused. It is not an inference from the winner count, and it
     * is not the converse inference, "the version moved, so somebody else
     * won", which stays out of this file entirely.
     */
    const survivors = []
    for (let round = 0; round < rounds; round += 1) {
      const path = at(`v2-round-${round}`)
      const created = await driver.put(path, body('v2'), { allowOverwrite: false })
      const results = await Promise.allSettled(
        Array.from({ length: writers }, (_unused, index) =>
          driver.put(path, body(`v2-writer-${index}`), { ifMatch: created.etag }),
        ),
      )
      const { wins, failures } = settle(results)
      tally.round(wins, failures)

      const winner = results.findIndex((one) => one.status === 'fulfilled')
      const acknowledged = winner === -1 ? null : (results[winner].value?.etag ?? null)
      const after = await driver.get(path)
      survivors.push({
        round,
        winner,
        bodyIsTheWinners: winner !== -1 && after?.body?.includes(`v2-writer-${winner}`) === true,
        revisionIsTheWinners: acknowledged !== null && after?.etag === acknowledged,
      })
    }

    const kept = survivors.filter(
      (one) => one.bodyIsTheWinners && one.revisionIsTheWinners,
    ).length
    const everyRoundKeptTheWinner = kept === survivors.length

    tally.finish(
      'V2',
      'ifMatch is compare-and-swap: of N concurrent conditional writes with one ETag, exactly one succeeds',
      {
        holds: everyRoundKeptTheWinner,
        facts: { survivors, everyRoundKeptTheWinner },
        lines: [
          `what survived: in ${kept} of ${survivors.length} rounds the stored object is the` +
            ' acknowledged winner\'s own body AND its own returned revision',
          everyRoundKeptTheWinner
            ? '  => no refused writer persisted anything. Read back from the store, not'
            : '  => AT LEAST ONE ROUND kept a revision the acknowledged winner did not write:',
          everyRoundKeptTheWinner
            ? '     inferred from the winner count.'
            : '     a refused writer persisted, or the winner was overwritten.',
        ],
      },
    )
  }

  /* V3 -- an uncached read reflects a write that completed before it began. */
  {
    const path = at('v3')
    const first = await driver.put(path, body('v3-one'), { allowOverwrite: false })
    const readBack = await driver.get(path)
    const second = await driver.put(path, body('v3-two'), { ifMatch: first.etag })
    const readAgain = await driver.get(path)

    const pass =
      readBack?.body?.includes('v3-one') === true &&
      readAgain?.body?.includes('v3-two') === true &&
      readBack.etag !== readAgain.etag
    record(
      'V3',
      'get(useCache:false) returns the content of the write that completed before it',
      pass,
      pass ? 'both reads saw their own write, and the ETag moved' : 'a read did not reflect its write',
    )

    /* V4 -- the ETag a read gives is the one ifMatch compares against. */
    let currentWorks = false
    let staleRefused = false
    let staleKind = 'none'
    try {
      await driver.put(path, body('v4-current'), { ifMatch: readAgain.etag })
      currentWorks = true
    } catch {
      currentWorks = false
    }
    try {
      await driver.put(path, body('v4-stale'), { ifMatch: first.etag })
    } catch (error) {
      staleRefused = true
      staleKind = driver.classify(error, OPERATION.CONDITIONAL_WRITE)
    }
    record(
      'V4',
      'the ETag from get() and from put() is the value ifMatch compares against',
      currentWorks && staleRefused && staleKind === 'precondition',
      `current ETag accepted: ${currentWorks}; stale ETag refused as: ${staleKind}`,
    )
    void second
  }

  /* V5 -- the "already exists" refusal is recognisable. */
  {
    const path = at('v5')
    await driver.put(path, body('v5'), { allowOverwrite: false })
    let kind = 'none'
    let shape = 'none'
    try {
      await driver.put(path, body('v5-again'), { allowOverwrite: false })
    } catch (error) {
      kind = driver.classify(error, OPERATION.CREATE)
      shape = driver.describe(error)
    }
    record(
      'V5',
      'the allowOverwrite refusal is recognisable, and is not mistaken for a network failure',
      kind === 'exists',
      `classified as "${kind}"; pinned shape: ${shape}`,
    )
  }

  /* V6 -- a read of a pathname that was never written. */
  {
    const path = `${root}/v6-never-written.json`
    let result = 'threw'
    let detail = ''
    try {
      const answer = await driver.get(path)
      result = answer === null ? 'null' : 'a value'
    } catch (error) {
      detail = driver.describe(error)
    }
    record(
      'V6',
      'get() on a missing pathname resolves falsy rather than throwing',
      result === 'null',
      result === 'null' ? 'resolved null, as the store driver assumes' : `got "${result}" ${detail}`,
    )
  }

  /* V7 -- delete, then recreate at the same pathname. */
  {
    const path = at('v7')
    const created = await driver.put(path, body('v7-one'), { allowOverwrite: false })
    await driver.del(path, { ifMatch: created.etag })
    let recreated = false
    let detail = ''
    try {
      await driver.put(path, body('v7-two'), { allowOverwrite: false })
      recreated = true
    } catch (error) {
      detail = driver.describe(error)
    }
    const after = await driver.get(path)
    record(
      'V7',
      'a pathname freed by a delete can immediately be created again',
      recreated && after?.body?.includes('v7-two') === true,
      recreated ? 'recreated, and the new content reads back' : `refused: ${detail}`,
    )
  }

  /* V8 -- conditional deletion. */
  {
    const path = at('v8')
    const created = await driver.put(path, body('v8-one'), { allowOverwrite: false })
    const moved = await driver.put(path, body('v8-two'), { ifMatch: created.etag })

    let staleKind = 'none'
    try {
      await driver.del(path, { ifMatch: created.etag })
    } catch (error) {
      staleKind = driver.classify(error, OPERATION.CONDITIONAL_DELETE)
    }
    const survived = await driver.get(path)

    let currentWorked = false
    try {
      await driver.del(path, { ifMatch: moved.etag })
      currentWorked = true
    } catch {
      currentWorked = false
    }
    const gone = (await driver.get(path)) === null

    /*
     * A conditional delete of a pathname that is not there.
     *
     * The SDK does not document this, and it is **not** a curiosity: it is the
     * behaviour `lib/private-store.ts:deleteIfMatch` depends on, and through it
     * every caller of `removeIfMatch`. The contract that code requires is:
     *
     *     a conditional delete naming an object that does not exist must NOT
     *     report success. It must fail in a way this driver can recognise --
     *     `notfound` or `precondition` -- so that `removeIfMatch` can answer
     *     `false`, which every caller reads as an honest conflict.
     *
     * Why it matters: `removeDeclinedRequest` removes a request conditionally on
     * the revision it read, and turns `false` into "that changed while you were
     * working on it". If the service silently resolved for a missing object,
     * `removeIfMatch` would answer `true` and a stale second Remove -- landing
     * after the address was freed and a *new* request created at the same
     * pathname -- would report that it removed the record it had read, when it
     * had removed nothing, or, worse, something else.
     *
     * This was previously recorded in the detail string and left out of the pass
     * predicate, so V8 could print PASS while proving nothing about it. It is
     * part of the predicate now: an unsupported behaviour fails the probe closed
     * and names exactly what the service did.
     */
    const missingPath = `${root}/v8-never-written.json`
    let missingKind = 'resolved-successfully'
    let missingShape = 'no error was raised'
    let missingRaw = null
    try {
      await driver.del(missingPath, { ifMatch: moved.etag })
    } catch (error) {
      missingRaw = error
      missingKind = driver.classify(error, OPERATION.CONDITIONAL_DELETE)
      missingShape = driver.describe(error)
    }
    const missingHonest = missingKind === 'notfound' || missingKind === 'precondition'

    // And nothing may have been created by asking.
    const missingStillAbsent = (await driver.get(missingPath)) === null

    record(
      'V8',
      'del(ifMatch) removes only the revision it names, and refuses honestly on a missing object',
      staleKind === 'precondition' &&
        survived !== null &&
        currentWorked &&
        gone &&
        missingHonest &&
        missingStillAbsent,
      `stale delete refused as "${staleKind}"; current delete succeeded: ${currentWorked}; ` +
        `missing pathname: "${missingKind}" (${missingShape})` +
        (missingHonest
          ? ''
          : ' -- UNSUPPORTED: removeIfMatch() cannot report an honest conflict on a missing' +
            ' object against this provider, so conditional removal is not safe here'),
      {
        staleKind,
        currentWorked,
        missingKind,
        missingHonest,
        missingStillAbsent,
        // Kept in full for the same reason V2's set is: the shape is the
        // whole finding, and "other" was what hid it the first time.
        missingShape: missingRaw === null ? null : driver.shape(missingRaw),
      },
    )
  }

  /* V9 -- a conditional put naming the revision of an object that was deleted. */
  {
    /*
     * The mirror image of V8, and the case V8 does not reach.
     *
     * V8 asks whether a conditional **delete** refuses honestly. This asks
     * whether a conditional **write** does, against a pathname whose object has
     * been removed -- and it is the behaviour `NoteStore.updateNote` depends on
     * for the interleaving `docs/author-reader.md` names first:
     *
     *     a retracted note must not come back, still shared, because an edit
     *     already in flight rewrote the object after the delete.
     *
     * That edit sends `put(..., { ifMatch })` naming the revision it read
     * before the delete. The store must refuse it. If instead it accepted the
     * write -- or created the object afresh, the way an unconditional put
     * would -- a note somebody had retracted would be back at its own pathname,
     * with its own body, at its own visibility, and the reviewer who withdrew it
     * would have no idea.
     *
     * Two things are required, and both are in the pass predicate rather than
     * printed beside it: the write must be **refused** in a way this driver
     * recognises, and the object must **still be absent** afterwards. A refusal
     * that nonetheless left an object behind would be the same defect wearing
     * an error message.
     */
    const path = at('v9')
    const created = await driver.put(path, body('v9-one'), { allowOverwrite: false })
    await driver.del(path, { ifMatch: created.etag })
    const goneFirst = (await driver.get(path)) === null

    let staleKind = 'resolved-successfully'
    let staleShape = 'no error was raised'
    let staleRaw = null
    try {
      await driver.put(path, body('v9-two'), { ifMatch: created.etag })
    } catch (error) {
      staleRaw = error
      staleKind = driver.classify(error, OPERATION.CONDITIONAL_WRITE)
      staleShape = driver.describe(error)
    }
    const refusedHonestly = staleKind === 'precondition' || staleKind === 'notfound'

    // And nothing may have been created by asking.
    const stillAbsent = (await driver.get(path)) === null

    record(
      'V9',
      'put(ifMatch) against a deleted object is refused, and recreates nothing',
      goneFirst && refusedHonestly && stillAbsent,
      `after the delete the object was absent: ${goneFirst}; the stale conditional put was ` +
        `"${staleKind}" (${staleShape}); the object is still absent: ${stillAbsent}` +
        (refusedHonestly && stillAbsent
          ? ''
          : ' -- UNSUPPORTED: a retracted note could be resurrected by an edit already in' +
            ' flight against this provider'),
      {
        goneFirst,
        staleKind,
        refusedHonestly,
        stillAbsent,
        staleShape: staleRaw === null ? null : driver.shape(staleRaw),
      },
    )
  }

  } finally {
  /* ------------------------------------------------------------- clean-up */

  for (const path of written) {
    try {
      const current = await driver.get(path)
      if (!current) continue
      await driver.del(path, { ifMatch: current.etag })
      if (await driver.get(path)) leftover.push(path)
    } catch {
      leftover.push(path)
    }
  }
  }

  return {
    driver: driver.name,
    prefix: root,
    checks,
    /*
     * Residue is a failure, not a footnote.
     *
     * The sweep above already records what it could not remove and the CLI
     * already prints it as a WARNING, but `passed` used to ignore it. A run
     * that stranded probe objects in a store therefore still printed
     * "OK -- every assumption held" and still exited 0, so an unattended
     * gate reading that exit code was told the store was clean when it was
     * not.
     *
     * A green run is now both things at once: every V1-V9 check passed
     * **and** the sweep left nothing behind. No V1-V9 predicate is weakened
     * by this, nothing is retried, and no clean-up error is swallowed --
     * the only change is that `leftover` now counts. The CLI keeps its
     * direct `outcome.passed ? 0 : 1` mapping, so residue returns 1.
     */
    passed: checks.every((check) => check.pass) && leftover.length === 0,
    leftover,
  }
}

/* ------------------------------------------------------------------ the CLI */

const ISOLATION_PHRASE = 'yes-this-store-holds-no-production-data'

/** A whole number above zero, or null -- so a typo cannot silently shrink a run. */
function positiveInt(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

async function main(argv) {
  const live = argv.includes('--live')
  const fake = argv.includes('--fake')

  if (live === fake) {
    console.error('Usage: node scripts/blob-probe.mjs --fake | --live')
    return 2
  }

  let driver
  if (fake) {
    driver = fakeDriver()
  } else {
    const token = (process.env.BLOB_PROBE_TOKEN ?? '').trim()
    const isolated = (process.env.BLOB_PROBE_ISOLATED ?? '').trim()

    if (!token) {
      console.error(
        'Refusing to run: set BLOB_PROBE_TOKEN to a read-write token for an isolated store.\n' +
          'It is deliberately NOT BLOB_READ_WRITE_TOKEN — sharing that variable with the\n' +
          'application is how a probe ends up writing into production.',
      )
      return 2
    }
    if (isolated !== ISOLATION_PHRASE) {
      console.error(
        `Refusing to run: set BLOB_PROBE_ISOLATED=${ISOLATION_PHRASE}\n` +
          'only once you have confirmed in the Vercel dashboard that the store this token\n' +
          'belongs to holds no production data.',
      )
      return 2
    }
    driver = await liveDriver(token)
  }

  /*
   * The load, which defaults to the sizes the architecture numbers V1 and V2
   * at and which an operator has to go out of their way to lower.
   *
   * Lowering it is sometimes the only way to learn anything -- a store that is
   * throttling twenty simultaneous writers tells you about its rate limiter
   * and nothing about its compare-and-swap. But a smaller run is a different
   * experiment, not a cheaper version of the same one, so the output says so
   * in as many words and the exit code is unchanged: a two-writer green run
   * does not stand in for the gate.
   */
  const rounds = positiveInt(process.env.BLOB_PROBE_ROUNDS) ?? ROUNDS
  const writers = positiveInt(process.env.BLOB_PROBE_WRITERS) ?? WRITERS
  const originalSize = rounds === ROUNDS && writers === WRITERS

  /*
   * Everything the console gets goes through the exact-value scrubber on its
   * way out.
   *
   * The detail strings already arrive redacted -- `describe()` and `shape()`
   * both run `redact()` -- so this is the belt to that braces: one last check,
   * at the last place text can still become visible, against the literal value
   * this process was handed. `redact()` itself is the wrong tool at this
   * boundary because it collapses newlines and cuts at 200 characters, which
   * would fold every multi-line check detail into one truncated line;
   * `scrubSecrets()` changes nothing but the secret.
   */
  const say = (line) => console.log(scrubSecrets(line))

  // Defined above the run so `runProbe` can disclose the prefix through it
  // before the first write, rather than only in the summary below.
  const outcome = await runProbe(driver, { rounds, writers, emit: say })

  say(`store driver: ${outcome.driver}`)
  say(`load:         ${rounds} rounds x ${writers} writers` +
    (originalSize
      ? '  (the original size: this is the gate)'
      : `  (REDUCED from ${ROUNDS} x ${WRITERS} -- a DIAGNOSTIC run, not the gate;` +
        ' it cannot stand in for an original-size pass)'))
  say(`prefix:       ${outcome.prefix}\n`)
  for (const check of outcome.checks) {
    say(`${check.pass ? 'PASS' : 'FAIL'}  ${check.id}  ${check.title}`)
    // The concurrency checks report several lines now -- winner counts, the
    // classification tally, and every distinct refusal shape -- so each one
    // gets its own indented line rather than being run together.
    for (const line of String(check.detail).split('\n')) say(`      ${line}`)
  }
  say('')
  if (outcome.leftover.length > 0) {
    say(`WARNING: ${outcome.leftover.length} probe object(s) could not be removed:`)
    for (const path of outcome.leftover) say(`  ${path}`)
  } else {
    say('every probe object was removed')
  }
  say(outcome.passed ? '\nOK -- every assumption held' : '\nFAILED -- see above')

  return outcome.passed ? 0 : 1
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      // Never the token, and never a response body: a class name and nothing
      // else. Scrubbed anyway -- this is the one output path that runs when
      // something unanticipated happened, which is the worst moment to be
      // relying on an assumption about what a string can contain.
      console.error(scrubSecrets(`probe failed: ${error?.constructor?.name ?? 'Error'}`))
      process.exitCode = 1
    },
  )
}
