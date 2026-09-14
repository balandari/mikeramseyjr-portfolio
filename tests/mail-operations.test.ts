import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  FileSystemPrivateStore,
  type CreateOutcome,
  type PrivateStore,
  type VersionedObject,
} from '../lib/private-store.ts'
import { __resetRosterStore, createRosterStore } from '../lib/reviewer-roster.ts'
import { isOutstanding } from '../lib/auth-credentials.ts'
import type { MailMessage, MailResult, Mailer } from '../lib/mailer.ts'
import {
  mailOperationPath,
  readMailOperation,
  sendMailOperation,
} from '../lib/mail-operations.ts'
import {
  activateWithCredential,
  approveRequest,
  sendAccessEmailForRequest,
  submitAccessRequest,
} from '../lib/reviewer-onboarding.ts'
import { listRequests, loadRequest } from '../lib/reviewer-requests.ts'

/*
 * The mail-provider partial-failure window.
 *
 * The interval nobody can observe from inside: a message is handed to Resend,
 * Resend accepts it, and the process dies before the outcome is written down.
 * Afterwards that is indistinguishable from "the send never happened". The
 * previous fault injections all fired *after* the durable delivery record, so
 * none of them covered this, and the approval retry then minted a fresh
 * credential -- and therefore a fresh idempotency key -- on the strength of a
 * response that had merely been lost. The first link was invalidated and a
 * second message could go out.
 *
 * What is claimed now, and tested here:
 *
 *   - one claimed operation makes **at most two** provider calls: the first
 *     attempt, and one re-offer of an uncertain answer with the same message
 *     and the same key. A settled or abandoned operation is never re-offered;
 *   - a retry of an unfinished approval **resumes** that operation: same
 *     credential, same key, no new credential, nothing sent;
 *   - the account is never duplicated;
 *   - the credential that is live stays live and stays usable;
 *   - an earlier credential never becomes current again.
 *
 * What is **not** claimed: exactly-once delivery, and not delivery at all. A
 * refused, unconfigured or permanently uncertain operation may deliver zero
 * messages, which is why this is deliberately not called at-least-once either.
 * What makes the re-offer safe is Resend's own guarantee -- at most one email
 * processed per key and identical payload inside its 24-hour window -- not the
 * number of calls this code makes. The tests at the end of this file pin that
 * language down rather than letting it drift back.
 */

const SECRET = 'test-secret-for-mail-operations'
const ADMIN = 'mike@example.com'
const BOOK = 'the-backward-becoming'

/**
 * A store that stops dead at a named write.
 *
 * A process that dies mid-operation cannot be modelled by making the mail
 * driver throw -- the operation log catches that and records it, which is the
 * opposite of the scenario. What is needed is for a *later* durable write to
 * never happen, so the store is what refuses, at a path the test names.
 */
class CrashingStore implements PrivateStore {
  readonly driver = 'fs'
  readonly writable = true
  readonly provenAtomic = true

  inner: PrivateStore
  /** Once armed, the next write whose path contains this throws, once. */
  crashOnWriteMatching: string | null = null

  constructor(inner: PrivateStore) {
    this.inner = inner
  }

  private check(path: string): void {
    const match = this.crashOnWriteMatching
    if (match !== null && path.includes(match)) {
      this.crashOnWriteMatching = null
      throw new Error(`process died before writing ${path}`)
    }
  }

  read(path: string): Promise<string | null> {
    return this.inner.read(path)
  }

  readVersioned(path: string): Promise<VersionedObject> {
    return this.inner.readVersioned(path)
  }

  async create(path: string, body: string): Promise<CreateOutcome> {
    this.check(path)
    return this.inner.create(path, body)
  }

  async writeIfMatch(path: string, body: string, version: string | null): Promise<boolean> {
    this.check(path)
    return this.inner.writeIfMatch(path, body, version)
  }

  async removeIfMatch(path: string, version: string): Promise<boolean> {
    this.check(path)
    return this.inner.removeIfMatch(path, version)
  }

  list(prefix: string): Promise<string[]> {
    return this.inner.list(prefix)
  }
}

type Harness = {
  root: string
  base: FileSystemPrivateStore
  store: CrashingStore
  sent: MailMessage[]
  mailer: Mailer
  /** Decides what the provider says, per call. */
  answer: (message: MailMessage, callNumber: number) => MailResult
  /**
   * Armed from *inside* the provider call, which is the only way to place the
   * crash in the window this file is about: after the message has been taken,
   * and before the write named here happens. Arming it beforehand would hit an
   * earlier write on the same prefix and model a different failure entirely.
   */
  crashAfterActivationSend: string | null
}

function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'mrj-mailop-'))
  const sent: MailMessage[] = []
  const base = new FileSystemPrivateStore(root)
  const h: Harness = {
    root,
    base,
    store: new CrashingStore(base),
    sent,
    answer: () => ({ status: 'accepted', providerId: 'm1', error: null }),
    crashAfterActivationSend: null,
    mailer: {
      driver: 'test',
      async send(message) {
        sent.push(message)
        const result = h.answer(message, sent.length)
        if (h.crashAfterActivationSend && message.idempotencyKey.startsWith('activation:')) {
          h.store.crashOnWriteMatching = h.crashAfterActivationSend
          h.crashAfterActivationSend = null
        }
        return result
      },
    },
  }
  return h
}

function withEnv<T>(h: Harness, run: () => Promise<T>): Promise<T> {
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

  return (async () => {
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
  })()
}

function deps(h: Harness) {
  return { store: h.store, mailer: h.mailer }
}

function tokenIn(message: MailMessage): string {
  const match = message.text.match(/#(?:a|s)=([A-Za-z0-9_-]{43})/)
  assert.ok(match, 'the message carries a credential in its fragment')
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

async function submitAnna(h: Harness) {
  return submitAccessRequest(
    { name: 'Anna Vasquez', email: 'anna@example.com', message: 'We met at the reading.' },
    deps(h),
  )
}

/** The activation messages only, so the author alert does not confuse a count. */
function activations(h: Harness): MailMessage[] {
  return h.sent.filter((message) => message.idempotencyKey.startsWith('activation:'))
}

/* ------------------------------------------- the operation log, on its own */

test('a settled operation is never re-offered, whatever calls it again', async () => {
  const h = harness()
  await withEnv(h, async () => {
    const message: MailMessage = {
      to: 'anna@example.com',
      subject: 'Once',
      text: 'once',
      html: '<p>once</p>',
      idempotencyKey: 'activation:abc:1',
    }

    const first = await sendMailOperation(h.mailer, message, h.store)
    const second = await sendMailOperation(h.mailer, message, h.store)
    const third = await sendMailOperation(h.mailer, message, h.store)

    assert.equal(h.sent.length, 1, 'the provider saw it once, because it settled at once')
    assert.equal(first.status, 'accepted')
    assert.deepEqual(second, first, 'and every later attempt reads what the first recorded')
    assert.deepEqual(third, first)
  })
})

test('two callers carrying one key cannot both start an operation', async () => {
  const h = harness()
  await withEnv(h, async () => {
    const message: MailMessage = {
      to: 'anna@example.com',
      subject: 'Race',
      text: 'race',
      html: '<p>race</p>',
      idempotencyKey: 'activation:abc:1',
    }

    const results = await Promise.all(
      Array.from({ length: 6 }, () => sendMailOperation(h.mailer, message, h.store)),
    )

    assert.equal(h.sent.length, 1, 'the operation is claimed with create-if-absent')
    for (const result of results) {
      assert.ok(
        result.status === 'accepted' || result.status === 'uncertain',
        'and nobody is told it failed',
      )
    }
  })
})

test('one operation makes at most two provider calls, with one unchanging key', async () => {
  const h = harness()
  await withEnv(h, async () => {
    h.answer = (_message, call) =>
      call === 1
        ? { status: 'uncertain', providerId: null, error: 'http_503' }
        : { status: 'accepted', providerId: 'm2', error: null }

    const message: MailMessage = {
      to: 'anna@example.com',
      subject: 'Retry',
      text: 'retry',
      html: '<p>retry</p>',
      idempotencyKey: 'activation:abc:7',
    }

    const result = await sendMailOperation(h.mailer, message, h.store)

    assert.equal(result.status, 'accepted')
    assert.equal(h.sent.length, 2, 'offered twice')
    assert.equal(
      h.sent[0].idempotencyKey,
      h.sent[1].idempotencyKey,
      'and the key did not change because a response was lost',
    )

    const record = await readMailOperation('activation:abc:7', h.store)
    assert.equal(record?.status, 'accepted')
    assert.equal(record?.attempts, 2, 'two calls, and the cap is two')
  })
})

test('a permanently uncertain operation stops at two calls and delivers nothing', async () => {
  const h = harness()
  await withEnv(h, async () => {
    h.answer = () => ({ status: 'uncertain', providerId: null, error: 'http_503' })

    const result = await sendMailOperation(
      h.mailer,
      {
        to: 'anna@example.com',
        subject: 'Never',
        text: 'never',
        html: '<p>never</p>',
        idempotencyKey: 'activation:abc:11',
      },
      h.store,
    )

    /*
     * The case that makes "at-least-once" the wrong word for overall delivery:
     * this operation may well have delivered nothing at all, and the system
     * says so rather than implying a message is on its way.
     */
    assert.equal(result.status, 'uncertain')
    assert.equal(h.sent.length, 2, 'two calls, then it stops')
    assert.equal((await readMailOperation('activation:abc:11', h.store))?.attempts, 2)
  })
})

test('a provider that stays uncertain settles as uncertain, never as sent or failed', async () => {
  const h = harness()
  await withEnv(h, async () => {
    h.answer = () => ({ status: 'uncertain', providerId: null, error: 'http_503' })

    const message: MailMessage = {
      to: 'anna@example.com',
      subject: 'Unknown',
      text: 'unknown',
      html: '<p>unknown</p>',
      idempotencyKey: 'activation:abc:9',
    }

    const result = await sendMailOperation(h.mailer, message, h.store)
    assert.equal(result.status, 'uncertain')
    assert.equal((await readMailOperation('activation:abc:9', h.store))?.status, 'uncertain')
  })
})

test('an operation left in flight is reported as uncertain, and nothing is sent again', async () => {
  const h = harness()
  await withEnv(h, async () => {
    const key = 'activation:abc:3'
    // Exactly the crash: the record was opened, and never settled.
    await h.store.create(
      mailOperationPath(key),
      `${JSON.stringify({
        schema: 1,
        key,
        status: 'in-flight',
        attempts: 1,
        startedAt: new Date().toISOString(),
        settledAt: null,
        providerId: null,
        error: null,
      })}\n`,
    )

    const result = await sendMailOperation(
      h.mailer,
      {
        to: 'anna@example.com',
        subject: 'After the crash',
        text: 'x',
        html: '<p>x</p>',
        idempotencyKey: key,
      },
      h.store,
    )

    assert.equal(result.status, 'uncertain')
    assert.equal(result.error, 'previous_attempt_unrecorded')
    assert.equal(h.sent.length, 0, 'no second copy of a message that may already have gone')
  })
})

test('the operation log holds no credential, address, link or message body', async () => {
  const h = harness()
  await withEnv(h, async () => {
    await sendMailOperation(
      h.mailer,
      {
        to: 'private.person@example.com',
        subject: 'Your link',
        text: 'https://example.test/review/activate#a=' + 'z'.repeat(43),
        html: '<p>secret</p>',
        idempotencyKey: 'activation:abc:1',
      },
      h.store,
    )

    const log = await h.base.read(mailOperationPath('activation:abc:1'))
    assert.ok(log, 'the operation was recorded')
    assert.ok(!log.includes('private.person@example.com'), 'no address')
    assert.ok(!log.includes('z'.repeat(43)), 'no credential')
    assert.ok(!log.includes('secret'), 'no body')
    assert.ok(log.includes('activation:abc:1'), 'the key, which is not a secret, is there')
  })
})

/* --------------------------- the approval, across the partial-failure window */

test('the provider accepts, the process dies before recording, and a retry resumes it', async () => {
  const h = harness()
  await withEnv(h, async () => {
    await submitAnna(h)
    const [pending] = await listRequests(h.store)

    /*
     * The window the previous fault injections all missed. The provider takes
     * the activation message and answers; the operation log settles; and the
     * process then dies before that answer reaches the request record. From the
     * outside afterwards this is indistinguishable from "no email was sent".
     */
    h.crashAfterActivationSend = `requests/v2/records/${pending.id}`
    await assert.rejects(
      () => approveRequest({ requestId: pending.id, books: [BOOK], actor: ADMIN }, deps(h)),
      /process died/,
    )

    const afterCrash = await loadRequest(pending.id, h.base)
    assert.equal(afterCrash?.status, 'approving', 'the approval is visibly unfinished')
    assert.notEqual(
      afterCrash?.delivery?.kind,
      'activation',
      'and nothing about the activation send was recorded -- only the earlier author alert',
    )

    const sentBefore = activations(h).length
    assert.equal(sentBefore, 1, 'one activation message was handed over')
    const posted = activations(h)[0]

    const reviewerId = afterCrash?.reviewerId
    assert.ok(reviewerId)
    const hashBefore = afterCrash?.activation?.tokenHash
    assert.ok(hashBefore, 'the request names the credential that was minted')
    assert.equal(
      await isOutstanding('activation', hashBefore, 0, h.base),
      true,
      'and the credential it carried is still outstanding',
    )

    /* ---- the retry ------------------------------------------------------ */

    const resumed = await approveRequest(
      { requestId: pending.id, books: [BOOK], actor: ADMIN },
      deps(h),
    )

    assert.equal(
      activations(h).length,
      sentBefore,
      'no second message: the operation was resumed, not restarted',
    )
    assert.equal(
      resumed.delivery.status,
      'accepted',
      'and the answer the provider actually gave is recovered from the operation log',
    )

    // The account is not duplicated.
    const roster = await createRosterStore().load()
    assert.equal(roster.reviewers.length, 1, 'exactly one reviewer')
    assert.equal(roster.reviewers[0].id, reviewerId, 'at the id claimed before the crash')
    assert.deepEqual(roster.reviewers[0].books, [BOOK], 'with one set of entitlements')

    // The correct credential remains usable, and it is the same one.
    const hashAfter = (await loadRequest(pending.id, h.base))?.activation?.tokenHash
    assert.equal(
      hashAfter,
      hashBefore,
      'the same credential, not a replacement minted beside the posted link',
    )
    assert.equal(await isOutstanding('activation', hashBefore, 0, h.base), true)

    const opened = await activateWithCredential(tokenIn(posted), deps(h))
    assert.equal(opened.ok, true, 'and the link that went out still opens the account')

    const settled = await loadRequest(pending.id, h.base)
    assert.equal(settled?.status, 'approved')
  })
})

test('the operation is left in flight, and a retry is honest rather than eager', async () => {
  const h = harness()
  await withEnv(h, async () => {
    await submitAnna(h)
    const [pending] = await listRequests(h.store)

    /*
     * The other half of the window: the provider answered, and the *operation
     * log* never settled. Nobody will ever know whether the message went, so
     * the only correct answer is to say so -- and above all not to send a
     * second copy of a message that may already be in somebody's inbox.
     */
    h.crashAfterActivationSend = 'mail/v2/ops/'
    const first = await approveRequest(
      { requestId: pending.id, books: [BOOK], actor: ADMIN },
      deps(h),
    )

    assert.equal(first.delivery.status, 'uncertain')
    assert.equal(activations(h).length, 1)
    const posted = activations(h)[0]
    const hashBefore = (await loadRequest(pending.id, h.base))?.activation?.tokenHash
    assert.ok(hashBefore)

    const retried = await approveRequest(
      { requestId: pending.id, books: [BOOK], actor: ADMIN },
      deps(h),
    ).catch(() => null)

    // `approveRequest` refuses a second approval of an approved request, which
    // is its own correct behaviour; what matters is that nothing was re-sent.
    assert.equal(activations(h).length, 1, 'still exactly one message')
    if (retried) assert.equal(retried.delivery.status, 'uncertain')

    const hashAfter = (await loadRequest(pending.id, h.base))?.activation?.tokenHash
    assert.equal(hashAfter, hashBefore, 'the same credential, still outstanding')
    assert.equal(await isOutstanding('activation', hashBefore, 0, h.base), true)
    assert.equal((await createRosterStore().load()).reviewers.length, 1, 'one reviewer')
    assert.equal(
      (await activateWithCredential(tokenIn(posted), deps(h))).ok,
      true,
      'and the link that went out still opens the account',
    )
  })
})

test('an uncertain provider answer does not duplicate the account or the credential', async () => {
  const h = harness()
  await withEnv(h, async () => {
    h.answer = (message) =>
      message.idempotencyKey.startsWith('activation:')
        ? { status: 'uncertain', providerId: null, error: 'concurrent_idempotent_request' }
        : { status: 'accepted', providerId: 'm0', error: null }

    await submitAnna(h)
    const [pending] = await listRequests(h.store)

    const first = await approveRequest(
      { requestId: pending.id, books: [BOOK], actor: ADMIN },
      deps(h),
    )
    assert.equal(first.delivery.status, 'uncertain')

    const hashBefore = (await loadRequest(pending.id, h.base))?.activation?.tokenHash
    assert.ok(hashBefore)
    const afterFirst = activations(h).length

    // Mike presses the button again, because the dashboard told him the truth
    // and the truth was "nobody knows".
    const retried = await sendAccessEmailForRequest({ requestId: pending.id, actor: ADMIN }, deps(h))

    const roster = await createRosterStore().load()
    assert.equal(roster.reviewers.length, 1, 'still exactly one reviewer')

    /*
     * "Send a new access email" is Mike saying the first one is not coming, so
     * it does mint a new credential and does send again. What changed with the
     * pointerless design is what happens to the first one: it stays valid.
     * Whichever link the reviewer actually opens works, once. That is the
     * opposite of the old behaviour, and it is the point of the change.
     */
    assert.ok(activations(h).length > afterFirst, 'a new email genuinely goes out')
    assert.equal(retried.delivery.status, 'uncertain')

    const hashAfter = (await loadRequest(pending.id, h.base))?.activation?.tokenHash
    assert.notEqual(hashAfter, hashBefore, 'a genuinely new credential was minted')
    assert.equal(
      await isOutstanding('activation', hashBefore, 0, h.base),
      true,
      'and the earlier one is still outstanding, not killed by the newer send',
    )

    const newest = activations(h)[activations(h).length - 1]
    const older = activations(h)[afterFirst - 1]

    assert.equal(
      (await activateWithCredential(tokenIn(older), deps(h))).ok,
      true,
      'the earlier link opens the account',
    )
    assert.equal(
      (await activateWithCredential(tokenIn(newest), deps(h))).ok,
      false,
      'and once the address is verified, the newer activation link is finished too',
    )
  })
})

test('a retry after an unrecorded send never resurrects an earlier credential', async () => {
  const h = harness()
  await withEnv(h, async () => {
    await submitAnna(h)
    const [pending] = await listRequests(h.store)

    await approveRequest({ requestId: pending.id, books: [BOOK], actor: ADMIN }, deps(h))
    const firstLink = activations(h)[0]
    const reviewerId = (await loadRequest(pending.id, h.base))?.reviewerId
    assert.ok(reviewerId)

    // A new email replaces the first, and the record of *that* send is lost:
    // the provider took it, and the process died before the request knew.
    h.crashAfterActivationSend = `requests/v2/records/${pending.id}`
    await assert.rejects(
      () => sendAccessEmailForRequest({ requestId: pending.id, actor: ADMIN }, deps(h)),
      /process died/,
    )
    const secondLink = activations(h)[activations(h).length - 1]
    assert.notEqual(tokenIn(firstLink), tokenIn(secondLink))

    /*
     * Mike, seeing nothing recorded, presses the button again. This is the
     * at-least-once boundary in the open: a third message goes out, because the
     * second one's plaintext no longer exists anywhere and cannot be re-sent.
     * What must hold is the ordering -- the newest wins, and nothing older ever
     * comes back to life.
     */
    const third = await sendAccessEmailForRequest({ requestId: pending.id, actor: ADMIN }, deps(h))
    const thirdLink = activations(h)[activations(h).length - 1]
    assert.notEqual(tokenIn(secondLink), tokenIn(thirdLink))
    assert.equal(third.delivery.status, 'accepted')

    /*
     * Three credentials now exist, all unexpired and all unused, and every one
     * of them would work -- once. The first one opens the account; the other
     * two are then refused, not because they were superseded but because the
     * address is verified and an activation credential is finished at that
     * point. That is the activation rule, and it is what stops an unused
     * activation link from living on as a three-day sign-in link.
     */
    assert.equal(
      (await activateWithCredential(tokenIn(firstLink), deps(h))).ok,
      true,
      'the first credential still opens the account',
    )
    for (const [label, message] of [
      ['the second', secondLink],
      ['the third', thirdLink],
    ] as const) {
      assert.equal(
        (await activateWithCredential(tokenIn(message), deps(h))).ok,
        false,
        `${label} is refused once the address is verified`,
      )
    }
    assert.equal(
      (await createRosterStore().load()).reviewers.length,
      1,
      'through all of which the account was never duplicated',
    )
  })
})

test('no credential reaches the operation log, over a whole approval and its retry', async () => {
  const h = harness()
  await withEnv(h, async () => {
    await submitAnna(h)
    const [pending] = await listRequests(h.store)

    h.crashAfterActivationSend = `requests/v2/records/${pending.id}`
    await assert.rejects(
      () => approveRequest({ requestId: pending.id, books: [BOOK], actor: ADMIN }, deps(h)),
      /process died/,
    )
    await approveRequest({ requestId: pending.id, books: [BOOK], actor: ADMIN }, deps(h))

    const issued = h.sent.filter((message) => /#(?:a|s)=/.test(message.text)).map(tokenIn)
    assert.ok(issued.length >= 1)

    for (const file of everything(h.root)) {
      for (const token of issued) {
        assert.ok(!file.text.includes(token), `no credential in ${file.path}`)
        assert.ok(!file.path.includes(token), 'and none in a pathname')
      }
    }
  })
})

/* ------------------------------------------------ the honest claim, tested */

test('the mail guarantee is stated accurately and does not drift back', () => {
  /*
   * Deliberately a test rather than a comment. Three claims were wrong at one
   * point or another -- "exactly-once", "at most one message reaches the
   * provider", and "at-least-once" -- and wording is exactly the kind of thing
   * a later edit restores without noticing. So the real statements are asserted
   * and the retracted ones are forbidden.
   */
  const mailer = readFileSync(join(process.cwd(), 'lib', 'mailer.ts'), 'utf8')
  const operations = readFileSync(join(process.cwd(), 'lib', 'mail-operations.ts'), 'utf8')
  const docs = readFileSync(join(process.cwd(), 'docs', 'author-reader.md'), 'utf8')
  const sources = [
    ['lib/mailer.ts', mailer],
    ['lib/mail-operations.ts', operations],
    ['docs/author-reader.md', docs],
  ] as const

  /*
   * These are wrapped comments and prose, so a line break is not a sentence
   * boundary: splitting on one tears a denial off the claim it denies. Unwrap
   * first -- dropping the leading comment asterisks -- then split on sentences.
   */
  const sentences = (source: string) =>
    source.replace(/\s*\n\s*\*?\s*/g, ' ').split(/(?<=\.)\s+/)

  const denies = /\bno\b|\bnot\b|\bnothing\b|\bnever\b|\bneither\b|without|deliberately/i

  for (const [name, source] of sources) {
    // Every mention of exactly-once must be a denial of it.
    for (const sentence of sentences(source)) {
      if (!/exactly[- ]once/i.test(sentence)) continue
      assert.ok(
        denies.test(sentence),
        `${name} must not claim exactly-once delivery: ${sentence.trim().slice(0, 80)}`,
      )
    }

    // "at-least-once" is retracted outright: zero messages is a real outcome.
    for (const sentence of sentences(source)) {
      if (!/at-least-once/i.test(sentence)) continue
      assert.ok(
        denies.test(sentence),
        `${name} must not describe overall delivery as at-least-once: ` +
          sentence.trim().slice(0, 80),
      )
    }

    /*
     * Sentence-level, like the two above, because `lib/mail-operations.ts`
     * quotes this exact phrase in order to retract it. A file is allowed to say
     * what it used to claim; it is not allowed to claim it.
     */
    for (const sentence of sentences(source)) {
      if (!/at most one message (is )?(handed|reaches)/i.test(sentence)) continue
      assert.ok(
        /earlier version|used to|no longer|retract/i.test(sentence),
        `${name} must not claim at most one provider call: ${sentence.trim().slice(0, 80)}`,
      )
    }
  }

  assert.ok(
    /at most two provider calls/i.test(operations) && /at most two provider calls/i.test(docs),
    'the real call bound is stated, in the module and in the documentation',
  )
  assert.ok(
    /idempotency window/i.test(operations) && /identical payload/i.test(operations),
    "and Resend's window and identical-payload condition are what the safety rests on",
  )
  assert.ok(
    /zero/i.test(operations) && /zero/i.test(docs),
    'and zero delivered messages is named as a real outcome',
  )
})
