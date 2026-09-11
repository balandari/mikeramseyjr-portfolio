/**
 * Generating a reviewer's access code.
 *
 * One job, deliberately separated from both the gate that checks codes and the
 * roster that stores their fingerprints, because this is the only place in the
 * codebase where a code exists in plaintext at all. It exists here for the
 * length of one function call and is handed straight back to the caller, which
 * shows it to Mike exactly once and never writes it down.
 *
 * Built on Web Crypto rather than `node:crypto` so the same implementation runs
 * in every runtime this project uses, exactly as `lib/reviewer-access.ts` does.
 */

/*
 * Crockford-style alphabet: no I, L, O, U, 0 or 1. A code gets read over the
 * phone and typed on a handset, so characters that are misread as each other
 * are simply not in it. 30 symbols over 16 characters is a little over 78 bits.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'
const CODE_LENGTH = 16
const GROUP = 4

/**
 * A uniformly distributed index into the alphabet.
 *
 * `% ALPHABET.length` on a raw byte would be biased -- 256 is not a multiple of
 * 30, so the first 16 symbols would come up slightly more often. Values in the
 * biased tail are discarded and redrawn instead, which costs a negligible
 * number of extra bytes and keeps every code equally likely.
 */
function unbiasedIndex(): number {
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length
  const byte = new Uint8Array(1)
  for (;;) {
    crypto.getRandomValues(byte)
    if (byte[0] < limit) return byte[0] % ALPHABET.length
  }
}

/**
 * One access code, grouped in fours for reading aloud and typing.
 *
 * The dashes are presentation: `normalizeAccessCode()` strips them before
 * anything is fingerprinted or compared, so a code typed with or without them
 * verifies identically.
 */
export function generateAccessCode(): string {
  let raw = ''
  for (let i = 0; i < CODE_LENGTH; i += 1) raw += ALPHABET[unbiasedIndex()]
  return (raw.match(new RegExp(`.{1,${GROUP}}`, 'g')) ?? [raw]).join('-')
}
