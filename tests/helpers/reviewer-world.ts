/**
 * One reviewer, one roster, one object store, and a mailer that never sends —
 * built in memory so an exploration can create a fresh one thousands of times.
 *
 * The two stores here are models, and the modelling is the point: every
 * interleaving proved against them is only meaningful if they behave the way
 * the real drivers behave. Both implement the same five primitives with the
 * same semantics the filesystem driver gives (`tests/scheduled-store.test.ts`
 * asserts that the memory object store and the filesystem one agree, primitive
 * by primitive) and the same semantics `scripts/blob-probe.mjs` checks against
 * the live service: atomic create-if-absent, compare-and-swap on an opaque
 * revision, conditional removal, and read-your-writes.
 *
 * The roster store is gated through the harness as well. That is not a detail:
 * every administrative boundary this suite exists to prove — a revocation, an
 * address change, an invalidation landing between a credential's used marker
 * and the decision that follows it — is a roster read or a roster write, and an
 * interleaving that cannot be scheduled cannot be proved.
 */

import { createHash } from 'node:crypto'

import type { MailMessage, MailResult, Mailer } from '../../lib/mailer.ts'
import {
  RosterConflictError,
  emptyRoster,
  nextUpdatedAt,
  parseRosterDocument,
  serializeRosterDocument,
  type AuditEvent,
  type ReviewerRosterStore,
  type RosterDocument,
  type RosterReviewer,
  type VersionedRoster,
} from '../../lib/reviewer-roster.ts'
import { MemoryPrivateStore, type Gate } from './scheduled-store.ts'

export const SECRET = 'test-secret-for-concurrency-only-not-a-real-one'
export const ORIGIN = 'https://example.test'
export const BOOK = 'the-backward-becoming'
export const ADMIN = 'mike@example.com'

/** The environment every one of these tests needs, set once per file. */
export function withReviewerEnv<T>(run: () => Promise<T>): Promise<T> {
  const keys = [
    'REVIEWER_AUTH_SECRET',
    'SITE_ORIGIN',
    'AUTHOR_ALERT_EMAIL',
    'EMAIL_FROM',
    'REVIEWER_ROSTER_DRIVER',
  ] as const
  const saved: Record<string, string | undefined> = {}
  for (const key of keys) saved[key] = process.env[key]

  process.env.REVIEWER_AUTH_SECRET = SECRET
  process.env.SITE_ORIGIN = ORIGIN
  process.env.AUTHOR_ALERT_EMAIL = ADMIN
  process.env.EMAIL_FROM = 'Test <test@example.test>'
  delete process.env.REVIEWER_ROSTER_DRIVER

  return run().finally(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key] as string
    }
  })
}

/* --------------------------------------------------------- roster in memory */

function digest(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

/**
 * The roster's contract, in a string, with the same conditional write the
 * filesystem and Vercel Blob drivers perform.
 *
 * `save` refuses on either test the real drivers refuse on: a revision that has
 * moved, or an `updatedAt` that is not the one the caller derived from. Audit
 * objects are immutable and created once, as they are everywhere else.
 */
export class MemoryRosterStore implements ReviewerRosterStore {
  readonly driver = 'memory'
  readonly writable = true

  private document: string | null = null
  private readonly auditLines: AuditEvent[] = []

  private read(): VersionedRoster {
    if (this.document === null) return { doc: emptyRoster(), version: null }
    const parsed = parseRosterDocument(this.document)
    if (!parsed) throw new Error('the stored roster document is malformed')
    return { doc: parsed, version: digest(this.document) }
  }

  async load(): Promise<RosterDocument> {
    return this.read().doc
  }

  async loadForUpdate(): Promise<VersionedRoster> {
    return this.read()
  }

  async save(
    next: RosterDocument,
    expectedUpdatedAt: string,
    version?: string | null,
  ): Promise<RosterDocument> {
    // One synchronous section, exactly as the filesystem driver holds one.
    const current = this.read()
    if (version !== undefined && current.version !== version) throw new RosterConflictError()
    if (current.doc.updatedAt !== expectedUpdatedAt) throw new RosterConflictError()

    const written: RosterDocument = {
      ...next,
      schema: 1,
      updatedAt: nextUpdatedAt(current.doc.updatedAt),
    }
    this.document = serializeRosterDocument(written)
    return written
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    this.auditLines.push(event)
  }

  async listAudit(limit: number): Promise<AuditEvent[]> {
    return [...this.auditLines]
      .sort((a, b) => (a.at === b.at ? b.id.localeCompare(a.id) : b.at.localeCompare(a.at)))
      .slice(0, limit)
  }

  /** Test convenience: every audit line ever appended, oldest first. */
  audit(): AuditEvent[] {
    return [...this.auditLines]
  }

  /** Test convenience: put a roster in place without going through a mutation. */
  seed(reviewers: RosterReviewer[]): void {
    this.document = serializeRosterDocument({
      schema: 1,
      updatedAt: new Date(0).toISOString(),
      reviewers,
    })
  }
}

/** The pathname the gate reports for a roster operation. Cosmetic, but legible. */
const ROSTER_PATH = 'roster/v1/roster.json'

/**
 * The same roster store, with every operation passing through the harness's
 * permit so it can be scheduled against the object store's operations.
 */
export function gatedRoster(inner: ReviewerRosterStore, gate: Gate): ReviewerRosterStore {
  return {
    driver: inner.driver,
    writable: inner.writable,
    load: () => gate('read', ROSTER_PATH, () => inner.load()),
    loadForUpdate: () => gate('readVersioned', ROSTER_PATH, () => inner.loadForUpdate()),
    save: (next, expectedUpdatedAt, version) =>
      gate('writeIfMatch', ROSTER_PATH, () => inner.save(next, expectedUpdatedAt, version)),
    appendAudit: (event) =>
      gate('create', `roster/v1/audit/${event.action}`, () => inner.appendAudit(event)),
    listAudit: (limit) => gate('list', 'roster/v1/audit/', () => inner.listAudit(limit)),
  }
}

/* ------------------------------------------------------------------ people */

export function aReviewer(overrides: Partial<RosterReviewer> = {}): RosterReviewer {
  return {
    id: 'anna',
    name: 'Anna',
    email: 'anna@example.com',
    books: [BOOK],
    status: 'active',
    codeHash: 'fingerprint-anna',
    createdAt: '2026-01-01T00:00:00.000Z',
    codeUpdatedAt: '2026-01-01T00:00:00.000Z',
    lastAccessAt: null,
    emailVerifiedAt: null,
    credentialEpoch: 0,
    origin: 'admin',
    requestId: null,
    ...overrides,
  }
}

/* ------------------------------------------------------------------ mailer */

export type Recorder = { sent: MailMessage[]; mailer: Mailer }

export function recordingMailer(
  answer: MailResult | ((message: MailMessage) => MailResult) = {
    status: 'accepted',
    providerId: 'm1',
    error: null,
  },
): Recorder {
  const sent: MailMessage[] = []
  return {
    sent,
    mailer: {
      driver: 'test',
      async send(message) {
        sent.push(message)
        return typeof answer === 'function' ? answer(message) : answer
      },
    },
  }
}

/** Pull the one-time credential out of a message, the way a reader would. */
export function tokenIn(message: MailMessage): string {
  const match = message.text.match(/#(?:a|s)=([A-Za-z0-9_-]{43})/)
  if (!match) throw new Error('the message carries no credential')
  return match[1]
}

/* ------------------------------------------------------------------- world */

export type World = {
  store: MemoryPrivateStore
  roster: MemoryRosterStore
  sent: MailMessage[]
  mailer: Mailer
}

export function freshWorld(
  options: { reviewers?: RosterReviewer[]; answer?: MailResult } = {},
): World {
  const store = new MemoryPrivateStore()
  const roster = new MemoryRosterStore()
  roster.seed(options.reviewers ?? [aReviewer()])
  const recorder = recordingMailer(options.answer)
  return { store, roster, sent: recorder.sent, mailer: recorder.mailer }
}
