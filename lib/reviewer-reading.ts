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

import { randomUUID, randomBytes } from 'node:crypto'
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
  /** ISO 8601, UTC. */
  updatedAt: string
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
  /** Write, replacing any existing object at that path. */
  put(path: string, body: string): Promise<void>
  /** Remove. Removing something absent is not an error. */
  del(path: string): Promise<void>
  /** Every path beneath a prefix. */
  list(prefix: string): Promise<string[]>
}

/* ------------------------------------------------------ unconfigured driver */

class UnconfiguredReadingObjects implements ReadingObjects {
  readonly driver = 'unconfigured'
  readonly durable = false

  async get(): Promise<string | null> {
    // Reading nothing is honest: there is no store, so there is nothing in it.
    return null
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

  async list(): Promise<string[]> {
    return []
  }
}

/* ------------------------------------------------------- filesystem driver */

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

  async list(prefix: string): Promise<string[]> {
    const full = this.resolveWithin(prefix)
    if (!existsSync(full)) return []
    const out: string[] = []
    for (const name of readdirSync(full, { withFileTypes: true })) {
      if (name.isFile()) out.push(`${prefix}${name.name}`)
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

  async writePosition(position: ReadingPosition): Promise<void> {
    const owner = { kind: position.ownerKind, id: position.ownerId }
    await this.objects.put(
      positionPath(owner, position.bookSlug),
      `${JSON.stringify(position, null, 2)}\n`,
    )
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

  async listAnnotations(owner: OwnerRef, bookSlug: string): Promise<Annotation[]> {
    const prefix = annotationsPrefix(owner, bookSlug)
    const paths = await this.objects.list(prefix)
    const rows: Annotation[] = []

    for (const path of paths) {
      if (!path.startsWith(prefix)) continue
      const raw = await this.objects.get(path)
      if (raw === null) continue
      const annotation = asAnnotation(parseJson(raw))
      if (!annotation) continue
      if (annotation.ownerKind !== owner.kind || annotation.ownerId !== owner.id) continue
      if (annotation.bookSlug !== bookSlug) continue
      rows.push(annotation)
    }

    return sortByChapterThenParagraph(rows)
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
  return value as unknown as ReadingPosition
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
    store = new ReadingStore(new FileSystemReadingObjects(dir))
  } else if (driver === 'vercel-blob') {
    store = new ReadingStore(
      createVercelBlobReadingObjects({ token: process.env.BLOB_READ_WRITE_TOKEN }),
    )
  } else {
    store = new ReadingStore(new UnconfiguredReadingObjects())
  }

  return store
}

/** Test seam. Resets the memoised store so a test can drive each driver. */
export function __resetReadingStore(): void {
  store = null
}

/** Test seam. Builds a store over an arbitrary object layer. */
export function __readingStoreOver(objects: ReadingObjects): ReadingStore {
  return new ReadingStore(objects)
}
