import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { FileSystemPrivateStore } from '../lib/private-store.ts'
import { __resetRosterStore } from '../lib/reviewer-roster.ts'
import type { MailMessage, MailResult, Mailer } from '../lib/mailer.ts'
import { authorAlertKey } from '../lib/mail-messages.ts'
import { declineRequest, removeDeclinedRequest, submitAccessRequest } from '../lib/reviewer-onboarding.ts'
import { MAIL_OPS_ROOT, readMailOperation } from '../lib/mail-operations.ts'
import { listRequests, newNotificationId } from '../lib/reviewer-requests.ts'

/*
 * "Decline, remove, and let the same person apply again."
 *
 * A request's identity is derived from its address on purpose: that is what
 * makes a submission one create-if-absent with nothing to recover. Removing one
 * frees the pathname, so the next request from the same address is created at
 * exactly the same id -- also on purpose.
 *
 * The author's alert was keyed on that id alone, and those two deliberate
 * decisions met in a way nobody had written down. The second request was stored
 * correctly, and its alert carried an idempotency key a durable mail operation
 * already held; `sendMailOperation` answered with the *old* operation's outcome
 * and never called the provider. Mike was recorded as having been told, and had
 * not been. Somebody waiting for an answer waits forever.
 *
 * This is the exact sequence, and what it demands is not subtle: a second
 * provider call, under a second key, recorded as a second durable operation.
 */

const SECRET = 'test-secret-for-alert-identity-only'
const ADMIN = 'mike@example.com'

type Harness = {
  root: string
  store: FileSystemPrivateStore
  sent: MailMessage[]
  mailer: Mailer
}

function harness(result: MailResult = { status: 'accepted', providerId: 'm1', error: null }): Harness {
  const root = mkdtempSync(join(tmpdir(), 'mrj-alert-'))
  const sent: MailMessage[] = []
  return {
    root,
    store: new FileSystemPrivateStore(root),
    sent,
    mailer: {
      driver: 'test',
      async send(message) {
        sent.push(message)
        return result
      },
    },
  }
}

async function withEnv<T>(h: Harness, run: () => Promise<T>): Promise<T> {
  const keys = [
    'REVIEWER_AUTH_SECRET',
    'REVIEWER_ROSTER_DRIVER',
    'REVIEWER_ROSTER_DIR',
    'SITE_ORIGIN',
    'AUTHOR_ALERT_EMAIL',
    'EMAIL_FROM',
  ] as const
  const saved: Record<string, string | undefined> = {}
  for (const key of keys) saved[key] = process.env[key]

  process.env.REVIEWER_AUTH_SECRET = SECRET
  process.env.REVIEWER_ROSTER_DRIVER = 'fs'
  process.env.REVIEWER_ROSTER_DIR = h.root
  process.env.SITE_ORIGIN = 'https://example.test'
  process.env.AUTHOR_ALERT_EMAIL = ADMIN
  process.env.EMAIL_FROM = 'Test <test@example.test>'
  __resetRosterStore()

  try {
    return await run()
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key] as string
    }
    __resetRosterStore()
    rmSync(h.root, { recursive: true, force: true })
  }
}

function deps(h: Harness) {
  return { store: h.store, mailer: h.mailer }
}

async function submitAnna(h: Harness) {
  return submitAccessRequest(
    { name: 'Anna Vasquez', email: 'anna@example.com', message: 'We met at the reading in March.' },
    deps(h),
  )
}

const alerts = (h: Harness) => h.sent.filter((message) => message.idempotencyKey.startsWith('author-alert:'))

/* ------------------------------------------------------- the regression */

test('submit, decline, remove, submit again: the second request alerts Mike too', async () => {
  const h = harness()
  await withEnv(h, async () => {
    /* 1. The first request, and the first alert. */
    const first = await submitAnna(h)
    assert.equal(first.effect, 'request-created')
    assert.equal(alerts(h).length, 1, 'Mike is told about the first one')
    const [firstRecord] = await listRequests(h.store)
    const firstKey = alerts(h)[0].idempotencyKey

    /* 2. Mike declines it and then removes it, freeing the address. */
    await declineRequest({ requestId: firstRecord.id, actor: ADMIN }, deps(h))
    await removeDeclinedRequest({ requestId: firstRecord.id, actor: ADMIN }, deps(h))
    assert.equal((await listRequests(h.store)).length, 0)

    /* 3. The same person applies again, months later. */
    const second = await submitAnna(h)
    assert.equal(second.effect, 'request-created', 'a genuinely new request')
    const [secondRecord] = await listRequests(h.store)

    /* The pathname is reused. That is the design, and it stays. */
    assert.equal(
      secondRecord.id,
      firstRecord.id,
      'the address still decides the pathname, so the current request is still deduplicated',
    )

    /* The occurrence is not. That is the repair. */
    assert.ok(firstRecord.notificationId, 'the first occurrence has an identity')
    assert.ok(secondRecord.notificationId, 'and so does the second')
    assert.notEqual(
      secondRecord.notificationId,
      firstRecord.notificationId,
      'and they are different, which is the whole point',
    )

    /* The provider was called again, under a different key. */
    const secondAlerts = alerts(h)
    assert.equal(secondAlerts.length, 2, 'the provider was invoked a second time')
    const secondKey = secondAlerts[1].idempotencyKey
    assert.notEqual(secondKey, firstKey, 'a distinct mail operation, not a replay of the first')
    assert.equal(secondKey, authorAlertKey(secondRecord))

    /* Two durable operations, not one reused. */
    const firstOp = await readMailOperation(firstKey, h.store)
    const secondOp = await readMailOperation(secondKey, h.store)
    assert.ok(firstOp && secondOp, 'both are recorded')
    assert.equal(firstOp.status, 'accepted')
    assert.equal(secondOp.status, 'accepted')
    assert.equal(secondOp.attempts, 1, 'and the second one really did call the provider once')

    const ops = await h.store.list(`${MAIL_OPS_ROOT}/`)
    assert.equal(ops.length, 2, 'two operations on disk, at two pathnames')

    /* And the second alert is reported to the caller as a real send. */
    assert.equal(second.delivery?.status, 'accepted')
    assert.equal(second.delivery?.providerId, 'm1')
  })
})

test('a repeat submission while the request is still pending is still one alert', async () => {
  const h = harness()
  await withEnv(h, async () => {
    /*
     * The property the address-derived pathname buys, which the repair must not
     * cost: somebody pressing the button twice, or submitting again the next
     * minute, is one request and one alert -- because it is one occurrence.
     */
    await submitAnna(h)
    const repeat = await submitAnna(h)

    assert.equal(repeat.effect, 'request-already-pending')
    assert.equal(alerts(h).length, 1, 'no second message for the same occurrence')
    assert.equal((await listRequests(h.store)).length, 1)
  })
})

test('two occurrences of one address hold two distinct notification identities', async () => {
  const h = harness()
  await withEnv(h, async () => {
    const seen = new Set<string>()
    for (let round = 0; round < 5; round += 1) {
      await submitAnna(h)
      const [record] = await listRequests(h.store)
      assert.ok(record.notificationId)
      seen.add(record.notificationId)
      await declineRequest({ requestId: record.id, actor: ADMIN }, deps(h))
      await removeDeclinedRequest({ requestId: record.id, actor: ADMIN }, deps(h))
    }
    assert.equal(seen.size, 5, 'five occurrences, five identities, one pathname')
    assert.equal(alerts(h).length, 5, 'and five alerts')
  })
})

/* ------------------------------------------------------------ the key */

test('the alert key names the occurrence, and falls back to the id for old records', () => {
  const base = {
    schema: 1 as const,
    id: 'a'.repeat(24),
    createdAt: '2026-09-13T10:00:00.000Z',
    updatedAt: '2026-09-13T10:00:00.000Z',
    name: 'Anna',
    email: 'anna@example.com',
    message: 'hello',
    status: 'pending' as const,
    reviewerId: null,
    books: [],
    decidedAt: null,
    decidedBy: null,
    activation: null,
    delivery: null,
    alertedAt: null,
  }

  const occurrence = newNotificationId()
  assert.match(occurrence, /^[a-f0-9]{24}$/)

  assert.equal(
    authorAlertKey({ ...base, notificationId: occurrence }),
    `author-alert:${base.id}:${occurrence}`,
  )

  /*
   * A record stored before the field existed keeps the key its already-sent
   * alert was built from, so deploying this does not re-send anything.
   */
  assert.equal(authorAlertKey({ ...base, notificationId: null }), `author-alert:${base.id}`)
})
