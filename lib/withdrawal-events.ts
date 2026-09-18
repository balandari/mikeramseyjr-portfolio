/**
 * Withdrawal events: the one author-visible remnant of a retracted note.
 *
 * ## What this is for, and the promise it must not break
 *
 * `docs/author-reader.md` has always promised that retraction leaves **no
 * hidden copy of a note's body**: the object is removed, not tombstoned, and
 * not copied anywhere first. That promise is about the body, and it is kept
 * here exactly as it was kept before -- nothing in this module ever receives,
 * stores, or is able to reconstruct what a note said.
 *
 * What it adds is the other half of the same honesty. Mike read something a
 * reviewer shared with him; if it simply vanishes from his inbox he has no way
 * to tell "they took it back" from "I imagined it" or "the store lost it". So a
 * note that was **shared at the moment its conditional deletion succeeded**
 * leaves one bodyless event saying that a note was withdrawn, which one, and
 * when.
 *
 * A **private** note leaves nothing. No event, no count, no placeholder, no
 * metadata trace and no error detail: a note Mike was never allowed to see
 * cannot produce a record telling him it existed, because that record would
 * itself be a disclosure of private material -- the smallest possible one, and
 * still one.
 *
 * ## What an event may carry, exhaustively
 *
 *   the note's stable id        already known to Mike; it is what his own
 *                               triage metadata and his exports index by
 *   the book                    already known to Mike
 *   the chapter, when the       where he was already told the note was
 *   scope had one
 *   the scope                   how much of the book it was about
 *   the revision that was       which version stopped existing
 *   deleted
 *   the time it happened
 *
 * And nothing else. In particular: no body, no quotation, no paragraph text, no
 * paragraph identifier, no offsets, no anchor payload, no reviewer id, no email,
 * no storage path, no reading position. `asWithdrawalEvent` below builds its
 * result field by field from a fixed list rather than spreading what it was
 * given, so a future caller cannot widen this record by handing it a bigger
 * object, and `tests/withdrawal-events.test.ts` scans the stored bytes for every
 * one of those exclusions.
 *
 * The reviewer's identity is deliberately **not** on the event. Mike can see
 * who wrote a note while the note exists; once it is withdrawn, what he is
 * entitled to know is that it was, not who is having second thoughts.
 *
 * ## The layout
 *
 *   withdrawals/v1/<bookSlug>/<noteId>.json
 *
 * Per book, versioned, keyed by note id -- the same shape and the same store as
 * `notes/v1/...`, selected by the same `REVIEWER_FEEDBACK_DRIVER`. One object
 * per event, so the prefix enumerates a book's withdrawals without consulting
 * the roster, exactly as the note prefix does and for the same reason: a
 * reviewer leaving must not rewrite what Mike was already told.
 *
 * ## Write-once
 *
 * An event is created with `putIfMatch(path, body, null)` -- "nothing must be
 * there" -- so it is never overwritten and never re-dated. A note id is a UUID
 * and is never reused, so a second event at the same pathname is not a
 * legitimate state; it answers `already-recorded` rather than replacing what is
 * stored.
 */

import type { NoteScope } from './note-contract.ts'
import { createReadingObjects, type ReadingObjects } from './reviewer-reading.ts'

if (typeof window !== 'undefined') {
  throw new Error(
    'lib/withdrawal-events is server-only and must not be imported by a client component',
  )
}

/** Layout version. A later layout is a new prefix, never a reinterpretation. */
export const WITHDRAWALS_PREFIX_VERSION = 'v1'

/** Root of every object this store writes. */
export const WITHDRAWALS_ROOT = `withdrawals/${WITHDRAWALS_PREFIX_VERSION}`

const BOOK_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const RECORD_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const CHAPTER_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * One withdrawal, as stored. Every field on it is listed in the module comment,
 * and there is no field on it that is not.
 */
export type WithdrawalEvent = {
  schema: 1
  /** The withdrawn note's stable id. The same id Mike's metadata indexes by. */
  noteId: string
  bookSlug: string
  scope: NoteScope
  /** The chapter, when the scope had one. Null for a book note. */
  chapterSlug: string | null
  /** The revision that stopped existing. */
  revision: number
  /** ISO 8601, UTC. When the deletion succeeded. */
  withdrawnAt: string
}

/** What one attempt at recording an event came to. */
export type WithdrawalWriteOutcome = 'recorded' | 'already-recorded'

/**
 * A book's withdrawal events, **with whether the answer is complete**.
 *
 * The two are returned together rather than the events alone because the whole
 * point of this record is that an absence can be a fact. A listed event whose
 * object could not be read, or whose bytes are not an event, makes this answer
 * incomplete -- it is never flattened into "there were no withdrawals", which
 * would be the same lie in the opposite direction from the one this module
 * exists to prevent.
 */
export type WithdrawalListing = {
  events: WithdrawalEvent[]
  /** True when at least one listed object could not be read or parsed. */
  incomplete: boolean
}

/* --------------------------------------------------------------- the paths */

function assertBookSlug(bookSlug: string): void {
  if (!BOOK_SLUG_PATTERN.test(bookSlug)) {
    throw new Error('invalid book slug for withdrawal storage')
  }
}

/** Every withdrawal on one book. The trailing slash matters, as ever. */
export function bookWithdrawalsPrefix(bookSlug: string): string {
  assertBookSlug(bookSlug)
  return `${WITHDRAWALS_ROOT}/${bookSlug}/`
}

export function withdrawalPath(bookSlug: string, noteId: string): string {
  if (!RECORD_ID_PATTERN.test(noteId)) {
    throw new Error('invalid note id for withdrawal storage')
  }
  return `${bookWithdrawalsPrefix(bookSlug)}${noteId}.json`
}

/* -------------------------------------------------------------- validation */

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function isScope(value: unknown): value is NoteScope {
  return value === 'passage' || value === 'paragraph' || value === 'chapter' || value === 'book'
}

/**
 * Accept a stored object only if it really is an event of this schema.
 *
 * Nothing is normalised into existence here, unlike a note -- a note carries
 * somebody's words and losing it over a bookkeeping field would be the worse
 * trade, while an event carries no words at all and a damaged one is simply not
 * evidence of anything. It is refused, and the refusal makes the listing
 * incomplete rather than quietly shortening it.
 *
 * The returned object is assembled field by field from this fixed list. A
 * caller cannot widen a stored event by handing this function a larger object:
 * whatever else is on the input is read by nothing and copied nowhere.
 */
export function asWithdrawalEvent(value: unknown): WithdrawalEvent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>

  if (row.schema !== 1) return null
  if (typeof row.noteId !== 'string' || !RECORD_ID_PATTERN.test(row.noteId)) return null
  if (typeof row.bookSlug !== 'string' || !BOOK_SLUG_PATTERN.test(row.bookSlug)) return null
  if (!isScope(row.scope)) return null
  if (typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision)) return null
  if (row.revision < 1) return null
  if (typeof row.withdrawnAt !== 'string' || Number.isNaN(Date.parse(row.withdrawnAt))) {
    return null
  }

  let chapterSlug: string | null = null
  if (row.scope === 'book') {
    // A book note anchors to nothing, so a chapter on its event would be an
    // invention. Refused rather than dropped, because something wrote it.
    if (row.chapterSlug !== null && row.chapterSlug !== undefined) return null
  } else {
    if (typeof row.chapterSlug !== 'string' || !CHAPTER_SLUG_PATTERN.test(row.chapterSlug)) {
      return null
    }
    chapterSlug = row.chapterSlug
  }

  return {
    schema: 1,
    noteId: row.noteId,
    bookSlug: row.bookSlug,
    scope: row.scope,
    chapterSlug,
    revision: row.revision,
    withdrawnAt: row.withdrawnAt,
  }
}

/** The bytes one event is stored as. One function, so the shape cannot drift. */
export function serializeWithdrawalEvent(event: WithdrawalEvent): string {
  return `${JSON.stringify(event, null, 2)}\n`
}

/* --------------------------------------------------------------- the store */

export class WithdrawalStore {
  readonly objects: ReadingObjects

  constructor(objects: ReadingObjects) {
    this.objects = objects
  }

  get driver(): string {
    return this.objects.driver
  }

  /**
   * Write one event, once.
   *
   * `putIfMatch(..., null)` is create-if-absent on every driver, so this can
   * neither overwrite an existing event nor re-date one. A refusal is reported
   * as `already-recorded` rather than as a failure: the caller's deletion did
   * happen, and an event already standing for it is the state it wanted.
   */
  async record(event: WithdrawalEvent): Promise<WithdrawalWriteOutcome> {
    /*
     * Normalised on the way out, not only on the way in.
     *
     * `serializeWithdrawalEvent` is `JSON.stringify` and will happily write
     * whatever object it is handed. TypeScript refuses an extra field on an
     * object *literal* at a call site, but it does not refuse a spread -- and
     * `{ ...note, schema: 1 }` is exactly the shape a future caller would reach
     * for. Passing every event through `asWithdrawalEvent` first means the
     * store cannot write a widened record even if one is handed to it, so the
     * closed field list is enforced where the bytes are produced rather than
     * only where they are read back.
     *
     * A value that is not an event at all throws rather than being written:
     * there is no half-event worth keeping, and a caller that built one has a
     * defect it should hear about.
     */
    const clean = asWithdrawalEvent(event)
    if (!clean) throw new Error('refusing to write a malformed withdrawal event')

    const path = withdrawalPath(clean.bookSlug, clean.noteId)
    const written = await this.objects.putIfMatch(path, serializeWithdrawalEvent(clean), null)
    return written ? 'recorded' : 'already-recorded'
  }

  /** One event by note id, or null when there is none. */
  async get(bookSlug: string, noteId: string): Promise<WithdrawalEvent | null> {
    const raw = await this.objects.get(withdrawalPath(bookSlug, noteId))
    if (raw === null) return null
    const event = asWithdrawalEvent(parseJson(raw))
    if (!event) return null
    if (event.bookSlug !== bookSlug || event.noteId !== noteId) return null
    return event
  }

  /**
   * Every event on one book, oldest first, and whether the answer is complete.
   *
   * Reads are **sequential**, one object at a time. That satisfies the
   * eight-in-flight bound the way a single file satisfies a disk quota, and it
   * is said plainly here rather than being presented as a concurrency result:
   * there is no limiter on this path and no claim about one.
   *
   * An object that the listing named and the store then would not give up does
   * **not** shorten the list quietly. It sets `incomplete`, which every caller
   * above -- the author's source, and through it the export -- turns into a
   * disclosed gap or a refusal rather than into a confident absence.
   */
  async list(bookSlug: string): Promise<WithdrawalListing> {
    const prefix = bookWithdrawalsPrefix(bookSlug)
    const events: WithdrawalEvent[] = []
    let incomplete = false

    for (const path of await this.objects.list(prefix)) {
      // The store was asked for one prefix, but a listing is still input.
      if (!path.startsWith(prefix)) continue

      let raw: string | null
      try {
        raw = await this.objects.get(path)
      } catch {
        incomplete = true
        continue
      }
      if (raw === null) {
        // Listed a moment ago and gone now. Nothing here removes an event, so
        // this is the store disagreeing with itself and is not an absence.
        incomplete = true
        continue
      }

      const event = asWithdrawalEvent(parseJson(raw))
      if (!event || event.bookSlug !== bookSlug) {
        incomplete = true
        continue
      }
      events.push(event)
    }

    events.sort((a, b) => {
      if (a.withdrawnAt !== b.withdrawnAt) return a.withdrawnAt.localeCompare(b.withdrawnAt)
      return a.noteId.localeCompare(b.noteId)
    })

    return { events, incomplete }
  }
}

/* ----------------------------------------------------------------- factory */

let store: WithdrawalStore | null = null

/** The configured withdrawal store for this process. The notes store's driver. */
export function createWithdrawalStore(): WithdrawalStore {
  if (store) return store
  store = new WithdrawalStore(createReadingObjects())
  return store
}

/** Test seam. Resets the memoised store so a test can drive each driver. */
export function __resetWithdrawalStore(): void {
  store = null
}

/** Test seam. Builds a store over an arbitrary object layer. */
export function __withdrawalStoreOver(objects: ReadingObjects): WithdrawalStore {
  return new WithdrawalStore(objects)
}
