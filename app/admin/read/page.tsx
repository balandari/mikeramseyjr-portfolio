import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { ADMIN_COOKIE_NAME, adminCsrfToken } from '@/lib/admin-auth'
import { cookies } from 'next/headers'
import { authorContext } from '@/lib/reading-session'
import { loadedBookSlugs } from '@/lib/reading-service'
import { buildWorkspace } from '@/lib/reading-workspace'
import { findBook, releasedChapters } from '@/lib/manuscript'
import ReadingHelp from '@/components/reader/ReadingHelp'
import AuthorMark from '@/components/site/AuthorMark'
import Workspace from '../../review/my-reading/Workspace'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Read my books',
  description: 'Administration.',
  keywords: null,
  robots: { index: false, follow: false, noarchive: true, nocache: true },
}

/**
 * Mike's own library, and what reviewers have sent him.
 *
 * Three things this page is careful about:
 *
 *   **Every manuscript the site has actually loaded**, and nothing else.
 *   `loadedBookSlugs()` walks `content/books`, so a book appears here because
 *   its manuscript is on disk and has a released chapter -- not because it is
 *   on the public shelf. **PERSISTENT is here**, and is his alone: its manifest
 *   says `"audience": "author-only"`, which keeps it out of every reviewer's
 *   library, out of the entitlement controls, and refused on every reviewer
 *   route even when its slug is guessed. This is the one page it is offered on.
 *
 *   **His own reading, in his own namespace.** The workspace below is built for
 *   the author viewer, so every record it shows lives under
 *   `reading/v1/author/...`. Opening a chapter from here creates no reviewer
 *   identity, moves no reviewer's last-opened time, and writes nothing into
 *   reviewer feedback.
 *
 *   **Nothing of anybody else's.** This page reads no feedback source and no
 *   triage metadata. What reviewers shared is at `/admin/feedback`, which this
 *   page links to and does not duplicate -- so there is no second count here to
 *   disagree with that one, and nothing on this route can mark an item read.
 */
export default async function AdminReadPage() {
  const context = await authorContext()
  if (!context) redirect('/admin/login?next=%2Fadmin%2Fread')

  const store = await cookies()
  const token = store.get(ADMIN_COOKIE_NAME)?.value
  const csrf = token ? await adminCsrfToken(token) : null
  if (!csrf) redirect('/admin/login?error=unconfigured')

  const slugs = loadedBookSlugs()
  const books = slugs
    .map((slug) => findBook(slug))
    .filter((book): book is NonNullable<typeof book> => book !== null)

  const workspace = await buildWorkspace(context.viewer, slugs, {
    base: '/admin/read',
    // The author submits no reviewer feedback. What reviewers sent him is a
    // different page entirely, never mixed in as though it were his own.
    includeFeedback: false,
  })

  return (
    <div className="rv-root">
      <header className="rv-bar">
        <Link href="/admin" className="rv-icon-btn" aria-label="Dashboard">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </Link>
        <span className="rv-bar-title">Read my books</span>
        <span className="rv-icon-btn" aria-hidden="true" />
      </header>

      <div className="rv-main rv-page">
        <div className="rv-hero">
          {/*
           * The same mark the reviewer library carries, on the author's own
           * shelf -- and, like that one, it stops at the shelf. Inside a
           * chapter there is nothing but the book.
           */}
          <AuthorMark size={34} className="rv-hero-mark" alt="Mike Ramsey Jr" />
          <p className="rv-hero-eyebrow">Your own copy</p>
          <h1 className="rv-hero-title">Read my books</h1>
          <p className="rv-hero-sub">
            Every manuscript loaded on this site, in the reader your reviewers use. Your
            place, your bookmarks and your notes are kept separately from theirs.
          </p>
        </div>

        {books.length === 0 ? (
          <p className="rv-empty">
            No manuscript is loaded on this deployment yet. A book appears here when its
            chapters are in <code>content/books</code>, not when it is on the shelf.
          </p>
        ) : (
          <div className="rv-stack">
            {books.map((book) => {
              const chapters = releasedChapters(book)
              return (
                <Link
                  key={book.slug}
                  href={`/admin/read/${book.slug}`}
                  className="rv-card"
                >
                  <h2 className="rv-card-title">{book.title}</h2>
                  <p className="rv-card-by">
                    {book.author}
                    {book.subtitle ? ` · ${book.subtitle}` : ''}
                  </p>
                  <p className="rv-card-meta">
                    <span className="rv-pill rv-pill--live">
                      {chapters.length === 1 ? '1 chapter' : `${chapters.length} chapters`}
                    </span>
                    <span>
                      about {chapters.reduce((total, entry) => total + entry.minutes, 0)} min
                    </span>
                  </p>
                </Link>
              )
            })}
          </div>
        )}

        {/* ------------------------------------------------ shared with you */}

        {/*
         * A door, not a list.
         *
         * What reviewers sent used to be rendered in full at the bottom of this
         * page, which made one route do two jobs: the shelf Mike reads his own
         * books from, and the inbox of what other people said about them. The
         * second grew filters, states, saved views and an export, and it now
         * lives at `/admin/feedback`.
         *
         * Nothing of it is duplicated here. This page reads no feedback source
         * and no triage metadata at all, so it cannot show a stale count, cannot
         * disagree with the inbox, and cannot mark anything read on the way past.
         */}
        <section className="rv-work-book">
          <div className="rv-work-head">
            <h2 className="rv-work-title">Shared with you</h2>
          </div>
          <p className="rv-work-resume rv-work-resume--none">
            Notes, highlights and comments reviewers chose to share &mdash; with filters, saved
            views and the export &mdash; are on their own page now.
          </p>
          <p style={{ marginTop: '0.75rem' }}>
            <Link href="/admin/feedback" className="ad-btn">
              Open the feedback inbox
            </Link>
          </p>
        </section>

        {/* --------------------------------------------------- your reading */}

        <section>
          <h2 className="rv-work-title" style={{ marginTop: '2rem' }}>
            Your own reading
          </h2>
          <Workspace
            endpoint={{ url: '/admin/api/reading', csrf }}
            books={workspace}
            emptyHint="Nothing saved yet. Open a chapter and highlight something."
          />
        </section>

        {/* The same explanation the reviewers get, in the author's voice. */}
        <ReadingHelp voice="author" />

        <footer className="rv-foot">
          <span>Signed in as {context.session.email}</span>
          <Link href="/admin">Dashboard</Link>
        </footer>
      </div>
    </div>
  )
}
