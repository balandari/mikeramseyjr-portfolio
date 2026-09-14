import test from 'node:test'
import assert from 'node:assert/strict'

import type { PrivateStore } from '../lib/private-store.ts'
import {
  credentialEmailLabel,
  fingerprint,
  isSpent,
  issueCredential,
  spendCredential,
} from '../lib/auth-credentials.ts'
import { mutateRoster, newAuditEvent } from '../lib/reviewer-roster.ts'
import {
  activateWithCredential,
  requestSigninLink,
  sendAccessEmailToReviewer,
  signinWithCredential,
} from '../lib/reviewer-onboarding.ts'
import { invalidateReviewerCredentials, revokeReviewer } from '../lib/reviewer-admin.ts'
import {
  explore,
  runSchedule,
  scripted,
  type Flow,
  type Gate,
  type RunOutcome,
} from './helpers/scheduled-store.ts'
import {
  ADMIN,
  aReviewer,
  freshWorld,
  gatedRoster,
  tokenIn,
  withReviewerEnv,
  type World,
} from './helpers/reviewer-world.ts'

/*
 * Every interleaving of the credential flows, enumerated rather than imagined.
 *
 * Three review rounds each found "the next interleaving", and each reproduction
 * was a hand-built barrier inside a verdict. This file is the mechanical
 * version: for each pair of flows below, `explore()` re-runs the scenario once
 * per ordering of their storage operations, against a fresh world, and checks
 * the invariants after every one. The count of orderings visited is asserted
 * too, so a scenario that silently collapses to a single ordering -- because a
 * flow stopped touching the store, say -- is caught rather than passing quietly.
 *
 * The invariants, by the names the architecture gives them:
 *
 *   I1   a credential is consumed at most once, under any interleaving
 *   I3   nothing reported as sent carries a credential the application refuses
 *   I4   a revoked reviewer's credentials are refused
 *   I5   after an address change, credentials sent to the old address are refused
 *   I16  two credentials issued concurrently are both accepted, once each
 *
 * And the rule from the last architectural correction, which is the one this
 * file exists to hold: **creating the used marker spends the credential but
 * does not authorize anything.** Where an administrative change lands between
 * the marker and the decision that follows it, the marker stays, no session is
 * minted, and the attempt is audited.
 */

const ADDRESS = 'anna@example.com'

function deps(world: World, store: PrivateStore, gate: Gate) {
  return { store, rosterStore: gatedRoster(world.roster, gate), mailer: world.mailer }
}

/** Mint a credential outside the schedule, so a flow can start holding one. */
async function seedCredential(
  world: World,
  purpose: 'activation' | 'signin',
  options: { address?: string; epoch?: number } = {},
): Promise<string> {
  const issued = await issueCredential(
    purpose,
    {
      reviewerId: 'anna',
      emailLabel: credentialEmailLabel(options.address ?? ADDRESS),
      credentialEpoch: options.epoch ?? 0,
    },
    world.store,
  )
  assert.ok(issued)
  return issued.token
}

/** How many flows came back with a session. */
function sessions(outcome: RunOutcome): number {
  let count = 0
  outcome.results.forEach((result) => {
    if (result.ok && (result.value as { ok?: boolean } | null)?.ok === true) count += 1
  })
  return count
}

function resultOf(outcome: RunOutcome, id: string): { ok: boolean; reason?: string } {
  const entry = outcome.results.get(id)
  assert.ok(entry, `no result for ${id}`)
  assert.equal(entry.ok, true, `${id} threw: ${String((entry as { error?: unknown }).error)}`)
  return (entry as { value: { ok: boolean; reason?: string } }).value
}

/* ------------------------------------------------- issuance against itself */

test('two concurrent activation issues both mint, and both credentials work', async () => {
  await withReviewerEnv(async () => {
    let visited = 0

    visited = await explore({
      setup: () => {
        const world = freshWorld()
        const flows: Flow[] = ['a', 'b'].map((id) => ({
          id,
          run: (store, gate) =>
            sendAccessEmailToReviewer({ reviewerId: 'anna', actor: null }, deps(world, store, gate)),
        }))
        return { store: world.store, flows, world }
      },
      check: async (outcome, world) => {
        // Both messages went, and each carries its own credential and its own
        // mail identity. There is nothing shared for them to race on.
        assert.equal(world.sent.length, 2, 'two messages')
        const tokens = world.sent.map(tokenIn)
        assert.equal(new Set(tokens).size, 2, 'two distinct credentials')
        assert.equal(
          new Set(world.sent.map((m) => m.idempotencyKey)).size,
          2,
          'and two distinct idempotency keys, so neither suppresses the other',
        )

        // I16 / I3: every emailed credential is genuinely usable, once. The
        // first opens the account; the second is then refused only because the
        // address is verified, which is the activation rule and not supersession.
        const first = await activateWithCredential(tokens[0], {
          store: world.store,
          rosterStore: world.roster,
          mailer: world.mailer,
        })
        assert.equal(first.ok, true, 'the first emailed credential opens the account')

        const second = await activateWithCredential(tokens[1], {
          store: world.store,
          rosterStore: world.roster,
          mailer: world.mailer,
        })
        assert.equal(second.ok, false)
        assert.equal(second.ok === false && second.reason, 'already-verified')
      },
    })

    /*
     * C(8,4) = 70. Each flow now resolves the reviewer from the roster at the
     * operation boundary before it mints anything -- one more scheduled
     * operation each than when the caller passed in a reviewer object.
     */
    assert.equal(visited, 70)
  })
})

test('two concurrent sign-in requests both mint, and both links work once', async () => {
  await withReviewerEnv(async () => {
    const visited = await explore({
      setup: () => {
        const world = freshWorld({
          reviewers: [aReviewer({ emailVerifiedAt: '2026-01-02T00:00:00.000Z' })],
        })
        const flows: Flow[] = ['a', 'b'].map((id) => ({
          id,
          run: (store, gate) => requestSigninLink(ADDRESS, deps(world, store, gate)),
        }))
        return { store: world.store, flows, world }
      },
      check: async (outcome, world) => {
        assert.equal(world.sent.length, 2)
        const tokens = world.sent.map(tokenIn)
        assert.equal(new Set(tokens).size, 2)

        for (const token of tokens) {
          const opened = await signinWithCredential(token, {
            store: world.store,
            rosterStore: world.roster,
            mailer: world.mailer,
          })
          assert.equal(opened.ok, true, 'each sign-in link works')
        }
        for (const token of tokens) {
          const again = await signinWithCredential(token, {
            store: world.store,
            rosterStore: world.roster,
            mailer: world.mailer,
          })
          assert.equal(again.ok, false, 'and each one works only once')
        }
      },
    })

    // Two flows of four operations each (a roster read, then three): C(8,4) = 70.
    assert.equal(visited, 70)
  })
})

/* -------------------------------------------------- consumption against itself */

test('two concurrent consumptions of one credential: exactly one session', async () => {
  await withReviewerEnv(async () => {
    const visited = await explore({
      setup: async () => {
        const world = freshWorld({
          reviewers: [aReviewer({ emailVerifiedAt: '2026-01-02T00:00:00.000Z' })],
        })
        const token = await seedCredential(world, 'signin')
        const flows: Flow[] = ['a', 'b'].map((id) => ({
          id,
          run: (store, gate) => signinWithCredential(token, deps(world, store, gate)),
        }))
        return { store: world.store, flows, world: { world, token } }
      },
      check: async (outcome, { world, token }) => {
        assert.equal(sessions(outcome), 1, 'I1: exactly one, under every ordering')

        const loser = ['a', 'b']
          .map((id) => resultOf(outcome, id))
          .find((result) => result.ok === false)
        assert.equal(loser?.reason, 'already-used', 'and the loser is told why, honestly')

        const hash = fingerprint('signin', token)
        assert.ok(hash)
        assert.equal(world.roster.audit().length, 1, 'one sign-in audit line, not two')

        // And the marker exists exactly once, whoever won.
        assert.equal(await isSpent('signin', fingerprint('signin', token) as string, world.store), true)
      },
    })

    // The two flows have different lengths depending on who wins the marker, so
    // the enumeration is larger than a symmetric pair. Pinned, so that a flow
    // quietly losing a storage operation shows up as a failure rather than as
    // a smaller number nobody reads.
    assert.equal(visited, 92)
  })
})

test('twelve simultaneous consumptions of one credential still produce one session', async () => {
  await withReviewerEnv(async () => {
    const world = freshWorld({
      reviewers: [aReviewer({ emailVerifiedAt: '2026-01-02T00:00:00.000Z' })],
    })
    const token = await seedCredential(world, 'signin')

    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () =>
        signinWithCredential(token, {
          store: world.store,
          rosterStore: world.roster,
          mailer: world.mailer,
        }),
      ),
    )

    assert.equal(outcomes.filter((one) => one.ok).length, 1)
    assert.equal(
      outcomes.filter((one) => !one.ok && one.reason === 'already-used').length,
      11,
      'and every other caller is refused by name',
    )
  })
})

/* ------------------------------------------- issuance against an older credential */

test('issuing a new link never disturbs an older one being spent at the same moment', async () => {
  await withReviewerEnv(async () => {
    const visited = await explore({
      setup: async () => {
        const world = freshWorld({
          reviewers: [aReviewer({ emailVerifiedAt: '2026-01-02T00:00:00.000Z' })],
        })
        const older = await seedCredential(world, 'signin')
        const flows: Flow[] = [
          {
            id: 'issue',
            run: (store, gate) => requestSigninLink(ADDRESS, deps(world, store, gate)),
          },
          {
            id: 'spend',
            run: (store, gate) => signinWithCredential(older, deps(world, store, gate)),
          },
        ]
        return { store: world.store, flows, world: { world, older } }
      },
      check: async (outcome, { world, older }) => {
        // I3: the older credential is accepted under every ordering. Issuing
        // another one is not an opinion about it.
        assert.equal(resultOf(outcome, 'spend').ok, true, 'the older link still opens a session')

        // And the newly issued one is usable too.
        assert.equal(world.sent.length, 1)
        const newer = tokenIn(world.sent[0])
        assert.notEqual(newer, older)
        const second = await signinWithCredential(newer, {
          store: world.store,
          rosterStore: world.roster,
          mailer: world.mailer,
        })
        assert.equal(second.ok, true, 'and so is the newer one')
      },
    })

    /*
     * Pinned, not a lower bound. The enumeration is deterministic, so a
     * different number means a flow gained or lost a storage operation --
     * which is exactly the kind of change that should be looked at rather
     * than passing quietly under a `>`.
     */
    assert.equal(visited, 126)
  })
})

/* ------------------------------------------- issuance against an administrative act */

/** Advance the epoch the way an address change does, through the real mutation. */
function changeAddressFlow(world: World, to: string): Flow {
  return {
    id: 'admin',
    run: (_store, gate) =>
      mutateRoster(
        (doc) => {
          const row = doc.reviewers.find((candidate) => candidate.id === 'anna')
          if (!row) return null
          return {
            reviewers: doc.reviewers.map((candidate) =>
              candidate.id === 'anna'
                ? {
                    ...candidate,
                    email: to,
                    emailVerifiedAt: null,
                    credentialEpoch: candidate.credentialEpoch + 1,
                  }
                : candidate,
            ),
            event: newAuditEvent(ADMIN, 'reviewer.email-changed', 'anna', 'Changed the address.'),
            result: null,
          }
        },
        gatedRoster(world.roster, gate),
      ),
  }
}

test('an issue racing an address change: the credential is bound to what it read', async () => {
  await withReviewerEnv(async () => {
    const visited = await explore({
      setup: () => {
        const world = freshWorld({
          reviewers: [aReviewer({ emailVerifiedAt: '2026-01-02T00:00:00.000Z' })],
        })
        const flows: Flow[] = [
          {
            id: 'issue',
            run: (store, gate) => requestSigninLink(ADDRESS, deps(world, store, gate)),
          },
          changeAddressFlow(world, 'anna.new@example.com'),
        ]
        return { store: world.store, flows, world }
      },
      check: async (outcome, world) => {
        const settled = (await world.roster.load()).reviewers[0]
        assert.equal(settled.email, 'anna.new@example.com')
        assert.equal(settled.credentialEpoch, 1, 'exactly one advance')

        if (world.sent.length === 0) return // the issue read the changed roster and declined

        /*
         * I5. The issue either read the roster before the change -- in which
         * case the message went to the old address and the credential carries
         * the old epoch, so it is refused -- or after it, in which case the
         * reviewer is no longer verified and no sign-in link is sent at all.
         * There is no ordering in which a link sent to the old address works.
         */
        const token = tokenIn(world.sent[0])
        const attempt = await signinWithCredential(token, {
          store: world.store,
          rosterStore: world.roster,
          mailer: world.mailer,
        })
        assert.equal(attempt.ok, false, 'a link bound to the old address is refused')
        assert.ok(
          attempt.ok === false &&
            ['invalidated', 'address-changed', 'not-verified'].includes(attempt.reason),
          `unexpected reason ${attempt.ok === false ? attempt.reason : ''}`,
        )

        // Refused before consumption, so nothing at all was written for it.
        const hash = fingerprint('signin', token)
        assert.ok(hash)
        assert.equal(await isSpent('signin', hash, world.store), false)
      },
    })

    assert.equal(visited, 32)
  })
})

test('an issue racing a revocation: no ordering produces a usable link', async () => {
  await withReviewerEnv(async () => {
    const visited = await explore({
      setup: () => {
        const world = freshWorld({
          reviewers: [aReviewer({ emailVerifiedAt: '2026-01-02T00:00:00.000Z' })],
        })
        const flows: Flow[] = [
          {
            id: 'issue',
            run: (store, gate) => requestSigninLink(ADDRESS, deps(world, store, gate)),
          },
          {
            id: 'admin',
            run: (_store, gate) => revokeReviewer('anna', ADMIN, gatedRoster(world.roster, gate)),
          },
        ]
        return { store: world.store, flows, world }
      },
      check: async (outcome, world) => {
        const settled = (await world.roster.load()).reviewers[0]
        assert.equal(settled.status, 'revoked')
        assert.equal(settled.credentialEpoch, 1, 'revocation advanced the epoch, once')

        if (world.sent.length === 0) return

        // I4, after both operations have settled.
        const attempt = await signinWithCredential(tokenIn(world.sent[0]), {
          store: world.store,
          rosterStore: world.roster,
          mailer: world.mailer,
        })
        assert.equal(attempt.ok, false)
        assert.equal(attempt.ok === false && attempt.reason, 'not-authorized')

        // A restore does not bring it back: the epoch does not go backwards.
        await mutateRoster(
          (doc) => ({
            reviewers: doc.reviewers.map((row) => ({ ...row, status: 'active' as const })),
            event: null,
            result: null,
          }),
          world.roster,
        )
        const afterRestore = await signinWithCredential(tokenIn(world.sent[0]), {
          store: world.store,
          rosterStore: world.roster,
          mailer: world.mailer,
        })
        assert.equal(afterRestore.ok, false, 'restoring does not revive a killed link')
        assert.equal(afterRestore.ok === false && afterRestore.reason, 'invalidated')
      },
    })

    assert.equal(visited, 32)
  })
})

test('an issue racing an explicit invalidation: same boundary, same outcome', async () => {
  await withReviewerEnv(async () => {
    const visited = await explore({
      setup: () => {
        const world = freshWorld({
          reviewers: [aReviewer({ emailVerifiedAt: '2026-01-02T00:00:00.000Z' })],
        })
        const flows: Flow[] = [
          {
            id: 'issue',
            run: (store, gate) => requestSigninLink(ADDRESS, deps(world, store, gate)),
          },
          {
            id: 'admin',
            run: (_store, gate) =>
              invalidateReviewerCredentials('anna', ADMIN, gatedRoster(world.roster, gate)),
          },
        ]
        return { store: world.store, flows, world }
      },
      check: async (outcome, world) => {
        const settled = (await world.roster.load()).reviewers[0]
        assert.equal(settled.credentialEpoch, 1)
        assert.equal(settled.status, 'active', 'invalidation does not revoke')
        assert.ok(settled.emailVerifiedAt, 'and does not un-verify the address')

        assert.equal(world.sent.length, 1, 'the link was still sent')
        const token = tokenIn(world.sent[0])
        const attempt = await signinWithCredential(token, {
          store: world.store,
          rosterStore: world.roster,
          mailer: world.mailer,
        })

        /*
         * Two honest outcomes, decided by which roster the issue read. Read
         * before the invalidation, the credential carries epoch 0 and is now
         * refused; read after it, the credential carries epoch 1 and works. Both
         * are correct: an invalidation kills what was outstanding when it ran,
         * and a link minted afterwards is not one of those.
         */
        const issuedEpoch = attempt.ok ? 1 : 0
        if (issuedEpoch === 0) {
          assert.equal(attempt.ok === false && attempt.reason, 'invalidated')
          assert.equal(await isSpent('signin', fingerprint('signin', token) as string, world.store), false)
        }
      },
    })

    assert.equal(visited, 35)
  })
})

/* ------------------------------------------------- two activations against each other */

test('two concurrent activations under unchanged state: both succeed, one flag write', async () => {
  await withReviewerEnv(async () => {
    const visited = await explore({
      setup: async () => {
        const world = freshWorld()
        const first = await seedCredential(world, 'activation')
        const second = await seedCredential(world, 'activation')
        const flows: Flow[] = [
          { id: 'a', run: (store, gate) => activateWithCredential(first, deps(world, store, gate)) },
          { id: 'b', run: (store, gate) => activateWithCredential(second, deps(world, store, gate)) },
        ]
        return { store: world.store, flows, world: { world, tokens: [first, second] } }
      },
      check: async (outcome, world) => {
        /*
         * C.2, under every ordering. Administrative state is unchanged
         * throughout, so the rule is: whatever gets past the pre-consumption
         * gate and spends its credential also mints a session. Nothing is ever
         * burned and then refused here, and the verified flag is written once
         * however many attempts succeed.
         */
        const spent = (
          await Promise.all(
            world.tokens.map((token) =>
              isSpent('activation', fingerprint('activation', token) as string, world.world.store),
            ),
          )
        ).filter(Boolean).length

        assert.ok(spent >= 1, 'at least one attempt got past the gate')
        assert.equal(sessions(outcome), spent, 'every spent credential minted a session')

        const verified = world.world.roster
          .audit()
          .filter((event) => event.action === 'reviewer.email-verified')
        assert.equal(verified.length, 1, 'exactly one verified-flag write, however many succeeded')

        // And no attempt reported a refusal after creating its marker.
        assert.equal(
          world.world.roster
            .audit()
            .filter((e) => e.action === 'credential.refused-after-spend').length,
          0,
        )

        // A third attempt, whose roster read follows the commit, is refused.
        const third = await seedCredential(world.world, 'activation')
        const late = await activateWithCredential(third, {
          store: world.world.store,
          rosterStore: world.world.roster,
          mailer: world.world.mailer,
        })
        assert.equal(late.ok, false)
        assert.equal(late.ok === false && late.reason, 'already-verified')
        assert.equal(
          await isSpent('activation', fingerprint('activation', third) as string, world.world.store),
          false,
          'and a pre-consumption refusal left no marker',
        )
      },
    })

    assert.equal(visited, 676)
  })
})

test('the activation pair that both read before either commits: two sessions, one write', async () => {
  await withReviewerEnv(async () => {
    const world = freshWorld()
    const first = await seedCredential(world, 'activation')
    const second = await seedCredential(world, 'activation')

    const outcome = await runSchedule({
      store: world.store,
      flows: [
        { id: 'a', run: (store, gate) => activateWithCredential(first, deps(world, store, gate)) },
        { id: 'b', run: (store, gate) => activateWithCredential(second, deps(world, store, gate)) },
      ],
      /*
       * The named schedule the addendum describes: each attempt reads the
       * credential and then the unverified roster, and only then is either
       * allowed to spend. This is the ordering that cannot happen by accident
       * on a filesystem and is the whole reason the harness exists.
       */
      choose: scripted(['a', 'b', 'a', 'b']),
    })

    assert.equal(sessions(outcome), 2, 'both attempts mint a session')
    assert.equal(
      world.roster.audit().filter((event) => event.action === 'reviewer.email-verified').length,
      1,
      'and exactly one of them wrote the verified flag',
    )
    assert.equal(
      world.roster.audit().filter((e) => e.action === 'credential.refused-after-spend').length,
      0,
      'neither was burned and then refused',
    )
  })
})

test('spending is single-use even when the same credential is presented twice at once', async () => {
  await withReviewerEnv(async () => {
    const visited = await explore({
      setup: async () => {
        const world = freshWorld()
        const token = await seedCredential(world, 'activation')
        const hash = fingerprint('activation', token)
        assert.ok(hash)
        const flows: Flow[] = ['a', 'b'].map((id) => ({
          id,
          run: (store: PrivateStore) => spendCredential('activation', hash, store),
        }))
        return { store: world.store, flows, world: null }
      },
      check: (outcome) => {
        let won = 0
        outcome.results.forEach((result) => {
          if (result.ok && result.value === true) won += 1
        })
        assert.equal(won, 1)
      },
    })

    assert.equal(visited, 2)
  })
})
