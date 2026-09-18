import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/*
 * Guards against stray control bytes landing in source text -- the kind a
 * bad find-and-replace or a corrupted paste can leave behind invisibly (see
 * the two raw backspace bytes this suite's sibling change removed from
 * tests/note-composer.test.ts). A byte in this range renders as nothing or
 * as a caret-escape depending on the tool, so it survives casual review.
 */

const REPO_ROOT = process.cwd()

const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.json',
  '.md',
  '.css',
  '.scss',
  '.html',
  '.py',
  '.yml',
  '.yaml',
  '.txt',
])

const TEXT_BASENAMES = new Set(['.gitignore', '.gitattributes'])

function isTextSourceFile(relPath: string): boolean {
  const base = path.basename(relPath)
  if (TEXT_BASENAMES.has(base)) return true
  return TEXT_EXTENSIONS.has(path.extname(relPath))
}

function listTrackedAndUntrackedFiles(): string[] {
  const output = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  )
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * Is this a valid UTF-8 byte sequence?
 *
 * **One predicate, used twice**, and that is the point of it existing at all.
 * The real-tree scan below calls it, and so does the counterexample test
 * underneath -- so the thing the scan trusts is the thing something else
 * independently proves discriminates. A predicate only the clean tree exercises
 * is a predicate nothing checks: it passes for the same reason `() => true`
 * would.
 *
 * `TextDecoder` with `fatal: true` **throws** on a malformed sequence, which is
 * what "strict" has to mean here. The check this replaced decoded leniently and
 * compared re-encoded byte length to original length, reasoning that a
 * substituted replacement character would change the length. It does not,
 * always: `f0 9a 80` is a truncated four-byte sequence that decodes to one
 * U+FFFD, and U+FFFD encodes to three bytes -- so three bytes in, three bytes
 * out, and the malformed sequence passed. The test below pins exactly that.
 */
function isValidUtf8(bytes: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

// Tab (0x09), LF (0x0A), and CR (0x0D) are ordinary text bytes and stay allowed.
function findProhibitedControlByte(bytes: Buffer): number {
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    const isProhibited =
      (b <= 0x08) ||
      b === 0x0b ||
      b === 0x0c ||
      (b >= 0x0e && b <= 0x1f) ||
      b === 0x7f
    if (isProhibited) return i
  }
  return -1
}

test('no tracked or untracked source file contains a prohibited control byte', () => {
  const files = listTrackedAndUntrackedFiles().filter(isTextSourceFile)
  assert.ok(files.length > 0, 'expected to find at least one text/source file to scan')

  const offenders: string[] = []
  for (const relPath of files) {
    const absPath = path.join(REPO_ROOT, relPath)
    const bytes = readFileSync(absPath)

    // Strict UTF-8 decode: a malformed byte sequence is itself a defect.
    assert.ok(isValidUtf8(bytes), `${relPath} is not valid UTF-8`)

    const offset = findProhibitedControlByte(bytes)
    if (offset !== -1) {
      offenders.push(`${relPath}@${offset} (0x${bytes[offset].toString(16).padStart(2, '0')})`)
    }
  }

  assert.deepEqual(offenders, [], `prohibited control bytes found: ${offenders.join(', ')}`)
})

test('the UTF-8 predicate the scan uses rejects sequences the length check let through', () => {
  // Ordinary text, including multi-byte characters, is accepted -- a predicate
  // that rejected everything would pass every rejection assertion below.
  assert.equal(isValidUtf8(Buffer.from('plain ascii\n', 'utf8')), true)
  assert.equal(isValidUtf8(Buffer.from('an em dash \u2014 and an emoji \u{1F600}\n', 'utf8')), true)
  // A literal U+FFFD is a real character and valid UTF-8; only malformed bytes
  // are the defect, so the predicate must not be a replacement-character hunt.
  assert.equal(isValidUtf8(Buffer.from('\uFFFD', 'utf8')), true)

  // The Judge's counterexample, plus one from each of the other two families of
  // malformed sequence. Names, so a failure says which family regressed.
  const invalid: [string, Buffer][] = [
    ['truncated four-byte sequence', Buffer.from([0xf0, 0x9a, 0x80])],
    ['overlong two-byte encoding of "/"', Buffer.from([0xc0, 0xaf])],
    ['lone continuation byte', Buffer.from([0x80])],
  ]

  for (const [name, bytes] of invalid) {
    assert.equal(isValidUtf8(bytes), false, `${name} was accepted as valid UTF-8`)
  }

  /*
   * And the discriminator: the check this replaced **accepted** the truncated
   * sequence. Node decodes those three bytes to one U+FFFD, which re-encodes to
   * three bytes, so the length comparison found nothing wrong. Asserting the old
   * rule's own answer here is what makes the replacement provably a change in
   * behaviour rather than a change in spelling.
   */
  const truncated = Buffer.from([0xf0, 0x9a, 0x80])
  assert.equal(
    Buffer.byteLength(truncated.toString('utf8'), 'utf8'),
    truncated.length,
    'the former length heuristic is being credited with a rejection it never made',
  )

  // None of the three carries a prohibited control byte either, so the rest of
  // the scan would not have caught any of them on the decode check's behalf.
  for (const [name, bytes] of invalid) {
    assert.equal(findProhibitedControlByte(bytes), -1, `${name} was caught by the control-byte rule`)
  }
})
