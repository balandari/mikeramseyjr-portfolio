import test from 'node:test'
import assert from 'node:assert/strict'

import type { PrivateStore } from '../lib/private-store.ts'
import { credentialEmailLabel, fingerprint, isSpent, issueCredential } from '../lib/auth-credentials.ts'
import {
  RosterConflictError,
  mutateRoster,
  newAuditEvent,
  type ReviewerRosterStore,
} from '../lib/reviewer-roster.ts'
import { activateWithCredential, signinWithCredential, setReviewerEmail } from '../lib/reviewer-onboarding.ts'
import { invalidateReviewerCredentials, revokeReviewer } from '../lib/reviewer-admin.ts'
import { runSchedule, scripted, type Flow, type Gate } from './helpers/scheduled-store.ts'
import {
  ADMIN,
  aReviewer,
  freshWorld,
  gatedRoster,
  withReviewerEnv,
  type World,
} from './helpers/reviewer-world.ts'

/*
 * The boundary the last architectural correction is about.
 *
 * Creating the used marker spends a credential **permanently**. It does not
 * authorize anything. An earlier version of this design said that an attempt
 * which had already linearized at the marker could mint its session even when
 * an administrative change committed underneath it, on the grounds that this
 * was harmless. It is not harmless: the holder of a mailbox Mike had just
 * corrected away from would get a one-year reading session, and Mike would have
 * no signal that it existed.
 *
 * So the rule is: **where a credential consumption and an administrative
 * security action are concurrent, the administrative action wins.** The
 * credential stays spent, no session is minted, no authorization is granted,
 * and the attempt is recorded as `credential.refused-after-spend` -- with the
 * reviewer id, the purpose and the reason, and nothing else. The visitor sees
 * the same generic failure page everybody else sees.
 *
 * Every test here drives the boundary with a named schedule rather than hoping
 * for it: the attempt is released through its marker, the administrative change
 * is released to completion, and only then is the attempt allowed to reach its
 * roster decision. That interleaving does not happen by accident on a
 * filesystem, which is exactly why it needs the harness.
 */

const ADDRESS = 'anna@example.com'
const VERIFIED = '2026-01-02T00:00:00.000Z'

function deps(world: World, store: PrivateStore, gate: Gate) {
  return { store, rosterStore: gatedRoster(world.roster, gate), mailer: world.mailer }
}

async function seed(
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

/** Every administrative act that advances the epoch, as a schedulable flow. */
function adminFlows(world: World): Record<string, (gate: Gate) => Promise<unknown>> {
  return {
    revocation: (gate) => revokeReviewer('anna', ADMIN, gatedRoster(world.roster, gate)),
    'an address change': (gate) =>
      setReviewerEmail(
        { reviewerId: 'anna', email: 'anna.new@example.com', actor: ADMIN },
        { store: world.store, rosterStore: gatedRoster(world.roster, gate), mailer: world.mailer },
      ),
    'an explicit invalidation': (gate) =>
      invalidateReviewerCredentials('anna', ADMIN, gatedRoster(world.roster, gate)),
  }
}

function refusedAfterSpend(world: World) {
  return world.roster.audit().filter((event) => event.action === 'credential.refused-after-spend')
}

/* ------------------------------- the boundary, for activation and for sign-in */

for (const which of ['revocation', 'an address change', 'an explicit invalidation'] as const) {
  test(`${which} landing between an activation's marker and its roster decision`, async () => {
    await withReviewerEnv(async () => {
      const world = freshWorld()
      const token = await seed(world, 'activation')
      const hash = fingerprint('activation', token)
      assert.ok(hash)

      const admin = adminFlows(world)[which]
      const flows: Flow[] = [
        { id: 'act', run: (store, gate) => activateWithCredential(token, deps(world, store, gate)) },
        { id: 'admin', run: (_store, gate) => admin(gate) },
      ]

      const outcome = await runSchedule({
        store: world.store,
        flows,
        /*
         * Three steps of the activation -- credential, roster, marker -- then
         * the administrative change to completion, and only then the
         * activation's roster decision.
         */
        choose: scripted(['act', 'act', 'act', 'admin', 'admin', 'admin']),
      })

      const result = outcome.results.get('act')
      assert.ok(result?.ok)
      const value = (result as { value: { ok: boolean; reason?: string } }).value

      assert.equal(value.ok, false, 'no session is minted')
      assert.ok(
        ['not-authorized', 'address-changed', 'invalidated'].includes(value.reason as string),
        `unexpected reason ${value.reason}`,
      )

      // The marker remains. It is a fence, not residue.
      assert.equal(await isSpent('activation', hash, world.store), true)

      // No verified flag was written.
      assert.equal(
        world.roster.audit().filter((e) => e.action === 'reviewer.email-verified').length,
        0,
      )
      assert.equal((await world.roster.load()).reviewers[0].emailVerifiedAt, null)

      // The refusal is recorded, and carries nothing it should not.
      const audited = refusedAfterSpend(world)
      assert.equal(audited.length, 1)
      assert.equal(audited[0].reviewerId, 'anna')
      assert.match(audited[0].detail, /spent activation link was refused/)
      assert.ok(!audited[0].detail.includes(ADDRESS), 'no address in the audit line')
      assert.ok(!audited[0].detail.includes(token), 'and no credential')
    })
  })

  test(`${which} landing between a sign-in's marker and its roster re-read`, async () => {
    await withReviewerEnv(async () => {
      const world = freshWorld({ reviewers: [aReviewer({ emailVerifiedAt: VERIFIED })] })
      const token = await seed(world, 'signin')
      const hash = fingerprint('signin', token)
      assert.ok(hash)

      const admin = adminFlows(world)[which]
      const flows: Flow[] = [
        { id: 'act', run: (store, gate) => signinWithCredential(token, deps(world, store, gate)) },
        { id: 'admin', run: (_store, gate) => admin(gate) },
      ]

      const outcome = await runSchedule({
        store: world.store,
        flows,
        choose: scripted(['act', 'act', 'act', 'admin', 'admin', 'admin']),
      })

      const result = outcome.results.get('act')
      assert.ok(result?.ok)
      const value = (result as { value: { ok: boolean; reason?: string } }).value

      assert.equal(value.ok, false, 'no session is minted')
      assert.equal(await isSpent('signin', hash, world.store), true, 'and the marker remains')

      const audited = refusedAfterSpend(world)
      assert.equal(audited.length, 1)
      assert.match(audited[0].detail, /spent sign-in link was refused/)
      assert.ok(!audited[0].detail.includes(ADDRESS))
      assert.ok(!audited[0].detail.includes(token))

      // No sign-in was recorded either: the attempt did not authenticate.
      assert.equal(world.roster.audit().filter((e) => e.action === 'signin.used').length, 0)
    })
  })
}

/* ------------------------------------------------ what the boundary preserves */

test('an email change does not end an existing session, but does stop a new one', async () => {
  await withReviewerEnv(async () => {
    const world = freshWorld({ reviewers: [aReviewer({ emailVerifiedAt: VERIFIED })] })

    // One session is minted honestly, before anything changes.
    const before = await signinWithCredential(await seed(world, 'signin'), {
      store: world.store,
      rosterStore: world.roster,
      mailer: world.mailer,
    })
    assert.equal(before.ok, true)

    const outstanding = await seed(world, 'signin')
    await setReviewerEmail(
      { reviewerId: 'anna', email: 'anna.new@example.com', actor: ADMIN },
      { store: world.store, rosterStore: world.roster, mailer: world.mailer },
    )

    const entry = (await world.roster.load()).reviewers[0]
    assert.equal(entry.status, 'active', 'the reviewer is not revoked by an address change')
    assert.equal(entry.emailVerifiedAt, null, 'the new address is unproved')
    assert.equal(entry.credentialEpoch, 1, 'and the epoch advanced, in the same mutation')

    /*
     * The session that already exists is untouched -- it is bound to the
     * reviewer id and the code fingerprint, not to an address, and ending it is
     * what "New code" and "Revoke" are for. What the change does guarantee is
     * that no credential from the previous era can mint a *new* one.
     */
    const after = await signinWithCredential(outstanding, {
      store: world.store,
      rosterStore: world.roster,
      mailer: world.mailer,
    })
    assert.equal(after.ok, false)
  })
})

test('an address changed from A to B and back to A does not revive a link sent to the first A', async () => {
  await withReviewerEnv(async () => {
    const world = freshWorld({ reviewers: [aReviewer({ emailVerifiedAt: VERIFIED })] })
    const token = await seed(world, 'signin')

    const options = { store: world.store, rosterStore: world.roster, mailer: world.mailer }
    await setReviewerEmail({ reviewerId: 'anna', email: 'anna.new@example.com', actor: ADMIN }, options)
    await setReviewerEmail({ reviewerId: 'anna', email: ADDRESS, actor: ADMIN }, options)

    const entry = (await world.roster.load()).reviewers[0]
    assert.equal(entry.email, ADDRESS, 'the address is the original one again')
    assert.equal(entry.credentialEpoch, 2, 'and the epoch advanced twice')

    /*
     * This is the case address binding alone cannot close: the label matches
     * again, so a design that checked only the address would let the old link
     * back in. The epoch is what closes it, and it is compared for equality
     * rather than ordering, so there is no clock and no skew involved.
     */
    const attempt = await signinWithCredential(token, options)
    assert.equal(attempt.ok, false)
    assert.equal(attempt.ok === false && attempt.reason, 'invalidated')
    assert.equal(
      await isSpent('signin', fingerprint('signin', token) as string, world.store),
      false,
      'refused before consumption, so nothing was written',
    )
    assert.equal(refusedAfterSpend(world).length, 0)
  })
})

test('two epoch rotations in the same millisecond still differ', async () => {
  await withReviewerEnv(async () => {
    const world = freshWorld({ reviewers: [aReviewer({ emailVerifiedAt: VERIFIED })] })

    await invalidateReviewerCredentials('anna', ADMIN, world.roster)
    const between = await seed(world, 'signin', { epoch: 1 })
    await invalidateReviewerCredentials('anna', ADMIN, world.roster)

    /*
     * An integer, not a timestamp. Two rotations inside one millisecond would
     * produce the same ISO string, which is exactly the trap `updatedAt` had to
     * be nudged around; there is no clock here to collide.
     */
    assert.equal((await world.roster.load()).reviewers[0].credentialEpoch, 2)

    const attempt = await signinWithCredential(between, {
      store: world.store,
      rosterStore: world.roster,
      mailer: world.mailer,
    })
    assert.equal(attempt.ok, false)
    assert.equal(attempt.ok === false && attempt.reason, 'invalidated')
  })
})

test('concurrent administrative acts both land: no lost update on the epoch', async () => {
  await withReviewerEnv(async () => {
    const world = freshWorld({ reviewers: [aReviewer({ emailVerifiedAt: VERIFIED })] })

    const flows: Flow[] = ['a', 'b'].map((id) => ({
      id,
      run: (_store, gate) =>
        invalidateReviewerCredentials('anna', ADMIN, gatedRoster(world.roster, gate)),
    }))

    // Both read the same document before either writes: the lost-update opening.
    await runSchedule({ store: world.store, flows, choose: scripted(['a', 'b', 'a', 'b']) })

    assert.equal(
      (await world.roster.load()).reviewers[0].credentialEpoch,
      2,
      'two increments landed; the conflicting one re-derived from the winner',
    )
    assert.equal(
      world.roster.audit().filter((e) => e.action === 'reviewer.credentials-invalidated').length,
      2,
      'and both audit lines are present',
    )
  })
})

/* ----------------------------------------------------- conflict exhaustion */

test('a bookkeeping mutation that cannot land refuses, keeps the marker, and audits', async () => {
  await withReviewerEnv(async () => {
    const world = freshWorld()
    const token = await seed(world, 'activation')
    const hash = fingerprint('activation', token)
    assert.ok(hash)

    /*
     * A roster whose conditional write never lands, which is what exhausting
     * the bounded retries looks like from inside `mutateRoster`. The safe
     * direction is refusal with the marker kept -- never "mint anyway", and
     * never a second attempt at the marker.
     */
    let saves = 0
    const alwaysConflicts: ReviewerRosterStore = {
      driver: world.roster.driver,
      writable: true,
      load: () => world.roster.load(),
      loadForUpdate: () => world.roster.loadForUpdate(),
      async save() {
        saves += 1
        throw new RosterConflictError()
      },
      appendAudit: (event) => world.roster.appendAudit(event),
      listAudit: (limit) => world.roster.listAudit(limit),
    }

    const outcome = await activateWithCredential(token, {
      store: world.store,
      rosterStore: alwaysConflicts,
      mailer: world.mailer,
    })

    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false && outcome.reason, 'conflict')
    assert.equal(saves, 5, 'the retries are bounded, and were all spent')
    assert.equal(await isSpent('activation', hash, world.store), true, 'the marker remains')
    assert.equal((await world.roster.load()).reviewers[0].emailVerifiedAt, null)

    const audited = refusedAfterSpend(world)
    assert.equal(audited.length, 1)
    assert.match(audited[0].detail, /could not be read consistently/)
  })
})

test('a failure to write the audit line does not turn a refusal into a success', async () => {
  await withReviewerEnv(async () => {
    const world = freshWorld()
    const token = await seed(world, 'activation')

    const refusing: ReviewerRosterStore = {
      driver: world.roster.driver,
      writable: true,
      load: () => world.roster.load(),
      loadForUpdate: () => world.roster.loadForUpdate(),
      save: (next, expected, version) => world.roster.save(next, expected, version),
      async appendAudit() {
        throw new Error('the audit log is unavailable')
      },
      listAudit: (limit) => world.roster.listAudit(limit),
    }

    // Revoke first, so the activation is refused after its marker.
    await revokeReviewer('anna', ADMIN, world.roster)

    const outcome = await activateWithCredential(token, {
      store: world.store,
      rosterStore: refusing,
      mailer: world.mailer,
    })

    assert.equal(outcome.ok, false, 'still a refusal, with nowhere to record it')
  })
})

/* --------------------------------- every pre-consumption refusal writes nothing */

test('every refusal decided before consumption leaves no marker and no roster change', async () => {
  await withReviewerEnv(async () => {
    const cases: { name: string; prepare: (world: World) => Promise<string> }[] = [
      {
        name: 'unknown',
        prepare: async () => 'T'.repeat(43),
      },
      {
        name: 'expired',
        prepare: async (world) => {
          const issued = await issueCredential(
            'signin',
            {
              reviewerId: 'anna',
              emailLabel: credentialEmailLabel(ADDRESS),
              credentialEpoch: 0,
              ttlMs: -1,
            },
            world.store,
          )
          assert.ok(issued)
          return issued.token
        },
      },
      {
        name: 'not-authorized',
        prepare: async (world) => {
          const token = await seed(world, 'signin')
          await revokeReviewer('anna', ADMIN, world.roster)
          return token
        },
      },
      {
        name: 'address-changed',
        prepare: async (world) => {
          const token = await seed(world, 'signin', { address: 'someone.else@example.com' })
          return token
        },
      },
      {
        name: 'invalidated',
        prepare: async (world) => {
          const token = await seed(world, 'signin')
          await invalidateReviewerCredentials('anna', ADMIN, world.roster)
          return token
        },
      },
    ]

    for (const one of cases) {
      const world = freshWorld({ reviewers: [aReviewer({ emailVerifiedAt: VERIFIED })] })
      const token = await one.prepare(world)

      const before = world.store.paths().length
      const outcome = await signinWithCredential(token, {
        store: world.store,
        rosterStore: world.roster,
        mailer: world.mailer,
      })

      assert.equal(outcome.ok, false, one.name)
      assert.equal(world.store.paths().length, before, `${one.name}: nothing was written`)
      assert.equal(refusedAfterSpend(world).length, 0, `${one.name}: and nothing was audited`)

      const hash = fingerprint('signin', token)
      if (hash) assert.equal(await isSpent('signin', hash, world.store), false, one.name)
    }
  })
})

/* ----------------------------------------------------------- the epoch itself */

test('revocation, an address change and an explicit invalidation each advance the epoch once', async () => {
  await withReviewerEnv(async () => {
    for (const [name, act] of [
      ['revocation', (world: World) => revokeReviewer('anna', ADMIN, world.roster)],
      [
        'an address change',
        (world: World) =>
          setReviewerEmail(
            { reviewerId: 'anna', email: 'anna.new@example.com', actor: ADMIN },
            { store: world.store, rosterStore: world.roster, mailer: world.mailer },
          ),
      ],
      [
        'an explicit invalidation',
        (world: World) => invalidateReviewerCredentials('anna', ADMIN, world.roster),
      ],
    ] as const) {
      const world = freshWorld({ reviewers: [aReviewer({ emailVerifiedAt: VERIFIED })] })
      assert.equal((await world.roster.load()).reviewers[0].credentialEpoch, 0, name)
      await act(world)
      assert.equal((await world.roster.load()).reviewers[0].credentialEpoch, 1, name)
    }

    // Restoring a revoked reviewer does not decrement it.
    const world = freshWorld({ reviewers: [aReviewer({ emailVerifiedAt: VERIFIED })] })
    await revokeReviewer('anna', ADMIN, world.roster)
    await mutateRoster(
      (doc) => ({
        reviewers: doc.reviewers.map((row) => ({ ...row, status: 'active' as const })),
        event: newAuditEvent(ADMIN, 'reviewer.restored', 'anna', 'Restored.'),
        result: null,
      }),
      world.roster,
    )
    assert.equal((await world.roster.load()).reviewers[0].credentialEpoch, 1, 'restore never decrements')
  })
})

test('a roster entry written before epochs existed reads as zero and still works', async () => {
  await withReviewerEnv(async () => {
    const world = freshWorld()
    const legacy = aReviewer({ emailVerifiedAt: VERIFIED })
    // The shape an entry written before this pass would have: no field at all.
    const { credentialEpoch: _dropped, ...withoutEpoch } = legacy
    world.roster.seed([withoutEpoch as typeof legacy])

    assert.equal((await world.roster.load()).reviewers[0].credentialEpoch, 0)

    const token = await seed(world, 'signin', { epoch: 0 })
    const outcome = await signinWithCredential(token, {
      store: world.store,
      rosterStore: world.roster,
      mailer: world.mailer,
    })
    assert.equal(outcome.ok, true, 'a legacy entry is not locked out by the new check')
  })
})
