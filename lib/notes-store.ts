/**
 * Where notes live.
 *
 * One object per note, in the **same** private store as reviewer feedback and
 * reading records, selected by the same `REVIEWER_FEEDBACK_DRIVER` and using
 * the same `BLOB_READ_WRITE_TOKEN`. No new service, package, account or secret:
 * a deployment that can already keep a bookmark can already keep a note.
 *
 * ## The layout, and why the book comes first
 *
 *   notes/v1/<bookSlug>/<ownerKind>/<ownerId>/<noteId>.json
 *
 * Reading records are laid out owner-first, because every question asked of
 * them is "what does *this person* have". A note is asked a second question
 * that the owner-first layout cannot answer: **what has been shared with Mike
 * about this book**. Owner-first, that question can only be answered by walking
 * a list of owners -- which means the roster, which means a reviewer removed
 * from the roster takes their shared notes with them. Notes on an unpublished
 * manuscript are the one thing here that must outlive the reading arrangement
 * that produced them: a reviewer finishing, being revoked, or having a book
 * withdrawn is not a reason for what they told the author to disappear.
 *
 * So the book is the first segment, and `notes/v1/<book>/reviewer/` is a prefix
 * that enumerates every reviewer note on that book without consulting anything
 * about who is currently a reviewer. That prefix is built in exactly one place
 * (`listBookNotes` below), is reachable only from an author session, and every
 * row it returns is still put past the visibility rule before anybody sees it.
 *
 * An owner's own listing is unchanged in character: `notes/v1/<book>/<kind>/<id>/`
 * is one person's prefix, and the prefix that would name somebody else's note is
 * never constructed on any reviewer path.
 *
 * ## What may be rewritten, and what may not
 *
 * A note's **body**, **visibility** and **status** are its author's and change
 * when they say so. Its **anchor**, **owner**, **book**, **scope** and
 * **creation time** are written once. An anchor that could be rewritten would
 * be exactly the silent re-attachment the contract exists to refuse, and a
 * creation time that could be rewritten would make the record unusable as
 * evidence of when something was said.
 */

import { randomUUID } from 'node:crypto'

import type { OwnerKind, OwnerRef } from './reading-access.ts'
import {
  anchorOrder,
  asNoteAnchor,
  asNoteStatus,
  asNoteVisibility,
  INITIAL_NOTE_REVISION,
  isNoteScope,
  MAX_NOTE_BODY_LENGTH,
  readNoteRevision,
  type NoteAnchor,
  type NoteScope,
  type NoteStatus,
  type NoteVisibility,
} from './note-contract.ts'
import { createReadingObjects, type ReadingObjects } from './reviewer-reading.ts'

if (typeof window !== 'undefined') {
  throw new Error(
    'lib/notes-store is server-only and must not be imported by a client component',
  )
}

/** Layout version. A later layout is a new prefix, never a reinterpretation. */
export const NOTES_PREFIX_VERSION = 'v1'

/** Root of every object this store writes. */
export const NOTES_ROOT = `notes/${NOTES_PREFIX_VERSION}`

const OWNER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/
const BOOK_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const RECORD_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/* -------------------------------------------------------------- the record */

/**
 * One note, as stored.
 *
 * `visibility` is on every note including Mike's own, where it is always
 * `private` and is never offered as a choice. Carrying the field rather than
 * omitting it means there is no note anywhere in the store whose readability
 * has to be inferred from its owner kind -- the row says.
 */
export type Note = {
  schema: 1
  id: string
  ownerKind: OwnerKind
  ownerId: string
  bookSlug: string
  scope: NoteScope
  /** What was written. Never empty: a note with no body is not a note. */
  body: string
  visibility: NoteVisibility
  status: NoteStatus
  anchor: NoteAnchor
  /**
   * Which version of this note's editable fields this row holds.
   *
   * 1 when the note is written, and one more on every accepted edit. It is the
   * token every conditional update is checked against, and it is sent to the
   * browser so that a save can say *which* version it was written against --
   * which `updatedAt` cannot, being a clock reading rather than a count.
   */
  revision: number
  /** ISO 8601, UTC. Written once and never rewritten. */
  createdAt: string
  /** ISO 8601, UTC. Moves on every accepted edit. */
  updatedAt: string
}

/** Everything a caller must decide before a note can be written. */
export type NoteDraft = {
  ownerKind: OwnerKind
  ownerId: string
  bookSlug: string
  scope: NoteScope
  body: string
  visibility: NoteVisibility
  status: NoteStatus
  anchor: NoteAnchor
}

/** What an edit may change. Everything else about a note is written once. */
export type NoteChanges = {
  body?: string
  visibility?: NoteVisibility
  status?: NoteStatus
}

/**
 * What one attempt at a conditional update came to.
 *
 * Three answers, never two. `conflict` is its own outcome rather than being
 * folded into `not-found` or into a thrown error, because it is the only one of
 * the three that means "the note is there, and what you were editing is no
 * longer what it says". A caller that cannot tell it from absence will either
 * tell somebody their note vanished or, worse, retry the write.
 */
export type NoteUpdateOutcome =
  | { outcome: 'updated'; note: Note }
  | { outcome: 'not-found' }
  | { outcome: 'conflict' }

/**
 * What one attempt at a conditional removal came to.
 *
 * The same three answers, for the same reason, and one addition: a successful
 * removal hands back **the note it removed**. Not so that it can be kept -- it
 * is already gone from the store by then, and nothing here writes it anywhere
 * -- but because the caller cannot ask afterwards. Whether a withdrawal event
 * is owed at all depends on whether the note was `shared` *at the moment its
 * deletion succeeded*, and that is a fact only this call is in a position to
 * state. Reading the note again after the delete would answer "not there";
 * reading it before and trusting that read would be the very race the
 * conditional removal exists to close.
 *
 * The caller decides what to do with it. `lib/note-service.ts` takes the four
 * bodyless fields a withdrawal event may carry and discards the rest.
 */
export type NoteRemoveOutcome =
  | { outcome: 'removed'; note: Note }
  | { outcome: 'not-found' }
  | { outcome: 'conflict' }

/**
 * Notes read from a prefix, **with whether the answer is complete**.
 *
 * The same pair, for the same reason, that `WithdrawalListing` already returns
 * in `lib/withdrawal-events.ts`: an object the store listed and then would
 * not give up, bytes that are not a note, a row filed under somebody else’s
 * prefix, or a note whose revision is damaged beyond reading is a **gap in
 * what the caller is being shown** -- and a gap is not an absence. Returning
 * the rows alone left every caller above unable to tell "nobody wrote
 * anything more" from "some of it would not read", and the author’s export
 * stamped the second as a complete packet.
 *
 * Nothing here decides what to do about it. The author's source turns it into
 * a disclosed gap and a refused export; a reviewer’s own surfaces raise it
 * rather than render it as an empty list. See `lib/author-feedback-source.ts`
 * and `lib/note-service.ts`.
 */
export type NoteListing = {
  notes: Note[]
  /** True when at least one listed object could not be read as a note. */
  incomplete: boolean
}

/* --------------------------------------------------------------- the paths */

function assertOwner(owner: OwnerRef): void {
  if (owner.kind !== 'reviewer' && owner.kind !== 'author') {
    throw new Error('invalid owner kind for note storage')
  }
  if (!OWNER_ID_PATTERN.test(owner.id)) {
    throw new Error('invalid owner id for note storage')
  }
}

function assertBookSlug(bookSlug: string): void {
  if (!BOOK_SLUG_PATTERN.test(bookSlug)) {
    throw new Error('invalid book slug for note storage')
  }
}

function assertRecordId(id: string): void {
  if (!RECORD_ID_PATTERN.test(id)) {
    throw new Error('invalid note id for note storage')
  }
}

/**
 * Every note of one kind of owner on one book.
 *
 * The trailing slash matters, as it does everywhere else here: without it a
 * prefix would reach a sibling whose name merely begins with the same letters.
 */
export function bookNotesPrefix(bookSlug: string, ownerKind: OwnerKind): string {
  assertBookSlug(bookSlug)
  if (ownerKind !== 'reviewer' && ownerKind !== 'author') {
    throw new Error('invalid owner kind for note storage')
  }
  return `${NOTES_ROOT}/${bookSlug}/${ownerKind}/`
}

/** One person's notes on one book. */
export function ownerNotesPrefix(owner: OwnerRef, bookSlug: string): string {
  assertOwner(owner)
  return `${bookNotesPrefix(bookSlug, owner.kind)}${owner.id}/`
}

export function notePath(owner: OwnerRef, bookSlug: string, id: string): string {
  assertRecordId(id)
  return `${ownerNotesPrefix(owner, bookSlug)}${id}.json`
}

/** A fresh note id, lower-cased so it satisfies the storage path pattern. */
export function mintNoteId(): string {
  return randomUUID().toLowerCase()
}

/* -------------------------------------------------------------- validation */

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function isOwnerKind(value: unknown): value is OwnerKind {
  return value === 'reviewer' || value === 'author'
}

/**
 * What one stored object turned out to be.
 *
 * Three answers, not two, because `corrupt-revision` is neither "a note" nor
 * "not a note". The bytes **are** this owner’s note -- id, owner, book, scope,
 * anchor and body all check out -- but the field the conditional write is
 * checked against says nothing usable. A caller that cannot tell that apart
 * from absence will answer `not-found` and tell somebody their note vanished;
 * a caller that flattens it into a note will compare a browser’s expected
 * revision against a number nothing on disk supports. Both were real: see
 * `readNoteRevision` for the stale re-share that followed from the second.
 */
export type NoteRowReading =
  | { ok: true; note: Note }
  | { ok: false; reason: 'not-a-note' | 'corrupt-revision' }

const NOT_A_NOTE: NoteRowReading = { ok: false, reason: 'not-a-note' }

/**
 * Accept a stored object only if it really is a note of this schema.
 *
 * Two fields are normalised rather than rejected, and each normalises in the
 * safe direction: an unrecognised `visibility` becomes `private` and an
 * unrecognised `status` becomes `open`. A note whose sharing field was
 * damaged must not be dropped -- losing what somebody wrote is worse than
 * showing it to nobody -- but it must never be *widened* by the damage.
 *
 * `revision` is **not** in that company, and used to be. It is not a field
 * that describes the note; it is the token every conditional update and delete
 * is checked against, and normalising a damaged one into 1 does not fail
 * safely in either direction -- it manufactures a version claim the row does
 * not make. A row whose revision is present and unusable is therefore
 * `corrupt-revision`: still recognisably this note, and not mutable until
 * somebody who can see the bytes repairs it. A row with no revision key at all
 * is a note from before the field existed, which is revision 1 and entirely
 * sound.
 *
 * Everything else that is wrong makes the object not a note, and it is skipped.
 */
export function asNoteRow(value: unknown): NoteRowReading {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return NOT_A_NOTE
  const row = value as Record<string, unknown>

  if (row.schema !== 1) return NOT_A_NOTE
  if (typeof row.id !== 'string' || !RECORD_ID_PATTERN.test(row.id)) return NOT_A_NOTE
  if (!isOwnerKind(row.ownerKind)) return NOT_A_NOTE
  if (typeof row.ownerId !== 'string' || !OWNER_ID_PATTERN.test(row.ownerId)) return NOT_A_NOTE
  if (typeof row.bookSlug !== 'string' || !BOOK_SLUG_PATTERN.test(row.bookSlug)) {
    return NOT_A_NOTE
  }
  if (!isNoteScope(row.scope)) return NOT_A_NOTE
  if (typeof row.body !== 'string' || row.body === '') return NOT_A_NOTE
  if (row.body.length > MAX_NOTE_BODY_LENGTH) return NOT_A_NOTE
  if (typeof row.createdAt !== 'string' || Number.isNaN(Date.parse(row.createdAt))) {
    return NOT_A_NOTE
  }
  if (typeof row.updatedAt !== 'string' || Number.isNaN(Date.parse(row.updatedAt))) {
    return NOT_A_NOTE
  }

  const anchor = asNoteAnchor(row.anchor)
  if (!anchor) return NOT_A_NOTE
  // The scope on the row and the scope on the anchor are two statements about
  // the same thing; a row where they disagree is not a note this can render.
  if (anchor.scope !== row.scope) return NOT_A_NOTE

  // Read last, so that "this is not a note at all" is never reported as a
  // damaged revision on something that was never a note to begin with.
  const revision = readNoteRevision(row.revision)
  if (revision.state === 'corrupt') return { ok: false, reason: 'corrupt-revision' }

  return {
    ok: true,
    note: {
      schema: 1,
      id: row.id,
      ownerKind: row.ownerKind,
      ownerId: row.ownerId,
      bookSlug: row.bookSlug,
      scope: row.scope,
      body: row.body,
      // Fails private, whatever was on disk. An author note is private by
      // definition and cannot be widened by editing its row either.
      visibility: row.ownerKind === 'author' ? 'private' : asNoteVisibility(row.visibility),
      status: asNoteStatus(row.status),
      anchor,
      // Absent on every note written before revisions existed, which is a note
      // that has been edited zero times. See `readNoteRevision`.
      revision: revision.revision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
  }
}

/**
 * The note, when the object is a sound one.
 *
 * Kept for the callers that have nothing to do with a damaged revision beyond
 * declining to use the row. Anything that must tell `corrupt-revision` apart
 * from `not-a-note` -- which is every mutation, and every listing that owes
 * its caller a completeness answer -- calls `asNoteRow` directly.
 */
export function asNote(value: unknown): Note | null {
  const reading = asNoteRow(value)
  return reading.ok ? reading.note : null
}

/* ----------------------------------------------------------------- the store */

/**
 * Every operation on notes.
 *
 * Each one takes the owner explicitly and builds its path from that owner's
 * prefix -- except `listBookNotes`, which is the one deliberate exception and
 * says so in its own comment.
 */
export class NoteStore {
  readonly objects: ReadingObjects

  constructor(objects: ReadingObjects) {
    this.objects = objects
  }

  get driver(): string {
    return this.objects.driver
  }

  get durable(): boolean {
    return this.objects.durable
  }

  /** One person's notes on one book, from their own prefix and nowhere else. */
  async listNotes(owner: OwnerRef, bookSlug: string): Promise<NoteListing> {
    const prefix = ownerNotesPrefix(owner, bookSlug)
    return this.readUnder(prefix, (note) => {
      if (note.ownerKind !== owner.kind || note.ownerId !== owner.id) return false
      return note.bookSlug === bookSlug
    })
  }

  /**
   * Every note one kind of owner has on one book, across owners.
   *
   * The only listing here that spans people, and the reason it exists is in the
   * module comment: what a reviewer shared with Mike must not vanish when their
   * roster entry does. It returns rows and decides nothing -- the caller
   * (`lib/note-service.ts`) puts every row past the visibility rule as the
   * author before a single one is rendered, counted or exported.
   */
  async listBookNotes(bookSlug: string, ownerKind: OwnerKind): Promise<NoteListing> {
    const prefix = bookNotesPrefix(bookSlug, ownerKind)
    return this.readUnder(prefix, (note) => {
      if (note.ownerKind !== ownerKind) return false
      return note.bookSlug === bookSlug
    })
  }

  /**
   * One note by id, or null.
   *
   * Null covers three different things on purpose -- there is no object, the
   * bytes are not a note, or the row’s revision is damaged -- because a
   * reader has the same thing to do about all three: not render it. The two
   * **mutations** below must tell them apart, and do.
   */
  async getNote(owner: OwnerRef, bookSlug: string, id: string): Promise<Note | null> {
    const raw = await this.objects.get(notePath(owner, bookSlug, id))
    if (raw === null) return null
    const note = asNote(parseJson(raw))
    if (!note) return null
    // Scope on read as well as on write: a misfiled object is skipped rather
    // than disclosed, whatever put it there.
    if (note.ownerKind !== owner.kind || note.ownerId !== owner.id) return null
    if (note.bookSlug !== bookSlug || note.id !== id) return null
    return note
  }

  async addNote(draft: NoteDraft): Promise<Note> {
    const now = new Date().toISOString()
    const note: Note = {
      schema: 1,
      id: mintNoteId(),
      ownerKind: draft.ownerKind,
      ownerId: draft.ownerId,
      bookSlug: draft.bookSlug,
      scope: draft.scope,
      body: draft.body,
      visibility: draft.ownerKind === 'author' ? 'private' : draft.visibility,
      status: draft.status,
      anchor: draft.anchor,
      revision: INITIAL_NOTE_REVISION,
      createdAt: now,
      updatedAt: now,
    }
    await this.write(note)
    return note
  }

  /**
   * Change a note's body, sharing or status -- conditionally, once, or not at all.
   *
   * ## Why this is not a read-modify-write
   *
   * It used to be. A note was read through `getNote`, a successor was built
   * from what was read, and `objects.put` replaced the object unconditionally.
   * Two requests in flight at once therefore landed in whatever order the
   * network delivered them, and each was told it had succeeded. Three
   * interleavings followed from that, all of them proved against this very
   * class: a **retracted** note came back -- still shared -- because an edit
   * already in flight rewrote the object after the delete; a note **narrowed
   * to "Only me"** was returned to `shared` by an in-flight body edit carrying
   * the stale record; and two concurrent edits **silently discarded** one of
   * them. The first two fail in the widening direction, which is the one
   * direction this whole contract exists to make impossible.
   *
   * ## The two checks, and why both
   *
   *   **The note's own `revision`** is the application's token, and it is the
   *   one the *browser* can hold. The caller says which revision it rendered;
   *   if the stored note has moved on, the edit was composed against words
   *   that are no longer there and is refused. This is what makes "you are
   *   editing a stale copy" answerable to a person.
   *
   *   **The storage version** is the driver's token -- a content digest on the
   *   filesystem, an ETag on the blob store -- and it closes the window
   *   between *this* call's read and *this* call's write, which no revision
   *   carried in from a browser can see. `putIfMatch` is the primitive the
   *   object layer already exposes for exactly this, and which
   *   `lib/reviewer-reading.ts` already uses for reading positions.
   *
   * Either check failing is a `conflict`, and a conflict writes **nothing**.
   *
   * ## Why there is no retry loop
   *
   * `savePosition` retries, because a position is a fact about where somebody
   * is and re-deciding it against newer state gives the same answer. A note is
   * somebody's words. Re-deciding an edit against a body that has changed
   * underneath it would apply text composed against a paragraph the writer can
   * no longer see, and a visibility chosen for a note that now says something
   * else. The only correct answer is to refuse, say so, and let the person who
   * wrote it look at what is actually there.
   *
   * `createdAt` is carried through untouched and `updatedAt` moves, which is
   * what makes "written then, revised since" answerable later -- Package 2's
   * changed-since-read and changed-since-export signals are read off exactly
   * these two fields, so this package writes them correctly and builds nothing
   * on top of them.
   */
  async updateNote(
    owner: OwnerRef,
    bookSlug: string,
    id: string,
    changes: NoteChanges,
    expectedRevision: number,
  ): Promise<NoteUpdateOutcome> {
    const path = notePath(owner, bookSlug, id)
    const current = await this.objects.getVersioned(path)
    if (current.body === null) return { outcome: 'not-found' }

    const reading = asNoteRow(parseJson(current.body))
    /*
     * A damaged revision refuses the write, and refuses it as a **conflict**.
     *
     * Not `not-found`: the object is there, and answering absence would tell
     * somebody their note had vanished and invite them to write it again.
     * Not an accepted edit either, which is what this used to be: the row's
     * revision was normalised to 1 and compared against the browser’s claim,
     * so a note at revision 3 that had been narrowed to `private` matched a
     * stale revision-1 request and re-shared the latest words. Conflict is the
     * truthful answer -- the note is there, and what this caller believes it
     * was editing is not what the row says -- and a conflict writes nothing.
     */
    if (!reading.ok && reading.reason === 'corrupt-revision') return { outcome: 'conflict' }
    const existing = reading.ok ? reading.note : null
    if (!existing) return { outcome: 'not-found' }
    // Scope on read, exactly as `getNote` does it: a misfiled object is not
    // this owner's note whatever put it there, and is never rewritten as one.
    if (existing.ownerKind !== owner.kind || existing.ownerId !== owner.id) {
      return { outcome: 'not-found' }
    }
    if (existing.bookSlug !== bookSlug || existing.id !== id) return { outcome: 'not-found' }

    // Checked before anything is built, so a stale edit costs one read and no
    // write at all -- there is no path here that touches the store and then
    // decides it should not have.
    if (existing.revision !== expectedRevision) return { outcome: 'conflict' }

    /*
     * The successor has to be a revision this module can read back.
     *
     * `Number.MAX_SAFE_INTEGER` is a sound stored revision -- `readNoteRevision`
     * accepts it, and a note at that value reads, lists and deletes normally.
     * But its successor is not safe: `+ 1` lands on 2^53, which the next read
     * classifies as `corrupt-revision`, so writing it would turn an accepted
     * edit into a note that can no longer be read. The check is on the value
     * this call would *produce*, before anything is built or written.
     *
     * The answer is `conflict`, deliberately, and not a fourth outcome: the note
     * cannot be advanced from here, the stored row is left exactly as it is, and
     * a conflict already means "this edit was refused and nothing was written".
     * No write, no conditional write, no change to what is stored.
     */
    if (!Number.isSafeInteger(existing.revision + 1)) return { outcome: 'conflict' }

    const next: Note = {
      ...existing,
      body: changes.body === undefined ? existing.body : changes.body,
      visibility:
        existing.ownerKind === 'author'
          ? 'private'
          : changes.visibility === undefined
            ? existing.visibility
            : changes.visibility,
      status: changes.status === undefined ? existing.status : changes.status,
      revision: existing.revision + 1,
      updatedAt: new Date().toISOString(),
    }

    /*
     * `current.version` is never null here -- the body was read -- so this is
     * always "replace exactly what I read". A note deleted in between is
     * therefore not recreated: the precondition names a revision the store no
     * longer holds, and the write is refused rather than minting the object
     * afresh. Deletion stays deletion.
     */
    const written = await this.objects.putIfMatch(path, serializeNote(next), current.version)
    if (!written) return { outcome: 'conflict' }

    return { outcome: 'updated', note: next }
  }

  /**
   * Remove a note -- conditionally, once, or not at all.
   *
   * The object is deleted, not tombstoned and not copied elsewhere first. A
   * retracted note leaves no hidden copy of what it said, which is what lets an
   * author-visible withdrawal event record *that* a shared note was withdrawn
   * without this store having squirrelled the body away where its author cannot
   * reach it.
   *
   * ## Why this is no longer a read-then-delete
   *
   * It used to be: `getNote`, then an unconditional `objects.del`. Package 1
   * documented the limit that left in so many words -- *"a client still holding
   * revision 1 can delete a note that another of that same person's clients has
   * since edited to revision 2, destroying a body it never saw, and be told the
   * delete succeeded"* -- and left closing it to this package. Two windows were
   * open, and they are different windows:
   *
   *   **The browser's.** The reader deleted a note it rendered at some
   *   revision, and said nothing about which. A second client of the same
   *   person -- a phone beside a laptop, or one request retried -- could have
   *   moved the note on in between. `expectedRevision` is that assertion, and
   *   it is compared against the row that is actually stored.
   *
   *   **This call's own.** Between the read above and the delete below, a write
   *   could land. An unconditional `del` cannot see it and removes the newer
   *   object anyway. `delIfMatch` names the exact storage revision that was
   *   read, so a delete that races a write removes nothing and says so.
   *
   * Both checks failing answer `conflict`, and a conflict removes **nothing**.
   * There is no retry here for the same reason `updateNote` has none: re-deciding
   * a deletion against a body that has changed underneath it would destroy words
   * the person who asked has never seen.
   *
   * ## Why a delete cannot resurrect, and a write cannot un-delete
   *
   * The two conditional primitives close the pair together. A **write racing a
   * delete** is `updateNote`'s `putIfMatch` against the version it read: once
   * the object is gone the store holds no such revision, the precondition fails,
   * and nothing is minted afresh. A **delete racing a write** is this method's
   * `delIfMatch`: the stored revision has moved, the precondition fails, and the
   * newer object stays. Neither order loses a note silently and neither reports
   * a removal that did not happen.
   */
  async removeNote(
    owner: OwnerRef,
    bookSlug: string,
    id: string,
    expectedRevision: number,
  ): Promise<NoteRemoveOutcome> {
    const path = notePath(owner, bookSlug, id)
    const current = await this.objects.getVersioned(path)
    if (current.body === null || current.version === null) return { outcome: 'not-found' }

    const reading = asNoteRow(parseJson(current.body))
    /*
     * A damaged revision refuses the delete, for exactly the reason it refuses
     * an update: the normalised 1 matched a stale browser, and that browser
     * could destroy a body it had never rendered. Conflict, and nothing is
     * removed.
     */
    if (!reading.ok && reading.reason === 'corrupt-revision') return { outcome: 'conflict' }
    const existing = reading.ok ? reading.note : null
    if (!existing) return { outcome: 'not-found' }
    // Scope on read, exactly as `getNote` and `updateNote` do it: a misfiled
    // object is not this owner's note whatever put it there, and is never
    // removed as one.
    if (existing.ownerKind !== owner.kind || existing.ownerId !== owner.id) {
      return { outcome: 'not-found' }
    }
    if (existing.bookSlug !== bookSlug || existing.id !== id) return { outcome: 'not-found' }

    // Checked before the store is touched, so a stale delete costs one read and
    // removes nothing at all.
    if (existing.revision !== expectedRevision) return { outcome: 'conflict' }

    const removed = await this.objects.delIfMatch(path, current.version)
    if (!removed) return { outcome: 'conflict' }

    return { outcome: 'removed', note: existing }
  }

  private async write(note: Note): Promise<void> {
    await this.objects.put(
      notePath({ kind: note.ownerKind, id: note.ownerId }, note.bookSlug, note.id),
      serializeNote(note),
    )
  }

  /**
   * Every readable note under a prefix, and whether that is all of them.
   *
   * Each of the four ways a listed object can fail to become a row sets
   * `incomplete` rather than quietly shortening the answer:
   *
   *   - the store listed a path outside the prefix it was asked for;
   *   - the object was listed and then would not read;
   *   - the bytes are not a note, or the revision on them is damaged;
   *   - the row is filed under this prefix but says it belongs elsewhere.
   *
   * None of those is "there was nothing more here". Nothing on this path
   * deletes notes, so a listed-then-absent object is the store disagreeing
   * with itself, exactly as `WithdrawalStore.list` already treats it.
   *
   * **`keep` is a misfiling test, never a policy filter.** Every caller below
   * passes owner/book predicates that any correctly filed row under that
   * prefix satisfies, so a false answer really is an anomaly. Visibility is
   * decided further up, in `lib/note-service.ts`, precisely so that a private
   * note being withheld from the author can never be reported here as a gap.
   */
  private async readUnder(
    prefix: string,
    keep: (note: Note) => boolean,
  ): Promise<NoteListing> {
    const rows: Note[] = []
    let incomplete = false

    for (const path of await this.objects.list(prefix)) {
      // The store was asked for one prefix, but a listing is still input.
      if (!path.startsWith(prefix)) {
        incomplete = true
        continue
      }

      let raw: string | null
      try {
        raw = await this.objects.get(path)
      } catch {
        incomplete = true
        continue
      }
      if (raw === null) {
        incomplete = true
        continue
      }

      const reading = asNoteRow(parseJson(raw))
      if (!reading.ok || !keep(reading.note)) {
        incomplete = true
        continue
      }
      rows.push(reading.note)
    }

    return { notes: sortNotes(rows), incomplete }
  }
}

/**
 * The bytes one note is stored as.
 *
 * One function, so the unconditional first write and the conditional update
 * cannot come to disagree about the shape on disk -- which would make a stored
 * revision unreadable by the very check it exists for.
 */
function serializeNote(note: Note): string {
  return `${JSON.stringify(note, null, 2)}\n`
}

/**
 * Reading order: by chapter, then by paragraph, then by when it was written.
 *
 * Book notes sort first because they are about everything, and a note about
 * everything does not belong wedged between two paragraphs of chapter four.
 */
export function sortNotes<T extends { anchor: NoteAnchor; createdAt: string; id: string }>(
  rows: T[],
): T[] {
  return rows.sort((a, b) => {
    const left = anchorOrder(a.anchor)
    const right = anchorOrder(b.anchor)
    if (left.chapter !== right.chapter) return left.chapter - right.chapter
    if (left.paragraph !== right.paragraph) return left.paragraph - right.paragraph
    if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt)
    return a.id.localeCompare(b.id)
  })
}

/* ----------------------------------------------------------------- factory */

let store: NoteStore | null = null

/**
 * The configured note store for this process.
 *
 * Driver selection is the reading store's, which is the feedback store's. An
 * unconfigured host gets the refusing driver and a note that was not stored is
 * never reported as stored.
 */
export function createNoteStore(): NoteStore {
  if (store) return store
  store = new NoteStore(createReadingObjects())
  return store
}

/** Test seam. Resets the memoised store so a test can drive each driver. */
export function __resetNoteStore(): void {
  store = null
}

/** Test seam. Builds a store over an arbitrary object layer. */
export function __noteStoreOver(objects: ReadingObjects): NoteStore {
  return new NoteStore(objects)
}
