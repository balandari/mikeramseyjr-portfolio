/**
 * Grouping an access code for a human to read back.
 *
 * A reviewer is handed a code that looks like `ABCD-EFGH-JKLM-NPQR` and, on a
 * phone, types it into a box that shows it back as one unbroken run. It is hard
 * to check a code against a message that way, and harder to find the place you
 * went wrong. These two functions are the whole of the fix: one regroups a
 * value, the other says where the caret belongs afterwards.
 *
 * **This is presentation, and it changes nothing about what is accepted.** The
 * server receives whatever the field holds and runs it through
 * `normalizeAccessCode`, which upper-cases and strips every non-alphanumeric
 * character before anything is compared or fingerprinted. A code typed with
 * dashes, without them, with the wrong ones, or in lower case has always
 * verified identically, and still does.
 *
 * Dependency-free on purpose -- no React, no JSX -- so the logic can be tested
 * directly rather than through a component.
 */

/** The characters a code is made of. Everything else is punctuation to re-derive. */
const ALNUM = /[A-Z0-9]/
const GROUP = 4

/**
 * Strip to the characters that matter, upper-case, and regroup in fours.
 *
 * The grouping is always re-derived from scratch rather than patched, so there
 * is no state to get out of step and no sequence of edits that can leave a
 * stray dash behind. It also means a paste of the code as printed, a paste with
 * no dashes, and a paste with spaces all produce the same thing.
 */
export function groupAccessCode(raw: string): string {
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (clean === '') return ''
  /*
   * A dash after every fourth character, but never a trailing one. A trailing
   * dash would sit directly under the caret and be the first thing the next
   * keystroke deleted, which makes the field feel like it is fighting back.
   */
  return clean.replace(new RegExp(`(.{${GROUP}})(?=.)`, 'g'), '$1-')
}

/** How many real characters sit before this offset. */
export function alnumBefore(value: string, offset: number): number {
  let count = 0
  for (let i = 0; i < offset && i < value.length; i += 1) {
    if (ALNUM.test(value[i].toUpperCase())) count += 1
  }
  return count
}

/**
 * Where the caret belongs after regrouping.
 *
 * Counted in real characters rather than in string offsets, because the dashes
 * move as the value grows. Typing the fourth character of a group leaves the
 * caret *after* the dash that character just caused, so the next keystroke
 * continues the next group instead of landing before the separator.
 */
export function caretAfterGrouping(formatted: string, realCharacters: number): number {
  if (realCharacters <= 0) return 0

  let seen = 0
  for (let i = 0; i < formatted.length; i += 1) {
    if (!ALNUM.test(formatted[i])) continue
    seen += 1
    if (seen === realCharacters) {
      const next = i + 1
      return formatted[next] === '-' ? next + 1 : next
    }
  }
  return formatted.length
}
