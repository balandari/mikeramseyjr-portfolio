/**
 * Reviewer feedback storage.
 *
 * This is the third of the feature's three separated concerns, and the only one
 * that writes anything at runtime. It imports neither the manuscript module nor
 * the access module: a feedback row references a reviewer and a passage by
 * identifier, and knows nothing else about either.
 *
 * The storage boundary is deliberately one small interface with two methods, so
 * that attaching a real database later is a new file implementing
 * `ReviewerFeedbackStore` and one line in `createFeedbackStore` -- not a change
 * to any page, any route handler, or any component.
 *
 * There are three drivers:
 *
 *   `vercel-blob` The production driver. Writes each submission as its own
 *                 immutable, versioned, private JSON object in a Vercel Blob
 *                 store, and lists only beneath the authenticated reviewer's
 *                 own book prefix. Durable on a serverless host. See
 *                 `lib/reviewer-feedback-blob.ts`.
 *
 *   `fs`          Appends newline-delimited JSON to a directory on disk. Durable
 *                 wherever the filesystem is durable: local development, a
 *                 self-hosted server, or any host with a persistent volume. It
 *                 is NOT durable on a serverless host, whose filesystem is
 *                 ephemeral and per-invocation. Retained as the test driver.
 *
 *   unconfigured  The default. Every write is refused with
 *                 `FeedbackStorageUnavailableError`, which the route handler
 *                 turns into a 503 and the reader shows as an explicit "not
 *                 configured" message.
 *
 * The unconfigured driver exists because refusing a comment loudly is honest and
 * losing one silently is not. Feedback is never written to the browser as a
 * substitute for server-side storage, never accepted and dropped, and never
 * reported as saved unless a store actually returned a stored row.
 */

import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// Type-only in the other direction, so this pairing is not a runtime cycle:
// the blob driver imports nothing from here but the shape it implements.
import { createVercelBlobFeedbackStore } from './reviewer-feedback-blob.ts'
// The one row validator, shared with the Blob driver.
import { asFeedbackEntry } from './feedback-entry.ts'

if (typeof window !== 'undefined') {
  throw new Error(
    'lib/reviewer-feedback is server-only and must not be imported by a client component',
  )
}

/** Longest comment a reviewer may submit, in characters. */
export const MAX_COMMENT_LENGTH = 4000

/** Whether a comment is about one passage or about the chapter as a whole. */
export type FeedbackScope = 'paragraph' | 'chapter'

/**
 * One reviewer comment, as submitted.
 *
 * Everything that identifies *what* the comment is about is resolved on the
 * server before a draft is built: the reviewer comes from the signed cookie,
 * and the book, chapter and quoted passage come from the verified manuscript.
 * Nothing the browser sends is trusted as attribution.
 */
export type FeedbackDraft = {
  reviewerId: string
  bookSlug: string
  chapterSlug: string
  chapterNumber: number
  scope: FeedbackScope
  /** Set for paragraph-scoped feedback, null for chapter-scoped. */
  paragraphId: string | null
  paragraphOrdinal: number | null
  /** The passage itself, copied from the manuscript server-side. */
  quote: string | null
  comment: string
}

export type FeedbackEntry = FeedbackDraft & {
  /** Row schema version. Present on every row so a later migration can branch on it. */
  schema: 1
  id: string
  /** ISO 8601, UTC. */
  createdAt: string
}

/**
 * Rows read for one reviewer and one book, **with whether that is all of them**.
 *
 * A stored comment is immutable and nothing here deletes one, so a row that
 * was enumerated and then would not read, or that will not parse, is the
 * store disagreeing with itself. Returning the survivors alone made that
 * indistinguishable from a reviewer who had submitted fewer comments, and the
 * author's export stamped the shortened result as a complete packet.
 *
 * The shape is deliberately the one `WithdrawalListing` already uses.
 */
export type FeedbackListing = {
  entries: FeedbackEntry[]
  /** True when at least one enumerated row could not be read. */
  incomplete: boolean
}

/**
 * The whole storage boundary. Two methods, both scoped by reviewer or by book,
 * so no implementation is ever asked for "everything".
 */
export type ReviewerFeedbackStore = {
  /** Short driver name, for diagnostics. Never includes a credential. */
  readonly driver: string
  /** Whether this driver's writes survive a process restart on this host. */
  readonly durable: boolean
  add(draft: FeedbackDraft): Promise<FeedbackEntry>
  listForReviewer(reviewerId: string, bookSlug: string): Promise<FeedbackListing>
}

/**
 * Raised when no durable store is configured. The route handler answers 503 and
 * the reader tells the reviewer plainly that their comment was not saved.
 */
export class FeedbackStorageUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FeedbackStorageUnavailableError'
  }
}

/* ------------------------------------------------------------ validation */

/**
 * Normalise and bound a submitted comment. Returns null when there is nothing
 * to store, so an empty comment is refused rather than written as a blank row.
 */
export function normalizeComment(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  // Normalise line endings so a row reads the same regardless of the browser
  // that produced it; collapse runs of blank lines; trim the ends.
  const text = raw.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (text.length === 0) return null
  if (text.length > MAX_COMMENT_LENGTH) return null
  return text
}

/* ------------------------------------------------------ unconfigured driver */

class UnconfiguredFeedbackStore implements ReviewerFeedbackStore {
  readonly driver = 'unconfigured'
  readonly durable = false

  async add(): Promise<FeedbackEntry> {
    throw new FeedbackStorageUnavailableError(
      'No reviewer feedback store is configured. Set REVIEWER_FEEDBACK_DRIVER.',
    )
  }

  async listForReviewer(): Promise<FeedbackListing> {
    // Reading nothing is honest: there is no store, so there are no rows, and
    // the answer is complete. Only writing is an error, because only a refused
    // write loses something.
    return { entries: [], incomplete: false }
  }
}

/* --------------------------------------------------------- filesystem driver */

/**
 * Newline-delimited JSON, one file per book.
 *
 * Append-only: a row is written with a single `appendFileSync`, which is atomic
 * for a write of this size, so concurrent submissions interleave as whole lines
 * rather than corrupting each other. Nothing is ever rewritten in place, so a
 * partial failure can lose at most the row being written and never an earlier
 * one.
 */
class FileSystemFeedbackStore implements ReviewerFeedbackStore {
  readonly driver = 'fs'
  readonly durable = true

  private readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  private pathFor(bookSlug: string): string {
    // The slug is pattern-checked by the caller, but this module must stand on
    // its own: reject anything that could escape the storage root.
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(bookSlug)) {
      throw new Error(`invalid book slug for feedback storage: ${bookSlug}`)
    }
    return join(this.root, `${bookSlug}.ndjson`)
  }

  async add(draft: FeedbackDraft): Promise<FeedbackEntry> {
    const entry: FeedbackEntry = {
      schema: 1,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...draft,
    }

    const path = this.pathFor(draft.bookSlug)
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8')

    return entry
  }

  async listForReviewer(reviewerId: string, bookSlug: string): Promise<FeedbackListing> {
    const path = this.pathFor(bookSlug)
    // No file is a genuine absence: nothing has ever been appended for this
    // book. That is a complete answer, and it is the only absence here that is.
    if (!existsSync(path)) return { entries: [], incomplete: false }

    const rows: FeedbackEntry[] = []
    let incomplete = false
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        /*
         * A single unparseable line must not hide every other comment -- and
         * must not be dropped in silence either, which is what this did. The
         * file is append-only and nothing rewrites it, so a line that will not
         * parse is damage, and the caller is told the answer is short.
         */
        incomplete = true
        continue
      }
      /*
       * A line that parses is still only a row if it has a row's shape. The
       * same validator the Blob driver uses decides it: a parseable line with a
       * field missing or mistyped is damage exactly as an unparseable one is,
       * so it is skipped and the answer is marked short. It used to be cast to
       * `FeedbackEntry` and emitted as complete, with whatever fields it had.
       */
      const entry = asFeedbackEntry(parsed)
      if (!entry) {
        incomplete = true
        continue
      }
      /*
       * Scope on read as well as on write, and the two mismatches mean
       * different things here.
       *
       * This file is named for one book. A row in it that names **another
       * book** is misfiled -- nothing that writes this file can put it there --
       * so it is skipped and disclosed, never emitted and never treated as an
       * ordinary non-match.
       *
       * The file holds **every reviewer's** rows for that book, so a correctly
       * filed row belonging to somebody else is not a gap. It is filtered out
       * silently: a caller asking for one reviewer's feedback must never be
       * handed another reviewer's row, and must not be told one exists.
       */
      if (entry.bookSlug !== bookSlug) {
        incomplete = true
        continue
      }
      if (entry.reviewerId === reviewerId) rows.push(entry)
    }

    return { entries: rows, incomplete }
  }
}

/* ----------------------------------------------------------------- factory */

let store: ReviewerFeedbackStore | null = null

/**
 * The configured feedback store for this process.
 *
 * Driver selection is explicit: a host that has not chosen a driver gets the
 * refusing one. There is no "helpful" fallback that appears to work.
 */
export function createFeedbackStore(): ReviewerFeedbackStore {
  if (store) return store

  const driver = (process.env.REVIEWER_FEEDBACK_DRIVER ?? '').trim().toLowerCase()

  if (driver === 'fs') {
    const dir = (process.env.REVIEWER_FEEDBACK_DIR ?? '').trim()
    if (!dir) {
      throw new Error('REVIEWER_FEEDBACK_DRIVER=fs requires REVIEWER_FEEDBACK_DIR')
    }
    store = new FileSystemFeedbackStore(dir)
  } else if (driver === 'vercel-blob') {
    // The credential is required, not optional: a misconfigured production
    // deployment must refuse to start a store rather than quietly become one
    // that accepts nothing. The value is never logged and never leaves this
    // call.
    store = createVercelBlobFeedbackStore({
      token: process.env.BLOB_READ_WRITE_TOKEN,
    })
  } else {
    store = new UnconfiguredFeedbackStore()
  }

  return store
}

/** Test seam. Resets the memoised store so a test can drive each driver. */
export function __resetFeedbackStore(): void {
  store = null
}

/**
 * A short, non-reversible digest of a comment, for operational logging.
 *
 * Feedback is a reviewer's candid opinion of an unpublished manuscript, so its
 * text is never logged. When a write needs to be traced, this is what is
 * written instead: enough to correlate a row with a request, nothing that
 * discloses what the reviewer said.
 */
export function commentDigest(comment: string): string {
  return createHash('sha256').update(comment, 'utf8').digest('hex').slice(0, 12)
}
