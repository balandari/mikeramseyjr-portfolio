/**
 * The life of a reviewer account: requested, approved, activated, signed in
 * again somewhere else, and maintained.
 *
 * Everything that spans more than one stored object lives here, because that
 * span is the hard part. An approval touches five independent things -- the
 * request, the roster, a credential, the audit log, and a mail service -- and
 * there is no transaction across them. Vercel Blob does not offer one, and
 * pretending otherwise would mean that a failure in the middle leaves Mike with
 * two reviewers, or a request stuck pending whose reviewer already exists, or a
 * dashboard claiming an email was sent that never was.
 *
 * ## How the approval survives failing anywhere
 *
 * It is a **resumable state transition with a claim**, not a single operation
 * that must either finish or be undone:
 *
 *   1. **Claim.** The request moves to `approving` and records the reviewer id
 *      it is going to use, and the books. Nothing else has happened yet. A
 *      failure here changes nothing at all.
 *   2. **Roster.** The entry is created *at that exact id*, and only if no entry
 *      with that id exists. An entry that already exists and names this request
 *      is this approval's own earlier attempt, and is reused. That is why a
 *      retry cannot create a second reviewer: the id was decided in step 1 and
 *      written down before anything used it.
 *   3. **Credential.** One activation credential is issued and its fingerprint
 *      written on the request, before anything is sent.
 *   4. **Send**, and write down what actually happened, before anything claims
 *      success.
 *   5. **Finalise.** The request becomes `approved`.
 *
 * Every step after the first is idempotent, and each records its own outcome
 * before the next begins, so a retry resumes rather than restarts. A request
 * left in `approving` is visible in the dashboard as an approval that did not
 * finish, and pressing the button again finishes it.
 *
 * Every write to the request record goes through `mutateRequest`, which derives
 * the change from the record that is actually stored and writes it back
 * conditionally on that exact revision. A double-pressed approve, an approve
 * racing a resend, and an activation racing a resend can therefore no longer
 * drop one another's fields.
 *
 * ## No credential supersedes another
 *
 * There is no "current credential" and no "only the newest email works". Every
 * unexpired, unused credential is valid until it is used or expires, each is
 * individually single-use, and each is bound to the reviewer, to a keyed label
 * of the address it was **sent to**, and to that reviewer's integer
 * `credentialEpoch` at the moment of issue. Mike advances the epoch -- inside
 * the same conditional roster mutation that performs the change -- when he
 * revokes somebody, changes their address, or explicitly invalidates their
 * outstanding links. See `lib/auth-credentials.ts`.
 *
 * So a pair of clicks sends two working emails rather than possibly none, an
 * older message in somebody's inbox keeps working until it expires, and no
 * message is ever reported as accepted while carrying a credential the
 * application would refuse.
 *
 * ## Spending, and the decision that comes after it
 *
 * Consumption is in two parts, and the order is the security property:
 *
 *   1. Read the credential and the roster, uncached, and decide **every**
 *      pre-consumption refusal from those reads. A refusal here writes nothing
 *      at all.
 *   2. Create the used marker. That is the linearization point for single use,
 *      and it spends the credential **permanently**.
 *   3. Confirm the reviewer's current roster state again -- for activation
 *      through the conditional roster mutation that writes the verified flag,
 *      for sign-in through a fresh uncached read.
 *   4. Mint a session only if step 3 agreed. If an administrative change landed
 *      in between, the credential stays spent, **nothing is minted, and nothing
 *      is authorized**; the attempt is recorded as `credential.refused-after-spend`
 *      and the visitor sees the same generic failure everybody else sees.
 *
 * Where a credential consumption and an administrative security action are
 * concurrent, the administrative action wins. That is the fail-closed
 * direction, and it is why a spent-then-refused marker is a fence rather than
 * residue.
 *
 * ## The mail boundary, and what it honestly is
 *
 * Every message this file causes goes through `lib/mail-operations.ts`, which
 * writes the operation down **before** the provider is called. That closes the
 * window where a provider accepted a message and the process then died without
 * recording it: the operation is left `in-flight`, and a retry reads it as
 * `uncertain` rather than sending a second copy.
 *
 * **Nothing here guarantees exactly-once delivery, and nothing guarantees
 * delivery at all** -- a refused, unconfigured or permanently uncertain
 * operation delivers nothing. The plaintext credential lives only in memory for
 * the length of one send, so a message whose fate is unknown cannot be re-sent;
 * there is nothing left to re-send.
 *
 * ## What is never true here
 *
 * No function in this file returns, stores, logs or renders an activation or
 * sign-in credential. Mike cannot see one; only the person it was mailed to
 * can. "Send another" always means "mint a new one", because the old one
 * genuinely cannot be recovered -- see `lib/auth-credentials.ts`.
 */

import { fingerprintAccessCode, type Reviewer } from './reviewer-access.ts'
import { generateAccessCode } from './reviewer-code.ts'
import { toReviewer } from './reviewer-authorization.ts'
import { AdminRequestError, assignableBookSlugs } from './reviewer-admin.ts'
import {
  RosterConflictError,
  createRosterStore,
  isValidBookSlug,
  isValidReviewerEmail,
  isValidReviewerId,
  mutateRoster,
  newAuditEvent,
  normalizeReviewerEmail,
  suggestReviewerId,
  type AuditEvent,
  type ReviewerRosterStore,
  type RosterDocument,
  type RosterReviewer,
} from './reviewer-roster.ts'
import {
  ACTIVATION_TTL_MS,
  SIGNIN_TTL_MS,
  credentialEmailLabel,
  isOutstanding,
  issueCredential,
  lookupCredential,
  sameLabel,
  spendCredential,
  type CredentialPurpose,
  type CredentialRecord,
  type IssuedCredential,
} from './auth-credentials.ts'
import { isSettled, readMailOperation, sendMailOperation } from './mail-operations.ts'
import { createPrivateStore, type PrivateStore } from './private-store.ts'
import {
  createMailer,
  siteOrigin,
  authorAlertAddress,
  type Mailer,
  type MailResult,
} from './mailer.ts'
import { activationMessage, authorAlertMessage, signinMessage } from './mail-messages.ts'
import {
  loadRequest,
  loadRequestVersioned,
  mutateRequest,
  removeRequestIfMatch,
  submitRequest,
  type DeliveryRecord,
  type ReviewerRequest,
} from './reviewer-requests.ts'

if (typeof window !== 'undefined') {
  throw new Error(
    'lib/reviewer-onboarding is server-only and must not be imported by a client component',
  )
}

/** How long before Mike is told about the same waiting request again. */
export const ALERT_REPEAT_MS = 24 * 60 * 60 * 1000

/**
 * Injected rather than imported, so a test can drive the whole pipeline over a
 * temporary directory and a mailer that fails on purpose. Defaults are the real
 * configured ones, so callers in the application pass nothing.
 */
export type OnboardingDeps = {
  store?: PrivateStore
  /**
   * The roster, injected for the same reason the object store is: the tests
   * need to pause it. Every administrative boundary in this file -- a
   * revocation, an address change, an invalidation landing between a
   * credential's marker and the decision that follows it -- is a roster
   * operation, and an interleaving that cannot be scheduled cannot be proved.
   */
  rosterStore?: ReviewerRosterStore
  mailer?: Mailer
  nowMs?: number
  /**
   * Test seam. Each hook runs immediately after that step's durable write, so a
   * test can throw there and assert what a crash at that exact point leaves
   * behind. Nothing in the application ever passes these.
   */
  hooks?: {
    afterClaim?: () => void
    afterRoster?: () => void
    afterCredential?: () => void
    afterSend?: () => void
  }
}

type Resolved = {
  store: PrivateStore
  rosterStore: ReviewerRosterStore
  mailer: Mailer
  nowMs: number
  hooks: NonNullable<OnboardingDeps['hooks']>
}

function resolve(deps: OnboardingDeps = {}): Resolved {
  return {
    store: deps.store ?? createPrivateStore(),
    rosterStore: deps.rosterStore ?? createRosterStore(),
    mailer: deps.mailer ?? createMailer(),
    nowMs: deps.nowMs ?? Date.now(),
    hooks: deps.hooks ?? {},
  }
}

/**
 * An approval that stopped part-way and cannot be finished, because the
 * reviewer it created has since been revoked.
 *
 * A separate class rather than a bare `AdminRequestError` because the dashboard
 * has to offer two specific ways out of it -- Restore then Finish, or Cancel --
 * rather than an ordinary retry button that would simply fail again.
 */
export class ApprovalRevokedError extends AdminRequestError {
  constructor() {
    super(
      'That reviewer was revoked after this approval stopped. Restore them first if you want ' +
        'to go ahead, or cancel the approval. Nothing was changed.',
      409,
    )
    this.name = 'ApprovalRevokedError'
  }
}

/**
 * How long an emailed link of each purpose lasts, in the words the dashboard
 * and the audit log use.
 *
 * Derived from the constants rather than written out, so the sentence cannot
 * drift away from the TTL it describes -- which is exactly the lie this repair
 * exists to stop telling.
 */
function lifetimeOf(purpose: CredentialPurpose): string {
  const ms = purpose === 'signin' ? SIGNIN_TTL_MS : ACTIVATION_TTL_MS
  const minutes = Math.round(ms / 60_000)
  if (minutes < 90) return `about ${minutes} minutes`
  const hours = Math.round(ms / 3_600_000)
  if (hours < 48) return `about ${hours} hours`
  return `about ${Math.round(hours / 24)} days`
}

/* ------------------------------------------------------------ roster helpers */

/**
 * Apply one change to the roster, derived from the document that is actually
 * stored and written back conditionally on that exact revision.
 *
 * Every shared-roster mutation in this file goes through here, which is what
 * stops an approval, an activation verification, an address change and a
 * revocation happening at once from discarding one another. `mutateRoster`
 * re-derives and retries on a conflict, and refuses honestly if it cannot.
 */
/** The books a reviewer may actually be given, validated against the manuscript. */
function cleanBooks(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new AdminRequestError('Entitlements must be a list of books.')
  const assignable = new Set(assignableBookSlugs())
  const books: string[] = []
  for (const value of raw) {
    const slug = typeof value === 'string' ? value.trim() : ''
    if (!slug) continue
    if (!isValidBookSlug(slug) || !assignable.has(slug)) {
      throw new AdminRequestError(`"${slug}" is not a book on this site.`)
    }
    if (!books.includes(slug)) books.push(slug)
  }
  return books
}

function sameBooks(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((slug) => b.includes(slug))
}

/**
 * The id this request's reviewer will have, decided once and written down.
 *
 * Derived from the name, because Mike should not have to invent identifiers,
 * and made unique by appending part of the request id when the obvious one is
 * taken. Both branches are deterministic **for this request**, which is what
 * lets step 2 be re-run safely: the same request always proposes the same id.
 */
function chooseReviewerId(request: ReviewerRequest, doc: RosterDocument): string {
  const taken = new Set(doc.reviewers.filter((row) => row.requestId !== request.id).map((r) => r.id))

  const base = suggestReviewerId(request.name) || 'reviewer'
  if (isValidReviewerId(base) && !taken.has(base)) return base

  const suffixed = `${base}-${request.id.slice(0, 6)}`
  if (isValidReviewerId(suffixed) && !taken.has(suffixed)) return suffixed

  throw new AdminRequestError(
    'Could not make a unique identifier for that name. Rename the reviewer after approving, ' +
      'or decline and ask them to write again with a different name.',
  )
}

/* --------------------------------------------------------- 1. a new request */

export type SubmitResult = {
  /**
   * What actually happened, for the server's own use and the tests. **The
   * visitor is told the same thing in every case**; this never reaches them.
   */
  effect:
    | 'request-created'
    | 'request-already-pending'
    | 'signin-sent-to-existing-reviewer'
    | 'activation-sent-to-existing-reviewer'
    | 'ignored-revoked'
  delivery: MailResult | null
}

/**
 * Take a request from the public form.
 *
 * Rate limiting has already happened in the route handler; this is the part
 * that decides what the submission means. Five outcomes, one answer.
 *
 * The two "existing reviewer" branches send the emailed credential **to the
 * address already on the roster**, which is the address Mike put there. A
 * stranger typing somebody else's address therefore causes mail to that person
 * and learns nothing, which is the same property every "email me a link" flow
 * has, and is bounded by the limiter.
 */
export async function submitAccessRequest(
  input: { name: string; email: string; message: string },
  deps: OnboardingDeps = {},
): Promise<SubmitResult> {
  const { store, rosterStore, mailer, nowMs } = resolve(deps)
  const email = normalizeReviewerEmail(input.email)

  const doc = await rosterStore.load()
  const existing = doc.reviewers.find((row) => row.email && row.email === email)

  if (existing) {
    if (existing.status !== 'active') {
      // A revoked reader cannot re-admit themselves through the front door, and
      // cannot make this site mail anybody either.
      return { effect: 'ignored-revoked', delivery: null }
    }
    /*
     * The same boundary resolution the two administrative paths use, so the
     * public door cannot send a link the application would refuse either. A
     * verified address gets a sign-in link; an unverified one gets an
     * activation link. Nothing is audited here: this is not an administrative
     * act, and the visitor is told the same thing whatever happened.
     */
    const sent = await sendAccessEmailToReviewer({ reviewerId: existing.id, actor: null }, deps)
    return {
      effect:
        sent.purpose === 'signin'
          ? 'signin-sent-to-existing-reviewer'
          : 'activation-sent-to-existing-reviewer',
      delivery: sent.delivery,
    }
  }

  const outcome = await submitRequest(
    { name: input.name, email, message: input.message },
    store,
    nowMs,
  )

  if (outcome.outcome === 'existing') {
    const seen = outcome.request.alertedAt ? Date.parse(outcome.request.alertedAt) : 0
    if (Number.isFinite(seen) && nowMs - seen < ALERT_REPEAT_MS) {
      return { effect: 'request-already-pending', delivery: null }
    }
    const delivery = await alertAuthor(outcome.request, { store, mailer, nowMs })
    return { effect: 'request-already-pending', delivery }
  }

  try {
    await rosterStore.appendAudit(
      newAuditEvent(
        'public',
        'request.received',
        '',
        'A reviewer access request arrived.',
        outcome.request.id,
      ),
    )
  } catch {
    // Best effort, exactly as elsewhere: a missing log line must not lose a
    // request that is already stored.
  }

  const delivery = await alertAuthor(outcome.request, { store, mailer, nowMs })
  return { effect: 'request-created', delivery }
}

/**
 * Tell Mike, and write down what happened.
 *
 * Called only after the request is durably stored. A failure here is recorded
 * on the request and shown in the dashboard; it never loses the request and
 * never changes its status.
 */
async function alertAuthor(
  request: ReviewerRequest,
  ctx: { store: PrivateStore; mailer: Mailer; nowMs: number },
): Promise<MailResult> {
  const origin = siteOrigin()
  const to = authorAlertAddress()

  let result: MailResult
  if (!origin || !to) {
    result = {
      status: 'not-configured',
      providerId: null,
      error: !origin ? 'no_site_origin' : 'no_alert_address',
    }
  } else {
    result = await sendMailOperation(
      ctx.mailer,
      authorAlertMessage({ to, request, adminUrl: `${origin}/admin` }),
      ctx.store,
      ctx.nowMs,
    )
  }

  try {
    await mutateRequest(
      request.id,
      (current) => ({
        next: {
          ...current,
          alertedAt: new Date(ctx.nowMs).toISOString(),
          delivery: deliveryRecord('author-alert', result, ctx.nowMs),
        },
        result: null,
      }),
      ctx.store,
      ctx.nowMs,
    )
  } catch {
    // The request stands either way. Recording the attempt is the courtesy.
  }

  return result
}

function deliveryRecord(
  kind: DeliveryRecord['kind'],
  result: MailResult,
  nowMs: number,
): DeliveryRecord {
  return {
    kind,
    at: new Date(nowMs).toISOString(),
    status: result.status,
    providerId: result.providerId,
    error: result.error,
  }
}

/* ------------------------------------------------------------ 2. approval */

export type ApprovalResult = {
  request: ReviewerRequest
  reviewerId: string
  delivery: MailResult
}

/**
 * Approve a request, create the account, and send the activation email.
 *
 * Resumable from wherever it stopped. See the header comment for the five steps
 * and what a failure at each one leaves behind.
 */
export async function approveRequest(
  input: { requestId: string; books: unknown; actor: string },
  deps: OnboardingDeps = {},
): Promise<ApprovalResult> {
  const { store, rosterStore, nowMs, hooks } = resolve(deps)

  const found = await loadRequest(input.requestId, store)
  if (!found) throw new AdminRequestError('That request is no longer here.', 404)
  if (found.status === 'declined') {
    throw new AdminRequestError('That request was declined. Nothing was changed.', 409)
  }
  if (found.status === 'approved') {
    throw new AdminRequestError(
      'That request is already approved. Use "Send a new access email" instead.',
      409,
    )
  }

  const books = cleanBooks(input.books)

  const doc = await rosterStore.load()

  /* ---- 0. refuse a resume that would undo a revocation -------------- */

  /*
   * Checked before anything at all is written, so that the common case of
   * pressing Finish on a blocked approval changes nothing whatsoever -- not the
   * roster, not the request, not the books, not a credential, not a message.
   * The authoritative check is the one inside `ensureReviewerForRequest`, which
   * is linearized against a concurrent revocation; this one exists so the
   * refusal is clean rather than merely safe.
   */
  if (found.status === 'approving' && found.reviewerId) {
    const existing = doc.reviewers.find((row) => row.id === found.reviewerId)
    if (existing && existing.status !== 'active') throw new ApprovalRevokedError()
  }

  /* ---- 1. claim ---------------------------------------------------- */

  const proposed = chooseReviewerId(found, doc)

  /*
   * Only a request that has not been claimed writes here. An `approving`
   * request already carries its identifier, and its books are brought in line
   * *after* the roster step -- because if the roster step refuses, this
   * operation must leave no trace at all, and a books field quietly updated on
   * the way to a refusal is a trace.
   */
  let request = found
  if (found.status !== 'approving' || !found.reviewerId) {
    request = (
      await mutateRequest(
        found.id,
        (current) => {
          if (current.status === 'approving' && current.reviewerId) return null
          if (current.status === 'approved' || current.status === 'declined') {
            throw new AdminRequestError('That request has already been decided.', 409)
          }
          return {
            next: { ...current, status: 'approving' as const, reviewerId: proposed, books },
            result: null,
          }
        },
        store,
        nowMs,
      )
    ).request
  }
  hooks.afterClaim?.()

  const reviewerId = request.reviewerId
  if (!reviewerId) throw new AdminRequestError('The approval could not claim an identifier.', 500)

  /* ---- 2. the roster entry, at the claimed id ----------------------- */

  await ensureReviewerForRequest(request, books, input.actor, rosterStore)
  hooks.afterRoster?.()

  // The roster agreed, so the request may now record the books Mike chose.
  if (!sameBooks(request.books, books)) {
    request = (
      await mutateRequest(
        request.id,
        (current) => (sameBooks(current.books, books) ? null : { next: { ...current, books }, result: null }),
        store,
        nowMs,
      )
    ).request
  }

  /* ---- 3 & 4. credential and send, resuming one already under way --- */

  /*
   * An approval is always the unverified case by construction -- the entry was
   * created with `emailVerifiedAt: null` -- but it is resolved rather than
   * assumed, so that an activation link is never sent to somebody who has
   * already proved their address by some other route.
   */
  const resolved = await resolveAccessEmail(reviewerId, rosterStore)
  const issued =
    resolved.purpose === 'activation'
      ? await issueAndRecord(request, resolved.reviewer, deps)
      : { request, send: await sendSigninLink(resolved.reviewer, deps) }
  request = issued.request
  hooks.afterCredential?.()

  const delivery: MailResult = issued.send ?? {
    status: 'not-configured',
    providerId: null,
    error: 'no_site_origin',
  }

  request = (
    await mutateRequest(
      request.id,
      (current) => ({
        next: { ...current, delivery: deliveryRecord(resolved.purpose, delivery, nowMs) },
        result: null,
      }),
      store,
      nowMs,
    )
  ).request
  hooks.afterSend?.()

  /* ---- 5. finalise -------------------------------------------------- */

  const finalised = (
    await mutateRequest(
      request.id,
      (current) => ({
        next: {
          ...current,
          status: 'approved' as const,
          decidedAt: current.decidedAt ?? new Date(nowMs).toISOString(),
          decidedBy: current.decidedBy ?? input.actor,
        },
        result: null,
      }),
      store,
      nowMs,
    )
  ).request

  try {
    await rosterStore.appendAudit(
      newAuditEvent(
        input.actor,
        'request.approved',
        reviewerId,
        `Approved a reviewer request and created ${reviewerId} with ` +
          `${books.length === 0 ? 'no books' : books.join(', ')}.`,
        finalised.id,
      ),
    )
    await rosterStore.appendAudit(
      newAuditEvent(
        input.actor,
        resolved.purpose === 'signin' ? 'signin.sent' : 'activation.sent',
        reviewerId,
        describeAccessEmail(resolved.purpose, delivery),
        finalised.id,
      ),
    )
  } catch {
    // See `commitRoster`.
  }

  return { request: finalised, reviewerId, delivery }
}

function describeDelivery(result: MailResult): string {
  if (result.status === 'accepted') return 'handed to the mail service'
  if (result.status === 'refused') return 'refused by the mail service'
  if (result.status === 'uncertain') {
    return 'left uncertain — the mail service may or may not have taken it'
  }
  if (result.status === 'unreachable') return 'not delivered — the mail service did not answer'
  return 'not sent — no mail service is configured'
}

/**
 * Create this request's roster entry, or recognise the one a previous attempt
 * already created.
 *
 * The identifier was decided and stored in step 1, so "does it already exist?"
 * is a question with a reliable answer. An entry at that id carrying this
 * request's id is ours; an entry at that id belonging to somebody else is a
 * genuine collision and is refused rather than merged into.
 *
 * ## About the access code this creates
 *
 * A roster entry must carry a code fingerprint -- it is what a reviewer's
 * session is bound to, and rotating it is what ends every session they have
 * open. So one is generated here, fingerprinted, and **immediately discarded**.
 * Nobody ever sees it and nobody holds it: this account is opened by email, not
 * by code. Mike can still press "New code" later to issue one he can hand over,
 * and that keeps working exactly as it does for every other reviewer.
 */
async function ensureReviewerForRequest(
  request: ReviewerRequest,
  books: string[],
  actor: string,
  store: ReviewerRosterStore,
): Promise<RosterReviewer> {
  const reviewerId = request.reviewerId
  if (!reviewerId || !isValidReviewerId(reviewerId)) {
    throw new AdminRequestError('That approval has no valid identifier.', 500)
  }

  if (!store.writable) {
    throw new AdminRequestError(
      `The roster is being served by the read-only "${store.driver}" driver, so a reviewer ` +
        'cannot be created here.',
      409,
    )
  }

  /*
   * Minted once, before the mutation, so that a conflict retry re-applies the
   * same account rather than creating a second fingerprint. Nobody ever sees
   * this code -- see the comment above.
   */
  const code = generateAccessCode()
  const codeHash = await fingerprintAccessCode(code)
  if (!codeHash) {
    throw new AdminRequestError(
      'REVIEWER_AUTH_SECRET is not configured, so an account cannot be created.',
      503,
    )
  }
  const at = new Date().toISOString()

  const outcome = await mutateRoster<RosterReviewer>((doc) => {
    const existing = doc.reviewers.find((row) => row.id === reviewerId)

    if (existing) {
      if (existing.requestId !== request.id) {
        throw new AdminRequestError(
          `The identifier "${reviewerId}" already belongs to another reviewer.`,
          409,
        )
      }

      /*
       * **A resume never reactivates a revoked reviewer.**
       *
       * This branch used to rebuild the entry with `status: 'active'`
       * unconditionally, on the reasoning that it was "bringing our own earlier
       * attempt in line". It was doing more than that: an approval can stop
       * after the roster entry exists, Mike can then revoke that reviewer
       * deliberately, and pressing "Finish approving" would silently undo the
       * revocation -- reactivating the account, re-admitting its access code,
       * and sending a fresh access email. An explicit security action must not
       * be reversible by a recovery button.
       *
       * So a revoked entry stops the approval here, inside the conditional
       * mutation, where the check is linearized against any concurrent
       * revocation. Nothing is written. The only operation allowed to make this
       * reviewer active again is the explicit Restore action, and the dashboard
       * offers Restore and Cancel side by side rather than a retry that fails.
       */
      // Ours, from an earlier attempt. Bring it in line without creating
      // anything; if it is already in line, write nothing at all.
      /*
       * **A resume never reactivates a revoked reviewer.**
       *
       * This branch used to rebuild the entry with `status: 'active'`
       * unconditionally, on the reasoning that it was "bringing our own earlier
       * attempt in line". It was doing more than that: an approval can stop
       * after the roster entry exists, Mike can then revoke that reviewer
       * deliberately, and pressing "Finish approving" would silently undo the
       * revocation -- reactivating the account, re-admitting its access code,
       * and sending a fresh access email. An explicit security action must not
       * be reversible by a recovery button.
       *
       * So a revoked entry stops the approval here, inside the conditional
       * mutation, where the check is linearized against any concurrent
       * revocation. Nothing is written. The only operation allowed to make this
       * reviewer active again is the explicit Restore action, and the dashboard
       * offers Restore and Cancel side by side rather than a retry that fails.
       */
      if (existing.status !== 'active') throw new ApprovalRevokedError()

      // Ours, from an earlier attempt. Bring it in line without creating
      // anything; if it is already in line, write nothing at all.
      if (sameBooks(existing.books, books)) return null

      const updated: RosterReviewer = { ...existing, books }
      return {
        reviewers: doc.reviewers.map((row) => (row.id === reviewerId ? updated : row)),
        event: newAuditEvent(
          actor,
          'reviewer.entitlements-changed',
          reviewerId,
          `Resumed an unfinished approval for ${existing.name}.`,
          request.id,
        ),
        result: updated,
      }
    }

    if (doc.reviewers.some((row) => row.email && row.email === request.email)) {
      throw new AdminRequestError(
        'There is already a reviewer with that address. Decline this request, or change ' +
          'that reviewer’s address first.',
        409,
      )
    }
    if (doc.reviewers.some((row) => row.codeHash === codeHash)) {
      throw new AdminRequestError('Could not create a unique account. Try again.', 500)
    }

    const reviewer: RosterReviewer = {
      id: reviewerId,
      name: request.name,
      email: request.email,
      books,
      status: 'active',
      codeHash,
      createdAt: at,
      codeUpdatedAt: at,
      lastAccessAt: null,
      emailVerifiedAt: null,
      credentialEpoch: 0,
      origin: 'request',
      requestId: request.id,
    }

    return {
      reviewers: [...doc.reviewers, reviewer],
      event: newAuditEvent(
        actor,
        'reviewer.created',
        reviewerId,
        `Created ${reviewer.name} from an access request, with ` +
          `${reviewer.books.length === 0 ? 'no books' : reviewer.books.join(', ')}.`,
        request.id,
      ),
      result: reviewer,
    }
  }, store)

  if (!outcome.unchanged) return outcome.result

  // Nothing needed writing, so the entry that is already there is the answer.
  const settled = outcome.roster.reviewers.find((row) => row.id === reviewerId)
  if (!settled) throw new AdminRequestError('That approval lost its roster entry.', 500)
  return settled
}

/**
 * The idempotency key one activation operation carries, for the whole life of
 * that operation.
 *
 * A pure function of the operation: a lost provider response never changes it,
 * and only a genuinely new credential does. The operation id is the whole of
 * the identity, because it is random per credential -- there is no generation
 * for two different payloads to collide on any more.
 */
function activationKey(requestId: string, operationId: string): string {
  return `activation:${requestId}:${operationId}`
}

/** Which kind of emailed link a reviewer can actually use right now. */
export type AccessEmailPurpose = CredentialPurpose

export type ResolvedAccessEmail = {
  reviewer: RosterReviewer
  purpose: AccessEmailPurpose
}

/**
 * Decide, from the roster and nothing else, which access email this reviewer
 * can use -- or refuse before anything is minted or sent.
 *
 * **The roster is the authorization root, and this is the only thing allowed to
 * answer the question.** A request record's `activation.usedAt` describes
 * bookkeeping progress; it is written best-effort after a successful
 * activation, and a failure to write it used to leave the request card offering
 * another activation link to a reviewer who had already verified their address.
 * Every such link is refused as `already-verified` -- so the email was accepted
 * by the provider and was dead before it was sent. The same was true of the
 * reviewer card, which always sent an activation regardless of state.
 *
 * So both operations now resolve the reviewer here, at the operation boundary,
 * from a fresh roster read rather than from whatever object the dashboard
 * happened to render:
 *
 *   active + unverified  -> an activation credential (its own, longer, TTL)
 *   active + verified    -> a fifteen-minute sign-in credential
 *   revoked / missing /
 *   no usable address    -> refused, before a credential exists and before the
 *                           provider is called
 *
 * The refusals are specific because exactly one person reads them, and he is
 * already authenticated.
 */
async function resolveAccessEmail(
  reviewerId: string | null | undefined,
  rosterStore: ReviewerRosterStore,
): Promise<ResolvedAccessEmail> {
  const id = typeof reviewerId === 'string' ? reviewerId.trim() : ''
  if (!id || !isValidReviewerId(id)) {
    throw new AdminRequestError('That approval has no valid identifier.', 409)
  }

  const doc = await rosterStore.load()
  const reviewer = doc.reviewers.find((row) => row.id === id)
  if (!reviewer) throw new AdminRequestError('That reviewer is no longer on the roster.', 404)
  if (reviewer.status !== 'active') {
    throw new AdminRequestError(
      'That reviewer is revoked, so no access email was sent. Restore them first.',
      409,
    )
  }
  if (!reviewer.email || !isValidReviewerEmail(reviewer.email)) {
    throw new AdminRequestError('That reviewer has no usable email address.', 409)
  }

  return { reviewer, purpose: reviewer.emailVerifiedAt ? 'signin' : 'activation' }
}

/** One sentence for the audit log, naming the purpose and its real lifetime. */
function describeAccessEmail(purpose: AccessEmailPurpose, result: MailResult): string {
  const what = purpose === 'signin' ? 'A sign-in email' : 'An activation email'
  return `${what} was ${describeDelivery(result)}. The link expires ${lifetimeOf(purpose)}.`
}

/**
 * Whether this approval's *existing* activation operation should be resumed
 * rather than replaced, and what it actually came to.
 *
 * Resumable exactly when the credential already minted for this request is
 * still outstanding -- unexpired, unspent, and issued under the reviewer's
 * current epoch -- and an operation was already opened for it. That covers both
 * halves of the window the original design fell through:
 *
 *   - the operation **settled** (the provider answered) but the process died
 *     before the answer reached the request record. The message went, and the
 *     link in somebody's inbox works.
 *   - the operation is still **in-flight**: the provider may or may not have
 *     taken it, and nobody will ever know. Reported as `uncertain`, and nothing
 *     is re-minted and nothing is re-sent.
 *
 * Either way the retry carries the same credential and the same idempotency
 * key. Only Mike pressing "Send a new access email" mints a new one -- and that
 * does not invalidate this one; both work until they expire.
 */
async function resumableActivation(
  request: ReviewerRequest,
  entry: RosterReviewer,
  store: PrivateStore,
  nowMs: number,
): Promise<MailResult | null> {
  const activation = request.activation
  if (!activation || activation.usedAt) return null
  if (!activation.tokenHash || !activation.operationId) return null

  if (!(await isOutstanding('activation', activation.tokenHash, entry.credentialEpoch, store, nowMs))) {
    return null
  }

  const operation = await readMailOperation(
    activationKey(request.id, activation.operationId),
    store,
  )
  // No operation at all means the send never started. There is nothing to
  // resume, and the plaintext is gone, so a fresh credential is the only move.
  if (!operation) return null

  if (isSettled(operation)) {
    return {
      status: operation.status === 'in-flight' ? 'uncertain' : operation.status,
      providerId: operation.providerId,
      error: operation.error,
    }
  }

  return {
    status: 'uncertain',
    providerId: operation.providerId,
    error: operation.status === 'in-flight' ? 'previous_attempt_unrecorded' : operation.error,
  }
}

/**
 * Issue an activation credential for a request's reviewer, and mail it.
 *
 * The credential is bound to the address **on the roster**, which is the
 * address the message is sent to. If Mike corrected the address after the
 * request came in, the link goes to the corrected one and is bound to it; the
 * request record's original address is history, not a destination.
 */
async function issueAndRecord(
  request: ReviewerRequest,
  entry: RosterReviewer,
  deps: OnboardingDeps,
  options: { forceNew?: boolean } = {},
): Promise<{ request: ReviewerRequest; send: MailResult | null }> {
  const { store, mailer, nowMs } = resolve(deps)

  /*
   * Resume before minting. The credential from the previous attempt is still
   * usable and may already be in the reviewer's inbox, so a retry that merely
   * lost a provider response must not start a second operation.
   */
  if (!options.forceNew) {
    const resumed = await resumableActivation(request, entry, store, nowMs)
    if (resumed) return { request, send: resumed }
  }

  const origin = siteOrigin()
  if (!origin) {
    // No link can be built, so nothing is minted and nothing is sent. Guessing
    // an origin is how a reviewer ends up with a link to nowhere.
    return {
      request,
      send: { status: 'not-configured', providerId: null, error: 'no_site_origin' },
    }
  }

  const issued = await issueCredential(
    'activation',
    {
      reviewerId: entry.id,
      requestId: request.id,
      emailLabel: credentialEmailLabel(entry.email),
      credentialEpoch: entry.credentialEpoch,
      ttlMs: ACTIVATION_TTL_MS,
    },
    store,
    nowMs,
  )
  if (!issued) {
    throw new AdminRequestError(
      'REVIEWER_AUTH_SECRET is not configured, so an access email cannot be issued.',
      503,
    )
  }

  /*
   * Written down before the send, so that a crash between the two leaves a
   * record naming the credential that may have gone out. Nothing here can
   * invalidate an older credential, so a conflicting concurrent resend simply
   * lands its own hash after ours; both credentials work, once each, and the
   * record names the later one.
   */
  const recorded = (
    await mutateRequest(
      request.id,
      (current) => ({
        next: {
          ...current,
          activation: {
            tokenHash: issued.tokenHash,
            operationId: issued.operationId,
            expiresAt: issued.expiresAt,
            usedAt: null,
          },
        },
        result: null,
      }),
      store,
      nowMs,
    )
  ).request

  const send = await sendMailOperation(
    mailer,
    activationMessage({
      to: entry.email,
      name: entry.name,
      origin,
      token: issued.token,
      expiresAt: issued.expiresAt,
      operationId: issued.operationId,
      requestId: recorded.id,
    }),
    store,
    nowMs,
  )

  return { request: recorded, send }
}

/* ----------------------------------------------- 3. sending another email */

/**
 * Send the access email an approved request's reviewer can actually use.
 *
 * It mints a fresh credential, because the previous one cannot be recovered and
 * never could, and it does not kill the previous one: whatever is already in
 * the reviewer's inbox keeps working until it expires or is used. If Mike wants
 * the earlier link dead, "Invalidate links" is the action that says so.
 *
 * **Which kind of email is decided by the roster, not by the request record.**
 * A reviewer who has already verified their address cannot use an activation
 * link -- every one is refused as `already-verified` -- so they are sent a
 * fifteen-minute sign-in link instead. The request's `activation.usedAt` is
 * written best-effort after an activation, and a failure to write it used to
 * leave this operation confidently sending a link that could never work. It no
 * longer consults that field at all.
 */
export async function sendAccessEmailForRequest(
  input: { requestId: string; actor: string },
  deps: OnboardingDeps = {},
): Promise<{ request: ReviewerRequest; delivery: MailResult; purpose: AccessEmailPurpose }> {
  const { store, rosterStore, nowMs } = resolve(deps)

  const found = await loadRequest(input.requestId, store)
  if (!found) throw new AdminRequestError('That request is no longer here.', 404)
  if (found.status !== 'approved' && found.status !== 'approving') {
    throw new AdminRequestError('That request has not been approved.', 409)
  }

  // Resolved from the roster, before anything is minted and before the provider
  // is called. A revoked or missing reviewer refuses here, having written
  // nothing and sent nothing.
  const { reviewer, purpose } = await resolveAccessEmail(found.reviewerId, rosterStore)

  const issued =
    purpose === 'activation'
      ? await issueAndRecord(found, reviewer, deps, { forceNew: true })
      : { request: found, send: await sendSigninLink(reviewer, deps) }

  const delivery = issued.send ?? { status: 'not-configured', providerId: null, error: null }

  /*
   * Recorded under its own kind. A sign-in link is never written into
   * `activation`, which is an activation-specific field with an
   * activation-specific lifetime; the delivery record's `kind` is what tells
   * the dashboard which message this was.
   */
  const recorded = (
    await mutateRequest(
      issued.request.id,
      (current) => ({
        next: { ...current, delivery: deliveryRecord(purpose, delivery, nowMs) },
        result: null,
      }),
      store,
      nowMs,
    )
  ).request

  try {
    await rosterStore.appendAudit(
      newAuditEvent(
        input.actor,
        purpose === 'signin' ? 'signin.sent' : 'activation.sent',
        reviewer.id,
        describeAccessEmail(purpose, delivery),
        found.id,
      ),
    )
  } catch {
    // The roster is the source of truth; the log is a courtesy.
  }

  return { request: recorded, delivery, purpose }
}

/**
 * Issue one activation credential for a reviewer and mail it. No request record
 * is touched; this is the reviewer-card path and the public re-request path.
 */
async function issueActivationFor(
  reviewer: RosterReviewer,
  deps: OnboardingDeps = {},
): Promise<MailResult> {
  const { store, mailer, nowMs } = resolve(deps)

  const origin = siteOrigin()
  if (!origin) return { status: 'not-configured', providerId: null, error: 'no_site_origin' }

  const issued = await issueCredential(
    'activation',
    {
      reviewerId: reviewer.id,
      requestId: reviewer.requestId,
      emailLabel: credentialEmailLabel(reviewer.email),
      credentialEpoch: reviewer.credentialEpoch,
      ttlMs: ACTIVATION_TTL_MS,
    },
    store,
    nowMs,
  )
  if (!issued) return { status: 'not-configured', providerId: null, error: 'no_auth_secret' }

  return sendMailOperation(
    mailer,
    activationMessage({
      to: reviewer.email,
      name: reviewer.name,
      origin,
      token: issued.token,
      expiresAt: issued.expiresAt,
      operationId: issued.operationId,
      requestId: reviewer.requestId ?? reviewer.id,
    }),
    store,
    nowMs,
  )
}

/**
 * Send a reviewer the access email they can actually use, from the reviewer
 * card.
 *
 * Takes an **id**, never a reviewer object the dashboard loaded a moment ago:
 * the state that decides which message to send is resolved here, at the
 * operation boundary, from the roster. An unverified reviewer gets an
 * activation link -- the migration path for everybody already on the roster
 * with a code. A verified one gets a sign-in link, because an activation link
 * would be refused the instant they pressed it.
 *
 * It creates nothing, changes no entitlement, and leaves their code working.
 */
export async function sendAccessEmailToReviewer(
  input: { reviewerId: string; actor: string | null },
  deps: OnboardingDeps = {},
): Promise<{ delivery: MailResult; purpose: AccessEmailPurpose }> {
  const { rosterStore } = resolve(deps)

  const { reviewer, purpose } = await resolveAccessEmail(input.reviewerId, rosterStore)

  const delivery =
    purpose === 'activation'
      ? await issueActivationFor(reviewer, deps)
      : await sendSigninLink(reviewer, deps)

  if (input.actor) {
    try {
      await rosterStore.appendAudit(
        newAuditEvent(
          input.actor,
          purpose === 'signin' ? 'signin.sent' : 'activation.sent',
          reviewer.id,
          describeAccessEmail(purpose, delivery),
        ),
      )
    } catch {
      // See above.
    }
  }

  return { delivery, purpose }
}

/* --------------------------------------------------------- 4. the decline */

export async function declineRequest(
  input: { requestId: string; actor: string },
  deps: OnboardingDeps = {},
): Promise<ReviewerRequest> {
  const { store, rosterStore, nowMs } = resolve(deps)

  const found = await loadRequest(input.requestId, store)
  if (!found) throw new AdminRequestError('That request is no longer here.', 404)
  if (found.status === 'approved' || found.status === 'approving') {
    throw new AdminRequestError('That request has already been approved.', 409)
  }
  if (found.status === 'declined') return found

  const declined = (
    await mutateRequest(
      found.id,
      (current) => {
        if (current.status === 'approved' || current.status === 'approving') {
          throw new AdminRequestError('That request has already been approved.', 409)
        }
        if (current.status === 'declined') return null
        return {
          next: {
            ...current,
            status: 'declined' as const,
            decidedAt: new Date(nowMs).toISOString(),
            decidedBy: input.actor,
          },
          result: null,
        }
      },
      store,
      nowMs,
    )
  ).request

  try {
    await rosterStore.appendAudit(
      newAuditEvent(input.actor, 'request.declined', '', 'Declined a reviewer request.', found.id),
    )
  } catch {
    // See `commitRoster`.
  }

  // Nothing is sent. A form rejection from an author reads badly, and Mike can
  // answer the alert in his own words if he wants to.
  return declined
}

/**
 * Abandon an approval that stopped part-way and can no longer be finished,
 * because the reviewer it created has since been revoked.
 *
 * This is the second of the two ways out of that state, and the first is
 * Restore followed by Finish. The two are deliberately separate operations:
 * **cancelling never reactivates anybody, and restoring never finishes an
 * approval.** Neither implicitly performs the other, because each is a distinct
 * decision and Mike should have to make the one he means.
 *
 * What it does: closes the request. What it does not do, all of which matters:
 *
 *   - it does not touch the roster entry, which stays revoked and stays on the
 *     roster with its history, its entitlements, its access record and its
 *     attribution intact. **Cancelling an approval is not deleting a reviewer.**
 *   - it does not touch `credentialEpoch`, so the links the revocation killed
 *     stay killed and nothing is resurrected by a later restore;
 *   - it mints no credential and sends no message.
 *
 * The request becomes `declined`, which is the existing closed state, so the
 * ordinary Remove action becomes available afterwards if Mike wants the address
 * freed. The audit line records a cancellation, not a decline, because they are
 * different events and reading them as the same one later would be wrong.
 */
export async function cancelApproval(
  input: { requestId: string; actor: string },
  deps: OnboardingDeps = {},
): Promise<ReviewerRequest> {
  const { store, rosterStore, nowMs } = resolve(deps)

  const found = await loadRequest(input.requestId, store)
  if (!found) throw new AdminRequestError('That request is no longer here.', 404)
  if (found.status !== 'approving') {
    throw new AdminRequestError('Only an unfinished approval can be cancelled.', 409)
  }

  /*
   * Offered only for the state it exists to resolve. If the reviewer is active,
   * the approval can simply be finished, and quietly closing the request would
   * strand an account nobody decided to create.
   */
  const doc = await rosterStore.load()
  const entry = found.reviewerId
    ? doc.reviewers.find((row) => row.id === found.reviewerId)
    : undefined
  if (!entry || entry.status === 'active') {
    throw new AdminRequestError(
      'That approval is not blocked. Finish it, or decline the request instead.',
      409,
    )
  }

  const cancelled = (
    await mutateRequest(
      found.id,
      (current) => {
        // Re-derived from the stored record: an approval finished by somebody
        // else in the meantime is not cancellable.
        if (current.status !== 'approving') {
          throw new AdminRequestError('Only an unfinished approval can be cancelled.', 409)
        }
        return {
          next: {
            ...current,
            status: 'declined' as const,
            decidedAt: new Date(nowMs).toISOString(),
            decidedBy: input.actor,
          },
          result: null,
        }
      },
      store,
      nowMs,
    )
  ).request

  try {
    await rosterStore.appendAudit(
      newAuditEvent(
        input.actor,
        'request.approval-cancelled',
        entry.id,
        `Cancelled an unfinished approval for ${entry.name}. They stay revoked, their account ` +
          'was not removed, and no email was sent.',
        found.id,
      ),
    )
  } catch {
    // The request is the source of truth; the log is a courtesy.
  }

  return cancelled
}

/**
 * Remove a declined request, freeing its address to write again.
 *
 * The removal is conditional on the revision the decision was read from. That
 * matters because a request's identity is its address: the moment this record
 * is gone, the next submission from that address is created at exactly the same
 * pathname. A second, stale "Remove" would otherwise delete the new pending
 * request. It is refused as a conflict instead.
 *
 * The audit line survives, and never carried the message body, so what is kept
 * is Mike's decision and not what a stranger wrote about themselves.
 */
export async function removeDeclinedRequest(
  input: { requestId: string; actor: string },
  deps: OnboardingDeps = {},
): Promise<void> {
  const { store, rosterStore } = resolve(deps)

  const found = await loadRequestVersioned(input.requestId, store)
  if (!found) return
  if (found.request.status !== 'declined') {
    throw new AdminRequestError('Only a declined request can be removed.', 409)
  }

  if (!(await removeRequestIfMatch(input.requestId, found.version, store))) {
    throw new AdminRequestError(
      'That request changed while you were working on it. Reload and try again.',
      409,
    )
  }

  try {
    await rosterStore.appendAudit(
      newAuditEvent(input.actor, 'request.removed', '', 'Removed a declined request.', found.request.id),
    )
  } catch {
    // See `commitRoster`.
  }
}

/* ------------------------------------------------------- 5. the reviewer side */

export type CredentialOutcome =
  | { ok: true; reviewer: Reviewer }
  /**
   * Every refusal, by name, **for the server**. The visitor is shown one
   * generic page: telling apart "expired", "already used" and "never existed"
   * would map the gate for somebody probing it.
   */
  | { ok: false; reason: string }

/**
 * A refusal discovered *after* the credential was atomically spent.
 *
 * Thrown from inside the roster mutation's apply function, which `mutateRoster`
 * propagates because it retries only on `RosterConflictError`. Because the
 * apply function's write is conditional on the roster's revision, an
 * administrative change landing between its read and its write makes the write
 * fail, the mutation re-reads, and the re-applied function sees the new state
 * and throws. The decision to mint is therefore pinned to a roster version
 * whenever a write occurs.
 */
class CredentialSupersededError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(`the credential was refused after being spent: ${reason}`)
    this.name = 'CredentialSupersededError'
    this.reason = reason
  }
}

/**
 * Record that a credential was spent and then refused.
 *
 * Privacy-safe by construction: the reviewer id, the purpose and the refusal
 * reason, and nothing else. No address, no credential, no fingerprint, nothing
 * about the visitor. This is precisely the signal Mike wants -- somebody at an
 * old address, or somebody holding a link he had just invalidated, pressed the
 * button -- and the visitor still sees the same generic failure page.
 *
 * **A failure to write it never turns a refusal into a success.** It is the
 * last thing done on a path that has already decided to refuse.
 */
async function auditRefusedAfterSpend(
  purpose: CredentialPurpose,
  reviewerId: string,
  reason: string,
  rosterStore: ReviewerRosterStore,
): Promise<void> {
  try {
    await rosterStore.appendAudit(
      newAuditEvent(
        'system',
        'credential.refused-after-spend',
        reviewerId,
        `A spent ${purpose === 'signin' ? 'sign-in' : 'activation'} link was refused: ${reason}.`,
      ),
    )
  } catch {
    // Deliberately swallowed, and deliberately last. See above.
  }
}

/** Human-readable, for the audit line only. Never shown to a visitor. */
function describeRefusal(reason: string): string {
  if (reason === 'address-changed') return 'the address on file had changed'
  if (reason === 'invalidated') return 'the link had been invalidated'
  if (reason === 'not-authorized') return 'the reviewer was no longer active'
  if (reason === 'already-verified') return 'the address was already verified'
  if (reason === 'not-verified') return 'the address was not verified'
  if (reason === 'conflict') return 'the roster could not be read consistently'
  return reason
}

/**
 * Every pre-consumption refusal, decided from one credential record and one
 * uncached roster read, before anything at all is written.
 *
 * Returns a reason when the attempt must be refused, and null when it may
 * proceed to the used marker.
 */
function preConsumptionRefusal(
  purpose: CredentialPurpose,
  record: CredentialRecord,
  entry: RosterReviewer | undefined,
): string | null {
  if (!entry || entry.status !== 'active') return 'not-authorized'
  if (!sameLabel(credentialEmailLabel(entry.email), record.emailLabel)) return 'address-changed'
  if (entry.credentialEpoch !== record.credentialEpoch) return 'invalidated'

  if (purpose === 'activation') {
    /*
     * Once the verified-address update has committed, an activation credential
     * is finished. Without this rule an unused activation link would have gone
     * on working as a three-day sign-in link, which is the longest-lived
     * credential in the system.
     */
    if (entry.emailVerifiedAt) return 'already-verified'
    return null
  }

  if (!entry.emailVerifiedAt) return 'not-verified'
  return null
}

/**
 * Spend an activation credential: prove the address, open the account, and hand
 * back the reviewer a session can be minted for.
 *
 * The order is the security property, and it is the one in the header comment:
 * decide every refusal from an uncached pair of reads, create the used marker,
 * *then* commit the verified flag through the conditional roster mutation, and
 * only return a reviewer if that mutation agreed.
 *
 * Two activations racing under unchanged administrative state both succeed:
 * exactly one writes the flag, and the other's apply function finds it already
 * set under the same address label and the same epoch and returns "nothing to
 * do", which is idempotent success. That is two sessions for one person on two
 * devices, which is what two sign-ins would be anyway.
 */
export async function activateWithCredential(
  token: string,
  deps: OnboardingDeps = {},
): Promise<CredentialOutcome> {
  const { store, rosterStore, nowMs } = resolve(deps)

  /* ---- 1. read, and decide every refusal, writing nothing ----------- */

  const found = await lookupCredential('activation', token, store, nowMs)
  if (!found.ok) return { ok: false, reason: found.reason }

  const doc = await rosterStore.load()
  const entry = doc.reviewers.find((row) => row.id === found.record.reviewerId)

  const refusal = preConsumptionRefusal('activation', found.record, entry)
  if (refusal) return { ok: false, reason: refusal }

  /* ---- 2. spend it. This is the linearization point ----------------- */

  if (!(await spendCredential('activation', found.tokenHash, store, nowMs))) {
    return { ok: false, reason: 'already-used' }
  }

  /* ---- 3. confirm against the roster that is actually stored -------- */

  const record = found.record
  let settled: RosterDocument
  try {
    const outcome = await mutateRoster<null>((current) => {
      const row = current.reviewers.find((candidate) => candidate.id === record.reviewerId)
      if (!row || row.status !== 'active') throw new CredentialSupersededError('not-authorized')
      if (!sameLabel(credentialEmailLabel(row.email), record.emailLabel)) {
        throw new CredentialSupersededError('address-changed')
      }
      if (row.credentialEpoch !== record.credentialEpoch) {
        throw new CredentialSupersededError('invalidated')
      }
      // Already verified under this same address and epoch, by a concurrent
      // activation. Nothing to write, and that is success, not a refusal.
      if (row.emailVerifiedAt) return null

      return {
        reviewers: current.reviewers.map((candidate) =>
          candidate.id === row.id
            ? { ...candidate, emailVerifiedAt: new Date(nowMs).toISOString() }
            : candidate,
        ),
        event: newAuditEvent(
          `reviewer:${row.id}`,
          'reviewer.email-verified',
          row.id,
          `${row.name} proved their email address and opened their account.`,
          row.requestId ?? undefined,
        ),
        result: null,
      }
    }, rosterStore)
    settled = outcome.roster
  } catch (error) {
    if (error instanceof CredentialSupersededError) {
      await auditRefusedAfterSpend(
        'activation',
        record.reviewerId,
        describeRefusal(error.reason),
        rosterStore,
      )
      return { ok: false, reason: error.reason }
    }
    if (error instanceof RosterConflictError) {
      /*
       * The bookkeeping mutation could not land after its bounded retries. The
       * safe direction is refusal with the marker kept -- never "mint anyway",
       * and never a second attempt at the marker.
       */
      await auditRefusedAfterSpend(
        'activation',
        record.reviewerId,
        describeRefusal('conflict'),
        rosterStore,
      )
      return { ok: false, reason: 'conflict' }
    }
    throw error
  }

  const verified = settled.reviewers.find((row) => row.id === record.reviewerId)
  if (!verified || verified.status !== 'active') {
    await auditRefusedAfterSpend(
      'activation',
      record.reviewerId,
      describeRefusal('not-authorized'),
      rosterStore,
    )
    return { ok: false, reason: 'not-authorized' }
  }

  /* ---- 4. bookkeeping, after the decision, never before it ---------- */

  const requestId = record.requestId
  if (requestId) {
    try {
      await mutateRequest(
        requestId,
        (current) => {
          if (!current.activation || current.activation.usedAt) return null
          return {
            next: {
              ...current,
              status: 'approved' as const,
              activation: { ...current.activation, usedAt: new Date(nowMs).toISOString() },
            },
            result: null,
          }
        },
        store,
        nowMs,
      )
    } catch {
      // The dashboard would show "awaiting activation" for a reviewer who has in
      // fact activated. Wrong, but harmless, and not worth refusing them for.
    }
  }

  return { ok: true, reviewer: toReviewer(verified) }
}

/**
 * Send a sign-in link, if and only if that address belongs to an active
 * reviewer who has proved it.
 *
 * Returns nothing the caller can leak. The route answers identically whether
 * this sent anything or not.
 */
export async function requestSigninLink(
  rawEmail: string,
  deps: OnboardingDeps = {},
): Promise<MailResult | null> {
  const email = normalizeReviewerEmail(rawEmail)
  if (!isValidReviewerEmail(email)) return null

  const doc = await resolve(deps).rosterStore.load()
  const entry = doc.reviewers.find((row) => row.email && row.email === email)
  if (!entry || entry.status !== 'active' || !entry.emailVerifiedAt) return null

  return sendSigninLink(entry, deps)
}

async function sendSigninLink(
  reviewer: RosterReviewer,
  deps: OnboardingDeps = {},
): Promise<MailResult> {
  const { store, mailer, nowMs } = resolve(deps)

  const origin = siteOrigin()
  if (!origin) return { status: 'not-configured', providerId: null, error: 'no_site_origin' }

  const issued = await issueCredential(
    'signin',
    {
      reviewerId: reviewer.id,
      emailLabel: credentialEmailLabel(reviewer.email),
      credentialEpoch: reviewer.credentialEpoch,
      ttlMs: SIGNIN_TTL_MS,
    },
    store,
    nowMs,
  )
  if (!issued) return { status: 'not-configured', providerId: null, error: 'no_auth_secret' }

  return sendMailOperation(
    mailer,
    signinMessage({
      to: reviewer.email,
      name: reviewer.name,
      origin,
      token: issued.token,
      expiresAt: issued.expiresAt,
      operationId: issued.operationId,
      reviewerId: reviewer.id,
    }),
    store,
    nowMs,
  )
}

/**
 * Spend a sign-in credential.
 *
 * Same shape as activation, and the same rule after the marker: a fresh
 * uncached roster read decides whether a session is minted. There is no
 * bookkeeping write to pin that decision to, so the read *is* the decision, and
 * an administrative change landing after it is equivalent to one landing a
 * microsecond after the session was minted -- which no design prevents, and
 * which revocation and code rotation already cover on the next request.
 */
export async function signinWithCredential(
  token: string,
  deps: OnboardingDeps = {},
): Promise<CredentialOutcome> {
  const { store, rosterStore, nowMs } = resolve(deps)

  /* ---- 1. read, and decide every refusal, writing nothing ----------- */

  const found = await lookupCredential('signin', token, store, nowMs)
  if (!found.ok) return { ok: false, reason: found.reason }

  const before = await rosterStore.load()
  const refusal = preConsumptionRefusal(
    'signin',
    found.record,
    before.reviewers.find((row) => row.id === found.record.reviewerId),
  )
  if (refusal) return { ok: false, reason: refusal }

  /* ---- 2. spend it -------------------------------------------------- */

  if (!(await spendCredential('signin', found.tokenHash, store, nowMs))) {
    return { ok: false, reason: 'already-used' }
  }

  /* ---- 3 & 4. read the roster again, and confirm -------------------- */

  const record = found.record
  let after: RosterDocument
  try {
    after = await rosterStore.load()
  } catch {
    await auditRefusedAfterSpend('signin', record.reviewerId, describeRefusal('conflict'), rosterStore)
    return { ok: false, reason: 'conflict' }
  }

  const entry = after.reviewers.find((row) => row.id === record.reviewerId)
  const stillRefused = preConsumptionRefusal('signin', record, entry)
  if (stillRefused || !entry) {
    await auditRefusedAfterSpend(
      'signin',
      record.reviewerId,
      describeRefusal(stillRefused ?? 'not-authorized'),
      rosterStore,
    )
    return { ok: false, reason: stillRefused ?? 'not-authorized' }
  }

  /* ---- 5. only now is there a session ------------------------------- */

  try {
    await rosterStore.appendAudit(
      newAuditEvent(
        `reviewer:${entry.id}`,
        'signin.used',
        entry.id,
        `${entry.name} signed in with an emailed link.`,
      ),
    )
  } catch {
    // See `commitRoster`.
  }

  return { ok: true, reviewer: toReviewer(entry) }
}

/* --------------------------------------------------- 6. email maintenance */

/**
 * Add or correct a reviewer's email address.
 *
 * Changing it is a security event, not an edit, and it does four things at
 * once, **all inside one conditional roster mutation** so that they commit
 * together or not at all:
 *
 *   - the address changes;
 *   - it stops being verified, so email sign-in is unavailable until the new
 *     one is proved;
 *   - `credentialEpoch` advances, which kills every outstanding link for this
 *     reviewer immediately -- including, crucially, links sent to the *old*
 *     address that would otherwise become valid again if the address were later
 *     changed back within their lifetime;
 *   - the reviewer id, their entitlements, their place in the book, their
 *     bookmarks, highlights, notes and feedback are all untouched, because none
 *     of it was ever keyed on an address.
 *
 * **It does not end existing sessions.** That is the documented behaviour and
 * it is unchanged: sessions are bound to the reviewer id and the code
 * fingerprint, not to an address. Revocation and "New code" are what end
 * sessions. What an address change does guarantee is that no credential issued
 * under the previous address or epoch can mint a *new* session once the change
 * has committed.
 */
export async function setReviewerEmail(
  input: { reviewerId: string; email: unknown; actor: string },
  deps: OnboardingDeps = {},
): Promise<RosterReviewer> {
  const { rosterStore } = resolve(deps)

  const id = typeof input.reviewerId === 'string' ? input.reviewerId.trim() : ''
  if (!isValidReviewerId(id)) throw new AdminRequestError('That is not a valid reviewer.')

  const email = normalizeReviewerEmail(input.email)
  if (!isValidReviewerEmail(email)) {
    throw new AdminRequestError('That is not a valid email address.')
  }

  if (!rosterStore.writable) {
    throw new AdminRequestError(
      `The roster is being served by the read-only "${rosterStore.driver}" driver.`,
      409,
    )
  }

  const doc = await rosterStore.load()
  const entry = doc.reviewers.find((row) => row.id === id)
  if (!entry) throw new AdminRequestError('That reviewer is no longer on the roster.', 404)
  if (entry.email === email) return entry

  const outcome = await mutateRoster<RosterReviewer>((current) => {
    const row = current.reviewers.find((candidate) => candidate.id === id)
    if (!row) throw new AdminRequestError('That reviewer is no longer on the roster.', 404)
    // Re-checked against the stored document, so two address changes racing
    // cannot both pass a uniqueness test neither of them still satisfies.
    if (current.reviewers.some((other) => other.id !== id && other.email && other.email === email)) {
      throw new AdminRequestError(`There is already a reviewer with the address ${email}.`)
    }
    if (row.email === email) return null

    const updated: RosterReviewer = {
      ...row,
      email,
      emailVerifiedAt: null,
      credentialEpoch: row.credentialEpoch + 1,
    }
    return {
      reviewers: current.reviewers.map((candidate) => (candidate.id === id ? updated : candidate)),
      event: newAuditEvent(
        input.actor,
        'reviewer.email-changed',
        id,
        `Changed ${row.name}'s address. It is unverified, and every outstanding emailed link ` +
          'stopped working. Existing sessions were not ended.',
      ),
      result: updated,
    }
  }, rosterStore)

  if (!outcome.unchanged) return outcome.result

  const settled = outcome.roster.reviewers.find((row) => row.id === id)
  if (!settled) throw new AdminRequestError('That reviewer is no longer on the roster.', 404)
  return settled
}

/* ------------------------------------------------------- 7. what Mike sees */

export type RequestView = ReviewerRequest & {
  /** Whether an unused, unexpired, still-valid activation is outstanding now. */
  activationOutstanding: boolean
  /**
   * What the **roster** says about this request's reviewer, right now.
   *
   * The dashboard needs three decisions that only the roster can answer, and
   * answering them from the request record is what produced two defects: an
   * approval resume that reversed a revocation, and an access email whose link
   * was dead before it was sent. So the roster state travels with the view.
   */
  reviewerStatus: 'absent' | 'active' | 'revoked'
  /** Whether that reviewer has proved their address. Decides the email purpose. */
  reviewerVerified: boolean
  /**
   * True when this approval stopped part-way and its reviewer was revoked
   * afterwards. Finishing is refused in that state, so the card offers Restore
   * and Cancel instead of a button that would only fail.
   */
  approvalBlockedByRevocation: boolean
}

/**
 * The requests, decorated with the one fact the record alone cannot answer:
 * whether the credential it names is still good.
 *
 * "Still good" is four things, and the fourth is the one a record cannot know:
 * the credential exists, it has not expired, it has not been spent, and it was
 * issued under the reviewer's **current** epoch. Without that last test a link
 * Mike had just invalidated would keep reading as outstanding.
 */
export async function loadRequestViews(
  requests: ReviewerRequest[],
  deps: OnboardingDeps = {},
): Promise<RequestView[]> {
  const { store, rosterStore, nowMs } = resolve(deps)

  let roster: RosterDocument | null = null
  try {
    roster = await rosterStore.load()
  } catch {
    roster = null
  }

  const views: RequestView[] = []
  for (const request of requests) {
    const entry =
      roster && request.reviewerId
        ? roster.reviewers.find((row) => row.id === request.reviewerId)
        : undefined

    const reviewerStatus: RequestView['reviewerStatus'] = !request.reviewerId
      ? 'absent'
      : !entry
        ? 'absent'
        : entry.status === 'active'
          ? 'active'
          : 'revoked'

    let outstanding = false
    const hash = request.activation?.tokenHash
    if (entry && entry.status === 'active' && hash && !request.activation?.usedAt) {
      try {
        outstanding = await isOutstanding('activation', hash, entry.credentialEpoch, store, nowMs)
      } catch {
        outstanding = false
      }
    }

    views.push({
      ...request,
      activationOutstanding: outstanding,
      reviewerStatus,
      reviewerVerified: !!entry?.emailVerifiedAt,
      approvalBlockedByRevocation: request.status === 'approving' && reviewerStatus === 'revoked',
    })
  }

  return views
}
