/**
 * How two claims about "where I stopped reading" are ordered.
 *
 * A reading position is the one record in this product that several devices
 * write to continuously, without coordinating, over connections that reorder
 * and retry. Two facts follow from that, and everything in this module is one
 * of the two:
 *
 *   **A device can order its own writes.** It knows which of its own saves it
 *   made first, so it stamps each one with a counter that only ever goes up.
 *   The server keeps the highest counter it has seen from that device and
 *   refuses anything at or below it -- which is precisely the delayed request
 *   arriving after a newer one, and nothing else.
 *
 *   **Two devices cannot order each other's writes.** Their counters are
 *   unrelated integers; comparing them would be comparing the number of times
 *   one phone has scrolled with the number of times a laptop has. There is no
 *   clock to fall back on either: device clocks disagree, and a phone whose
 *   time is a day fast would pin a reader's place forever. So across devices
 *   the rule stays what it already was -- **the last write to arrive wins** --
 *   and this module is careful never to compare across devices at all.
 *
 * ## The device identifier is not identity
 *
 * It is random, minted in the browser, carries nothing about the person, and
 * authorizes nothing. Every request that bears one is already authenticated by
 * the reviewer's signed cookie and re-checked against the roster; the
 * identifier is read *after* that, and only to decide which of two positions is
 * newer. A forged or copied identifier can therefore do exactly one thing:
 * make that reader's own place ordering wrong for that reader. It can never
 * reach another person's record, because the path to it is never built from
 * anything a request supplies.
 *
 * ## Bounded, because a reader keeps reading
 *
 * The per-device high-water marks live on the position record itself, which is
 * rewritten on every save. Left unbounded it would grow by one entry per
 * browser profile forever. `MAX_TRACKED_DEVICES` caps it, oldest first, and the
 * device that wrote the position currently on record is always the most
 * recently touched entry -- so it is the last one that can ever be dropped.
 *
 * This module is pure: no Node builtins, no browser globals, no imports. The
 * server enforces the rules and the browser predicts them, and they must not be
 * able to disagree about what they are.
 */

/** How many devices' high-water marks one position record keeps. */
export const MAX_TRACKED_DEVICES = 8

/**
 * What a device identifier may look like.
 *
 * Lower-case alphanumeric, bounded at both ends. The browser mints 32 hex
 * characters; the pattern is a little wider so a future minting scheme is not a
 * storage migration, and a lot narrower than "any string" so a record cannot be
 * inflated by one.
 */
export const DEVICE_ID_PATTERN = /^[a-z0-9]{8,64}$/

/** One device, and the newest sequence the server has accepted from it. */
export type DeviceSequence = {
  id: string
  seq: number
}

/** A device identifier, or null when there is not a usable one. */
export function normalizeDeviceId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const id = raw.trim().toLowerCase()
  return DEVICE_ID_PATTERN.test(id) ? id : null
}

/**
 * A sequence number, or null when there is not a usable one.
 *
 * Positive integers only. Zero is excluded so that "no sequence" and "the
 * first sequence" can never be confused by a falsy check, and the ceiling is
 * the largest integer JavaScript can compare reliably -- past it, `>=` stops
 * meaning what this module needs it to mean.
 */
export function normalizeSequence(raw: unknown): number | null {
  if (typeof raw !== 'number') return null
  if (!Number.isSafeInteger(raw)) return null
  if (raw <= 0) return null
  return raw
}

/**
 * The stored high-water list, cleaned.
 *
 * An array rather than an object on purpose: object key order is only insertion
 * order for keys that do not look like array indices, and a random identifier
 * can come out all digits. Recency is load-bearing here, so it is carried by
 * something that cannot silently reorder itself.
 *
 * Returns `undefined` when the field is absent, which is what every record
 * written before this existed looks like. A malformed field is treated as
 * absent rather than as a reason to reject the record: a reader's place must
 * not be lost because the ordering metadata beside it was damaged.
 */
export function normalizeDeviceList(raw: unknown): DeviceSequence[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) return undefined

  const seen = new Set<string>()
  const rows: DeviceSequence[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const id = normalizeDeviceId((entry as Record<string, unknown>).id)
    const seq = normalizeSequence((entry as Record<string, unknown>).seq)
    if (!id || seq === null) continue
    if (seen.has(id)) continue
    seen.add(id)
    rows.push({ id, seq })
  }

  if (rows.length === 0) return undefined
  return rows.slice(-MAX_TRACKED_DEVICES)
}

/** The newest sequence recorded for one device, or null if it has none. */
export function highWaterFor(
  devices: readonly DeviceSequence[] | undefined,
  device: string,
): number | null {
  if (!devices) return null
  for (const row of devices) {
    if (row.id === device) return row.seq
  }
  return null
}

/**
 * Whether an incoming save is one this device has already been overtaken by.
 *
 * **Only ever consults the incoming device's own history.** A sequence from
 * another device is not looked at, let alone compared: that is the whole point.
 * A save with no device metadata is never stale, because there is nothing to
 * order it against and refusing it would silently drop the place of any client
 * that predates this.
 */
export function isStaleSequence(
  devices: readonly DeviceSequence[] | undefined,
  device: string | null,
  sequence: number | null,
): boolean {
  if (!device || sequence === null) return false
  const high = highWaterFor(devices, device)
  if (high === null) return false
  return sequence <= high
}

/**
 * The high-water list after accepting `sequence` from `device`.
 *
 * Every other device's mark is carried through untouched -- the server has to
 * remember them all, not only the one that happens to hold the position at the
 * moment, or an old request from a device that lost a race would be accepted a
 * second time. The accepted device moves to the end, so the bounded list sheds
 * the least recently active first and never the one on record.
 */
export function mergeDeviceSequence(
  devices: readonly DeviceSequence[] | undefined,
  device: string,
  sequence: number,
): DeviceSequence[] {
  const kept = (devices ?? []).filter((row) => row.id !== device)
  kept.push({ id: device, seq: sequence })
  return kept.slice(-MAX_TRACKED_DEVICES)
}

/** The shape this module needs of a stored position. Nothing more. */
export type OrderedPosition = {
  device?: string
  sequence?: number
  devices?: DeviceSequence[]
}

/**
 * Whether the server is known to hold this device's save, or something newer
 * from the same device.
 *
 * This is the question a browser asks about its own unconfirmed write, and the
 * only honest evidence for it is the device's own high-water mark. The record's
 * `device`/`sequence` are checked as well, for the one case the list cannot
 * cover: a device pushed out of the bounded list by eight others while still
 * holding the position.
 *
 * A position written by *another* device says nothing either way, and is not
 * treated as saying anything: no sequence is compared across devices here.
 */
export function serverHasConfirmed(
  position: OrderedPosition | null | undefined,
  device: string,
  sequence: number,
): boolean {
  if (!position) return false
  const high = highWaterFor(position.devices, device)
  if (high !== null && high >= sequence) return true
  if (position.device === device && typeof position.sequence === 'number') {
    return position.sequence >= sequence
  }
  return false
}
