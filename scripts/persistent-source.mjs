/**
 * persistent-source.mjs -- the one definition of how the locked PERSISTENT
 * manuscript becomes this site's private-book payload.
 *
 * This module contains no I/O decisions and no side effects beyond reading the
 * source file it is handed. It exists so that the *builder*
 * (`build-persistent.mjs`) and the *verifier* (`verify-persistent.mjs`) run
 * exactly the same conversion. A verifier that re-implemented the rules would
 * prove that two pieces of code agree, which is not the same as proving that
 * the payload on disk is the manuscript.
 *
 * ## The source, pinned
 *
 * `D:\MRAMSEYBUILDS\projects\persistent\Fable 5\PERSISTENT-locked.md`
 *   252,756 bytes
 *   29 `## Chapter` headings
 *   SHA-256 ea63958af036b343647379ede09985a7b4285c5e0f4885912ae7bf052b14aa28
 *
 * The source is read and never written. Nothing here modifies the PERSISTENT
 * project, and its project instructions are not loaded: the file is content.
 *
 * ## The normalization rules, in full
 *
 * Every transformation applied to the manuscript is listed here. There are no
 * others, and `verify-persistent.mjs` proves there are no others by
 * reconstructing the source's own prose back out of the payload and comparing
 * it to the source character for character.
 *
 *   **N1 -- Front matter is metadata, not chapter text.** Everything before the
 *   first `## Chapter` heading (`# PERSISTENT`, `*A novel*`, and one `---`)
 *   supplies the book's title and subtitle. It contributes no chapter content
 *   and appears in no chapter file.
 *
 *   **N2 -- One chapter per `## Chapter` heading.** A chapter's slice runs from
 *   its heading to the line before the next `## Chapter` heading, or to the end
 *   of the file for the last one. Chapter order is the source's order, and the
 *   heading's own words become the chapter's slug and label
 *   (`## Chapter Twenty-One` -> slug `chapter-twenty-one`, label
 *   `Chapter Twenty-One`).
 *
 *   **N3 -- The chapter's section title becomes its title.** Every slice opens
 *   with a single fully-bold line (`**RESTON**`). Its text is taken verbatim,
 *   including its capitalisation, as the chapter's `subtitle`, and the
 *   chapter's `title` is `<label> \u2014 <subtitle>`. This mirrors the site's
 *   established format, in which a chapter file opens with the one `#` heading
 *   its manifest declares.
 *
 *   **N4 -- Two rules per chapter are structural and are dropped.** The `---`
 *   that closes the chapter's header block (immediately after the section title
 *   and the dateline) and the `---` that closes the chapter (its last non-blank
 *   line) separate *chapters* in a single-file manuscript. In a file-per-chapter
 *   payload the file boundary already says that, so those two -- and only those
 *   two -- are dropped. Every other `---` is a scene break inside a chapter and
 *   is kept exactly where it was. The verifier counts them: 225 rules in the
 *   source, 1 in the front matter, 58 structural (two per chapter), 166 scene
 *   breaks carried through.
 *
 *   **N5 -- Runs of blank lines collapse to one.** The source separates its
 *   blocks with one blank line 1,741 times and with two 58 times, always around
 *   a dropped structural rule. A blank line is a block separator in this
 *   format, so one and two mean the same thing; collapsing makes the payload
 *   canonical and changes no block boundary. Nothing else about whitespace is
 *   touched -- the source carries no trailing whitespace and no indented line.
 *
 *   **N6 -- Nothing else changes.** No character of prose, no asterisk, no
 *   backtick, no blockquote marker, no em dash, no quotation mark is added,
 *   removed, reordered, re-cased or re-wrapped. The payload's chapter bodies
 *   are the source's own lines.
 *
 * That is the complete list.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** The locked manuscript's identity. A source that does not match is refused. */
export const SOURCE = {
  path: 'D:\\MRAMSEYBUILDS\\projects\\persistent\\Fable 5\\PERSISTENT-locked.md',
  bytes: 252756,
  sha256: 'ea63958af036b343647379ede09985a7b4285c5e0f4885912ae7bf052b14aa28',
  chapterHeadings: 29,
}

export const BOOK_SLUG = 'persistent'

const WORDS = [
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen', 'twenty', 'twenty-one', 'twenty-two', 'twenty-three',
  'twenty-four', 'twenty-five', 'twenty-six', 'twenty-seven', 'twenty-eight',
  'twenty-nine',
]

const HEADING = /^## Chapter (.+)$/
const RULE = /^-{3,}$/
const BOLD_LINE = /^\*\*([^*]+)\*\*$/

export const sha256 = (input) => createHash('sha256').update(input).digest('hex')

/**
 * Read the locked source and prove it is the file this conversion was written
 * against. Every identity claim is checked; a mismatch throws rather than
 * converting something else that happens to be at that path.
 */
export function readSource(path = SOURCE.path) {
  const buffer = readFileSync(path)

  if (buffer.byteLength !== SOURCE.bytes) {
    throw new Error(
      `source is ${buffer.byteLength} bytes, expected ${SOURCE.bytes} -- refusing to convert`,
    )
  }

  const digest = sha256(buffer)
  if (digest !== SOURCE.sha256) {
    throw new Error(`source SHA-256 is ${digest}, expected ${SOURCE.sha256} -- refusing to convert`)
  }

  const text = buffer.toString('utf8')
  const headings = text.split('\n').filter((line) => HEADING.test(line)).length
  if (headings !== SOURCE.chapterHeadings) {
    throw new Error(
      `source has ${headings} chapter headings, expected ${SOURCE.chapterHeadings} -- refusing to convert`,
    )
  }

  return { buffer, text, bytes: buffer.byteLength, sha256: digest, headings }
}

/** `Twenty-One` -> `chapter-twenty-one`, checked against the ordinal it must be. */
function slugFor(words, number) {
  const expected = WORDS[number - 1]
  const slug = words.trim().toLowerCase().replace(/\s+/g, '-')
  if (slug !== expected) {
    throw new Error(`chapter ${number}: heading says "${words}", expected "${expected}"`)
  }
  return `chapter-${slug}`
}

/** N5: collapse runs of blank lines, and trim the ends. */
function collapseBlanks(lines) {
  const out = []
  for (const line of lines) {
    if (line.trim() === '' && out.length > 0 && out[out.length - 1].trim() === '') continue
    out.push(line)
  }
  while (out.length > 0 && out[0].trim() === '') out.shift()
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  return out
}

/**
 * Convert the locked source into the payload this site stores.
 *
 * Returns the 29 chapters, each with the exact file text that belongs on disk,
 * plus the counts the verifier asserts against.
 */
export function convert(text) {
  const lines = text.split('\n')

  const starts = []
  lines.forEach((line, index) => {
    if (HEADING.test(line)) starts.push(index)
  })

  const frontMatter = lines.slice(0, starts[0])
  const chapters = []
  let structuralRules = 0
  let sceneBreaks = 0

  starts.forEach((start, position) => {
    const number = position + 1
    const end = position + 1 < starts.length ? starts[position + 1] : lines.length
    const slug = slugFor(lines[start].match(HEADING)[1], number)

    // N3: the slice's first non-blank line is the chapter's section title.
    const body = collapseBlanks(lines.slice(start + 1, end))

    const titleMatch = body[0] === undefined ? null : BOLD_LINE.exec(body[0])
    if (!titleMatch) {
      throw new Error(`${slug}: slice does not open with a bold section title`)
    }
    const subtitle = titleMatch[1]

    /*
     * N4. After `collapseBlanks` the slice's shape is exactly:
     *
     *   0  **SECTION TITLE**      -> the chapter's subtitle (N3)
     *   1  (blank)
     *   2  **Dateline**           -> kept, as the chapter's first paragraph
     *   3  (blank)
     *   4  ---                    -> the header rule, structural, dropped
     *   5  (blank)
     *   6.. the body
     *   n  ---                    -> the closing rule, structural, dropped
     *
     * Each of those positions is asserted rather than assumed, so a source
     * whose shape differs stops the conversion instead of being reinterpreted.
     */
    if (!BOLD_LINE.test(body[2] ?? '')) {
      throw new Error(`${slug}: no dateline follows the section title`)
    }
    if (body[1] !== '' || body[3] !== '' || !RULE.test(body[4] ?? '') || body[5] !== '') {
      throw new Error(`${slug}: the header rule is not where the format puts it`)
    }
    if (!RULE.test(body[body.length - 1] ?? '')) {
      throw new Error(`${slug}: the slice does not end with its closing rule`)
    }
    structuralRules += 2

    // The dateline, then everything from the body's first line to the line
    // before the closing rule. N6: verbatim.
    const kept = collapseBlanks([body[2], '', ...body.slice(6, body.length - 1)])
    sceneBreaks += kept.filter((line) => RULE.test(line)).length

    const title = `${`Chapter ${lines[start].match(HEADING)[1]}`} \u2014 ${subtitle}`
    const file = `# ${title}\n\n${kept.join('\n')}\n`

    chapters.push({
      slug,
      number,
      title,
      label: `Chapter ${lines[start].match(HEADING)[1]}`,
      subtitle,
      file: `chapters/${slug}.md`,
      text: file,
      buffer: Buffer.from(file, 'utf8'),
      status: 'available',
    })
  })

  // N1: `# PERSISTENT`, `*A novel*`, and one structural rule.
  const front = collapseBlanks(frontMatter).filter((line) => line.trim() !== '')
  if (!/^#\s+\S/.test(front[0] ?? '') || !/^\*[^*]+\*$/.test(front[1] ?? '')) {
    throw new Error('front matter is not a title followed by a subtitle')
  }
  const bookTitle = front[0].replace(/^#\s+/, '')
  const bookSubtitle = front[1].replace(/^\*(.*)\*$/, '$1')

  return {
    slug: BOOK_SLUG,
    title: bookTitle,
    subtitle: bookSubtitle,
    chapters,
    counts: {
      chapters: chapters.length,
      rulesInSource: lines.filter((line) => RULE.test(line)).length,
      rulesInFrontMatter: frontMatter.filter((line) => RULE.test(line)).length,
      structuralRules,
      sceneBreaks,
    },
  }
}

/** The manifest the site reads, built from the conversion. */
export function manifestFor(converted, author) {
  const chapters = converted.chapters.map((chapter) => ({
    slug: chapter.slug,
    number: chapter.number,
    title: chapter.title,
    label: chapter.label,
    subtitle: chapter.subtitle,
    file: chapter.file,
    bytes: chapter.buffer.byteLength,
    sha256: sha256(chapter.buffer),
    status: chapter.status,
  }))

  const combined = Buffer.concat(converted.chapters.map((chapter) => chapter.buffer))

  return {
    slug: converted.slug,
    title: converted.title,
    author,
    subtitle: converted.subtitle,
    /*
     * Author-only. PERSISTENT has not had its line-by-line pass, so it is
     * loaded for Mike and for nobody else: it is never listed to a reviewer,
     * never offered in the entitlement controls, and refused to a reviewer
     * session even when the slug is guessed. `lib/manuscript.ts` defaults this
     * field to `author-only` when it is absent or unrecognised, so the failure
     * mode of a malformed manifest is a book nobody but Mike can open.
     */
    audience: 'author-only',
    /*
     * One line is one paragraph. This manuscript wraps nothing -- every prose
     * paragraph is a single long line -- so two lines in the same block are two
     * things the author put on two lines: the `Path:`, `Type:` and `Size:`
     * fields of a record entry, the lines of a logbook entry. Joining them, as
     * a hard-wrapped manuscript's lines are joined, ran them together into one
     * sentence on the page. 21 blocks depend on this.
     */
    wrap: 'lines',
    source: {
      name: 'PERSISTENT-locked.md',
      bytes: SOURCE.bytes,
      sha256: SOURCE.sha256,
      chapterHeadings: SOURCE.chapterHeadings,
    },
    chapters,
    combinedBytes: combined.byteLength,
    combinedSha256: sha256(combined),
  }
}
