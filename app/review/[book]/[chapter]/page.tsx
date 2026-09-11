import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'

import { reviewerStorageNamespace } from '@/lib/reviewer-access'
import { reviewerContext } from '@/lib/reading-session'
import { loadBookReading } from '@/lib/reading-service'
import { findReleasedChapter, releasedChapters } from '@/lib/manuscript'
import ReviewAppearance from '../../ReviewAppearance'
import ChapterReader, { type ReaderClientBlock } from './ChapterReader'

/**
 * Rendered per request behind the gate, never prerendered. A static render
 * would publish an unpublished manuscript as a build artifact that no
 * request-time check could take back.
 */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Advance reading',
  robots: { index: false, follow: false, noarchive: true, nocache: true },
}

export default async function ChapterPage({
  params,
}: {
  params: { book: string; chapter: string }
}) {
  const context = await reviewerContext()

  // Second, independent enforcement. The request boundary already turns an
  // unauthorized caller away; this refuses even to load the prose if it did not.
  if (!context) redirect('/review/login')

  /*
   * Entitlement, the book, and this reviewer's own reading records, in one
   * call. `loadBookReading` refuses a book this reviewer may not read and a
   * book the site has not loaded with the same answer, so an unentitled
   * reviewer gets the same 404 as a book that does not exist -- "you may not
   * read this" and "this is not here" must be indistinguishable, or the reader
   * becomes a way to enumerate unpublished work.
   */
  const reading = await loadBookReading(context.viewer, params.book)
  if (!reading.ok) notFound()

  const { book, position, bookmarks, annotations } = reading.value

  // Draft chapters resolve to null here, so an unreleased chapter is a 404 even
  // for an entitled reviewer who guesses its URL.
  const chapter = findReleasedChapter(book, params.chapter)
  if (!chapter) notFound()

  const ordered = releasedChapters(book)
  const index = ordered.findIndex((entry) => entry.slug === chapter.slug)
  const previous = index > 0 ? ordered[index - 1] : null
  const next = index >= 0 && index < ordered.length - 1 ? ordered[index + 1] : null

  /*
   * The paragraph's plain text is dropped here rather than sent to the browser
   * as a second copy. The reader renders from `segments`, whose characters are
   * exactly the text an annotation's offsets are measured against -- so the
   * browser and the server agree about what character 12 is without either
   * having to describe the other's markup.
   */
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

  const namespace = await reviewerStorageNamespace(context.reviewer)

  return (
    <div className="rv-root">
      <ReviewAppearance namespace={namespace} />

      <ChapterReader
        namespace={namespace}
        endpoint={{ url: '/review/api/reading' }}
        bookBase={`/review/${book.slug}`}
        workspaceHref="/review/my-reading"
        feedbackEnabled
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
