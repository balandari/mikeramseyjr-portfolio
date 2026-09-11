import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  findBook,
  findParagraph,
  findReleasedChapter,
  listBookSlugs,
  loadBook,
  paragraphId,
  parseInline,
  releasedChapters,
} from '../lib/manuscript.ts'

const CONTENT = join(process.cwd(), 'content', 'books')
const BOOK = 'the-backward-becoming'

/* ------------------------------------------------------ the shipped book */

test('the launch book loads and its four chapters are released', () => {
  const book = loadBook(BOOK)
  assert.equal(book.slug, BOOK)
  assert.equal(book.title, 'The Backward Becoming')

  const chapters = releasedChapters(book)
  assert.equal(chapters.length, 4)
  assert.deepEqual(
    chapters.map((chapter) => chapter.slug),
    ['chapter-one', 'chapter-two', 'chapter-three', 'chapter-four'],
  )
  assert.deepEqual(
    chapters.map((chapter) => chapter.number),
    [1, 2, 3, 4],
  )
})

test('every chapter file still hashes to the manifest pin it was imported under', () => {
  const manifest = JSON.parse(readFileSync(join(CONTENT, BOOK, 'book.json'), 'utf8'))

  for (const chapter of manifest.chapters) {
    const buffer = readFileSync(join(CONTENT, BOOK, chapter.file))
    assert.equal(buffer.byteLength, chapter.bytes, `${chapter.slug} byte count`)
    assert.equal(
      createHash('sha256').update(buffer).digest('hex'),
      chapter.sha256,
      `${chapter.slug} sha256`,
    )
  }
})

test('the imported chapters match the hashes recorded for the /tbb source', () => {
  // These are the per-chapter digests the reference reader pinned. They are
  // restated here so that a future re-import cannot quietly substitute
  // different text while still agreeing with its own manifest.
  const SOURCE_PINS: Record<string, string> = {
    'chapter-one': '691383abc09f67f687efa2bd52fd482f668763650a7880aa2c148b60dfb1dea1',
    'chapter-two': '3819d4d494418e51a45a250016e7ddc1f6e27cad91726e23554f40c1ce2f78f8',
    'chapter-three': '9b52bd79c1a533798ca96a848acaa30a8de9af5ba2d91e2e966cb10fd91af6d3',
    'chapter-four': '20cdd79f1faedd2397474033dfbef9a72c6ab38a324614cdb6f6241295be63c1',
  }
  const COMBINED = '2c8ed32de36eafafdc14f98c8cdbb562a0b16f82811c25732ba02d94c4b66fe5'

  const buffers: Buffer[] = []
  for (const [slug, expected] of Object.entries(SOURCE_PINS)) {
    const buffer = readFileSync(join(CONTENT, BOOK, 'chapters', `${slug}.md`))
    assert.equal(createHash('sha256').update(buffer).digest('hex'), expected, slug)
    buffers.push(buffer)
  }

  const combined = Buffer.concat(buffers)
  assert.equal(combined.byteLength, 97967)
  assert.equal(createHash('sha256').update(combined).digest('hex'), COMBINED)
})

/**
 * The guard that makes "the prose is unaltered" a fact rather than a promise.
 * Driven through `loadBook` itself on a throwaway book, because the shipped
 * book is memoised after its first successful load and tampering with it
 * afterwards would prove nothing.
 */
test('a chapter whose bytes have drifted from its pin is refused, not served', () => {
  const slug = 'workflow-drift-book'
  const dir = join(CONTENT, slug)
  const body = '# Chapter One — Drift\n\nA paragraph that will be tampered with.\n'

  const writeFixture = (fileText: string, pinnedText: string) => {
    mkdirSync(join(dir, 'chapters'), { recursive: true })
    writeFileSync(join(dir, 'chapters', 'one.md'), Buffer.from(fileText, 'utf8'))
    writeFileSync(
      join(dir, 'book.json'),
      JSON.stringify({
        slug,
        title: 'Drift',
        author: 'Test',
        subtitle: '',
        chapters: [
          {
            slug: 'one',
            number: 1,
            title: 'Chapter One — Drift',
            label: 'Chapter One',
            subtitle: '',
            file: 'chapters/one.md',
            // The pin describes `pinnedText`, which may not be what is on disk.
            bytes: Buffer.byteLength(pinnedText, 'utf8'),
            sha256: createHash('sha256')
              .update(Buffer.from(pinnedText, 'utf8'))
              .digest('hex'),
            status: 'available',
          },
        ],
      }),
    )
  }

  try {
    // Same length, one byte different: the byte-count check cannot catch this,
    // so this proves the digest check specifically.
    const drifted = body.replace('tampered', 'tamperee')
    assert.equal(Buffer.byteLength(drifted, 'utf8'), Buffer.byteLength(body, 'utf8'))

    writeFixture(drifted, body)
    assert.throws(() => loadBook(slug), /SHA-256 does not match its manifest pin/)
    assert.equal(findBook(slug), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a chapter whose length has drifted from its pin is refused, not served', () => {
  const slug = 'workflow-length-book'
  const dir = join(CONTENT, slug)
  const body = '# Chapter One — Length\n\nA paragraph.\n'

  try {
    mkdirSync(join(dir, 'chapters'), { recursive: true })
    writeFileSync(join(dir, 'chapters', 'one.md'), Buffer.from(`${body}Extra.\n`, 'utf8'))
    writeFileSync(
      join(dir, 'book.json'),
      JSON.stringify({
        slug,
        title: 'Length',
        author: 'Test',
        subtitle: '',
        chapters: [
          {
            slug: 'one',
            number: 1,
            title: 'Chapter One — Length',
            label: 'Chapter One',
            subtitle: '',
            file: 'chapters/one.md',
            bytes: Buffer.byteLength(body, 'utf8'),
            sha256: createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex'),
            status: 'available',
          },
        ],
      }),
    )

    assert.throws(() => loadBook(slug), /expected \d+ bytes, found \d+/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* --------------------------------------------------------------- parsing */

test('paragraph identifiers are stable, padded and chapter-scoped', () => {
  assert.equal(paragraphId('chapter-one', 1), 'chapter-one-p001')
  assert.equal(paragraphId('chapter-one', 42), 'chapter-one-p042')
  assert.equal(paragraphId('chapter-four', 7), 'chapter-four-p007')
  // Two chapters never share a paragraph identifier.
  assert.notEqual(paragraphId('chapter-one', 3), paragraphId('chapter-two', 3))
})

test('paragraph ordinals are continuous and skip scene breaks', () => {
  const book = loadBook(BOOK)
  for (const chapter of releasedChapters(book)) {
    const paragraphs = chapter.blocks.filter((block) => block.kind === 'paragraph')
    assert.equal(paragraphs.length, chapter.paragraphCount, chapter.slug)
    paragraphs.forEach((paragraph, index) => {
      assert.equal(paragraph.kind, 'paragraph')
      if (paragraph.kind !== 'paragraph') return
      assert.equal(paragraph.ordinal, index + 1)
      assert.equal(paragraph.id, paragraphId(chapter.slug, index + 1))
    })
  }
})

test('inline emphasis is parsed, and an unpaired asterisk stays literal', () => {
  assert.deepEqual(parseInline('plain'), [{ kind: 'text', text: 'plain' }])
  assert.deepEqual(parseInline('a *b* c'), [
    { kind: 'text', text: 'a ' },
    { kind: 'emphasis', text: 'b' },
    { kind: 'text', text: ' c' },
  ])
  assert.deepEqual(parseInline('a *b c'), [{ kind: 'text', text: 'a *b c' }])
})

test('no paragraph text is empty and none retains a markdown heading', () => {
  const book = loadBook(BOOK)
  for (const chapter of releasedChapters(book)) {
    for (const block of chapter.blocks) {
      if (block.kind !== 'paragraph') continue
      assert.ok(block.text.trim().length > 0, `${block.id} is empty`)
      assert.ok(!block.text.startsWith('#'), `${block.id} looks like a heading`)
    }
  }
})

test('a paragraph can be looked up by its identifier, and an unknown one cannot', () => {
  const book = loadBook(BOOK)
  const chapter = findReleasedChapter(book, 'chapter-one')
  assert.ok(chapter)

  const found = findParagraph(chapter, 'chapter-one-p002')
  assert.ok(found)
  assert.equal(found.ordinal, 2)
  assert.ok(found.text.length > 0)

  // A paragraph from another chapter is not reachable through this one.
  assert.equal(findParagraph(chapter, 'chapter-two-p002'), null)
  assert.equal(findParagraph(chapter, 'chapter-one-p999'), null)
  assert.equal(findParagraph(chapter, 'nonsense'), null)
})

/* ------------------------------------------------------------ addressing */

test('an unknown or malformed book slug resolves to nothing, never an error', () => {
  assert.equal(findBook('no-such-book'), null)
  assert.equal(findBook('../../etc'), null)
  assert.equal(findBook('Bad Slug'), null)
  assert.equal(findBook(''), null)
})

test('the shipped book is discoverable on disk', () => {
  assert.ok(listBookSlugs().includes(BOOK))
})

/* -------------------------------------------------- the content workflow */

/*
 * The proof behind requirement 10: a new book and a new chapter are content,
 * not code. This test adds one of each through nothing but files on disk --
 * exactly the documented workflow -- and asserts that the application picks
 * them up, hides the unreleased one, and serves it once released. No module in
 * `app/` or `lib/` is touched, imported differently, or aware this happened.
 */
test('a new book and chapter can be added as files alone, with release honoured', () => {
  const slug = 'workflow-fixture-book'
  const dir = join(CONTENT, slug)

  const released = '# Chapter One — Released\n\nFirst paragraph of the released chapter.\n\nSecond paragraph.\n'
  const draft = '# Chapter Two — Unreleased\n\nThis chapter is staged but not released.\n'

  const digest = (text: string) =>
    createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')

  try {
    mkdirSync(join(dir, 'chapters'), { recursive: true })
    writeFileSync(join(dir, 'chapters', 'released.md'), Buffer.from(released, 'utf8'))
    writeFileSync(join(dir, 'chapters', 'unreleased.md'), Buffer.from(draft, 'utf8'))

    const manifest = {
      slug,
      title: 'Workflow Fixture',
      author: 'Test',
      subtitle: 'A fixture',
      chapters: [
        {
          slug: 'released',
          number: 1,
          title: 'Chapter One — Released',
          label: 'Chapter One',
          subtitle: 'Released',
          file: 'chapters/released.md',
          bytes: Buffer.byteLength(released, 'utf8'),
          sha256: digest(released),
          status: 'available',
        },
        {
          slug: 'unreleased',
          number: 2,
          title: 'Chapter Two — Unreleased',
          label: 'Chapter Two',
          subtitle: 'Unreleased',
          file: 'chapters/unreleased.md',
          bytes: Buffer.byteLength(draft, 'utf8'),
          sha256: digest(draft),
          status: 'draft',
        },
      ],
    }
    writeFileSync(join(dir, 'book.json'), JSON.stringify(manifest, null, 2))

    // Discovered with no code change.
    assert.ok(listBookSlugs().includes(slug))

    const book = loadBook(slug)
    assert.equal(book.title, 'Workflow Fixture')
    assert.equal(book.chapters.length, 2)

    // The draft is present in the manifest but unreachable to a reader.
    const readable = releasedChapters(book)
    assert.equal(readable.length, 1)
    assert.equal(readable[0].slug, 'released')
    assert.equal(findReleasedChapter(book, 'unreleased'), null)

    // The released chapter parsed into addressable paragraphs.
    const chapter = findReleasedChapter(book, 'released')
    assert.ok(chapter)
    assert.equal(chapter.paragraphCount, 2)
    assert.equal(findParagraph(chapter, 'released-p001')?.text, 'First paragraph of the released chapter.')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a chapter whose heading disagrees with its manifest is refused', () => {
  const slug = 'workflow-mismatch-book'
  const dir = join(CONTENT, slug)
  const body = '# Chapter One — Actual\n\nA paragraph.\n'

  try {
    mkdirSync(join(dir, 'chapters'), { recursive: true })
    writeFileSync(join(dir, 'chapters', 'one.md'), Buffer.from(body, 'utf8'))
    writeFileSync(
      join(dir, 'book.json'),
      JSON.stringify({
        slug,
        title: 'Mismatch',
        author: 'Test',
        subtitle: '',
        chapters: [
          {
            slug: 'one',
            number: 1,
            // Declares a different heading from the one in the file.
            title: 'Chapter One — Declared',
            label: 'Chapter One',
            subtitle: '',
            file: 'chapters/one.md',
            bytes: Buffer.byteLength(body, 'utf8'),
            sha256: createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex'),
            status: 'available',
          },
        ],
      }),
    )

    assert.throws(() => loadBook(slug), /does not open with the heading/)
    // And the safe wrapper turns that into "not found" rather than a 500.
    assert.equal(findBook(slug), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* --------------------------------------------------- reserved route segments */

/*
 * `/review/<book>` is a dynamic segment, and a few static segments live beside
 * it. Next resolves a static segment first, so a book whose slug happened to be
 * one of these would become unreachable in the reader -- silently, and only for
 * that book.
 *
 * This is cheap to check and expensive to discover, so it is checked. If a
 * future manuscript really needs one of these words as its slug, the fix is to
 * move the route, not to rename the book after it has shipped.
 */
const RESERVED_REVIEW_SEGMENTS = ['api', 'login', 'my-reading', 'shared']

test('no loaded book slug collides with a reserved reader route', () => {
  for (const slug of listBookSlugs()) {
    assert.ok(
      !RESERVED_REVIEW_SEGMENTS.includes(slug),
      `"${slug}" is also a static segment under /review, so /review/${slug} would never reach the book`,
    )
  }
})
