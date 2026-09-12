#!/usr/bin/env node
/**
 * verify-persistent.mjs -- prove the stored PERSISTENT payload *is* the locked
 * manuscript, with nothing rewritten and nothing left out.
 *
 * `verify-manuscript.mjs` proves a different, weaker thing: that the chapter
 * files on disk still hash to the pins in their own manifest. That catches
 * drift after the fact but would happily bless a payload that was wrong the day
 * it was written. This script closes that gap by going back to the source.
 *
 * It makes three independent proofs, in increasing strength:
 *
 *   **1. Source identity.** The locked file is exactly 252,756 bytes, hashes to
 *   the pinned SHA-256, and carries 29 `## Chapter` headings. Anything else and
 *   nothing further is checked.
 *
 *   **2. The payload is the conversion.** Re-running the documented conversion
 *   (`persistent-source.mjs`) over the source reproduces every file under
 *   `content/books/persistent/` byte for byte -- the 29 chapter files and the
 *   manifest. Nothing was hand-edited after the build.
 *
 *   **3. The source reconstructs from the payload.** The strongest one, and the
 *   one that actually answers "was anything silently rewritten or omitted?".
 *   The 29 chapter files on disk are reassembled back into a single-file
 *   manuscript -- front matter, headings, section titles, the two structural
 *   rules per chapter -- and compared to the locked source line by line under
 *   the one documented whitespace rule (N5). They must be identical. A dropped
 *   paragraph, a re-cased word, a lost asterisk, a reordered chapter or a
 *   merged pair of lines all fail here, and the first differing line is
 *   printed.
 *
 * Proof 3 is what makes proof 2 meaningful: together they say the conversion is
 * lossless *and* that the payload is that conversion.
 *
 * Usage: node scripts/verify-persistent.mjs [--source <path>]
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BOOK_SLUG, SOURCE, convert, manifestFor, readSource, sha256 } from './persistent-source.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BOOK_DIR = join(ROOT, 'content', 'books', BOOK_SLUG)

const args = process.argv.slice(2)
const sourceIndex = args.indexOf('--source')
const sourcePath = sourceIndex >= 0 ? args[sourceIndex + 1] : SOURCE.path

const AUTHOR = 'Mike Ramsey Jr'
const RULE = /^-{3,}$/

let checks = 0
let failures = 0

function check(label, condition, detail = '') {
  checks += 1
  if (condition) console.log(`  PASS  ${label}${detail ? `  -- ${detail}` : ''}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `  -- ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

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

/* ------------------------------------------------------- 1. source identity */

section('1. the locked source is the file this conversion was written against')

let source
try {
  source = readSource(sourcePath)
} catch (error) {
  console.log(`  FAIL  source identity  -- ${error.message}`)
  console.log('\nFAILED -- the source could not be accepted, so nothing else was checked')
  process.exit(1)
}

check('source byte count', source.bytes === SOURCE.bytes, `${source.bytes}`)
check('source SHA-256', source.sha256 === SOURCE.sha256, source.sha256)
check('source chapter headings', source.headings === SOURCE.chapterHeadings, `${source.headings}`)

/* --------------------------------------------- 2. the payload is the conversion */

section('2. every stored file is exactly what the documented conversion produces')

const converted = convert(source.text)
const manifest = manifestFor(converted, AUTHOR)

check(
  'the conversion yields 29 chapters',
  converted.counts.chapters === 29,
  `${converted.counts.chapters}`,
)
check(
  'every horizontal rule in the source is accounted for',
  converted.counts.rulesInFrontMatter +
    converted.counts.structuralRules +
    converted.counts.sceneBreaks ===
    converted.counts.rulesInSource,
  `${converted.counts.rulesInSource} = ${converted.counts.rulesInFrontMatter} front matter + ${converted.counts.structuralRules} structural + ${converted.counts.sceneBreaks} scene breaks`,
)
check(
  'exactly two structural rules per chapter were dropped',
  converted.counts.structuralRules === 2 * converted.counts.chapters,
  `${converted.counts.structuralRules}`,
)

const expectedFiles = [
  ['book.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')],
  ...converted.chapters.map((chapter) => [chapter.file, chapter.buffer]),
]

let payloadMatches = true
for (const [relative, buffer] of expectedFiles) {
  const path = join(BOOK_DIR, relative)
  const onDisk = existsSync(path) ? readFileSync(path) : null
  const same = onDisk !== null && onDisk.equals(buffer)
  if (!same) payloadMatches = false
  check(
    `content/books/${BOOK_SLUG}/${relative}`,
    same,
    same
      ? `${buffer.byteLength} bytes  sha256 ${sha256(buffer).slice(0, 16)}`
      : onDisk === null
        ? 'missing'
        : `on disk ${onDisk.byteLength} bytes, conversion ${buffer.byteLength} bytes`,
  )
}

/* ------------------------------------ 3. the source reconstructs from the payload */

section('3. the locked source reconstructs, line for line, from the stored payload')

if (!payloadMatches) {
  check('reconstruction', false, 'skipped -- the payload does not match the conversion')
} else {
  const stored = JSON.parse(readFileSync(join(BOOK_DIR, 'book.json'), 'utf8'))

  /*
   * Rebuild the single-file manuscript from what is on disk and from nothing
   * else: the manifest's own chapter order, each chapter file's own bytes, and
   * the two structural rules the conversion documented itself as dropping.
   * Then compare with the source.
   */
  const rebuilt = [`# ${stored.title}`, '', `*${stored.subtitle}*`, '', '---']

  const ordered = [...stored.chapters].sort((a, b) => a.number - b.number)

  for (const entry of ordered) {
    const file = readFileSync(join(BOOK_DIR, entry.file), 'utf8')
    const lines = collapseBlanks(file.split('\n'))

    // The file's own heading, back into `## Chapter X` plus `**SUBTITLE**`.
    const heading = lines[0]
    if (heading !== `# ${entry.title}`) {
      check(`${entry.slug}: file opens with its declared heading`, false, heading.slice(0, 60))
      continue
    }

    const body = lines.slice(1)
    while (body.length > 0 && body[0].trim() === '') body.shift()

    // body: [dateline, '', ...chapter body...]
    rebuilt.push(
      '',
      `## ${entry.label}`,
      '',
      `**${entry.subtitle}**`,
      '',
      body[0],
      '',
      '---',
      '',
      ...body.slice(2),
      '',
      '---',
    )
  }

  const expected = collapseBlanks(source.text.split('\n'))
  const actual = collapseBlanks(rebuilt)

  check(
    'the reconstruction has the same number of lines as the source',
    actual.length === expected.length,
    `${actual.length} vs ${expected.length}`,
  )

  let firstDifference = -1
  const limit = Math.min(actual.length, expected.length)
  for (let index = 0; index < limit; index += 1) {
    if (actual[index] !== expected[index]) {
      firstDifference = index
      break
    }
  }
  if (firstDifference === -1 && actual.length !== expected.length) firstDifference = limit

  check(
    'every line of the locked source is present, in order, unchanged',
    firstDifference === -1,
    firstDifference === -1
      ? `${expected.length} lines compared`
      : `first difference at line ${firstDifference + 1}:\n          source  ${JSON.stringify((expected[firstDifference] ?? '<end>').slice(0, 120))}\n          payload ${JSON.stringify((actual[firstDifference] ?? '<end>').slice(0, 120))}`,
  )

  // Said a second way, so a bug in the line walk above cannot pass silently.
  check(
    'the reconstruction hashes to the source (blank runs normalised, N5)',
    sha256(Buffer.from(`${actual.join('\n')}\n`, 'utf8')) ===
      sha256(Buffer.from(`${expected.join('\n')}\n`, 'utf8')),
  )

  /* ------------------------------------------------- chapter-level accounting */

  section('4. chapter accounting')

  check('the manifest lists 29 chapters', ordered.length === 29, `${ordered.length}`)
  check(
    'every chapter is released',
    ordered.every((entry) => entry.status === 'available'),
  )
  check(
    'chapter numbers run 1..29 with no gap and no repeat',
    ordered.every((entry, index) => entry.number === index + 1),
  )
  check(
    'the manifest records the source it was built from',
    stored.source?.sha256 === SOURCE.sha256 &&
      stored.source?.bytes === SOURCE.bytes &&
      stored.source?.chapterHeadings === SOURCE.chapterHeadings,
  )
  check(
    'the book is marked author-only',
    stored.audience === 'author-only',
    String(stored.audience),
  )

  const sourceHeadings = source.text
    .split('\n')
    .filter((line) => /^## Chapter /.test(line))
    .map((line) => line.replace(/^## /, ''))
  check(
    "every source chapter heading appears as a chapter's label, in order",
    sourceHeadings.length === ordered.length &&
      sourceHeadings.every((label, index) => ordered[index].label === label),
  )

  /*
   * A third, deliberately simple-minded pass over the same question, written so
   * that a mistake in the reconstruction above cannot also hide here: take every
   * line of the source that carries prose, walk it against every line of the
   * payload that carries prose, and let the only permitted deviations be the
   * ones the rules name. Nothing is matched by content, only by position, so a
   * reordering fails.
   */
  const isProse = (line) => line.trim() !== '' && !RULE.test(line) && !line.startsWith('#')

  const sourceProse = collapseBlanks(source.text.split('\n')).filter(isProse)
  const payloadProse = ordered.flatMap((entry) =>
    collapseBlanks(readFileSync(join(BOOK_DIR, entry.file), 'utf8').split('\n'))
      .slice(1)
      .filter(isProse),
  )

  // What the rules move out of the prose stream: the front matter's `*A novel*`
  // (N1) and each chapter's `**SECTION TITLE**` line (N3), in chapter order.
  const moved = [`*${stored.subtitle}*`, ...ordered.map((entry) => `**${entry.subtitle}**`)]
  const remainder = []
  let movedIndex = 0
  for (const line of sourceProse) {
    if (movedIndex < moved.length && line === moved[movedIndex]) {
      movedIndex += 1
      continue
    }
    remainder.push(line)
  }

  check(
    'the lines the rules move into metadata are exactly the 30 they name',
    movedIndex === moved.length,
    `${movedIndex} of ${moved.length} found, in order`,
  )
  check(
    'every remaining prose line of the source is carried into a chapter file',
    remainder.length === payloadProse.length,
    `${payloadProse.length} carried, ${remainder.length} expected, ${sourceProse.length} prose lines in source`,
  )
  const proseDifference = remainder.findIndex((line, index) => line !== payloadProse[index])
  check(
    'the carried prose lines are identical, in order',
    proseDifference === -1,
    proseDifference === -1
      ? `${remainder.length} lines compared`
      : `first difference at prose line ${proseDifference + 1}`,
  )
}

/* ------------------------------------------------------------------- result */

console.log(`\n${failures === 0 ? 'OK' : 'FAILED'} -- ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
