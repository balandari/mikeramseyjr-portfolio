/**
 * The public bookshelf.
 *
 * This is the *public* side of the site and it is deliberately a different
 * thing from `lib/manuscript.ts`. That module loads unpublished prose for
 * signed-in reviewers; this one loads a handful of short, approved marketing
 * facts about a title -- its name, its stage, how Mike wants it described.
 * Neither module imports the other, and nothing here can reach a chapter file,
 * so the shelf growing can never widen what the public can read.
 *
 * A title is one JSON file in `content/bookshelf/`. Adding the next book is
 * writing one more file: the homepage, the shelf, `/books` and `/books/<slug>`
 * all read whatever is in the directory, so none of them has to be rebuilt or
 * edited to carry a second title.
 *
 * Every page that uses this is statically generated, so these files are read at
 * build time and never at request time.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

if (typeof window !== 'undefined') {
  throw new Error('lib/bookshelf is server-only and must not be imported by a client component')
}

const SHELF_ROOT = join(process.cwd(), 'content', 'bookshelf')

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Where a title is in its life.
 *
 * `in-progress` is the only stage the shelf currently holds. The others exist
 * so that a later title does not need a code change to describe itself -- but
 * none of them invents a date, a retailer or a review: a stage is a label, and
 * anything more specific has to be written into the file by hand.
 */
export type BookStage = 'in-progress' | 'in-revision' | 'complete' | 'published'

const STAGES: readonly BookStage[] = ['in-progress', 'in-revision', 'complete', 'published']

export type BookDetail = {
  label: string
  value: string
}

export type ShelfBook = {
  slug: string
  order: number
  featured: boolean
  title: string
  /** "Novel", "Novella", "Stories" -- what the thing is, in Mike's words. */
  kind: string
  tagline: string
  status: BookStage
  /** Short badge text, e.g. "Work in progress". */
  statusLabel: string
  /** One sentence of honest detail under the badge. */
  statusNote: string
  description: string[]
  details: BookDetail[]
  /** Whether this title is one an advance reader can be let into at /review. */
  reviewerAccess: boolean
  /**
   * Approved cover artwork, once it exists. `null` means there is none, and the
   * site renders a typographic plate (featured) or nothing (shelf, book page)
   * rather than inventing one.
   *
   * `src` is the default file; `srcSet` lists every derivative with its width
   * so the browser can pick by layout and density; `width`/`height` are the
   * intrinsic size of `src`, which the browser needs to reserve space before
   * the bytes arrive. The alt text describes the artwork as it is.
   */
  cover: {
    src: string
    alt: string
    srcSet?: string
    width?: number
    height?: number
  } | null
}

function fail(file: string, reason: string): never {
  throw new Error(`content/bookshelf/${file}: ${reason}`)
}

function requireString(file: string, value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(file, `"${field}" must be a non-empty string`)
  return value
}

function parseBook(file: string, raw: unknown): ShelfBook {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail(file, 'must contain a JSON object')
  const entry = raw as Record<string, unknown>

  const slug = requireString(file, entry.slug, 'slug')
  if (!SLUG_PATTERN.test(slug)) fail(file, `"slug" must be a lowercase slug, got ${JSON.stringify(slug)}`)
  if (`${slug}.json` !== file) fail(file, `"slug" must match the filename, got ${JSON.stringify(slug)}`)

  if (typeof entry.order !== 'number' || !Number.isFinite(entry.order)) fail(file, '"order" must be a number')

  const status = requireString(file, entry.status, 'status')
  if (!STAGES.includes(status as BookStage)) fail(file, `"status" must be one of ${STAGES.join(', ')}`)

  const description = entry.description
  if (!Array.isArray(description) || description.length === 0) {
    fail(file, '"description" must be a non-empty array of paragraphs')
  }
  const paragraphs = description.map((p, i) => requireString(file, p, `description[${i}]`))

  const rawDetails = entry.details ?? []
  if (!Array.isArray(rawDetails)) fail(file, '"details" must be an array')
  const details = rawDetails.map((d, i) => {
    if (typeof d !== 'object' || d === null) fail(file, `"details[${i}]" must be an object`)
    const detail = d as Record<string, unknown>
    return {
      label: requireString(file, detail.label, `details[${i}].label`),
      value: requireString(file, detail.value, `details[${i}].value`),
    }
  })

  let cover: ShelfBook['cover'] = null
  if (entry.cover !== null && entry.cover !== undefined) {
    if (typeof entry.cover !== 'object' || Array.isArray(entry.cover)) fail(file, '"cover" must be an object or null')
    const c = entry.cover as Record<string, unknown>
    cover = {
      src: requireString(file, c.src, 'cover.src'),
      alt: requireString(file, c.alt, 'cover.alt'),
    }
    if (c.srcSet !== undefined) cover.srcSet = requireString(file, c.srcSet, 'cover.srcSet')
    for (const dim of ['width', 'height'] as const) {
      if (c[dim] === undefined) continue
      const value = c[dim]
      if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        fail(file, `"cover.${dim}" must be a positive integer`)
      }
      cover[dim] = value
    }
  }

  return {
    slug,
    order: entry.order,
    featured: entry.featured === true,
    title: requireString(file, entry.title, 'title'),
    kind: requireString(file, entry.kind, 'kind'),
    tagline: requireString(file, entry.tagline, 'tagline'),
    status: status as BookStage,
    statusLabel: requireString(file, entry.statusLabel, 'statusLabel'),
    statusNote: requireString(file, entry.statusNote, 'statusNote'),
    description: paragraphs,
    details,
    reviewerAccess: entry.reviewerAccess === true,
    cover,
  }
}

/**
 * Every title on the shelf, in the order they should be shown.
 *
 * A malformed file throws rather than being skipped. The shelf is small and
 * hand-written, and a title quietly vanishing from the homepage because one
 * comma was wrong is a worse failure than a build that stops and says so.
 */
export function loadShelf(root: string = SHELF_ROOT): ShelfBook[] {
  let files: string[]
  try {
    files = readdirSync(root).filter((name) => name.endsWith('.json')).sort()
  } catch {
    return []
  }

  const books = files.map((file) => parseBook(file, JSON.parse(readFileSync(join(root, file), 'utf8'))))

  const seen = new Set<string>()
  for (const book of books) {
    if (seen.has(book.slug)) throw new Error(`content/bookshelf: duplicate slug ${book.slug}`)
    seen.add(book.slug)
  }

  return books.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
}

/**
 * The title to lead with.
 *
 * The first one explicitly marked `featured`, falling back to the first on the
 * shelf so that a shelf which forgets to mark one still has a front page.
 */
export function featuredBook(books: ShelfBook[]): ShelfBook | null {
  return books.find((book) => book.featured) ?? books[0] ?? null
}

export function findShelfBook(slug: string, root?: string): ShelfBook | null {
  if (!SLUG_PATTERN.test(slug)) return null
  return loadShelf(root).find((book) => book.slug === slug) ?? null
}
