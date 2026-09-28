/**
 * What a stored reviewer comment row **is**, decided in one place.
 *
 * Every feedback reader -- the filesystem driver, the Blob driver, and the Blob
 * driver over an in-memory backend in the tests -- hands rows to the same
 * consumers: the reviewer's own reader, the author source, the dashboard and
 * the export. Those consumers render and attribute these fields directly. Two
 * readers that disagree about what a row is are therefore two different
 * contracts behind one interface, and that is exactly what this replaced: the
 * Blob driver validated every field, and the filesystem driver cast a parsed
 * line to `FeedbackEntry` and hoped. A line holding only a reviewer, a book and
 * a comment was emitted as a complete row with no id, no timestamp, no scope
 * and no chapter, and the listing called itself complete.
 *
 * The partition this draws:
 *
 *   **a row** -- an object with `schema: 1` and every field of
 *   `FeedbackEntry` present with its declared type. It is returned as is.
 *
 *   **not a row** -- anything else that parsed: an array, a scalar, `null`,
 *   an object with a different schema, a missing field, a field of the wrong
 *   type, an empty id or comment, an unparseable timestamp, a reviewer
 *   identity outside the reviewer-id domain. The caller skips it and **marks
 *   its listing incomplete**; it never emits it.
 *
 * The reviewer identity is judged against the same domain every writer
 * enforces (`lib/reviewer-roster.ts`, `lib/reviewer-access.ts`,
 * `lib/reviewer-feedback-blob.ts`), not merely "is a string". A row attributed
 * to `""` or to any other identity no reviewer can hold is damage, not another
 * reviewer's row: the filesystem driver filters another reviewer's rows out of
 * a shared per-book file in silence, so an identity it could not have written
 * must be refused here, or the row vanishes and the listing still calls itself
 * complete -- and the export stamps the shortened packet.
 *
 * Imported by both drivers, and importing nothing at runtime itself, so the
 * type-only direction between `reviewer-feedback.ts` and
 * `reviewer-feedback-blob.ts` stays free of a cycle.
 */

import type { FeedbackEntry } from './reviewer-feedback.ts'

/** The reviewer-id domain, the same literal the writer boundaries use. */
const REVIEWER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function asFeedbackEntry(value: unknown): FeedbackEntry | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>

  if (row.schema !== 1) return null
  if (typeof row.id !== 'string' || row.id === '') return null
  if (typeof row.createdAt !== 'string' || Number.isNaN(Date.parse(row.createdAt))) return null
  if (typeof row.reviewerId !== 'string' || !REVIEWER_ID_PATTERN.test(row.reviewerId)) return null
  if (typeof row.bookSlug !== 'string') return null
  if (typeof row.chapterSlug !== 'string') return null
  if (typeof row.chapterNumber !== 'number' || !Number.isFinite(row.chapterNumber)) return null
  if (row.scope !== 'paragraph' && row.scope !== 'chapter') return null
  if (typeof row.paragraphId !== 'string' && row.paragraphId !== null) return null
  if (typeof row.paragraphOrdinal !== 'number' && row.paragraphOrdinal !== null) return null
  if (typeof row.quote !== 'string' && row.quote !== null) return null
  if (typeof row.comment !== 'string' || row.comment === '') return null

  return value as FeedbackEntry
}
