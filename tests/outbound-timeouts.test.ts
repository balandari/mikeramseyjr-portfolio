import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { FileSystemPrivateStore } from '../lib/private-store.ts'
import {
  GOOGLE_TOKEN_TIMEOUT_MS,
  exchangeGoogleCode,
} from '../lib/admin-auth.ts'
import {
  RESEND_TIMEOUT_MS,
  ResendMailer,
  isAbortLike,
  type MailMessage,
} from '../lib/mailer.ts'
import { readMailOperation, sendMailOperation } from '../lib/mail-operations.ts'

/*
 * Deadlines on the two things this application calls that it does not own.
 *
 * Neither had one, and `fetch` supplies none. A provider that accepts the
 * connection and then stalls therefore held the serverless function open until
 * the platform killed it -- and the platform killing it is exactly the crash
 * `lib/mail-operations.ts` exists to survive: the operation stays `in-flight`,
 * every later reader calls it `uncertain`, and it is never re-offered. So the
 * stall spent the whole invocation and produced the one outcome nobody can
 * resolve. On the OAuth side it simply hung the sign-in.
 *
 * What the repair must not do is turn "we stopped waiting" into "it went". The
 * request may have been received and acted on before the deadline passed, and
 * there is no way from here to find out. Every test below is really the same
 * assertion: a terminated send is `uncertain`, and never `accepted`.
 */

const SECRET = 'test-secret-for-timeouts-only'

/** A provider that accepts the call and then says nothing until abandoned. */
function stallingFetch(captured: RequestInit[]): typeof globalThis.fetch {
  return (async (_url: string, init: RequestInit) => {
    captured.push(init)
    const signal = init.signal as AbortSignal | undefined
    if (!signal) {
      // The defect, stated: with no signal there is nothing to stop waiting for.
      return new Promise<Response>(() => {})
    }
    return new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      signal.addEventListener('abort', () => reject(signal.reason))
    })
  }) as typeof globalThis.fetch
}

async function withFetch<T>(impl: typeof globalThis.fetch, run: () => Promise<T>): Promise<T> {
  const saved = globalThis.fetch
  globalThis.fetch = impl
  try {
    return await run()
  } finally {
    globalThis.fetch = saved
  }
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

const message: MailMessage = {
  to: 'anna@example.com',
  subject: 'Your advance reading is open',
  text: 'link',
  html: '<p>link</p>',
  idempotencyKey: 'activation:abc:0123456789abcdef01234567',
}

/* ---------------------------------------------------------- the classifier */

test('a timeout and an explicit abort are both recognised, and nothing else is', () => {
  assert.equal(isAbortLike(new DOMException('timed out', 'TimeoutError')), true)
  assert.equal(isAbortLike(new DOMException('aborted', 'AbortError')), true)
  assert.equal(isAbortLike(new TypeError('fetch failed')), false)
  assert.equal(isAbortLike(new Error('ECONNRESET')), false)
  assert.equal(isAbortLike(null), false)
  assert.equal(isAbortLike('TimeoutError'), false)
})

/* -------------------------------------------------------------- the mailer */

test('the Resend request carries a deadline', async () => {
  const captured: RequestInit[] = []
  await withEnv({ EMAIL_FROM: 'Mike <review@example.test>' }, async () => {
    await withFetch(stallingFetch(captured), async () => {
      await new ResendMailer('secret-key-value', 25).send(message)
    })
  })

  assert.equal(captured.length, 1)
  assert.ok(captured[0].signal instanceof AbortSignal, 'every send is abortable')
})

test('a stalled provider is reported as uncertain, and never as delivered', async () => {
  const result = await withEnv({ EMAIL_FROM: 'Mike <review@example.test>' }, () =>
    withFetch(stallingFetch([]), () => new ResendMailer('secret-key-value', 25).send(message)),
  )

  assert.equal(result.status, 'uncertain', 'the message may have gone; we stopped waiting')
  assert.notEqual(result.status, 'accepted')
  assert.notEqual(result.status, 'refused', 'and a stall is not a refusal either')
  assert.equal(result.error, 'timeout', 'named apart from an ordinary network failure')
  assert.equal(result.providerId, null)
})

test('an ordinary network failure is still named as one', async () => {
  const angry = (async () => {
    throw new TypeError('fetch failed')
  }) as unknown as typeof globalThis.fetch

  const result = await withEnv({ EMAIL_FROM: 'Mike <review@example.test>' }, () =>
    withFetch(angry, () => new ResendMailer('secret-key-value', 25).send(message)),
  )

  assert.equal(result.status, 'uncertain')
  assert.equal(result.error, 'network', 'the two are distinguishable in the record Mike reads')
})

test('the default deadline is generous but finite', () => {
  assert.ok(RESEND_TIMEOUT_MS > 0 && RESEND_TIMEOUT_MS <= 30_000, `${RESEND_TIMEOUT_MS}ms`)
  assert.ok(GOOGLE_TOKEN_TIMEOUT_MS > 0 && GOOGLE_TOKEN_TIMEOUT_MS <= 30_000)
})

/* ---------------------------------------------- the durable state it lands in */

test('a timed-out send settles the operation as uncertain, durably', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mrj-timeout-'))
  try {
    await withEnv(
      { REVIEWER_AUTH_SECRET: SECRET, EMAIL_FROM: 'Mike <review@example.test>' },
      async () => {
        const store = new FileSystemPrivateStore(root)
        const mailer = new ResendMailer('secret-key-value', 25)

        const result = await withFetch(stallingFetch([]), () =>
          sendMailOperation(mailer, message, store),
        )

        assert.equal(result.status, 'uncertain')
        assert.equal(result.error, 'timeout')

        const record = await readMailOperation(message.idempotencyKey, store)
        assert.ok(record, 'the attempt is written down')
        assert.equal(record.status, 'uncertain', 'not accepted, and not left in-flight')
        assert.notEqual(record.status, 'accepted')
        assert.equal(record.providerId, null, 'there is no provider id to claim')
        assert.equal(record.error, 'timeout')
        assert.ok(record.settledAt, 'and it is settled rather than abandoned mid-flight')

        /*
         * The transition an operator has to be able to rely on: a later look at
         * the same key answers uncertain too. It never becomes a success, and
         * the provider is not called again -- the plaintext credential that
         * message carried no longer exists to re-send.
         */
        const again = await withFetch(
          (async () => {
            throw new Error('the provider must not be called again')
          }) as unknown as typeof globalThis.fetch,
          () => sendMailOperation(mailer, message, store),
        )
        assert.equal(again.status, 'uncertain')
      },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an uncertain answer is re-offered once, with the same key, and then stops', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mrj-timeout-retry-'))
  try {
    await withEnv(
      { REVIEWER_AUTH_SECRET: SECRET, EMAIL_FROM: 'Mike <review@example.test>' },
      async () => {
        const store = new FileSystemPrivateStore(root)
        const captured: RequestInit[] = []
        const mailer = new ResendMailer('secret-key-value', 25)

        await withFetch(stallingFetch(captured), () =>
          sendMailOperation(mailer, message, store),
        )

        assert.equal(captured.length, 2, 'the first attempt and one re-offer, and no more')
        for (const init of captured) {
          const headers = init.headers as Record<string, string>
          assert.equal(
            headers['idempotency-key'],
            message.idempotencyKey,
            'the same key both times, which is what makes the re-offer safe',
          )
        }

        const record = await readMailOperation(message.idempotencyKey, store)
        assert.equal(record?.attempts, 2)
        assert.equal(record?.status, 'uncertain')
      },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* --------------------------------------------------------- the token exchange */

const OAUTH = {
  GOOGLE_OAUTH_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret-value',
}

test('the Google token exchange carries a deadline', async () => {
  const captured: RequestInit[] = []
  await withEnv(OAUTH, () =>
    withFetch(stallingFetch(captured), () =>
      exchangeGoogleCode('an-authorization-code', 'https://example.test/admin/api/auth/callback', Date.now(), 25),
    ),
  )

  assert.equal(captured.length, 1)
  assert.ok(captured[0].signal instanceof AbortSignal)
})

test('a stalled token exchange lands in the existing safe state, not in a hang', async () => {
  const identity = await withEnv(OAUTH, () =>
    withFetch(stallingFetch([]), () =>
      exchangeGoogleCode('an-authorization-code', 'https://example.test/admin/api/auth/callback', Date.now(), 25),
    ),
  )

  /*
   * `null` is the only safe answer, and it is the same one a refusal, a
   * malformed body and an unverified address produce. The callback turns every
   * one of them into a single generic message, so a timed-out exchange grants
   * nothing and discloses nothing.
   */
  assert.equal(identity, null)
})

test('a token exchange that fails outright still lands in the same safe state', async () => {
  const angry = (async () => {
    throw new TypeError('fetch failed')
  }) as unknown as typeof globalThis.fetch

  const identity = await withEnv(OAUTH, () =>
    withFetch(angry, () =>
      exchangeGoogleCode('an-authorization-code', 'https://example.test/admin/api/auth/callback'),
    ),
  )
  assert.equal(identity, null)
})

test('neither deadline leaks a credential into what it reports', async () => {
  const result = await withEnv({ EMAIL_FROM: 'Mike <review@example.test>' }, () =>
    withFetch(stallingFetch([]), () => new ResendMailer('secret-key-value', 25).send(message)),
  )
  assert.ok(!JSON.stringify(result).includes('secret-key-value'))
})
