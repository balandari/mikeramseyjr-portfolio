#!/usr/bin/env node
/**
 * The live-store probe: eight assumptions about Vercel Blob, checked against a
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
 * Exit code 0 when every check passed, 1 otherwise. `tests/blob-probe.test.ts`
 * runs the fake path, so the script cannot rot unnoticed.
 */

import { randomBytes } from 'node:crypto'

/** How many simultaneous writers each concurrency check uses. */
const WRITERS = 20
/** How many times the concurrency checks repeat, to catch a rare double win. */
const ROUNDS = 10

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
    classify(error) {
      if (error?.name === 'BlobPreconditionFailedError') return 'precondition'
      if (error?.name === 'BlobNotFoundError') return 'notfound'
      const message = error instanceof Error ? error.message.toLowerCase() : ''
      if (message.includes('already exists') || message.includes('allowoverwrite')) return 'exists'
      return 'other'
    },
    describe(error) {
      return `${error?.name ?? 'Error'}: ${String(error?.message ?? '').slice(0, 120)}`
    },
  }
}

/**
 * The real store, reached exactly the way `lib/private-store.ts` reaches it:
 * private access, no random suffix, JSON content type, and every read with
 * `useCache: false`.
 */
export async function liveDriver(token) {
  const blob = await import('@vercel/blob')
  const { put, get, del, BlobPreconditionFailedError, BlobNotFoundError } = blob

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
    classify(error) {
      if (error instanceof BlobPreconditionFailedError) return 'precondition'
      if (error instanceof BlobNotFoundError) return 'notfound'
      const message = error instanceof Error ? error.message.toLowerCase() : ''
      if (message.includes('already exists') || message.includes('allowoverwrite')) return 'exists'
      return 'other'
    },
    describe(error) {
      // Never the token, and never a body: a class name and a short message.
      return `${error?.constructor?.name ?? 'Error'}: ${String(error?.message ?? '').slice(0, 120)}`
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
 * V1 to V8, in the order the architecture numbers them. Each returns a plain
 * record so the caller can print, save or assert over them.
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

  const record = (id, title, pass, detail) => {
    checks.push({ id, title, pass, detail })
  }

  /* V1 -- create-if-absent is atomic under concurrent writers. */
  {
    let everyRoundHadOneWinner = true
    let observed = []
    for (let round = 0; round < rounds; round += 1) {
      const path = at(`v1-round-${round}`)
      const results = await Promise.allSettled(
        Array.from({ length: writers }, () => driver.put(path, body('v1'), { allowOverwrite: false })),
      )
      const { wins, failures } = settle(results)
      observed.push(wins)
      if (wins !== 1) everyRoundHadOneWinner = false
      const wrong = failures.map((error) => driver.classify(error)).filter((kind) => kind !== 'exists')
      if (wrong.length > 0) {
        everyRoundHadOneWinner = false
        observed.push(`unexpected refusal kinds: ${wrong.join(', ')}`)
      }
    }
    record(
      'V1',
      'create-if-absent is atomic: of N simultaneous puts to one new pathname, exactly one succeeds',
      everyRoundHadOneWinner,
      `${rounds} rounds of ${writers} writers; winners per round: ${observed.join(', ')}`,
    )
  }

  /* V2 -- ifMatch is a genuine compare-and-swap. */
  {
    let everyRoundHadOneWinner = true
    const observed = []
    for (let round = 0; round < rounds; round += 1) {
      const path = at(`v2-round-${round}`)
      const created = await driver.put(path, body('v2'), { allowOverwrite: false })
      const results = await Promise.allSettled(
        Array.from({ length: writers }, (_unused, index) =>
          driver.put(path, body(`v2-writer-${index}`), { ifMatch: created.etag }),
        ),
      )
      const { wins, failures } = settle(results)
      observed.push(wins)
      if (wins !== 1) everyRoundHadOneWinner = false
      const wrong = failures
        .map((error) => driver.classify(error))
        .filter((kind) => kind !== 'precondition')
      if (wrong.length > 0) {
        everyRoundHadOneWinner = false
        observed.push(`unexpected refusal kinds: ${wrong.join(', ')}`)
      }
    }
    record(
      'V2',
      'ifMatch is compare-and-swap: of N concurrent conditional writes with one ETag, exactly one succeeds',
      everyRoundHadOneWinner,
      `${rounds} rounds of ${writers} writers; winners per round: ${observed.join(', ')}`,
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
      staleKind = driver.classify(error)
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
      kind = driver.classify(error)
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
      staleKind = driver.classify(error)
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
    try {
      await driver.del(missingPath, { ifMatch: moved.etag })
    } catch (error) {
      missingKind = driver.classify(error)
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
    )
  }

  /* ------------------------------------------------------------- clean-up */

  const leftover = []
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

  return {
    driver: driver.name,
    prefix: root,
    checks,
    passed: checks.every((check) => check.pass),
    leftover,
  }
}

/* ------------------------------------------------------------------ the CLI */

const ISOLATION_PHRASE = 'yes-this-store-holds-no-production-data'

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

  const outcome = await runProbe(driver)

  console.log(`store driver: ${outcome.driver}`)
  console.log(`prefix:       ${outcome.prefix}\n`)
  for (const check of outcome.checks) {
    console.log(`${check.pass ? 'PASS' : 'FAIL'}  ${check.id}  ${check.title}`)
    console.log(`      ${check.detail}`)
  }
  console.log('')
  if (outcome.leftover.length > 0) {
    console.log(`WARNING: ${outcome.leftover.length} probe object(s) could not be removed:`)
    for (const path of outcome.leftover) console.log(`  ${path}`)
  } else {
    console.log('every probe object was removed')
  }
  console.log(outcome.passed ? '\nOK -- every assumption held' : '\nFAILED -- see above')

  return outcome.passed ? 0 : 1
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      // Never the token, and never a response body.
      console.error(`probe failed: ${error?.constructor?.name ?? 'Error'}`)
      process.exitCode = 1
    },
  )
}
