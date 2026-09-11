/**
 * The operations the reviewer dashboard performs.
 *
 * Everything that changes who may read what goes through this module, and each
 * operation does the same four things in the same order: validate the request,
 * apply it to a freshly loaded roster, save with optimistic concurrency, and
 * append one audit line. Nothing here renders anything and nothing here decides
 * who is allowed to call it -- authorization happened before, in the route
 * handler, against `lib/admin-auth.ts`.
 *
 * The one invariant worth stating on its own: **an access code exists in
 * plaintext only inside `createReviewer` and `replaceReviewerCode`, only as a
 * return value, and only for the single response that shows it to Mike.** It is
 * never written to the roster, never written to the audit log, never logged,
 * never put in a URL, and cannot be recovered afterwards from anything this
 * system stores. Losing a code means issuing a new one, which is one click and
 * is exactly what the dashboard offers.
 */

import { fingerprintAccessCode } from './reviewer-access.ts'
import { generateAccessCode } from './reviewer-code.ts'
import { listBookSlugs } from './manuscript.ts'
import {
  createRosterStore,
  isValidBookSlug,
  isValidReviewerEmail,
  isValidReviewerId,
  newAuditEvent,
  normalizeReviewerEmail,
  suggestReviewerId,
  type AuditEvent,
  type RosterDocument,
  type RosterReviewer,
} from './reviewer-roster.ts'

if (typeof window !== 'undefined') {
  throw new Error(
    'lib/reviewer-admin is server-only and must not be imported by a client component',
  )
}

/** How many audit lines the dashboard shows. Minimal, and enough to answer "what changed?". */
export const AUDIT_PAGE_SIZE = 40

/**
 * A refusal the dashboard can show verbatim.
 *
 * These messages are read by exactly one person -- Mike, already authenticated
 * -- so they are allowed to be specific and useful. That is the opposite of the
 * reviewer gate, whose failures are deliberately generic because they are read
 * by strangers.
 */
export class AdminRequestError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'AdminRequestError'
    this.status = status
  }
}

/** The books a reviewer can actually be given. Derived, never typed in. */
export function assignableBookSlugs(): string[] {
  return listBookSlugs()
}

export type AdminView = {
  driver: string
  writable: boolean
  updatedAt: string
  reviewers: RosterReviewer[]
  audit: AuditEvent[]
  books: string[]
}

/**
 * Everything the dashboard renders, in one read.
 *
 * The audit log is best-effort: a store that cannot list it should not stop
 * Mike seeing -- and revoking -- his reviewers. A roster that cannot be read is
 * a different matter entirely and propagates, because every row below it would
 * be a guess.
 */
export async function loadAdminView(): Promise<AdminView> {
  const store = createRosterStore()
  const doc = await store.load()

  let audit: AuditEvent[] = []
  try {
    audit = await store.listAudit(AUDIT_PAGE_SIZE)
  } catch {
    audit = []
  }

  return {
    driver: store.driver,
    writable: store.writable,
    updatedAt: doc.updatedAt,
    reviewers: [...doc.reviewers].sort((a, b) => a.name.localeCompare(b.name)),
    audit,
    books: assignableBookSlugs(),
  }
}

/* ------------------------------------------------------------- validation */

function requireWritable(): void {
  const store = createRosterStore()
  if (!store.writable) {
    throw new AdminRequestError(
      `The roster is being served by the read-only "${store.driver}" driver, so it cannot be ` +
        'edited here. Set REVIEWER_ROSTER_DRIVER to a writable driver to manage reviewers ' +
        'from this dashboard.',
      409,
    )
  }
}

function cleanName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : ''
  if (!name) throw new AdminRequestError('A name is required.')
  if (name.length > 80) throw new AdminRequestError('That name is too long.')
  return name
}

function cleanEmail(raw: unknown): string {
  const email = normalizeReviewerEmail(raw)
  if (!email) throw new AdminRequestError('An email address is required.')
  if (!isValidReviewerEmail(email)) throw new AdminRequestError('That is not a valid email address.')
  return email
}

/**
 * Clean a set of entitlements.
 *
 * Every slug must be one this deployment actually has a manuscript for. A
 * reviewer entitled to a book that does not exist is not dangerous, but it is a
 * silent lie in the dashboard -- the row would claim access to something that
 * can never appear -- so it is refused at the point of entry.
 */
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

function findOrThrow(doc: RosterDocument, id: string): RosterReviewer {
  const reviewer = doc.reviewers.find((row) => row.id === id)
  if (!reviewer) throw new AdminRequestError('That reviewer is no longer on the roster.', 404)
  return reviewer
}

/**
 * Apply a change and record it.
 *
 * The save happens before the audit append, and deliberately: an audit line for
 * a change that did not land would be worse than a missing one, because it
 * would be read later as evidence that it did. If the append fails after a
 * successful save the change stands and the line is lost, which is the failure
 * this ordering chooses.
 */
async function commit(
  doc: RosterDocument,
  next: RosterReviewer[],
  event: AuditEvent,
): Promise<RosterDocument> {
  const store = createRosterStore()
  const saved = await store.save({ ...doc, reviewers: next }, doc.updatedAt)
  try {
    await store.appendAudit(event)
  } catch {
    // See above. The roster is the source of truth; the log is a courtesy.
  }
  return saved
}

/* ------------------------------------------------------------- operations */

export type IssuedCode = {
  reviewerId: string
  name: string
  /**
   * The plaintext code, for this response only.
   *
   * Handed to the dashboard, shown once behind an explicit "I have copied it"
   * confirmation, and then gone. Nothing stores it.
   */
  code: string
}

/**
 * Add a reviewer, and issue their first code.
 *
 * The id is derived from the name unless one is supplied, because Mike should
 * not have to invent identifiers. It is checked for collision against the
 * roster either way.
 */
export async function createReviewer(
  input: { name: unknown; email: unknown; books: unknown; id?: unknown },
  actor: string,
): Promise<{ roster: RosterDocument; issued: IssuedCode }> {
  requireWritable()

  const name = cleanName(input.name)
  const email = cleanEmail(input.email)
  const books = cleanBooks(input.books)

  const requestedId = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : ''
  const id = requestedId || suggestReviewerId(name)
  if (!id || !isValidReviewerId(id)) {
    throw new AdminRequestError(
      'Could not make an identifier from that name. Give one explicitly: lowercase letters, ' +
        'digits, hyphens and underscores.',
    )
  }

  const store = createRosterStore()
  const doc = await store.load()

  if (doc.reviewers.some((row) => row.id === id)) {
    throw new AdminRequestError(`There is already a reviewer with the identifier "${id}".`)
  }
  if (doc.reviewers.some((row) => row.email && row.email === email)) {
    throw new AdminRequestError(`There is already a reviewer with the address ${email}.`)
  }

  const code = generateAccessCode()
  const codeHash = await fingerprintAccessCode(code)
  if (!codeHash) {
    throw new AdminRequestError(
      'REVIEWER_AUTH_SECRET is not configured, so a code cannot be issued.',
      503,
    )
  }
  // Astronomically unlikely, and refused rather than allowed to create the one
  // state the gate treats as an ambiguous roster.
  if (doc.reviewers.some((row) => row.codeHash === codeHash)) {
    throw new AdminRequestError('Could not issue a unique code. Try again.', 500)
  }

  const now = new Date().toISOString()
  const reviewer: RosterReviewer = {
    id,
    name,
    email,
    books,
    status: 'active',
    codeHash,
    createdAt: now,
    codeUpdatedAt: now,
    lastAccessAt: null,
  }

  const roster = await commit(
    doc,
    [...doc.reviewers, reviewer],
    newAuditEvent(
      actor,
      'reviewer.created',
      id,
      `Added ${name} <${email}> with ${books.length === 0 ? 'no books' : books.join(', ')}.`,
    ),
  )

  return { roster, issued: { reviewerId: id, name, code } }
}

/**
 * Issue a new code for an existing reviewer, replacing the old one.
 *
 * This is also how a lost code is handled, and it is the only way: the previous
 * code cannot be recovered, so it is replaced. Replacing it changes the stored
 * fingerprint, which changes that reviewer's token binding, which invalidates
 * every session they currently have open -- on every device -- from their next
 * request. No other reviewer is affected.
 */
export async function replaceReviewerCode(
  reviewerId: unknown,
  actor: string,
): Promise<{ roster: RosterDocument; issued: IssuedCode }> {
  requireWritable()

  const id = typeof reviewerId === 'string' ? reviewerId.trim() : ''
  if (!isValidReviewerId(id)) throw new AdminRequestError('That is not a valid reviewer.')

  const store = createRosterStore()
  const doc = await store.load()
  const reviewer = findOrThrow(doc, id)

  const code = generateAccessCode()
  const codeHash = await fingerprintAccessCode(code)
  if (!codeHash) {
    throw new AdminRequestError(
      'REVIEWER_AUTH_SECRET is not configured, so a code cannot be issued.',
      503,
    )
  }
  if (doc.reviewers.some((row) => row.id !== id && row.codeHash === codeHash)) {
    throw new AdminRequestError('Could not issue a unique code. Try again.', 500)
  }

  const now = new Date().toISOString()
  const roster = await commit(
    doc,
    doc.reviewers.map((row) =>
      row.id === id ? { ...row, codeHash, codeUpdatedAt: now } : row,
    ),
    newAuditEvent(
      actor,
      'reviewer.code-replaced',
      id,
      `Issued a new code for ${reviewer.name}. Any existing sessions were ended.`,
    ),
  )

  return { roster, issued: { reviewerId: id, name: reviewer.name, code } }
}

/**
 * Change what a reviewer may read.
 *
 * Takes effect on their next request, because entitlements are read from the
 * roster on every authorization rather than carried in the cookie. Removing a
 * book closes it mid-session; adding one opens it without them signing in
 * again.
 */
export async function setReviewerEntitlements(
  reviewerId: unknown,
  books: unknown,
  actor: string,
): Promise<RosterDocument> {
  requireWritable()

  const id = typeof reviewerId === 'string' ? reviewerId.trim() : ''
  if (!isValidReviewerId(id)) throw new AdminRequestError('That is not a valid reviewer.')
  const next = cleanBooks(books)

  const store = createRosterStore()
  const doc = await store.load()
  const reviewer = findOrThrow(doc, id)

  return commit(
    doc,
    doc.reviewers.map((row) => (row.id === id ? { ...row, books: next } : row)),
    newAuditEvent(
      actor,
      'reviewer.entitlements-changed',
      id,
      `${reviewer.name} now has ${next.length === 0 ? 'no books' : next.join(', ')}.`,
    ),
  )
}

export async function renameReviewer(
  reviewerId: unknown,
  name: unknown,
  actor: string,
): Promise<RosterDocument> {
  requireWritable()

  const id = typeof reviewerId === 'string' ? reviewerId.trim() : ''
  if (!isValidReviewerId(id)) throw new AdminRequestError('That is not a valid reviewer.')
  const next = cleanName(name)

  const store = createRosterStore()
  const doc = await store.load()
  const reviewer = findOrThrow(doc, id)

  return commit(
    doc,
    doc.reviewers.map((row) => (row.id === id ? { ...row, name: next } : row)),
    newAuditEvent(actor, 'reviewer.renamed', id, `Renamed ${reviewer.name} to ${next}.`),
  )
}

/**
 * Revoke a reviewer, immediately.
 *
 * The entry stays on the roster, marked `revoked`, rather than being deleted:
 * their feedback is still attributed to a name, the audit history still refers
 * to somebody, and a deletion would quietly free their identifier for reuse.
 * What changes is that every authorization check now treats them as absent, so
 * their open sessions stop working on their next request and their code stops
 * being recognised at the gate.
 */
export async function revokeReviewer(
  reviewerId: unknown,
  actor: string,
): Promise<RosterDocument> {
  requireWritable()

  const id = typeof reviewerId === 'string' ? reviewerId.trim() : ''
  if (!isValidReviewerId(id)) throw new AdminRequestError('That is not a valid reviewer.')

  const store = createRosterStore()
  const doc = await store.load()
  const reviewer = findOrThrow(doc, id)

  return commit(
    doc,
    doc.reviewers.map((row) => (row.id === id ? { ...row, status: 'revoked' as const } : row)),
    newAuditEvent(
      actor,
      'reviewer.revoked',
      id,
      `Revoked ${reviewer.name}. Their sessions and their code stopped working.`,
    ),
  )
}

/**
 * Restore a revoked reviewer.
 *
 * Their previous code works again, because the fingerprint was never removed.
 * That is stated plainly in the dashboard next to the action: restoring is
 * undoing a revocation, not issuing a new grant. If the reason for revoking was
 * that the code may have reached somebody else, the right action is Restore
 * followed by New code -- or simply New code, which both reactivates nothing
 * and replaces everything.
 */
export async function restoreReviewer(
  reviewerId: unknown,
  actor: string,
): Promise<RosterDocument> {
  requireWritable()

  const id = typeof reviewerId === 'string' ? reviewerId.trim() : ''
  if (!isValidReviewerId(id)) throw new AdminRequestError('That is not a valid reviewer.')

  const store = createRosterStore()
  const doc = await store.load()
  const reviewer = findOrThrow(doc, id)

  return commit(
    doc,
    doc.reviewers.map((row) => (row.id === id ? { ...row, status: 'active' as const } : row)),
    newAuditEvent(
      actor,
      'reviewer.restored',
      id,
      `Restored ${reviewer.name}. Their previous code works again.`,
    ),
  )
}
