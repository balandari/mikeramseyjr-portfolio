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
  asNoteRevision,
  asNoteStatus,
  asNoteVisibility,
  INITIAL_NOTE_REVISION,
  isNoteScope,
  MAX_NOTE_BODY_LENGTH,
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
 * Accept a stored object only if it really is a note of this schema.
 *
 * Three fields are normalised rather than rejected, and each normalises in the
 * safe direction: an unrecognised `visibility` becomes `private`, an
 * unrecognised `status` becomes `open`, and a missing or damaged `revision`
 * becomes 1. A note whose sharing field was damaged must not be dropped --
 * losing what somebody wrote is worse than showing it to nobody -- but it must
 * never be *widened* by the damage, and a damaged revision can only ever refuse
 * an edit, never wave one through. Everything else that is wrong makes the
 * object not a note, and it is skipped.
 */
export function asNote(value: unknown): Note | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>

  if (row.schema !== 1) return null
  if (typeof row.id !== 'string' || !RECORD_ID_PATTERN.test(row.id)) return null
  if (!isOwnerKind(row.ownerKind)) return null
  if (typeof row.ownerId !== 'string' || !OWNER_ID_PATTERN.test(row.ownerId)) return null
  if (typeof row.bookSlug !== 'string' || !BOOK_SLUG_PATTERN.test(row.bookSlug)) return null
  if (!isNoteScope(row.scope)) return null
  if (typeof row.body !== 'string' || row.body === '') return null
  if (row.body.length > MAX_NOTE_BODY_LENGTH) return null
  if (typeof row.createdAt !== 'string' || Number.isNaN(Date.parse(row.createdAt))) return null
  if (typeof row.updatedAt !== 'string' || Number.isNaN(Date.parse(row.updatedAt))) return null

  const anchor = asNoteAnchor(row.anchor)
  if (!anchor) return null
  // The scope on the row and the scope on the anchor are two statements about
  // the same thing; a row where they disagree is not a note this can render.
  if (anchor.scope !== row.scope) return null

  return {
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
    // that has been edited zero times. See `asNoteRevision`.
    revision: asNoteRevision(row.revision),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
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
  async listNotes(owner: OwnerRef, bookSlug: string): Promise<Note[]> {
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
  async listBookNotes(bookSlug: string, ownerKind: OwnerKind): Promise<Note[]> {
    const prefix = bookNotesPrefix(bookSlug, ownerKind)
    return this.readUnder(prefix, (note) => {
      if (note.ownerKind !== ownerKind) return false
      return note.bookSlug === bookSlug
    })
  }

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

    const existing = asNote(parseJson(current.body))
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
   * Remove a note.
   *
   * The object is deleted, not tombstoned and not copied elsewhere first. A
   * retracted note leaves no hidden copy of what it said, which is the
   * behaviour Package 2's visible-deletion event has to be built on top of: it
   * can record *that* a shared note was withdrawn without this package having
   * squirrelled the body away where its author cannot reach it.
   */
  async removeNote(owner: OwnerRef, bookSlug: string, id: string): Promise<boolean> {
    const existing = await this.getNote(owner, bookSlug, id)
    if (!existing) return false
    await this.objects.del(notePath(owner, bookSlug, id))
    return true
  }

  private async write(note: Note): Promise<void> {
    await this.objects.put(
      notePath({ kind: note.ownerKind, id: note.ownerId }, note.bookSlug, note.id),
      serializeNote(note),
    )
  }

  /** Read every valid note under a prefix the caller has already built. */
  private async readUnder(prefix: string, keep: (note: Note) => boolean): Promise<Note[]> {
    const rows: Note[] = []
    for (const path of await this.objects.list(prefix)) {
      // The store was asked for one prefix, but a listing is still input.
      if (!path.startsWith(prefix)) continue
      const raw = await this.objects.get(path)
      if (raw === null) continue
      const note = asNote(parseJson(raw))
      if (!note || !keep(note)) continue
      rows.push(note)
    }
    return sortNotes(rows)
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
