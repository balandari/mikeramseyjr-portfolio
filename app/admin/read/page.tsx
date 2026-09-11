import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { ADMIN_COOKIE_NAME, adminCsrfToken } from '@/lib/admin-auth'
import { cookies } from 'next/headers'
import { loadAuthorInbox } from '@/lib/author-inbox'
import { authorContext } from '@/lib/reading-session'
import { loadedBookSlugs } from '@/lib/reading-service'
import { buildWorkspace } from '@/lib/reading-workspace'
import { findBook, releasedChapters } from '@/lib/manuscript'
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
 *   on the public shelf. **PERSISTENT is not here**, and that is correct: it
 *   has public metadata and cover art and no manuscript, so there is nothing to
 *   read. Nothing on this page implies otherwise.
 *
 *   **His own reading, in his own namespace.** The workspace below is built for
 *   the author viewer, so every record it shows lives under
 *   `reading/v1/author/...`. Opening a chapter from here creates no reviewer
 *   identity, moves no reviewer's last-opened time, and writes nothing into
 *   reviewer feedback.
 *
 *   **Only what was shared with him.** The inbox is filtered by the same
 *   visibility rule every other surface uses; a reviewer's private annotation
 *   is not in it.
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
    // The author submits no reviewer feedback. What reviewers sent him is shown
    // below as an inbox, never mixed in as though it were his own.
    includeFeedback: false,
  })

  const inbox = await loadAuthorInbox(context.viewer)

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

        <section className="rv-work-book">
          <div className="rv-work-head">
            <h2 className="rv-work-title">Shared with you</h2>
            <p className="rv-work-resume rv-work-resume--none">
              {inbox.annotations.length} note{inbox.annotations.length === 1 ? '' : 's'} ·{' '}
              {inbox.comments.length} comment{inbox.comments.length === 1 ? '' : 's'}
            </p>
          </div>

          {inbox.incomplete ? (
            <p className="rv-note rv-note--bad" role="alert">
              Some of this could not be read just now. This is a storage fault, not an
              empty inbox — what is missing has not been lost.
            </p>
          ) : null}

          {inbox.annotations.length === 0 && inbox.comments.length === 0 && !inbox.incomplete ? (
            <p className="rv-empty rv-empty--tight">
              Nothing has been shared with you yet. A reviewer&rsquo;s private notes stay
              private — you see only what they chose to share.
            </p>
          ) : null}

          {inbox.annotations.length > 0 ? (
            <div className="rv-work-group">
              <span className="rv-field-label">Notes reviewers shared</span>
              {inbox.annotations.map((entry) => (
                <div key={entry.id} className="rv-mark-row">
                  {entry.anchorOk ? (
                    <Link className="rv-mark-go" href={entry.href}>
                      <span className="rv-mark-where">
                        {entry.reviewerName} · {entry.bookTitle} · {entry.chapterLabel} ·
                        paragraph {entry.paragraphOrdinal}
                      </span>
                      <span className="rv-mark-quote">“{entry.quote}”</span>
                      {entry.note ? <span className="rv-mark-text">{entry.note}</span> : null}
                    </Link>
                  ) : (
                    <span className="rv-mark-go rv-mark-go--dead">
                      <span className="rv-mark-where">
                        {entry.reviewerName} · {entry.bookTitle} · {entry.chapterLabel}
                      </span>
                      <span className="rv-mark-quote">“{entry.quote}”</span>
                      {entry.note ? <span className="rv-mark-text">{entry.note}</span> : null}
                      <span className="rv-mark-flag">
                        The manuscript has changed here — this needs relocating, so it is
                        not linked to the text.
                      </span>
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : null}

          {inbox.comments.length > 0 ? (
            <div className="rv-work-group">
              <span className="rv-field-label">Comments reviewers sent</span>
              {inbox.comments.map((entry) => (
                <div key={entry.id} className="rv-mark-row">
                  <Link className="rv-mark-go" href={entry.href}>
                    <span className="rv-mark-where">
                      {entry.reviewerName} · {entry.bookTitle} · {entry.chapterLabel}
                      {entry.paragraphOrdinal ? ` · paragraph ${entry.paragraphOrdinal}` : ''}
                    </span>
                    {entry.quote ? (
                      <span className="rv-mark-quote">“{entry.quote}”</span>
                    ) : null}
                    <span className="rv-mark-text">{entry.comment}</span>
                  </Link>
                </div>
              ))}
            </div>
          ) : null}
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

        <footer className="rv-foot">
          <span>Signed in as {context.session.email}</span>
          <Link href="/admin">Dashboard</Link>
        </footer>
      </div>
    </div>
  )
}
