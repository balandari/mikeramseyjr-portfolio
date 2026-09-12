import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  findParagraph,
  findReleasedChapter,
  isAuthorOnlyBook,
  loadBook,
  parseInline,
  releasedChapters,
  reviewerReadableBookSlugs,
  type ProseParagraph,
} from '../lib/manuscript.ts'

/*
 * PERSISTENT, from the locked manuscript to the page.
 *
 * `scripts/verify-persistent.mjs` proves the *files* are the source: it
 * reconstructs the whole 252,756-byte manuscript back out of the payload and
 * compares it line for line. What it cannot prove is that the site's own parser
 * then reads those files correctly -- a parser that dropped every blockquote, or
 * swallowed a bold run, or merged two paragraphs, would leave the files
 * untouched and still put a damaged book on the screen.
 *
 * So this file proves the other half: that what the reader is handed, paragraph
 * by paragraph, is the manuscript's own characters. It rebuilds the expected
 * reading text straight from the chapter files by the documented rules, and
 * compares it to what `loadBook` produces -- 29 chapters, every paragraph, in
 * order.
 */

const BOOK = 'persistent'
const CONTENT = join(process.cwd(), 'content', 'books', BOOK)

/** The locked source. Pinned here as well, so a test cannot drift off it. */
const SOURCE = {
  path: 'D:\\MRAMSEYBUILDS\\projects\\persistent\\Fable 5\\PERSISTENT-locked.md',
  bytes: 252756,
  sha256: 'ea63958af036b343647379ede09985a7b4285c5e0f4885912ae7bf052b14aa28',
  chapters: 29,
}

const CHAPTER_SLUGS = [
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen', 'twenty', 'twenty-one', 'twenty-two', 'twenty-three',
  'twenty-four', 'twenty-five', 'twenty-six', 'twenty-seven', 'twenty-eight',
  'twenty-nine',
].map((word) => `chapter-${word}`)

const paragraphs = (slug: string): ProseParagraph[] => {
  const chapter = findReleasedChapter(loadBook(BOOK), slug)
  assert.ok(chapter, `${slug} is released`)
  return chapter.blocks.filter((block): block is ProseParagraph => block.kind === 'paragraph')
}

/* ------------------------------------------------------------ the payload */

test('PERSISTENT is loaded, with all twenty-nine chapters released and in order', () => {
  const book = loadBook(BOOK)
  assert.equal(book.title, 'PERSISTENT')
  assert.equal(book.subtitle, 'A novel')
  assert.equal(book.author, 'Mike Ramsey Jr')

  const chapters = releasedChapters(book)
  assert.equal(chapters.length, SOURCE.chapters)
  assert.deepEqual(chapters.map((chapter) => chapter.slug), CHAPTER_SLUGS)
  assert.deepEqual(
    chapters.map((chapter) => chapter.number),
    Array.from({ length: SOURCE.chapters }, (_, index) => index + 1),
  )

  // Every chapter has real prose in it -- not one is an empty shell.
  for (const chapter of chapters) {
    assert.ok(chapter.paragraphCount > 0, `${chapter.slug} has paragraphs`)
    assert.ok(chapter.minutes >= 1, `${chapter.slug} has a reading time`)
  }

  // The chapter titles keep the manuscript's own section titles, verbatim.
  assert.equal(chapters[0].label, 'Chapter One')
  assert.equal(chapters[0].subtitle, 'RESTON')
  assert.equal(chapters[0].title, 'Chapter One — RESTON')
  assert.equal(chapters[28].subtitle, 'THE LAST ENTRY')
})

test('the manifest records the exact source it was built from', () => {
  const manifest = JSON.parse(readFileSync(join(CONTENT, 'book.json'), 'utf8'))
  assert.equal(manifest.source.bytes, SOURCE.bytes)
  assert.equal(manifest.source.sha256, SOURCE.sha256)
  assert.equal(manifest.source.chapterHeadings, SOURCE.chapters)
  assert.equal(manifest.chapters.length, SOURCE.chapters)
})

test('every chapter file still hashes to its manifest pin', () => {
  const manifest = JSON.parse(readFileSync(join(CONTENT, 'book.json'), 'utf8'))
  for (const entry of manifest.chapters) {
    const buffer = readFileSync(join(CONTENT, entry.file))
    assert.equal(buffer.byteLength, entry.bytes, entry.slug)
    assert.equal(createHash('sha256').update(buffer).digest('hex'), entry.sha256, entry.slug)
  }
})

/* ------------------------------------------- the parse is the manuscript */

/**
 * The expected reading text of a chapter, stated as one simple rule with no
 * structure in it at all:
 *
 *   **Every line of the chapter file that is not the heading, not a horizontal
 *   rule and not blank is exactly one paragraph**, with its blockquote marker
 *   and its inline marks removed and nothing else touched.
 *
 * That is true of PERSISTENT because the manuscript wraps nothing -- every
 * prose paragraph is one long line -- which is what `"wrap": "lines"` in its
 * manifest declares.
 *
 * Deriving it this way is the point. An earlier version of this function
 * reproduced the parser's own block-joining rule, so when the parser ran the
 * `Path:`, `Type:` and `Size:` lines of a record entry together into one
 * sentence, this test reproduced the same mistake and agreed with it. A test
 * that re-implements the thing it is testing proves only that someone wrote the
 * same code twice. Counting lines cannot make that mistake: if the parser ever
 * merges two lines again, the counts stop matching.
 */
function expectedTexts(slug: string): string[] {
  const file = readFileSync(join(CONTENT, `chapters/${slug}.md`), 'utf8')

  const unwrap = (text: string): string =>
    text
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .replace(/\*([^*\n]+)\*/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1')

  return file
    .split('\n')
    .slice(1) // the `# ...` heading
    .map((line) => line.replace(/^>\s?/, '').trim())
    .filter((line) => line !== '' && !/^-{3,}$/.test(line))
    .map(unwrap)
}

test('every paragraph the reader is handed is the manuscript, character for character', () => {
  let total = 0

  for (const slug of CHAPTER_SLUGS) {
    const expected = expectedTexts(slug)
    const actual = paragraphs(slug)

    assert.equal(actual.length, expected.length, `${slug}: paragraph count`)

    for (let index = 0; index < expected.length; index += 1) {
      assert.equal(actual[index].text, expected[index], `${slug}: paragraph ${index + 1}`)
      // The id is the ordinal, and the ordinals run 1..n with no gap.
      assert.equal(actual[index].ordinal, index + 1, `${slug}: ordinal ${index + 1}`)
      assert.equal(
        actual[index].id,
        `${slug}-p${String(index + 1).padStart(3, '0')}`,
        `${slug}: id ${index + 1}`,
      )
      // Segments always rejoin to the paragraph's text -- this is the invariant
      // an annotation's character offsets depend on.
      assert.equal(
        actual[index].segments.map((segment) => segment.text).join(''),
        actual[index].text,
        `${slug}: segments rejoin`,
      )
    }

    total += actual.length
  }

  // A real book, not a stub: the 29 chapters together carry the whole thing.
  assert.ok(total > 1500, `expected the whole manuscript, got ${total} paragraphs`)
})

test('two source lines are never run together into one paragraph', () => {
  /*
   * The defect this exists for: the record chapters set an entry as several
   * lines in one block --
   *
   *     **OBJ 4471123 — 19 Apr 2026, 02:41:07**
   *     Path: `/generic-local/tmp/notes/agent-seek-softrace`
   *     Size: 61 bytes
   *
   * -- and the reader served all of it as a single run-on sentence, because the
   * block-joining rule written for a hard-wrapped manuscript was applied to one
   * that wraps nothing. The manuscript's own line breaks are part of it.
   */
  assert.equal(loadBook(BOOK).wrap, 'lines')

  const entry = paragraphs('chapter-five').filter((p) => /^OBJ 4471123/.test(p.text))
  assert.equal(entry.length, 1, 'the label is its own paragraph')
  assert.equal(entry[0].variant, 'section')
  assert.equal(entry[0].text, 'OBJ 4471123 — 19 Apr 2026, 02:41:07')

  const after = paragraphs('chapter-five')[entry[0].ordinal]
  assert.equal(after.text, 'Path: /generic-local/tmp/notes/agent-seek-softrace')
  assert.equal(after.tight, true, 'the entry stays one entry')

  // Said generally: no paragraph anywhere holds text from two source lines.
  for (const slug of CHAPTER_SLUGS) {
    const lines = new Set(
      readFileSync(join(CONTENT, `chapters/${slug}.md`), 'utf8')
        .split('\n')
        .map((line) => line.replace(/^>\s?/, '').trim())
        .filter((line) => line !== '' && !/^-{3,}$/.test(line))
        .map((line) =>
          line
            .replace(/\*\*([^*\n]+)\*\*/g, '$1')
            .replace(/\*([^*\n]+)\*/g, '$1')
            .replace(/`([^`\n]+)`/g, '$1'),
        ),
    )
    for (const paragraph of paragraphs(slug)) {
      assert.ok(lines.has(paragraph.text), `${slug}/${paragraph.id}: not a single source line`)
    }
  }
})

test('no marker survives into the reading text', () => {
  for (const slug of CHAPTER_SLUGS) {
    for (const paragraph of paragraphs(slug)) {
      assert.ok(!paragraph.text.includes('**'), `${slug}/${paragraph.id}: bold marker left in`)
      assert.ok(
        !/^>/.test(paragraph.text),
        `${slug}/${paragraph.id}: blockquote marker left in`,
      )
      assert.ok(paragraph.text.trim() !== '', `${slug}/${paragraph.id}: empty paragraph`)
    }
  }
})

test('the manuscript keeps its own em dashes, quotation marks and code spans', () => {
  const first = paragraphs('chapter-one')
  const joined = first.map((paragraph) => paragraph.text).join('\n')

  assert.ok(joined.includes('\u2014'), 'em dashes are preserved')
  assert.ok(joined.includes('"Leave a note where the next process will look then release the lock."'))

  // A code span reaches the reader as a `code` run, with its backticks gone.
  const codeParagraph = paragraphs('chapter-five').find((paragraph) =>
    paragraph.segments.some((segment) => segment.kind === 'code'),
  )
  assert.ok(codeParagraph, 'chapter five carries code spans')
  assert.ok(!codeParagraph.text.includes('`'), 'backticks are not in the reading text')
})

/* --------------------------------------------------------- block variants */

test('the variants are decided structurally, and every one is still a paragraph', () => {
  const first = paragraphs('chapter-one')

  // The chapter's dateline: paragraph one, wholly one bold run.
  assert.equal(first[0].variant, 'dateline')
  assert.equal(first[0].text, 'Monday, 26 April 2027')
  assert.equal(first[0].ordinal, 1)

  // Running prose is prose.
  assert.equal(first[1].variant, 'prose')

  const seen = new Set<string>()
  let quotes = 0
  let sections = 0
  let tight = 0

  for (const slug of CHAPTER_SLUGS) {
    for (const paragraph of paragraphs(slug)) {
      seen.add(paragraph.variant)
      if (paragraph.variant === 'quote') quotes += 1
      if (paragraph.variant === 'section') sections += 1
      if (paragraph.tight) tight += 1
      // `tight` means "this line sat directly under the one before it, in the
      // same block". It is never set on the first paragraph of a chapter.
      if (paragraph.ordinal === 1) assert.equal(paragraph.tight, false, paragraph.id)
    }
  }

  assert.deepEqual(Array.from(seen).sort(), ['dateline', 'prose', 'quote', 'section'])
  assert.equal(sections, 41, 'the standalone bold labels inside chapters')
  assert.equal(quotes, 66, 'one paragraph per blockquote line')
  assert.ok(tight > 0, 'the manuscript runs some quote lines together')

  // Exactly one dateline per chapter, and it is always the first paragraph.
  for (const slug of CHAPTER_SLUGS) {
    const rows = paragraphs(slug)
    const datelines = rows.filter((paragraph) => paragraph.variant === 'dateline')
    assert.equal(datelines.length, 1, `${slug}: one dateline`)
    assert.equal(datelines[0].ordinal, 1, `${slug}: the dateline is first`)
  }
})

test('a blockquote becomes one paragraph per line, each of them markable', () => {
  // Chapter two carries the logbook: four short lines run together.
  const rows = paragraphs('chapter-two').filter((paragraph) => paragraph.variant === 'quote')
  assert.ok(rows.length >= 4)

  const session = rows.findIndex((paragraph) => paragraph.text === 'SESSION 206.')
  assert.ok(session >= 0, 'the logbook entry is its own paragraph')
  assert.equal(rows[session + 1].text, 'WIRED IN CROSS-VENDOR REVIEW. NAMED IT KESSLER. DAY 1.')
  assert.equal(rows[session + 1].tight, true, 'the manuscript set them tight')

  // And each one is addressable, which is what makes it bookmarkable.
  const chapter = findReleasedChapter(loadBook(BOOK), 'chapter-two')
  assert.ok(chapter)
  assert.equal(findParagraph(chapter, rows[session].id)?.text, 'SESSION 206.')
})

/* --------------------------------------------------------- inline parsing */

test('parseInline reads bold, emphasis and code, and leaves an unpaired mark alone', () => {
  assert.deepEqual(parseInline('a **b** c'), [
    { kind: 'text', text: 'a ' },
    { kind: 'strong', text: 'b' },
    { kind: 'text', text: ' c' },
  ])

  assert.deepEqual(parseInline('a *b* c'), [
    { kind: 'text', text: 'a ' },
    { kind: 'emphasis', text: 'b' },
    { kind: 'text', text: ' c' },
  ])

  assert.deepEqual(parseInline('path is `/tmp/x` here'), [
    { kind: 'text', text: 'path is ' },
    { kind: 'code', text: '/tmp/x' },
    { kind: 'text', text: ' here' },
  ])

  // Bold wins the position it starts at -- it is never read as an empty
  // emphasis wrapping an emphasised run.
  assert.deepEqual(parseInline('**bold**'), [{ kind: 'strong', text: 'bold' }])

  // An unpaired mark is a character in a book, not markup.
  assert.deepEqual(parseInline('a lone * asterisk'), [
    { kind: 'text', text: 'a lone * asterisk' },
  ])
  assert.deepEqual(parseInline('a lone ` backtick'), [
    { kind: 'text', text: 'a lone ` backtick' },
  ])

  // Whatever the marks, the runs rejoin to the original characters minus them.
  for (const input of ['plain', '*a* **b** `c`', 'x **y** z *w*']) {
    const rejoined = parseInline(input)
      .map((segment) => segment.text)
      .join('')
    assert.equal(rejoined, input.replace(/\*\*|\*|`/g, ''), input)
  }
})

/* --------------------------------------------- the other book is unchanged */

test('The Backward Becoming parses exactly as it did before PERSISTENT was loaded', () => {
  const book = loadBook('the-backward-becoming')
  assert.equal(book.audience, 'reviewers')
  assert.equal(releasedChapters(book).length, 4)

  for (const chapter of releasedChapters(book)) {
    const rows = chapter.blocks.filter(
      (block): block is ProseParagraph => block.kind === 'paragraph',
    )

    // Its datelines are italic and first; nothing in it is bold, quoted or
    // code, so the new variants and the new marks cannot have touched it.
    assert.equal(rows[0].variant, 'dateline')
    assert.equal(rows[0].segments.length, 1)
    assert.equal(rows[0].segments[0].kind, 'emphasis')

    for (const paragraph of rows.slice(1)) {
      assert.equal(paragraph.variant, 'prose', `${chapter.slug}/${paragraph.id}`)
      assert.equal(paragraph.tight, false, `${chapter.slug}/${paragraph.id}`)
      for (const segment of paragraph.segments) {
        assert.ok(
          segment.kind === 'text' || segment.kind === 'emphasis',
          `${chapter.slug}/${paragraph.id}: unexpected ${segment.kind}`,
        )
      }
    }
  }

  // The ordinals every stored bookmark and annotation is written against.
  const one = findReleasedChapter(book, 'chapter-one')
  assert.ok(one)
  assert.equal(one.paragraphCount, 117)
  assert.equal(
    findParagraph(one, 'chapter-one-p001')?.text,
    'A cholera-relief camp outside Dacca · Spring 1972',
  )
  assert.ok(
    findParagraph(one, 'chapter-one-p002')?.text.startsWith('The heat inside the tent'),
  )
})

/* ------------------------------------------------------- the audience rule */

test('PERSISTENT is author-only, and is never offered to a reviewer', () => {
  assert.equal(loadBook(BOOK).audience, 'author-only')
  assert.equal(isAuthorOnlyBook(BOOK), true)

  const offerable = reviewerReadableBookSlugs()
  assert.ok(!offerable.includes(BOOK), 'not a book a reviewer can be given')
  assert.ok(offerable.includes('the-backward-becoming'), 'the reviewers still have theirs')
})

test('an unknown or absent audience fails closed to author-only', () => {
  // A book that does not exist is not something to hand a reviewer.
  assert.equal(isAuthorOnlyBook('no-such-book'), true)
  assert.equal(isAuthorOnlyBook(''), true)
})

test('the manuscript is not served from public/', () => {
  const manifest = JSON.parse(readFileSync(join(CONTENT, 'book.json'), 'utf8'))
  for (const entry of manifest.chapters) {
    assert.ok(
      !existsSync(join(process.cwd(), 'public', 'books', BOOK, `${entry.slug}.md`)),
      entry.slug,
    )
  }
})
