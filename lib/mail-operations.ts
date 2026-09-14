/**
 * One email as a durable operation, so that a process dying at the wrong moment
 * cannot quietly turn into a second message, a lost account, or a claim of
 * delivery nobody can support.
 *
 * ## The window this exists to close
 *
 * Handing a message to a mail service and writing down what it said are two
 * separate acts, and there is an interval between them:
 *
 *     send  ──►  the service accepts  ──►  ✗ the process dies  ──►  nothing recorded
 *
 * From the outside afterwards, that is indistinguishable from "the send never
 * happened". A retry that assumes the latter sends a second message; a retry
 * that assumes the former may leave somebody with no email at all. Neither
 * assumption is safe, and an earlier version of this feature made the first one
 * implicitly, by minting a fresh credential — and therefore a fresh
 * idempotency key — every time an approval was retried.
 *
 * So the operation is written down **before** the provider is called, and
 * settled afterwards:
 *
 *     mail/v2/ops/<keyed label of the idempotency key>.json
 *
 * A record left at `in-flight` is exactly the crash above, and it is reported
 * as `uncertain` rather than guessed in either direction.
 *
 * The claim is a create-if-absent, so it has exactly one owner. The settle is
 * nevertheless a **conditional** write, against the revision the claim itself
 * returned: single ownership is a property of the current code, and the point
 * of removing the unconditional primitive from `PrivateStore` is that no future
 * edit can reintroduce a last-writer-wins path here by forgetting it.
 *
 * ## What is guaranteed, stated as precisely as it can be
 *
 * An earlier version of this comment said "at most one message is handed to the
 * provider" two paragraphs above saying that an uncertain answer is re-offered
 * once. Both cannot be true, and the second one is. The guarantee is therefore
 * split into the part this application owns and the part Resend owns:
 *
 * **This application makes at most two provider calls for one stable
 * operation.** A `settled` operation is never re-offered — a later attempt on
 * that key returns what was recorded — and an operation left `in-flight` is
 * never re-offered either; it reports `uncertain`. The two calls are the first
 * attempt and one re-offer of an uncertain answer, with the *same* message and
 * the *same* key.
 *
 * **Resend processes at most one email for one idempotency key carrying an
 * identical payload, within its documented idempotency window (24 hours).**
 * That, and not the call count, is what makes the re-offer safe. It is the
 * provider's guarantee, it is bounded by that window, and it holds only because
 * the re-offered payload is byte-identical to the first.
 *
 * **There is no exactly-once delivery here, and no guarantee of delivery at
 * all.** A refused, unconfigured, or permanently uncertain operation may
 * deliver **zero** messages — which is why this is deliberately *not* described
 * as at-least-once either.
 *
 * What is no longer claimed, because the design that needed it is gone: there
 * is no ordering between access emails. Every emailed credential that has not
 * expired and has not been used **works**, once, until Mike revokes the
 * reviewer, changes their address, or invalidates their outstanding links. So a
 * pair of clicks produces two working emails rather than possibly none, and no
 * accepted message is ever an unusable one.
 *
 * The plaintext credential exists only in memory, for as long as it takes to
 * put it in a message (see `lib/auth-credentials.ts`), so a message whose fate
 * is unknown can never be re-sent verbatim — there is nothing left to re-send.
 * Pressing "Send a new access email" is therefore a genuinely new operation
 * with a new credential and a new key; the earlier link keeps working until it
 * expires.
 *
 * An idempotency key is **never** regenerated because a response was lost. It is
 * a pure function of the operation — `activation:<requestId>:<operationId>` —
 * and it changes only when a new credential is genuinely minted. The operation
 * id is the whole of the identity because a generation was never enough: two
 * simultaneous issues once minted two different tokens under one generation, so
 * two different payloads shared one key and the claim below suppressed one of
 * them. There are no generations any more, and every credential carries its own
 * random operation id, so two messages can never share a key.
 *
 * Nothing here stores a credential, a link, a message body or an address. The
 * record holds the operation key, a status, a count, two timestamps, the mail
 * service's own message id when it gave one, and a short failure class.
 */

import { createPrivateStore, pathLabel, type PrivateStore } from './private-store.ts'
import type { Mailer, MailMessage, MailResult } from './mailer.ts'

if (typeof window !== 'undefined') {
  throw new Error(
    'lib/mail-operations is server-only and must not be imported by a client component',
  )
}

/** `v2`, moving with the keyed label's change to a real HMAC. */
export const MAIL_OPS_ROOT = 'mail/v2/ops'

/**
 * `in-flight` is not a transient state a reader can ignore. It means a message
 * was handed over and the answer was never written down, which is the one
 * outcome that must not be mistaken for either success or failure.
 */
export type MailOperationStatus =
  | 'in-flight'
  | 'accepted'
  | 'refused'
  | 'uncertain'
  | 'not-configured'

export type MailOperationRecord = {
  schema: 1
  /** The idempotency key. Identifies the operation; is not a secret. */
  key: string
  status: MailOperationStatus
  /** How many times the provider has been called for this key. */
  attempts: number
  startedAt: string
  settledAt: string | null
  /** The mail service's own message id, when it gave one. Not a secret. */
  providerId: string | null
  /** A short failure class. Never a credential, an address or a link. */
  error: string | null
}

/** How many times one operation may be re-offered to the provider, same key. */
const PROVIDER_ATTEMPTS = 2

export function mailOperationPath(key: string): string {
  return `${MAIL_OPS_ROOT}/${pathLabel('mail-op', key)}.json`
}

function parseOperation(raw: string | null): MailOperationRecord | null {
  if (raw === null) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return null
    const row = value as Record<string, unknown>
    if (row.schema !== 1) return null
    const status = row.status
    if (
      status !== 'in-flight' &&
      status !== 'accepted' &&
      status !== 'refused' &&
      status !== 'uncertain' &&
      status !== 'not-configured'
    ) {
      return null
    }
    return {
      schema: 1,
      key: typeof row.key === 'string' ? row.key : '',
      status,
      attempts: typeof row.attempts === 'number' ? row.attempts : 0,
      startedAt: typeof row.startedAt === 'string' ? row.startedAt : '',
      settledAt: typeof row.settledAt === 'string' ? row.settledAt : null,
      providerId: typeof row.providerId === 'string' ? row.providerId : null,
      error: typeof row.error === 'string' ? row.error : null,
    }
  } catch {
    return null
  }
}

export async function readMailOperation(
  key: string,
  store: PrivateStore = createPrivateStore(),
): Promise<MailOperationRecord | null> {
  return parseOperation(await store.read(mailOperationPath(key)))
}

/** Whether this operation has reached an answer anybody can act on. */
export function isSettled(record: MailOperationRecord | null): boolean {
  if (!record) return false
  return record.status === 'accepted' || record.status === 'refused' || record.status === 'not-configured'
}

function resultOf(record: MailOperationRecord): MailResult {
  if (record.status === 'in-flight') {
    return { status: 'uncertain', providerId: null, error: 'previous_attempt_unrecorded' }
  }
  return {
    status: record.status,
    providerId: record.providerId,
    error: record.error,
  }
}

function serialize(record: MailOperationRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`
}

/**
 * Run one mail operation: up to two provider calls, and one durable outcome.
 *
 * The operation is claimed with create-if-absent, so two callers carrying the
 * same key cannot both start one: the loser reads what the winner recorded. A
 * record that exists but never settled is reported as `uncertain` and **nothing
 * further is sent** — see the header comment for why re-sending it is not
 * possible anyway.
 *
 * Within a claim, an uncertain answer from the provider is re-offered **once**,
 * with the same message and the same key. So this function calls the provider
 * at most twice, and that is safe not because of the count but because Resend
 * processes at most one email per key and identical payload inside its
 * idempotency window.
 */
export async function sendMailOperation(
  mailer: Mailer,
  message: MailMessage,
  store: PrivateStore = createPrivateStore(),
  nowMs: number = Date.now(),
): Promise<MailResult> {
  const path = mailOperationPath(message.idempotencyKey)
  const startedAt = new Date(nowMs).toISOString()

  const opened: MailOperationRecord = {
    schema: 1,
    key: message.idempotencyKey,
    status: 'in-flight',
    attempts: 0,
    startedAt,
    settledAt: null,
    providerId: null,
    error: null,
  }

  let claim: { created: boolean; version: string | null }
  try {
    claim = await store.create(path, serialize(opened))
  } catch {
    /*
     * No durable record is possible. Sending anyway would be a message nobody
     * could ever account for, so this refuses instead — and refuses in the
     * direction that loses an email rather than the one that loses the record
     * of it.
     */
    return { status: 'uncertain', providerId: null, error: 'no_operation_log' }
  }

  if (!claim.created) {
    const existing = await readMailOperation(message.idempotencyKey, store)
    // Unreadable is treated exactly as unsettled: it is not evidence of
    // anything, and the safe reading is "this may already have gone".
    if (!existing) {
      return { status: 'uncertain', providerId: null, error: 'operation_unreadable' }
    }
    return resultOf(existing)
  }

  let result: MailResult = { status: 'uncertain', providerId: null, error: 'not_attempted' }
  let attempts = 0

  for (let attempt = 0; attempt < PROVIDER_ATTEMPTS; attempt += 1) {
    attempts += 1
    try {
      result = await mailer.send(message)
    } catch {
      // A driver that threw told us nothing about whether it sent.
      result = { status: 'uncertain', providerId: null, error: 'driver_threw' }
    }
    if (result.status !== 'uncertain') break
  }

  const settled: MailOperationRecord = {
    ...opened,
    // `unreachable` is folded into `uncertain` because that is what it means.
    status: result.status === 'unreachable' ? 'uncertain' : result.status,
    attempts,
    settledAt: new Date(nowMs).toISOString(),
    providerId: result.providerId,
    error: result.error,
  }

  /*
   * Conditional on the revision the claim returned. This process is the
   * operation's only owner, so the condition is expected always to hold -- and
   * it is written anyway, because a settle that could not land must be reported
   * as uncertain rather than forced through. There is no unconditional write on
   * the store's interface to force it with.
   */
  let recorded: boolean
  try {
    recorded = await store.writeIfMatch(path, serialize(settled), claim.version)
  } catch {
    recorded = false
  }
  if (!recorded) {
    /*
     * The message may well have gone; the record of it did not land. Reported
     * as uncertain rather than as the success it might have been, because the
     * next reader of this operation will see `in-flight` and must agree.
     */
    return { status: 'uncertain', providerId: result.providerId, error: 'outcome_unrecorded' }
  }

  return {
    // `settled.status` cannot be `in-flight` here -- it was just written from a
    // provider answer -- and saying so in the type rather than in a comment is
    // what stops a later edit from making it possible.
    status: settled.status === 'in-flight' ? 'uncertain' : settled.status,
    providerId: settled.providerId,
    error: settled.error,
  }
}
