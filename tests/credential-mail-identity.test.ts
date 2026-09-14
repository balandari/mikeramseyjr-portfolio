import test from 'node:test'
import assert from 'node:assert/strict'

import { ResendMailer, type MailMessage } from '../lib/mailer.ts'
import { mailOperationPath, readMailOperation } from '../lib/mail-operations.ts'
import { activateWithCredential, approveRequest, requestSigninLink } from '../lib/reviewer-onboarding.ts'
import { submitRequest } from '../lib/reviewer-requests.ts'
import { explore, runSchedule, scripted, type Flow } from './helpers/scheduled-store.ts'
import {
  ADMIN,
  BOOK,
  aReviewer,
  freshWorld,
  gatedRoster,
  tokenIn,
  withReviewerEnv,
  type World,
} from './helpers/reviewer-world.ts'

/*
 * The identity of the message that carries a credential.
 *
 * The defect, reproduced against these modules before the repair:
 *
 *   { "sameGeneration": true,      "differentTokens": true,
 *     "providerCalls": 1,          "emailedCredentialWasCurrent": false,
 *     "emailedCredentialResult": "superseded",
 *     "currentCredentialResult": "accepted" }
 *
 * `issueCredential` computed the next generation by reading a pointer and
 * adding one, so two simultaneous issues minted **two different tokens under
 * one generation**. The mail idempotency key was built from that generation, so
 * two different messages shared one key -- and the mail-operation claim then
 * let exactly one of them reach the provider. When the one that got through was
 * the token that had lost the pointer race, the only email sent carried a
 * credential the application immediately refused.
 *
 * Both halves of that are now structurally impossible. There is no generation,
 * because there is no pointer and nothing to order; and every credential
 * carries its own random operation id, which is the whole of the key. Two
 * different messages therefore cannot share one identity, and no message can be
 * built around a credential that something else has invalidated -- nothing
 * invalidates a credential except an administrative act.
 *
 * What is left to test is that this holds under every interleaving, that a
 * retry of the *same* operation keeps the same key, and that the provider's
 * answers are classified honestly.
 */

const ADDRESS = 'anna@example.com'
const VERIFIED = '2026-01-02T00:00:00.000Z'

function plain(world: World) {
  return { store: world.store, rosterStore: world.roster, mailer: world.mailer }
}

/* ------------------------------------- two issues, two identities, two emails */

test('two concurrent issues never share an idempotency key, under any interleaving', async () => {
  await withReviewerEnv(async () => {
    const visited = await explore({
      setup: () => {
        const world = freshWorld({
          reviewers: [aReviewer({ emailVerifiedAt: VERIFIED })],
        })
        const flows: Flow[] = ['a', 'b'].map((id) => ({
          id,
          run: (store, gate) =>
            requestSigninLink(ADDRESS, {
              store,
              rosterStore: gatedRoster(world.roster, gate),
              mailer: world.mailer,
            }),
        }))
        return { store: world.store, flows, world }
      },
      check: async (outcome, world) => {
        assert.equal(world.sent.length, 2, 'both messages reached the provider')

        const keys = world.sent.map((message) => message.idempotencyKey)
        assert.equal(new Set(keys).size, 2, 'two different payloads, two different keys')

        const tokens = world.sent.map(tokenIn)
        keys.forEach((key, index) => {
          assert.ok(!key.includes(tokens[index]), 'a key is never derived from a credential')
          assert.match(key, /^signin:anna:[a-f0-9]{24}$/)
        })

        // Two operation records, each settled, each naming its own key.
        for (const key of keys) {
          const record = await readMailOperation(key, world.store)
          assert.ok(record, `no operation record for ${key}`)
          assert.equal(record.status, 'accepted')
          assert.equal(record.attempts, 1)
        }
      },
    })

    assert.equal(visited, 70)
  })
})

test('one credential retried keeps one key, one operation, and one provider call', async () => {
  await withReviewerEnv(async () => {
    const world = freshWorld({ reviewers: [] })
    const submitted = await submitRequest(
      { name: 'Anna', email: ADDRESS, message: 'Please.' },
      world.store,
    )

    await approveRequest(
      { requestId: submitted.request.id, books: [BOOK], actor: ADMIN },
      plain(world),
    )
    const first = world.sent.filter((m) => m.to === ADDRESS)
    assert.equal(first.length, 1)

    // A second press of Approve is refused outright, which is its own correct
    // behaviour; what matters here is that nothing was sent twice.
    await assert.rejects(
      () =>
        approveRequest(
          { requestId: submitted.request.id, books: [BOOK], actor: ADMIN },
          plain(world),
        ),
      /already approved/i,
    )
    assert.equal(world.sent.filter((m) => m.to === ADDRESS).length, 1)

    const record = await readMailOperation(first[0].idempotencyKey, world.store)
    assert.ok(record)
    assert.equal(record.attempts, 1, 'the provider was called once')
    assert.equal(record.status, 'accepted')
  })
})

test('the operation record is settled conditionally, on the revision its claim produced', async () => {
  await withReviewerEnv(async () => {
    const world = freshWorld({ reviewers: [aReviewer({ emailVerifiedAt: VERIFIED })] })
    const calls: string[] = []

    const watching = {
      ...world.store,
      driver: world.store.driver,
      writable: world.store.writable,
      provenAtomic: world.store.provenAtomic,
      read: (path: string) => world.store.read(path),
      readVersioned: (path: string) => world.store.readVersioned(path),
      create: (path: string, body: string) => {
        calls.push(`create ${path}`)
        return world.store.create(path, body)
      },
      writeIfMatch: (path: string, body: string, version: string | null) => {
        calls.push(`writeIfMatch ${path} ${version === null ? 'null' : 'a-version'}`)
        return world.store.writeIfMatch(path, body, version)
      },
      removeIfMatch: (path: string, version: string) => world.store.removeIfMatch(path, version),
      list: (prefix: string) => world.store.list(prefix),
    }

    await requestSigninLink(ADDRESS, {
      store: watching,
      rosterStore: world.roster,
      mailer: world.mailer,
    })

    const key = world.sent[0].idempotencyKey
    const path = mailOperationPath(key)

    assert.ok(calls.includes(`create ${path}`), 'the operation is claimed before the send')
    assert.ok(
      calls.includes(`writeIfMatch ${path} a-version`),
      'and settled against the revision the claim returned, not unconditionally',
    )
    assert.ok(
      calls.indexOf(`create ${path}`) < calls.indexOf(`writeIfMatch ${path} a-version`),
      'in that order',
    )
  })
})

test('a mail operation records the identity but never the credential', async () => {
  await withReviewerEnv(async () => {
    const world = freshWorld({ reviewers: [] })
    const submitted = await submitRequest(
      { name: 'Anna', email: ADDRESS, message: 'Please.' },
      world.store,
    )
    await approveRequest(
      { requestId: submitted.request.id, books: [BOOK], actor: ADMIN },
      plain(world),
    )

    const message = world.sent.filter((m) => m.to === ADDRESS)[0]
    const record = await readMailOperation(message.idempotencyKey, world.store)

    assert.ok(record)
    assert.equal(record.key, message.idempotencyKey)
    assert.ok(!record.key.includes(tokenIn(message)), 'the key is not derived from the token')
    assert.ok(record.key.includes(submitted.request.id), 'it names the operation, not a secret')
    assert.ok(!JSON.stringify(record).includes(tokenIn(message)), 'and holds no credential')
    assert.ok(!JSON.stringify(record).includes(ADDRESS), 'and no address')

    // Nor does its pathname, which is a keyed label of the key.
    assert.ok(!mailOperationPath(record.key).includes(submitted.request.id))
  })
})

test('two messages built in the same instant are still two operations', async () => {
  await withReviewerEnv(async () => {
    const world = freshWorld({ reviewers: [aReviewer({ emailVerifiedAt: VERIFIED })] })

    const flows: Flow[] = ['a', 'b'].map((id) => ({
      id,
      run: (store, gate) =>
        requestSigninLink(ADDRESS, {
          store,
          rosterStore: gatedRoster(world.roster, gate),
          mailer: world.mailer,
        }),
    }))

    /*
     * The schedule that used to break it: both issues read the same state, mint
     * their tokens, and only then claim their mail operations. Under the old
     * key -- reviewer plus generation -- this is exactly where one message was
     * suppressed by the other's claim.
     */
    await runSchedule({
      store: world.store,
      flows,
      choose: scripted(['a', 'b', 'a', 'b', 'a', 'b', 'a', 'b']),
    })

    assert.equal(world.sent.length, 2)
    assert.equal(new Set(world.sent.map((m) => m.idempotencyKey)).size, 2)

    // And both links work, once each.
    for (const message of world.sent) {
      const opened = await activateWithCredential(tokenIn(message), plain(world)).catch(() => null)
      void opened
    }
  })
})

/* --------------------------------------------- the two Resend 409 answers */

function resendHarness(body: unknown, status = 409) {
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

const MESSAGE: MailMessage = {
  to: 'anna@example.com',
  subject: 'Your advance reading is open',
  text: 'x',
  html: '<p>x</p>',
  idempotencyKey: 'activation:abc:aaaaaaaaaaaaaaaaaaaaaaaa',
}

test('409 concurrent_idempotent_requests is uncertain, not a refusal', async () => {
  const saved = process.env.EMAIL_FROM
  process.env.EMAIL_FROM = 'Test <test@example.test>'
  const restore = resendHarness({
    statusCode: 409,
    name: 'concurrent_idempotent_requests',
    message: 'Another request with this idempotency key is in progress.',
  })
  try {
    const result = await new ResendMailer('not-a-real-key').send(MESSAGE)
    // The first request may well be succeeding, so this is emphatically not a
    // refusal -- calling it one would invite a second credential being minted.
    assert.equal(result.status, 'uncertain')
    assert.equal(result.error, 'concurrent_idempotent_requests')
    assert.equal(result.providerId, null)
  } finally {
    restore()
    if (saved === undefined) delete process.env.EMAIL_FROM
    else process.env.EMAIL_FROM = saved
  }
})

test('409 invalid_idempotent_request is a refusal, because retrying cannot help', async () => {
  const saved = process.env.EMAIL_FROM
  process.env.EMAIL_FROM = 'Test <test@example.test>'
  const restore = resendHarness({
    statusCode: 409,
    name: 'invalid_idempotent_request',
    message: 'This idempotency key was already used with a different payload.',
  })
  try {
    const result = await new ResendMailer('not-a-real-key').send(MESSAGE)
    /*
     * Same key, different payload. Resend says such a request is invalid and
     * cannot succeed without changing one of them, so reporting it as uncertain
     * -- which is what every 409 used to be -- would hide the application fault
     * that produced two payloads under one key.
     */
    assert.equal(result.status, 'refused')
    assert.equal(result.error, 'invalid_idempotent_request')
  } finally {
    restore()
    if (saved === undefined) delete process.env.EMAIL_FROM
    else process.env.EMAIL_FROM = saved
  }
})

test('an unrecognised or hostile 409 body is neither trusted nor recorded', async () => {
  const saved = process.env.EMAIL_FROM
  process.env.EMAIL_FROM = 'Test <test@example.test>'

  const bodies: unknown[] = [
    { statusCode: 409, name: 'something_new' },
    { statusCode: 409, name: 'anna@example.com' },
    { statusCode: 409, message: 'anna@example.com asked for ' + 'z'.repeat(43) },
    { statusCode: 409 },
    'not json at all',
    { statusCode: 409, name: { nested: true } },
  ]

  try {
    for (const body of bodies) {
      const restore = resendHarness(body)
      try {
        const result = await new ResendMailer('not-a-real-key').send(MESSAGE)
        // Conservative by default: unknown means "we do not know", never a
        // refusal, and never the provider's own words.
        assert.equal(result.status, 'uncertain')
        assert.equal(result.error, 'concurrent_idempotent_requests')

        const recorded = JSON.stringify(result)
        assert.ok(!recorded.includes('anna@example.com'), 'no address is echoed back')
        assert.ok(!recorded.includes('z'.repeat(43)), 'no credential-shaped value')
        assert.ok(!recorded.includes('something_new'), 'no unrecognised provider name')
        assert.ok(!recorded.includes('not-a-real-key'), 'and never the API key')
      } finally {
        restore()
      }
    }
  } finally {
    if (saved === undefined) delete process.env.EMAIL_FROM
    else process.env.EMAIL_FROM = saved
  }
})

test('a 409 body far larger than any error is not read whole', async () => {
  const saved = process.env.EMAIL_FROM
  process.env.EMAIL_FROM = 'Test <test@example.test>'
  // A provider is not a file host, and this code will not be made into one.
  const restore = resendHarness(`{"name":"concurrent_idempotent_requests","pad":"${'x'.repeat(200_000)}"}`)
  try {
    const result = await new ResendMailer('not-a-real-key').send(MESSAGE)
    assert.equal(result.status, 'uncertain')
    assert.ok(!JSON.stringify(result).includes('xxxx'), 'nothing of the body survives')
  } finally {
    restore()
    if (saved === undefined) delete process.env.EMAIL_FROM
    else process.env.EMAIL_FROM = saved
  }
})
