#!/usr/bin/env node
/**
 * build-persistent.mjs -- write `content/books/persistent/` from the locked
 * manuscript.
 *
 * The conversion itself lives in `persistent-source.mjs`, which is also what
 * `verify-persistent.mjs` runs. This script is the side-effecting half: it
 * converts, then writes, then tells you what it wrote.
 *
 * It is deterministic and idempotent -- running it twice produces identical
 * bytes -- so a re-run is a safe way to prove the payload on disk is still the
 * conversion of the source. Pass `--check` to compare without writing.
 *
 * Usage:
 *   node scripts/build-persistent.mjs            write the payload
 *   node scripts/build-persistent.mjs --check    compare only, write nothing
 *   node scripts/build-persistent.mjs --source <path>
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BOOK_SLUG, SOURCE, convert, manifestFor, readSource } from './persistent-source.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BOOK_DIR = join(ROOT, 'content', 'books', BOOK_SLUG)

const args = process.argv.slice(2)
const check = args.includes('--check')
const sourceIndex = args.indexOf('--source')
const sourcePath = sourceIndex >= 0 ? args[sourceIndex + 1] : SOURCE.path

const AUTHOR = 'Mike Ramsey Jr'

const source = readSource(sourcePath)
console.log(
  `source  ${sourcePath}\n        ${source.bytes} bytes  sha256 ${source.sha256}\n        ${source.headings} chapter headings`,
)

const converted = convert(source.text)
const manifest = manifestFor(converted, AUTHOR)

console.log(
  `\nconverted  ${converted.counts.chapters} chapters` +
    `\n           ${converted.counts.rulesInSource} rules in source` +
    ` = ${converted.counts.rulesInFrontMatter} front matter` +
    ` + ${converted.counts.structuralRules} structural` +
    ` + ${converted.counts.sceneBreaks} scene breaks`,
)

const files = [
  [join(BOOK_DIR, 'book.json'), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')],
  ...converted.chapters.map((chapter) => [join(BOOK_DIR, chapter.file), chapter.buffer]),
]

let differences = 0

for (const [path, buffer] of files) {
  const relative = path.slice(ROOT.length + 1).replace(/\\/g, '/')
  const existing = existsSync(path) ? readFileSync(path) : null
  const same = existing !== null && existing.equals(buffer)

  if (same) {
    console.log(`  same     ${relative}  (${buffer.byteLength} bytes)`)
    continue
  }

  differences += 1

  if (check) {
    console.log(`  DIFFERS  ${relative}  (${existing === null ? 'absent' : `${existing.byteLength} bytes on disk`}, ${buffer.byteLength} expected)`)
    continue
  }

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, buffer)
  console.log(`  wrote    ${relative}  (${buffer.byteLength} bytes)`)
}

if (check) {
  console.log(`\n${differences === 0 ? 'OK' : 'FAILED'} -- ${files.length - differences}/${files.length} files match the conversion`)
  process.exit(differences === 0 ? 0 : 1)
}

console.log(`\nOK -- ${files.length} files, ${differences} changed`)
