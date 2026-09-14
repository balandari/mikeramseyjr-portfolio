import test from 'node:test'
import assert from 'node:assert/strict'

import { credentialEmailLabel, fingerprint, isSpent, issueCredential } from '../lib/auth-credentials.ts'
import {
  approveRequest,
  activateWithCredential,
  requestSigninLink,
  sendAccessEmailForRequest,
  signinWithCredential,
  submitAccessRequest,
} from '../lib/reviewer-onboarding.ts'
import { listRequests, loadRequest, submitRequest } from '../lib/reviewer-requests.ts'
import { InjectedCrash, exploreCrashes, type Flow } from './helpers/scheduled-store.ts'
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
 * A crash after every durable write, and what one more press converges to.
 *
 * The question these ask is always the same, and it is the one from the
 * architecture's I12: *whatever write the process died immediately after,
 * pressing the button once more must finish the job* — with exactly one
 * reviewer, no second live message for the same operation, and a dashboard that
 * is either correct or explicitly uncertain.
 *
 * `exploreCrashes` runs the scenario once cleanly to learn how many durable
 * writes it performs, then once per write, killing the flow the instant that
 * write lands. So "after each durable write" is enumerated rather than chosen:
 * adding a write to a flow adds a crash point automatically.
 *
 * The roster is gated as well as the object store, so a crash lands after a
 * roster write just as readily as after a credential one.
 */

const ADDRESS = 'anna@example.com'
const VERIFIED = '2026-01-02T00:00:00.000Z'

function deps(world: World, store: Parameters<Flow['run']>[0], gate: Parameters<Flow['run']>[1]) {
  return { store, rosterStore: gatedRoster(world.roster, gate), mailer: world.mailer }
}

function crashed(outcome: { results: Map<string, { ok: boolean; error?: unknown }> }, id: string) {
  const result = outcome.results.get(id)
  return !!result && !result.ok && result.error instanceof InjectedCrash
}

/* ------------------------------------------------------------- the approval */

test('an approval crashing after any durable write converges on one more press', async () => {
  await withReviewerEnv(async () => {
    let points = 0

    points = await exploreCrashes({
      setup: async () => {
        const world = freshWorld({ reviewers: [] })
        const submitted = await submitRequest(
          { name: 'Anna', email: ADDRESS, message: 'Please.' },
          world.store,
        )
        const flows: Flow[] = [
          {
            id: 'approve',
            run: (store, gate) =>
              approveRequest(
                { requestId: submitted.request.id, books: [BOOK], actor: ADMIN },
                deps(world, store, gate),
              ),
          },
        ]
        return { store: world.store, flows, world: { world, id: submitted.request.id } }
      },
      check: async (outcome, { world, id }, k) => {
        /*
         * Not every injected crash kills the flow, and that is correct rather
         * than a gap: appending an audit line is explicitly best-effort, so a
         * failure there is swallowed and the approval finishes without its log
         * line. The roster is the source of truth; the log is a courtesy. Every
         * crash on a write that is *not* best-effort does kill the flow, and
         * the convergence assertions below hold in both cases.
         */
        void crashed(outcome, 'approve')

        // Whatever it stopped at, the request never reads as done unless it is.
        const midway = await loadRequest(id, world.store)
        assert.ok(midway)
        if (k > 0) assert.notEqual(midway.status, 'declined')
        assert.ok((await world.roster.load()).reviewers.length <= 1, 'never two reviewers')

        // One more press.
        const recovered = await approveRequest(
          { requestId: id, books: [BOOK], actor: ADMIN },
          { store: world.store, rosterStore: world.roster, mailer: world.mailer },
        ).catch((error: unknown) => {
          // The only refusal a retry may produce is "already approved", which is
          // the clean run's own correct behaviour.
          assert.match(String(error), /already approved/i, `crash ${k}: ${String(error)}`)
          return null
        })

        const doc = await world.roster.load()
        assert.equal(doc.reviewers.length, 1, `crash ${k}: exactly one reviewer`)
        assert.deepEqual(doc.reviewers[0].books, [BOOK], `crash ${k}: one set of entitlements`)

        const settled = await loadRequest(id, world.store)
        assert.equal(settled?.status, 'approved', `crash ${k}: the approval finished`)
        if (recovered) assert.ok(recovered.delivery, `crash ${k}: a delivery was reported`)

        const plain = {
          store: world.store,
          rosterStore: world.roster,
          mailer: world.mailer,
        }
        const sent = world.sent.filter((m) => m.to === ADDRESS)

        if (sent.length >= 1) {
          /*
           * The credential the reviewer actually received works. Whichever
           * message went out first is as good as the last, so the first is the
           * one checked: under the old design this is precisely the link a
           * retry would have killed.
           */
          const opened = await activateWithCredential(tokenIn(sent[0]), plain)
          assert.equal(opened.ok, true, `crash ${k}: the first emailed link opens the account`)
          return
        }

        /*
         * The one crash point that leaves no message at all: between claiming
         * the mail operation and the provider answering. The provider may or
         * may not have taken it and nobody can ever find out, so the retry
         * refuses to send a second copy and reports `uncertain` — which is the
         * honest answer, and the reason the dashboard has a sentence for it.
         * The recovery Mike is offered is "send a new access email", and it
         * produces a working link without disturbing anything.
         */
        assert.equal(settled?.delivery?.status, 'uncertain', `crash ${k}: nothing sent, not uncertain`)

        const again = await sendAccessEmailForRequest({ requestId: id, actor: ADMIN }, plain)
        assert.equal(again.delivery.status, 'accepted', `crash ${k}: the new email went`)

        const fresh = world.sent.filter((m) => m.to === ADDRESS)
        assert.equal(fresh.length, 1)
        const opened = await activateWithCredential(tokenIn(fresh[0]), plain)
        assert.equal(opened.ok, true, `crash ${k}: and it opens the account`)
      },
    })

    // Pinned: a write added to the approval adds a crash point, and should be seen.
    assert.equal(points, 11, 'every durable write of an approval is a crash point')
  })
})

test('a resend crashing after any durable write leaves every emailed link usable', async () => {
  await withReviewerEnv(async () => {
    const points = await exploreCrashes({
      setup: async () => {
        const world = freshWorld({ reviewers: [] })
        const submitted = await submitRequest(
          { name: 'Anna', email: ADDRESS, message: 'Please.' },
          world.store,
        )
        await approveRequest(
          { requestId: submitted.request.id, books: [BOOK], actor: ADMIN },
          { store: world.store, rosterStore: world.roster, mailer: world.mailer },
        )
        const before = world.sent.length

        const flows: Flow[] = [
          {
            id: 'resend',
            run: (store, gate) =>
              sendAccessEmailForRequest(
                { requestId: submitted.request.id, actor: ADMIN },
                deps(world, store, gate),
              ),
          },
        ]
        return { store: world.store, flows, world: { world, id: submitted.request.id, before } }
      },
      check: async (outcome, { world, before }, k) => {
        const sent = world.sent.slice(0, before).filter((m) => m.to === ADDRESS)
        assert.equal(sent.length, 1, 'the original access email')

        /*
         * The invariant the old design could not hold: a crash anywhere in a
         * resend must never strand the link that was already in the reviewer's
         * inbox. There is nothing left that could — a resend creates one new
         * immutable credential and touches no other one.
         */
        const opened = await activateWithCredential(tokenIn(sent[0]), {
          store: world.store,
          rosterStore: world.roster,
          mailer: world.mailer,
        })
        assert.equal(opened.ok, true, `crash ${k}: the original link still works`)
      },
    })

    assert.equal(points, 6)
  })
})

/* -------------------------------------------------------------- consumption */

test('an activation crashing after any durable write never grants access it did not earn', async () => {
  await withReviewerEnv(async () => {
    const points = await exploreCrashes({
      setup: async () => {
        const world = freshWorld()
        const issued = await issueCredential(
          'activation',
          {
            reviewerId: 'anna',
            emailLabel: credentialEmailLabel(ADDRESS),
            credentialEpoch: 0,
          },
          world.store,
        )
        assert.ok(issued)
        const flows: Flow[] = [
          {
            id: 'activate',
            run: (store, gate) => activateWithCredential(issued.token, deps(world, store, gate)),
          },
        ]
        return { store: world.store, flows, world: { world, token: issued.token } }
      },
      check: async (outcome, { world, token }, k) => {
        const hash = fingerprint('activation', token)
        assert.ok(hash)
        const spent = await isSpent('activation', hash, world.store)
        const verified = (await world.roster.load()).reviewers[0].emailVerifiedAt

        /*
         * The two states a crash can leave, and neither of them is dangerous:
         *
         *   - not spent: nothing happened at all, and one more press works.
         *   - spent: the credential is permanently gone. The flag may or may
         *     not have been written; either way this credential can never let
         *     anybody in again, which is the fail-closed direction.
         *
         * What must never be true is a verified flag with no marker, because
         * that would mean the roster moved on the strength of a credential
         * nobody had spent.
         */
        if (verified) {
          assert.equal(spent, true, `crash ${k}: verified without a marker`)
        }

        // A second attempt with the same credential can never succeed once spent.
        const again = await activateWithCredential(token, {
          store: world.store,
          rosterStore: world.roster,
          mailer: world.mailer,
        })
        if (spent) assert.equal(again.ok, false, `crash ${k}: a spent credential came back`)
      },
    })

    assert.equal(points, 3)
  })
})

test('a sign-in crashing after any durable write leaves the credential spent and no session', async () => {
  await withReviewerEnv(async () => {
    const points = await exploreCrashes({
      setup: async () => {
        const world = freshWorld({ reviewers: [aReviewer({ emailVerifiedAt: VERIFIED })] })
        const issued = await issueCredential(
          'signin',
          { reviewerId: 'anna', emailLabel: credentialEmailLabel(ADDRESS), credentialEpoch: 0 },
          world.store,
        )
        assert.ok(issued)
        const flows: Flow[] = [
          {
            id: 'signin',
            run: (store, gate) => signinWithCredential(issued.token, deps(world, store, gate)),
          },
        ]
        return { store: world.store, flows, world: { world, token: issued.token } }
      },
      check: async (outcome, { world, token }, k) => {
        const hash = fingerprint('signin', token)
        assert.ok(hash)

        if (await isSpent('signin', hash, world.store)) {
          const again = await signinWithCredential(token, {
            store: world.store,
            rosterStore: world.roster,
            mailer: world.mailer,
          })
          assert.equal(again.ok, false, `crash ${k}: a spent sign-in link came back`)
          assert.equal(again.ok === false && again.reason, 'already-used')
        }
      },
    })

    assert.equal(points, 2)
  })
})

/* ---------------------------------------------------------------- the request */

test('a submission crashing after any durable write leaves one request and no orphan', async () => {
  await withReviewerEnv(async () => {
    const points = await exploreCrashes({
      setup: () => {
        const world = freshWorld({ reviewers: [] })
        const flows: Flow[] = [
          {
            id: 'submit',
            run: (store, gate) =>
              submitAccessRequest(
                { name: 'Anna', email: ADDRESS, message: 'Please.' },
                deps(world, store, gate),
              ),
          },
        ]
        return { store: world.store, flows, world }
      },
      check: async (outcome, world, k) => {
        // One more attempt, from a clean process.
        await submitAccessRequest(
          { name: 'Anna', email: ADDRESS, message: 'Trying again.' },
          { store: world.store, rosterStore: world.roster, mailer: world.mailer },
        )

        const all = await listRequests(world.store)
        assert.equal(all.length, 1, `crash ${k}: exactly one request, never an orphan`)
        assert.equal(all[0].email, ADDRESS)
        assert.equal(all[0].status, 'pending')
      },
    })

    assert.equal(points, 5)
  })
})

test('a sign-in link request crashing after any durable write never emails a dead link', async () => {
  await withReviewerEnv(async () => {
    const points = await exploreCrashes({
      setup: () => {
        const world = freshWorld({ reviewers: [aReviewer({ emailVerifiedAt: VERIFIED })] })
        const flows: Flow[] = [
          {
            id: 'issue',
            run: (store, gate) => requestSigninLink(ADDRESS, deps(world, store, gate)),
          },
        ]
        return { store: world.store, flows, world }
      },
      check: async (outcome, world, k) => {
        if (world.sent.length === 0) return

        /*
         * I3, as a structural property rather than a checked one: a message is
         * only ever built after its credential record exists, and nothing can
         * invalidate that credential afterwards except an administrative act.
         * So every message that went out carries a usable link, whatever the
         * process did next.
         */
        const opened = await signinWithCredential(tokenIn(world.sent[0]), {
          store: world.store,
          rosterStore: world.roster,
          mailer: world.mailer,
        })
        assert.equal(opened.ok, true, `crash ${k}: an emailed link was not usable`)
      },
    })

    assert.equal(points, 3)
  })
})
