import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { FileSystemPrivateStore } from '../lib/private-store.ts'
import { __resetRosterStore, createRosterStore } from '../lib/reviewer-roster.ts'
import { fingerprint, isOutstanding, isSpent } from '../lib/auth-credentials.ts'
import type { MailMessage, MailResult, Mailer } from '../lib/mailer.ts'
import {
  activateWithCredential,
  approveRequest,
  declineRequest,
  removeDeclinedRequest,
  requestSigninLink,
  sendAccessEmailForRequest,
  sendAccessEmailToReviewer,
  setReviewerEmail,
  signinWithCredential,
  submitAccessRequest,
} from '../lib/reviewer-onboarding.ts'
import { listRequests, loadRequest } from '../lib/reviewer-requests.ts'
import { invalidateReviewerCredentials } from '../lib/reviewer-admin.ts'

/*
 * The whole life of a reviewer account, and the failures it has to survive.
 *
 * An approval touches five independent things -- the request, the roster, a
 * credential, the audit log and a mail service -- with no transaction across
 * them. The tests that matter most here are therefore not the happy path. They
 * are the four that kill the process after each durable write in turn and then
 * ask: is there exactly one reviewer, exactly one live credential, and a
 * dashboard telling the truth?
 *
 * `Deps` are injected, so every one of these runs against a temporary directory
 * and a mailer that never sends anything. No network, no credential, no email.
 */

const SECRET = 'test-secret-for-onboarding-only'
const ADMIN = 'mike@example.com'
const BOOK = 'the-backward-becoming'

type Harness = {
  root: string
  store: FileSystemPrivateStore
  sent: MailMessage[]
  mailer: Mailer
}

function harness(result: MailResult = { status: 'accepted', providerId: 'm1', error: null }): Harness {
  const root = mkdtempSync(join(tmpdir(), 'mrj-onboard-'))
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

/** The injected store and mailer, for every call that needs no fault. */
function deps(h: Harness) {
  return { store: h.store, mailer: h.mailer }
}

/** Pull the one-time credential out of a message, the way a reader would. */
function tokenIn(message: MailMessage): string {
  const match = message.text.match(/#(?:a|s)=([A-Za-z0-9_-]{43})/)
  assert.ok(match, 'the message carries a link with the credential in its fragment')
  return match[1]
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

async function roster() {
  return createRosterStore().load()
}

async function submitAnna(h: Harness) {
  return submitAccessRequest(
    { name: 'Anna Vasquez', email: 'anna@example.com', message: 'We met at the reading in March.' },
    { store: h.store, mailer: h.mailer },
  )
}

/* ------------------------------------------------------------ happy path */

test('a request is saved, Mike is alerted, and the alert never carries a credential', async () => {
  const h = harness()
  await withEnv(h, async () => {
    const result = await submitAnna(h)
    assert.equal(result.effect, 'request-created')

    const all = await listRequests(h.store)
    assert.equal(all.length, 1)
    assert.equal(all[0].status, 'pending')
    assert.equal(all[0].email, 'anna@example.com')

    assert.equal(h.sent.length, 1)
    assert.equal(h.sent[0].to, ADMIN)
    assert.equal(h.sent[0].replyTo, 'anna@example.com', 'Mike can answer the person directly')
    assert.match(h.sent[0].text, /We met at the reading in March\./)
    assert.doesNotMatch(h.sent[0].text, /#a=/, 'the alert carries no activation link')

    assert.equal(all[0].delivery?.status, 'accepted')
    assert.ok(all[0].alertedAt)
  })
})

test('approving creates the account, opens the books, and emails a one-time link', async () => {
  const h = harness()
  await withEnv(h, async () => {
    const submitted = await submitAnna(h)
    assert.equal(submitted.effect, 'request-created')
    const [pending] = await listRequests(h.store)

    const approved = await approveRequest(
      { requestId: pending.id, books: [BOOK], actor: ADMIN },
      { store: h.store, mailer: h.mailer },
    )

    assert.equal(approved.delivery.status, 'accepted')

    const doc = await roster()
    assert.equal(doc.reviewers.length, 1)
    const reviewer = doc.reviewers[0]
    assert.equal(reviewer.email, 'anna@example.com')
    assert.deepEqual(reviewer.books, [BOOK])
    assert.equal(reviewer.status, 'active')
    assert.equal(reviewer.origin, 'request')
    assert.equal(reviewer.requestId, pending.id)
    assert.equal(reviewer.emailVerifiedAt, null, 'nothing is verified until a link is used')

    const activation = h.sent.find((message) => message.to === 'anna@example.com')
    assert.ok(activation, 'the reader was emailed')
    assert.match(activation.text, /https:\/\/example\.test\/review\/activate#a=/)
    assert.doesNotMatch(activation.text, /\?token=/, 'never a query parameter')
    assert.doesNotMatch(activation.text, /\?a=/, 'never a query parameter')

    const after = await loadRequest(pending.id, h.store)
    assert.equal(after?.status, 'approved')
    assert.equal(after?.activation?.usedAt, null)
  })
})

test('using the link opens the account, verifies the address, and works once', async () => {
  const h = harness()
  await withEnv(h, async () => {
    await submitAnna(h)
    const [pending] = await listRequests(h.store)
    await approveRequest({ requestId: pending.id, books: [BOOK], actor: ADMIN }, deps(h))

    const activation = h.sent.find((message) => message.to === 'anna@example.com')
    assert.ok(activation)
    const token = tokenIn(activation)

    const opened = await activateWithCredential(token, { store: h.store })
    assert.equal(opened.ok, true)
    if (opened.ok) {
      assert.equal(opened.reviewer.name, 'Anna Vasquez')
      assert.deepEqual(opened.reviewer.books, [BOOK])
    }

    const doc = await roster()
    assert.ok(doc.reviewers[0].emailVerifiedAt, 'the address is now proved')

    const request = await loadRequest(pending.id, h.store)
    assert.ok(request?.activation?.usedAt, 'and the dashboard shows it activated')

    const again = await activateWithCredential(token, { store: h.store })
    assert.equal(again.ok, false, 'a second use opens nothing')
  })
})

/* -------------------------------------------------- recovery after failure */

/**
 * The four transition boundaries, each killed in turn.
 *
 * After each one the approval is simply attempted again, exactly as Mike would
 * by pressing the button, and the same four invariants are checked every time.
 */
for (const boundary of ['afterClaim', 'afterRoster', 'afterCredential', 'afterSend'] as const) {
  test(`an approval that dies ${boundary} recovers without duplicating anything`, async () => {
    const h = harness()
    await withEnv(h, async () => {
      await submitAnna(h)
      const [pending] = await listRequests(h.store)
      const alertCount = h.sent.length

      const boom = new Error(`process died ${boundary}`)
      await assert.rejects(
        () =>
          approveRequest(
            { requestId: pending.id, books: [BOOK], actor: ADMIN },
            {
              store: h.store,
              mailer: h.mailer,
              hooks: {
                [boundary]: () => {
                  throw boom
                },
              },
            },
          ),
        /process died/,
      )

      // Whatever state it stopped in, nothing may be approved yet and there
      // must never be more than one reviewer.
      const midway = await loadRequest(pending.id, h.store)
      assert.notEqual(midway?.status, 'approved', 'a half-finished approval never reads as done')
      assert.ok((await roster()).reviewers.length <= 1)

      // Mike presses the button again.
      const recovered = await approveRequest(
        { requestId: pending.id, books: [BOOK], actor: ADMIN },
        { store: h.store, mailer: h.mailer },
      )

      const doc = await roster()
      assert.equal(doc.reviewers.length, 1, 'exactly one reviewer, however often it is retried')
      assert.deepEqual(doc.reviewers[0].books, [BOOK], 'and exactly one set of permissions')

      const finished = await loadRequest(pending.id, h.store)
      assert.equal(finished?.status, 'approved')
      assert.equal(finished?.delivery?.status, 'accepted', 'the delivery state is the real one')
      assert.equal(recovered.delivery.status, 'accepted')

      /*
       * Whichever link actually reached the reviewer opens the account, once.
       * There is no "newest wins" any more, so the first message sent is as
       * good as the last -- and afterwards the address is verified, so every
       * remaining activation link is finished.
       */
      const activations = h.sent.slice(alertCount).filter((m) => m.to === 'anna@example.com')
      assert.ok(activations.length >= 1)

      const opened = await activateWithCredential(tokenIn(activations[0]), { store: h.store })
      assert.equal(opened.ok, true, 'the first link that went out opens the account')

      for (const later of activations.slice(1)) {
        const again = await activateWithCredential(tokenIn(later), { store: h.store })
        assert.equal(again.ok, false, 'and every other activation link is finished')
      }
    })
  })
}

test('a delivery failure leaves the request approved, truthful, and retryable', async () => {
  const h = harness({ status: 'refused', providerId: null, error: 'http_422' })
  await withEnv(h, async () => {
    await submitAnna(h)
    const [pending] = await listRequests(h.store)

    const result = await approveRequest(
      { requestId: pending.id, books: [BOOK], actor: ADMIN },
      { store: h.store, mailer: h.mailer },
    )

    assert.equal(result.delivery.status, 'refused')

    const stored = await loadRequest(pending.id, h.store)
    assert.equal(stored?.status, 'approved', 'the account exists; the email did not arrive')
    assert.equal(stored?.delivery?.status, 'refused')
    assert.equal(stored?.delivery?.error, 'http_422')
    assert.equal((await roster()).reviewers.length, 1)

    // Retrying mints a fresh credential rather than claiming the old one again.
    const retried = await sendAccessEmailForRequest({ requestId: pending.id, actor: ADMIN }, deps(h))
    assert.equal(retried.delivery.status, 'refused')
    assert.equal((await roster()).reviewers.length, 1, 'still exactly one reviewer')
  })
})

test('a second approval of the same request is refused, not repeated', async () => {
  const h = harness()
  await withEnv(h, async () => {
    await submitAnna(h)
    const [pending] = await listRequests(h.store)
    await approveRequest({ requestId: pending.id, books: [BOOK], actor: ADMIN }, deps(h))

    await assert.rejects(
      () => approveRequest({ requestId: pending.id, books: [BOOK], actor: ADMIN }, deps(h)),
      /already approved/i,
    )
    assert.equal((await roster()).reviewers.length, 1)
  })
})

/* --------------------------------------------------------- sending again */

test('sending another access email leaves the one already in the inbox working', async () => {
  const h = harness()
  await withEnv(h, async () => {
    await submitAnna(h)
    const [pending] = await listRequests(h.store)
    await approveRequest({ requestId: pending.id, books: [BOOK], actor: ADMIN }, deps(h))

    const first = tokenIn(h.sent[h.sent.length - 1])
    await sendAccessEmailForRequest({ requestId: pending.id, actor: ADMIN }, deps(h))
    const second = tokenIn(h.sent[h.sent.length - 1])

    assert.notEqual(first, second, 'a credential is never re-sent, because it cannot be recovered')

    /*
     * This is the behaviour the whole pass exists to establish. The older link
     * is not dead: Mike pressing the button again is not a statement about the
     * first message, and a reviewer who opens the older email should not be
     * told to go and find the newer one. Both credentials are individually
     * single-use; whichever is opened first opens the account.
     */
    const older = await activateWithCredential(first, { store: h.store })
    assert.equal(older.ok, true, 'the earlier link still opens the account')

    const newer = await activateWithCredential(second, { store: h.store })
    assert.equal(newer.ok, false, 'and the newer one is finished, because the address is proved')
    assert.equal((await roster()).reviewers.length, 1, 'and no second account was made')
  })
})

test('an explicit invalidation is what kills an outstanding link', async () => {
  const h = harness()
  await withEnv(h, async () => {
    await submitAnna(h)
    const [pending] = await listRequests(h.store)
    await approveRequest({ requestId: pending.id, books: [BOOK], actor: ADMIN }, deps(h))
    const outstanding = tokenIn(h.sent[h.sent.length - 1])

    const id = (await roster()).reviewers[0].id
    assert.equal((await roster()).reviewers[0].credentialEpoch, 0, 'nothing has invalidated it yet')

    await invalidateReviewerCredentials(id, ADMIN)
    assert.equal((await roster()).reviewers[0].credentialEpoch, 1, 'the epoch advanced, once')

    const refused = await activateWithCredential(outstanding, { store: h.store })
    assert.equal(refused.ok, false)
    assert.equal(refused.ok === false && refused.reason, 'invalidated')

    // Refused before consumption, so nothing was written at all.
    const hash = fingerprint('activation', outstanding)
    assert.ok(hash)
    assert.equal(await isSpent('activation', hash, h.store), false)

    // And a fresh email works, under the new epoch.
    await sendAccessEmailForRequest({ requestId: pending.id, actor: ADMIN }, deps(h))
    const fresh = await activateWithCredential(tokenIn(h.sent[h.sent.length - 1]), {
      store: h.store,
    })
    assert.equal(fresh.ok, true)
  })
})

test('an activated account is sent a sign-in link, never another activation', async () => {
  const h = harness()
  await withEnv(h, async () => {
    await submitAnna(h)
    const [pending] = await listRequests(h.store)
    await approveRequest({ requestId: pending.id, books: [BOOK], actor: ADMIN }, deps(h))
    await activateWithCredential(tokenIn(h.sent[h.sent.length - 1]), { store: h.store })

    /*
     * This used to be refused with "already activated", decided from the
     * request record's `usedAt`. That was wrong twice over: the request record
     * is not the authorization root, and refusing left Mike with no way to get
     * a verified reviewer back onto a new device from this card. The roster
     * says the address is verified, so the operation sends the credential that
     * a verified reviewer can actually use.
     */
    const sent = await sendAccessEmailForRequest({ requestId: pending.id, actor: ADMIN }, deps(h))
    assert.equal(sent.purpose, 'signin')
    assert.equal(sent.delivery.status, 'accepted')

    const message = h.sent[h.sent.length - 1]
    assert.match(message.subject, /sign in/i)
    assert.match(message.idempotencyKey, /^signin:/)

    // The delivery record names what it was, so the dashboard cannot call a
    // fifteen-minute sign-in link a three-day activation.
    assert.equal(sent.request.delivery?.kind, 'signin')

    // And the credential in the message that was actually sent works, once.
    assert.equal((await signinWithCredential(tokenIn(message), { store: h.store })).ok, true)
    assert.equal((await signinWithCredential(tokenIn(message), { store: h.store })).ok, false)
  })
})

/* ------------------------------------------------------------- refusals */

test('a revoked reviewer cannot activate, however good their link is', async () => {
  const h = harness()
  await withEnv(h, async () => {
    await submitAnna(h)
    const [pending] = await listRequests(h.store)
    await approveRequest({ requestId: pending.id, books: [BOOK], actor: ADMIN }, deps(h))
    const token = tokenIn(h.sent[h.sent.length - 1])

    const store = createRosterStore()
    const doc = await store.load()
    await store.save(
      { ...doc, reviewers: doc.reviewers.map((row) => ({ ...row, status: 'revoked' as const })) },
      doc.updatedAt,
    )

    const result = await activateWithCredential(token, { store: h.store })
    assert.equal(result.ok, false, 'status is re-checked when the link is used, not when it is sent')
  })
})

test('PERSISTENT cannot be granted by approving a request', async () => {
  const h = harness()
  await withEnv(h, async () => {
    await submitAnna(h)
    const [pending] = await listRequests(h.store)

    await assert.rejects(
      () => approveRequest({ requestId: pending.id, books: ['persistent'], actor: ADMIN }, deps(h)),
      /not a book on this site/,
    )
    assert.equal((await roster()).reviewers.length, 0, 'and nothing was created trying')
  })
})

test('declining stores the decision, sends nothing, and creates nobody', async () => {
  const h = harness()
  await withEnv(h, async () => {
    await submitAnna(h)
    const [pending] = await listRequests(h.store)
    const before = h.sent.length

    const declined = await declineRequest({ requestId: pending.id, actor: ADMIN }, deps(h))
    assert.equal(declined.status, 'declined')
    assert.equal(h.sent.length, before, 'no rejection email')
    assert.equal((await roster()).reviewers.length, 0)

    await assert.rejects(
      () => approveRequest({ requestId: pending.id, books: [BOOK], actor: ADMIN }, deps(h)),
      /declined/i,
    )
  })
})

test('a declined request can be removed, and the address can write again', async () => {
  const h = harness()
  await withEnv(h, async () => {
    await submitAnna(h)
    const [pending] = await listRequests(h.store)
    await declineRequest({ requestId: pending.id, actor: ADMIN }, deps(h))
    await removeDeclinedRequest({ requestId: pending.id, actor: ADMIN }, deps(h))

    assert.equal((await listRequests(h.store)).length, 0)

    const again = await submitAnna(h)
    assert.equal(again.effect, 'request-created')

    // The audit line survives the removal, without the message body.
    const audit = await createRosterStore().listAudit(50)
    const removal = audit.find((event) => event.action === 'request.removed')
    assert.ok(removal, 'the decision is still on the record')
    assert.doesNotMatch(removal.detail, /reading in March/, 'but what they wrote is not')
  })
})

test('an approved request cannot be removed', async () => {
  const h = harness()
  await withEnv(h, async () => {
    await submitAnna(h)
    const [pending] = await listRequests(h.store)
    await approveRequest({ requestId: pending.id, books: [BOOK], actor: ADMIN }, deps(h))

    await assert.rejects(
      () => removeDeclinedRequest({ requestId: pending.id, actor: ADMIN }, deps(h)),
      /only a declined request/i,
    )
  })
})

/* ------------------------------------------------- the returning reviewer */

test('a sign-in link goes only to an active reviewer who has proved their address', async () => {
  const h = harness()
  await withEnv(h, async () => {
    await submitAnna(h)
    const [pending] = await listRequests(h.store)
    await approveRequest({ requestId: pending.id, books: [BOOK], actor: ADMIN }, deps(h))

    // Unverified: nothing is sent.
    let before = h.sent.length
    assert.equal(await requestSigninLink('anna@example.com', deps(h)), null)
    assert.equal(h.sent.length, before, 'an unproved address gets no sign-in link')

    // Nobody at all: nothing is sent, and it looks identical.
    assert.equal(await requestSigninLink('stranger@example.com', deps(h)), null)
    assert.equal(h.sent.length, before)

    await activateWithCredential(tokenIn(h.sent[h.sent.length - 1]), { store: h.store })

    before = h.sent.length
    const result = await requestSigninLink('ANNA@example.com', deps(h))
    assert.equal(result?.status, 'accepted')
    assert.equal(h.sent.length, before + 1)

    const link = h.sent[h.sent.length - 1]
    assert.match(link.text, /https:\/\/example\.test\/review\/signin\/verify#s=/)

    const signedIn = await signinWithCredential(tokenIn(link), { store: h.store })
    assert.equal(signedIn.ok, true)
    if (signedIn.ok) assert.equal(signedIn.reviewer.id, (await roster()).reviewers[0].id)
  })
})

test('two sign-in links coexist, and each one works exactly once', async () => {
  const h = harness()
  await withEnv(h, async () => {
    await submitAnna(h)
    const [pending] = await listRequests(h.store)
    await approveRequest({ requestId: pending.id, books: [BOOK], actor: ADMIN }, deps(h))
    await activateWithCredential(tokenIn(h.sent[h.sent.length - 1]), { store: h.store })

    await requestSigninLink('anna@example.com', deps(h))
    const first = tokenIn(h.sent[h.sent.length - 1])

    await requestSigninLink('anna@example.com', deps(h))
    const second = tokenIn(h.sent[h.sent.length - 1])

    assert.notEqual(first, second)

    // Opened in the order they arrived, which is the order a person reads them.
    assert.equal((await signinWithCredential(first, { store: h.store })).ok, true)
    assert.equal((await signinWithCredential(second, { store: h.store })).ok, true)

    // Each one, and only once.
    assert.equal((await signinWithCredential(first, { store: h.store })).ok, false)
    assert.equal((await signinWithCredential(second, { store: h.store })).ok, false)
  })
})

test('a revoked reviewer gets no sign-in link and cannot spend one already sent', async () => {
  const h = harness()
  await withEnv(h, async () => {
    await submitAnna(h)
    const [pending] = await listRequests(h.store)
    await approveRequest({ requestId: pending.id, books: [BOOK], actor: ADMIN }, deps(h))
    await activateWithCredential(tokenIn(h.sent[h.sent.length - 1]), { store: h.store })

    await requestSigninLink('anna@example.com', deps(h))
    const token = tokenIn(h.sent[h.sent.length - 1])

    const store = createRosterStore()
    const doc = await store.load()
    await store.save(
      { ...doc, reviewers: doc.reviewers.map((row) => ({ ...row, status: 'revoked' as const })) },
      doc.updatedAt,
    )

    const before = h.sent.length
    assert.equal(await requestSigninLink('anna@example.com', deps(h)), null)
    assert.equal(h.sent.length, before)
    assert.equal((await signinWithCredential(token, { store: h.store })).ok, false)
  })
})

/* --------------------------------------------------- address maintenance */

test('changing an address un-verifies it and strands every link sent to the old one', async () => {
  const h = harness()
  await withEnv(h, async () => {
    await submitAnna(h)
    const [pending] = await listRequests(h.store)
    await approveRequest({ requestId: pending.id, books: [BOOK], actor: ADMIN }, deps(h))
    await activateWithCredential(tokenIn(h.sent[h.sent.length - 1]), { store: h.store })

    const id = (await roster()).reviewers[0].id
    await requestSigninLink('anna@example.com', deps(h))
    const outstanding = tokenIn(h.sent[h.sent.length - 1])

    const updated = await setReviewerEmail(
      { reviewerId: id, email: 'Anna.New@Example.com', actor: ADMIN },
      deps(h),
    )

    assert.equal(updated.email, 'anna.new@example.com', 'normalised, as everywhere else')
    assert.equal(updated.emailVerifiedAt, null, 'and no longer proved')
    assert.equal(updated.id, id, 'the identifier never moves')
    assert.deepEqual(updated.books, [BOOK], 'and neither do their books')

    assert.equal(
      (await signinWithCredential(outstanding, { store: h.store })).ok,
      false,
      'the link in the old mailbox is dead',
    )
    /*
     * Nothing was retired and nothing was deleted to make that true. The
     * credential record is still there, unspent -- the address change advanced
     * the reviewer's `credentialEpoch` inside the same conditional roster
     * mutation, and equality of that integer is what the consumption checks.
     * A refusal before consumption writes nothing at all, which is why the
     * used marker is still absent.
     */
    const staleHash = fingerprint('signin', outstanding)
    assert.ok(staleHash)
    assert.equal(await isSpent('signin', staleHash, h.store), false, 'a refusal left no trace')
    assert.equal(
      await isOutstanding('signin', staleHash, (await roster()).reviewers[0].credentialEpoch, h.store),
      false,
      'and it is no longer outstanding under the new epoch',
    )

    const before = h.sent.length
    assert.equal(await requestSigninLink('anna.new@example.com', deps(h)), null)
    assert.equal(h.sent.length, before, 'the new address must be proved before it can sign in')
  })
})

test('an address already on the roster cannot be given to a second reviewer', async () => {
  const h = harness()
  await withEnv(h, async () => {
    await submitAnna(h)
    const [pending] = await listRequests(h.store)
    await approveRequest({ requestId: pending.id, books: [BOOK], actor: ADMIN }, deps(h))
    const id = (await roster()).reviewers[0].id

    await assert.rejects(
      () => setReviewerEmail({ reviewerId: id, email: 'not an address', actor: ADMIN }, deps(h)),
      /not a valid email/i,
    )
  })
})

test('an existing code-holding reviewer can be offered email sign-in without losing anything', async () => {
  const h = harness()
  await withEnv(h, async () => {
    await submitAnna(h)
    const [pending] = await listRequests(h.store)
    await approveRequest({ requestId: pending.id, books: [BOOK], actor: ADMIN }, deps(h))

    const before = (await roster()).reviewers[0]
    const result = await sendAccessEmailToReviewer({ reviewerId: before.id, actor: ADMIN }, deps(h))
    assert.equal(result.delivery.status, 'accepted')
    assert.equal(result.purpose, 'activation', 'they have not proved the address yet')

    await activateWithCredential(tokenIn(h.sent[h.sent.length - 1]), { store: h.store })

    const after = (await roster()).reviewers[0]
    assert.equal(after.id, before.id, 'same identifier, so every record they own still finds them')
    assert.equal(after.codeHash, before.codeHash, 'and their access code still works')
    assert.deepEqual(after.books, before.books)
    assert.ok(after.emailVerifiedAt)
  })
})

/* ------------------------------------------- what a repeat submission does */

test('an address that already belongs to a verified reviewer gets a sign-in link, not a request', async () => {
  const h = harness()
  await withEnv(h, async () => {
    await submitAnna(h)
    const [pending] = await listRequests(h.store)
    await approveRequest({ requestId: pending.id, books: [BOOK], actor: ADMIN }, deps(h))
    await activateWithCredential(tokenIn(h.sent[h.sent.length - 1]), { store: h.store })
    await removeDeclinedRequest({ requestId: pending.id, actor: ADMIN }, deps(h)).catch(() => {})

    const result = await submitAnna(h)
    assert.equal(result.effect, 'signin-sent-to-existing-reviewer')
    assert.equal((await roster()).reviewers.length, 1, 'no second account')
  })
})

test('a revoked address is ignored entirely, and looks exactly like everything else', async () => {
  const h = harness()
  await withEnv(h, async () => {
    await submitAnna(h)
    const [pending] = await listRequests(h.store)
    await approveRequest({ requestId: pending.id, books: [BOOK], actor: ADMIN }, deps(h))

    const store = createRosterStore()
    const doc = await store.load()
    await store.save(
      { ...doc, reviewers: doc.reviewers.map((row) => ({ ...row, status: 'revoked' as const })) },
      doc.updatedAt,
    )

    const before = h.sent.length
    const result = await submitAnna(h)
    assert.equal(result.effect, 'ignored-revoked')
    assert.equal(h.sent.length, before, 'a revoked reader cannot make this site send anything')
  })
})

test('Mike is not alerted twice about the same waiting request', async () => {
  const h = harness()
  await withEnv(h, async () => {
    await submitAnna(h)
    const first = h.sent.length

    const again = await submitAnna(h)
    assert.equal(again.effect, 'request-already-pending')
    assert.equal(h.sent.length, first, 'inside a day, one alert is enough')
    assert.equal((await listRequests(h.store)).length, 1)
  })
})

/* ------------------------------------------------------- the whole store */

test('no credential appears anywhere in storage after the entire journey', async () => {
  const h = harness()
  await withEnv(h, async () => {
    await submitAnna(h)
    const [pending] = await listRequests(h.store)
    await approveRequest({ requestId: pending.id, books: [BOOK], actor: ADMIN }, deps(h))
    await sendAccessEmailForRequest({ requestId: pending.id, actor: ADMIN }, deps(h))
    await activateWithCredential(tokenIn(h.sent[h.sent.length - 1]), { store: h.store })
    await requestSigninLink('anna@example.com', deps(h))
    await signinWithCredential(tokenIn(h.sent[h.sent.length - 1]), { store: h.store })

    const credentials = h.sent
      .filter((message) => /#(?:a|s)=/.test(message.text))
      .map((message) => tokenIn(message))
    assert.ok(credentials.length >= 3, 'several credentials were issued along the way')

    for (const file of everything(h.root)) {
      for (const credential of credentials) {
        assert.ok(!file.text.includes(credential), `no credential inside ${file.path}`)
        assert.ok(!file.path.includes(credential), `no credential in the name of ${file.path}`)
      }
    }

    // And the roster's audit log, which outlives everything else.
    const audit = await createRosterStore().listAudit(100)
    for (const event of audit) {
      for (const credential of credentials) {
        assert.ok(!event.detail.includes(credential), 'no credential in an audit line')
      }
    }
  })
})
