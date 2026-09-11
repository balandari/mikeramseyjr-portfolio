/**
 * Reviewer feedback storage: Vercel Blob (private store).
 *
 * This is the production driver. It implements the same two-method
 * `ReviewerFeedbackStore` boundary as the filesystem driver, so no page, no
 * component and no route handler changes when it is selected -- selection is
 * one branch in `createFeedbackStore()`, chosen explicitly with
 * `REVIEWER_FEEDBACK_DRIVER=vercel-blob`.
 *
 * The shape of the store, and why:
 *
 *   One submission, one object. Every comment is written as its own JSON
 *   object. Nothing is appended to, merged into, or rewritten over an existing
 *   object, so a write can never damage an earlier comment and a partial
 *   failure can lose at most the comment being written.
 *
 *   Immutable. Objects are written with `allowOverwrite: false` and
 *   `addRandomSuffix: false`. The pathname is fully determined by the row, so
 *   the store refuses a second write to the same pathname rather than
 *   replacing what is there. A reviewer's recorded opinion of a manuscript is
 *   evidence; evidence is not edited in place.
 *
 *   Versioned. The schema version appears both in the row (`schema: 1`) and in
 *   the pathname (`feedback/v1/...`), so a later schema can be introduced
 *   alongside this one without reinterpreting a single existing object.
 *
 *   Private. The store is created with private access and every object is
 *   written with `access: 'private'`, so an object URL is not a capability:
 *   reading requires the store credential, which exists only on the server.
 *
 *   Prefixed by reviewer, then book. Listing is only ever performed beneath
 *   `feedback/v1/<reviewerId>/<bookSlug>/`, which is derived from the signed
 *   cookie and the verified manuscript -- never from a request body. One
 *   reviewer's listing cannot reach another reviewer's objects, and a listing
 *   for one book cannot reach another book's, because the prefix that would
 *   name them is never constructed.
 *
 * What this module will not do: return a blob URL, a pathname, a token, or any
 * other reviewer's row to its caller. It returns `FeedbackEntry` values and
 * nothing else.
 */

import { randomUUID } from 'node:crypto'

import {
  type FeedbackDraft,
  type FeedbackEntry,
  type ReviewerFeedbackStore,
} from './reviewer-feedback.ts'

if (typeof window !== 'undefined') {
  throw new Error(
    'lib/reviewer-feedback-blob is server-only and must not be imported by a client component',
  )
}

/**
 * The storage layout version. It is part of the pathname, so a future layout
 * is a new prefix rather than a reinterpretation of this one.
 */
export const FEEDBACK_PREFIX_VERSION = 'v1'

/** Root of every object this driver writes. */
export const FEEDBACK_ROOT = `feedback/${FEEDBACK_PREFIX_VERSION}`

/**
 * Identifier shapes accepted into a pathname.
 *
 * The reviewer id comes from the signed cookie and the book slug from the
 * verified manuscript, so both are already constrained by the time they arrive
 * here. They are re-checked anyway, because this module must stand on its own:
 * anything that could introduce a `/` or a `..` into a pathname would move an
 * object out from under the prefix that isolates it.
 */
const REVIEWER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/
const BOOK_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

function assertReviewerId(reviewerId: string): void {
  if (!REVIEWER_ID_PATTERN.test(reviewerId)) {
    throw new Error('invalid reviewer id for feedback storage')
  }
}

function assertBookSlug(bookSlug: string): void {
  if (!BOOK_SLUG_PATTERN.test(bookSlug)) {
    throw new Error('invalid book slug for feedback storage')
  }
}

/**
 * The prefix beneath which one reviewer's feedback on one book lives, and the
 * only prefix this driver ever lists. The trailing slash matters: without it a
 * reviewer id that is a prefix of another id would list the other's objects.
 */
export function feedbackPrefix(reviewerId: string, bookSlug: string): string {
  assertReviewerId(reviewerId)
  assertBookSlug(bookSlug)
  return `${FEEDBACK_ROOT}/${reviewerId}/${bookSlug}/`
}

/**
 * The pathname of one stored comment.
 *
 * The timestamp leads so that a plain lexical listing is also chronological,
 * and the row id follows so that two comments submitted in the same
 * millisecond still occupy two different objects. Colons and dots are replaced
 * because a pathname is not the place to rely on them; the unmodified
 * timestamp remains inside the object.
 */
export function feedbackPathname(entry: FeedbackEntry): string {
  const stamp = entry.createdAt.replace(/[:.]/g, '-')
  return `${feedbackPrefix(entry.reviewerId, entry.bookSlug)}${stamp}-${entry.id}.json`
}

/* ------------------------------------------------------------- the backend */

/**
 * The narrow slice of Vercel Blob this driver uses.
 *
 * Declaring it here does two things: it keeps the SDK's much larger surface
 * (delete, copy, rename, multipart, signed URLs) out of reach of this module,
 * and it lets the driver's behaviour -- isolation, malformed objects,
 * duplicate refusal, outage -- be tested exactly rather than approximately.
 */
export type FeedbackBlobBackend = {
  /** Write one object. Must reject rather than replace when it already exists. */
  putObject(pathname: string, body: string): Promise<void>
  /** Every pathname beneath a prefix, following pagination to the end. */
  listPathnames(prefix: string): Promise<string[]>
  /**
   * One object's bytes, or `null` when the store answered and the object is
   * not there.
   *
   * These are the only two normal outcomes. A storage, network or credential
   * failure must *reject* -- it must never be reported as `null`, because the
   * driver treats `null` as "nothing to show" and a rejection as "do not
   * pretend to know". Collapsing the two would let an outage masquerade as an
   * empty feedback history.
   */
  readObject(pathname: string): Promise<string | null>
}

/**
 * The real backend, over the official `@vercel/blob` SDK.
 *
 * The token is held here and passed explicitly on every call rather than left
 * to ambient environment lookup, so there is exactly one place in this codebase
 * that a store credential is read from and exactly one place it is used.
 */
export function createVercelBlobBackend(token: string): FeedbackBlobBackend {
  return {
    async putObject(pathname, body) {
      const { put } = await import('@vercel/blob')
      await put(pathname, body, {
        token,
        access: 'private',
        contentType: 'application/json; charset=utf-8',
        // Immutability, enforced by the store rather than by convention: a
        // pathname that already exists is refused, not replaced.
        allowOverwrite: false,
        // The pathname is the row's identity. A random suffix would make two
        // writes of the same row into two different objects, which is exactly
        // the duplicate the refusal above exists to prevent.
        addRandomSuffix: false,
      })
    },

    async listPathnames(prefix) {
      const { list } = await import('@vercel/blob')
      const pathnames: string[] = []
      let cursor: string | undefined

      // Follow the cursor to the end. Stopping at the first page would quietly
      // hide a reviewer's older comments once they had written enough of them.
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
        // Read the object, not a cached copy of it. A comment submitted a
        // moment ago must be readable a moment later.
        useCache: false,
      })
      if (!result?.stream) return null
      return await new Response(result.stream).text()
    },
  }
}

/* -------------------------------------------------------------- the driver */

class VercelBlobFeedbackStore implements ReviewerFeedbackStore {
  readonly driver = 'vercel-blob'
  readonly durable = true

  private readonly backend: FeedbackBlobBackend

  constructor(backend: FeedbackBlobBackend) {
    this.backend = backend
  }

  async add(draft: FeedbackDraft): Promise<FeedbackEntry> {
    assertReviewerId(draft.reviewerId)
    assertBookSlug(draft.bookSlug)

    const entry: FeedbackEntry = {
      schema: 1,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...draft,
    }

    // Pretty-printed and newline-terminated so that an exported object is
    // readable as-is by whoever eventually reads these, without a tool.
    await this.backend.putObject(
      feedbackPathname(entry),
      `${JSON.stringify(entry, null, 2)}\n`,
    )

    // The stored row, and only the stored row. No pathname, no URL.
    return entry
  }

  async listForReviewer(reviewerId: string, bookSlug: string): Promise<FeedbackEntry[]> {
    const prefix = feedbackPrefix(reviewerId, bookSlug)
    const pathnames = await this.backend.listPathnames(prefix)

    const entries: FeedbackEntry[] = []

    for (const pathname of pathnames) {
      // The backend was asked for one prefix, but a listing is still input.
      // Anything that came back from outside the requested prefix is not this
      // reviewer's to read, whatever produced it.
      if (!pathname.startsWith(prefix)) continue

      // A read that *throws* is a failure of the store, the network or the
      // credential -- a fact about the storage backend, not about this object.
      // It propagates, deliberately and without exception.
      //
      // Catching it here is what made an outage that began *after* a
      // successful listing indistinguishable from an empty history: every
      // object would fail, every failure would be swallowed, and a reviewer
      // with a year of comments would be shown a blank page that said they had
      // written nothing. That is the one lie this module must never tell, and
      // it is worse than an error, because it looks like an answer.
      const raw = await this.backend.readObject(pathname)

      // A read that *returns* `null` is a different thing entirely: the store
      // answered, and the object is simply not there -- a pathname listed a
      // moment before it vanished, or one nothing ever backed. There is
      // nothing to render and nothing has gone wrong. Skipped.
      if (raw === null) continue

      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        continue
      }

      const entry = asFeedbackEntry(parsed)
      if (!entry) continue

      // Scope on read as well as on write. A row is only returned when it says
      // itself that it belongs to this reviewer and this book -- so a
      // misfiled object is skipped rather than disclosed.
      if (entry.reviewerId !== reviewerId || entry.bookSlug !== bookSlug) continue

      entries.push(entry)
    }

    // Oldest first, with the row id breaking ties, so the order a reviewer sees
    // does not depend on how the store happened to page.
    entries.sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.id.localeCompare(b.id)
        : a.createdAt.localeCompare(b.createdAt),
    )

    return entries
  }
}

/**
 * Accept an object only if it is actually a row of this schema.
 *
 * A stored object that has been truncated, half-written, hand-edited, or left
 * behind by a different schema is skipped rather than passed on with missing
 * fields, because the reader renders these values directly.
 */
function asFeedbackEntry(value: unknown): FeedbackEntry | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>

  if (row.schema !== 1) return null
  if (typeof row.id !== 'string' || row.id === '') return null
  if (typeof row.createdAt !== 'string' || Number.isNaN(Date.parse(row.createdAt))) return null
  if (typeof row.reviewerId !== 'string' || typeof row.bookSlug !== 'string') return null
  if (typeof row.chapterSlug !== 'string') return null
  if (typeof row.chapterNumber !== 'number' || !Number.isFinite(row.chapterNumber)) return null
  if (row.scope !== 'paragraph' && row.scope !== 'chapter') return null
  if (typeof row.paragraphId !== 'string' && row.paragraphId !== null) return null
  if (typeof row.paragraphOrdinal !== 'number' && row.paragraphOrdinal !== null) return null
  if (typeof row.quote !== 'string' && row.quote !== null) return null
  if (typeof row.comment !== 'string' || row.comment === '') return null

  return value as FeedbackEntry
}

/**
 * Build the driver.
 *
 * `backend` exists so the driver's behaviour can be tested against a store
 * that can be made to misbehave on purpose. Production passes no backend and
 * gets the real one.
 */
export function createVercelBlobFeedbackStore(options: {
  token?: string
  backend?: FeedbackBlobBackend
}): ReviewerFeedbackStore {
  const backend =
    options.backend ??
    createVercelBlobBackend(
      (() => {
        const token = (options.token ?? '').trim()
        if (!token) {
          throw new Error(
            'REVIEWER_FEEDBACK_DRIVER=vercel-blob requires BLOB_READ_WRITE_TOKEN',
          )
        }
        return token
      })(),
    )

  return new VercelBlobFeedbackStore(backend)
}
