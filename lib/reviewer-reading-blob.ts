/**
 * Private reading records: the Vercel Blob object layer.
 *
 * This is the production driver for `lib/reviewer-reading.ts`, and it is
 * deliberately tiny: four operations on opaque paths. Every rule about *which*
 * path may be built -- the owner prefix, the book prefix, the pattern checks --
 * lives in the store above, so it is written once and applies identically to
 * the filesystem driver and to this one.
 *
 * It introduces nothing new. It uses the `@vercel/blob` package the project
 * already depends on, the same private store, and the same
 * `BLOB_READ_WRITE_TOKEN` the reviewer feedback and roster stores already use.
 * There is no new vendor, no new account, no new plan and no new secret.
 *
 * Two differences from the feedback driver, both intentional:
 *
 *   **Objects here may be replaced.** Feedback is evidence and is written with
 *   `allowOverwrite: false`. A reading position is overwritten by definition,
 *   an annotation's sharing is changed by its owner, and a bookmark is removed.
 *   So `put` replaces and `del` exists. What keeps that safe is not the store
 *   refusing -- it is that a path is only ever built from the authenticated
 *   owner's own prefix, so the path that would name somebody else's record is
 *   never constructed.
 *
 *   **A failed read rejects; a missing object returns null.** The distinction is
 *   the same one the feedback driver makes, for the same reason: an outage that
 *   reported itself as "nothing there" would tell a reviewer they had no
 *   bookmarks, which looks like an answer and is a lie.
 */

if (typeof window !== 'undefined') {
  throw new Error(
    'lib/reviewer-reading-blob is server-only and must not be imported by a client component',
  )
}

import type { ReadingObjects, VersionedReadingObject } from './reviewer-reading.ts'

/**
 * True when this error is the service's way of saying the pathname was taken.
 *
 * Mirrors `lib/private-store.ts`, narrowly and for the same reason: the SDK has
 * no typed class for the `allowOverwrite: false` refusal, so it is matched on
 * its message, and only where a refusal is a meaningful answer. Anything else
 * re-throws, because a credential or network failure reported as "somebody else
 * got there first" would silently skip a write.
 */
function looksLikeExistenceConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  return message.includes('already exists') || message.includes('allowoverwrite')
}

/**
 * The complete sentence the live probe recorded, verbatim -- twice now, on two
 * different operations.
 *
 * The September 14 V8 run recorded it from a conditional **delete** of a
 * pathname that was never written. The September 19 P3.1 run recorded the same
 * class and the same complete sentence from a conditional **write** naming the
 * revision of an object that had since been deleted -- which is exactly the
 * call `putIfMatch` below makes, and exactly the interleaving
 * `NoteStore.updateNote` depends on. So both mappings in this file now rest on
 * a run that watched the real service produce this shape on that operation,
 * rather than on the other operation's evidence being borrowed.
 *
 * Copied from `lib/private-store.ts`, which is where the live evidence for it
 * is written down, rather than imported: that module is the *other* private
 * store's driver, it reads `REVIEWER_ROSTER_DRIVER`, and importing a value from
 * it here would pull its factory and its environment reading into this module's
 * graph for the sake of one string. `tests/blob-refusal-mapping.test.ts` holds
 * the two copies identical, so the duplication cannot drift.
 */
const MISSING_OBJECT_MESSAGE = 'Vercel Blob: The specified key does not exist.'

/**
 * True only for the SDK's base `BlobError` itself, carrying exactly that
 * sentence -- the "demonstrated provider shape" rule `lib/private-store.ts`
 * states in full.
 *
 * `Object.getPrototypeOf(...) === BlobError.prototype` rather than
 * `instanceof`, because every typed class on this SDK extends `BlobError`;
 * `BlobStoreNotFoundError` in particular is a credential or configuration
 * failure sharing three words with this refusal, and a store that cannot be
 * reached says nothing about whether an object is there. The message is
 * compared whole and case-sensitively: a superset is a different error quoting
 * a familiar phrase, not the evidence. If the service ever rewords it, the
 * match stops holding and the error propagates as unknown -- which is the only
 * safe direction for drift on a removal.
 */
function looksLikeMissingObject(
  error: unknown,
  blobErrorClass: { prototype: unknown },
): boolean {
  return (
    error instanceof Error &&
    Object.getPrototypeOf(error) === blobErrorClass.prototype &&
    error.message === MISSING_OBJECT_MESSAGE
  )
}

/**
 * The real object layer, over the official SDK.
 *
 * The token is held in this closure and passed explicitly on every call rather
 * than left to ambient environment lookup, so there is one place it is read and
 * one place it is used. It is never logged, never returned, and never part of a
 * value this module hands back.
 */
export function createVercelBlobReadingObjects(options: {
  token?: string
  objects?: ReadingObjects
}): ReadingObjects {
  if (options.objects) return options.objects

  const token = (options.token ?? '').trim()
  if (!token) {
    throw new Error('REVIEWER_FEEDBACK_DRIVER=vercel-blob requires BLOB_READ_WRITE_TOKEN')
  }

  return {
    driver: 'vercel-blob',
    durable: true,

    async get(path) {
      const { get } = await import('@vercel/blob')
      const result = await get(path, { token, access: 'private', useCache: false })
      if (!result?.stream) return null
      return await new Response(result.stream).text()
    },

    async getVersioned(path): Promise<VersionedReadingObject> {
      const { get } = await import('@vercel/blob')
      const result = await get(path, { token, access: 'private', useCache: false })
      if (!result?.stream) return { body: null, version: null }
      return {
        body: await new Response(result.stream).text(),
        version: result.blob?.etag ?? null,
      }
    },

    /**
     * `put(..., { ifMatch })`, which the installed SDK (`@vercel/blob@2.8.0`)
     * documents and which fails with `BlobPreconditionFailedError` when the
     * stored ETag has moved on. With no ETag to match the write means "this
     * must not exist yet", which is `allowOverwrite: false` -- the SDK refuses
     * the two options together as contradictory.
     *
     * Exactly as in `lib/private-store.ts`, what cannot be established from
     * this machine is whether the live service enforces the precondition under
     * genuine concurrency. `scripts/blob-probe.mjs` is what settles that, and
     * it is recorded here rather than assumed.
     *
     * ## The third shape, and why it is a conflict
     *
     * The September 19 P3.1 live run did exactly what this method does -- a
     * conditional put naming the revision of an object deleted after that
     * revision was read -- and the service **refused it and created nothing**:
     * the object was absent before the write and absent after it. But the
     * refusal arrived as neither typed class. It arrived on the SDK's
     * `bad_request` branch, a base `BlobError` carrying the service's own
     * words:
     *
     *     Vercel Blob: The specified key does not exist.
     *
     * Rethrown, that safe refusal became an unhandled failure: `updateNote`
     * never reached `if (!written) return { outcome: 'conflict' }`, so the
     * caller saw a 500 where the design says "somebody else changed this".
     * Mapped here it becomes the honest answer it always was -- *nothing was
     * written by this call* -- which is precisely true, because the object is
     * not there.
     *
     * It is scoped to the conditional branch, the way
     * `lib/private-store.ts:putIfMatch` scopes its own untyped sentence with
     * `etag !== null`. With `version === null` this method sends no
     * conditional request at all; it sends `allowOverwrite: false`, a create,
     * which was never demonstrated to receive this answer and could not
     * honestly be refused for naming a revision it did not name. There the
     * error stays unknown and propagates.
     *
     * And it is the demonstrated *shape* -- base class plus the complete
     * sentence -- not the phrase. `looksLikeMissingObject` above says why that
     * distinction is the whole safety of it.
     */
    async putIfMatch(path, body, version) {
      const { put, BlobError, BlobPreconditionFailedError } = await import('@vercel/blob')
      try {
        await put(path, body, {
          token,
          access: 'private',
          contentType: 'application/json; charset=utf-8',
          addRandomSuffix: false,
          ...(version === null ? { allowOverwrite: false } : { ifMatch: version }),
        })
        return true
      } catch (error) {
        if (error instanceof BlobPreconditionFailedError) return false
        if (version === null && looksLikeExistenceConflict(error)) return false
        if (version !== null && looksLikeMissingObject(error, BlobError)) return false
        throw error
      }
    },

    async put(path, body) {
      const { put } = await import('@vercel/blob')
      await put(path, body, {
        token,
        access: 'private',
        contentType: 'application/json; charset=utf-8',
        // Replacement is the point here -- see the module comment. The path is
        // the record's identity, so a random suffix would turn one record into
        // an ever-growing pile of stale copies.
        allowOverwrite: true,
        addRandomSuffix: false,
      })
    },

    async del(path) {
      const { del } = await import('@vercel/blob')
      await del(path, { token })
    },

    /**
     * `del(..., { ifMatch })`, mapped exactly as
     * `PrivateBlobBackend.deleteIfMatch` in `lib/private-store.ts` maps it, and
     * for the identical reason -- the same three provider shapes mean the same
     * one thing to a caller:
     *
     *     nothing was removed by this call.
     *
     *   `BlobPreconditionFailedError`  the typed refusal: the stored ETag has
     *                                  moved on, so the revision named is not
     *                                  the revision stored.
     *   `BlobNotFoundError`            the typed absence.
     *   base `BlobError` + the exact   the *untyped* absence the September 14
     *   sentence above                 V8 run actually recorded from the live
     *                                  service, which was rethrown before
     *                                  `lib/private-store.ts` learned it.
     *
     * Anything else rejects. The behaviour this method requires of the provider
     * -- that a conditional delete naming an object which does not exist must
     * not report success -- is what `scripts/blob-probe.mjs` V8 establishes and
     * fails closed on. The unconditional `del` above *does* resolve for a
     * missing object, which is precisely why a note's deletion does not use it.
     */
    async delIfMatch(path, version) {
      const { del, BlobError, BlobNotFoundError, BlobPreconditionFailedError } =
        await import('@vercel/blob')
      try {
        await del(path, { token, ifMatch: version })
        return true
      } catch (error) {
        if (error instanceof BlobPreconditionFailedError) return false
        if (error instanceof BlobNotFoundError) return false
        if (looksLikeMissingObject(error, BlobError)) return false
        throw error
      }
    },

    async list(prefix) {
      const { list } = await import('@vercel/blob')
      const paths: string[] = []
      let cursor: string | undefined

      // Follow the cursor to the end. Stopping at the first page would quietly
      // hide a reviewer's older bookmarks once they had made enough of them.
      for (;;) {
        const page = await list({ token, prefix, cursor })
        for (const blob of page.blobs) paths.push(blob.pathname)
        if (!page.hasMore || !page.cursor) break
        cursor = page.cursor
      }

      return paths
    },
  }
}
