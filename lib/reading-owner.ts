/**
 * The author's own reading namespace.
 *
 * Mike reads his manuscripts as himself, not as a reviewer. That has to be true
 * in the storage layout and not merely in the interface, or "author reading"
 * would be a reviewer session wearing a different label -- and every worry the
 * assignment names (creating a reviewer identity, moving a reviewer's
 * last-opened time, writing into reviewer feedback) would be one bug away.
 *
 * So the author is a distinct owner kind with a distinct id, and every path
 * built for him begins `reading/v1/author/...`. No reviewer prefix is ever
 * constructed from an author session, so a stray write cannot land in one.
 *
 * ## Why the id is derived rather than the address
 *
 * The obvious id is the administrator's email address, and it is the wrong one:
 * it would put a real person's address into a storage pathname, into a listing,
 * and into anything that ever exports one. Instead the id is a keyed
 * (HMAC-SHA-256) derivation of the address under a domain-separated label,
 * rendered as hex and truncated. It is:
 *
 *   - **stable** -- the same address always derives the same id, so Mike's
 *     bookmarks are still his after signing out and back in;
 *   - **opaque** -- it discloses nothing about the address;
 *   - **not reversible by guessing**, because it is keyed with
 *     `ADMIN_AUTH_SECRET` rather than being a bare hash of a short, guessable
 *     string;
 *   - **path-safe** -- hex only, so it satisfies the storage id pattern with no
 *     escaping anywhere.
 *
 * Built on Web Crypto rather than `node:crypto` so it behaves identically
 * wherever it is called, exactly as the reviewer and admin token modules do.
 */

const encoder = new TextEncoder()

/**
 * Domain separation. An author owner id can never collide with, or be produced
 * by, any other derivation that uses the same administrator secret.
 */
const OWNER_LABEL = 'mikeramseyjr/author-reading/v1'

/** Length of the derived id in hex characters: 96 bits. */
const OWNER_ID_LENGTH = 24

function adminSecret(): string {
  // Read through a literal `process.env.NAME` so a build that only carries
  // statically visible variables still sees it.
  const value = process.env.ADMIN_AUTH_SECRET
  return typeof value === 'string' ? value.trim() : ''
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * The author's storage owner id for one administrator address, or null when no
 * administrator secret is configured.
 *
 * Null is a refusal, not a fallback. A deployment with no `ADMIN_AUTH_SECRET`
 * cannot mint an administrator session either, so there is no situation in
 * which a caller legitimately has an author session and no secret -- and
 * inventing a constant id for that case would put every deployment's author
 * records in one shared namespace.
 */
export async function authorOwnerId(email: string): Promise<string | null> {
  const secret = adminSecret()
  if (!secret) return null

  const normalized = email.trim().toLowerCase()
  if (normalized === '') return null

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${OWNER_LABEL}|${normalized}`),
  )

  return toHex(mac).slice(0, OWNER_ID_LENGTH)
}
