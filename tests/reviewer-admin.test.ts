import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

import { mintReviewerToken, normalizeAccessCode } from '../lib/reviewer-access.ts'
import {
  authorizeReviewer,
  identifyReviewerFromStore,
  isReviewerAccessLive,
  toReviewer,
} from '../lib/reviewer-authorization.ts'
import {
  AdminRequestError,
  createReviewer,
  loadAdminView,
  renameReviewer,
  replaceReviewerCode,
  restoreReviewer,
  revokeReviewer,
  setReviewerEntitlements,
} from '../lib/reviewer-admin.ts'
import { __resetRosterStore, createRosterStore } from '../lib/reviewer-roster.ts'

/*
 * What the dashboard promises, proved end to end against a real store.
 *
 * The promises are: a code issued here opens the reader; revoking closes it on
 * the very next request rather than whenever a cookie expires; replacing a code
 * ends that reviewer's open sessions and nobody else's; entitlements change
 * without a redeploy; and no access code is ever written down anywhere.
 *
 * Every code in this file is generated per run, exists only in memory, and is
 * valid against nothing but the throwaway secret set below.
 */

const SECRET = 'admin-ops-test-secret-not-used-by-any-deployment'
const ACTOR = 'mike@example.com'
const BOOK = 'the-backward-becoming'

type Sandbox = { dir: string }

/**
 * Run a test against a real filesystem-backed roster in a throwaway directory.
 */
async function withRoster(run: (sandbox: Sandbox) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'rv-admin-'))
  const saved = {
    REVIEWER_AUTH_SECRET: process.env.REVIEWER_AUTH_SECRET,
    REVIEWER_ROSTER_DRIVER: process.env.REVIEWER_ROSTER_DRIVER,
    REVIEWER_ROSTER_DIR: process.env.REVIEWER_ROSTER_DIR,
    REVIEWER_ROSTER: process.env.REVIEWER_ROSTER,
  }

  process.env.REVIEWER_AUTH_SECRET = SECRET
  process.env.REVIEWER_ROSTER_DRIVER = 'fs'
  process.env.REVIEWER_ROSTER_DIR = dir
  delete process.env.REVIEWER_ROSTER
  __resetRosterStore()

  try {
    await run({ dir })
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    __resetRosterStore()
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The stored reviewer, with the fingerprint the token binding needs. */
async function stored(id: string) {
  const doc = await createRosterStore().load()
  const entry = doc.reviewers.find((row) => row.id === id)
  assert.ok(entry, `expected ${id} on the roster`)
  return entry
}

/** A signed cookie for a reviewer, exactly as the unlock endpoint would mint it. */
async function sessionFor(id: string): Promise<string> {
  const token = await mintReviewerToken(toReviewer(await stored(id)))
  assert.ok(token)
  return token
}

async function addAnna() {
  return createReviewer({ name: 'Anna Vasquez', email: 'Anna@Example.com ', books: [BOOK] }, ACTOR)
}

/* ------------------------------------------------------------- the basics */

test('adding a reviewer issues a code that opens the reader', async () => {
  await withRoster(async () => {
    const { issued } = await addAnna()

    assert.equal(issued.reviewerId, 'anna-vasquez')
    assert.ok(normalizeAccessCode(issued.code).length >= 12)

    // The code works at the gate.
    const identified = await identifyReviewerFromStore(issued.code)
    assert.equal(identified?.id, 'anna-vasquez')

    // And it works typed without its grouping dashes, as a reviewer might.
    const plain = await identifyReviewerFromStore(normalizeAccessCode(issued.code))
    assert.equal(plain?.id, 'anna-vasquez')

    // The session it leads to is authorised.
    const reviewer = await authorizeReviewer(await sessionFor('anna-vasquez'))
    assert.equal(reviewer?.name, 'Anna Vasquez')
    assert.deepEqual(reviewer?.books, [BOOK])
  })
})

test('the address is normalised, and the identifier derived from the name', async () => {
  await withRoster(async () => {
    await addAnna()
    const entry = await stored('anna-vasquez')
    assert.equal(entry.email, 'anna@example.com')
    assert.equal(entry.status, 'active')
    assert.equal(entry.lastAccessAt, null)
  })
})

/* --------------------------------------------- the promise: no stored codes */

test('the issued code is written nowhere -- not the roster, not the audit log', async () => {
  await withRoster(async ({ dir }) => {
    const { issued } = await addAnna()
    await replaceReviewerCode('anna-vasquez', ACTOR)
    await revokeReviewer('anna-vasquez', ACTOR)

    const normalized = normalizeAccessCode(issued.code)

    for (const file of ['roster.json', 'audit.ndjson']) {
      const path = join(dir, file)
      if (!existsSync(path)) continue
      const raw = readFileSync(path, 'utf8')
      // Neither the grouped code nor its normalised form appears anywhere.
      assert.ok(!raw.includes(issued.code), `${file} contains the code as issued`)
      assert.ok(!raw.includes(normalized), `${file} contains the normalised code`)
    }

    // What IS stored is a keyed fingerprint, which is not the code.
    const entry = await stored('anna-vasquez')
    assert.ok(entry.codeHash.length > 0)
    assert.notEqual(entry.codeHash, normalized)
  })
})

/* ------------------------------------------------- the promise: revocation */

test('revoking ends an open session on the very next request', async () => {
  await withRoster(async () => {
    await addAnna()
    const session = await sessionFor('anna-vasquez')

    // Signed in and reading.
    assert.ok(await authorizeReviewer(session))

    await revokeReviewer('anna-vasquez', ACTOR)

    // The same cookie, unchanged and still perfectly well signed, is now
    // worthless. Nothing expired and nothing was redeployed.
    assert.equal(await authorizeReviewer(session), null)
  })
})

test('a revoked code is refused at the gate, and indistinguishably so', async () => {
  await withRoster(async () => {
    const { issued } = await addAnna()
    await revokeReviewer('anna-vasquez', ACTOR)

    // Same answer a wholly unknown code gets: null, with nothing to tell them
    // apart.
    assert.equal(await identifyReviewerFromStore(issued.code), null)
    assert.equal(await identifyReviewerFromStore('ZZZZ-NOBODY-HAS-THIS'), null)
  })
})

test('restoring a reviewer brings their previous code back', async () => {
  await withRoster(async () => {
    const { issued } = await addAnna()
    await revokeReviewer('anna-vasquez', ACTOR)
    assert.equal(await identifyReviewerFromStore(issued.code), null)

    await restoreReviewer('anna-vasquez', ACTOR)
    assert.equal((await identifyReviewerFromStore(issued.code))?.id, 'anna-vasquez')
  })
})

test('revoking one reviewer leaves the others untouched', async () => {
  await withRoster(async () => {
    const anna = await addAnna()
    const ben = await createReviewer(
      { name: 'Ben', email: 'ben@example.com', books: [BOOK] },
      ACTOR,
    )

    const bensSession = await sessionFor('ben')
    await revokeReviewer('anna-vasquez', ACTOR)

    assert.equal(await identifyReviewerFromStore(anna.issued.code), null)
    assert.equal((await identifyReviewerFromStore(ben.issued.code))?.id, 'ben')
    assert.ok(await authorizeReviewer(bensSession))
  })
})

/* -------------------------------------------- the promise: code replacement */

test('replacing a code invalidates every session that used the old one', async () => {
  await withRoster(async () => {
    const first = await addAnna()
    const session = await sessionFor('anna-vasquez')
    assert.ok(await authorizeReviewer(session))

    const second = await replaceReviewerCode('anna-vasquez', ACTOR)

    // The old cookie is dead on its next request...
    assert.equal(await authorizeReviewer(session), null)
    // ...the old code no longer opens anything...
    assert.equal(await identifyReviewerFromStore(first.issued.code), null)
    // ...and the new one does.
    assert.equal((await identifyReviewerFromStore(second.issued.code))?.id, 'anna-vasquez')
    assert.notEqual(second.issued.code, first.issued.code)

    // A session minted against the new code is fine.
    assert.ok(await authorizeReviewer(await sessionFor('anna-vasquez')))
  })
})

test("replacing one reviewer's code does not touch anybody else's session", async () => {
  await withRoster(async () => {
    await addAnna()
    await createReviewer({ name: 'Ben', email: 'ben@example.com', books: [BOOK] }, ACTOR)

    const bensSession = await sessionFor('ben')
    await replaceReviewerCode('anna-vasquez', ACTOR)

    assert.ok(await authorizeReviewer(bensSession))
  })
})

test('replacing a code moves the issued timestamp', async () => {
  await withRoster(async () => {
    await addAnna()
    const before = await stored('anna-vasquez')
    await replaceReviewerCode('anna-vasquez', ACTOR)
    const after = await stored('anna-vasquez')

    assert.notEqual(after.codeHash, before.codeHash)
    assert.ok(Date.parse(after.codeUpdatedAt) >= Date.parse(before.codeUpdatedAt))
    // Adding-time is history and does not move.
    assert.equal(after.createdAt, before.createdAt)
  })
})

/* ------------------------------------------ the promise: entitlements, live */

test('an entitlement change takes effect without a redeploy', async () => {
  await withRoster(async () => {
    await createReviewer({ name: 'Anna', email: 'anna@example.com', books: [] }, ACTOR)
    const session = await sessionFor('anna')

    // Signed in, entitled to nothing.
    assert.deepEqual((await authorizeReviewer(session))?.books, [])

    await setReviewerEntitlements('anna', [BOOK], ACTOR)
    // Same cookie, more books -- read fresh from the roster on every request.
    assert.deepEqual((await authorizeReviewer(session))?.books, [BOOK])

    await setReviewerEntitlements('anna', [], ACTOR)
    assert.deepEqual((await authorizeReviewer(session))?.books, [])
  })
})

test('a book this site does not have cannot be granted', async () => {
  await withRoster(async () => {
    await addAnna()
    await assert.rejects(
      () => setReviewerEntitlements('anna-vasquez', ['a-book-that-does-not-exist'], ACTOR),
      (error: Error) => error instanceof AdminRequestError,
    )
    // Nothing changed.
    assert.deepEqual((await stored('anna-vasquez')).books, [BOOK])
  })
})

/* ---------------------------------------------------------- last access */

test('authorising a reviewer records roughly when they were last seen', async () => {
  await withRoster(async () => {
    await addAnna()
    assert.equal((await stored('anna-vasquez')).lastAccessAt, null)

    await authorizeReviewer(await sessionFor('anna-vasquez'))

    const seen = (await stored('anna-vasquez')).lastAccessAt
    assert.ok(seen, 'expected a last-access timestamp')
    assert.ok(Math.abs(Date.now() - Date.parse(seen)) < 60_000)
  })
})

/* --------------------------------------------------------------- validation */

test('a duplicate identifier or address is refused', async () => {
  await withRoster(async () => {
    await addAnna()

    await assert.rejects(
      () => createReviewer({ name: 'Anna Vasquez', email: 'other@example.com', books: [] }, ACTOR),
      /already a reviewer with the identifier/,
    )
    await assert.rejects(
      () => createReviewer({ name: 'Someone Else', email: 'anna@example.com', books: [] }, ACTOR),
      /already a reviewer with the address/,
    )
  })
})

test('a missing or malformed name or address is refused', async () => {
  await withRoster(async () => {
    for (const bad of [
      { name: '', email: 'a@b.co', books: [] },
      { name: '   ', email: 'a@b.co', books: [] },
      { name: 'Anna', email: '', books: [] },
      { name: 'Anna', email: 'not-an-address', books: [] },
      { name: 'Anna', email: 'a@localhost', books: [] },
      { name: 'Anna', email: 'a@b.co', books: 'not-a-list' },
    ]) {
      await assert.rejects(
        () => createReviewer(bad as never, ACTOR),
        (error: Error) => error instanceof AdminRequestError,
        `expected ${JSON.stringify(bad)} to be refused`,
      )
    }

    assert.deepEqual((await createRosterStore().load()).reviewers, [])
  })
})

test('a name that yields no usable identifier is refused rather than guessed at', async () => {
  await withRoster(async () => {
    await assert.rejects(
      () => createReviewer({ name: '???', email: 'a@b.co', books: [] }, ACTOR),
      /identifier/,
    )
  })
})

test('an operation on somebody who is not on the roster is refused', async () => {
  await withRoster(async () => {
    for (const run of [
      () => revokeReviewer('nobody', ACTOR),
      () => restoreReviewer('nobody', ACTOR),
      () => replaceReviewerCode('nobody', ACTOR),
      () => renameReviewer('nobody', 'New Name', ACTOR),
      () => setReviewerEntitlements('nobody', [], ACTOR),
    ]) {
      await assert.rejects(run, (error: Error) => error instanceof AdminRequestError)
    }
  })
})

/* -------------------------------------------------------------- read-only */

test('a read-only roster refuses every mutation and says why', async () => {
  const saved = {
    REVIEWER_AUTH_SECRET: process.env.REVIEWER_AUTH_SECRET,
    REVIEWER_ROSTER_DRIVER: process.env.REVIEWER_ROSTER_DRIVER,
    REVIEWER_ROSTER: process.env.REVIEWER_ROSTER,
  }
  process.env.REVIEWER_AUTH_SECRET = SECRET
  process.env.REVIEWER_ROSTER_DRIVER = 'env'
  process.env.REVIEWER_ROSTER = JSON.stringify([
    { id: 'anna', name: 'Anna', books: [BOOK], codeHash: 'fp-anna' },
  ])
  __resetRosterStore()

  try {
    // Appearing to save and silently discarding the change on the next cold
    // start would be far worse than refusing.
    await assert.rejects(
      () => revokeReviewer('anna', ACTOR),
      /read-only "env" driver/,
    )
    const view = await loadAdminView()
    assert.equal(view.writable, false)
    assert.equal(view.driver, 'env')
    assert.equal(view.reviewers.length, 1)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    __resetRosterStore()
  }
})

/* ------------------------------------------------------------------ audit */

test('every change leaves one audit line naming who did it', async () => {
  await withRoster(async () => {
    await addAnna()
    await setReviewerEntitlements('anna-vasquez', [], ACTOR)
    await renameReviewer('anna-vasquez', 'Anna V.', ACTOR)
    await replaceReviewerCode('anna-vasquez', ACTOR)
    await revokeReviewer('anna-vasquez', ACTOR)
    await restoreReviewer('anna-vasquez', ACTOR)

    const view = await loadAdminView()
    const actions: string[] = view.audit.map((event) => event.action)

    for (const expected of [
      'reviewer.created',
      'reviewer.entitlements-changed',
      'reviewer.renamed',
      'reviewer.code-replaced',
      'reviewer.revoked',
      'reviewer.restored',
    ]) {
      assert.ok(actions.includes(expected), `missing an audit line for ${expected}`)
    }

    for (const event of view.audit) {
      assert.equal(event.actor, ACTOR)
      assert.equal(event.reviewerId, 'anna-vasquez')
    }
  })
})

/* ------------------------------------------------------------ availability */

test('a roster with nobody active is not a live reader', async () => {
  await withRoster(async () => {
    assert.equal(await isReviewerAccessLive(), false)

    await addAnna()
    assert.equal(await isReviewerAccessLive(), true)

    await revokeReviewer('anna-vasquez', ACTOR)
    assert.equal(await isReviewerAccessLive(), false)
  })
})
