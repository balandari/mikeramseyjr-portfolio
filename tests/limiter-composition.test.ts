import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { FileSystemPrivateStore, type PrivateStore } from '../lib/private-store.ts'
import {
  RULES,
  allowCredentialAttempt,
  limiterReady,
  limiterStatus,
  recordAndCheck,
} from '../lib/rate-limit.ts'

/*
 * How the brake is actually composed in production, and what can no longer
 * switch it off.
 *
 * The settled model:
 *
 *   application limiter   PRIMARY, after the live Blob proof, declared with
 *                         RATE_LIMIT_TRUST_STORE=1
 *   Vercel WAF            a coarse IP/JA4 backstop in front of it. It needs no
 *                         application flag, and there is no longer one to set.
 *
 * What this replaces: `RATE_LIMIT_UPSTREAM` was checked *first* in
 * `limiterStatus()` and, when set, stopped all application counting. Two of the
 * rules are keyed on the **email address** -- three requests a day, five sign-in
 * links an hour to one mailbox -- and no rule keyed on a client address can
 * express either. So declaring the backstop silently deleted the stronger
 * control, and the release recipe told an operator to declare it. The variable
 * is gone; these tests are what keeps it gone.
 */

const SECRET = 'test-secret-for-limiter-composition-only'
const CLIENT = new Headers({ 'x-forwarded-for': '198.51.100.4' })

const ROUTES = [
  'lib/rate-limit.ts',
  'app/review/api/request/route.ts',
  'app/review/api/signin/route.ts',
  'app/review/api/credential/route.ts',
  'app/review/api/unlock/route.ts',
] as const

function freshStore(): { store: FileSystemPrivateStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'mrj-compose-'))
  return { store: new FileSystemPrivateStore(root), root }
}

async function withEnv<T>(
  values: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await run()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function withSecret<T>(run: () => Promise<T>): Promise<T> {
  return withEnv({ REVIEWER_AUTH_SECRET: SECRET }, run)
}

/** A store that behaves, but whose atomicity has not been demonstrated. */
const unprovenStore: PrivateStore = {
  driver: 'pretend-blob',
  writable: true,
  provenAtomic: false,
  async read() {
    return null
  },
  async readVersioned() {
    return { body: null, version: null }
  },
  async create() {
    return { created: true, version: 'v' }
  },
  async writeIfMatch() {
    return true
  },
  async removeIfMatch() {
    return true
  },
  async list() {
    return []
  },
}

const unwritableStore: PrivateStore = { ...unprovenStore, driver: 'unconfigured', writable: false }

/* --------------------------- the upstream bypass, gone rather than narrowed */

test('nothing in the application reads a variable announcing an upstream limiter', () => {
  // The strongest available form of "a Firewall declaration cannot disable the
  // local limits": there is no declaration to make.
  for (const relative of ROUTES) {
    const source = readFileSync(join(process.cwd(), relative), 'utf8')
    assert.ok(
      !/process\.env\.RATE_LIMIT_UPSTREAM/.test(source),
      `${relative} must not read RATE_LIMIT_UPSTREAM`,
    )
  }
})

test('setting the old upstream variable changes nothing at all', async () => {
  for (const declared of ['vercel-firewall', '1', 'true', 'anything']) {
    await withEnv({ RATE_LIMIT_UPSTREAM: declared, RATE_LIMIT_TRUST_STORE: undefined }, async () => {
      assert.equal(
        limiterStatus(unprovenStore),
        'unproven',
        `an unproven store stays unproven with RATE_LIMIT_UPSTREAM=${declared}`,
      )
      assert.equal(limiterReady(unprovenStore), false, 'so the mail endpoints stay shut')
      assert.equal(limiterStatus(unwritableStore), 'unavailable')
    })
  }
})

test('the configured production mode still counts, per client and per address', async () => {
  const { store, root } = freshStore()
  try {
    /*
     * Exactly the production configuration -- the trusted-store flag set after
     * the live proof -- and the Firewall declared the old way alongside it, to
     * show it no longer has any effect. Every rule must still bite.
     */
    await withEnv(
      {
        REVIEWER_AUTH_SECRET: SECRET,
        RATE_LIMIT_TRUST_STORE: '1',
        RATE_LIMIT_UPSTREAM: 'vercel-firewall',
      },
      async () => {
        assert.equal(limiterReady(store), true, 'the application is the primary limiter')
        assert.equal(limiterReady(unprovenStore), true, 'even on a store trusted by that flag')

        const admitted = async (rule: (typeof RULES)[keyof typeof RULES], key: string) => {
          const outcomes = []
          for (let i = 0; i < rule.limit + 2; i += 1) {
            outcomes.push(await recordAndCheck(rule, key, store))
          }
          return outcomes.filter((outcome) => outcome.allowed).length
        }

        assert.equal(
          await admitted(RULES.requestByClient, '203.0.113.5'),
          RULES.requestByClient.limit,
          'the per-client request rule is enforced',
        )
        assert.equal(
          await admitted(RULES.requestByAddress, 'anna@example.com'),
          RULES.requestByAddress.limit,
          'and so is the per-address rule, which a WAF rule cannot express',
        )
        assert.equal(
          await admitted(RULES.signinByAddress, 'anna@example.com'),
          RULES.signinByAddress.limit,
          'five sign-in links an hour to one mailbox, still',
        )
        assert.equal(
          await admitted(RULES.signinByClient, '203.0.113.6'),
          RULES.signinByClient.limit,
          'and the per-client sign-in rule',
        )
      },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* -------------------------- the credential-spending endpoints' shared policy */

/** A store that counts what it was asked to do. */
function counting(inner: PrivateStore): { store: PrivateStore; seen: () => { reads: number; writes: number } } {
  let reads = 0
  let writes = 0
  return {
    seen: () => ({ reads, writes }),
    store: {
      driver: inner.driver,
      writable: inner.writable,
      provenAtomic: inner.provenAtomic,
      read: (path) => {
        reads += 1
        return inner.read(path)
      },
      readVersioned: (path) => {
        reads += 1
        return inner.readVersioned(path)
      },
      create: (path, body) => {
        writes += 1
        return inner.create(path, body)
      },
      writeIfMatch: (path, body, version) => {
        writes += 1
        return inner.writeIfMatch(path, body, version)
      },
      removeIfMatch: (path, version) => {
        writes += 1
        return inner.removeIfMatch(path, version)
      },
      list: (prefix) => inner.list(prefix),
    },
  }
}

test('a credential attempt is admitted up to the limit and refused beyond it', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      const outcomes = []
      for (let i = 0; i < RULES.credentialByClient.limit + 3; i += 1) {
        outcomes.push(await allowCredentialAttempt(CLIENT, store))
      }
      assert.equal(
        outcomes.filter(Boolean).length,
        RULES.credentialByClient.limit,
        'one bucket bounds guessing across both credential-spending endpoints',
      )
      assert.equal(outcomes.at(-1), false)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('at or beyond the limit it costs one read, no writes, and no roster read', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      // Fill the window first, un-counted.
      for (let i = 0; i < RULES.credentialByClient.limit; i += 1) {
        await allowCredentialAttempt(CLIENT, store)
      }

      const watched = counting(store)
      const allowed = await allowCredentialAttempt(CLIENT, watched.store)

      assert.equal(allowed, false, 'refused')
      const { reads, writes } = watched.seen()
      assert.equal(writes, 0, 'and wrote nothing')
      assert.ok(reads <= 1, `and read at most once: ${reads}`)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an unavailable limiter admits rather than locking out a real code holder', async () => {
  await withEnv({ REVIEWER_AUTH_SECRET: SECRET, RATE_LIMIT_TRUST_STORE: undefined }, async () => {
    /*
     * No store, an unwritable one, and an unproven one: all three admit. Neither
     * of these endpoints sends mail, and both receive something guessing does
     * not threaten -- so refusing would only ever lock out the person the system
     * exists for.
     */
    assert.equal(await allowCredentialAttempt(CLIENT, null), true)
    assert.equal(await allowCredentialAttempt(CLIENT, unwritableStore), true)
    assert.equal(await allowCredentialAttempt(CLIENT, unprovenStore), true)
  })
})

test('a limiter that throws admits rather than refusing', async () => {
  const angry: PrivateStore = {
    ...unprovenStore,
    driver: 'fs',
    provenAtomic: true,
    async read(): Promise<never> {
      throw new Error('the store is having a bad minute')
    },
    async create(): Promise<never> {
      throw new Error('the store is having a bad minute')
    },
  }
  await withSecret(async () => {
    assert.equal(await allowCredentialAttempt(CLIENT, angry), true)
  })
})

test('the two mail-sending endpoints still fail closed on the same store', async () => {
  // The other half of the policy, and the reason it is two policies and not one.
  await withEnv({ RATE_LIMIT_TRUST_STORE: undefined }, async () => {
    assert.equal(limiterReady(unprovenStore), false)
    for (const relative of ['app/review/api/request/route.ts', 'app/review/api/signin/route.ts']) {
      const source = readFileSync(join(process.cwd(), relative), 'utf8')
      assert.match(source, /!limiterReady\(store\)/, `${relative} refuses without a working brake`)
      assert.ok(
        !/allowCredentialAttempt/.test(source),
        `${relative} must not adopt the fail-open policy`,
      )
    }
  })
})

test('both credential-spending routes go through the one policy, before any roster read', () => {
  const credential = readFileSync(
    join(process.cwd(), 'app', 'review', 'api', 'credential', 'route.ts'),
    'utf8',
  )
  const unlock = readFileSync(
    join(process.cwd(), 'app', 'review', 'api', 'unlock', 'route.ts'),
    'utf8',
  )

  assert.match(credential, /allowCredentialAttempt\(request\.headers/)
  assert.match(unlock, /allowCredentialAttempt\(request\.headers/)

  /*
   * The ordering the acceptance condition is about: the limiter runs before
   * `isReviewerAccessLive()` and before `identifyReviewerFromStore()`, which are
   * the two roster-backed reads an invalid submission used to buy for free.
   */
  const gate = unlock.indexOf('await allowCredentialAttempt(request.headers')
  const live = unlock.indexOf('await isReviewerAccessLive()')
  const identify = unlock.indexOf('await identifyReviewerFromStore(')
  assert.ok(gate > 0, 'the unlock route has an availability check')
  assert.ok(live > gate, 'which precedes the roster liveness read')
  assert.ok(identify > gate, 'and precedes the roster lookup')
})
