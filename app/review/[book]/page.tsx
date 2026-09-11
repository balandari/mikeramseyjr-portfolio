import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { reviewerStorageNamespace } from '@/lib/reviewer-access'
import { reviewerContext } from '@/lib/reading-session'
import { loadBookReading } from '@/lib/reading-service'
import { releasedChapters } from '@/lib/manuscript'
import ReviewAppearance from '../ReviewAppearance'
import ResumeCard from '../ResumeCard'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Advance reading',
  robots: { index: false, follow: false, noarchive: true, nocache: true },
}

/**
 * One book's table of contents, with what this reviewer has made in it.
 *
 * Entitlement is checked before the book is loaded, and a reviewer who is not
 * entitled gets the same 404 as a book that does not exist. That is deliberate:
 * "you may not read this" and "this is not here" must be indistinguishable, or
 * the reader becomes a way to enumerate unpublished work.
 */
export default async function BookPage({ params }: { params: { book: string } }) {
  const context = await reviewerContext()
  if (!context) redirect('/review/login')

  const reading = await loadBookReading(context.viewer, params.book)
  if (!reading.ok) notFound()

  const { book, position, bookmarks, annotations } = reading.value
  const chapters = releasedChapters(book)
  const namespace = await reviewerStorageNamespace(context.reviewer)
  const minutes = chapters.reduce((total, chapter) => total + chapter.minutes, 0)

  // How many bookmarks and marked passages sit in each chapter, so the contents
  // shows where the reviewer has been working without opening anything.
  const perChapter = new Map<string, { bookmarks: number; annotations: number }>()
  for (const bookmark of bookmarks) {
    const row = perChapter.get(bookmark.chapterSlug) ?? { bookmarks: 0, annotations: 0 }
    row.bookmarks += 1
    perChapter.set(bookmark.chapterSlug, row)
  }
  for (const annotation of annotations) {
    const row = perChapter.get(annotation.chapterSlug) ?? { bookmarks: 0, annotations: 0 }
    row.annotations += 1
    perChapter.set(annotation.chapterSlug, row)
  }

  return (
    <div className="rv-root">
      <ReviewAppearance namespace={namespace} />

      <header className="rv-bar">
        <Link href="/review" className="rv-icon-btn" aria-label="All titles">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </Link>
        <span className="rv-bar-title">{book.title}</span>
        <span className="rv-icon-btn" aria-hidden="true" />
      </header>

      <div className="rv-main rv-page">
        <div className="rv-hero">
          <p className="rv-hero-eyebrow">Advance reading</p>
          <h1 className="rv-hero-title">{book.title}</h1>
          <p className="rv-hero-sub">
            {book.author}
            {book.subtitle ? ` · ${book.subtitle}` : ''}
          </p>
          <p className="rv-card-meta">
            <span className="rv-pill rv-pill--live">
              {chapters.length === 1 ? '1 chapter' : `${chapters.length} chapters`}
            </span>
            <span>about {minutes} min of reading</span>
          </p>
        </div>

        <ResumeCard position={position} />

        <Link href="/review/my-reading" className="rv-workspace-link">
          <span className="rv-workspace-k">My reading</span>
          <span className="rv-workspace-v">
            {bookmarks.length} bookmark{bookmarks.length === 1 ? '' : 's'} ·{' '}
            {annotations.length} highlight{annotations.length === 1 ? '' : 's'} in this book
          </span>
        </Link>

        {chapters.length === 0 ? (
          <p className="rv-empty">No chapters have been released yet.</p>
        ) : (
          <nav className="rv-stack" aria-label="Chapters">
            {chapters.map((chapter) => {
              const counts = perChapter.get(chapter.slug)
              return (
                <Link
                  key={chapter.slug}
                  href={`/review/${book.slug}/${chapter.slug}`}
                  className="rv-card"
                >
                  <h2 className="rv-card-title">{chapter.label}</h2>
                  {chapter.subtitle ? <p className="rv-card-by">{chapter.subtitle}</p> : null}
                  <p className="rv-card-meta">
                    <span>{chapter.paragraphCount} paragraphs</span>
                    <span>·</span>
                    <span>about {chapter.minutes} min</span>
                    {counts ? (
                      <span className="rv-pill">
                        {counts.bookmarks > 0
                          ? `${counts.bookmarks} bookmark${counts.bookmarks === 1 ? '' : 's'}`
                          : null}
                        {counts.bookmarks > 0 && counts.annotations > 0 ? ' · ' : null}
                        {counts.annotations > 0
                          ? `${counts.annotations} highlight${counts.annotations === 1 ? '' : 's'}`
                          : null}
                      </span>
                    ) : null}
                  </p>
                </Link>
              )
            })}
          </nav>
        )}

        <footer className="rv-foot">
          <span>Signed in as {context.reviewer.name}</span>
          <form action="/review/api/lock" method="post">
            <button type="submit">Sign out</button>
          </form>
        </footer>
      </div>
    </div>
  )
}
