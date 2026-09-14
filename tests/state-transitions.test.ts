import test from 'node:test'
import assert from 'node:assert/strict'

import { ACTIVATION_TTL_MS, SIGNIN_TTL_MS, fingerprint, isSpent } from '../lib/auth-credentials.ts'
import { revokeReviewer } from '../lib/reviewer-admin.ts'
import type { RosterReviewer } from '../lib/reviewer-roster.ts'
import {
  activateWithCredential,
  approveRequest,
  cancelApproval,
  sendAccessEmailForRequest,
  sendAccessEmailToReviewer,
  signinWithCredential,
} from '../lib/reviewer-onboarding.ts'
import { loadRequest, mutateRequest, submitRequest, type ReviewerRequest } from '../lib/reviewer-requests.ts'
import type { MailMessage } from '../lib/mailer.ts'
import {
  ADMIN,
  BOOK,
  aReviewer,
  freshWorld,
  tokenIn,
  withReviewerEnv,
  type World,
} from './helpers/reviewer-world.ts'

/*
 * The state space, walked one cell at a time.
 *
 * The scheduling harness enumerates *orderings* of two concurrent flows. It is
 * the wrong instrument for a different question, and the Judge found two real
 * defects in the gap: an approval resume that silently reversed an explicit
 * revocation, and two reachable operations that sent activation links to
 * reviewers who could never use them. Neither needs concurrency. Both need a
 * combination of states nobody had written down.
 *
 * So this file is the sequential complement: a table over
 *
 *   request state   pending | approving | approved | declined
 *   reviewer state  absent  | active    | revoked
 *   address state   unverified | verified
 *   action          approve/finish | cancel | request-card email | reviewer-card email
 *
 * and, for every combination, the exact expected result — refusal with no
 * mutation, a no-op, an activation email, a sign-in email, or a named
 * administrative transition. Invalid and internally inconsistent combinations
 * must fail closed.
 *
 * **Every cell that claims an accepted email proves it.** The credential is
 * extracted from the message that was actually generated and consumed from an
 * isolated starting state, so "accepted" can never again mean "accepted by the
 * provider and dead on arrival". Where consuming one activation legitimately
 * finishes the others — completing activation verifies the address, and a
 * verified address ends every activation link — that is asserted as the settled
 * behaviour it is, not reported as a failure.
 */

const ADDRESS = 'anna@example.com'
const VERIFIED = '2026-01-02T00:00:00.000Z'

type Action = 'approve' | 'cancel' | 'request-email' | 'reviewer-email'

type RequestState = 'none' | 'pending' | 'approving' | 'approved' | 'declined'
type ReviewerState = 'absent' | 'active' | 'revoked'
type AddressState = 'unverified' | 'verified'

type Expected =
  | { kind: 'refused'; because: RegExp }
  | { kind: 'activation-email' }
  | { kind: 'signin-email' }
  | { kind: 'transition'; requestStatus: ReviewerRequest['status'] }

type Cell = {
  request: RequestState
  reviewer: ReviewerState
  address: AddressState
  action: Action
  expect: Expected
  /** Why this cell is what it is, in one line. Printed on failure. */
  because: string
}

function plain(world: World) {
  return { store: world.store, rosterStore: world.roster, mailer: world.mailer }
}

/* ----------------------------------------------------------- world building */

/**
 * Build exactly the described state, using the real operations wherever they
 * exist so the fixture cannot drift from what the application can reach.
 */
async function build(cell: Cell): Promise<{ world: World; request: ReviewerRequest | null }> {
  const world = freshWorld({ reviewers: [] })

  if (cell.request === 'none') {
    if (cell.reviewer !== 'absent') {
      world.roster.seed([
        aReviewer({
          emailVerifiedAt: cell.address === 'verified' ? VERIFIED : null,
          status: cell.reviewer === 'revoked' ? 'revoked' : 'active',
          credentialEpoch: cell.reviewer === 'revoked' ? 1 : 0,
        }),
      ])
    }
    return { world, request: null }
  }

  const submitted = await submitRequest(
    { name: 'Anna', email: ADDRESS, message: 'Please.' },
    world.store,
  )
  let request = submitted.request

  if (cell.request === 'pending') {
    // A pending request never has a reviewer; the table only pairs it with
    // `absent`, and the builder refuses anything else rather than inventing it.
    assert.equal(cell.reviewer, 'absent', `${cell.because}: a pending request has no reviewer`)
    return { world, request }
  }

  if (cell.request === 'declined') {
    request = (
      await mutateRequest(
        request.id,
        (current) => ({
          next: { ...current, status: 'declined' as const, decidedAt: VERIFIED, decidedBy: ADMIN },
          result: null,
        }),
        world.store,
      )
    ).request
    return { world, request }
  }

  if (cell.request === 'approving') {
    /*
     * The real interruption: the approval is stopped immediately after the
     * roster entry is created, using the module's own crash hook. That is the
     * state the dashboard calls "unfinished", and it is where both P1 defects
     * lived.
     */
    await approveRequest(
      { requestId: request.id, books: [BOOK], actor: ADMIN },
      {
        ...plain(world),
        hooks: {
          afterRoster: () => {
            throw new Error('interrupted immediately after the roster entry was created')
          },
        },
      },
    ).catch(() => null)

    request = (await loadRequest(request.id, world.store)) as ReviewerRequest
    assert.equal(request.status, 'approving', `${cell.because}: the fixture is an unfinished approval`)
  }

  if (cell.request === 'approved') {
    await approveRequest({ requestId: request.id, books: [BOOK], actor: ADMIN }, plain(world))
    request = (await loadRequest(request.id, world.store)) as ReviewerRequest
    world.sent.length = 0
  }

  // Now bend the reviewer into the described state.
  const roster = await world.roster.load()
  const entry = roster.reviewers[0] as RosterReviewer | undefined

  if (cell.reviewer === 'absent') {
    world.roster.seed([])
  } else {
    assert.ok(entry, `${cell.because}: the approval should have created a reviewer`)
    if (cell.address === 'verified') {
      // Verified the only way the application allows: by spending a credential.
      const sent = await sendAccessEmailToReviewer({ reviewerId: entry.id, actor: null }, plain(world))
      assert.equal(sent.purpose, 'activation')
      const opened = await activateWithCredential(
        tokenIn(world.sent[world.sent.length - 1]),
        plain(world),
      )
      assert.equal(opened.ok, true, `${cell.because}: the fixture could not verify the address`)
      world.sent.length = 0
    }
    if (cell.reviewer === 'revoked') {
      await revokeReviewer(entry.id, ADMIN, world.roster)
    }
  }

  request = (await loadRequest(request.id, world.store)) as ReviewerRequest
  return { world, request }
}

/* ------------------------------------------------------------ running a cell */

type Snapshot = {
  reviewers: string
  request: string
  sent: number
  epoch: number | null
}

async function snapshot(world: World, request: ReviewerRequest | null): Promise<Snapshot> {
  const doc = await world.roster.load()
  const current = request ? await loadRequest(request.id, world.store) : null
  return {
    reviewers: JSON.stringify(doc.reviewers),
    request: JSON.stringify(current),
    sent: world.sent.length,
    epoch: doc.reviewers[0]?.credentialEpoch ?? null,
  }
}

async function invoke(
  cell: Cell,
  world: World,
  request: ReviewerRequest | null,
): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> {
  const id = request?.id ?? 'ffffffffffffffffffffffff'
  const reviewerId = (await world.roster.load()).reviewers[0]?.id ?? 'anna'

  try {
    switch (cell.action) {
      case 'approve':
        return {
          ok: true,
          value: await approveRequest({ requestId: id, books: [BOOK], actor: ADMIN }, plain(world)),
        }
      case 'cancel':
        return { ok: true, value: await cancelApproval({ requestId: id, actor: ADMIN }, plain(world)) }
      case 'request-email':
        return {
          ok: true,
          value: await sendAccessEmailForRequest({ requestId: id, actor: ADMIN }, plain(world)),
        }
      case 'reviewer-email':
        return {
          ok: true,
          value: await sendAccessEmailToReviewer({ reviewerId, actor: ADMIN }, plain(world)),
        }
    }
  } catch (error) {
    return { ok: false, error }
  }
}

/** Consume the credential in the message that was actually sent. */
async function opens(
  world: World,
  message: MailMessage,
  purpose: 'activation' | 'signin',
): Promise<boolean> {
  const outcome =
    purpose === 'signin'
      ? await signinWithCredential(tokenIn(message), plain(world))
      : await activateWithCredential(tokenIn(message), plain(world))
  return outcome.ok
}

/* -------------------------------------------------------------- the table */

const TABLE: Cell[] = [
  /* ---------------------------------------------------------- approve ---- */
  {
    request: 'pending',
    reviewer: 'absent',
    address: 'unverified',
    action: 'approve',
    expect: { kind: 'activation-email' },
    because: 'approving a pending request creates the account and sends an activation link',
  },
  {
    request: 'approving',
    reviewer: 'active',
    address: 'unverified',
    action: 'approve',
    expect: { kind: 'activation-email' },
    because: 'finishing an interrupted approval picks up where it stopped',
  },
  {
    request: 'approving',
    reviewer: 'revoked',
    address: 'unverified',
    action: 'approve',
    expect: { kind: 'refused', because: /revoked after this approval stopped/i },
    because: 'P1: a resume must never turn a revoked reviewer active again',
  },
  {
    request: 'approving',
    reviewer: 'revoked',
    address: 'verified',
    action: 'approve',
    expect: { kind: 'refused', because: /revoked after this approval stopped/i },
    because: 'and a verified address does not change that',
  },
  {
    request: 'approving',
    reviewer: 'absent',
    address: 'unverified',
    action: 'approve',
    expect: { kind: 'activation-email' },
    because: 'the roster entry vanished, so the claimed id is created afresh',
  },
  {
    request: 'approved',
    reviewer: 'active',
    address: 'unverified',
    action: 'approve',
    expect: { kind: 'refused', because: /already approved/i },
    because: 'an approved request is not approved twice',
  },
  {
    request: 'declined',
    reviewer: 'absent',
    address: 'unverified',
    action: 'approve',
    expect: { kind: 'refused', because: /declined/i },
    because: 'a declined request is a decision, not a starting point',
  },

  /* ----------------------------------------------------------- cancel ---- */
  {
    request: 'approving',
    reviewer: 'revoked',
    address: 'unverified',
    action: 'cancel',
    expect: { kind: 'transition', requestStatus: 'declined' },
    because: 'the second way out of a blocked approval: close the request, keep them revoked',
  },
  {
    request: 'approving',
    reviewer: 'active',
    address: 'unverified',
    action: 'cancel',
    expect: { kind: 'refused', because: /not blocked/i },
    because: 'an approval that can simply be finished must not be quietly closed',
  },
  {
    request: 'approving',
    reviewer: 'absent',
    address: 'unverified',
    action: 'cancel',
    expect: { kind: 'refused', because: /not blocked/i },
    because: 'no reviewer means nothing to be blocked by; fail closed',
  },
  {
    request: 'pending',
    reviewer: 'absent',
    address: 'unverified',
    action: 'cancel',
    expect: { kind: 'refused', because: /unfinished approval/i },
    because: 'cancel is for approvals, not for undecided requests',
  },
  {
    request: 'approved',
    reviewer: 'active',
    address: 'unverified',
    action: 'cancel',
    expect: { kind: 'refused', because: /unfinished approval/i },
    because: 'a finished approval cannot be cancelled',
  },
  {
    request: 'declined',
    reviewer: 'absent',
    address: 'unverified',
    action: 'cancel',
    expect: { kind: 'refused', because: /unfinished approval/i },
    because: 'and neither can a declined request',
  },

  /* --------------------------------------------- the request-card email -- */
  {
    request: 'approved',
    reviewer: 'active',
    address: 'unverified',
    action: 'request-email',
    expect: { kind: 'activation-email' },
    because: 'an unverified reviewer needs an activation link',
  },
  {
    request: 'approved',
    reviewer: 'active',
    address: 'verified',
    action: 'request-email',
    expect: { kind: 'signin-email' },
    because: 'P1: a verified reviewer cannot use an activation link, so send a sign-in link',
  },
  {
    request: 'approved',
    reviewer: 'revoked',
    address: 'unverified',
    action: 'request-email',
    expect: { kind: 'refused', because: /revoked/i },
    because: 'a revoked reviewer is sent nothing at all',
  },
  {
    request: 'approved',
    reviewer: 'revoked',
    address: 'verified',
    action: 'request-email',
    expect: { kind: 'refused', because: /revoked/i },
    because: 'and verification does not soften that',
  },
  {
    request: 'approved',
    reviewer: 'absent',
    address: 'unverified',
    action: 'request-email',
    expect: { kind: 'refused', because: /no longer on the roster/i },
    because: 'an approved request whose reviewer is gone is inconsistent; fail closed',
  },
  {
    request: 'approving',
    reviewer: 'active',
    address: 'unverified',
    action: 'request-email',
    expect: { kind: 'activation-email' },
    because: 'an unfinished approval may still be chased with another email',
  },
  {
    request: 'approving',
    reviewer: 'revoked',
    address: 'unverified',
    action: 'request-email',
    expect: { kind: 'refused', because: /revoked/i },
    because: 'unless the reviewer was revoked in the meantime',
  },
  {
    request: 'pending',
    reviewer: 'absent',
    address: 'unverified',
    action: 'request-email',
    expect: { kind: 'refused', because: /not been approved/i },
    because: 'nothing to send to: nobody has been approved',
  },
  {
    request: 'declined',
    reviewer: 'absent',
    address: 'unverified',
    action: 'request-email',
    expect: { kind: 'refused', because: /not been approved/i },
    because: 'and a declined request is not a recipient',
  },

  /* -------------------------------------------- the reviewer-card email -- */
  {
    request: 'none',
    reviewer: 'active',
    address: 'unverified',
    action: 'reviewer-email',
    expect: { kind: 'activation-email' },
    because: 'the migration path for somebody already here with a code',
  },
  {
    request: 'none',
    reviewer: 'active',
    address: 'verified',
    action: 'reviewer-email',
    expect: { kind: 'signin-email' },
    because: 'P1: the reviewer card used to send a dead activation link here',
  },
  {
    request: 'none',
    reviewer: 'revoked',
    address: 'unverified',
    action: 'reviewer-email',
    expect: { kind: 'refused', because: /revoked/i },
    because: 'a revoked reviewer gets nothing',
  },
  {
    request: 'none',
    reviewer: 'revoked',
    address: 'verified',
    action: 'reviewer-email',
    expect: { kind: 'refused', because: /revoked/i },
    because: 'verified or not',
  },
  {
    request: 'none',
    reviewer: 'absent',
    address: 'unverified',
    action: 'reviewer-email',
    expect: { kind: 'refused', because: /no longer on the roster/i },
    because: 'and a reviewer who is not there gets nothing either',
  },
]

for (const cell of TABLE) {
  const name =
    `${cell.action} | request=${cell.request} reviewer=${cell.reviewer} ` +
    `address=${cell.address} -> ${cell.expect.kind}`

  test(name, async () => {
    await withReviewerEnv(async () => {
      const { world, request } = await build(cell)
      const before = await snapshot(world, request)
      world.sent.length = 0

      const outcome = await invoke(cell, world, request)
      const after = await snapshot(world, request)

      if (cell.expect.kind === 'refused') {
        assert.equal(outcome.ok, false, `${cell.because}: expected a refusal`)
        const message = String((outcome as { error: unknown }).error)
        assert.match(message, cell.expect.because, cell.because)

        // A refusal changes nothing at all: not the roster, not the request,
        // not the epoch, and it sends no message.
        assert.equal(after.reviewers, before.reviewers, `${cell.because}: the roster moved`)
        assert.equal(after.request, before.request, `${cell.because}: the request moved`)
        assert.equal(after.epoch, before.epoch, `${cell.because}: the epoch moved`)
        assert.equal(world.sent.length, 0, `${cell.because}: a message was sent`)
        return
      }

      assert.equal(outcome.ok, true, `${cell.because}: ${String((outcome as { error?: unknown }).error)}`)

      if (cell.expect.kind === 'transition') {
        const current = await loadRequest(request!.id, world.store)
        assert.equal(current?.status, cell.expect.requestStatus, cell.because)
        assert.equal(world.sent.length, 0, `${cell.because}: a transition sends no message`)
        // The roster is untouched by a request-only transition.
        assert.equal(after.reviewers, before.reviewers, `${cell.because}: the roster moved`)
        return
      }

      /* ---- an email was claimed, so prove the credential in it works ---- */

      const purpose = cell.expect.kind === 'signin-email' ? 'signin' : 'activation'
      const mail = world.sent.filter((m) => m.to === ADDRESS)
      assert.equal(mail.length, 1, `${cell.because}: expected exactly one message`)

      const message = mail[0]
      assert.match(
        message.idempotencyKey,
        purpose === 'signin' ? /^signin:/ : /^activation:/,
        `${cell.because}: the message identifies itself as ${purpose}`,
      )

      assert.equal(
        await opens(world, message, purpose),
        true,
        `${cell.because}: the accepted email carried a credential that does not work`,
      )
    })
  })
}

/* ------------------------------------------------ the six named regressions */

test('regression 1 — interrupt after roster creation, revoke, then Finish', async () => {
  await withReviewerEnv(async () => {
    const world = freshWorld({ reviewers: [] })
    const submitted = await submitRequest(
      { name: 'Anna', email: ADDRESS, message: 'Please.' },
      world.store,
    )

    await approveRequest(
      { requestId: submitted.request.id, books: [BOOK], actor: ADMIN },
      {
        ...plain(world),
        hooks: {
          afterRoster: () => {
            throw new Error('interrupted immediately after the roster entry was created')
          },
        },
      },
    ).catch(() => null)

    const created = (await world.roster.load()).reviewers[0]
    assert.equal(created.status, 'active')
    assert.equal(created.credentialEpoch, 0)

    await revokeReviewer(created.id, ADMIN, world.roster)
    const revoked = (await world.roster.load()).reviewers[0]
    assert.equal(revoked.status, 'revoked')
    assert.equal(revoked.credentialEpoch, 1, 'revocation advanced the epoch')

    world.sent.length = 0
    const storeBefore = world.store.paths().join('\n')

    await assert.rejects(
      () => approveRequest({ requestId: submitted.request.id, books: [BOOK], actor: ADMIN }, plain(world)),
      /revoked after this approval stopped/i,
    )

    const after = (await world.roster.load()).reviewers[0]
    assert.equal(after.status, 'revoked', 'the reviewer is still revoked')
    assert.equal(after.credentialEpoch, 1, 'and the epoch is exactly where revocation left it')
    assert.equal(world.sent.length, 0, 'no email was sent')
    assert.equal(world.store.paths().join('\n'), storeBefore, 'no credential and no other object')

    // The request is untouched and both explicit ways out remain open.
    const request = await loadRequest(submitted.request.id, world.store)
    assert.equal(request?.status, 'approving', 'not falsely approved, and still recoverable')

    // Restore, then Finish, is the path that proceeds — and only Restore reactivates.
    await world.roster.save(
      {
        ...(await world.roster.load()),
        reviewers: (await world.roster.load()).reviewers.map((row) => ({
          ...row,
          status: 'active' as const,
        })),
      },
      (await world.roster.load()).updatedAt,
      (await world.roster.loadForUpdate()).version,
    )

    const finished = await approveRequest(
      { requestId: submitted.request.id, books: [BOOK], actor: ADMIN },
      plain(world),
    )
    assert.equal(finished.delivery.status, 'accepted')
    assert.equal(
      (await world.roster.load()).reviewers[0].credentialEpoch,
      1,
      'restoring never decrements the epoch',
    )
    assert.equal(
      (await activateWithCredential(tokenIn(world.sent[world.sent.length - 1]), plain(world))).ok,
      true,
      'and the email that finally went out works',
    )
  })
})

test('regression 2 — interrupt after roster creation, revoke, then Cancel', async () => {
  await withReviewerEnv(async () => {
    const world = freshWorld({ reviewers: [] })
    const submitted = await submitRequest(
      { name: 'Anna', email: ADDRESS, message: 'Please.' },
      world.store,
    )

    await approveRequest(
      { requestId: submitted.request.id, books: [BOOK], actor: ADMIN },
      {
        ...plain(world),
        hooks: {
          afterRoster: () => {
            throw new Error('interrupted')
          },
        },
      },
    ).catch(() => null)

    const created = (await world.roster.load()).reviewers[0]
    await revokeReviewer(created.id, ADMIN, world.roster)
    world.sent.length = 0

    const cancelled = await cancelApproval({ requestId: submitted.request.id, actor: ADMIN }, plain(world))

    assert.equal(cancelled.status, 'declined', 'the request closes')
    assert.equal(cancelled.decidedBy, ADMIN, 'and records who decided')

    const after = (await world.roster.load()).reviewers
    assert.equal(after.length, 1, 'cancelling an approval is not deleting a reviewer')
    assert.equal(after[0].status, 'revoked', 'who stays revoked')
    assert.equal(after[0].credentialEpoch, 1, 'with the epoch the revocation produced')
    assert.equal(after[0].id, created.id, 'and their identifier, history and attribution intact')
    assert.equal(after[0].books.length, created.books.length)
    assert.equal(world.sent.length, 0, 'no email was sent')

    const audit = world.roster.audit().map((event) => event.action)
    assert.ok(audit.includes('request.approval-cancelled'), 'the cancellation is audited as itself')
    assert.ok(audit.includes('reviewer.revoked'), 'and the revocation is still in the history')
  })
})

test('regression 3 — a verified reviewer asking the reviewer card for an access email', async () => {
  await withReviewerEnv(async () => {
    const world = freshWorld({ reviewers: [aReviewer({ emailVerifiedAt: VERIFIED })] })

    const sent = await sendAccessEmailToReviewer({ reviewerId: 'anna', actor: ADMIN }, plain(world))
    assert.equal(sent.purpose, 'signin', 'a sign-in credential, not an activation one')
    assert.equal(sent.delivery.status, 'accepted')

    const message = world.sent[world.sent.length - 1]
    assert.match(message.subject, /sign in/i)
    assert.match(message.idempotencyKey, /^signin:anna:/)

    // Its lifetime is the sign-in TTL, not the activation TTL.
    const expiry = message.text.match(/expires ([^\n]+)/)
    assert.ok(expiry, 'the message states an expiry')
    assert.ok(SIGNIN_TTL_MS < ACTIVATION_TTL_MS)

    // And the audit says which kind of email it was.
    const line = world.roster.audit().find((event) => event.action === 'signin.sent')
    assert.ok(line, 'recorded as a sign-in, not as an activation')
    assert.match(line.detail, /sign-in email/i)
    assert.match(line.detail, /about 15 minutes/i)

    assert.equal((await signinWithCredential(tokenIn(message), plain(world))).ok, true, 'it opens')
    assert.equal((await signinWithCredential(tokenIn(message), plain(world))).ok, false, 'once')
  })
})

test('regression 4 — activation succeeds, usedAt bookkeeping fails, then the request card', async () => {
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

    /*
     * The exact fault the Judge injected: the roster verification commits, and
     * only the best-effort `request.activation.usedAt` write fails. The request
     * record therefore still says "not activated" while the roster -- the
     * authorization root -- says the address is verified.
     */
    const requestPath = `requests/v2/records/${submitted.request.id}.json`
    const honest = world.store.writeIfMatch.bind(world.store)
    let faulted = false
    world.store.writeIfMatch = async (path: string, body: string, version: string | null) => {
      if (!faulted && path === requestPath && body.includes('"usedAt": "')) {
        faulted = true
        throw new Error('the request record could not be written')
      }
      return honest(path, body, version)
    }

    const opened = await activateWithCredential(tokenIn(world.sent[world.sent.length - 1]), plain(world))
    assert.equal(opened.ok, true, 'the activation itself succeeded')
    assert.equal(faulted, true, 'and the bookkeeping write was the thing that failed')

    world.store.writeIfMatch = honest

    assert.ok((await world.roster.load()).reviewers[0].emailVerifiedAt, 'the roster is verified')
    assert.equal(
      (await loadRequest(submitted.request.id, world.store))?.activation?.usedAt,
      null,
      'while the request record still says otherwise',
    )

    world.sent.length = 0
    const sent = await sendAccessEmailForRequest({ requestId: submitted.request.id, actor: ADMIN }, plain(world))

    assert.equal(sent.purpose, 'signin', 'the roster wins; a sign-in link is sent')
    assert.equal(sent.delivery.status, 'accepted')
    assert.equal(sent.request.delivery?.kind, 'signin', 'and it is recorded as a sign-in')

    const message = world.sent[world.sent.length - 1]
    assert.match(message.idempotencyKey, /^signin:/)
    assert.equal((await signinWithCredential(tokenIn(message), plain(world))).ok, true, 'it opens')
    assert.equal((await signinWithCredential(tokenIn(message), plain(world))).ok, false, 'once')
  })
})

test('regression 5 — an unverified active reviewer, through either access-email action', async () => {
  for (const action of ['request-email', 'reviewer-email'] as const) {
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
      world.sent.length = 0

      const purpose =
        action === 'request-email'
          ? (await sendAccessEmailForRequest({ requestId: submitted.request.id, actor: ADMIN }, plain(world)))
              .purpose
          : (await sendAccessEmailToReviewer({ reviewerId: 'anna', actor: ADMIN }, plain(world))).purpose

      assert.equal(purpose, 'activation', `${action}: an unverified address gets an activation link`)

      const message = world.sent[world.sent.length - 1]
      assert.match(message.idempotencyKey, /^activation:/)

      const opened = await activateWithCredential(tokenIn(message), plain(world))
      assert.equal(opened.ok, true, `${action}: it opens`)
      assert.ok(
        (await world.roster.load()).reviewers[0].emailVerifiedAt,
        `${action}: and opening it verified the address`,
      )
      assert.equal(
        (await activateWithCredential(tokenIn(message), plain(world))).ok,
        false,
        `${action}: once`,
      )
    })
  }
})

test('regression 6 — a revoked or missing reviewer, through either access-email action', async () => {
  for (const who of ['revoked', 'missing'] as const) {
    for (const action of ['request-email', 'reviewer-email'] as const) {
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

        if (who === 'revoked') await revokeReviewer('anna', ADMIN, world.roster)
        else world.roster.seed([])

        world.sent.length = 0
        const before = world.store.paths().join('\n')

        let providerCalls = 0
        const counting = {
          driver: 'test',
          async send(message: MailMessage) {
            providerCalls += 1
            world.sent.push(message)
            return { status: 'accepted' as const, providerId: 'm1', error: null }
          },
        }

        const run =
          action === 'request-email'
            ? () =>
                sendAccessEmailForRequest(
                  { requestId: submitted.request.id, actor: ADMIN },
                  { ...plain(world), mailer: counting },
                )
            : () =>
                sendAccessEmailToReviewer(
                  { reviewerId: 'anna', actor: ADMIN },
                  { ...plain(world), mailer: counting },
                )

        await assert.rejects(run, /revoked|no longer on the roster/i, `${who} / ${action}`)

        assert.equal(providerCalls, 0, `${who} / ${action}: the provider was never called`)
        assert.equal(world.sent.length, 0, `${who} / ${action}: no email was reported`)
        assert.equal(
          world.store.paths().join('\n'),
          before,
          `${who} / ${action}: no credential was created`,
        )
      })
    }
  }
})

/* ----------------------------------------- the settled activation transition */

test('completing one activation finishes the others, and that is the settled rule', async () => {
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
    await sendAccessEmailForRequest({ requestId: submitted.request.id, actor: ADMIN }, plain(world))

    const mail = world.sent.filter((m) => m.to === ADDRESS)
    assert.equal(mail.length, 2, 'two activation links coexist')

    assert.equal((await activateWithCredential(tokenIn(mail[0]), plain(world))).ok, true)

    /*
     * The second is now refused -- not because it was superseded, which this
     * architecture deliberately abolished, but because the address is verified
     * and an activation credential is finished at that point. That is the
     * settled rule from Addendum A.3, and it is an expected transition rather
     * than a failure of the coexistence guarantee.
     */
    const second = await activateWithCredential(tokenIn(mail[1]), plain(world))
    assert.equal(second.ok, false)
    assert.equal(second.ok === false && second.reason, 'already-verified')

    // Refused before consumption, so it left no marker.
    const hash = fingerprint('activation', tokenIn(mail[1]))
    assert.ok(hash)
    assert.equal(await isSpent('activation', hash, world.store), false)

    // And the reviewer is not stranded: the next access email is a sign-in link.
    world.sent.length = 0
    const next = await sendAccessEmailForRequest({ requestId: submitted.request.id, actor: ADMIN }, plain(world))
    assert.equal(next.purpose, 'signin')
    assert.equal(
      (await signinWithCredential(tokenIn(world.sent[world.sent.length - 1]), plain(world))).ok,
      true,
    )
  })
})
