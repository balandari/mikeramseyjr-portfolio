#!/usr/bin/env node
/**
 * reviewer-code.mjs -- issue one reviewer's access code.
 *
 * Generates a high-entropy code, prints it once, and prints the roster entry to
 * paste into `REVIEWER_ROSTER`. The roster entry contains a keyed fingerprint of
 * the code, never the code itself, so the roster can live in an environment
 * variable without the codes ever existing anywhere but in the reviewer's hands.
 *
 * Since the roster became runtime state, the usual way to issue a code is the
 * dashboard at `/admin`, which does the same thing and writes the entry for you.
 * This script remains for a deployment running the read-only environment roster,
 * and for issuing a code without opening a browser.
 *
 * The printed code is the ONLY time it is ever shown. It is not written to a
 * file, not stored, and cannot be recovered afterwards -- not from the roster,
 * not from a cookie, not from this repository. If it is lost, issue a new one:
 * replacing that reviewer's entry revokes their old code and their existing
 * sessions, and affects no other reviewer.
 *
 * Usage:
 *   REVIEWER_AUTH_SECRET=... node scripts/reviewer-code.mjs \
 *     --id anna --name "Anna" --books the-backward-becoming
 *
 *   # re-fingerprint a code you already issued (does not generate a new one)
 *   REVIEWER_AUTH_SECRET=... node scripts/reviewer-code.mjs \
 *     --id anna --name "Anna" --books the-backward-becoming --code ABCD-EFGH-...
 */

import { fingerprintAccessCode, normalizeAccessCode } from '../lib/reviewer-access.ts'
import { generateAccessCode } from '../lib/reviewer-code.ts'

/*
 * The generator itself lives in `lib/reviewer-code.ts`, so this script and the
 * dashboard at `/admin` issue codes from one implementation rather than two
 * that could drift apart.
 */

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return null
  const value = process.argv[index + 1]
  return typeof value === 'string' && !value.startsWith('--') ? value : null
}

function fail(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}

const id = arg('id')
const name = arg('name')
const books = arg('books')
const provided = arg('code')

if (!id) fail('--id is required (lowercase letters, digits, - and _)')
if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) fail(`--id "${id}" is not a valid reviewer id`)
if (!name) fail('--name is required')
if (!books) fail('--books is required (comma-separated book slugs)')

if (!process.env.REVIEWER_AUTH_SECRET) {
  fail(
    'REVIEWER_AUTH_SECRET must be set, and must be the same secret the deployment uses.\n' +
      '       A fingerprint made under a different secret will never match.',
  )
}

const bookSlugs = books
  .split(',')
  .map((slug) => slug.trim())
  .filter(Boolean)

for (const slug of bookSlugs) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) fail(`"${slug}" is not a valid book slug`)
}

const code = provided ?? generateAccessCode()

if (normalizeAccessCode(code).length < 12) {
  fail('an access code must normalise to at least 12 characters')
}

const codeHash = await fingerprintAccessCode(code)
if (!codeHash) fail('could not fingerprint the code')

const entry = { id, name, books: bookSlugs, codeHash }

console.log('')
console.log('  Access code for %s  (shown once, never stored):', name)
console.log('')
console.log('      %s', code)
console.log('')
console.log('  Send it to them directly. Do not commit it, paste it into a ticket,')
console.log('  or keep it in a note. It cannot be recovered from anything below.')
console.log('')
console.log('  Roster entry -- add this object to REVIEWER_ROSTER:')
console.log('')
console.log('      %s', JSON.stringify(entry))
console.log('')
