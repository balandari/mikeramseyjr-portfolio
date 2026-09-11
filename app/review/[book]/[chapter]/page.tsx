import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { notFound, redirect } from 'next/navigation'

import {
  REVIEWER_COOKIE_NAME,
  reviewerMayRead,
  reviewerStorageNamespace,
} from '@/lib/reviewer-access'
import { authorizeReviewer } from '@/lib/reviewer-authorization'
import { findBook, findReleasedChapter, releasedChapters } from '@/lib/manuscript'
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
  const store = await cookies()
  const reviewer = await authorizeReviewer(store.get(REVIEWER_COOKIE_NAME)?.value)

  // Second, independent enforcement. The request boundary already turns an
  // unauthorized caller away; this refuses even to load the prose if it did not.
  if (!reviewer) redirect('/review/login')
  if (!reviewerMayRead(reviewer, params.book)) notFound()

  const book = findBook(params.book)
  if (!book) notFound()

  // Draft chapters resolve to null here, so an unreleased chapter is a 404 even
  // for an entitled reviewer who guesses its URL.
  const chapter = findReleasedChapter(book, params.chapter)
  if (!chapter) notFound()

  const ordered = releasedChapters(book)
  const index = ordered.findIndex((entry) => entry.slug === chapter.slug)
  const previous = index > 0 ? ordered[index - 1] : null
  const next = index >= 0 && index < ordered.length - 1 ? ordered[index + 1] : null

  /*
   * The paragraph's plain text is dropped here rather than sent to the browser.
   * The reader renders from `segments`, and the exact passage a comment is
   * about is resolved server-side from the verified manuscript when the comment
   * is stored -- so the quote on a feedback row can never be something the
   * browser supplied.
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

  return (
    <div className="rv-root">
      <ReviewAppearance namespace={await reviewerStorageNamespace(reviewer)} />

      <ChapterReader
        namespace={await reviewerStorageNamespace(reviewer)}
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
      />
    </div>
  )
}
