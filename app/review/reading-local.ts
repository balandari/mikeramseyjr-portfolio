/**
 * The one thing about a reading position that *is* a property of this browser:
 * the save it has made and has not yet seen the server acknowledge.
 *
 * Everything durable about reading lives on the server, and that is not changed
 * by anything here — a place in a book belongs to the person, follows them
 * between devices, and survives clearing a cache. What the server cannot do is
 * be faster than the network, and there is a moment where that matters:
 *
 *   1. A reviewer reads two screens of Chapter Three.
 *   2. They press Android Back. The place is measured and handed to the browser
 *      to deliver as the page closes.
 *   3. The library appears — from the App Router's client-side cache, which
 *      replays the document as it was rendered *before* any of that.
 *   4. The card asks the server, and the answer comes back before the leaving
 *      page's own write has landed.
 *
 * Every step there is correct, and the reviewer is still shown Chapter Two.
 * Mike reproduced exactly this, and proved the write was not lost: refreshing
 * showed Chapter Three. So what the card needs is not a fresher fetch — it had
 * one — but knowledge that **this device has a newer place in flight**, which
 * only this device has.
 *
 * ## The rule, and why "newest response wins" is not it
 *
 * A local place is preferred over the server's only while the server has not
 * yet confirmed it, and only ever over a position the server attributes to a
 * *different* device or to an older save from this one. Confirmation is the
 * server reporting a sequence for **this device** at or past the pending one;
 * sequences from two devices are never compared, because they count different
 * things (`lib/reading-order.ts`).
 *
 * And it is bounded. A pending place that is never confirmed is a place that
 * was probably never stored, and continuing to show it would be exactly the
 * comfortable lie this reader is built to avoid: after
 * `PENDING_RECONCILE_LIMIT` unconfirmed reconciliations, or `PENDING_TTL_MS`,
 * the server's record is shown and the reader is told plainly that their place
 * could not be saved.
 *
 * ## Whose place it is
 *
 * Every record is keyed by the reader's storage namespace — the same opaque,
 * HMAC-derived identity the appearance settings already use — and by the book.
 * A different reviewer signing in on the same phone cannot read the previous
 * one's key, and `sweepForeignPending` removes what is left of it: a borrowed
 * browser must not be able to say where somebody else stopped reading.
 *
 * `localStorage` is the smallest mechanism that holds these invariants: it
 * survives the page being torn down mid-navigation, which is the entire
 * problem, and it is synchronous, so a place can be recorded on the way out
 * without waiting for anything. It is never read as authority for what is
 * stored, and nothing here is ever sent to the server as evidence of identity.
 */

import type { ClientPosition } from '../../lib/reading-view.ts'
import {
  normalizeDeviceId,
  normalizeSequence,
  serverHasConfirmed,
  // Relative, with the extension, because this module is exercised directly by
  // `tests/reading-pending.test.ts` under Node's own resolver -- which knows
  // nothing about the `@/` alias. Every rule in it is decided without a browser,
  // and it is worth keeping it that way.
} from '../../lib/reading-order.ts'

/** Key prefix for one reader's pending place in one book. */
const PENDING_PREFIX = 'mrj.reading.pending.'
/** This browser's ordering identity. Not scoped to a reader: it is the device. */
const DEVICE_KEY = 'mrj.reading.device'
/** This device's counter. Shared by every tab, which is what keeps it rising. */
const SEQUENCE_KEY = 'mrj.reading.seq'

/**
 * How long an unconfirmed local place may outrank the server's record.
 *
 * Long enough to cover a slow phone connection finishing a write that was
 * handed over as the page closed; short enough that a place which never
 * arrived is not still being shown as if it had.
 */
export const PENDING_TTL_MS = 90_000

/**
 * How many reconciliations may fail to confirm a pending place before it stops
 * being preferred. A count as well as a clock, because a card that is opened
 * and re-opened is asking the same question repeatedly and deserves the honest
 * answer sooner than the clock would give it.
 */
export const PENDING_RECONCILE_LIMIT = 3

/**
 * A place this device measured, and the state of the write for it.
 *
 * The book title and chapter label are carried so the card can render this
 * without another request — they are the reader's own, already on the page they
 * came from, and re-fetching them would be the round trip this exists to
 * survive without.
 */
export type PendingPosition = {
  schema: 1
  /** The reader's storage namespace. Never a name, an address or an id. */
  identity: string
  device: string
  sequence: number
  bookSlug: string
  bookTitle: string
  chapterSlug: string
  chapterNumber: number
  chapterLabel: string
  paragraphId: string | null
  paragraphOrdinal: number | null
  paragraphOffset?: number
  /** Epoch milliseconds, from this device's clock. Compared only with itself. */
  recordedAt: number
  /** Reconciliations that have not confirmed it. */
  attempts: number
}

/** The slice of `Storage` this module uses, so a test can pass a plain object. */
export type LocalStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & {
  readonly length?: number
  key?(index: number): string | null
}

/**
 * The browser's own storage, or null where there is none.
 *
 * Private modes, disabled site data and server rendering all end up here, and
 * all three are the same answer: there is nowhere to keep this, so keep it
 * nowhere. Every caller degrades to the server's record, which is the truth
 * anyway — nothing here is ever load-bearing for durability.
 */
export function browserStore(): LocalStore | null {
  try {
    if (typeof window === 'undefined') return null
    const store = window.localStorage
    if (!store) return null
    // Touch it: Safari's private mode only throws on use, not on access.
    const probe = '__mrj_probe__'
    store.setItem(probe, '1')
    store.removeItem(probe)
    return store
  } catch {
    return null
  }
}

function pendingKey(identity: string, bookSlug: string): string {
  return `${PENDING_PREFIX}${identity}.${bookSlug}`
}

/* ------------------------------------------------------------ the device */

function randomId(): string {
  try {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  } catch {
    // Not cryptography. It only has to be different from the other devices this
    // reader uses, and a collision costs an ordering decision, not a secret.
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 32)
      .padEnd(16, '0')
  }
}

/**
 * This browser's ordering identity, minted once and then kept.
 *
 * It names nothing and grants nothing: see `lib/reading-order.ts`. Where there
 * is no storage it is minted per page load, which costs the device its ability
 * to recognise its own older writes — the honest outcome for a browser that has
 * been told to remember nothing.
 */
export function deviceId(store: LocalStore | null = browserStore()): string {
  if (!store) return randomId()
  const existing = normalizeDeviceId(store.getItem(DEVICE_KEY))
  if (existing) return existing
  const minted = randomId()
  try {
    store.setItem(DEVICE_KEY, minted)
  } catch {
    // Full or refused: the identity is this page load's, and ordering degrades
    // to last-arrival-wins, which is where it started.
  }
  return minted
}

/**
 * The next counter for this device — strictly greater than every one before it.
 *
 * Shared across tabs through storage on purpose: two tabs of the same browser
 * are one device to the server, and a per-tab counter would have them refusing
 * each other's saves as stale.
 */
export function nextSequence(store: LocalStore | null = browserStore()): number {
  if (!store) return Date.now()
  const previous = normalizeSequence(Number(store.getItem(SEQUENCE_KEY))) ?? 0
  /*
   * The clock is a floor, never the value. It makes a counter that has been
   * cleared — site data wiped, a different profile — resume above anything the
   * server already has for this device, instead of restarting at 1 and having
   * every save refused as stale for as long as the old high-water stands.
   * It is not used to order anything: only this device's own counter is.
   */
  const next = Math.max(previous + 1, Date.now())
  try {
    store.setItem(SEQUENCE_KEY, String(next))
  } catch {
    // Unwritable storage means the floor above does the work on its own, which
    // still rises monotonically for as long as the clock does.
  }
  return next
}

/* ----------------------------------------------------------- the record */

function asPending(raw: unknown, identity: string): PendingPosition | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  if (row.schema !== 1) return null
  // The identity is checked as well as keyed, so a hand-edited or migrated key
  // cannot present one reader's place to another.
  if (row.identity !== identity) return null

  const device = normalizeDeviceId(row.device)
  const sequence = normalizeSequence(row.sequence)
  if (!device || sequence === null) return null
  if (typeof row.bookSlug !== 'string' || row.bookSlug === '') return null
  if (typeof row.chapterSlug !== 'string' || row.chapterSlug === '') return null
  if (typeof row.recordedAt !== 'number' || !Number.isFinite(row.recordedAt)) return null
  if (typeof row.paragraphId !== 'string' && row.paragraphId !== null) return null

  const attempts =
    typeof row.attempts === 'number' && Number.isFinite(row.attempts) && row.attempts > 0
      ? Math.floor(row.attempts)
      : 0

  return {
    schema: 1,
    identity,
    device,
    sequence,
    bookSlug: row.bookSlug,
    bookTitle: typeof row.bookTitle === 'string' ? row.bookTitle : '',
    chapterSlug: row.chapterSlug,
    chapterNumber:
      typeof row.chapterNumber === 'number' && Number.isFinite(row.chapterNumber)
        ? row.chapterNumber
        : 0,
    chapterLabel: typeof row.chapterLabel === 'string' ? row.chapterLabel : '',
    paragraphId: row.paragraphId,
    paragraphOrdinal:
      typeof row.paragraphOrdinal === 'number' && Number.isFinite(row.paragraphOrdinal)
        ? row.paragraphOrdinal
        : null,
    ...(typeof row.paragraphOffset === 'number' &&
    Number.isFinite(row.paragraphOffset) &&
    row.paragraphOffset > 0
      ? { paragraphOffset: Math.min(1, row.paragraphOffset) }
      : {}),
    recordedAt: row.recordedAt,
    attempts,
  }
}

export function readPending(
  identity: string,
  bookSlug: string,
  store: LocalStore | null = browserStore(),
): PendingPosition | null {
  if (!store || !identity) return null
  try {
    const raw = store.getItem(pendingKey(identity, bookSlug))
    if (raw === null) return null
    return asPending(JSON.parse(raw), identity)
  } catch {
    return null
  }
}

export function writePending(
  record: PendingPosition,
  store: LocalStore | null = browserStore(),
): void {
  if (!store || !record.identity) return
  try {
    store.setItem(pendingKey(record.identity, record.bookSlug), JSON.stringify(record))
  } catch {
    // Storage full or refused. The server write is still on its way; this was
    // only ever the shortcut that lets the next page know about it early.
  }
}

export function clearPending(
  identity: string,
  bookSlug: string,
  store: LocalStore | null = browserStore(),
): void {
  if (!store || !identity) return
  try {
    store.removeItem(pendingKey(identity, bookSlug))
  } catch {
    // Nothing to do about it, and nothing depends on it having worked: an
    // unremovable record still expires, and is still checked against identity.
  }
}

/**
 * Remove every pending place belonging to somebody else.
 *
 * Called when a reader opens their own reading. Signing out and signing in as
 * another reviewer changes the namespace, so this is what makes "ignore the
 * previous reader's place" into "the previous reader's place is not on this
 * phone any more".
 */
export function sweepForeignPending(
  identity: string,
  store: LocalStore | null = browserStore(),
): void {
  if (!store || typeof store.key !== 'function' || typeof store.length !== 'number') return
  try {
    const doomed: string[] = []
    const mine = `${PENDING_PREFIX}${identity}.`
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index)
      if (!key || !key.startsWith(PENDING_PREFIX)) continue
      if (!key.startsWith(mine)) doomed.push(key)
    }
    for (const key of doomed) store.removeItem(key)
  } catch {
    // A storage that will not be enumerated is a storage whose foreign records
    // are already unreadable here, because every read checks the identity too.
  }
}

/* -------------------------------------------------------- the decision */

export type PendingVerdict =
  /** The server has this device's save, or a newer one from it. Nothing pending. */
  | { kind: 'confirmed' }
  /** Not confirmed yet, and still within its bounds: show the local place. */
  | { kind: 'pending'; record: PendingPosition }
  /**
   * Not confirmed, and out of attempts or out of time. Show the server's record
   * and say plainly that the newer place was not saved.
   */
  | { kind: 'expired' }

/**
 * What to do with a pending place, given what the server says it holds.
 *
 * `now` and `attempts` are arguments rather than ambient so that every path
 * through this is decidable in a test without waiting for a clock.
 */
export function judgePending(
  record: PendingPosition | null,
  server: ClientPosition | null,
  now: number,
): PendingVerdict {
  if (!record) return { kind: 'confirmed' }
  if (serverHasConfirmed(server, record.device, record.sequence)) return { kind: 'confirmed' }
  if (record.attempts >= PENDING_RECONCILE_LIMIT) return { kind: 'expired' }
  if (now - record.recordedAt >= PENDING_TTL_MS) return { kind: 'expired' }
  return { kind: 'pending', record }
}

/**
 * The pending place, shaped as the position a card renders.
 *
 * Deliberately carries its own `device` and `sequence`: what the card shows and
 * what the server is being asked about are then the same claim, and a later
 * reconciliation can settle it without re-deriving anything.
 */
export function pendingAsPosition(record: PendingPosition): ClientPosition {
  return {
    bookSlug: record.bookSlug,
    bookTitle: record.bookTitle,
    chapterSlug: record.chapterSlug,
    chapterNumber: record.chapterNumber,
    chapterLabel: record.chapterLabel,
    paragraphId: record.paragraphId,
    paragraphOrdinal: record.paragraphOrdinal,
    ...(record.paragraphOffset === undefined
      ? {}
      : { paragraphOffset: record.paragraphOffset }),
    device: record.device,
    sequence: record.sequence,
    updatedAt: new Date(record.recordedAt).toISOString(),
  }
}
