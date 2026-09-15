/**
 * Requests for reviewer access: what a stranger submits, and everything that
 * subsequently happens to it.
 *
 * A request is the one record in this system written by somebody who has not
 * been authorised for anything, so it is the one record whose every field is
 * treated as hostile until it has been cleaned. Nothing here is trusted for
 * attribution, nothing here grants anything, and nothing here is rendered
 * anywhere without escaping.
 *
 * ## Three fields, and no more
 *
 *   name      how Mike recognises whether he knows this person, and what the
 *             reader will greet them by afterwards
 *   email     the only way to tell them the answer, and afterwards the thing
 *             they sign in with
 *   message   the only basis Mike has for deciding about somebody he has never
 *             met
 *
 * There is no phone number, no address, no employer, no "how did you hear about
 * this", no marketing consent, and **no stored IP address or user agent**. The
 * rate limiter needs to tell clients apart; it does that with a keyed label
 * that lives in a pathname and expires with its window, and it never writes an
 * address down (see `lib/rate-limit.ts`).
 *
 * ## Why a duplicate cannot be created by racing, and why nothing can strand an
 * address
 *
 * **A request's identity is derived from its address**, and the record lives at
 * the path that identity names. So submitting is *one* operation:
 *
 *     requests/v2/records/<keyed label of the normalised address>.json
 *
 * created with create-if-absent. The first caller creates it; every other
 * caller is told the object exists and reads it. There is no separate index to
 * keep in step, no claim to acquire, no second write to be interrupted between,
 * and therefore **no partial state a crash can leave behind** — the whole
 * submission either happened or did not.
 *
 * That is the third and final shape of this code, and the first two are worth
 * recording because each one's failure is what produced the next:
 *
 *   1. *Index claimed, then record written.* A crash between the two left an
 *      index pointing at nothing, and the unconditional repair let two retries
 *      each create a request — one indexed, one an orphan no lookup could find.
 *   2. *Index, record, and a claim on the repair itself.* That fixed the orphan,
 *      but the claim was permanent and had no owner: if the repairer crashed
 *      after taking it, no later caller could ever acquire it, and the address
 *      was locked out for good with no request in existence. Reproduced before
 *      this repair.
 *   3. *One object, addressed by the address.* Nothing to claim, nothing to
 *      abandon, nothing to converge. The failure modes above are not repaired
 *      so much as deleted.
 *
 * The identity is a **keyed** label, so it is not reversible to the address and
 * cannot be guessed by somebody who knows one. Two consequences are real and are
 * written down rather than discovered later:
 *
 *   - **A removed request frees its address by freeing its path**, and a later
 *     request from that address takes the same id. The audit log is timestamped
 *     and ordered, so the timeline still reads correctly — but two entries a
 *     year apart can share an id, and that is deliberate, not an accident.
 *   - **Mail keys are not affected by that reuse.** Every credential carries its
 *     own random operation identity (`lib/auth-credentials.ts`), and every
 *     *request occurrence* carries `notificationId` — a fresh random value
 *     minted by the create-if-absent that brings the record into existence, and
 *     therefore never shared by two occurrences at one pathname.
 *
 *     That second identity is not decoration, and it was missing. The author's
 *     alert was keyed on the request id alone, so: decline a request, remove it,
 *     and let the same person apply again. The new pending request was stored
 *     correctly — and the alert carried a key a durable mail operation already
 *     held, so `sendMailOperation` returned the *old* outcome and Mike was never
 *     told anybody was waiting. The pathname still dedupes the current request;
 *     `notificationId` is what makes the second occurrence a second message.
 */

import { randomBytes } from 'node:crypto'

import { ORDERED_READ_CONCURRENCY, mapOrderedLimited } from './ordered-concurrency.ts'
import {
  createPrivateStore,
  pathLabel,
  type PrivateStore,
} from './private-store.ts'
import { isValidReviewerEmail, normalizeReviewerEmail } from './reviewer-roster.ts'

if (typeof window !== 'undefined') {
  throw new Error(
    'lib/reviewer-requests is server-only and must not be imported by a client component',
  )
}

/**
 * `v2` because the identity of a request is a keyed label and `pathLabel`
 * became a real HMAC in this pass. A record written under the old salted-digest
 * scheme must never be found -- or missed -- under the new one, so the prefix
 * moves with it.
 */
export const REQUESTS_PREFIX_VERSION = 'v2'
export const REQUESTS_ROOT = `requests/${REQUESTS_PREFIX_VERSION}`
export const REQUEST_RECORDS = `${REQUESTS_ROOT}/records`

/** Longest message a requester may write. Long enough to say who they are. */
export const MAX_MESSAGE_LENGTH = 600
export const MAX_NAME_LENGTH = 80

const REQUEST_ID_PATTERN = /^[a-f0-9]{24}$/

/** Same shape as a request id, so nothing downstream has to learn a second one. */
const NOTIFICATION_ID_PATTERN = /^[a-f0-9]{24}$/

/**
 * A fresh identity for one request occurrence.
 *
 * Random, not derived: two occurrences at one pathname must differ, and the only
 * thing that distinguishes them is that they were created at different moments
 * by different `create()` calls. Deriving it from the address, the clock or the
 * id would reintroduce exactly the collision it exists to prevent.
 */
export function newNotificationId(): string {
  return randomBytes(12).toString('hex')
}

/**
 * `approving` is not decoration. It is the state an approval is in after the
 * reviewer id has been claimed and before the whole transition has finished,
 * and it is what makes a failed approval resumable rather than either lost or
 * duplicated. See `lib/reviewer-onboarding.ts`.
 */
export type RequestStatus = 'pending' | 'approving' | 'approved' | 'declined'

export type DeliveryStatus =
  | 'accepted'
  | 'refused'
  /** The service was reached and may have taken it. See `lib/mail-operations.ts`. */
  | 'uncertain'
  /** Retained so records written before `uncertain` existed still parse. */
  | 'unreachable'
  | 'not-configured'

/**
 * What happened the last time this request caused an email.
 *
 * `accepted` deliberately does not say "delivered". The mail service accepting
 * a message is the most this system can ever know from the inside; whether it
 * reached a mailbox is not knowable here, and claiming it would be a lie in the
 * one place Mike is relying on to tell him the truth.
 */
export type DeliveryRecord = {
  /**
   * Which message this was. `signin` exists so that a sign-in link sent to an
   * already-verified reviewer is never recorded, rendered or audited as an
   * activation -- the two have different lifetimes and different meanings, and
   * saying "activation" about a fifteen-minute sign-in link would be a lie in
   * the one place Mike reads to find out what happened.
   */
  kind: 'author-alert' | 'activation' | 'signin'
  at: string
  status: DeliveryStatus
  /** The mail service's own message id, when it gave one. Not a secret. */
  providerId: string | null
  /** A short failure class. Never a credential, never a provider key. */
  error: string | null
}

/**
 * The activation credential this approval minted, named by its own fingerprint.
 *
 * There is no generation any more, because there is no "which one is current"
 * -- see `lib/auth-credentials.ts`. What the request record holds is enough to
 * answer the two questions the dashboard and a retried approval actually ask:
 * *is that credential still outstanding* (read its record, its used marker and
 * the reviewer's epoch), and *which mail operation carried it* (the operation
 * id, which is what the idempotency key is built from).
 *
 * Records written before this shape carried a `generation` and no hash. They
 * parse to `tokenHash: null`, which reads as "there is nothing here to resume
 * or report", and one more press mints a fresh credential. That is the correct
 * reading: a v1 credential lives under a prefix this code no longer looks at.
 */
export type ActivationState = {
  /** The credential's keyed fingerprint. Not the credential, and not reversible. */
  tokenHash: string | null
  /** The mail-operation identity that carried it. Not a secret. */
  operationId: string | null
  expiresAt: string | null
  usedAt: string | null
}

export type ReviewerRequest = {
  schema: 1
  id: string
  createdAt: string
  /** When this record last changed. Display only; see `mutateRequest`. */
  updatedAt: string
  name: string
  email: string
  message: string
  status: RequestStatus
  /** Claimed before the roster is touched, so a retry reuses it. */
  reviewerId: string | null
  /** The entitlements Mike chose, claimed at the same moment. */
  books: string[]
  decidedAt: string | null
  decidedBy: string | null
  activation: ActivationState | null
  delivery: DeliveryRecord | null
  /** When Mike was last told about this request. Throttles repeat alerts. */
  alertedAt: string | null
  /**
   * This occurrence's notification identity, or null for a record written
   * before the field existed.
   *
   * Minted once, by the create-if-absent that brought this record into being,
   * and never rewritten afterwards — so a request removed and resubmitted from
   * the same address gets a different one even though it gets the same id. It is
   * what the author-alert idempotency key is built from; see
   * `lib/mail-messages.ts`.
   *
   * Null reads as "the id alone is the identity", which is what a record from
   * before this change actually meant, and keeps its alert deduplicated the way
   * it has been all along.
   */
  notificationId: string | null
}

export class RequestConflictError extends Error {
  constructor() {
    super('That request changed while you were working on it. Reload and try again.')
    this.name = 'RequestConflictError'
  }
}

/* ------------------------------------------------------------- validation */

export function cleanRequestName(raw: unknown): string | null {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : ''
  if (!name || name.length > MAX_NAME_LENGTH) return null
  // Control characters have no business in a name and are how a log line or a
  // header gets broken in half.
  if (/[\u0000-\u001F\u007F]/.test(name)) return null
  return name
}

export function cleanRequestMessage(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const message = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '')
    .trim()
  if (!message || message.length > MAX_MESSAGE_LENGTH) return null
  return message
}

export function cleanRequestEmail(raw: unknown): string | null {
  const email = normalizeReviewerEmail(raw)
  if (!isValidReviewerEmail(email)) return null
  return email
}

/* ------------------------------------------------------------------ paths */

export function requestPath(id: string): string {
  if (!REQUEST_ID_PATTERN.test(id)) throw new Error('invalid request id')
  return `${REQUEST_RECORDS}/${id}.json`
}

/**
 * The identity of the request belonging to one address.
 *
 * Derived rather than random, which is what makes a submission a single
 * create-if-absent and leaves nothing to recover. Keyed with the deployment's
 * reviewer secret, so it does not reveal the address and cannot be computed by
 * somebody who knows one; twenty-four hex characters, which is the shape every
 * request id in this system has always had.
 */
export function requestIdForEmail(email: string): string {
  return pathLabel('request-email', normalizeReviewerEmail(email)).slice(0, 24)
}

/* ---------------------------------------------------------------- parsing */

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

export function parseRequest(raw: string | null): ReviewerRequest | null {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const row = parsed as Record<string, unknown>
  if (row.schema !== 1) return null

  const id = typeof row.id === 'string' ? row.id : ''
  if (!REQUEST_ID_PATTERN.test(id)) return null

  const status =
    row.status === 'approving' || row.status === 'approved' || row.status === 'declined'
      ? row.status
      : 'pending'

  const activation =
    typeof row.activation === 'object' && row.activation !== null
      ? (row.activation as Record<string, unknown>)
      : null

  const delivery =
    typeof row.delivery === 'object' && row.delivery !== null
      ? (row.delivery as Record<string, unknown>)
      : null

  return {
    schema: 1,
    id,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : new Date(0).toISOString(),
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : new Date(0).toISOString(),
    name: typeof row.name === 'string' ? row.name : '',
    email: normalizeReviewerEmail(row.email),
    message: typeof row.message === 'string' ? row.message : '',
    status,
    reviewerId: typeof row.reviewerId === 'string' ? row.reviewerId : null,
    books: asStringArray(row.books),
    decidedAt: typeof row.decidedAt === 'string' ? row.decidedAt : null,
    decidedBy: typeof row.decidedBy === 'string' ? row.decidedBy : null,
    activation: activation
      ? {
          tokenHash:
            typeof activation.tokenHash === 'string' && /^[a-f0-9]{64}$/.test(activation.tokenHash)
              ? activation.tokenHash
              : null,
          operationId:
            typeof activation.operationId === 'string' &&
            /^[a-f0-9]{24}$/.test(activation.operationId)
              ? activation.operationId
              : null,
          expiresAt: typeof activation.expiresAt === 'string' ? activation.expiresAt : null,
          usedAt: typeof activation.usedAt === 'string' ? activation.usedAt : null,
        }
      : null,
    delivery: delivery
      ? {
          kind:
            delivery.kind === 'activation'
              ? 'activation'
              : delivery.kind === 'signin'
                ? 'signin'
                : 'author-alert',
          at: typeof delivery.at === 'string' ? delivery.at : '',
          status:
            delivery.status === 'accepted' ||
            delivery.status === 'refused' ||
            delivery.status === 'uncertain' ||
            delivery.status === 'unreachable' ||
            delivery.status === 'not-configured'
              ? delivery.status
              : 'refused',
          providerId: typeof delivery.providerId === 'string' ? delivery.providerId : null,
          error: typeof delivery.error === 'string' ? delivery.error : null,
        }
      : null,
    alertedAt: typeof row.alertedAt === 'string' ? row.alertedAt : null,
    notificationId:
      typeof row.notificationId === 'string' && NOTIFICATION_ID_PATTERN.test(row.notificationId)
        ? row.notificationId
        : null,
  }
}

function serialize(request: ReviewerRequest): string {
  return `${JSON.stringify(request, null, 2)}\n`
}

/**
 * Strictly increasing, so the dashboard never shows two changes as simultaneous.
 *
 * It used to be the concurrency marker as well, which is why it has to be
 * nudged when the clock has not moved. That job now belongs to the stored
 * revision `mutateRequest` writes against, and this is a timestamp again.
 */
export function nextRequestUpdatedAt(previous: string, nowMs: number = Date.now()): string {
  const previousMs = Date.parse(previous)
  const baseline = Number.isFinite(previousMs) ? previousMs : 0
  return new Date(nowMs > baseline ? nowMs : baseline + 1).toISOString()
}

/* ------------------------------------------------------------- operations */

export async function loadRequest(
  id: string,
  store: PrivateStore = createPrivateStore(),
): Promise<ReviewerRequest | null> {
  if (!REQUEST_ID_PATTERN.test(id)) return null
  return parseRequest(await store.read(requestPath(id)))
}

/**
 * Every request, newest first.
 *
 * Read whole rather than paged: this is a handful of records, all of them are
 * wanted, and a partial list of "who is waiting" is a wrong answer rather than
 * a smaller one.
 */
export async function listRequests(
  store: PrivateStore = createPrivateStore(),
): Promise<ReviewerRequest[]> {
  const paths = await store.list(`${REQUEST_RECORDS}/`)

  /*
   * Eight at a time, for the same reason the audit page is: this list shares
   * the 2,500 ms post-commit refresh deadline, and one record per round trip
   * spends it. The mapper answers in `paths` order, so the sort below decides
   * the order exactly as it always did.
   *
   * It also rejects rather than skipping, which is the whole point here: an
   * unreadable record must not quietly shorten the waiting list. A partial
   * answer to "who is waiting" is a wrong answer, not a smaller one, and that
   * is a different policy from the audit page's.
   */
  const bodies = await mapOrderedLimited(paths, ORDERED_READ_CONCURRENCY, (path) =>
    store.read(path),
  )

  const requests: ReviewerRequest[] = []
  for (const body of bodies) {
    const request = parseRequest(body)
    if (request) requests.push(request)
  }
  requests.sort((a, b) =>
    a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt),
  )
  return requests
}

/** A request and the exact stored revision it was read from. */
export type VersionedRequest = {
  request: ReviewerRequest
  /** Opaque and driver-specific: an ETag on Blob, a content digest on disk. */
  version: string
}

/**
 * Read a request together with the revision it was read at, for a caller that
 * is about to write it back -- or remove it -- conditionally.
 */
export async function loadRequestVersioned(
  id: string,
  store: PrivateStore = createPrivateStore(),
): Promise<VersionedRequest | null> {
  if (!REQUEST_ID_PATTERN.test(id)) return null
  const { body, version } = await store.readVersioned(requestPath(id))
  if (body === null || version === null) return null
  const request = parseRequest(body)
  if (!request) return null
  return { request, version }
}

/** How many times a conflicting request mutation is re-applied before giving up. */
export const REQUEST_MUTATION_ATTEMPTS = 5

/**
 * What one request mutation is: a pure function from the record that is
 * actually stored to the record that should replace it.
 *
 * A function rather than a precomputed object, for the same reason
 * `mutateRoster` takes one: a conflict is retried by re-deriving the change
 * from the record that won, instead of writing a stale copy over it. It may be
 * called more than once, so it must have no side effects of its own.
 *
 * Returning `null` means "nothing to do", and nothing is written.
 */
export type RequestMutation<T> = (
  current: ReviewerRequest,
) => { next: ReviewerRequest; result: T } | null

export type RequestMutationOutcome<T> = {
  request: ReviewerRequest
  result: T
  /** True when the mutation decided there was nothing to write. */
  unchanged: boolean
}

/**
 * Apply one change to a request, against whatever is actually stored.
 *
 * This replaces a read-check-then-**unconditional**-overwrite that the module's
 * own comment admitted was "not compare-and-swap". It was the same lost-update
 * class the credential pointer had, on a record that holds `status`,
 * `reviewerId`, `activation`, `delivery` and `alertedAt` -- so a double-pressed
 * approve, an approval racing a resend, or an activation racing a resend could
 * silently drop a field. Now the write is conditional on the exact revision the
 * change was derived from, a conflict re-derives against the winner, and an
 * irreconcilable one is an honest `RequestConflictError` rather than a silent
 * overwrite.
 *
 * `updatedAt` is still written and still strictly increasing, because the
 * dashboard reads it; it is no longer load-bearing for concurrency.
 */
export async function mutateRequest<T>(
  id: string,
  apply: RequestMutation<T>,
  store: PrivateStore = createPrivateStore(),
  nowMs: number = Date.now(),
): Promise<RequestMutationOutcome<T>> {
  for (let attempt = 0; attempt < REQUEST_MUTATION_ATTEMPTS; attempt += 1) {
    const found = await loadRequestVersioned(id, store)
    if (!found) throw new RequestConflictError()

    const change = apply(found.request)
    if (!change) {
      return { request: found.request, result: undefined as T, unchanged: true }
    }

    const written: ReviewerRequest = {
      ...change.next,
      schema: 1,
      id: found.request.id,
      updatedAt: nextRequestUpdatedAt(found.request.updatedAt, nowMs),
    }

    if (await store.writeIfMatch(requestPath(id), serialize(written), found.version)) {
      return { request: written, result: change.result, unchanged: false }
    }
    // Somebody else wrote between the read and this write. Nothing of theirs was
    // overwritten and nothing of ours was written; derive again from the winner.
  }

  throw new RequestConflictError()
}

/**
 * The request for one address, if there is one.
 *
 * One read of one path. There is no index to consult and therefore no index to
 * be stale: the address *is* the location.
 */
export async function findRequestByEmail(
  email: string,
  store: PrivateStore = createPrivateStore(),
): Promise<ReviewerRequest | null> {
  return loadRequest(requestIdForEmail(email), store)
}

export type SubmitOutcome =
  | { outcome: 'created'; request: ReviewerRequest }
  | { outcome: 'existing'; request: ReviewerRequest }

/**
 * Record one new request, unless this address already has one.
 *
 * **One create-if-absent, and nothing else.** The address decides the path, so
 * the record is its own index: the first caller creates it and owns the
 * address; every other caller is told the object already exists and reads it.
 * Two simultaneous submissions produce one request and one identical answer,
 * and there is no intermediate state — no claim, no index, no second write — in
 * which a crash could leave anything to recover. See the header comment for the
 * two earlier shapes this replaces and why each failed.
 *
 * The loser of the race does not learn that it lost; every outcome this module
 * produces is reported to the visitor with the same words.
 */
export async function submitRequest(
  input: { name: string; email: string; message: string },
  store: PrivateStore = createPrivateStore(),
  nowMs: number = Date.now(),
): Promise<SubmitOutcome> {
  const id = requestIdForEmail(input.email)
  const at = new Date(nowMs).toISOString()

  const request: ReviewerRequest = {
    schema: 1,
    id,
    createdAt: at,
    updatedAt: at,
    name: input.name,
    email: normalizeReviewerEmail(input.email),
    message: input.message,
    status: 'pending',
    reviewerId: null,
    books: [],
    decidedAt: null,
    decidedBy: null,
    activation: null,
    delivery: null,
    alertedAt: null,
    // Fresh for this occurrence, every time. The path may have been used before;
    // this value never has.
    notificationId: newNotificationId(),
  }

  if ((await store.create(requestPath(id), serialize(request))).created) {
    return { outcome: 'created', request }
  }

  const existing = await loadRequest(id, store)
  if (existing) return { outcome: 'existing', request: existing }

  /*
   * The object exists but does not parse. That is a storage fault, not a
   * duplicate, and it is raised rather than silently overwritten -- overwriting
   * is how a request Mike has already acted on would disappear.
   */
  throw new RequestUnreadableError()
}

/** The record for this address exists and cannot be read. Nothing was written. */
export class RequestUnreadableError extends Error {
  constructor() {
    super('That request could not be read. Nothing was changed.')
    this.name = 'RequestUnreadableError'
  }
}

/**
 * Remove a request and free its address, conditionally on the revision the
 * decision to remove it was made from.
 *
 * The condition is not decoration. A request's identity is derived from its
 * address, so removing one frees that pathname and the next submission from the
 * same address is created **at exactly the same path**. An unconditional delete
 * therefore had a real race: Mike double-presses "Remove" on a declined
 * request, both handlers load the declined record, the first deletes it, the
 * requester writes again, and the second handler's stale delete removes the new
 * pending request. Narrow, and exactly the class this pass exists to close.
 *
 * Resolves true when this call removed the record the caller had read, and
 * false when it did not -- because somebody else removed it, or because the
 * object at that path is no longer the one that was read. The caller turns
 * false into a conflict rather than into silence.
 */
export async function removeRequestIfMatch(
  id: string,
  version: string,
  store: PrivateStore = createPrivateStore(),
): Promise<boolean> {
  if (!REQUEST_ID_PATTERN.test(id)) return false
  // One object, so removing it frees the address in the same breath. There is
  // no index that could survive the record and strand the address.
  return store.removeIfMatch(requestPath(id), version)
}
