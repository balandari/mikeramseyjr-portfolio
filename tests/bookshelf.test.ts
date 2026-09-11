import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { featuredBook, findShelfBook, loadShelf, type ShelfBook } from '../lib/bookshelf.ts'

/* ------------------------------------------------------- the shipped shelf */

test('the shipped shelf loads and carries both real titles, in order', () => {
  const books = loadShelf()
  assert.deepEqual(
    books.map((b) => b.slug),
    ['the-backward-becoming', 'persistent'],
  )

  const backward = findShelfBook('the-backward-becoming')
  assert.ok(backward, 'the current book is on the shelf')
  assert.equal(backward.title, 'The Backward Becoming')
  assert.equal(backward.status, 'in-progress')
  assert.equal(backward.featured, true)
  assert.equal(backward.reviewerAccess, true)
  assert.ok(backward.description.length > 0)

  const persistent = findShelfBook('persistent')
  assert.ok(persistent, 'the completed draft is on the shelf')
  assert.equal(persistent.title, 'PERSISTENT')
  assert.equal(persistent.status, 'complete')
  assert.equal(persistent.featured, false)
  assert.ok(persistent.description.length > 0)
})

test('PERSISTENT is described as a draft awaiting review, and nothing more', () => {
  const book = findShelfBook('persistent')
  assert.ok(book)

  const text = [book.tagline, book.statusLabel, book.statusNote, ...book.description]
    .join(' ')
    .toLowerCase()

  // Its length and its stage are stated; both are facts Mike gave.
  assert.ok(/twenty-nine|29/.test(text), 'the chapter count is stated')
  assert.ok(text.includes('draft'), 'it is described as a draft')
  assert.ok(
    /line-by-line|read back|review/.test(text),
    'what it is waiting for is stated',
  )

  // It must not be dressed up as finished work, or as available to anyone.
  for (const forbidden of [
    'publication-ready',
    'ready to publish',
    'ready for publication',
    'finished novel',
    'out now',
    'available now',
    'read it',
    'excerpt',
    'sample chapter',
  ]) {
    assert.ok(!text.includes(forbidden), `PERSISTENT must not claim "${forbidden}"`)
  }
})

test('PERSISTENT is not offered to advance readers', () => {
  assert.equal(findShelfBook('persistent')?.reviewerAccess, false)

  // Exactly one title is in advance reading, and it is the one that actually is.
  const shared = loadShelf().filter((b) => b.reviewerAccess)
  assert.deepEqual(
    shared.map((b) => b.slug),
    ['the-backward-becoming'],
  )
})

test('the shipped shelf makes no claim the work has not earned', () => {
  const books = loadShelf()
  const text = JSON.stringify(books).toLowerCase()

  // No retailer, no pre-order, no invented date or accolade may reach the
  // public site through content. A future title that genuinely has any of these
  // will need this test changed deliberately, which is the point of it.
  for (const forbidden of [
    'amazon',
    'kindle',
    'kdp',
    'pre-order',
    'preorder',
    'buy now',
    'award',
    'bestseller',
    'praise for',
    'isbn',
    'coming soon',
  ]) {
    assert.ok(!text.includes(forbidden), `shelf content must not contain ${forbidden}`)
  }
})

test('no title ships a cover or an author image it does not have', () => {
  for (const book of loadShelf()) {
    assert.equal(book.cover, null, `${book.slug} must not claim cover art`)
  }
})

test('every title has a stage and a plain-language note about it', () => {
  for (const book of loadShelf()) {
    assert.ok(book.statusLabel.trim().length > 0)
    assert.ok(book.statusNote.trim().length > 0)
  }
})

/* ------------------------------------------------------- growing the shelf */

function shelfFixture(entries: Record<string, unknown>[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'shelf-'))
  mkdirSync(dir, { recursive: true })
  for (const entry of entries) {
    writeFileSync(join(dir, `${entry.slug}.json`), JSON.stringify(entry), 'utf8')
  }
  return dir
}

function validEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: 'a-book',
    order: 1,
    featured: false,
    title: 'A Book',
    kind: 'Novel',
    tagline: 'A tagline.',
    status: 'in-progress',
    statusLabel: 'Work in progress',
    statusNote: 'Not yet published.',
    description: ['One paragraph.'],
    details: [{ label: 'Form', value: 'Novel' }],
    reviewerAccess: false,
    cover: null,
    ...overrides,
  }
}

test('a second title needs one file and no code change', (t) => {
  const dir = shelfFixture([
    validEntry({ slug: 'first-book', title: 'First Book', order: 1, featured: true }),
    validEntry({ slug: 'second-book', title: 'Second Book', order: 2 }),
  ])
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const books = loadShelf(dir)
  assert.deepEqual(
    books.map((b) => b.slug),
    ['first-book', 'second-book'],
  )
  assert.equal(featuredBook(books)?.slug, 'first-book')
  assert.equal(findShelfBook('second-book', dir)?.title, 'Second Book')
})

test('order decides the shelf, not the filename', (t) => {
  const dir = shelfFixture([
    validEntry({ slug: 'aaa', title: 'Aaa', order: 9 }),
    validEntry({ slug: 'zzz', title: 'Zzz', order: 1 }),
  ])
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  assert.deepEqual(
    loadShelf(dir).map((b) => b.slug),
    ['zzz', 'aaa'],
  )
})

test('promoting the next book is one boolean', (t) => {
  const dir = shelfFixture([
    validEntry({ slug: 'old-book', title: 'Old Book', order: 1 }),
    validEntry({ slug: 'new-book', title: 'New Book', order: 2, featured: true }),
  ])
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  assert.equal(featuredBook(loadShelf(dir))?.slug, 'new-book')
})

test('a shelf with nothing marked featured still has a front page', (t) => {
  const dir = shelfFixture([validEntry({ slug: 'only-book', title: 'Only Book', order: 1 })])
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  assert.equal(featuredBook(loadShelf(dir))?.slug, 'only-book')
})

test('an empty shelf is empty rather than an error', (t) => {
  const dir = shelfFixture([])
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const books = loadShelf(dir)
  assert.deepEqual(books, [] as ShelfBook[])
  assert.equal(featuredBook(books), null)
})

test('a missing shelf directory is empty rather than an error', () => {
  assert.deepEqual(loadShelf(join(tmpdir(), 'shelf-that-does-not-exist-9f3a')), [])
})

/* --------------------------------------------------------------- refusals */

test('a malformed title stops the build instead of vanishing from the shelf', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'shelf-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const cases: [string, Record<string, unknown>][] = [
    ['missing title', validEntry({ title: '' })],
    ['missing tagline', validEntry({ tagline: '   ' })],
    ['unknown status', validEntry({ status: 'on-sale' })],
    ['empty description', validEntry({ description: [] })],
    ['non-string description entry', validEntry({ description: [42] })],
    ['non-numeric order', validEntry({ order: 'first' })],
    ['detail without a value', validEntry({ details: [{ label: 'Form' }] })],
    ['cover without a src', validEntry({ cover: { alt: 'a cover' } })],
  ]

  for (const [name, entry] of cases) {
    writeFileSync(join(dir, 'a-book.json'), JSON.stringify(entry), 'utf8')
    assert.throws(() => loadShelf(dir), /a-book\.json/, `${name} must throw`)
  }
})

test('a file whose slug and filename disagree is refused', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'shelf-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  writeFileSync(join(dir, 'a-book.json'), JSON.stringify(validEntry({ slug: 'other-book' })), 'utf8')
  assert.throws(() => loadShelf(dir), /must match the filename/)
})

test('a slug that is not a slug is refused, including traversal', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'shelf-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  writeFileSync(join(dir, 'a-book.json'), JSON.stringify(validEntry()), 'utf8')

  for (const slug of ['..', '../a-book', 'a/b', 'A-Book', '', '-leading']) {
    assert.equal(findShelfBook(slug, dir), null, `${JSON.stringify(slug)} must not resolve`)
  }
})

test('an unknown slug is null, not a guess', (t) => {
  const dir = shelfFixture([validEntry()])
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  assert.equal(findShelfBook('a-boo', dir), null)
  assert.equal(findShelfBook('a-books', dir), null)
  assert.equal(findShelfBook('a-book', dir)?.slug, 'a-book')
})

/* ------------------------------------------------------------- separation */

test('the public shelf cannot reach the private manuscript', () => {
  // The two content trees are separate on disk and the loaders do not import
  // one another. Reading the shelf must never surface a chapter, a file path
  // into `content/books/`, or anything that could be mistaken for prose.
  const serialised = JSON.stringify(loadShelf())
  assert.ok(!serialised.includes('content/books'))
  assert.ok(!serialised.includes('chapters/'))
  assert.ok(!serialised.includes('.md'))
})
