#!/usr/bin/env node
/**
 * Export every reviewer feedback object from the Vercel Blob store, unchanged.
 *
 *   BLOB_READ_WRITE_TOKEN=... npm run export:feedback -- ./feedback-export
 *
 * What this is for: the store holds each comment as its own immutable JSON
 * object, and this walks the whole `feedback/` tree and writes each object to a
 * local file at the same relative path. It is the migration path off Vercel
 * Blob -- whatever the next store is, its importer reads these files.
 *
 * The one rule this script follows: **the bytes are not touched.** Objects are
 * written exactly as they were read -- not re-serialised, not re-indented, not
 * re-ordered, not normalised. A JSON object that round-trips through a parser
 * is no longer the object that was stored, and an export whose purpose is to be
 * the record of what a reviewer said must be the record, not a rendering of it.
 * The script parses a copy only to *report* on what it found, never to decide
 * what to write.
 *
 * Nothing is deleted and nothing in the store is modified: this is a read-only
 * operation that happens to write locally.
 *
 * The token is read from the environment and is never printed. Blob URLs are
 * never printed either -- the pathname is what identifies an object here.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

import { get, list } from '@vercel/blob'

/** Everything this driver writes lives beneath here. */
const FEEDBACK_ROOT = 'feedback/'

function fail(message) {
  process.stderr.write(`export-feedback: ${message}\n`)
  process.exit(1)
}

const token = (process.env.BLOB_READ_WRITE_TOKEN ?? '').trim()
if (!token) {
  fail(
    'BLOB_READ_WRITE_TOKEN is not set.\n' +
      "  Pull it from the project's production environment first:\n" +
      '    vercel env pull --environment=production\n' +
      '  and run this with that value in the environment. Never paste it into a file that is committed.',
  )
}

const outDir = resolve(process.argv[2] ?? 'feedback-export')

/** Every pathname beneath the feedback root, following pagination to the end. */
async function allPathnames() {
  const pathnames = []
  let cursor

  for (;;) {
    const page = await list({ token, prefix: FEEDBACK_ROOT, cursor })
    for (const blob of page.blobs) pathnames.push(blob.pathname)
    if (!page.hasMore || !page.cursor) break
    cursor = page.cursor
  }

  return pathnames.sort()
}

/**
 * Where one object lands locally. The store's pathname is reproduced as a
 * directory path, so the export has the same reviewer/book shape the store
 * does and a later importer can read the structure without a manifest.
 */
function localPathFor(pathname) {
  const segments = pathname.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`refusing to write a suspicious pathname: ${pathname}`)
  }
  const target = join(outDir, ...segments)
  // Belt and braces: whatever the store returned, nothing is written outside
  // the directory the operator named.
  if (target !== outDir && !target.startsWith(outDir + sep)) {
    throw new Error(`refusing to write outside ${outDir}: ${pathname}`)
  }
  return target
}

const pathnames = await allPathnames()

if (pathnames.length === 0) {
  process.stdout.write(`No feedback objects found beneath "${FEEDBACK_ROOT}".\n`)
  process.exit(0)
}

let written = 0
let unreadable = 0
let unparseable = 0
const reviewers = new Set()
const books = new Set()

for (const pathname of pathnames) {
  const result = await get(pathname, { token, access: 'private', useCache: false })
  if (!result?.stream) {
    unreadable += 1
    process.stderr.write(`  ! could not read ${pathname}\n`)
    continue
  }

  // Read as bytes and write as bytes. No text decoding, no re-encoding.
  const bytes = Buffer.from(await new Response(result.stream).arrayBuffer())

  const target = localPathFor(pathname)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, bytes)
  written += 1

  // Reporting only. Nothing below this line influences what was written above.
  try {
    const row = JSON.parse(bytes.toString('utf8'))
    if (typeof row?.reviewerId === 'string') reviewers.add(row.reviewerId)
    if (typeof row?.bookSlug === 'string') books.add(row.bookSlug)
  } catch {
    unparseable += 1
    process.stderr.write(`  ! not valid JSON (exported unchanged anyway): ${pathname}\n`)
  }
}

process.stdout.write(
  [
    `Exported ${written} feedback object${written === 1 ? '' : 's'} to ${outDir}`,
    `  reviewers : ${reviewers.size}`,
    `  books     : ${books.size}`,
    unreadable > 0 ? `  unreadable: ${unreadable}` : null,
    unparseable > 0 ? `  unparseable (still exported byte-for-byte): ${unparseable}` : null,
    '',
    'Each file is the stored object, byte for byte. Nothing in the store was changed.',
    '',
  ]
    .filter((line) => line !== null)
    .join('\n'),
)

if (unreadable > 0) process.exit(1)
