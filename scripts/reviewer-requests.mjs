#!/usr/bin/env node
/**
 * reviewer-requests.mjs -- work the access-request queue from the command line.
 *
 * The dashboard at `/admin` is the real place to do this. This exists for the
 * same reason `reviewer-code.mjs` does: the dashboard is behind Google sign-in,
 * and a local development machine has no Google client registered for its own
 * address, so the administrative half of this feature cannot be driven in a
 * browser locally. Rather than weaken that gate for convenience -- which would
 * be the wrong trade, permanently, for a local one -- the same library
 * functions are offered here, to somebody who already has the deployment's
 * secrets in their own shell.
 *
 * **It grants nothing the dashboard does not.** It calls exactly the operations
 * `/admin/api/requests` calls, with the same validation, the same audit lines
 * and the same refusals. It is not a bypass: possessing the roster secret and
 * the store already *is* the administrator's position.
 *
 * **It never prints a credential.** Approving mails a one-time link through the
 * configured driver -- locally the file outbox -- and the link exists only in
 * that message. Nothing here can show it to you, and nor can the dashboard.
 *
 * Usage, from the repository root:
 *
 *   node scripts/reviewer-requests.mjs list
 *   node scripts/reviewer-requests.mjs approve --id <requestId> [--books a,b]
 *   node scripts/reviewer-requests.mjs decline --id <requestId>
 *   node scripts/reviewer-requests.mjs resend  --id <requestId>
 *
 * Configuration is read from the environment, and from `.env.local` when one is
 * present -- the same file the dev server reads. Values are never printed.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/* Load `.env.local` exactly as far as this needs: KEY=VALUE, one per line. */
const envFile = join(process.cwd(), '.env.local')
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (!(key in process.env)) process.env[key] = value
  }
}

const { listRequests } = await import('../lib/reviewer-requests.ts')
const { assignableBookSlugs } = await import('../lib/reviewer-admin.ts')
const { approveRequest, cancelApproval, declineRequest, sendAccessEmailForRequest, loadRequestViews } =
  await import(
  '../lib/reviewer-onboarding.ts'
)

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index > -1 ? process.argv[index + 1] : undefined
}

const ACTOR = 'local-cli'

function describeDelivery(delivery) {
  if (!delivery) return 'nothing was sent'
  if (delivery.status === 'accepted') return 'handed to the mail driver'
  if (delivery.status === 'refused') return 'REFUSED by the mail driver'
  if (delivery.status === 'unreachable') return 'NOT DELIVERED -- the mail driver did not answer'
  return 'NOT SENT -- no mail driver is configured'
}

const command = process.argv[2]

if (command === 'list') {
  const views = await loadRequestViews(await listRequests())
  if (views.length === 0) {
    console.log('No access requests.')
  }
  for (const view of views) {
    const activation = view.activation?.usedAt
      ? 'activated'
      : view.activationOutstanding
        ? 'access email outstanding'
        : view.status === 'approved'
          ? 'no live access email'
          : '-'
    console.log(
      [
        view.id,
        view.status.padEnd(9),
        activation.padEnd(24),
        view.name,
        `<${view.email}>`,
      ].join('  '),
    )
  }
  process.exit(0)
}

const id = arg('id')
if (!id) {
  console.error('Give --id <requestId>. Run `list` to see them.')
  process.exit(1)
}

try {
  if (command === 'approve') {
    const books = (arg('books') ?? assignableBookSlugs().join(','))
      .split(',')
      .map((slug) => slug.trim())
      .filter(Boolean)

    const result = await approveRequest({ requestId: id, books, actor: ACTOR })
    console.log(`Approved. Reviewer id: ${result.reviewerId}`)
    console.log(`Books: ${books.join(', ') || 'none'}`)
    console.log(`Access email: ${describeDelivery(result.delivery)}`)
    console.log('The one-time link is in the message only. It cannot be printed here.')
  } else if (command === 'decline') {
    await declineRequest({ requestId: id, actor: ACTOR })
    console.log('Declined. Nothing was emailed.')
  } else if (command === 'resend') {
    const result = await sendAccessEmailForRequest({ requestId: id, actor: ACTOR })
    const what = result.purpose === 'signin' ? 'A SIGN-IN email' : 'An ACTIVATION email'
    console.log(`${what}: ${describeDelivery(result.delivery)}`)
    console.log(
      result.purpose === 'signin'
        ? 'They have already proved this address, so an activation link would not work for them.'
        : 'Using it proves the address and turns on email sign-in.',
    )
    console.log('Earlier links keep working until they expire.')
  } else if (command === 'cancel') {
    await cancelApproval({ requestId: id, actor: ACTOR })
    console.log('Approval cancelled. The request is closed.')
    console.log('The reviewer stays revoked and stays on the roster; nothing was emailed.')
  } else {
    console.error('Commands: list | approve | decline | resend | cancel')
    process.exit(1)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'That could not be completed.')
  process.exit(1)
}
