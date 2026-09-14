import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { FileSystemPrivateStore } from '../lib/private-store.ts'
import {
  ACTIVATION_TTL_MS,
  AUTH_ROOT,
  asEpoch,
  credentialEmailLabel,
  fingerprint,
  isOutstanding,
  isSpent,
  issueCredential,
  lookupCredential,
  readCredential,
  spendCredential,
} from '../lib/auth-credentials.ts'

/*
 * One-use credentials, in the pointerless layout.
 *
 * Four properties are load-bearing, and every one of them is the kind that
 * looks fine until two things happen at once:
 *
 *   1. The plaintext is never stored. Not in the record, not in a pathname,
 *      not anywhere under the store's root.
 *   2. A credential can be spent exactly once, even by twelve callers racing.
 *   3. **Several credentials for one person and purpose coexist.** That is the
 *      change: there is no pointer, nothing is retired, and an earlier email
 *      keeps working until it is used or expires.
 *   4. What kills a credential early is the reviewer's `credentialEpoch`, an
 *      integer copied at issue and compared for equality at use -- never a
 *      clock, and never "greater than".
 *
 * The filesystem driver is what these run against, and its create-if-absent is
 * `O_CREAT|O_EXCL` -- a real kernel-level atomic create, not a read followed by
 * a write. That is what makes the concurrency test below meaningful rather than
 * decorative.
 */

const SECRET = 'test-secret-for-credentials-only-not-a-real-one'
const ADDRESS = 'anna@example.com'

function freshStore(): { store: FileSystemPrivateStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'mrj-cred-'))
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

/** The shape every call in here shares: one reviewer, one address, one epoch. */
function mint(reviewerId = 'anna', epoch = 0, ttlMs?: number) {
  return {
    reviewerId,
    emailLabel: credentialEmailLabel(ADDRESS),
    credentialEpoch: epoch,
    ...(ttlMs === undefined ? {} : { ttlMs }),
  }
}

/** Every byte under a directory, as text, for "is this string anywhere?" checks. */
function everyFile(root: string): { path: string; text: string }[] {
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

test('a credential is 256 bits, and two of them are never the same', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      const first = await issueCredential('activation', mint('anna'), store)
      const second = await issueCredential('activation', mint('ben'), store)

      assert.ok(first && second)
      // 32 bytes, base64url, unpadded.
      assert.match(first.token, /^[A-Za-z0-9_-]{43}$/)
      assert.match(second.token, /^[A-Za-z0-9_-]{43}$/)
      assert.notEqual(first.token, second.token)
      assert.notEqual(first.tokenHash, second.tokenHash)
      assert.notEqual(first.operationId, second.operationId)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the plaintext credential is never written anywhere in the store', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      const issued = await issueCredential('activation', mint(), store)
      assert.ok(issued)
      await spendCredential('activation', issued.tokenHash, store)

      for (const file of everyFile(root)) {
        assert.ok(!file.text.includes(issued.token), `credential found in ${file.path}`)
        assert.ok(!file.path.includes(issued.token), 'and none in a pathname')
      }
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the address is never written either — only a keyed label of it', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      const issued = await issueCredential('activation', mint(), store)
      assert.ok(issued)

      const record = await readCredential('activation', issued.tokenHash, store)
      assert.ok(record)
      assert.equal(record.emailLabel, credentialEmailLabel(ADDRESS))
      assert.match(record.emailLabel, /^[a-f0-9]{32}$/)

      for (const file of everyFile(root)) {
        assert.ok(!file.text.includes(ADDRESS), `an address appeared in ${file.path}`)
        assert.ok(!file.path.includes('anna@'), 'and none in a pathname')
      }

      // A different address labels differently, so a change is detectable.
      assert.notEqual(credentialEmailLabel('anna.new@example.com'), record.emailLabel)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a credential can be spent exactly once', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      const issued = await issueCredential('activation', mint(), store)
      assert.ok(issued)

      assert.equal(await isSpent('activation', issued.tokenHash, store), false)
      assert.equal(await spendCredential('activation', issued.tokenHash, store), true)
      assert.equal(await isSpent('activation', issued.tokenHash, store), true)
      assert.equal(await spendCredential('activation', issued.tokenHash, store), false)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('twelve callers racing for one credential produce exactly one success', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      const issued = await issueCredential('activation', mint(), store)
      assert.ok(issued)

      const results = await Promise.all(
        Array.from({ length: 12 }, () => spendCredential('activation', issued.tokenHash, store)),
      )
      assert.equal(results.filter(Boolean).length, 1, 'exactly one')
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('several credentials for one person and purpose coexist, each usable once', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      const issued = await Promise.all([
        issueCredential('activation', mint(), store),
        issueCredential('activation', mint(), store),
        issueCredential('activation', mint(), store),
      ])
      assert.ok(issued.every(Boolean))

      const hashes = issued.map((one) => (one as { tokenHash: string }).tokenHash)
      assert.equal(new Set(hashes).size, 3, 'three distinct credentials')

      // All three are outstanding. Nothing was retired and nothing superseded.
      for (const hash of hashes) {
        assert.equal(await isOutstanding('activation', hash, 0, store), true)
      }

      // And each can be spent, once, in any order.
      for (const hash of hashes) {
        assert.equal(await spendCredential('activation', hash, store), true)
        assert.equal(await spendCredential('activation', hash, store), false)
        assert.equal(await isOutstanding('activation', hash, 0, store), false)
      }
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('issuing writes one object and reads nothing — there is no pointer to contend on', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      const issued = await issueCredential('activation', mint(), store)
      assert.ok(issued)

      const files = everyFile(root).map((file) => file.path)
      assert.equal(files.length, 1, 'one object for one credential')
      assert.ok(files[0].includes(join('cred', 'activation')))

      // No `current/` and no `gen/` anywhere: the layout has two kinds only.
      assert.equal(
        everyFile(root).filter((f) => f.path.includes(`${'current'}`) || f.path.includes('gen'))
          .length,
        0,
      )
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an expired credential is refused, and says so to the server', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      const now = Date.now()
      const issued = await issueCredential('activation', mint('anna', 0, 1000), store, now)
      assert.ok(issued)

      const late = await lookupCredential('activation', issued.token, store, now + 2000)
      assert.equal(late.ok, false)
      assert.equal(late.ok === false && late.reason, 'expired')

      // And it is decided from the record alone, with nothing else consulted.
      assert.equal(await isOutstanding('activation', issued.tokenHash, 0, store, now + 2000), false)
      assert.equal(await isSpent('activation', issued.tokenHash, store), false, 'and not spent')
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an activation credential is not a sign-in credential', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      const issued = await issueCredential('activation', mint(), store)
      assert.ok(issued)

      const wrong = await lookupCredential('signin', issued.token, store)
      assert.equal(wrong.ok, false)
      // The same bytes hash to a different pathname under the other label, so
      // the wrong purpose does not find a record at all.
      assert.equal(wrong.ok === false && wrong.reason, 'unknown')

      const right = await lookupCredential('activation', issued.token, store)
      assert.equal(right.ok, true)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the epoch is copied at issue and compared for equality, never ordered', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      const issued = await issueCredential('activation', mint('anna', 3), store)
      assert.ok(issued)

      const record = await readCredential('activation', issued.tokenHash, store)
      assert.equal(record?.credentialEpoch, 3)

      assert.equal(await isOutstanding('activation', issued.tokenHash, 3, store), true)
      // An advance kills it.
      assert.equal(await isOutstanding('activation', issued.tokenHash, 4, store), false)
      // And so does a value below it: equality, not "greater than".
      assert.equal(await isOutstanding('activation', issued.tokenHash, 2, store), false)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a legacy credential record with no epoch parses as zero', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      const hash = fingerprint('activation', 'T'.repeat(43))
      assert.ok(hash)

      // Written by hand in the shape an earlier version would have left.
      await store.create(
        `${AUTH_ROOT}/cred/activation/${hash}.json`,
        `${JSON.stringify({
          schema: 1,
          purpose: 'activation',
          reviewerId: 'anna',
          requestId: null,
          operationId: 'a'.repeat(24),
          emailLabel: credentialEmailLabel(ADDRESS),
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + ACTIVATION_TTL_MS).toISOString(),
        })}\n`,
      )

      const record = await readCredential('activation', hash, store)
      assert.equal(record?.credentialEpoch, 0, 'absent reads as zero, exactly as a fresh entry')
      assert.equal(asEpoch(undefined), 0)
      assert.equal(asEpoch('2026-09-13T00:00:00.000Z'), 0, 'and so does a timestamp')
      assert.equal(asEpoch(-1), 0)
      assert.equal(asEpoch(2.5), 0)
      assert.equal(asEpoch(7), 7)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('with no signing secret, nothing can be minted and nothing can be spent', async () => {
  const { store, root } = freshStore()
  try {
    const saved = process.env.REVIEWER_AUTH_SECRET
    delete process.env.REVIEWER_AUTH_SECRET
    try {
      const issued = await issueCredential(
        'activation',
        { reviewerId: 'anna', emailLabel: 'a'.repeat(32), credentialEpoch: 0 },
        store,
      )
      assert.equal(issued, null)

      const spent = await lookupCredential('activation', 'T'.repeat(43), store)
      assert.equal(spent.ok, false)
      assert.equal(spent.ok === false && spent.reason, 'unconfigured')
      assert.equal(everyFile(root).length, 0, 'and nothing was written')
    } finally {
      if (saved === undefined) delete process.env.REVIEWER_AUTH_SECRET
      else process.env.REVIEWER_AUTH_SECRET = saved
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a malformed credential is refused before anything is read', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      for (const bad of ['', 'short', 'T'.repeat(42), 'T'.repeat(44), 'has spaces in it']) {
        const result = await lookupCredential('activation', bad, store)
        assert.equal(result.ok, false)
        assert.equal(result.ok === false && result.reason, 'malformed', bad)
      }
      assert.equal(everyFile(root).length, 0, 'and nothing was written')
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
