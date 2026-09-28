/**
 * Private reading records: resume positions, bookmarks and passage annotations.
 *
 * These belong to a **person**, not to a browser. The reader's appearance
 * settings -- theme and text size -- are still kept in `localStorage`, because
 * those genuinely are a property of the device somebody is reading on. A place
 * in a book, a bookmark and a note are not: they must follow a reviewer from
 * their phone to their laptop, survive clearing a cache, and be provably the
 * work of the reviewer whose cookie signed the request. So they live on the
 * server, under a prefix derived from the authenticated owner.
 *
 * ## No new infrastructure
 *
 * This module introduces no database, no vendor, no package, no account and no
 * new secret. It selects its driver from the **same** `REVIEWER_FEEDBACK_DRIVER`
 * the feedback store already uses, and the blob driver uses the **same**
 * `BLOB_READ_WRITE_TOKEN` credential in the **same** private store. A deployment
 * that can already keep a reviewer's comment can already keep their bookmarks,
 * with nothing to configure. `REVIEWER_READING_DIR` exists only as an optional
 * override for the filesystem driver and defaults to a `reading/` directory
 * beside the feedback rows.
 *
 * ## How this differs from feedback storage, and why
 *
 * Feedback is evidence: append-only, immutable, never rewritten. Submitted
 * chapter and book feedback stays exactly as it was submitted, and nothing here
 * touches it.
 *
 * Reading records are working state that their owner controls. A bookmark is
 * added and removed; a note's sharing is changed; a reading position is
 * overwritten continuously by definition. So this store can overwrite and
 * delete -- but only ever at a pathname built from the authenticated owner's
 * own prefix, which is why a delete can never reach another person's record:
 * the path that would name it is never constructed.
 *
 * ## The layout
 *
 *   reading/v1/<ownerKind>/<ownerId>/<bookSlug>/position.json
 *   reading/v1/<ownerKind>/<ownerId>/<bookSlug>/bookmarks/<createdAt>-<id>.json
 *   reading/v1/<ownerKind>/<ownerId>/<bookSlug>/annotations/<id>.json
 *   reading/v1/share/<token>.json
 *
 * `ownerKind` is `reviewer` or `author`, which is what keeps Mike's own reading
 * in a separate namespace: the author's progress, bookmarks and notes cannot
 * land in a reviewer's prefix, and reading a manuscript as the author touches
 * no reviewer record at all.
 *
 * The share index is the one global object, and it is only a locator: it maps a
 * random token to (owner, book, annotation id). Holding it grants nothing --
 * `lib/reading-access.ts` still requires a valid author session or a reviewer
 * the roster currently entitles to that book.
 */

import { createHash, randomUUID, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

import {
  isAnnotationVisibility,
  type AnnotationVisibility,
  type OwnerKind,
  type OwnerRef,
} from './reading-access.ts'
import {
  isStaleSequence,
  mergeDeviceSequence,
  normalizeDeviceId,
  normalizeDeviceList,
  normalizeSequence,
  type DeviceSequence,
} from './reading-order.ts'
import { MAX_NOTE_LENGTH, MAX_QUOTE_LENGTH } from './reading-anchor.ts'
import { createVercelBlobReadingObjects } from './reviewer-reading-blob.ts'

if (typeof window !== 'undefined') {
  throw new Error(
    'lib/reviewer-reading is server-only and must not be imported by a client component',
  )
}

/** Layout version. A later layout is a new prefix, never a reinterpretation. */
export const READING_PREFIX_VERSION = 'v1'

/** Root of every object this store writes. */
export const READING_ROOT = `reading/${READING_PREFIX_VERSION}`

const OWNER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/
const BOOK_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const CHAPTER_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const RECORD_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const SHARE_TOKEN_PATTERN = /^[a-f0-9]{32}$/

/* ------------------------------------------------------------------- types */

export type ReadingPosition = {
  schema: 1
  ownerKind: OwnerKind
  ownerId: string
  bookSlug: string
  bookTitle: string
  chapterSlug: string
  chapterNumber: number
  chapterLabel: string
  /** The paragraph they had reached, or null for the top of the chapter. */
  paragraphId: string | null
  paragraphOrdinal: number | null
  /**
   * How far into that paragraph they were, 0 to 1. Optional.
   *
   * A paragraph in this manuscript can run to ten lines on a phone, and a
   * place recorded only as "paragraph 19" sends a reader who stopped at its
   * last line back to its first — measured at 523px, about six lines of
   * re-reading. This is the rest of the answer.
   *
   * Absent on every record written before it existed, and absent whenever no
   * paragraph is named. A reader that does not understand it, or a record
   * that does not carry it, simply lands at the top of the paragraph as
   * before — which is why this needs no schema bump.
   */
  paragraphOffset?: number
  /**
   * Which device wrote the position on record, and its own counter for it.
   *
   * Both optional, and both absent on every record written before ordering
   * existed. They are an ordering aid and nothing else: see `lib/reading-order.ts`
   * for why a device identifier can never be authorization evidence, and why
   * two devices' sequences are never compared with each other.
   */
  device?: string
  sequence?: number
  /**
   * The newest sequence accepted from each recent device, oldest entry first.
   *
   * Not only the device named above: a delayed request from a device that lost
   * a race has to be recognisable as old *after* it has lost, which needs that
   * device's mark to survive another device taking the position. Bounded by
   * `MAX_TRACKED_DEVICES`.
   */
  devices?: DeviceSequence[]
  /** ISO 8601, UTC. */
  updatedAt: string
}

/** What an ordered position write came to. */
export type PositionWriteOutcome =
  /** Written. `position` is exactly what is now on record. */
  | { outcome: 'stored'; position: ReadingPosition }
  /**
   * Refused as older than something already accepted from the *same* device.
   * Nothing was written; `position` is what remains on record.
   */
  | { outcome: 'stale'; position: ReadingPosition | null }

/**
 * How many times a conditional position write may lose a race before giving up.
 *
 * A position is written by one reader on a handful of devices, so a collision
 * is already unusual and two in a row is close to unheard of. The loop exists
 * so a genuine collision is retried rather than dropped; the bound exists so
 * that a store which somehow never settles fails loudly instead of spinning.
 */
const POSITION_WRITE_ATTEMPTS = 4

/** Raised when a position write kept losing its race. Never silently dropped. */
export class ReadingWriteConflictError extends Error {
  constructor() {
    super('the reading position was being written concurrently and did not settle')
    this.name = 'ReadingWriteConflictError'
  }
}

export type Bookmark = {
  schema: 1
  id: string
  ownerKind: OwnerKind
  ownerId: string
  bookSlug: string
  chapterSlug: string
  chapterNumber: number
  chapterLabel: string
  paragraphId: string
  paragraphOrdinal: number
  /** A short excerpt, copied from the manuscript, so a list reads on its own. */
  excerpt: string
  /** `sha256` of the chapter file this bookmark was placed in. */
  manuscriptSha256: string
  createdAt: string
}

export type Annotation = {
  schema: 1
  id: string
  ownerKind: OwnerKind
  ownerId: string
  bookSlug: string
  chapterSlug: string
  chapterNumber: number
  chapterLabel: string
  paragraphId: string
  paragraphOrdinal: number
  startOffset: number
  endOffset: number
  /** The captured quotation, copied server-side from the verified manuscript. */
  quote: string
  /** `sha256` of the chapter file the offsets were measured in. */
  manuscriptSha256: string
  /** Optional: a highlight with nothing written about it is a complete record. */
  note: string | null
  visibility: AnnotationVisibility
  /**
   * The private link's locator, minted once and kept even if sharing is later
   * narrowed, so re-sharing does not silently invalidate a link already given
   * to somebody. It authorizes nothing on its own.
   */
  shareToken: string | null
  createdAt: string
  updatedAt: string
}

/** What a share token resolves to. A locator and nothing more. */
export type ShareRef = {
  schema: 1
  ownerKind: OwnerKind
  ownerId: string
  bookSlug: string
  annotationId: string
}

/**
 * Raised when no durable store is configured. Mirrors the feedback store's
 * behaviour exactly: a write is refused loudly rather than lost quietly, and
 * never falls back to the browser.
 */
export class ReadingStorageUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReadingStorageUnavailableError'
  }
}

/* --------------------------------------------------------- the object layer */

/**
 * The whole storage surface: four operations on opaque paths.
 *
 * Keeping the drivers this small is what lets one set of record rules -- every
 * path, every scope check, every validation below -- be shared by the
 * filesystem and the blob store, and tested once against both.
 */
export type ReadingObjects = {
  readonly driver: string
  readonly durable: boolean
  /** The object's bytes, or null when the store answered and it is not there. */
  get(path: string): Promise<string | null>
  /**
   * The object's bytes together with the revision they were read at.
   *
   * `version` is opaque and driver-specific -- a content digest on the
   * filesystem, an ETag on the blob store -- and is null exactly when the
   * object is absent. It exists so that a decision taken from what was read can
   * be applied only if nothing has been written in between.
   */
  getVersioned(path: string): Promise<VersionedReadingObject>
  /**
   * Write only if the stored revision is exactly `version`.
   *
   * `null` means "nothing must be there", which is how a first write is made
   * safe against two callers doing it at once. Resolves false when the
   * precondition failed -- somebody else wrote first. Anything else **rejects**:
   * treating a network or credential failure as a lost race would turn an
   * outage into a silently dropped place.
   */
  putIfMatch(path: string, body: string, version: string | null): Promise<boolean>
  /** Write, replacing any existing object at that path. */
  put(path: string, body: string): Promise<void>
  /** Remove. Removing something absent is not an error. */
  del(path: string): Promise<void>
  /**
   * Remove only if the stored revision is exactly `version`.
   *
   * The removal counterpart of `putIfMatch`, and the exact analogue of
   * `removeIfMatch` on `lib/private-store.ts` -- named for the verb it is
   * conditional on, as `putIfMatch` is, so the two conditional primitives on
   * this interface read the same way.
   *
   * Resolves **false** when the precondition failed, *including when the object
   * is already absent*: "nothing was removed by this call" is the honest report
   * in both cases, and the caller decides what that means. Anything else
   * **rejects**, for the same reason `putIfMatch` does -- a network or
   * credential failure read as "somebody else got there first" would turn an
   * outage into a silently dropped removal, and, worse, into a deletion this
   * code would then report as having happened.
   *
   * `del` remains for the records that are genuinely unconditional -- a
   * bookmark, an annotation's share pointer, a reading position. A note's
   * deletion is not one of them: see `NoteStore.removeNote`.
   */
  delIfMatch(path: string, version: string): Promise<boolean>
  /** Every path beneath a prefix. */
  list(prefix: string): Promise<string[]>
}

/** An object's bytes and the exact stored revision they were read at. */
export type VersionedReadingObject = {
  /** Null when the store answered and the object is not there. */
  body: string | null
  /** Opaque and driver-specific. Null exactly when `body` is null. */
  version: string | null
}

/* ------------------------------------------------------ unconfigured driver */

class UnconfiguredReadingObjects implements ReadingObjects {
  readonly driver = 'unconfigured'
  readonly durable = false

  async get(): Promise<string | null> {
    // Reading nothing is honest: there is no store, so there is nothing in it.
    return null
  }

  async getVersioned(): Promise<VersionedReadingObject> {
    return { body: null, version: null }
  }

  async putIfMatch(): Promise<boolean> {
    throw new ReadingStorageUnavailableError(
      'No reviewer reading store is configured. Set REVIEWER_FEEDBACK_DRIVER.',
    )
  }

  async put(): Promise<void> {
    throw new ReadingStorageUnavailableError(
      'No reviewer reading store is configured. Set REVIEWER_FEEDBACK_DRIVER.',
    )
  }

  async del(): Promise<void> {
    throw new ReadingStorageUnavailableError(
      'No reviewer reading store is configured. Set REVIEWER_FEEDBACK_DRIVER.',
    )
  }

  async delIfMatch(): Promise<boolean> {
    // Thrown, not `false`. `false` means "the store answered, and the
    // precondition did not hold", which a caller turns into a conflict it can
    // tell somebody about. There is no store here, so there is no answer.
    throw new ReadingStorageUnavailableError(
      'No reviewer reading store is configured. Set REVIEWER_FEEDBACK_DRIVER.',
    )
  }

  async list(): Promise<string[]> {
    return []
  }
}

/* ------------------------------------------------------- filesystem driver */

/** The filesystem driver's revision: the bytes themselves, hashed. */
function digestOf(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

class FileSystemReadingObjects implements ReadingObjects {
  readonly driver = 'fs'
  readonly durable = true

  private readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  private resolveWithin(path: string): string {
    // Every path this module builds is assembled from pattern-checked parts, so
    // this cannot trigger in practice. It is here because a storage root is
    // exactly the place a path-traversal bug would matter most, and a cheap
    // absolute check is worth more than an assumption.
    const full = resolve(join(this.root, path))
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error('reading storage path escaped its root')
    }
    return full
  }

  async get(path: string): Promise<string | null> {
    const full = this.resolveWithin(path)
    if (!existsSync(full)) return null
    return readFileSync(full, 'utf8')
  }

  async getVersioned(path: string): Promise<VersionedReadingObject> {
    const full = this.resolveWithin(path)
    if (!existsSync(full)) return { body: null, version: null }
    const body = readFileSync(full, 'utf8')
    return { body, version: digestOf(body) }
  }

  /**
   * Conditional write, as one uninterrupted synchronous section.
   *
   * There is no `await` between reading the stored bytes and writing the new
   * ones, so nothing in this process can interleave between the check and the
   * write: it is a compare-and-swap rather than a read-then-hope. The absent
   * case uses `O_CREAT | O_EXCL` (`flag: 'wx'`), which the kernel makes atomic.
   * This mirrors `lib/private-store.ts` exactly, deliberately: the same
   * guarantee should not be argued from two different implementations.
   */
  async putIfMatch(path: string, body: string, version: string | null): Promise<boolean> {
    const full = this.resolveWithin(path)
    if (version === null) {
      mkdirSync(dirname(full), { recursive: true })
      try {
        writeFileSync(full, body, { encoding: 'utf8', flag: 'wx' })
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') return false
        throw error
      }
    }
    if (!existsSync(full)) return false
    if (digestOf(readFileSync(full, 'utf8')) !== version) return false
    writeFileSync(full, body, 'utf8')
    return true
  }

  async put(path: string, body: string): Promise<void> {
    const full = this.resolveWithin(path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, body, 'utf8')
  }

  async del(path: string): Promise<void> {
    const full = this.resolveWithin(path)
    if (!existsSync(full)) return
    rmSync(full, { force: true })
  }

  /**
   * Conditional removal, as one uninterrupted synchronous section.
   *
   * No `await` between reading the stored bytes and removing them, exactly as
   * `putIfMatch` above and `FileSystemPrivateStore.removeIfMatch` in
   * `lib/private-store.ts`: nothing in this process can interleave between the
   * comparison and the removal. An absent object answers `false` rather than
   * `true`, because nothing was removed by this call.
   */
  async delIfMatch(path: string, version: string): Promise<boolean> {
    const full = this.resolveWithin(path)
    if (!existsSync(full)) return false
    if (digestOf(readFileSync(full, 'utf8')) !== version) return false
    rmSync(full, { force: true })
    return true
  }

  /**
   * Every object beneath a prefix, at any depth.
   *
   * Depth matters because the blob driver's `list` is a **prefix** match with
   * no delimiter -- it has always returned objects nested arbitrarily deep --
   * and the two drivers have to answer the same question the same way or a
   * rule proved against one is not a rule. Every prefix this store listed
   * before notes existed was a leaf directory, so nothing that already worked
   * sees a different answer; what changes is that a listing which spans a level
   * (`notes/v1/<book>/reviewer/`, one entry per reviewer) now works on the
   * filesystem as well as in production.
   */
  async list(prefix: string): Promise<string[]> {
    const full = this.resolveWithin(prefix)
    if (!existsSync(full)) return []
    const out: string[] = []
    for (const name of readdirSync(full, { withFileTypes: true })) {
      if (name.isFile()) out.push(`${prefix}${name.name}`)
      else if (name.isDirectory()) out.push(...(await this.list(`${prefix}${name.name}/`)))
    }
    return out
  }
}

/* ------------------------------------------------------------- path helpers */

function assertOwner(owner: OwnerRef): void {
  if (owner.kind !== 'reviewer' && owner.kind !== 'author') {
    throw new Error('invalid owner kind for reading storage')
  }
  if (!OWNER_ID_PATTERN.test(owner.id)) {
    throw new Error('invalid owner id for reading storage')
  }
}

function assertBookSlug(bookSlug: string): void {
  if (!BOOK_SLUG_PATTERN.test(bookSlug)) {
    throw new Error('invalid book slug for reading storage')
  }
}

function assertRecordId(id: string): void {
  if (!RECORD_ID_PATTERN.test(id)) {
    throw new Error('invalid record id for reading storage')
  }
}

/**
 * The prefix beneath which one owner's records for one book live, and the only
 * prefix ever listed. The trailing slash matters: without it an owner id that
 * is a prefix of another id would list the other's objects.
 */
export function bookPrefix(owner: OwnerRef, bookSlug: string): string {
  assertOwner(owner)
  assertBookSlug(bookSlug)
  return `${READING_ROOT}/${owner.kind}/${owner.id}/${bookSlug}/`
}

export function positionPath(owner: OwnerRef, bookSlug: string): string {
  return `${bookPrefix(owner, bookSlug)}position.json`
}

export function bookmarksPrefix(owner: OwnerRef, bookSlug: string): string {
  return `${bookPrefix(owner, bookSlug)}bookmarks/`
}

export function bookmarkPath(bookmark: Bookmark): string {
  assertRecordId(bookmark.id)
  const stamp = bookmark.createdAt.replace(/[:.]/g, '-')
  return `${bookmarksPrefix(
    { kind: bookmark.ownerKind, id: bookmark.ownerId },
    bookmark.bookSlug,
  )}${stamp}-${bookmark.id}.json`
}

export function annotationsPrefix(owner: OwnerRef, bookSlug: string): string {
  return `${bookPrefix(owner, bookSlug)}annotations/`
}

export function annotationPath(owner: OwnerRef, bookSlug: string, id: string): string {
  assertRecordId(id)
  return `${annotationsPrefix(owner, bookSlug)}${id}.json`
}

export function sharePath(token: string): string {
  if (!SHARE_TOKEN_PATTERN.test(token)) {
    throw new Error('invalid share token')
  }
  return `${READING_ROOT}/share/${token}.json`
}

/** A fresh, unguessable private-link locator: 128 bits of randomness, hex. */
export function mintShareToken(): string {
  return randomBytes(16).toString('hex')
}

/** A fresh record id, lower-cased so it satisfies the storage path pattern. */
export function mintRecordId(): string {
  return randomUUID().toLowerCase()
}

/* ------------------------------------------------------------- the store */

export type BookmarkDraft = Omit<Bookmark, 'schema' | 'id' | 'createdAt'>
export type AnnotationDraft = Omit<
  Annotation,
  'schema' | 'id' | 'createdAt' | 'updatedAt' | 'shareToken'
>

/**
 * Every operation on private reading material.
 *
 * Each one takes the owner explicitly, and every path it builds starts from
 * that owner's prefix. There is no method that means "everything", and no
 * method that can be asked for a record without saying whose it is -- except
 * `resolveShareToken`, which returns a locator and no content at all.
 */
/**
 * Annotations read from a prefix, **with whether the answer is complete**.
 *
 * See `ReadingStore.listAnnotations` below, and `WithdrawalListing` in
 * `lib/withdrawal-events.ts` for the precedent this follows.
 */
export type AnnotationListing = {
  annotations: Annotation[]
  /** True when at least one listed object could not be read as an annotation. */
  incomplete: boolean
}

export class ReadingStore {
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

  /* ------------------------------------------------------------- position */

  async readPosition(owner: OwnerRef, bookSlug: string): Promise<ReadingPosition | null> {
    const raw = await this.objects.get(positionPath(owner, bookSlug))
    if (raw === null) return null
    const parsed = parseJson(raw)
    const position = asPosition(parsed)
    if (!position) return null
    // Scope on read as well as on write: a misfiled object is skipped rather
    // than disclosed, whatever put it there.
    if (position.ownerKind !== owner.kind || position.ownerId !== owner.id) return null
    if (position.bookSlug !== bookSlug) return null
    return position
  }

  /**
   * Record a position, in order, as one conditional atomic mutation.
   *
   * ## Why this is not a `put`
   *
   * It used to be. A position was read nowhere and written unconditionally, so
   * two requests in flight at once landed in whatever order the network
   * happened to deliver them -- and a request delayed by three seconds on a
   * phone's flaky connection overwrote the newer one that had overtaken it.
   * The reader was then shown a place they had already read past, which is
   * indistinguishable from the save having been lost.
   *
   * ## What one call does
   *
   * Reads the stored object *with its revision*, decides against what it read,
   * and writes back only if that revision is still current. The decision and
   * the write are therefore one indivisible step: the per-device high-water
   * marks are inside the same object as the position they order, so there is no
   * interleaving in which the ordering says one thing and the position says
   * another. Losing the race means somebody else wrote in between, and the only
   * correct response is to read again and re-decide -- which is the loop.
   *
   * ## The rule it applies
   *
   *   - A save whose sequence is at or below what this **same** device has
   *     already had accepted is refused as stale. Nothing is written.
   *   - A save from **any other** device is accepted, exactly as before. Their
   *     sequences are never compared; last arrival still wins across devices.
   *   - A save with no device metadata at all is accepted, exactly as before.
   *
   * So `A10`, then `B5`, then a delayed `A9` leaves `B5` on record: `A9` is at
   * or below A's own high-water of 10, and A's mark survived B taking the
   * position precisely because every device's mark is carried forward.
   */
  async savePosition(
    position: ReadingPosition,
    order: { device?: unknown; sequence?: unknown } = {},
  ): Promise<PositionWriteOutcome> {
    const owner = { kind: position.ownerKind, id: position.ownerId }
    const path = positionPath(owner, position.bookSlug)
    const device = normalizeDeviceId(order.device)
    const sequence = device === null ? null : normalizeSequence(order.sequence)

    for (let attempt = 0; attempt < POSITION_WRITE_ATTEMPTS; attempt += 1) {
      const current = await this.objects.getVersioned(path)
      const existing = current.body === null ? null : asPosition(parseJson(current.body))

      // A misfiled or foreign object is not ordering evidence about this
      // reader, and is overwritten rather than consulted -- the same posture
      // `readPosition` takes when it refuses to disclose one.
      const ordering =
        existing &&
        existing.ownerKind === owner.kind &&
        existing.ownerId === owner.id &&
        existing.bookSlug === position.bookSlug
          ? existing
          : null

      if (isStaleSequence(ordering?.devices, device, sequence)) {
        return { outcome: 'stale', position: ordering }
      }

      const next: ReadingPosition = {
        ...position,
        ...(device === null || sequence === null
          ? {}
          : {
              device,
              sequence,
              devices: mergeDeviceSequence(ordering?.devices, device, sequence),
            }),
        // A legacy save carries no ordering of its own, and must not erase the
        // marks that order everybody else's.
        ...(device === null && ordering?.devices ? { devices: ordering.devices } : {}),
      }

      const written = await this.objects.putIfMatch(
        path,
        `${JSON.stringify(next, null, 2)}\n`,
        current.version,
      )
      if (written) return { outcome: 'stored', position: next }
    }

    throw new ReadingWriteConflictError()
  }

  /**
   * Record a position with no ordering metadata.
   *
   * Kept for callers that have none to give -- which is every caller written
   * before ordering existed. It is still a conditional write underneath, so it
   * cannot reintroduce the unconditional overwrite; with nothing to order by it
   * simply lands last-arrival-wins, exactly as it always did.
   */
  async writePosition(position: ReadingPosition): Promise<void> {
    await this.savePosition(position)
  }

  /* ------------------------------------------------------------ bookmarks */

  async listBookmarks(owner: OwnerRef, bookSlug: string): Promise<Bookmark[]> {
    const prefix = bookmarksPrefix(owner, bookSlug)
    const paths = await this.objects.list(prefix)
    const rows: Bookmark[] = []

    for (const path of paths) {
      // The store was asked for one prefix, but a listing is still input.
      if (!path.startsWith(prefix)) continue
      const raw = await this.objects.get(path)
      if (raw === null) continue
      const bookmark = asBookmark(parseJson(raw))
      if (!bookmark) continue
      if (bookmark.ownerKind !== owner.kind || bookmark.ownerId !== owner.id) continue
      if (bookmark.bookSlug !== bookSlug) continue
      rows.push(bookmark)
    }

    return sortByChapterThenParagraph(rows)
  }

  async addBookmark(draft: BookmarkDraft): Promise<Bookmark> {
    const bookmark: Bookmark = {
      schema: 1,
      id: mintRecordId(),
      createdAt: new Date().toISOString(),
      ...draft,
    }
    await this.objects.put(bookmarkPath(bookmark), `${JSON.stringify(bookmark, null, 2)}\n`)
    return bookmark
  }

  /**
   * Remove one bookmark by id.
   *
   * The id is never turned directly into a path: the owner's own bookmark
   * prefix is listed and the matching row is found in it. A guessed or stolen
   * id therefore cannot reach another person's bookmark, because the only
   * prefix searched is the caller's own. Returns false when there was nothing
   * of theirs with that id.
   */
  async removeBookmark(owner: OwnerRef, bookSlug: string, id: string): Promise<boolean> {
    assertRecordId(id)
    const prefix = bookmarksPrefix(owner, bookSlug)
    for (const path of await this.objects.list(prefix)) {
      if (!path.startsWith(prefix)) continue
      const raw = await this.objects.get(path)
      if (raw === null) continue
      const bookmark = asBookmark(parseJson(raw))
      if (!bookmark || bookmark.id !== id) continue
      if (bookmark.ownerKind !== owner.kind || bookmark.ownerId !== owner.id) continue
      await this.objects.del(path)
      return true
    }
    return false
  }

  /* ---------------------------------------------------------- annotations */

  /**
   * One owner's annotations on one book, and whether that is all of them.
   *
   * A listed object that would not read, bytes that are not an annotation, or
   * a row filed here that says it belongs to somebody else are each a **gap**
   * in the answer, not an absence. They used to be dropped silently, so a
   * damaged row and a reviewer who had highlighted nothing produced the same
   * empty array -- and the author's export stamped the first as complete.
   *
   * The pair returned here is the one `WithdrawalStore.list` already returns,
   * and it is consumed the same way: disclosed and refused, never flattened.
   */
  async listAnnotations(owner: OwnerRef, bookSlug: string): Promise<AnnotationListing> {
    const prefix = annotationsPrefix(owner, bookSlug)
    const paths = await this.objects.list(prefix)
    const rows: Annotation[] = []
    let incomplete = false

    for (const path of paths) {
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
      const annotation = asAnnotation(parseJson(raw))
      if (!annotation) {
        incomplete = true
        continue
      }
      if (annotation.ownerKind !== owner.kind || annotation.ownerId !== owner.id) {
        incomplete = true
        continue
      }
      if (annotation.bookSlug !== bookSlug) {
        incomplete = true
        continue
      }
      rows.push(annotation)
    }

    return { annotations: sortByChapterThenParagraph(rows), incomplete }
  }

  async getAnnotation(
    owner: OwnerRef,
    bookSlug: string,
    id: string,
  ): Promise<Annotation | null> {
    const raw = await this.objects.get(annotationPath(owner, bookSlug, id))
    if (raw === null) return null
    const annotation = asAnnotation(parseJson(raw))
    if (!annotation) return null
    if (annotation.ownerKind !== owner.kind || annotation.ownerId !== owner.id) return null
    if (annotation.bookSlug !== bookSlug || annotation.id !== id) return null
    return annotation
  }

  async addAnnotation(draft: AnnotationDraft): Promise<Annotation> {
    const now = new Date().toISOString()
    const owner: OwnerRef = { kind: draft.ownerKind, id: draft.ownerId }
    const annotation: Annotation = {
      schema: 1,
      id: mintRecordId(),
      createdAt: now,
      updatedAt: now,
      shareToken: draft.visibility === 'link' ? mintShareToken() : null,
      ...draft,
    }
    await this.saveAnnotation(owner, annotation)
    return annotation
  }

  /**
   * Change an annotation's note or sharing.
   *
   * The anchor is not among the things that can change: offsets, quotation,
   * paragraph and fingerprint are written once, when the passage was actually
   * selected in a known version of the text. Allowing them to be rewritten
   * afterwards would be exactly the silent re-attachment this feature refuses.
   */
  async updateAnnotation(
    owner: OwnerRef,
    bookSlug: string,
    id: string,
    changes: { note?: string | null; visibility?: AnnotationVisibility },
  ): Promise<Annotation | null> {
    const existing = await this.getAnnotation(owner, bookSlug, id)
    if (!existing) return null

    const visibility = changes.visibility ?? existing.visibility

    const next: Annotation = {
      ...existing,
      note: changes.note === undefined ? existing.note : changes.note,
      visibility,
      // Minted on first use and then kept, so a link already handed to somebody
      // keeps working if sharing is widened again. It grants nothing by itself.
      shareToken:
        existing.shareToken ?? (visibility === 'link' ? mintShareToken() : null),
      updatedAt: new Date().toISOString(),
    }

    await this.saveAnnotation(owner, next)
    return next
  }

  async removeAnnotation(owner: OwnerRef, bookSlug: string, id: string): Promise<boolean> {
    const existing = await this.getAnnotation(owner, bookSlug, id)
    if (!existing) return false

    // The locator goes first. If the second delete fails, a token that resolves
    // to nothing is harmless; a live token pointing at a deleted record would
    // also be harmless, but this ordering leaves no dangling capability even
    // for an instant.
    if (existing.shareToken) {
      await this.objects.del(sharePath(existing.shareToken))
    }
    await this.objects.del(annotationPath(owner, bookSlug, id))
    return true
  }

  /**
   * What a private link points at.
   *
   * This returns a locator -- owner, book, annotation id -- and never content.
   * The caller must still load the annotation and run it past
   * `canViewAnnotation`, which requires a real session and real entitlement.
   */
  async resolveShareToken(token: string): Promise<ShareRef | null> {
    if (!SHARE_TOKEN_PATTERN.test(token)) return null
    const raw = await this.objects.get(sharePath(token))
    if (raw === null) return null
    return asShareRef(parseJson(raw))
  }

  private async saveAnnotation(owner: OwnerRef, annotation: Annotation): Promise<void> {
    await this.objects.put(
      annotationPath(owner, annotation.bookSlug, annotation.id),
      `${JSON.stringify(annotation, null, 2)}\n`,
    )

    if (annotation.shareToken) {
      const ref: ShareRef = {
        schema: 1,
        ownerKind: annotation.ownerKind,
        ownerId: annotation.ownerId,
        bookSlug: annotation.bookSlug,
        annotationId: annotation.id,
      }
      await this.objects.put(
        sharePath(annotation.shareToken),
        `${JSON.stringify(ref, null, 2)}\n`,
      )
    }
  }
}

/* ------------------------------------------------------------- validation */

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function isRow(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOwnerKind(value: unknown): value is OwnerKind {
  return value === 'reviewer' || value === 'author'
}

function commonOk(row: Record<string, unknown>): boolean {
  if (row.schema !== 1) return false
  if (!isOwnerKind(row.ownerKind)) return false
  if (typeof row.ownerId !== 'string' || !OWNER_ID_PATTERN.test(row.ownerId)) return false
  if (typeof row.bookSlug !== 'string' || !BOOK_SLUG_PATTERN.test(row.bookSlug)) return false
  if (typeof row.chapterSlug !== 'string' || !CHAPTER_SLUG_PATTERN.test(row.chapterSlug)) {
    return false
  }
  if (typeof row.chapterNumber !== 'number' || !Number.isFinite(row.chapterNumber)) return false
  if (typeof row.chapterLabel !== 'string') return false
  return true
}

/**
 * Accept a stored object only if it really is a row of this schema.
 *
 * A truncated, half-written, hand-edited or foreign-schema object is skipped
 * rather than handed on with missing fields, because these values are rendered
 * directly and used to build links back into the manuscript.
 */
export function asPosition(value: unknown): ReadingPosition | null {
  if (!isRow(value) || !commonOk(value)) return null
  if (typeof value.bookTitle !== 'string') return null
  if (typeof value.paragraphId !== 'string' && value.paragraphId !== null) return null
  if (typeof value.paragraphOrdinal !== 'number' && value.paragraphOrdinal !== null) return null
  if (typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt))) {
    return null
  }

  /*
   * The ordering metadata is normalised, never a reason to reject.
   *
   * Every record written before ordering existed carries none of it, and those
   * records must keep working -- readable, writable, and resumable -- exactly
   * as they are. A record whose ordering fields are damaged is treated the same
   * way: the fields are dropped and the place survives. Losing somebody's place
   * in a book because the bookkeeping beside it was malformed would be a much
   * worse failure than the one this ordering exists to prevent.
   */
  const device = normalizeDeviceId(value.device)
  const sequence = device === null ? null : normalizeSequence(value.sequence)
  const devices = normalizeDeviceList(value.devices)

  const clean =
    device === (value.device ?? null) &&
    sequence === (value.sequence ?? null) &&
    devices === value.devices

  if (clean) return value as unknown as ReadingPosition

  const normalized = { ...value } as Record<string, unknown>
  if (device === null || sequence === null) {
    delete normalized.device
    delete normalized.sequence
  }
  if (devices === undefined) delete normalized.devices
  else normalized.devices = devices

  return normalized as unknown as ReadingPosition
}

export function asBookmark(value: unknown): Bookmark | null {
  if (!isRow(value) || !commonOk(value)) return null
  if (typeof value.id !== 'string' || !RECORD_ID_PATTERN.test(value.id)) return null
  if (typeof value.paragraphId !== 'string' || value.paragraphId === '') return null
  if (typeof value.paragraphOrdinal !== 'number' || !Number.isFinite(value.paragraphOrdinal)) {
    return null
  }
  if (typeof value.excerpt !== 'string') return null
  if (typeof value.manuscriptSha256 !== 'string') return null
  if (typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) {
    return null
  }
  return value as unknown as Bookmark
}

export function asAnnotation(value: unknown): Annotation | null {
  if (!isRow(value) || !commonOk(value)) return null
  if (typeof value.id !== 'string' || !RECORD_ID_PATTERN.test(value.id)) return null
  if (typeof value.paragraphId !== 'string' || value.paragraphId === '') return null
  if (typeof value.paragraphOrdinal !== 'number' || !Number.isFinite(value.paragraphOrdinal)) {
    return null
  }
  if (typeof value.startOffset !== 'number' || !Number.isInteger(value.startOffset)) return null
  if (typeof value.endOffset !== 'number' || !Number.isInteger(value.endOffset)) return null
  if (value.startOffset < 0 || value.endOffset <= value.startOffset) return null
  if (typeof value.quote !== 'string' || value.quote === '') return null
  if (value.quote.length > MAX_QUOTE_LENGTH) return null
  if (typeof value.manuscriptSha256 !== 'string') return null
  if (value.note !== null && typeof value.note !== 'string') return null
  if (typeof value.note === 'string' && value.note.length > MAX_NOTE_LENGTH) return null
  if (!isAnnotationVisibility(value.visibility)) return null
  if (value.shareToken !== null) {
    if (typeof value.shareToken !== 'string' || !SHARE_TOKEN_PATTERN.test(value.shareToken)) {
      return null
    }
  }
  if (typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) {
    return null
  }
  if (typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt))) {
    return null
  }
  return value as unknown as Annotation
}

export function asShareRef(value: unknown): ShareRef | null {
  if (!isRow(value)) return null
  if (value.schema !== 1) return null
  if (!isOwnerKind(value.ownerKind)) return null
  if (typeof value.ownerId !== 'string' || !OWNER_ID_PATTERN.test(value.ownerId)) return null
  if (typeof value.bookSlug !== 'string' || !BOOK_SLUG_PATTERN.test(value.bookSlug)) return null
  if (typeof value.annotationId !== 'string' || !RECORD_ID_PATTERN.test(value.annotationId)) {
    return null
  }
  return value as unknown as ShareRef
}

/** Normalise and bound a note. Empty means "no note", which is a valid highlight. */
export function normalizeNote(raw: unknown): string | null | undefined {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'string') return undefined
  const text = raw.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (text === '') return null
  if (text.length > MAX_NOTE_LENGTH) return undefined
  return text
}

/**
 * Reading order: by chapter, then by paragraph, then by when it was made.
 *
 * A workspace is read as a book is read, not as a log is read, so the order
 * must not depend on how the store happened to page a listing.
 */
function sortByChapterThenParagraph<
  T extends { chapterNumber: number; paragraphOrdinal: number; createdAt: string; id: string },
>(rows: T[]): T[] {
  return rows.sort((a, b) => {
    if (a.chapterNumber !== b.chapterNumber) return a.chapterNumber - b.chapterNumber
    if (a.paragraphOrdinal !== b.paragraphOrdinal) return a.paragraphOrdinal - b.paragraphOrdinal
    if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt)
    return a.id.localeCompare(b.id)
  })
}

/* ----------------------------------------------------------------- factory */

let store: ReadingStore | null = null

/**
 * The configured reading store for this process.
 *
 * Driver selection is the feedback store's, on purpose: there is no separate
 * switch to forget, and no deployment where a comment is durable but a bookmark
 * is not. An unconfigured host gets the refusing driver, exactly as it does for
 * feedback -- a bookmark that was not stored is never reported as stored.
 */
export function createReadingStore(): ReadingStore {
  if (store) return store
  store = new ReadingStore(createReadingObjects())
  return store
}

/**
 * The configured object layer, on its own.
 *
 * Exported because the note store (`lib/notes-store.ts`) keeps its records in
 * the **same** private store, under the same credential, selected by the same
 * variable. There is no second driver switch to forget and no deployment where
 * a bookmark is durable and a note is not -- which is the same reasoning that
 * made reading records share the feedback store's driver in the first place.
 */
export function createReadingObjects(): ReadingObjects {
  const driver = (process.env.REVIEWER_FEEDBACK_DRIVER ?? '').trim().toLowerCase()

  if (driver === 'fs') {
    const explicit = (process.env.REVIEWER_READING_DIR ?? '').trim()
    const feedbackDir = (process.env.REVIEWER_FEEDBACK_DIR ?? '').trim()
    const dir = explicit || (feedbackDir ? join(feedbackDir, 'reading') : '')
    if (!dir) {
      throw new Error(
        'REVIEWER_FEEDBACK_DRIVER=fs requires REVIEWER_FEEDBACK_DIR (or REVIEWER_READING_DIR)',
      )
    }
    return new FileSystemReadingObjects(dir)
  }

  if (driver === 'vercel-blob') {
    return createVercelBlobReadingObjects({ token: process.env.BLOB_READ_WRITE_TOKEN })
  }

  return new UnconfiguredReadingObjects()
}

/** Test seam. Resets the memoised store so a test can drive each driver. */
export function __resetReadingStore(): void {
  store = null
}

/** Test seam. Builds a store over an arbitrary object layer. */
export function __readingStoreOver(objects: ReadingObjects): ReadingStore {
  return new ReadingStore(objects)
}
