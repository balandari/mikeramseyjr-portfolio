import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { notFound, redirect } from 'next/navigation'

import { ADMIN_COOKIE_NAME, adminCsrfToken } from '@/lib/admin-auth'
import { authorContext } from '@/lib/reading-session'
import { loadBookReading } from '@/lib/reading-service'
import { findReleasedChapter, releasedChapters } from '@/lib/manuscript'
import ChapterReader, {
  type ReaderClientBlock,
} from '../../../../review/[book]/[chapter]/ChapterReader'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Read my books',
  description: 'Administration.',
  keywords: null,
  robots: { index: false, follow: false, noarchive: true, nocache: true },
}

/**
 * Mike reading a chapter of his own book.
 *
 * It is the same reading surface, given a different endpoint and told not to
 * offer reviewer feedback. That last part matters and is not cosmetic: the
 * author has no reviewer identity, so there is nothing for a reviewer comment
 * to be attributed to, and the control is therefore absent rather than present
 * and failing. The reviewer feedback endpoint would refuse him anyway -- it
 * authorises against the reviewer cookie, which he does not have.
 *
 * Everything he *does* save here -- his place, his bookmarks, his notes -- is
 * written under the author owner prefix by `/admin/api/reading`, which cannot
 * construct a reviewer path at all.
 */
export default async function AdminChapterPage({
  params,
}: {
  params: { book: string; chapter: string }
}) {
  const context = await authorContext()
  if (!context) {
    redirect(
      `/admin/login?next=${encodeURIComponent(`/admin/read/${params.book}/${params.chapter}`)}`,
    )
  }

  const store = await cookies()
  const token = store.get(ADMIN_COOKIE_NAME)?.value
  const csrf = token ? await adminCsrfToken(token) : null
  if (!csrf) redirect('/admin/login?error=unconfigured')

  const reading = await loadBookReading(context.viewer, params.book)
  if (!reading.ok) notFound()

  const { book, position, bookmarks, annotations } = reading.value

  const chapter = findReleasedChapter(book, params.chapter)
  if (!chapter) notFound()

  const ordered = releasedChapters(book)
  const index = ordered.findIndex((entry) => entry.slug === chapter.slug)
  const previous = index > 0 ? ordered[index - 1] : null
  const next = index >= 0 && index < ordered.length - 1 ? ordered[index + 1] : null

  const blocks: ReaderClientBlock[] = chapter.blocks.map((block) =>
    block.kind === 'paragraph'
      ? {
          kind: 'paragraph',
          id: block.id,
          ordinal: block.ordinal,
          dateline: block.dateline,
          segments: block.segments,
        }
      : { kind: 'scene-break', id: block.id },
  )

  return (
    <div className="rv-root">
      <ChapterReader
        // The author's appearance settings are his own key in his own browser,
        // and cannot collide with a reviewer's on the same machine.
        namespace={`author-${context.viewer.id.slice(0, 12)}`}
        endpoint={{ url: '/admin/api/reading', csrf }}
        bookBase={`/admin/read/${book.slug}`}
        workspaceHref="/admin/read"
        feedbackEnabled={false}
        book={{ slug: book.slug, title: book.title }}
        chapter={{
          slug: chapter.slug,
          number: chapter.number,
          title: chapter.title,
          label: chapter.label,
          subtitle: chapter.subtitle,
          paragraphCount: chapter.paragraphCount,
          minutes: chapter.minutes,
        }}
        blocks={blocks}
        contents={ordered.map((entry) => ({
          slug: entry.slug,
          number: entry.number,
          label: entry.label,
          subtitle: entry.subtitle,
          minutes: entry.minutes,
        }))}
        previousSlug={previous?.slug ?? null}
        nextSlug={next?.slug ?? null}
        initial={{ position, bookmarks, annotations }}
      />
    </div>
  )
}
