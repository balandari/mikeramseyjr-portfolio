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

import type { ReadingObjects } from './reviewer-reading.ts'

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
