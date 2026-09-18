/**
 * The author's feedback packet: one model, two renderings, no model involved.
 *
 * ## What this is
 *
 * Mike asks for what reviewers have told him about a book, and gets a complete,
 * portable record of it -- machine-readable JSON and readable Markdown, both
 * generated on demand from the **same** normalized model, so the two can never
 * come to say different things. Nothing is emailed, uploaded, persisted, cached
 * or stored: a packet is produced, returned, and forgotten by this process.
 *
 * `scripts/export-feedback.mjs` is a different thing entirely and is not
 * involved: it is the raw Blob migration utility for the retired comment store.
 * This is the author's packet.
 *
 * ## No model, no key, no prompt
 *
 * The AI revision-brief decision is explicit that the export path stands alone,
 * and it does: there is no Gemini call here, no API key read, no prompt built,
 * no background job queued and no manuscript rewritten. A packet is a
 * rearrangement of records this deployment already holds. Whatever Mike later
 * chooses to do with a file he has downloaded is his business and happens
 * somewhere else.
 *
 * ## Refusal is a first-class outcome
 *
 * A packet says "this is what was said about your book". Saying that when one
 * of the sources did not answer is a lie of exactly the kind the rest of this
 * codebase spends its comments refusing to tell, so the whole export refuses
 * when **any** required source is unreadable or incomplete -- the feedback
 * source, or Mike's own triage metadata. There is no partial packet, no
 * "generated with warnings", and no flag a caller can pass to get one anyway.
 *
 * ## What determinism means here, exactly
 *
 * Given identical source records, identical options and an identical injected
 * generation time, each rendering is **byte-identical** across runs. That needs
 * four separate things to be pinned, and each is pinned in one place below:
 *
 *   **Schema.** `EXPORT_SCHEMA_VERSION`, on the packet, so a later shape is a
 *   new version rather than a quiet reinterpretation.
 *
 *   **Item order.** The source's own total order (`sortAuthorItems`), which is
 *   computed from each row and never from which read finished first.
 *
 *   **Object keys and newlines.** Every object in the JSON is built by an
 *   explicit constructor below, in declaration order, and serialized with
 *   `JSON.stringify(..., 2)` plus one trailing newline. No object is spread
 *   from a source row, so no field can arrive in an order that depends on how
 *   it was parsed, and no unexpected field can arrive at all.
 *
 *   **Markdown delimiters.** Every piece of contained text is written inside a
 *   fence computed from that text -- see `fenceFor` -- so a reviewer who writes
 *   three backticks, or thirty, cannot close the block they are inside and
 *   cannot make the rest of the packet render as their own words.
 *
 * ## Pseudonyms
 *
 * By default a packet names nobody. Each reviewer that appears gets an index
 * assigned **from the item order** -- first appearance is 1, and so on -- and is
 * called "Reviewer 1". That is a per-packet label, not a hash and not a
 * reversible encoding of anything: two packets over different item sets may
 * label the same person differently, which is the point. A hash would be a
 * stable identifier by another name.
 *
 * An explicit option asks for the roster's display names instead. Neither mode
 * puts an email address, the underlying reviewer id, an access code, a token, a
 * credential, a storage path, a reading position or any private material into
 * the model -- the model has no field for any of them, and
 * `tests/author-export.test.ts` scans both renderings for each one.
 */

import {
  loadAuthorFeedbackSource,
  type AuthorFeedbackItem,
  type AuthorFeedbackSource,
  type AuthorSourceFailure,
} from './author-feedback-source.ts'
import {
  UNTOUCHED,
  isNewSince,
  itemMetadata,
  loadAuthorMetadata,
  recordItemsExported,
  type AuthorMetadata,
} from './author-metadata.ts'
import type { Viewer } from './reading-access.ts'

if (typeof window !== 'undefined') {
  throw new Error(
    'lib/author-export is server-only and must not be imported by a client component',
  )
}

/** The packet's shape version. A later shape is a new number, never a reread. */
export const EXPORT_SCHEMA_VERSION = 1

/** How a packet names the people in it. */
export type ExportNaming = 'pseudonym' | 'display-name'

export type ExportOptions = {
  /** Default `pseudonym`. `display-name` is an explicit choice of Mike's. */
  naming?: ExportNaming
  /** Restrict to these books. Omitted means every book he can open. */
  bookSlugs?: readonly string[]
}

/** One row of a packet. Every field is written by `packetItem` and no other. */
export type ExportItem = {
  itemId: string
  kind: AuthorFeedbackItem['kind']
  /** `reviewer`, `author`, or null for a withdrawal, which names nobody. */
  originator: AuthorFeedbackItem['originator']
  /** "Reviewer 1", a display name, "Mike", or null. Never an id. */
  attribution: string | null
  bookSlug: string
  bookTitle: string
  scope: string
  chapterNumber: number | null
  chapterLabel: string | null
  paragraphOrdinal: number | null
  /** The captured quotation or paragraph, exactly as it was saved. */
  captured: string | null
  /** What was written. Null for a withdrawal and a wordless highlight. */
  text: string | null
  revision: number | null
  anchorState: string
  manuscriptChanged: boolean | null
  createdAt: string | null
  updatedAt: string | null
  withdrawnAt: string | null
  /** Mike's own open/resolved on his own notes. */
  authorNoteStatus: string | null
  /** Mike's triage of reviewer feedback: reversible, and separate from New. */
  resolved: boolean
  /** New relative to when he last explicitly opened it. */
  isNew: boolean
  /**
   * When this item last left in a packet, **as at generation**.
   *
   * Deliberately not this packet's own time. A row claiming to have been
   * exported at the instant it is being exported would be a record of this
   * export written inside this export, which is circular and useless; the
   * stamp for this packet is written afterwards, by `recordItemsExported`.
   */
  lastExportedAt: string | null
}

export type ExportPacket = {
  schema: number
  /** The time the caller supplied. Injected so a packet is reproducible. */
  generatedAt: string
  naming: ExportNaming
  books: { slug: string; title: string }[]
  items: ExportItem[]
}

/** Why an export could not be produced. */
export type ExportFailure =
  | 'forbidden'
  | 'incomplete-source'
  | 'metadata-unreadable'
  | 'storage-unavailable'

export type ExportRefusal = {
  ok: false
  reason: ExportFailure
  /** Which sources failed, by name. Safe to print: see `AuthorSourceFailure`. */
  failures: AuthorSourceFailure[]
}

/**
 * A packet that was generated, both renderings, and what became of the stamp.
 *
 * `stamped` is reported rather than folded into success or failure because the
 * two are genuinely different events. The export **succeeded**: the complete
 * packet and both renderings were generated and are being returned, which is
 * the definition this package works to. The stamp is bookkeeping that happens
 * afterwards, and a stamp that did not land means Mike's `lastExportedAt` is
 * older than the truth -- it never means the packet is short, wrong or partial.
 */
export type ExportSuccess = {
  ok: true
  packet: ExportPacket
  json: string
  markdown: string
  /** The item ids this packet contained, in packet order. */
  itemIds: string[]
  /**
   * Requested books the manifest does not hold, in the order they were asked
   * for. Empty when every requested book was found.
   *
   * A requested book that does not exist is a legitimate local answer and not a
   * failure -- the source says so, and this carries that answer out to the
   * caller instead of discarding it. Without it, a saved view naming a book
   * that has since been unloaded would produce a smaller packet with nothing
   * anywhere to say a book was missing, which reads exactly like a book that
   * nobody has written about.
   *
   * It is deliberately **not** in the packet. The packet's bytes are the
   * determinism surface, and what it contains is decided by the books that were
   * found; a book that was not found put nothing in it.
   */
  notFound: string[]
  /**
   * Whether the `lastExportedAt` stamp landed for **every** item in the packet.
   *
   * `recorded` is the whole-packet claim and nothing weaker: if any book's
   * write failed, or any packet item was not covered by a write that succeeded,
   * this is `not-recorded`. A partial stamp reported as `recorded` would leave
   * some items claiming they left in a packet and others, from the same packet,
   * claiming they never had.
   *
   * "Every item" means every `(bookSlug, itemId)` coordinate the packet holds,
   * not every bare id: see `stampCoordinate`.
   */
  stamped: 'recorded' | 'not-recorded'
}

export type ExportOutcome = ExportSuccess | ExportRefusal

/* ------------------------------------------------------------ the pseudonyms */

/**
 * Assign each reviewer a packet-local index, from the item order.
 *
 * First appearance in the ordered items is 1. Nothing about the reviewer
 * themselves enters the number: not their id, not a hash of it, not a sort of
 * their names. Two packets over different sets of items may number the same
 * person differently, and that is the property that makes this a label rather
 * than an identifier.
 */
export function assignPseudonyms(items: readonly AuthorFeedbackItem[]): Map<string, number> {
  const indexes = new Map<string, number>()
  for (const item of items) {
    if (item.originator !== 'reviewer') continue
    if (item.reviewerId === null) continue
    if (!indexes.has(item.reviewerId)) indexes.set(item.reviewerId, indexes.size + 1)
  }
  return indexes
}

/**
 * What one row is called in a packet.
 *
 * Mike's own notes are "Mike"; a withdrawal names nobody and is null. A
 * reviewer is their index or, when Mike asked for it, the roster's display
 * name -- falling back to the index when the roster could not name them, rather
 * than to the identifier, because the identifier is exactly what neither mode
 * may print.
 */
function attributionFor(
  item: AuthorFeedbackItem,
  naming: ExportNaming,
  indexes: Map<string, number>,
): string | null {
  if (item.originator === 'author') return 'Mike'
  if (item.originator !== 'reviewer' || item.reviewerId === null) return null
  const index = indexes.get(item.reviewerId)
  const pseudonym = index === undefined ? 'Reviewer' : `Reviewer ${index}`
  if (naming !== 'display-name') return pseudonym
  return item.reviewerName ?? pseudonym
}

/* ---------------------------------------------------------------- the model */

/**
 * One packet row, field by field, in this fixed order and no other.
 *
 * `metadata` is **this item's own book's** document, or null when that book has
 * no document yet. Nothing else may be passed: an item's triage lives in the
 * document stored under the book the item belongs to, and reading it from any
 * other book's document would let an entry written about one book decide what a
 * different book's item says. A null document is not a guess -- a book nobody
 * has triaged genuinely has no entries, which is what `UNTOUCHED` states.
 */
function packetItem(
  item: AuthorFeedbackItem,
  metadata: AuthorMetadata | null,
  naming: ExportNaming,
  indexes: Map<string, number>,
): ExportItem {
  const entry = metadata === null ? UNTOUCHED : itemMetadata(metadata, item.itemId)
  return {
    itemId: item.itemId,
    kind: item.kind,
    originator: item.originator,
    attribution: attributionFor(item, naming, indexes),
    bookSlug: item.bookSlug,
    bookTitle: item.bookTitle,
    scope: item.scope,
    chapterNumber: item.chapterNumber,
    chapterLabel: item.chapterLabel,
    paragraphOrdinal: item.paragraphOrdinal,
    captured: item.captured,
    text: item.body,
    revision: item.revision,
    anchorState: item.anchorState,
    manuscriptChanged: item.manuscriptChanged,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    withdrawnAt: item.withdrawnAt,
    authorNoteStatus: item.authorNoteStatus,
    resolved: entry.resolved,
    // A withdrawal has no `updatedAt`, so there is nothing for "changed since
    // you looked" to compare. It is new until he has opened it, and no longer.
    isNew: isNewSince(entry, item.updatedAt ?? item.withdrawnAt ?? ''),
    lastExportedAt: entry.lastExportedAt,
  }
}

/**
 * The key one stamp is counted under: the book **and** the item, together.
 *
 * An item id names a source kind and a source id and never a book, and the
 * storage layout scopes every item by book, so `note:x` under one book and
 * `note:x` under another are two different things that a packet can legitimately
 * hold at once. Counting stamps under the bare id let one book's successful
 * write answer for the other book's refused one, which is exactly the claim
 * `stamped: 'recorded'` must not be able to make falsely.
 *
 * The separator is injective: `bookSlug` matches a pattern with no `/` in it, so
 * the first `/` splits the key back into the pair it was built from and no two
 * distinct pairs can collide on one key.
 */
function stampCoordinate(bookSlug: string, itemId: string): string {
  return `${bookSlug}/${itemId}`
}

/**
 * Build the packet.
 *
 * Pure: it takes records, options and a time, and returns a model. It reads no
 * store, no clock and no environment, which is what makes "the same inputs
 * produce the same bytes" a thing a test can establish rather than assert.
 *
 * Metadata arrives **keyed by book slug and is never flattened**. One map entry
 * is one book's document, and an item is only ever shown the entry for its own
 * `bookSlug`. The merged map this replaced was keyed by item id alone, and
 * since an item id carries its source kind and source id but no book, an entry
 * written under one book governed an identically-named item under another.
 */
export function buildExportPacket(
  source: AuthorFeedbackSource,
  metadata: ReadonlyMap<string, AuthorMetadata>,
  options: ExportOptions,
  generatedAt: string,
): ExportPacket {
  const naming: ExportNaming = options.naming === 'display-name' ? 'display-name' : 'pseudonym'
  const indexes = assignPseudonyms(source.items)
  return {
    schema: EXPORT_SCHEMA_VERSION,
    generatedAt,
    naming,
    books: source.books.map((book) => ({ slug: book.slug, title: book.title })),
    items: source.items.map((item) =>
      packetItem(item, metadata.get(item.bookSlug) ?? null, naming, indexes),
    ),
  }
}

/* ------------------------------------------------------------- the renderers */

/**
 * The machine-readable rendering.
 *
 * `JSON.stringify` with two-space indentation and one trailing newline. Key
 * order is the construction order above, which is fixed; no object here is
 * spread from a parsed row, so no key can arrive in an order decided by the
 * bytes on disk.
 */
export function renderExportJson(packet: ExportPacket): string {
  return `${JSON.stringify(packet, null, 2)}\n`
}

/**
 * A fence long enough that the text inside cannot close it.
 *
 * CommonMark closes a fenced block on a line of **at least** as many backticks
 * as opened it, so a fence one longer than the longest run anywhere in the text
 * cannot be closed from inside -- wherever the run sits on its line, and whether
 * or not the writer meant anything by it. Three at minimum, so ordinary text
 * still looks like an ordinary code block.
 *
 * This is the whole of the escaping strategy, deliberately: nothing rewrites,
 * strips or escapes a character of what somebody wrote. A packet that altered a
 * reviewer's words to make them safe to render would be a packet that no longer
 * quotes them.
 */
export function fenceFor(text: string): string {
  let longest = 0
  let run = 0
  for (const character of text) {
    if (character === '`') {
      run += 1
      if (run > longest) longest = run
    } else {
      run = 0
    }
  }
  return '`'.repeat(Math.max(3, longest + 1))
}

/** One fenced block, opened and closed by a fence the text cannot close. */
function fenced(text: string): string[] {
  const fence = fenceFor(text)
  return [fence, ...text.split('\n'), fence]
}

/** Where a row sits, in plain language, with no invented place. */
function placeOf(item: ExportItem): string {
  if (item.scope === 'book') return 'the whole book'
  const chapter =
    item.chapterLabel ?? (item.chapterNumber === null ? 'a chapter' : `chapter ${item.chapterNumber}`)
  if (item.scope === 'chapter') return chapter
  if (item.paragraphOrdinal === null) return chapter
  return `${chapter}, paragraph ${item.paragraphOrdinal}`
}

const KIND_HEADING: Readonly<Record<string, string>> = {
  note: 'Note',
  annotation: 'Highlight',
  comment: 'Earlier submitted comment',
  withdrawal: 'Withdrawn note',
}

/**
 * The readable rendering, from the same model and nothing else.
 *
 * Lines are joined with `\n` and the document ends with exactly one, on every
 * platform: a renderer that used the host's line ending would make the same
 * packet differ between a laptop and a server, which is the determinism this
 * package promises, lost to a detail nobody would look at.
 */
export function renderExportMarkdown(packet: ExportPacket): string {
  const lines: string[] = []

  lines.push('# Feedback packet')
  lines.push('')
  lines.push(`- Generated: ${packet.generatedAt}`)
  lines.push(`- Schema: ${packet.schema}`)
  lines.push(
    `- Reviewers are named: ${packet.naming === 'display-name' ? 'by display name' : 'by packet pseudonym'}`,
  )
  lines.push(`- Items: ${packet.items.length}`)
  lines.push('')

  lines.push('## Books')
  lines.push('')
  if (packet.books.length === 0) {
    lines.push('None.')
  } else {
    for (const book of packet.books) lines.push(`- ${book.title} (${book.slug})`)
  }
  lines.push('')

  lines.push('## Items')
  lines.push('')
  if (packet.items.length === 0) lines.push('None.')

  for (const item of packet.items) {
    const heading = KIND_HEADING[item.kind] ?? 'Item'
    lines.push(`### ${heading} — ${item.itemId}`)
    lines.push('')
    lines.push(`- Book: ${item.bookTitle} (${item.bookSlug})`)
    lines.push(`- Where: ${placeOf(item)}`)
    if (item.attribution !== null) lines.push(`- From: ${item.attribution}`)
    if (item.revision !== null) lines.push(`- Revision: ${item.revision}`)
    if (item.createdAt !== null) lines.push(`- Written: ${item.createdAt}`)
    if (item.updatedAt !== null && item.updatedAt !== item.createdAt) {
      lines.push(`- Revised: ${item.updatedAt}`)
    }
    if (item.withdrawnAt !== null) lines.push(`- Withdrawn: ${item.withdrawnAt}`)
    lines.push(`- Anchor: ${item.anchorState}`)
    if (item.manuscriptChanged !== null) {
      lines.push(`- Chapter file changed since: ${item.manuscriptChanged ? 'yes' : 'no'}`)
    }
    if (item.authorNoteStatus !== null) lines.push(`- Your status: ${item.authorNoteStatus}`)
    lines.push(`- Resolved: ${item.resolved ? 'yes' : 'no'}`)
    lines.push(`- New: ${item.isNew ? 'yes' : 'no'}`)
    lines.push(`- Last exported: ${item.lastExportedAt ?? 'never'}`)
    lines.push('')

    if (item.captured !== null) {
      lines.push('About:')
      lines.push('')
      lines.push(...fenced(item.captured))
      lines.push('')
    }

    if (item.kind === 'withdrawal') {
      /*
       * The one sentence a withdrawal is allowed to say, and it says the whole
       * of what is known. There is no body to render, and none is implied: the
       * event carries nothing about what the note said, and this line must not
       * read as though something is being withheld either.
       */
      lines.push('This note was withdrawn. The record of the withdrawal does not keep what it said.')
      lines.push('')
    } else if (item.text !== null) {
      lines.push('Said:')
      lines.push('')
      lines.push(...fenced(item.text))
      lines.push('')
    } else {
      lines.push('A highlight, with nothing written about it.')
      lines.push('')
    }
  }

  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}

/* -------------------------------------------------------------- the operation */

/**
 * Generate a packet, and only then record that it happened.
 *
 * The order is fixed and is the one thing about this function that is not
 * negotiable:
 *
 *   1. read the source, and **refuse** if it is incomplete;
 *   2. read Mike's metadata, and **refuse** if it is unreadable;
 *   3. build the model;
 *   4. render JSON;
 *   5. render Markdown;
 *   6. only now, stamp `lastExportedAt` on every item the packet contained.
 *
 * Steps 1 to 5 are what "a successful export" means, and nothing is recorded
 * until all five have happened. A refusal at 1 or 2 records nothing at all --
 * no partial stamp, no "attempted" marker, no trace -- because a stamp is a
 * claim that a copy exists, and a refusal produced no copy.
 *
 * Step 6 can fail on its own, and if it does the packet is still returned with
 * `stamped: 'not-recorded'`. Discarding a packet that was successfully
 * generated because a bookkeeping write failed would throw away the thing Mike
 * asked for in order to keep a record of it tidy.
 *
 * **Nothing reviewer-owned is written by any step.** The only write in this
 * whole path is step 6, into Mike's own metadata document under his own prefix.
 * `lastReadAt` and `resolved` are not touched: exporting is not reading and is
 * not triage.
 */
export async function exportAuthorFeedback(
  viewer: Viewer,
  options: ExportOptions = {},
  generatedAt: string = new Date().toISOString(),
): Promise<ExportOutcome> {
  if (viewer.kind !== 'author') return { ok: false, reason: 'forbidden', failures: [] }

  const source = await loadAuthorFeedbackSource(viewer, options.bookSlugs)
  if (source.incomplete) {
    return { ok: false, reason: 'incomplete-source', failures: source.failures }
  }

  /*
   * One metadata document per book, and every one of them is required: a
   * packet states Mike's triage, and a book whose triage could not be read
   * would silently claim everything on it is unresolved and never exported.
   *
   * They are kept **apart, under their own book slugs**, and are never merged
   * into one map. Merging was the whole of the cross-book defect: the merge key
   * was the item id, an item id names a source kind and a source id but never a
   * book, so two books holding an entry for the same id had one silently win
   * for both.
   */
  const perBook = new Map<string, AuthorMetadata>()

  for (const book of source.books) {
    const loaded = await loadAuthorMetadata(viewer, book.slug, generatedAt)
    if (!loaded.ok) {
      if (loaded.reason === 'storage-unavailable') {
        return {
          ok: false,
          reason: 'storage-unavailable',
          failures: [{ source: 'author-metadata', bookSlug: book.slug }],
        }
      }
      return {
        ok: false,
        reason: 'metadata-unreadable',
        failures: [{ source: 'author-metadata', bookSlug: book.slug }],
      }
    }
    perBook.set(book.slug, loaded.value.metadata)
  }

  const packet = buildExportPacket(source, perBook, options, generatedAt)
  const json = renderExportJson(packet)
  const markdown = renderExportMarkdown(packet)
  const itemIds = packet.items.map((item) => item.itemId)
  const coordinates = packet.items.map((item) => stampCoordinate(item.bookSlug, item.itemId))

  /*
   * Everything above succeeded, so this export succeeded. What follows is the
   * record of it, and its failure cannot unmake what has already been produced.
   *
   * Every **coordinate** a successful write covered is collected as it goes, and
   * `recorded` is that set covering the whole packet -- not a flag that failures
   * clear. The per-book loop makes a partial landing genuinely possible: two
   * books, the first write lands, the second is refused. Deriving the answer
   * from coverage rather than from "did anything fail" means there is one thing
   * to be right about, and it is the thing `recorded` actually claims -- that
   * every item in this packet carries the stamp.
   *
   * The coordinate, rather than the bare id, is what makes that claim true of a
   * packet holding the same id under two books: the covered set is keyed by the
   * book the write went to, so a stamp that landed for one book cannot answer
   * for the same id under a book whose write was refused.
   */
  const covered = new Set<string>()

  for (const book of source.books) {
    const ids = packet.items
      .filter((item) => item.bookSlug === book.slug)
      .map((item) => item.itemId)
    if (ids.length === 0) continue
    try {
      const recorded = await recordItemsExported(viewer, book.slug, ids, generatedAt)
      // Only a write that succeeded covers anything. A refusal and a throw both
      // cover nothing, and neither needs its own flag to say so.
      if (recorded.ok) for (const id of ids) covered.add(stampCoordinate(book.slug, id))
    } catch {
      // Covered by nothing, exactly as a refusal is.
    }
  }

  const stamped: ExportSuccess['stamped'] = coordinates.every((key) => covered.has(key))
    ? 'recorded'
    : 'not-recorded'

  return { ok: true, packet, json, markdown, itemIds, notFound: [...source.notFound], stamped }
}
