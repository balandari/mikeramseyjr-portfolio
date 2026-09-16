import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { authorContext } from '@/lib/reading-session'
import { openNoteByLocator, type OpenedNote } from '@/lib/note-service'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'A note',
  description: 'Administration.',
  keywords: null,
  robots: { index: false, follow: false, noarchive: true, nocache: true },
}

/**
 * The author's door onto a note's private link.
 *
 * It lives under `/admin` because that is where Mike's cookie is sent. The
 * alternative -- widening the administrator cookie's scope so it reached
 * `/review` -- would make a privileged, long-lived credential available to every
 * route on the domain in order to solve a link-routing problem. This is one
 * small page instead, and it is the same arrangement `/admin/shared/<token>`
 * already uses for annotations.
 *
 * The rules are the same rules. `openNoteByLocator` requires a real session,
 * requires the book to be one the site has actually loaded, and puts the note
 * past `canViewNote` -- which has **no exception for the author**. A reviewer's
 * private note is refused here exactly as it is everywhere else, and the link
 * changes nothing about that: it is a locator, and it grants nothing.
 */
export default async function AuthorNoteLinkPage({
  params,
}: {
  params: { book: string; id: string }
}) {
  const here = `/admin/note/${encodeURIComponent(params.book)}/${encodeURIComponent(params.id)}`
  const context = await authorContext()
  if (!context) redirect(`/admin/login?next=${encodeURIComponent(here)}`)

  const result = await openNoteByLocator(context.viewer, params.book, params.id)

  if (!result.ok) {
    return (
      <div className="ad-root">
        <div className="ad-gate">
          <div className="ad-gate-panel">
            <h1>A note</h1>
            <p className="ad-note" role="status">
              That link does not open anything you can see. Either there is no such note, it
              has been deleted, or it is private to the reviewer who wrote it.
            </p>
            <p style={{ marginTop: '1rem' }}>
              <Link href="/admin" className="ad-btn">
                Back to the dashboard
              </Link>
            </p>
          </div>
        </div>
      </div>
    )
  }

  const { note, book, chapter } = result.value
  const passageHref =
    note.anchor.scope === 'book'
      ? `/admin/read/${book.slug}`
      : note.paragraphId && note.anchor.scope !== 'chapter'
        ? `/admin/read/${book.slug}/${note.anchor.chapterSlug}#${note.paragraphId}`
        : `/admin/read/${book.slug}/${note.anchor.chapterSlug}`

  return (
    <div className="ad-root">
      <header className="ad-bar">
        <Link href="/admin" className="ad-bar-back">
          Dashboard
        </Link>
        <span className="ad-bar-title">A note</span>
        <span />
      </header>

      <div className="ad-main">
        <section className="ad-card">
          <h1 className="ad-card-title">{book.title}</h1>
          <p className="ad-card-sub">
            {note.anchor.scope === 'book'
              ? 'The whole book'
              : `${chapter?.label ?? note.anchor.chapterLabel} · ${where(result.value)}`}
          </p>

          {captured(result.value) ? (
            <blockquote className="ad-quote">{captured(result.value)}</blockquote>
          ) : null}

          <p className="ad-note-body">{note.body}</p>

          {note.anchorState === 'needs-relocation' ? (
            <p className="ad-note ad-note--bad" role="status">
              The manuscript has changed since this was written, so it no longer points at
              the same words. What is above is what was saved.
            </p>
          ) : (
            <p style={{ marginTop: '1rem' }}>
              <Link href={passageHref} className="ad-btn">
                {note.anchor.scope === 'book' ? 'Open the book' : 'Open this passage'}
              </Link>
            </p>
          )}
        </section>
      </div>
    </div>
  )
}

function where({ note }: OpenedNote): string {
  if (note.anchor.scope === 'chapter') return 'a note about the chapter'
  if (note.anchor.scope === 'book') return 'a note about all of it'
  return `paragraph ${note.anchor.paragraphOrdinal}`
}

function captured({ note }: OpenedNote): string | null {
  if (note.anchor.scope === 'passage') return note.anchor.quote
  if (note.anchor.scope === 'paragraph') return note.anchor.paragraphText
  return null
}
