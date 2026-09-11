import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ADMIN_COOKIE_NAME,
  ADMIN_SESSION_SECONDS,
  adminAllowlist,
  adminCookie,
  adminCsrfToken,
  adminCsrfTokenMatches,
  adminRedirectUri,
  clearedAdminCookie,
  googleAuthorizationUrl,
  identityFromIdToken,
  isAdminConfigured,
  isAllowedAdminEmail,
  mintAdminState,
  mintAdminToken,
  safeAdminPath,
  verifyAdminState,
  verifyAdminToken,
} from '../lib/admin-auth.ts'
import {
  REVIEWER_COOKIE_NAME,
  mintReviewerToken,
  verifyReviewerToken,
} from '../lib/reviewer-access.ts'

/*
 * The rule this file exists to hold in place:
 *
 *   A successful Google sign-in is NOT enough.
 *
 * Google establishes which verified mailbox somebody controls. Authorisation is
 * a separate question, answered only by an exact match against the configured
 * allowlist. Most of the tests below are the ways somebody might try to get
 * between those two facts.
 *
 * No real client id, client secret, Google project or token appears anywhere in
 * this file. The id tokens are hand-built shapes, valid only against the
 * throwaway configuration each test sets.
 */

const ADMIN_SECRET = 'admin-test-secret-not-used-by-any-deployment'
const CLIENT_ID = 'test-client-id.apps.googleusercontent.com'
const MIKE = 'mike@example.com'
const STRANGER = 'someone-else@example.com'

function config(overrides: Record<string, string | undefined> = {}) {
  return {
    ADMIN_AUTH_SECRET: ADMIN_SECRET,
    GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: 'test-client-secret',
    ADMIN_ALLOWED_EMAILS: MIKE,
    ...overrides,
  }
}

function withEnv<T>(env: Record<string, string | undefined>, run: () => T | Promise<T>) {
  const saved: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
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
  return result
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

/** A Google id token's shape. Never signed -- nothing here checks a signature. */
function idToken(claims: Record<string, unknown>): string {
  return [
    base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
    base64url(JSON.stringify(claims)),
    'signature-is-never-checked-here',
  ].join('.')
}

function goodClaims(overrides: Record<string, unknown> = {}) {
  return {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 600,
    email: MIKE,
    email_verified: true,
    ...overrides,
  }
}

/* ------------------------------------------------------------ configuration */

test('the dashboard is unconfigured until every input is present', () => {
  withEnv(config(), () => assert.equal(isAdminConfigured(), true))

  for (const missing of [
    'ADMIN_AUTH_SECRET',
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'ADMIN_ALLOWED_EMAILS',
  ]) {
    withEnv(config({ [missing]: undefined }), () => {
      assert.equal(isAdminConfigured(), false, `expected unconfigured without ${missing}`)
    })
  }
})

test('an allowlist of nobody counts as unconfigured', () => {
  // A dashboard that can only ever refuse is not a working dashboard, and
  // rendering a sign-in button for it would be a lie.
  withEnv(config({ ADMIN_ALLOWED_EMAILS: '   ,  , ' }), () => {
    assert.deepEqual(adminAllowlist(), [])
    assert.equal(isAdminConfigured(), false)
  })
})

test('the allowlist is exact, normalised, and not a pattern', () => {
  withEnv(config({ ADMIN_ALLOWED_EMAILS: ' Mike@Example.com , second@example.com ' }), () => {
    assert.deepEqual(adminAllowlist(), [MIKE, 'second@example.com'])
    assert.ok(isAllowedAdminEmail('MIKE@EXAMPLE.COM'))
    assert.ok(isAllowedAdminEmail('  mike@example.com  '))

    // None of these is Mike, and none of them is close enough.
    assert.ok(!isAllowedAdminEmail('mike@example.com.evil.test'))
    assert.ok(!isAllowedAdminEmail('evil.test/mike@example.com'))
    assert.ok(!isAllowedAdminEmail('mike@exampleXcom'))
    assert.ok(!isAllowedAdminEmail('m.ike@example.com'))
    assert.ok(!isAllowedAdminEmail('mike+admin@example.com'))
    assert.ok(!isAllowedAdminEmail(''))
  })
})

/* -------------------------------------------------- the Google identity check */

test('a verified, allowlisted identity is accepted', () => {
  withEnv(config(), () => {
    assert.deepEqual(identityFromIdToken(idToken(goodClaims())), { email: MIKE })
  })
})

test('an UNVERIFIED address is refused, however good the rest of the token is', () => {
  // This is the check that would otherwise let anybody assert they are Mike by
  // adding his address to an account they control and never confirming it.
  withEnv(config(), () => {
    assert.equal(identityFromIdToken(idToken(goodClaims({ email_verified: false }))), null)
    assert.equal(identityFromIdToken(idToken(goodClaims({ email_verified: 'false' }))), null)
    assert.equal(identityFromIdToken(idToken(goodClaims({ email_verified: undefined }))), null)
    assert.equal(identityFromIdToken(idToken(goodClaims({ email_verified: 1 }))), null)
  })
})

test('a token minted for a different client is refused', () => {
  withEnv(config(), () => {
    assert.equal(identityFromIdToken(idToken(goodClaims({ aud: 'someone-elses-client' }))), null)
  })
})

test('a token from a different issuer is refused', () => {
  withEnv(config(), () => {
    assert.equal(identityFromIdToken(idToken(goodClaims({ iss: 'https://evil.test' }))), null)
    assert.equal(identityFromIdToken(idToken(goodClaims({ iss: undefined }))), null)
  })
})

test('an expired token is refused', () => {
  withEnv(config(), () => {
    const expired = idToken(goodClaims({ exp: Math.floor(Date.now() / 1000) - 1 }))
    assert.equal(identityFromIdToken(expired), null)
  })
})

test('a malformed token is refused rather than half-read', () => {
  withEnv(config(), () => {
    for (const bad of ['', 'not-a-jwt', 'a.b', 'a.b.c.d', `a.${base64url('not json')}.c`]) {
      assert.equal(identityFromIdToken(bad), null)
    }
  })
})

/* ------------------------------------------------------------ the session */

test('a session can only be minted for an allowlisted address', async () => {
  await withEnv(config(), async () => {
    assert.ok(await mintAdminToken(MIKE))
    // Google said this person is real. The allowlist says they are not an
    // administrator, and the allowlist is what decides.
    assert.equal(await mintAdminToken(STRANGER), null)
  })
})

test('a minted session verifies, and names the administrator', async () => {
  await withEnv(config(), async () => {
    const token = await mintAdminToken(MIKE)
    assert.ok(token)
    assert.deepEqual(await verifyAdminToken(token), { email: MIKE })
  })
})

test('removing an address from the allowlist ends its session immediately', async () => {
  // Authority is re-derived from configuration on every request, never carried
  // by the cookie -- so this does not wait for an expiry.
  const token = await withEnv(config(), () => mintAdminToken(MIKE))
  assert.ok(token)

  await withEnv(config({ ADMIN_ALLOWED_EMAILS: 'somebody-else@example.com' }), async () => {
    assert.equal(await verifyAdminToken(token), null)
  })
})

test('a session signed under a different secret is refused', async () => {
  const token = await withEnv(config(), () => mintAdminToken(MIKE))
  await withEnv(config({ ADMIN_AUTH_SECRET: 'a-completely-different-secret' }), async () => {
    assert.equal(await verifyAdminToken(token), null)
  })
})

test('a tampered session is refused', async () => {
  await withEnv(config({ ADMIN_ALLOWED_EMAILS: `${MIKE},${STRANGER}` }), async () => {
    const token = await mintAdminToken(MIKE)
    assert.ok(token)
    const [version, email, exp, signature] = token.split('.')

    // Swap the address for another allowlisted one without re-signing.
    const forged = [version, Buffer.from(STRANGER, 'utf8').toString('base64url'), exp, signature]
    assert.equal(await verifyAdminToken(forged.join('.')), null)

    // Extend the expiry.
    assert.equal(
      await verifyAdminToken([version, email, String(Number(exp) + 86400), signature].join('.')),
      null,
    )

    // Wrong version, wrong arity, empty.
    assert.equal(await verifyAdminToken(['zz9', email, exp, signature].join('.')), null)
    assert.equal(await verifyAdminToken(`${token}.extra`), null)
    assert.equal(await verifyAdminToken(''), null)
    assert.equal(await verifyAdminToken(null), null)
  })
})

test('an expired session is refused', async () => {
  await withEnv(config(), async () => {
    const past = Date.now() - (ADMIN_SESSION_SECONDS + 60) * 1000
    const token = await mintAdminToken(MIKE, past)
    assert.ok(token)
    assert.equal(await verifyAdminToken(token), null)
  })
})

test('with no secret configured, nothing can be minted and nothing verifies', async () => {
  await withEnv(config({ ADMIN_AUTH_SECRET: undefined }), async () => {
    assert.equal(await mintAdminToken(MIKE), null)
    assert.equal(await verifyAdminToken('anything'), null)
    assert.equal(await mintAdminState('/admin'), null)
  })
})

/* ------------------------------------------- separation from reviewer access */

test('an administrator session is not a reviewer session, and vice versa', async () => {
  // The two mechanisms share a deployment and nothing else: different secret,
  // different cookie, different label, different token shape.
  assert.notEqual(ADMIN_COOKIE_NAME, REVIEWER_COOKIE_NAME)

  await withEnv(
    {
      ...config(),
      REVIEWER_AUTH_SECRET: 'reviewer-test-secret',
      REVIEWER_ROSTER: JSON.stringify([
        { id: 'anna', name: 'Anna', books: ['the-backward-becoming'], codeHash: 'fp-anna' },
      ]),
    },
    async () => {
      const adminToken = await mintAdminToken(MIKE)
      const reviewerToken = await mintReviewerToken({
        id: 'anna',
        name: 'Anna',
        books: ['the-backward-becoming'],
        codeHash: 'fp-anna',
      })
      assert.ok(adminToken)
      assert.ok(reviewerToken)

      // Neither is accepted by the other's verifier.
      assert.equal(await verifyReviewerToken(adminToken), null)
      assert.equal(await verifyAdminToken(reviewerToken), null)
    },
  )
})

test('even sharing one secret, the two token kinds stay separate', async () => {
  // Domain separation is by label, not by the secret happening to differ.
  const shared = 'one-secret-for-both-which-is-not-recommended'
  await withEnv(
    {
      ...config({ ADMIN_AUTH_SECRET: shared }),
      REVIEWER_AUTH_SECRET: shared,
      REVIEWER_ROSTER: JSON.stringify([
        { id: 'anna', name: 'Anna', books: [], codeHash: 'fp-anna' },
      ]),
    },
    async () => {
      const adminToken = await mintAdminToken(MIKE)
      assert.ok(adminToken)
      assert.equal(await verifyReviewerToken(adminToken), null)
    },
  )
})

/* ----------------------------------------------------------------- CSRF */

test('a mutation token is bound to its own session', async () => {
  await withEnv(config({ ADMIN_ALLOWED_EMAILS: `${MIKE},${STRANGER}` }), async () => {
    const mine = await mintAdminToken(MIKE)
    const theirs = await mintAdminToken(STRANGER, Date.now() + 1000)
    assert.ok(mine)
    assert.ok(theirs)

    const token = await adminCsrfToken(mine)
    assert.ok(token)

    assert.equal(await adminCsrfTokenMatches(mine, token), true)
    assert.equal(await adminCsrfTokenMatches(theirs, token), false)
    assert.equal(await adminCsrfTokenMatches(mine, 'guessed'), false)
    assert.equal(await adminCsrfTokenMatches(mine, ''), false)
    assert.equal(await adminCsrfTokenMatches(mine, null), false)
  })
})

/* ----------------------------------------------------------------- state */

test('the OAuth state round-trips, and carries where to land', async () => {
  await withEnv(config(), async () => {
    const minted = await mintAdminState('/admin?tab=history')
    assert.ok(minted)
    const parsed = await verifyAdminState(minted.state)
    assert.equal(parsed?.nonce, minted.nonce)
    assert.equal(parsed?.next, '/admin?tab=history')
  })
})

test('a tampered, stale or foreign state is refused', async () => {
  await withEnv(config(), async () => {
    const minted = await mintAdminState('/admin')
    assert.ok(minted)

    assert.equal(await verifyAdminState(`${minted.state}x`), null)
    assert.equal(await verifyAdminState('st1.a.b.c.d'), null)
    assert.equal(await verifyAdminState(null), null)

    // Five minutes later it is no longer a live attempt.
    assert.equal(await verifyAdminState(minted.state, Date.now() + 6 * 60 * 1000), null)
  })

  // Minted under one secret, presented under another.
  const other = await withEnv(config({ ADMIN_AUTH_SECRET: 'different' }), () =>
    mintAdminState('/admin'),
  )
  await withEnv(config(), async () => {
    assert.equal(await verifyAdminState(other!.state), null)
  })
})

test('a redirect target can never leave the dashboard', () => {
  // What is allowed through, unchanged.
  assert.equal(safeAdminPath('/admin'), '/admin')
  assert.equal(safeAdminPath('/admin/anything?x=1'), '/admin/anything?x=1')
  assert.equal(safeAdminPath('/admin?tab=history'), '/admin?tab=history')

  for (const hostile of [
    'https://evil.test/admin',
    '//evil.test',
    '/\\evil.test',
    '/review',
    '/review/the-backward-becoming',
    '/',
    // Begins with the same letters and is a different path entirely.
    '/adminevil',
    '/admin.evil.test',
    null,
    undefined,
    42 as unknown as string,
  ]) {
    assert.equal(safeAdminPath(hostile as string), '/admin', `${String(hostile)} was let through`)
  }
})

/* --------------------------------------------------------------- plumbing */

test('the authorization URL asks for the least it can', () => {
  withEnv(config(), () => {
    const url = new URL(
      googleAuthorizationUrl('https://mikeramseyjr.com/admin/api/auth/callback', 'the-state'),
    )
    assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
    // Identity only. No profile, no name, no picture.
    assert.equal(url.searchParams.get('scope'), 'openid email')
    assert.equal(url.searchParams.get('response_type'), 'code')
    assert.equal(url.searchParams.get('state'), 'the-state')
    assert.equal(url.searchParams.get('client_id'), CLIENT_ID)
    // The client secret is never in a URL.
    assert.ok(!url.toString().includes('test-client-secret'))
  })
})

test('the redirect URI is configurable, and otherwise derived from the request', () => {
  withEnv(config({ ADMIN_OAUTH_REDIRECT_URI: undefined }), () => {
    assert.equal(
      adminRedirectUri('http://localhost:3000/admin/api/auth/start'),
      'http://localhost:3000/admin/api/auth/callback',
    )
  })
  withEnv(config({ ADMIN_OAUTH_REDIRECT_URI: 'https://mikeramseyjr.com/admin/api/auth/callback' }), () => {
    assert.equal(
      adminRedirectUri('http://localhost:3000/admin/api/auth/start'),
      'https://mikeramseyjr.com/admin/api/auth/callback',
    )
  })
})

test('the admin cookie is HttpOnly and scoped to /admin alone', () => {
  const cookie = adminCookie('value')
  assert.equal(cookie.name, ADMIN_COOKIE_NAME)
  assert.equal(cookie.httpOnly, true)
  assert.equal(cookie.sameSite, 'lax')
  // Never presented to the public site, and never to the reviewer reader.
  assert.equal(cookie.path, '/admin')
  assert.equal(clearedAdminCookie().maxAge, 0)
  assert.equal(clearedAdminCookie().value, '')
})
