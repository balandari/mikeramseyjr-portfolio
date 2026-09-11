/**
 * Manuscript loading for the private author-review reader.
 *
 * Content is the first of this feature's three separated concerns -- manuscript
 * text here, reviewer access in `lib/reviewer-access.ts`, reviewer feedback in
 * `lib/reviewer-feedback.ts`. None of the three imports another. A book can be
 * added, a chapter can be released, and a reviewer can be granted or revoked
 * without any of those actions touching the other two.
 *
 * A book is a directory under `content/books/<slug>/` holding a `book.json`
 * manifest and one Markdown file per chapter. The manifest pins each chapter's
 * exact byte count and SHA-256, and this module refuses to serve a chapter
 * whose file does not still hash to its pin. The prose is therefore verifiable
 * at rest: `npm run verify:manuscript` proves the same thing without a server,
 * and the test suite proves it again.
 *
 * Nothing here is reachable from the browser. The text lives outside `public/`,
 * is never imported by a client component, and reaches a browser only inside
 * the response to a request that has already been authorized twice.
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

if (typeof window !== 'undefined') {
  throw new Error('lib/manuscript is server-only and must not be imported by a client component')
}

/** Where books live, relative to the project root. */
const CONTENT_ROOT = join(process.cwd(), 'content', 'books')

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const SCENE_BREAK = /^-{3,}$/

/**
 * Release state for one chapter.
 *
 * `draft` is the default for anything the manifest does not explicitly mark
 * `available`: an unreleased chapter is invisible to reviewers and unreadable
 * by direct URL until it is deliberately released. Adding an unpublished
 * chapter is therefore a content edit, never a code change.
 */
export type ChapterStatus = 'available' | 'draft'

export type ChapterManifestEntry = {
  slug: string
  number: number
  title: string
  label: string
  subtitle: string
  file: string
  bytes: number
  sha256: string
  status: ChapterStatus
}

export type BookManifest = {
  slug: string
  title: string
  author: string
  subtitle: string
  chapters: ChapterManifestEntry[]
}

export type InlineSegment = {
  kind: 'text' | 'emphasis'
  text: string
}

export type ProseParagraph = {
  kind: 'paragraph'
  /** Stable identifier: chapter slug plus paragraph ordinal. Feedback and bookmarks use it. */
  id: string
  ordinal: number
  /** True for a fully italicised opening block -- a place-and-date line. Styling only. */
  dateline: boolean
  segments: InlineSegment[]
  /** The paragraph as plain text. Used server-side to quote a passage back exactly. */
  text: string
}

export type SceneBreak = {
  kind: 'scene-break'
  id: string
}

export type ReaderBlock = ProseParagraph | SceneBreak

export type ReaderChapter = {
  slug: string
  number: number
  title: string
  label: string
  subtitle: string
  status: ChapterStatus
  blocks: ReaderBlock[]
  paragraphCount: number
  /** Rough reading time in minutes, from the chapter's own word count. */
  minutes: number
  bytes: number
  sha256: string
}

export type ReaderBook = {
  slug: string
  title: string
  author: string
  subtitle: string
  chapters: ReaderChapter[]
}

/* ------------------------------------------------------------------ parsing */

/**
 * Split a payload into blocks on blank lines, joining the lines of each block
 * with a single space so a hard-wrapped paragraph is one block.
 */
function toBlocks(payload: string): string[][] {
  const blocks: string[][] = []
  let current: string[] = []

  for (const line of payload.split('\n')) {
    if (line.trim() === '') {
      if (current.length > 0) blocks.push(current)
      current = []
    } else {
      current.push(line)
    }
  }
  if (current.length > 0) blocks.push(current)

  return blocks
}

/**
 * Split paragraph text into plain and emphasised runs. A single asterisk pair
 * is the only inline mark the manuscripts use; every other character is
 * literal, including the asterisk of an unpaired run.
 */
export function parseInline(text: string): InlineSegment[] {
  const segments: InlineSegment[] = []
  const pattern = /\*([^*\n]+)\*/g
  let index = 0

  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match.index > index) {
      segments.push({ kind: 'text', text: text.slice(index, match.index) })
    }
    segments.push({ kind: 'emphasis', text: match[1] })
    index = match.index + match[0].length
  }

  if (index < text.length) {
    segments.push({ kind: 'text', text: text.slice(index) })
  }

  return segments.length > 0 ? segments : [{ kind: 'text', text }]
}

/**
 * Deterministic paragraph identifier: chapter identity plus ordinal, nothing
 * else. It is independent of how the source happens to be wrapped, because a
 * paragraph's lines are joined into one block before it is counted, and scene
 * breaks and the heading never consume an ordinal. Re-wrapping the source
 * therefore cannot renumber a paragraph and cannot detach existing feedback
 * from the passage it was written about.
 */
export function paragraphId(chapterSlug: string, ordinal: number): string {
  return `${chapterSlug}-p${String(ordinal).padStart(3, '0')}`
}

function wordCount(text: string): number {
  const trimmed = text.trim()
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length
}

function parseChapter(entry: ChapterManifestEntry, payload: string): ReaderChapter {
  const blocks = toBlocks(payload)

  const heading = blocks[0]?.[0]?.trim()
  const expectedHeading = `# ${entry.title}`
  if (heading !== expectedHeading) {
    throw new Error(
      `${entry.slug}: file does not open with the heading its manifest declares`,
    )
  }

  const readerBlocks: ReaderBlock[] = []
  let ordinal = 0
  let sceneBreaks = 0
  let words = 0

  for (const block of blocks.slice(1)) {
    if (block.length === 1 && SCENE_BREAK.test(block[0].trim())) {
      sceneBreaks += 1
      readerBlocks.push({ kind: 'scene-break', id: `${entry.slug}-s${sceneBreaks}` })
      continue
    }

    // Anything that is not a scene break is prose. These manuscripts carry no
    // other block construct, and the verifier asserts that they do not.
    const text = block.join(' ').trim()
    ordinal += 1
    words += wordCount(text)

    const segments = parseInline(text)
    const dateline =
      ordinal === 1 && segments.length === 1 && segments[0].kind === 'emphasis'

    readerBlocks.push({
      kind: 'paragraph',
      id: paragraphId(entry.slug, ordinal),
      ordinal,
      dateline,
      segments,
      text: segments.map((segment) => segment.text).join(''),
    })
  }

  return {
    slug: entry.slug,
    number: entry.number,
    title: entry.title,
    label: entry.label,
    subtitle: entry.subtitle,
    status: entry.status,
    blocks: readerBlocks,
    paragraphCount: ordinal,
    // 220 words a minute, rounded up, never reported as zero.
    minutes: Math.max(1, Math.round(words / 220)),
    bytes: entry.bytes,
    sha256: entry.sha256,
  }
}

/* ------------------------------------------------------------------ loading */

function readManifest(bookSlug: string): BookManifest {
  if (!SLUG_PATTERN.test(bookSlug)) {
    throw new Error(`invalid book slug: ${bookSlug}`)
  }

  const manifestPath = join(CONTENT_ROOT, bookSlug, 'book.json')
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown

  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`${bookSlug}: manifest is not an object`)
  }
  const source = raw as Record<string, unknown>

  if (source.slug !== bookSlug) {
    throw new Error(`${bookSlug}: manifest slug does not match its directory`)
  }
  if (!Array.isArray(source.chapters)) {
    throw new Error(`${bookSlug}: manifest has no chapters array`)
  }

  const chapters: ChapterManifestEntry[] = source.chapters.map((value, index) => {
    if (typeof value !== 'object' || value === null) {
      throw new Error(`${bookSlug}: chapter ${index} is not an object`)
    }
    const chapter = value as Record<string, unknown>

    const slug = String(chapter.slug ?? '')
    if (!SLUG_PATTERN.test(slug)) {
      throw new Error(`${bookSlug}: chapter ${index} has an invalid slug`)
    }
    const bytes = Number(chapter.bytes)
    const sha256 = String(chapter.sha256 ?? '')
    if (!Number.isInteger(bytes) || bytes <= 0) {
      throw new Error(`${bookSlug}/${slug}: manifest has no byte count`)
    }
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`${bookSlug}/${slug}: manifest has no SHA-256`)
    }

    return {
      slug,
      number: Number(chapter.number ?? index + 1),
      title: String(chapter.title ?? ''),
      label: String(chapter.label ?? ''),
      subtitle: String(chapter.subtitle ?? ''),
      file: String(chapter.file ?? ''),
      bytes,
      sha256,
      // Anything not explicitly released is a draft. Fail closed.
      status: chapter.status === 'available' ? 'available' : 'draft',
    }
  })

  return {
    slug: bookSlug,
    title: String(source.title ?? bookSlug),
    author: String(source.author ?? ''),
    subtitle: String(source.subtitle ?? ''),
    chapters: chapters.sort((a, b) => a.number - b.number),
  }
}

/**
 * Read one chapter file and prove it is the text the manifest pins.
 *
 * Both the byte count and the digest are checked, and a mismatch throws rather
 * than serving the file. That is the whole guarantee behind "the prose is
 * unaltered": a chapter that has drifted by a single byte cannot be displayed.
 */
function readChapterPayload(bookSlug: string, entry: ChapterManifestEntry): string {
  const path = join(CONTENT_ROOT, bookSlug, entry.file)
  const buffer = readFileSync(path)

  if (buffer.byteLength !== entry.bytes) {
    throw new Error(
      `${bookSlug}/${entry.slug}: expected ${entry.bytes} bytes, found ${buffer.byteLength}`,
    )
  }

  const digest = createHash('sha256').update(buffer).digest('hex')
  if (digest !== entry.sha256) {
    throw new Error(`${bookSlug}/${entry.slug}: SHA-256 does not match its manifest pin`)
  }

  return buffer.toString('utf8')
}

/**
 * Parsed books, cached per process.
 *
 * Manuscripts are immutable between deployments, so hashing and parsing them
 * once per server process is both correct and much cheaper than doing it on
 * every request.
 */
const cache = new Map<string, ReaderBook>()

/** Every book directory present on disk, in directory order. */
export function listBookSlugs(): string[] {
  if (!existsSync(CONTENT_ROOT)) return []
  return readdirSync(CONTENT_ROOT, { withFileTypes: true })
    .filter((item) => item.isDirectory() && SLUG_PATTERN.test(item.name))
    .map((item) => item.name)
    .sort()
}

/**
 * Load one book, hash-verified and parsed. Throws when the book does not exist
 * or when any chapter has drifted from its pin.
 */
export function loadBook(bookSlug: string): ReaderBook {
  const cached = cache.get(bookSlug)
  if (cached) return cached

  const manifest = readManifest(bookSlug)
  const chapters = manifest.chapters.map((entry) =>
    parseChapter(entry, readChapterPayload(bookSlug, entry)),
  )

  const book: ReaderBook = {
    slug: manifest.slug,
    title: manifest.title,
    author: manifest.author,
    subtitle: manifest.subtitle,
    chapters,
  }

  cache.set(bookSlug, book)
  return book
}

/** Load a book, or null when it is absent or unreadable. */
export function findBook(bookSlug: string): ReaderBook | null {
  if (!SLUG_PATTERN.test(bookSlug)) return null
  try {
    return loadBook(bookSlug)
  } catch {
    return null
  }
}

/**
 * The chapters a reviewer may actually open: released ones only.
 *
 * Draft chapters stay in the manifest so that an author can stage the next
 * chapter in place, but they are filtered out here, which is the single point
 * every reader surface goes through.
 */
export function releasedChapters(book: ReaderBook): ReaderChapter[] {
  return book.chapters.filter((chapter) => chapter.status === 'available')
}

/** One released chapter by slug, or null. Draft chapters resolve to null. */
export function findReleasedChapter(
  book: ReaderBook,
  chapterSlug: string,
): ReaderChapter | null {
  return releasedChapters(book).find((chapter) => chapter.slug === chapterSlug) ?? null
}

/**
 * The exact text of one paragraph, looked up server-side.
 *
 * Feedback quotes the passage it is about, and that quote is resolved here from
 * the manuscript rather than accepted from the browser. A reviewer can
 * therefore never attach a comment to a passage that does not exist, or to text
 * the book does not contain.
 */
export function findParagraph(
  chapter: ReaderChapter,
  paragraphIdentifier: string,
): ProseParagraph | null {
  for (const block of chapter.blocks) {
    if (block.kind === 'paragraph' && block.id === paragraphIdentifier) return block
  }
  return null
}
