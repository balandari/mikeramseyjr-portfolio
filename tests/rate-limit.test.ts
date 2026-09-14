import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { FileSystemPrivateStore, type PrivateStore } from '../lib/private-store.ts'
import { clientKey, limiterStatus, recordAndCheck, type RateLimitRule } from '../lib/rate-limit.ts'

/*
 * The brake on the two endpoints a stranger can reach.
 *
 * The property that matters is not "it counts" -- it is that **concurrent
 * callers cannot walk through it**. A limiter built on read-add-write does
 * exactly that, silently, and looks correct in every sequential test. So the
 * test that earns its place here is the parallel one.
 *
 * The second property is that it holds no personal data: an address is a keyed
 * label in a pathname and nothing more.
 */

const SECRET = 'test-secret-for-rate-limit-only'

const RULE: RateLimitRule = { scope: 'test-scope', limit: 3, windowMs: 60_000 }

function freshStore(): { store: FileSystemPrivateStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'mrj-limit-'))
  return { store: new FileSystemPrivateStore(root), root }
}

function withSecret<T>(run: () => Promise<T>): Promise<T> {
  const saved = process.env.REVIEWER_AUTH_SECRET
  process.env.REVIEWER_AUTH_SECRET = SECRET
  return run().finally(() => {
    if (saved === undefined) delete process.env.REVIEWER_AUTH_SECRET
    else process.env.REVIEWER_AUTH_SECRET = saved
  })
}

function everything(root: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else out.push({ path: full, text: readFileSync(full, 'utf8') })
    }
  }
  walk(root)
  return out
}

test('a key is allowed up to its limit and refused after it', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      const outcomes = []
      for (let i = 0; i < 5; i += 1) {
        outcomes.push(await recordAndCheck(RULE, 'someone@example.com', store))
      }
      assert.deepEqual(
        outcomes.map((outcome) => outcome.allowed),
        [true, true, true, false, false],
      )
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('twenty simultaneous hits let exactly the limit through', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      const outcomes = await Promise.all(
        Array.from({ length: 20 }, () => recordAndCheck(RULE, 'flood@example.com', store)),
      )
      const allowed = outcomes.filter((outcome) => outcome.allowed).length
      assert.equal(
        allowed,
        RULE.limit,
        'nothing is incremented, so nothing can be lost to a race',
      )
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('two different keys do not share a budget', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      for (let i = 0; i < 3; i += 1) await recordAndCheck(RULE, 'one@example.com', store)
      const other = await recordAndCheck(RULE, 'two@example.com', store)
      assert.equal(other.allowed, true)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a new window starts a fresh budget', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      const now = Date.now()
      for (let i = 0; i < 4; i += 1) await recordAndCheck(RULE, 'later@example.com', store, now)

      const next = await recordAndCheck(RULE, 'later@example.com', store, now + RULE.windowMs)
      assert.equal(next.allowed, true)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('neither the address nor the client is ever stored', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      await recordAndCheck(RULE, 'private.person@example.com', store)
      await recordAndCheck(RULE, '203.0.113.42', store)

      for (const file of everything(root)) {
        assert.ok(
          !file.text.includes('private.person@example.com'),
          `no address in ${file.path}`,
        )
        assert.ok(!file.text.includes('203.0.113.42'), `no client address in ${file.path}`)
        assert.ok(!file.path.includes('private.person'), 'and none in a pathname')
        assert.ok(!file.path.includes('203.0.113.42'), 'and none in a pathname')
      }
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a key far past its limit stops being written down at all', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      for (let i = 0; i < 40; i += 1) await recordAndCheck(RULE, 'attacker@example.com', store)

      /*
       * A window holds `limit` numbered slots and nothing else, so the bound is
       * the limit itself rather than a multiple of it that had to be tuned:
       * forty hits against a limit of three write exactly three objects.
       */
      const written = everything(root).length
      assert.equal(written, RULE.limit, `bounded storage: ${written} objects`)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------ the ordering defect, regressed */

/*
 * What this replaces. The limiter used to create one uniquely-named object per
 * hit and then admit a caller if its own name sorted within the first `limit`
 * of a listing. The name was `<millisecond>-<random>`, so two hits in the same
 * millisecond were ordered by the random half -- and a later hit whose suffix
 * sorted earlier took a rank that had already been handed out.
 *
 * It did not even need concurrency: two *sequential* calls at one timestamp,
 * against a limit of one, both came back allowed. That was reproduced against
 * the module before it was replaced, and this is the test that keeps it gone.
 */

test('two hits in the same millisecond cannot both take the same rank', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      const one: RateLimitRule = { scope: 'same-ms', limit: 1, windowMs: 60_000 }
      const now = 1_700_000_000_000

      const results = []
      for (let i = 0; i < 8; i += 1) {
        results.push(await recordAndCheck(one, 'twice@example.com', store, now))
      }

      assert.equal(
        results.filter((outcome) => outcome.allowed).length,
        1,
        'a limit of one admits one, whatever the clock and the random suffix do',
      )
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a caller that decides before its neighbour has written is still bounded', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      /*
       * The interleaving the old algorithm could not survive: one caller runs
       * to completion -- write, list, decide -- before the next one starts, so
       * it can never see the others. Slot claiming does not care, because the
       * decision is the claim rather than a view of the window.
       */
      const one: RateLimitRule = { scope: 'sequential', limit: 2, windowMs: 60_000 }
      const now = 1_700_000_000_000

      const outcomes = []
      for (let i = 0; i < 6; i += 1) {
        outcomes.push(await recordAndCheck(one, 'queue@example.com', store, now))
      }

      assert.deepEqual(
        outcomes.map((outcome) => outcome.allowed),
        [true, true, false, false, false, false],
      )
      assert.deepEqual(
        outcomes.map((outcome) => outcome.used),
        [1, 2, 2, 2, 2, 2],
        'and each admitted caller holds a slot no other caller holds',
      )
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the limiter needs no listing at all', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      /*
       * Stated as a test because it is the whole argument for the Blob store
       * being usable at all: the algorithm's only requirement is that
       * `create()` is atomic create-if-absent. It never lists, so immediate
       * list visibility and a globally consistent order -- neither of which can
       * be demonstrated from here -- are simply not properties it needs.
       */
      let listed = 0
      const watched: PrivateStore = {
        driver: 'fs',
        writable: true,
        provenAtomic: true,
        read: (path) => store.read(path),
        readVersioned: (path) => store.readVersioned(path),
        create: (path, body) => store.create(path, body),
        writeIfMatch: (path, body, version) => store.writeIfMatch(path, body, version),
        removeIfMatch: (path, version) => store.removeIfMatch(path, version),
        list: (prefix) => {
          listed += 1
          return store.list(prefix)
        },
      }

      for (let i = 0; i < 10; i += 1) await recordAndCheck(RULE, 'nolist@example.com', watched)
      assert.equal(listed, 0, 'not once')
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------ readiness */

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

test('a store whose atomicity is unproven is not treated as a working limiter', () => {
  const saved = process.env.RATE_LIMIT_TRUST_STORE
  delete process.env.RATE_LIMIT_TRUST_STORE
  try {
    const { store, root } = freshStore()
    try {
      assert.equal(limiterStatus(store), 'ready', 'the filesystem driver is proven')
      assert.equal(limiterStatus(unprovenStore), 'unproven')
      assert.equal(limiterStatus(unwritableStore), 'unavailable')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  } finally {
    if (saved !== undefined) process.env.RATE_LIMIT_TRUST_STORE = saved
  }
})

test('trusting an unproven store takes one deliberate environment variable', () => {
  const saved = process.env.RATE_LIMIT_TRUST_STORE
  process.env.RATE_LIMIT_TRUST_STORE = '1'
  try {
    assert.equal(limiterStatus(unprovenStore), 'ready')
  } finally {
    if (saved === undefined) delete process.env.RATE_LIMIT_TRUST_STORE
    else process.env.RATE_LIMIT_TRUST_STORE = saved
  }
})

test('the client key comes from the proxy header, and falls back honestly', () => {
  assert.equal(
    clientKey(new Headers({ 'x-forwarded-for': '203.0.113.7, 70.41.3.18' })),
    '203.0.113.7',
  )
  assert.equal(clientKey(new Headers({ 'x-real-ip': '198.51.100.9' })), '198.51.100.9')
  assert.equal(clientKey(new Headers()), 'unknown-client')
})

