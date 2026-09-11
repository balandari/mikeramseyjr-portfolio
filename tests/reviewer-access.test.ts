import test from 'node:test'
import assert from 'node:assert/strict'

import {
  REVIEWER_SESSION_SECONDS,
  clearedReviewerCookie,
  fingerprintAccessCode,
  identifyReviewer,
  isReviewerAccessConfigured,
  loadRoster,
  mintReviewerToken,
  normalizeAccessCode,
  reviewerCookie,
  reviewerMayRead,
  reviewerStorageNamespace,
  verifyReviewerToken,
  type Reviewer,
} from '../lib/reviewer-access.ts'

/*
 * These exercise the real gate against the real environment variables, because
 * the environment IS the configuration: a test that stubbed the roster would
 * not prove that a misconfigured deployment fails closed.
 *
 * Codes here are generated per run and never written down. Nothing in this file
 * is a real reviewer's code, and no code from this file is ever valid against a
 * deployment, whose secret is different.
 */

const SECRET = 'test-secret-not-used-by-any-deployment'
const OTHER_SECRET = 'a-different-secret-entirely'

const ANNA_CODE = 'ANNA-TEST-CODE-AAAA'
const BEN_CODE = 'BENB-TEST-CODE-BBBB'
const UNKNOWN_CODE = 'ZZZZ-NOBODY-HAS-THIS'

function withEnv(values: Record<string, string | undefined>, run: () => void | Promise<void>) {
  const saved: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  const result = run()
  if (result instanceof Promise) return result.finally(restore)
  restore()
  return undefined
}

/** Build a roster under the given secret, as the operator script would. */
async function buildRoster(secret: string) {
  process.env.REVIEWER_AUTH_SECRET = secret
  const anna = await fingerprintAccessCode(ANNA_CODE)
  const ben = await fingerprintAccessCode(BEN_CODE)
  assert.ok(anna && ben)
  return JSON.stringify([
    { id: 'anna', name: 'Anna', books: ['the-backward-becoming'], codeHash: anna },
    { id: 'ben', name: 'Ben', books: ['some-other-book'], codeHash: ben },
  ])
}

let ROSTER = ''

test.before(async () => {
  ROSTER = await buildRoster(SECRET)
  process.env.REVIEWER_AUTH_SECRET = SECRET
  process.env.REVIEWER_ROSTER = ROSTER
})

/* ------------------------------------------------------------ code shape */

test('a code normalises independently of case, spacing and grouping', () => {
  assert.equal(normalizeAccessCode('anna-test-code-aaaa'), 'ANNATESTCODEAAAA')
  assert.equal(normalizeAccessCode('  ANNA test CODE aaaa  '), 'ANNATESTCODEAAAA')
  assert.equal(normalizeAccessCode(null), '')
  assert.equal(normalizeAccessCode(undefined), '')
})

test('a fingerprint never contains the code it was made from', async () => {
  const hash = await fingerprintAccessCode(ANNA_CODE)
  assert.ok(hash)
  assert.ok(!hash.includes('ANNA'))
  assert.ok(!hash.toUpperCase().includes(normalizeAccessCode(ANNA_CODE)))
  // Distinct codes produce distinct fingerprints.
  assert.notEqual(hash, await fingerprintAccessCode(BEN_CODE))
})

test('the same code under a different secret produces a different fingerprint', async () => {
  const underTest = await fingerprintAccessCode(ANNA_CODE)
  await withEnv({ REVIEWER_AUTH_SECRET: OTHER_SECRET }, async () => {
    assert.notEqual(await fingerprintAccessCode(ANNA_CODE), underTest)
  })
})

/* ------------------------------------------------------- identify: pass */

test('a valid code identifies exactly the reviewer it belongs to', async () => {
  const anna = await identifyReviewer(ANNA_CODE)
  assert.equal(anna?.id, 'anna')
  assert.equal(anna?.name, 'Anna')

  const ben = await identifyReviewer(BEN_CODE)
  assert.equal(ben?.id, 'ben')
})

test('a code is accepted however the reviewer happens to type it', async () => {
  assert.equal((await identifyReviewer('annatestcodeaaaa'))?.id, 'anna')
  assert.equal((await identifyReviewer('Anna Test Code Aaaa'))?.id, 'anna')
  assert.equal((await identifyReviewer('  ANNA-TEST-CODE-AAAA '))?.id, 'anna')
})

/* ------------------------------------------------------- identify: fail */

test('an unknown code is refused', async () => {
  assert.equal(await identifyReviewer(UNKNOWN_CODE), null)
})

test('an empty or whitespace code is refused', async () => {
  assert.equal(await identifyReviewer(''), null)
  assert.equal(await identifyReviewer('   '), null)
  assert.equal(await identifyReviewer('---'), null)
})

test('a near-miss of a real code is refused', async () => {
  assert.equal(await identifyReviewer(`${ANNA_CODE}X`), null)
  assert.equal(await identifyReviewer(ANNA_CODE.slice(0, -1)), null)
})

test("a reviewer's own fingerprint cannot be submitted as a code", async () => {
  // Possession of the roster must not be possession of access.
  const roster = loadRoster()
  const hash = roster.find((entry) => entry.id === 'anna')?.codeHash
  assert.ok(hash)
  assert.equal(await identifyReviewer(hash), null)
})

test('with no secret configured, nothing is accepted', async () => {
  await withEnv({ REVIEWER_AUTH_SECRET: undefined }, async () => {
    assert.equal(isReviewerAccessConfigured(), false)
    assert.equal(await identifyReviewer(ANNA_CODE), null)
  })
})

test('with no roster configured, nothing is accepted', async () => {
  await withEnv({ REVIEWER_ROSTER: undefined }, async () => {
    assert.equal(isReviewerAccessConfigured(), false)
    assert.equal(await identifyReviewer(ANNA_CODE), null)
  })
})

test('a malformed roster fails closed rather than partially loading', async () => {
  for (const broken of [
    'not json',
    '{}',
    '[]',
    '[{"id":"anna"}]',
    '[{"id":"anna","name":"Anna","books":"nope","codeHash":"x"}]',
    '[{"id":"UPPER","name":"A","books":[],"codeHash":"x"}]',
    '[{"id":"has.dot","name":"A","books":[],"codeHash":"x"}]',
    '[{"id":"a","name":"A","books":["Bad Slug"],"codeHash":"x"}]',
  ]) {
    await withEnv({ REVIEWER_ROSTER: broken }, async () => {
      assert.deepEqual(loadRoster(), [], broken)
      assert.equal(await identifyReviewer(ANNA_CODE), null, broken)
    })
  }
})

test('an ambiguous roster refuses rather than guessing an identity', async () => {
  const hash = await fingerprintAccessCode(ANNA_CODE)
  const duplicated = JSON.stringify([
    { id: 'anna', name: 'Anna', books: ['b'], codeHash: hash },
    { id: 'anna-two', name: 'Anna Two', books: ['b'], codeHash: hash },
  ])
  await withEnv({ REVIEWER_ROSTER: duplicated }, async () => {
    assert.deepEqual(loadRoster(), [])
    assert.equal(await identifyReviewer(ANNA_CODE), null)
  })
})

/* ---------------------------------------------------------------- tokens */

test('a freshly minted token resolves back to the same reviewer', async () => {
  const anna = await identifyReviewer(ANNA_CODE)
  assert.ok(anna)
  const token = await mintReviewerToken(anna)
  assert.ok(token)
  assert.equal((await verifyReviewerToken(token))?.id, 'anna')
})

test('a token lasts about a year and is refused after it expires', async () => {
  const anna = await identifyReviewer(ANNA_CODE)
  assert.ok(anna)
  const mintedAt = Date.now()
  const token = await mintReviewerToken(anna, mintedAt)
  assert.ok(token)

  // A day before expiry: still good.
  const almost = mintedAt + (REVIEWER_SESSION_SECONDS - 86400) * 1000
  assert.equal((await verifyReviewerToken(token, almost))?.id, 'anna')

  // A second past expiry: refused.
  const after = mintedAt + (REVIEWER_SESSION_SECONDS + 1) * 1000
  assert.equal(await verifyReviewerToken(token, after), null)
})

test('a token never contains the access code', async () => {
  const anna = await identifyReviewer(ANNA_CODE)
  assert.ok(anna)
  const token = await mintReviewerToken(anna)
  assert.ok(token)
  assert.ok(!token.includes(normalizeAccessCode(ANNA_CODE)))
  assert.ok(!token.includes(ANNA_CODE))
})

test('a malformed or absent token is refused', async () => {
  for (const bad of [
    null,
    undefined,
    '',
    'nonsense',
    'rv1.anna',
    'rv1.anna.1.2.3.4',
    'xx1.anna.99999999999.aaa.bbb',
  ]) {
    assert.equal(await verifyReviewerToken(bad), null, String(bad))
  }
})

test('a token with a tampered signature is refused', async () => {
  const anna = await identifyReviewer(ANNA_CODE)
  assert.ok(anna)
  const token = await mintReviewerToken(anna)
  assert.ok(token)

  const parts = token.split('.')
  const tampered = `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3]}.${parts[4].slice(0, -2)}XY`
  assert.equal(await verifyReviewerToken(tampered), null)
})

test('a token whose expiry has been pushed out is refused', async () => {
  const anna = await identifyReviewer(ANNA_CODE)
  assert.ok(anna)
  const token = await mintReviewerToken(anna)
  assert.ok(token)

  const parts = token.split('.')
  const extended = [parts[0], parts[1], String(Number(parts[2]) + 31_536_000), parts[3], parts[4]]
  assert.equal(await verifyReviewerToken(extended.join('.')), null)
})

/* ------------------------------------------- cross-reviewer containment */

test("one reviewer's token cannot be edited into another reviewer's identity", async () => {
  const anna = await identifyReviewer(ANNA_CODE)
  assert.ok(anna)
  const token = await mintReviewerToken(anna)
  assert.ok(token)

  const parts = token.split('.')
  assert.equal(parts[1], 'anna')

  // Swap the named reviewer, keep everything else. The signature no longer
  // covers these claims, so this must not become Ben.
  const swapped = ['rv1', 'ben', parts[2], parts[3], parts[4]].join('.')
  assert.equal(await verifyReviewerToken(swapped), null)
})

test("one reviewer's cookie cannot be re-bound to another reviewer's binding", async () => {
  const anna = await identifyReviewer(ANNA_CODE)
  const ben = await identifyReviewer(BEN_CODE)
  assert.ok(anna && ben)

  const annaToken = (await mintReviewerToken(anna))!.split('.')
  const benToken = (await mintReviewerToken(ben))!.split('.')

  // Anna's identity and signature, Ben's binding.
  const frankenstein = ['rv1', 'anna', annaToken[2], benToken[3], annaToken[4]].join('.')
  assert.equal(await verifyReviewerToken(frankenstein), null)
})

test('reviewers see only their own books', async () => {
  const anna = await identifyReviewer(ANNA_CODE)
  const ben = await identifyReviewer(BEN_CODE)
  assert.ok(anna && ben)

  assert.equal(reviewerMayRead(anna, 'the-backward-becoming'), true)
  assert.equal(reviewerMayRead(anna, 'some-other-book'), false)
  assert.equal(reviewerMayRead(ben, 'some-other-book'), true)
  assert.equal(reviewerMayRead(ben, 'the-backward-becoming'), false)
})

test('two reviewers get different, opaque storage namespaces', async () => {
  const anna = await identifyReviewer(ANNA_CODE)
  const ben = await identifyReviewer(BEN_CODE)
  assert.ok(anna && ben)

  const annaNamespace = await reviewerStorageNamespace(anna)
  const benNamespace = await reviewerStorageNamespace(ben)

  assert.notEqual(annaNamespace, benNamespace)
  // Stable for the same reviewer, so their saved place survives a new session.
  assert.equal(await reviewerStorageNamespace(anna), annaNamespace)
  // Opaque: it reveals neither the id nor the code.
  assert.ok(!annaNamespace.toLowerCase().includes('anna'))
  assert.ok(!annaNamespace.includes(normalizeAccessCode(ANNA_CODE)))
})

/* ------------------------------------------------------------ revocation */

test('removing a reviewer from the roster invalidates their existing cookie', async () => {
  const anna = await identifyReviewer(ANNA_CODE)
  assert.ok(anna)
  const token = await mintReviewerToken(anna)
  assert.ok(token)
  assert.equal((await verifyReviewerToken(token))?.id, 'anna')

  const withoutAnna = JSON.stringify(
    loadRoster().filter((entry) => entry.id !== 'anna'),
  )
  await withEnv({ REVIEWER_ROSTER: withoutAnna }, async () => {
    assert.equal(await verifyReviewerToken(token), null)
  })
})

test("re-issuing one reviewer's code invalidates only that reviewer's cookie", async () => {
  const anna = await identifyReviewer(ANNA_CODE)
  const ben = await identifyReviewer(BEN_CODE)
  assert.ok(anna && ben)

  const annaToken = await mintReviewerToken(anna)
  const benToken = await mintReviewerToken(ben)
  assert.ok(annaToken && benToken)

  const rotatedHash = await fingerprintAccessCode('ANNA-BRAND-NEW-CODE-9999')
  const rotated = JSON.stringify(
    loadRoster().map((entry) =>
      entry.id === 'anna' ? { ...entry, codeHash: rotatedHash } : entry,
    ),
  )

  await withEnv({ REVIEWER_ROSTER: rotated }, async () => {
    // Anna's old cookie and old code are both dead.
    assert.equal(await verifyReviewerToken(annaToken), null)
    assert.equal(await identifyReviewer(ANNA_CODE), null)
    // Her new code works.
    assert.equal((await identifyReviewer('ANNA-BRAND-NEW-CODE-9999'))?.id, 'anna')
    // Ben is untouched.
    assert.equal((await verifyReviewerToken(benToken))?.id, 'ben')
  })
})

test('a token minted under a different secret is refused', async () => {
  let foreignToken: string | null = null
  const foreignReviewer: Reviewer = {
    id: 'anna',
    name: 'Anna',
    books: ['the-backward-becoming'],
    codeHash: 'whatever',
  }

  await withEnv({ REVIEWER_AUTH_SECRET: OTHER_SECRET }, async () => {
    foreignToken = await mintReviewerToken(foreignReviewer)
  })

  assert.ok(foreignToken)
  assert.equal(await verifyReviewerToken(foreignToken), null)
})

test('with the gate unconfigured, even a previously valid token is refused', async () => {
  const anna = await identifyReviewer(ANNA_CODE)
  assert.ok(anna)
  const token = await mintReviewerToken(anna)
  assert.ok(token)

  await withEnv({ REVIEWER_AUTH_SECRET: undefined }, async () => {
    assert.equal(await verifyReviewerToken(token), null)
  })
})

/* ---------------------------------------------------------------- cookie */

test('the cookie is HttpOnly, path-scoped, and about a year long', () => {
  const cookie = reviewerCookie('value')
  assert.equal(cookie.httpOnly, true)
  assert.equal(cookie.sameSite, 'lax')
  assert.equal(cookie.path, '/review')
  assert.equal(cookie.maxAge, REVIEWER_SESSION_SECONDS)
  assert.ok(cookie.maxAge >= 360 * 24 * 60 * 60)
})

test('signing out clears the cookie rather than rewriting it', () => {
  const cleared = clearedReviewerCookie()
  assert.equal(cleared.value, '')
  assert.equal(cleared.maxAge, 0)
  assert.equal(cleared.httpOnly, true)
})
