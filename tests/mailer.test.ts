import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { FileMailer, ResendMailer, siteOrigin, type MailMessage } from '../lib/mailer.ts'
import {
  activationLink,
  activationMessage,
  authorAlertMessage,
  escapeHtml,
  signinLink,
  signinMessage,
} from '../lib/mail-messages.ts'
import type { ReviewerRequest } from '../lib/reviewer-requests.ts'

/*
 * Delivery, and telling the truth about it.
 *
 * The Resend driver has never run against the real service from this
 * repository -- it needs a credential this work is not authorised to hold -- so
 * what is tested here is the contract it implements: the headers it sends, and
 * the way it maps an answer onto one of four honest outcomes. The mapping
 * follows the service's documented behaviour, and that distinction is stated in
 * the report rather than hidden behind a green tick.
 */

const request: ReviewerRequest = {
  schema: 1,
  id: 'a'.repeat(24),
  createdAt: '2026-09-13T10:00:00.000Z',
  updatedAt: '2026-09-13T10:00:00.000Z',
  name: 'Anna Vasquez',
  email: 'anna@example.com',
  message: 'We met at the reading in March.',
  status: 'pending',
  reviewerId: null,
  books: [],
  decidedAt: null,
  decidedBy: null,
  activation: null,
  delivery: null,
  alertedAt: null,
  notificationId: 'b'.repeat(24),
}

/* ------------------------------------------------------------ composition */

test('a credential travels in the fragment, never in a query parameter', () => {
  const token = 'T'.repeat(43)

  const activation = activationLink('https://example.test', token)
  assert.equal(activation, `https://example.test/review/activate#a=${token}`)

  const signin = signinLink('https://example.test', token)
  assert.equal(signin, `https://example.test/review/signin/verify#s=${token}`)

  for (const link of [activation, signin]) {
    const url = new URL(link)
    assert.equal(url.search, '', 'nothing is in the query string')
    assert.ok(url.hash.includes(token), 'and the credential is in the part never sent')
  }
})

test('the messages carry the link, the code, and nothing else secret', () => {
  const token = 'T'.repeat(43)
  const message = activationMessage({
    to: 'anna@example.com',
    name: 'Anna Vasquez',
    origin: 'https://example.test',
    token,
    expiresAt: '2026-09-16T10:00:00.000Z',
    operationId: 'a'.repeat(24),
    requestId: request.id,
  })

  assert.match(message.text, /#a=T{43}/)
  assert.ok(message.text.includes(token), 'the printed code is there for a damaged link')
  assert.doesNotMatch(message.text, /\?token=/)
  assert.doesNotMatch(message.html, /\?token=/)
  // The credential's own random operation identity is the whole of the key, so
  // two different tokens can never produce one. See `lib/auth-credentials.ts`.
  assert.equal(message.idempotencyKey, `activation:${request.id}:${'a'.repeat(24)}`)

  const later = signinMessage({
    to: 'anna@example.com',
    name: 'Anna',
    origin: 'https://example.test',
    token,
    expiresAt: '2026-09-13T10:15:00.000Z',
    operationId: 'b'.repeat(24),
    reviewerId: 'anna',
  })
  assert.equal(later.idempotencyKey, `signin:anna:${'b'.repeat(24)}`)
})

test("a stranger's name and message are escaped before they reach Mike's mail client", () => {
  const hostile: ReviewerRequest = {
    ...request,
    name: '<img src=x onerror="alert(1)">',
    message: 'Hello <script>steal()</script> & "goodbye"',
  }

  const message = authorAlertMessage({
    to: 'mike@example.com',
    request: hostile,
    adminUrl: 'https://example.test/admin',
  })

  /*
   * The test is that nothing they typed becomes an element. The characters
   * survive as text -- `onerror=` still reads as `onerror=` on the page, and
   * should -- but there is no tag for it to be an attribute of.
   */
  assert.doesNotMatch(message.html, /<script/)
  assert.doesNotMatch(message.html, /<img/)
  assert.match(message.html, /&lt;script&gt;/)
  assert.match(message.html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/)
  assert.match(message.html, /&amp;/)
  assert.equal(message.replyTo, 'anna@example.com')
  // The occurrence, not just the request: see `tests/author-alert-identity.test.ts`
  // for the sequence that made the id alone insufficient.
  assert.equal(
    message.idempotencyKey,
    `author-alert:${hostile.id}:${hostile.notificationId}`,
  )
})

test('escaping covers every character that changes meaning in HTML', () => {
  assert.equal(escapeHtml(`<&>"'`), '&lt;&amp;&gt;&quot;&#39;')
})

/* -------------------------------------------------------------- the origin */

test('the origin for every emailed link is configured, never inferred', () => {
  const saved = process.env.SITE_ORIGIN
  try {
    process.env.SITE_ORIGIN = 'https://mikeramseyjr.com'
    assert.equal(siteOrigin(), 'https://mikeramseyjr.com')

    process.env.SITE_ORIGIN = 'https://mikeramseyjr.com/review/'
    assert.equal(siteOrigin(), 'https://mikeramseyjr.com', 'only the origin survives')

    process.env.SITE_ORIGIN = 'javascript:alert(1)'
    assert.equal(siteOrigin(), null)

    process.env.SITE_ORIGIN = 'not a url'
    assert.equal(siteOrigin(), null)

    delete process.env.SITE_ORIGIN
    assert.equal(siteOrigin(), null, 'unset means no link can be built, and none is guessed')
  } finally {
    if (saved === undefined) delete process.env.SITE_ORIGIN
    else process.env.SITE_ORIGIN = saved
  }
})

/* ------------------------------------------------------------ file outbox */

test('the local outbox writes the message to disk and nothing leaves the machine', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mrj-outbox-'))
  try {
    const mailer = new FileMailer(dir)
    const result = await mailer.send({
      to: 'anna@example.com',
      subject: 'Your advance reading is open',
      text: 'link here',
      html: '<p>link here</p>',
      idempotencyKey: 'activation:x:1',
    })

    assert.equal(result.status, 'accepted')
    assert.ok(result.providerId)

    const files = readdirSync(dir)
    assert.equal(files.length, 1)
    const written = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'))
    assert.equal(written.to, 'anna@example.com')
    assert.equal(written.idempotencyKey, 'activation:x:1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ----------------------------------------------------------------- Resend */

type Captured = { url: string; init: RequestInit }

async function withFetch<T>(
  reply: () => Response | Promise<Response> | Promise<never>,
  run: (captured: Captured[]) => Promise<T>,
): Promise<T> {
  const saved = globalThis.fetch
  const captured: Captured[] = []
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    captured.push({ url: String(url), init })
    return reply()
  }) as typeof globalThis.fetch
  try {
    return await run(captured)
  } finally {
    globalThis.fetch = saved
  }
}

const message: MailMessage = {
  to: 'anna@example.com',
  subject: 'Your advance reading is open',
  text: 'link',
  html: '<p>link</p>',
  idempotencyKey: 'activation:abc:2',
}

test('the Resend driver sends the idempotency key, and the key itself goes nowhere else', async () => {
  const saved = process.env.EMAIL_FROM
  process.env.EMAIL_FROM = 'Mike <review@example.test>'
  try {
    await withFetch(
      () => new Response(JSON.stringify({ id: 'resend-123' }), { status: 200 }),
      async (captured) => {
        const result = await new ResendMailer('secret-key-value').send(message)

        assert.equal(result.status, 'accepted')
        assert.equal(result.providerId, 'resend-123')

        assert.equal(captured.length, 1)
        assert.equal(captured[0].url, 'https://api.resend.com/emails')

        const headers = captured[0].init.headers as Record<string, string>
        assert.equal(headers['idempotency-key'], 'activation:abc:2')
        assert.equal(headers.authorization, 'Bearer secret-key-value')

        // The credential goes to the mail service and to nowhere else: not into
        // the result, not into an error string, not into a provider id.
        assert.ok(!JSON.stringify(result).includes('secret-key-value'))
      },
    )
  } finally {
    if (saved === undefined) delete process.env.EMAIL_FROM
    else process.env.EMAIL_FROM = saved
  }
})

test('an answer is mapped onto an honest outcome, and never onto "delivered"', async () => {
  const saved = process.env.EMAIL_FROM
  process.env.EMAIL_FROM = 'Mike <review@example.test>'
  try {
    const cases: [number, string][] = [
      [200, 'accepted'],
      /*
       * These four are the cases where the service was reached and did not say
       * no, so the message may well have been taken. They used to be reported
       * as `unreachable`, which reads as "it did not go" -- and it might have.
       * `uncertain` is the honest word, and it is what the dashboard now shows.
       */
      [409, 'uncertain'],
      [429, 'uncertain'],
      [500, 'uncertain'],
      [503, 'uncertain'],
      [422, 'refused'],
      [403, 'refused'],
    ]

    for (const [status, expected] of cases) {
      await withFetch(
        () => new Response(status === 200 ? '{"id":"x"}' : 'nope', { status }),
        async () => {
          const result = await new ResendMailer('k').send(message)
          assert.equal(result.status, expected, `HTTP ${status} is ${expected}`)
          if (result.status !== 'accepted') {
            assert.ok(!/nope/.test(String(result.error)), 'the body is never echoed back')
          }
        },
      )
    }
  } finally {
    if (saved === undefined) delete process.env.EMAIL_FROM
    else process.env.EMAIL_FROM = saved
  }
})

test('a network failure is uncertain, not a refusal and not a proven non-send', async () => {
  const saved = process.env.EMAIL_FROM
  process.env.EMAIL_FROM = 'Mike <review@example.test>'
  try {
    await withFetch(
      () => Promise.reject(new Error('socket hang up')),
      async () => {
        const result = await new ResendMailer('k').send(message)
        // Not `unreachable`: the request may have been received and acted on
        // before the connection broke, and this cannot tell from here.
        assert.equal(result.status, 'uncertain')
        assert.equal(result.error, 'network')
      },
    )
  } finally {
    if (saved === undefined) delete process.env.EMAIL_FROM
    else process.env.EMAIL_FROM = saved
  }
})

test('with no sender configured the Resend driver refuses rather than guessing one', async () => {
  const saved = process.env.EMAIL_FROM
  delete process.env.EMAIL_FROM
  try {
    const result = await new ResendMailer('k').send(message)
    assert.equal(result.status, 'not-configured')
    assert.equal(result.error, 'no_email_from')
  } finally {
    if (saved !== undefined) process.env.EMAIL_FROM = saved
  }
})
