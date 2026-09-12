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
/** The blockquote marker, with the single space the manuscripts put after it. */
const QUOTE_LINE = /^>\s?/

/**
 * Release state for one chapter.
 *
 * `draft` is the default for anything the manifest does not explicitly mark
 * `available`: an unreleased chapter is invisible to reviewers and unreadable
 * by direct URL until it is deliberately released. Adding an unpublished
 * chapter is therefore a content edit, never a code change.
 */
export type ChapterStatus = 'available' | 'draft'

/**
 * Who a loaded manuscript may be opened by.
 *
 * `reviewers` is the ordinary case: the book can be granted to an advance
 * reader, and Mike can read it too. `author-only` means Mike and nobody else --
 * the manuscript is loaded so that *he* can read it, and it is not offered to a
 * reviewer, not listed in a reviewer's library, not offered in the entitlement
 * controls, and refused to a reviewer session that names its slug directly.
 *
 * **This field fails closed.** A manifest that omits it, misspells it, or sets
 * it to anything this module does not recognise yields `author-only`. The
 * failure mode of a damaged manifest is therefore a book only Mike can open,
 * never a manuscript quietly widened to an audience nobody chose. A book is
 * readable by reviewers because its manifest says so in as many words.
 *
 * PERSISTENT is `author-only` because Mike has not made his line-by-line pass
 * over it. Letting reviewers in later is a deliberate edit to that book's
 * manifest -- one word -- and nothing about loading the manuscript, adding a
 * reviewer, or granting another book can cause it on its own.
 */
export type BookAudience = 'reviewers' | 'author-only'

/**
 * How a manuscript uses line breaks inside a block, which decides where one
 * paragraph ends and the next begins.
 *
 *   `hard`   The source is hard-wrapped: the lines of a block are one
 *            paragraph and are joined with a single space. This is the
 *            original behaviour and stays the default.
 *
 *   `lines`  One line is one paragraph. The source wraps nothing, so two lines
 *            in the same block are two things the author put on two lines --
 *            the fields of a record, the lines of a logbook entry -- and
 *            joining them would run them together on the page.
 *
 * It has to be declared rather than guessed, because the two conventions are
 * indistinguishable from a single block: `A\nB` is one wrapped sentence under
 * one rule and two lines under the other, and there is no way to look at it and
 * know. Guessing would mean silently reflowing somebody's manuscript.
 *
 * `The Backward Becoming` is `hard` and contains no multi-line block at all, so
 * the rule is inert for it either way. PERSISTENT is `lines`, and 21 of its
 * blocks depend on it -- the record entries, whose `Path:`, `Type:` and `Size:`
 * lines were being served as one run-on sentence before this existed.
 */
export type BookWrap = 'hard' | 'lines'

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
  audience: BookAudience
  wrap: BookWrap
  chapters: ChapterManifestEntry[]
}

/**
 * One run of a paragraph's reading text.
 *
 * `text` is always the characters a reader sees; the marks that produced them
 * are not in it. Joining every segment's `text` therefore yields exactly the
 * string a browser selection measures offsets against, which is what makes an
 * annotation's offsets mean the same thing in the browser, in a server render
 * and in a route handler.
 *
 * `strong` and `code` were added for PERSISTENT, whose manuscript uses bold
 * section labels and inline code spans. `The Backward Becoming` contains
 * neither -- no `**`, no backtick, no blockquote anywhere in its four chapters
 * -- so its parse, its paragraph ordinals and every anchor already stored
 * against it are unchanged by their existence.
 */
export type InlineSegment = {
  kind: 'text' | 'emphasis' | 'strong' | 'code'
  text: string
  /**
   * The mark this run sits *inside*, when the manuscript nested one.
   *
   * PERSISTENT does this once, in chapter two: a path set as code inside an
   * italicised sentence. Flattening it would have been easy and would have
   * rendered six characters upright in the middle of an italic line -- a small
   * wrong, but a wrong that the phrase "preserve emphasis exactly" does not
   * leave room for. One optional field keeps it right, and every run that is
   * not nested does not carry it.
   *
   * Only `code` is ever nested, and only inside `emphasis` or `strong`. Nothing
   * downstream has to understand it: offsets are measured against `text`, which
   * is unaffected either way.
   */
  within?: 'emphasis' | 'strong'
}

/**
 * How a paragraph presents itself. Styling only -- every variant is a real,
 * ordinal-bearing paragraph that can be bookmarked, highlighted and annotated
 * like any other, because a reader who cannot mark a logbook entry or a section
 * label has been given a reader with holes in it.
 *
 *   `prose`     running text.
 *   `dateline`  a chapter's opening place-and-date line: the first paragraph,
 *               and wholly one emphasised or bold run.
 *   `section`   a standalone fully-bold line inside a chapter -- a label over
 *               the passage that follows.
 *   `quote`     a line the manuscript set as a blockquote.
 *
 * Each is decided structurally, from the shape of the block alone. Nothing is
 * guessed from what a paragraph says, so no line of prose can be reclassified
 * as furniture by accident.
 */
export type ParagraphVariant = 'prose' | 'dateline' | 'section' | 'quote'

export type ProseParagraph = {
  kind: 'paragraph'
  /** Stable identifier: chapter slug plus paragraph ordinal. Feedback and bookmarks use it. */
  id: string
  ordinal: number
  variant: ParagraphVariant
  /**
   * True when this paragraph sat directly under another in the same block, with
   * no blank line between them -- the second and later lines of a record entry,
   * the continuing lines of a logbook entry. They are set close together the
   * way the manuscript sets them, rather than as separate paragraphs.
   *
   * Always false under `wrap: 'hard'`, where a block is one paragraph by
   * definition.
   */
  tight: boolean
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
  audience: BookAudience
  wrap: BookWrap
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

const CODE_SPAN = /`([^`\n]+)`/g

/**
 * The inside of an emphasised or bold run, split on any code span within it.
 *
 * `code` is the only mark these manuscripts ever nest, so this is the whole of
 * the nesting rule rather than a general recursive descent -- a parser that
 * handled marks it will never meet would be untested code guarding a case that
 * does not exist.
 */
function parseMarkedRun(text: string, mark: 'emphasis' | 'strong'): InlineSegment[] {
  const runs: InlineSegment[] = []
  let index = 0

  CODE_SPAN.lastIndex = 0
  for (let match = CODE_SPAN.exec(text); match !== null; match = CODE_SPAN.exec(text)) {
    if (match.index > index) runs.push({ kind: mark, text: text.slice(index, match.index) })
    runs.push({ kind: 'code', text: match[1], within: mark })
    index = match.index + match[0].length
  }

  if (index < text.length) runs.push({ kind: mark, text: text.slice(index) })

  return runs.length > 0 ? runs : [{ kind: mark, text }]
}

/**
 * Split paragraph text into its plain, emphasised, bold and code runs.
 *
 * Three inline marks, in one pass, longest mark first so `**bold**` is never
 * read as an empty emphasis wrapping `*bold*`:
 *
 *   `**strong**`   a bold run
 *   `*emphasis*`   an italic run
 *   `` `code` ``   a literal run, set in the monospaced face
 *
 * Everything else is literal, including the asterisk or backtick of an unpaired
 * run -- a manuscript is allowed to contain a lone asterisk, and turning one
 * into markup would be the parser editing the book.
 *
 * A code span inside an emphasised or bold run keeps both marks (see `within`
 * on `InlineSegment`). No other nesting occurs in these manuscripts, and none
 * is invented here.
 *
 * Whatever the marks, every run's `text` is the characters a reader sees, and
 * the runs concatenated are exactly the paragraph's reading text -- which is
 * what an annotation's offsets are measured against.
 */
export function parseInline(text: string): InlineSegment[] {
  const segments: InlineSegment[] = []
  // Order matters: `**` before `*`, so a bold run wins the position it starts at.
  const pattern = /\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|`([^`\n]+)`/g
  let index = 0

  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match.index > index) {
      segments.push({ kind: 'text', text: text.slice(index, match.index) })
    }

    if (match[1] !== undefined) segments.push(...parseMarkedRun(match[1], 'strong'))
    else if (match[2] !== undefined) segments.push(...parseMarkedRun(match[2], 'emphasis'))
    else segments.push({ kind: 'code', text: match[3] })

    index = match.index + match[0].length
  }

  if (index < text.length) {
    segments.push({ kind: 'text', text: text.slice(index) })
  }

  return segments.length > 0 ? segments : [{ kind: 'text', text }]
}

/** True when a paragraph is wholly one run of the given kind -- a label, not prose. */
function isWholly(segments: InlineSegment[], kind: InlineSegment['kind']): boolean {
  return segments.length === 1 && segments[0].kind === kind
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

function parseChapter(
  entry: ChapterManifestEntry,
  payload: string,
  wrap: BookWrap,
): ReaderChapter {
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

  /**
   * One paragraph, counted and pushed. Every variant goes through here, so
   * every variant gets an ordinal and an id -- there is no second, unmarkable
   * class of text on the page.
   */
  const push = (text: string, variant: ParagraphVariant, tight: boolean): void => {
    ordinal += 1
    words += wordCount(text)
    const segments = parseInline(text)
    readerBlocks.push({
      kind: 'paragraph',
      id: paragraphId(entry.slug, ordinal),
      ordinal,
      variant,
      tight,
      segments,
      text: segments.map((segment) => segment.text).join(''),
    })
  }

  for (const block of blocks.slice(1)) {
    if (block.length === 1 && SCENE_BREAK.test(block[0].trim())) {
      sceneBreaks += 1
      readerBlocks.push({ kind: 'scene-break', id: `${entry.slug}-s${sceneBreaks}` })
      continue
    }

    /*
     * A blockquote. Each of its lines is one paragraph, because one line here
     * is one logical line -- a logbook entry, a post, a line of a letter -- and
     * joining them would merge things the author set apart. A `>`-only line is
     * the quote's own blank line: it ends the tight run and is not a paragraph.
     */
    if (QUOTE_LINE.test(block[0])) {
      let previous = false
      for (const line of block) {
        const content = line.replace(QUOTE_LINE, '').trim()
        if (content === '') {
          previous = false
          continue
        }
        push(content, 'quote', previous)
        previous = true
      }
      continue
    }

    /*
     * Everything else. Under `hard` the block is one paragraph; under `lines`
     * each line is its own, and every line after the first is `tight` so a
     * record entry still reads as one entry.
     */
    const texts = wrap === 'lines' ? block.map((line) => line.trim()) : [block.join(' ').trim()]

    texts.forEach((text, index) => {
      if (text === '') return
      const segments = parseInline(text)

      const variant: ParagraphVariant =
        ordinal === 0 && (isWholly(segments, 'emphasis') || isWholly(segments, 'strong'))
          ? 'dateline'
          : isWholly(segments, 'strong')
            ? 'section'
            : 'prose'

      push(text, variant, index > 0)
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
    // Fail closed: only the literal string opens a book to reviewers.
    audience: source.audience === 'reviewers' ? 'reviewers' : 'author-only',
    // The original behaviour is the default, so an existing manifest is unchanged.
    wrap: source.wrap === 'lines' ? 'lines' : 'hard',
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

/**
 * The books a reviewer may be offered at all: loaded, and not author-only.
 *
 * This is the list the entitlement controls are built from and the list a
 * reviewer's live entitlements are intersected with. A book missing from it
 * cannot be granted, cannot be listed, and cannot be reached -- and because
 * `audience` fails closed (see `BookAudience`), a book is on it only when its
 * own manifest says `"audience": "reviewers"` in as many words.
 */
export function reviewerReadableBookSlugs(): string[] {
  return listBookSlugs().filter((slug) => findBook(slug)?.audience === 'reviewers')
}

/** True when this book is loaded for Mike alone. Unknown books answer true. */
export function isAuthorOnlyBook(bookSlug: string): boolean {
  return findBook(bookSlug)?.audience !== 'reviewers'
}

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
    parseChapter(entry, readChapterPayload(bookSlug, entry), manifest.wrap),
  )

  const book: ReaderBook = {
    slug: manifest.slug,
    title: manifest.title,
    author: manifest.author,
    subtitle: manifest.subtitle,
    audience: manifest.audience,
    wrap: manifest.wrap,
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
