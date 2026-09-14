import type { Metadata } from 'next'
import Link from 'next/link'
import { cookies } from 'next/headers'
import { notFound, redirect } from 'next/navigation'

import { ADMIN_COOKIE_NAME, adminCsrfToken } from '@/lib/admin-auth'
import { authorContext } from '@/lib/reading-session'
import { loadBookReading } from '@/lib/reading-service'
import { releasedChapters } from '@/lib/manuscript'
import ResumeCard from '../../../review/ResumeCard'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Read my books',
  description: 'Administration.',
  keywords: null,
  robots: { index: false, follow: false, noarchive: true, nocache: true },
}

/**
 * One of Mike's books, as he reads it.
 *
 * `loadBookReading` is the same call the reviewer's contents page makes, with
 * an author viewer instead of a reviewer one. The book must be loaded on this
 * deployment or this 404s -- being the author is not a way to read a manuscript
 * that is not here.
 */
export default async function AdminBookPage({ params }: { params: { book: string } }) {
  const context = await authorContext()
  if (!context) {
    redirect(`/admin/login?next=${encodeURIComponent(`/admin/read/${params.book}`)}`)
  }

  /*
   * The same token the chapter page mints, for the same reason: the card now
   * reconciles itself against `/admin/api/reading`, which requires it on any
   * write. A read needs none, so a page without a usable token would still show
   * the right place -- but the one retry the card can make would be refused,
   * and a refusal it cannot act on is worth not creating.
   */
  const store = await cookies()
  const token = store.get(ADMIN_COOKIE_NAME)?.value
  const csrf = token ? await adminCsrfToken(token) : null
  if (!csrf) redirect('/admin/login?error=unconfigured')

  const reading = await loadBookReading(context.viewer, params.book)
  if (!reading.ok) notFound()

  const { book, position, bookmarks, annotations } = reading.value
  const chapters = releasedChapters(book)
  const minutes = chapters.reduce((total, chapter) => total + chapter.minutes, 0)

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
      <header className="rv-bar">
        <Link href="/admin/read" className="rv-icon-btn" aria-label="My books">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </Link>
        <span className="rv-bar-title">{book.title}</span>
        <span className="rv-icon-btn" aria-hidden="true" />
      </header>

      <div className="rv-main rv-page">
        <div className="rv-hero">
          <p className="rv-hero-eyebrow">Your own copy</p>
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

        <ResumeCard
          position={position}
          base="/admin/read"
          identity={`author-${context.viewer.id.slice(0, 12)}`}
          endpoint={{ url: '/admin/api/reading', csrf }}
          books={[book.slug]}
        />

        <Link href="/admin/read" className="rv-workspace-link">
          <span className="rv-workspace-k">Your reading</span>
          <span className="rv-workspace-v">
            {bookmarks.length} bookmark{bookmarks.length === 1 ? '' : 's'} ·{' '}
            {annotations.length} highlight{annotations.length === 1 ? '' : 's'} in this book
          </span>
        </Link>

        {chapters.length === 0 ? (
          <p className="rv-empty">No chapters are released in this manuscript.</p>
        ) : (
          <nav className="rv-stack" aria-label="Chapters">
            {chapters.map((chapter) => {
              const counts = perChapter.get(chapter.slug)
              return (
                <Link
                  key={chapter.slug}
                  href={`/admin/read/${book.slug}/${chapter.slug}`}
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
          <span>Signed in as {context.session.email}</span>
          <Link href="/admin">Dashboard</Link>
        </footer>
      </div>
    </div>
  )
}
