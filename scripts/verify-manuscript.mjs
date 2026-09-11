#!/usr/bin/env node
/**
 * verify-manuscript.mjs -- prove the stored manuscripts are unaltered.
 *
 * Runs without a server and without secrets, so it is equally usable as a local
 * gate before a commit and as a CI step. It proves, for every book under
 * `content/books/`:
 *
 *   1. Every chapter file is exactly the bytes its manifest pins -- byte count
 *      and SHA-256, both.
 *   2. Every chapter opens with the heading its manifest declares, so a file
 *      cannot be swapped for another chapter with the same length.
 *   3. Where a manifest pins the whole book, the concatenation of its chapters
 *      in order matches that pin too.
 *   4. No chapter file has leaked into `public/`, which would publish an
 *      unreleased manuscript as a static asset that no access check could
 *      take back.
 *
 * Usage: node scripts/verify-manuscript.mjs
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BOOKS = join(ROOT, 'content', 'books')
const PUBLIC = join(ROOT, 'public')

const sha256 = (input) => createHash('sha256').update(input).digest('hex')

let checks = 0
let failures = 0

function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`  PASS  ${label}${detail ? `  -- ${detail}` : ''}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `  -- ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

/* ----------------------------------------------------------------- books */

if (!existsSync(BOOKS)) {
  console.error(`no content directory at ${BOOKS}`)
  process.exit(1)
}

const bookSlugs = readdirSync(BOOKS, { withFileTypes: true })
  .filter((item) => item.isDirectory())
  .map((item) => item.name)
  .sort()

check('at least one book is present', bookSlugs.length > 0, `${bookSlugs.length} found`)

const chapterDigests = new Set()

for (const slug of bookSlugs) {
  section(`${slug}`)

  const manifestPath = join(BOOKS, slug, 'book.json')
  if (!existsSync(manifestPath)) {
    check(`${slug}: manifest present`, false, 'book.json is missing')
    continue
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  check(`${slug}: manifest slug matches its directory`, manifest.slug === slug)
  check(`${slug}: manifest lists chapters`, Array.isArray(manifest.chapters) && manifest.chapters.length > 0)

  const ordered = [...(manifest.chapters ?? [])].sort((a, b) => a.number - b.number)
  let combined = Buffer.alloc(0)
  let allFilesPresent = true

  for (const chapter of ordered) {
    const path = join(BOOKS, slug, chapter.file)

    if (!existsSync(path)) {
      check(`${slug}/${chapter.slug}: file present`, false, chapter.file)
      allFilesPresent = false
      continue
    }

    const buffer = readFileSync(path)
    const digest = sha256(buffer)

    check(
      `${slug}/${chapter.slug}: byte count matches its pin`,
      buffer.byteLength === chapter.bytes,
      `${buffer.byteLength} vs ${chapter.bytes}`,
    )
    check(
      `${slug}/${chapter.slug}: SHA-256 matches its pin`,
      digest === chapter.sha256,
      digest.slice(0, 16),
    )

    const text = buffer.toString('utf8')
    const firstLine = text.split('\n')[0].trim()
    check(
      `${slug}/${chapter.slug}: opens with its declared heading`,
      firstLine === `# ${chapter.title}`,
      firstLine.slice(0, 48),
    )

    // A chapter must not appear twice under two names.
    check(`${slug}/${chapter.slug}: content is not a duplicate`, !chapterDigests.has(digest))
    chapterDigests.add(digest)

    if (chapter.status === 'available') {
      combined = Buffer.concat([combined, buffer])
    }
  }

  // The whole-book pin covers the RELEASED chapters in order, so staging an
  // unreleased chapter in the manifest leaves it intact and still checked.
  // It is optional: a book gains one when its released set is meant to be frozen.
  if (manifest.combinedSha256 && allFilesPresent) {
    check(
      `${slug}: combined byte count matches its pin`,
      combined.byteLength === manifest.combinedBytes,
      `${combined.byteLength} vs ${manifest.combinedBytes}`,
    )
    check(
      `${slug}: combined SHA-256 matches its pin`,
      sha256(combined) === manifest.combinedSha256,
    )
  } else if (manifest.combinedSha256) {
    console.log(
      `  NOTE  ${slug}: combined pin not evaluated -- the released set has changed (a draft or missing chapter is present)`,
    )
  }
}

/* ------------------------------------------------------------- exposure */

section('exposure')

function walk(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name)
    if (item.isDirectory()) out.push(...walk(path))
    else if (statSync(path).isFile()) out.push(path)
  }
  return out
}

const publicFiles = walk(PUBLIC)
const leaked = publicFiles.filter((path) => chapterDigests.has(sha256(readFileSync(path))))

check(
  'no chapter file is served from public/',
  leaked.length === 0,
  leaked.length === 0 ? `${publicFiles.length} public files scanned` : leaked.join(', '),
)

/* --------------------------------------------------------------- result */

console.log(`\n${failures === 0 ? 'OK' : 'FAILED'} -- ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
