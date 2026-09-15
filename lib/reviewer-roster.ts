/**
 * The reviewer roster, as runtime state.
 *
 * Until now the roster was `REVIEWER_ROSTER`: a JSON array in an environment
 * variable, read at request time but changeable only by editing the deployment.
 * Adding a reviewer, widening what one may read, or revoking one all meant a
 * redeploy. That is the thing this module replaces.
 *
 * What it is NOT is a new piece of infrastructure. The store this writes to is
 * the *same private Vercel Blob store* the feature already uses for reviewer
 * feedback, reached through the same `@vercel/blob` dependency and the same
 * `BLOB_READ_WRITE_TOKEN` credential that is already configured. No new
 * service, no new account, no new paid plan, and nothing irreversible was
 * created to make this work -- which was a hard precondition of the assignment
 * that produced it.
 *
 * The shape of the store, and why:
 *
 *   One document. The roster is small -- a handful of people -- and every read
 *   wants all of it, so it is one JSON object at one fixed pathname rather than
 *   an object per reviewer. A roster is also a set: "who may read" is only
 *   meaningful whole, and a partial roster is a wrong answer rather than a
 *   smaller one.
 *
 *   Overwritten, deliberately. Unlike feedback -- which is evidence, and
 *   immutable -- the roster is current state, so the document is written with
 *   `allowOverwrite: true`. Its *history* is not lost, because every mutation
 *   also appends an immutable audit object that is never rewritten.
 *
 *   Private. Same private store, same rule: an object URL is not a capability.
 *   Reading requires the store credential, which exists only on the server.
 *
 *   No code, ever. A roster entry holds the same keyed HMAC fingerprint of an
 *   access code (`codeHash`) that the env roster held. The code itself is
 *   generated, shown to the administrator exactly once, and never written here,
 *   to a log, or to anything else.
 *
 * Concurrency, for real this time. An earlier version of this file re-read the
 * document, compared `updatedAt`, and then overwrote -- and said in its own
 * comment that this was not compare-and-swap. It was not: two server functions
 * could both pass the check and the later write could discard the other's
 * reviewer creation, activation verification, address change, entitlement
 * change or revocation, silently. Every one of those is a security-sensitive
 * boundary, and the account lifecycle added by reviewer onboarding leans on all
 * of them.
 *
 * Both writable drivers now perform a genuine conditional write, and refuse
 * rather than clobber:
 *
 *   vercel-blob  reads the document's **ETag** alongside its bytes and writes
 *                with `put(..., { ifMatch })`, which the installed SDK
 *                documents as failing with `BlobPreconditionFailedError` when
 *                the object has moved. Creating the very first roster is the
 *                same operation with no ETag to match: `allowOverwrite: false`,
 *                which fails if anybody else got there first.
 *
 *   fs           holds the read, the check and the write inside a single
 *                synchronous section with no `await` in it, so nothing can
 *                interleave between them in this process, and matches a
 *                content digest as the version. (The fs driver is local
 *                development and single-process by construction; it is not a
 *                deployment target.)
 *
 * A conflict is a `RosterConflictError`, and `mutateRoster()` below turns that
 * into a bounded retry of the caller's *own* change against the document that
 * actually won -- so a lost update becomes a re-applied update, and an
 * irreconcilable one becomes an honest refusal rather than a silent overwrite.
 */

import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

if (typeof window !== 'undefined') {
  throw new Error(
    'lib/reviewer-roster is server-only and must not be imported by a client component',
  )
}

/** Layout version. It is part of every pathname, so a later layout is a new prefix. */
export const ROSTER_PREFIX_VERSION = 'v1'

/** Root of every object this module writes. */
export const ROSTER_ROOT = `roster/${ROSTER_PREFIX_VERSION}`

/** The one document that holds current state. */
export const ROSTER_DOCUMENT = `${ROSTER_ROOT}/roster.json`

/** Prefix under which immutable audit objects are appended. */
export const AUDIT_ROOT = `${ROSTER_ROOT}/audit`

/** Reviewer ids are used inside a dot-separated token, so their shape is constrained. */
const REVIEWER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** Book slugs appear in URLs and on disk, so their shape is constrained too. */
const BOOK_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Deliberately ordinary email validation.
 *
 * This address **is** sent to, and once it has been proved it **is** an
 * authentication factor: a reviewer can be sent an activation link or a
 * fifteen-minute sign-in link, and using one signs them in. An earlier version
 * of this comment said the opposite -- "never sent to, never used to
 * authenticate, reviewer sign-in is code-only" -- which described the system
 * before reviewer accounts and email existed, and was left behind by them.
 * Access codes still work; they are no longer the only way in.
 *
 * What is still true, and is the thing worth stating here: **typing an address
 * proves nothing.** See `emailVerifiedAt` below -- only somebody who received a
 * credential at this address and spent it can turn it into a factor. So the
 * check is shape, not deliverability -- one `@`, something either side, no
 * whitespace -- and nothing here pretends to know whether the mailbox is real
 * or whose it is.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/

export type ReviewerStatus = 'active' | 'revoked'

/** One reviewer, as the roster holds them. */
export type RosterReviewer = {
  /** Stable, non-secret identifier. Appears in the cookie and on feedback rows. */
  id: string
  /** Display name, shown to that reviewer and in the dashboard. */
  name: string
  /**
   * Normalised address. Identification until it is proved; an authentication
   * factor afterwards. `emailVerifiedAt` is the field that says which, and
   * nothing Mike types can set it.
   */
  email: string
  /** Book slugs this reviewer may open. */
  books: string[]
  /** `revoked` reviewers fail every check immediately, including live sessions. */
  status: ReviewerStatus
  /** Keyed fingerprint of the current access code. Never the code. */
  codeHash: string
  /** ISO 8601, UTC. */
  createdAt: string
  /** When the current code was issued. Replacing a code moves this. */
  codeUpdatedAt: string
  /** Last time this reviewer was authorised, to the hour. Null until they sign in. */
  lastAccessAt: string | null
  /**
   * When an emailed credential sent to `email` was actually used. Null until
   * then, and null again the moment the address is changed.
   *
   * This is the field that turns an address from identification into an
   * authentication factor, and it is deliberately the only thing that can:
   * Mike *typing* an address never sets it. If it did, one mistyped character
   * would mail a working sign-in link to a stranger. Only somebody who received
   * a credential at that address and used it can set this.
   */
  emailVerifiedAt: string | null
  /**
   * Which era of emailed credentials is currently valid for this reviewer.
   *
   * An integer, deliberately: a timestamp compared for equality lets two
   * rotations inside one millisecond produce the same value, which is the exact
   * trap `updatedAt` had to be nudged around. There is no clock here and
   * therefore no skew and no collision.
   *
   * Every credential records the value it was issued under, and consumption
   * requires **equality**. The number is incremented *inside the apply function
   * of the same conditional mutation* that performs the change it protects --
   * revocation, an email change, or an explicit "invalidate outstanding links"
   * -- so the epoch and that change always commit together, and a conflict
   * retry increments the winner's value rather than a stale one. Restoring a
   * revoked reviewer does not decrement it: the links it killed stay dead.
   *
   * Entries written before epochs existed have no field and parse as zero,
   * following the `emailVerifiedAt` precedent. There is no schema bump.
   */
  credentialEpoch: number
  /** How this reviewer came to exist. Display only; grants nothing. */
  origin: 'admin' | 'request'
  /** The access request this reviewer was approved from, if any. */
  requestId: string | null
}

export type RosterDocument = {
  schema: 1
  /** ISO 8601, UTC. Also the optimistic-concurrency marker for `save()`. */
  updatedAt: string
  reviewers: RosterReviewer[]
}

/** What happened, who did it, and to whom. Never what the code was. */
export type AuditEvent = {
  schema: 1
  id: string
  at: string
  /** The administrator's verified email. The only actor that can mutate a roster. */
  actor: string
  action:
    | 'reviewer.created'
    | 'reviewer.renamed'
    | 'reviewer.entitlements-changed'
    | 'reviewer.code-replaced'
    | 'reviewer.revoked'
    | 'reviewer.restored'
    | 'reviewer.email-changed'
    | 'reviewer.email-verified'
    /** Mike deliberately killing every outstanding link for one reviewer. */
    | 'reviewer.credentials-invalidated'
    /*
     * Request and credential events. Added rather than split into a second log:
     * "who was let in, by whom, and when" is one history, and reading it in two
     * places would be how a gap goes unnoticed. `asAuditEvent` accepts any
     * string action, so every object written before these existed still parses.
     */
    | 'request.received'
    | 'request.approved'
    | 'request.declined'
    | 'request.removed'
    /**
     * Mike abandoning an approval that stopped part-way and cannot be finished,
     * because the reviewer it created was revoked in the meantime. The reviewer
     * stays revoked and stays on the roster; only the request closes.
     */
    | 'request.approval-cancelled'
    | 'activation.sent'
    /**
     * A sign-in email, recorded as a sign-in email. A reviewer who has already
     * proved their address cannot use an activation link, so asking for "a new
     * access email" sends them a sign-in link -- and the log says which.
     */
    | 'signin.sent'
    | 'activation.used'
    | 'signin.used'
    /**
     * A credential that was atomically spent and then refused, because an
     * administrative change had landed under it. Exactly the signal Mike wants:
     * somebody at the old address, or somebody holding a link he had just
     * invalidated, pressed the button. It never carries an address, a
     * credential or anything else about the visitor.
     */
    | 'credential.refused-after-spend'
  /** The reviewer this concerns. Empty for an event that concerns only a request. */
  reviewerId: string
  /** The access request this concerns, when there is one. */
  requestId?: string
  /**
   * One short human-readable line.
   *
   * Contains no code, no credential, no token and no message body -- a declined
   * request's audit line outlives the request itself, and what somebody wrote
   * about themselves is not part of the permanent record of Mike's decision.
   */
  detail: string
}

export class RosterConflictError extends Error {
  constructor() {
    super('The roster changed while you were editing it. Reload and try again.')
    this.name = 'RosterConflictError'
  }
}

export class RosterReadOnlyError extends Error {
  constructor(driver: string) {
    super(`The "${driver}" roster driver cannot be edited at runtime.`)
    this.name = 'RosterReadOnlyError'
  }
}

/* ------------------------------------------------------------ normalisation */

/**
 * Normalise an address to the one form the roster stores and compares.
 *
 * Trimmed and lower-cased, and nothing else. Provider-specific folding -- Gmail
 * dots, `+` tags -- is deliberately NOT applied: guessing that two addresses are
 * the same mailbox is exactly the kind of cleverness that quietly merges two
 * different people. Two spellings are two entries, and Mike can see both.
 */
export function normalizeReviewerEmail(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.trim().toLowerCase()
}

export function isValidReviewerEmail(email: string): boolean {
  return email.length > 0 && email.length <= 254 && EMAIL_PATTERN.test(email)
}

export function isValidReviewerId(id: string): boolean {
  return REVIEWER_ID_PATTERN.test(id)
}

export function isValidBookSlug(slug: string): boolean {
  return BOOK_SLUG_PATTERN.test(slug)
}

/**
 * Derive a reviewer id from a name, for the dashboard's convenience.
 *
 * The administrator may always override it. Collisions are the caller's to
 * resolve -- this only proposes.
 */
export function suggestReviewerId(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return REVIEWER_ID_PATTERN.test(base) ? base : ''
}

/* -------------------------------------------------------------- parsing */

export function emptyRoster(): RosterDocument {
  return { schema: 1, updatedAt: new Date(0).toISOString(), reviewers: [] }
}

function isoOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : fallback
}

function asReviewer(value: unknown): RosterReviewer | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>

  const id = typeof row.id === 'string' ? row.id.trim() : ''
  const name = typeof row.name === 'string' ? row.name.trim() : ''
  const codeHash = typeof row.codeHash === 'string' ? row.codeHash.trim() : ''
  if (!REVIEWER_ID_PATTERN.test(id) || !name || !codeHash) return null

  // An entry written by the env roster has no email. It is identification, not
  // authentication, so its absence weakens nothing and is carried as empty.
  const email = normalizeReviewerEmail(row.email)

  if (!Array.isArray(row.books)) return null
  const books: string[] = []
  for (const slug of row.books) {
    if (typeof slug !== 'string' || !BOOK_SLUG_PATTERN.test(slug.trim())) return null
    books.push(slug.trim())
  }

  // Anything that is not exactly `revoked` is treated as active, so an entry
  // from an older shape keeps working. Revocation is never inferred.
  const status: ReviewerStatus = row.status === 'revoked' ? 'revoked' : 'active'

  const createdAt = isoOr(row.createdAt, new Date(0).toISOString())

  return {
    id,
    name,
    email,
    books,
    status,
    codeHash,
    createdAt,
    codeUpdatedAt: isoOr(row.codeUpdatedAt, createdAt),
    lastAccessAt:
      typeof row.lastAccessAt === 'string' && !Number.isNaN(Date.parse(row.lastAccessAt))
        ? row.lastAccessAt
        : null,
    /*
     * The three fields below post-date every roster written before reviewer
     * accounts existed, and are read tolerantly for exactly that reason. An
     * entry that lacks them is not malformed -- it is an entry from before, and
     * it parses to "no verified address, created by Mike, from no request",
     * which is precisely what it was. Nothing about the old shape became
     * invalid, so there is no schema bump. This follows the `paragraphOffset`
     * precedent in `lib/reviewer-reading.ts`.
     *
     * Note the default for `emailVerifiedAt` is null, never a timestamp: an
     * address that predates verification has not been verified, and inferring
     * otherwise would hand every legacy entry an authentication factor nobody
     * ever proved.
     */
    emailVerifiedAt:
      typeof row.emailVerifiedAt === 'string' && !Number.isNaN(Date.parse(row.emailVerifiedAt))
        ? row.emailVerifiedAt
        : null,
    credentialEpoch:
      typeof row.credentialEpoch === 'number' &&
      Number.isInteger(row.credentialEpoch) &&
      row.credentialEpoch >= 0
        ? row.credentialEpoch
        : 0,
    origin: row.origin === 'request' ? 'request' : 'admin',
    requestId: typeof row.requestId === 'string' && row.requestId ? row.requestId : null,
  }
}

/**
 * Parse a stored roster document.
 *
 * One malformed reviewer disqualifies the whole document, exactly as the env
 * roster behaved: serving a partial roster could hand someone the wrong
 * entitlements, or silently drop a revocation. Duplicate ids, duplicate
 * fingerprints and duplicate non-empty emails are all refused for the same
 * reason.
 */
export function parseRosterDocument(raw: string): RosterDocument | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const doc = parsed as Record<string, unknown>
  if (doc.schema !== 1) return null
  if (!Array.isArray(doc.reviewers)) return null

  const reviewers: RosterReviewer[] = []
  const seenIds = new Set<string>()
  const seenHashes = new Set<string>()
  const seenEmails = new Set<string>()

  for (const value of doc.reviewers) {
    const reviewer = asReviewer(value)
    if (!reviewer) return null
    if (seenIds.has(reviewer.id)) return null
    if (seenHashes.has(reviewer.codeHash)) return null
    if (reviewer.email && seenEmails.has(reviewer.email)) return null
    seenIds.add(reviewer.id)
    seenHashes.add(reviewer.codeHash)
    if (reviewer.email) seenEmails.add(reviewer.email)
    reviewers.push(reviewer)
  }

  return {
    schema: 1,
    updatedAt: isoOr(doc.updatedAt, new Date(0).toISOString()),
    reviewers,
  }
}

export function serializeRosterDocument(doc: RosterDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`
}

/**
 * The next value of `updatedAt`, guaranteed to be strictly greater than the
 * last one.
 *
 * `updatedAt` is doing two jobs: it is a human-readable "when did this last
 * change", and it is the marker `save()` compares to detect a concurrent write.
 * The second job is the one with a trap in it -- an ISO timestamp has
 * millisecond resolution, and two saves inside the same millisecond produce the
 * *same* string. A stale document would then compare equal to the current one
 * and be allowed to overwrite it, which is precisely the conflict the check
 * exists to catch.
 *
 * So the clock is used when it has moved, and nudged forward by a millisecond
 * when it has not. The value stays an ordinary timestamp, and it never repeats.
 */
export function nextUpdatedAt(previous: string, nowMs: number = Date.now()): string {
  const previousMs = Date.parse(previous)
  const baseline = Number.isFinite(previousMs) ? previousMs : 0
  return new Date(nowMs > baseline ? nowMs : baseline + 1).toISOString()
}

/* ------------------------------------------------------------- the boundary */

/**
 * A document and the exact stored revision it was read from.
 *
 * `version` is opaque and driver-specific: an ETag on Vercel Blob, a content
 * digest on the filesystem. `null` means *no document existed*, which is a
 * distinct precondition from "a document existed and looked like this" -- it is
 * what makes creating the first roster safe against two callers doing it at
 * once.
 */
export type VersionedRoster = {
  doc: RosterDocument
  version: string | null
}

export type ReviewerRosterStore = {
  /** Short driver name, for diagnostics. Never includes a credential. */
  readonly driver: string
  /** Whether the dashboard may mutate this roster at runtime. */
  readonly writable: boolean
  load(): Promise<RosterDocument>
  /**
   * Read the document together with the revision it was read from, for a
   * caller that is about to write it back conditionally.
   */
  loadForUpdate(): Promise<VersionedRoster>
  /**
   * Replace the document, conditionally.
   *
   * `expectedUpdatedAt` is the `updatedAt` the caller read. `version` is the
   * revision it was read from, from `loadForUpdate()`; pass `null` to mean "no
   * document existed", and omit it only when the caller has not read one, in
   * which case this reads it itself. When the stored document has moved on --
   * by either test -- this throws `RosterConflictError` rather than overwriting
   * somebody else's change.
   */
  save(
    next: RosterDocument,
    expectedUpdatedAt: string,
    version?: string | null,
  ): Promise<RosterDocument>
  appendAudit(event: AuditEvent): Promise<void>
  /** Most recent first. */
  listAudit(limit: number): Promise<AuditEvent[]>
}

/** How many times a conflicting mutation is re-applied before giving up. */
export const ROSTER_MUTATION_ATTEMPTS = 5

/**
 * What one roster mutation is: a pure function from the document that is
 * actually stored to the reviewers that should replace it, the audit line that
 * describes the change, and whatever the caller wants back.
 *
 * It is a function rather than a precomputed array precisely so that a conflict
 * can be retried: the change is re-derived from the document that won, instead
 * of a stale one being written over it. It may be called more than once, so it
 * must not have side effects of its own -- every caller here only reads the
 * document and builds objects.
 *
 * Returning `null` means "nothing to do", and nothing is written. An `event`
 * of `null` means the change is real but not an administrative act worth a line
 * in the audit log -- `lastAccessAt` is the only such change.
 */
export type RosterMutation<T> = (
  doc: RosterDocument,
) => { reviewers: RosterReviewer[]; event: AuditEvent | null; result: T } | null

export type RosterMutationOutcome<T> = {
  roster: RosterDocument
  result: T
  /** True when the mutation decided there was nothing to write. */
  unchanged: boolean
}

/**
 * Apply one change to the roster, against whatever is actually stored.
 *
 * Load, derive, write conditionally; on a conflict, load the document that won
 * and derive again. A caller's validation lives inside `apply`, so a change
 * that has become impossible (the reviewer was removed, the address is now
 * taken) throws from there on the retry and is reported honestly instead of
 * being forced through.
 *
 * The audit append happens after the save and deliberately: an audit line for a
 * change that did not land would be worse than a missing one, because it would
 * be read later as evidence that it did.
 */
export async function mutateRoster<T>(
  apply: RosterMutation<T>,
  store: ReviewerRosterStore = createRosterStore(),
): Promise<RosterMutationOutcome<T>> {
  let lastConflict: RosterConflictError | null = null

  for (let attempt = 0; attempt < ROSTER_MUTATION_ATTEMPTS; attempt += 1) {
    const { doc, version } = await store.loadForUpdate()
    const change = apply(doc)
    if (!change) return { roster: doc, result: undefined as T, unchanged: true }

    let saved: RosterDocument
    try {
      saved = await store.save({ ...doc, reviewers: change.reviewers }, doc.updatedAt, version)
    } catch (error) {
      if (error instanceof RosterConflictError) {
        lastConflict = error
        continue
      }
      throw error
    }

    if (change.event) {
      try {
        await store.appendAudit(change.event)
      } catch {
        // The roster is the source of truth; the log is a courtesy.
      }
    }

    return { roster: saved, result: change.result, unchanged: false }
  }

  // Honest refusal. Nothing was written, and nothing of anybody else's was
  // discarded to get here.
  throw lastConflict ?? new RosterConflictError()
}

export function newAuditEvent(
  actor: string,
  action: AuditEvent['action'],
  reviewerId: string,
  detail: string,
  requestId?: string,
): AuditEvent {
  return {
    schema: 1,
    id: randomUUID(),
    at: new Date().toISOString(),
    actor,
    action,
    reviewerId,
    ...(requestId ? { requestId } : {}),
    detail,
  }
}

function asAuditEvent(value: unknown): AuditEvent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (row.schema !== 1) return null
  if (typeof row.id !== 'string' || typeof row.actor !== 'string') return null
  if (typeof row.at !== 'string' || Number.isNaN(Date.parse(row.at))) return null
  if (typeof row.action !== 'string' || typeof row.reviewerId !== 'string') return null
  if (typeof row.detail !== 'string') return null
  return value as AuditEvent
}

/** The pathname of one audit object. Timestamp first, so a listing is chronological. */
export function auditPathname(event: AuditEvent): string {
  return `${AUDIT_ROOT}/${event.at.replace(/[:.]/g, '-')}-${event.id}.json`
}

/* ------------------------------------------------------ read-only env driver */

/**
 * The roster as it was: `REVIEWER_ROSTER`, read-only.
 *
 * Kept so a deployment that has not been given a writable store keeps working
 * exactly as before rather than losing its reviewers. The dashboard refuses to
 * mutate it and says why, instead of appearing to save and silently discarding
 * the change on the next cold start.
 */
class EnvRosterStore implements ReviewerRosterStore {
  readonly driver = 'env'
  readonly writable = false

  async load(): Promise<RosterDocument> {
    const source = (process.env.REVIEWER_ROSTER ?? '').trim()
    if (!source) return emptyRoster()

    // The env roster is a bare array; wrap it in the document shape and let the
    // one parser above decide whether every entry is acceptable.
    let parsed: unknown
    try {
      parsed = JSON.parse(source)
    } catch {
      return emptyRoster()
    }
    if (!Array.isArray(parsed)) return emptyRoster()

    return (
      parseRosterDocument(
        JSON.stringify({ schema: 1, updatedAt: new Date(0).toISOString(), reviewers: parsed }),
      ) ?? emptyRoster()
    )
  }

  async loadForUpdate(): Promise<VersionedRoster> {
    return { doc: await this.load(), version: null }
  }

  async save(): Promise<RosterDocument> {
    throw new RosterReadOnlyError(this.driver)
  }

  async appendAudit(): Promise<void> {
    throw new RosterReadOnlyError(this.driver)
  }

  async listAudit(): Promise<AuditEvent[]> {
    return []
  }
}

/* --------------------------------------------------- unconfigured (default) */

/**
 * No roster at all.
 *
 * Every check against it fails, which is the correct behaviour for a
 * deployment that has not been configured: nobody is admitted. Reading is not
 * an error -- there genuinely are no reviewers -- but writing is refused
 * loudly rather than accepted and dropped.
 */
class UnconfiguredRosterStore implements ReviewerRosterStore {
  readonly driver = 'unconfigured'
  readonly writable = false

  async load(): Promise<RosterDocument> {
    return emptyRoster()
  }

  async loadForUpdate(): Promise<VersionedRoster> {
    return { doc: emptyRoster(), version: null }
  }

  async save(): Promise<RosterDocument> {
    throw new RosterReadOnlyError(this.driver)
  }

  async appendAudit(): Promise<void> {
    throw new RosterReadOnlyError(this.driver)
  }

  async listAudit(): Promise<AuditEvent[]> {
    return []
  }
}

/* -------------------------------------------------------- filesystem driver */

/**
 * A JSON document and an append-only audit log on disk.
 *
 * Durable wherever the filesystem is -- local development, a self-hosted
 * server, a host with a persistent volume -- and NOT durable on a serverless
 * host. It is the driver the tests drive, and the one Mike runs against
 * locally, so the dashboard can be exercised end to end without touching a
 * production store.
 */
class FileSystemRosterStore implements ReviewerRosterStore {
  readonly driver = 'fs'
  readonly writable = true

  private readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  private get documentPath(): string {
    return join(this.root, 'roster.json')
  }

  private get auditPath(): string {
    return join(this.root, 'audit.ndjson')
  }

  /**
   * Read the document synchronously, with the digest it hashes to.
   *
   * Synchronous on purpose: `save()` below repeats exactly this read inside its
   * own uninterrupted section, and the two must be the same operation for the
   * version to mean anything.
   */
  private readVersioned(): VersionedRoster {
    if (!existsSync(this.documentPath)) return { doc: emptyRoster(), version: null }
    const raw = readFileSync(this.documentPath, 'utf8')
    const parsed = parseRosterDocument(raw)
    if (!parsed) {
      // A document that does not parse is a configuration fault, not an empty
      // roster. Saying so is what keeps a corrupted file from reading as
      // "nobody has access" and then being overwritten with that.
      throw new Error('the stored roster document is malformed')
    }
    return { doc: parsed, version: createHash('sha256').update(raw, 'utf8').digest('hex') }
  }

  async load(): Promise<RosterDocument> {
    return this.readVersioned().doc
  }

  async loadForUpdate(): Promise<VersionedRoster> {
    return this.readVersioned()
  }

  /**
   * Conditional write, as one uninterrupted synchronous section.
   *
   * There is no `await` between reading the stored bytes and writing the new
   * ones, so no other caller in this process can interleave between the check
   * and the write -- which is what makes this a compare-and-swap rather than
   * the read-then-hope it used to be. Two callers that both read the same
   * document produce one winner and one `RosterConflictError`.
   */
  async save(
    next: RosterDocument,
    expectedUpdatedAt: string,
    version?: string | null,
  ): Promise<RosterDocument> {
    const current = this.readVersioned()

    if (version !== undefined && current.version !== version) throw new RosterConflictError()
    if (current.doc.updatedAt !== expectedUpdatedAt) throw new RosterConflictError()

    const written: RosterDocument = {
      ...next,
      schema: 1,
      updatedAt: nextUpdatedAt(current.doc.updatedAt),
    }
    mkdirSync(dirname(this.documentPath), { recursive: true })
    writeFileSync(this.documentPath, serializeRosterDocument(written), 'utf8')
    return written
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    mkdirSync(dirname(this.auditPath), { recursive: true })
    appendFileSync(this.auditPath, `${JSON.stringify(event)}\n`, 'utf8')
  }

  async listAudit(limit: number): Promise<AuditEvent[]> {
    if (!existsSync(this.auditPath)) return []
    const events: AuditEvent[] = []
    for (const line of readFileSync(this.auditPath, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      try {
        const event = asAuditEvent(JSON.parse(line))
        if (event) events.push(event)
      } catch {
        continue
      }
    }
    events.sort((a, b) => (a.at === b.at ? b.id.localeCompare(a.id) : b.at.localeCompare(a.at)))
    return events.slice(0, limit)
  }
}

/* ------------------------------------------------------- vercel blob driver */

/**
 * The narrow slice of Vercel Blob this driver uses.
 *
 * Declared here for the same two reasons the feedback driver declares one: the
 * SDK's wider surface stays out of reach, and the driver's behaviour can be
 * tested against a store that misbehaves on purpose.
 */
export type RosterBlobBackend = {
  /** Write one object, replacing it when `overwrite` is true. */
  putObject(pathname: string, body: string, overwrite: boolean): Promise<void>
  /**
   * Conditional write. `etag` is the revision the caller read; `null` means the
   * object must not exist yet.
   *
   * Resolves `true` when the write landed and `false` when the precondition
   * failed -- that is, when somebody else wrote first. Anything else (network,
   * credential, service) **rejects**, because treating a failure as "somebody
   * else won" would turn an outage into a silently dropped change.
   */
  putObjectIfMatch(pathname: string, body: string, etag: string | null): Promise<boolean>
  /** One object's bytes and the revision they were read at. */
  readObjectWithEtag(pathname: string): Promise<{ body: string | null; etag: string | null }>
  /** Every pathname beneath a prefix, following pagination to the end. */
  listPathnames(prefix: string): Promise<string[]>
  /**
   * One object's bytes, or `null` when the store answered and it is not there.
   *
   * A storage, network or credential failure must *reject*. Reporting it as
   * `null` would turn an outage into "the roster is empty", and an empty
   * roster is a roster that admits nobody -- or, worse, one that a subsequent
   * save would persist over the real one.
   */
  readObject(pathname: string): Promise<string | null>
}

/**
 * The complete sentence the September 14 V2 run recorded, verbatim, byte for
 * byte identical to `lib/private-store.ts:CONDITIONAL_CONFLICT_MESSAGE`.
 *
 * Kept as a whole message rather than a fragment on purpose: see the comment
 * at the use site, and `lib/private-store.ts:isDemonstratedBlobRefusal` for
 * why the class is tested with `Object.getPrototypeOf` rather than
 * `instanceof`.
 */
const CONDITIONAL_CONFLICT_MESSAGE =
  'Vercel Blob: The conditional request cannot succeed due to a conflicting operation against this resource.'

export function createRosterBlobBackend(token: string): RosterBlobBackend {
  return {
    async putObject(pathname, body, overwrite) {
      const { put } = await import('@vercel/blob')
      await put(pathname, body, {
        token,
        access: 'private',
        contentType: 'application/json; charset=utf-8',
        allowOverwrite: overwrite,
        addRandomSuffix: false,
      })
    },

    async putObjectIfMatch(pathname, body, etag) {
      const { put, BlobError, BlobPreconditionFailedError } = await import('@vercel/blob')
      try {
        await put(pathname, body, {
          token,
          access: 'private',
          contentType: 'application/json; charset=utf-8',
          addRandomSuffix: false,
          // No ETag to match means "this must not exist yet", which is the
          // first-ever roster. With one, `ifMatch` implies overwriting.
          ...(etag === null ? { allowOverwrite: false } : { ifMatch: etag }),
        })
        return true
      } catch (error) {
        if (error instanceof BlobPreconditionFailedError) return false
        /*
         * The "already exists" refusal from `allowOverwrite: false` is not a
         * typed class on this SDK's surface, so it is matched on its message --
         * narrowly, and only for the create case. Anything else re-throws: a
         * credential or network failure reported as "somebody else won" would
         * lose a change and say nothing.
         */
        const message = error instanceof Error ? error.message.toLowerCase() : ''
        if (etag === null && (message.includes('already exists') || message.includes('allowoverwrite'))) {
          return false
        }
        /*
         * The service's *second* way of refusing a lost compare-and-swap, kept
         * identical to `lib/private-store.ts:looksLikeConditionalConflict` --
         * see that function for the evidence and for the failures this
         * deliberately does not match.
         *
         * In short: the September 14 instrumented probe run found that of 190
         * conditional losers, 77 arrived as `BlobPreconditionFailedError` and
         * 113 as an untyped `bad_request` saying "The conditional request
         * cannot succeed due to a conflicting operation against this
         * resource", and the same run read back every round to show that no
         * refused writer had persisted anything. The two adapters have to
         * agree about this or the roster and the private store would disagree
         * about what a conflict is; they are checked against each other in
         * `tests/blob-refusal-mapping.test.ts`, which drives both real
         * adapters over the SDK's own error classes.
         *
         * A demonstrated provider shape is a class plus a full message: the
         * base `BlobError` itself, and the complete sentence, compared whole.
         * A subclass, a wrapper, or a longer message containing that sentence
         * is a different error wearing a familiar phrase, and it rejects --
         * which matters most here, because this is the adapter `mutateRoster`
         * retries. An ambiguous answer read as a definite loss would be
         * re-applied up to `ROSTER_MUTATION_ATTEMPTS` times. Message drift
         * must fail toward unknown.
         *
         * Conditional branch only. A create-if-absent sends no conditional
         * request and so can never honestly receive this answer.
         */
        if (
          etag !== null &&
          error instanceof Error &&
          Object.getPrototypeOf(error) === BlobError.prototype &&
          error.message === CONDITIONAL_CONFLICT_MESSAGE
        ) {
          return false
        }
        throw error
      }
    },

    async readObjectWithEtag(pathname) {
      const { get } = await import('@vercel/blob')
      const result = await get(pathname, { token, access: 'private', useCache: false })
      if (!result?.stream) return { body: null, etag: null }
      return {
        body: await new Response(result.stream).text(),
        etag: result.blob?.etag ?? null,
      }
    },

    async listPathnames(prefix) {
      const { list } = await import('@vercel/blob')
      const pathnames: string[] = []
      let cursor: string | undefined
      for (;;) {
        const page = await list({ token, prefix, cursor })
        for (const blob of page.blobs) pathnames.push(blob.pathname)
        if (!page.hasMore || !page.cursor) break
        cursor = page.cursor
      }
      return pathnames
    },

    async readObject(pathname) {
      const { get } = await import('@vercel/blob')
      const result = await get(pathname, {
        token,
        access: 'private',
        // A revocation made a moment ago must be readable a moment later.
        // Serving a cached roster would keep a revoked reviewer reading.
        useCache: false,
      })
      if (!result?.stream) return null
      return await new Response(result.stream).text()
    },
  }
}

class VercelBlobRosterStore implements ReviewerRosterStore {
  readonly driver = 'vercel-blob'
  readonly writable = true

  private readonly backend: RosterBlobBackend

  constructor(backend: RosterBlobBackend) {
    this.backend = backend
  }

  private parse(raw: string | null): RosterDocument {
    // `null` is the honest empty case: the store answered and no roster has
    // been written yet. A failure to reach the store throws, in the backend.
    if (raw === null) return emptyRoster()
    const parsed = parseRosterDocument(raw)
    if (!parsed) throw new Error('the stored roster document is malformed')
    return parsed
  }

  async load(): Promise<RosterDocument> {
    return this.parse(await this.backend.readObject(ROSTER_DOCUMENT))
  }

  async loadForUpdate(): Promise<VersionedRoster> {
    const { body, etag } = await this.backend.readObjectWithEtag(ROSTER_DOCUMENT)
    // No object means no revision to match, which is its own precondition.
    return { doc: this.parse(body), version: body === null ? null : etag }
  }

  /**
   * Conditional write against the ETag the document was read at.
   *
   * A caller that already read the document passes its version through; one
   * that did not gets the read done here, so that the `updatedAt` check and the
   * ETag come from the same read and there is no gap between them.
   */
  async save(
    next: RosterDocument,
    expectedUpdatedAt: string,
    version?: string | null,
  ): Promise<RosterDocument> {
    let expectedVersion: string | null
    let currentUpdatedAt: string

    if (version === undefined) {
      const read = await this.loadForUpdate()
      expectedVersion = read.version
      currentUpdatedAt = read.doc.updatedAt
    } else {
      expectedVersion = version
      currentUpdatedAt = expectedUpdatedAt
    }

    if (currentUpdatedAt !== expectedUpdatedAt) throw new RosterConflictError()

    const written: RosterDocument = {
      ...next,
      schema: 1,
      updatedAt: nextUpdatedAt(currentUpdatedAt),
    }

    const landed = await this.backend.putObjectIfMatch(
      ROSTER_DOCUMENT,
      serializeRosterDocument(written),
      expectedVersion,
    )
    // Somebody else wrote between the read and this write. Nothing of theirs
    // was overwritten, and nothing of ours was written.
    if (!landed) throw new RosterConflictError()

    return written
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    // Immutable, like feedback: history is evidence, and evidence is not
    // edited in place.
    await this.backend.putObject(auditPathname(event), `${JSON.stringify(event, null, 2)}\n`, false)
  }

  async listAudit(limit: number): Promise<AuditEvent[]> {
    const pathnames = await this.backend.listPathnames(`${AUDIT_ROOT}/`)
    // Chronological by pathname, newest first, so only `limit` objects are read.
    pathnames.sort((a, b) => b.localeCompare(a))

    const events: AuditEvent[] = []
    for (const pathname of pathnames.slice(0, limit)) {
      const raw = await this.backend.readObject(pathname)
      if (raw === null) continue
      try {
        const event = asAuditEvent(JSON.parse(raw))
        if (event) events.push(event)
      } catch {
        continue
      }
    }
    events.sort((a, b) => (a.at === b.at ? b.id.localeCompare(a.id) : b.at.localeCompare(a.at)))
    return events
  }
}

export function createVercelBlobRosterStore(options: {
  token?: string
  backend?: RosterBlobBackend
}): ReviewerRosterStore {
  const backend =
    options.backend ??
    createRosterBlobBackend(
      (() => {
        const token = (options.token ?? '').trim()
        if (!token) {
          throw new Error('REVIEWER_ROSTER_DRIVER=vercel-blob requires BLOB_READ_WRITE_TOKEN')
        }
        return token
      })(),
    )
  return new VercelBlobRosterStore(backend)
}

/* ----------------------------------------------------------------- factory */

let store: ReviewerRosterStore | null = null

/**
 * The configured roster store for this process.
 *
 * Selection is explicit, with one deliberate exception: a deployment that sets
 * no driver but still has a `REVIEWER_ROSTER` gets the read-only env driver, so
 * upgrading this code does not lock out the reviewers a deployment already had.
 * Everything else that is unset fails closed to a roster of nobody.
 */
export function createRosterStore(): ReviewerRosterStore {
  if (store) return store

  const driver = (process.env.REVIEWER_ROSTER_DRIVER ?? '').trim().toLowerCase()

  if (driver === 'fs') {
    const dir = (process.env.REVIEWER_ROSTER_DIR ?? '').trim()
    if (!dir) throw new Error('REVIEWER_ROSTER_DRIVER=fs requires REVIEWER_ROSTER_DIR')
    store = new FileSystemRosterStore(dir)
  } else if (driver === 'vercel-blob') {
    store = createVercelBlobRosterStore({ token: process.env.BLOB_READ_WRITE_TOKEN })
  } else if (driver === 'env') {
    store = new EnvRosterStore()
  } else if (!driver && (process.env.REVIEWER_ROSTER ?? '').trim()) {
    store = new EnvRosterStore()
  } else {
    store = new UnconfiguredRosterStore()
  }

  return store
}

/** Test seam. Resets the memoised store so a test can drive each driver. */
export function __resetRosterStore(): void {
  store = null
}

/**
 * A short, non-reversible digest of an access code, for one purpose only:
 * proving in a test that two values differ without writing either one down.
 * It is never stored and never logged.
 */
export function codeDigest(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex').slice(0, 12)
}
