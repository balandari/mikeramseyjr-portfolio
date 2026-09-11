import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { authorContext } from '@/lib/reading-session'
import { openSharedAnnotation } from '@/lib/reading-service'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'A shared note',
  description: 'Administration.',
  keywords: null,
  robots: { index: false, follow: false, noarchive: true, nocache: true },
}

/**
 * The author's door onto the same private link.
 *
 * It lives under `/admin` because that is where Mike's cookie is sent. The
 * alternative -- widening the administrator cookie's scope so it reached
 * `/review` -- would make a privileged, long-lived credential available to every
 * route on the domain in order to solve a link-routing problem. This is one
 * small page instead.
 *
 * The rules are the same rules. `openSharedAnnotation` requires a real session,
 * requires the book to be one the site has actually loaded, and requires the
 * annotation to be shared by link. A reviewer's explicitly private annotation is
 * refused here exactly as it is everywhere else: it is refused by
 * `canViewAnnotation`, which does not have an exception for the author.
 */
export default async function AdminSharedAnnotationPage({
  params,
}: {
  params: { token: string }
}) {
  const context = await authorContext()
  if (!context) redirect(`/admin/login?next=${encodeURIComponent(`/admin/shared/${params.token}`)}`)

  const result = await openSharedAnnotation(context.viewer, params.token)

  if (!result.ok) {
    return (
      <div className="ad-root">
        <div className="ad-gate">
          <div className="ad-gate-panel">
            <h1>A shared note</h1>
            <p className="ad-note" role="status">
              That link does not open anything you can see. Either it was never a link, it
              has been withdrawn, or the note behind it is private to the reviewer who
              wrote it.
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

  const { annotation, book, chapter } = result.value
  const passageHref = `/admin/read/${book.slug}/${annotation.chapterSlug}#${annotation.paragraphId}`

  return (
    <div className="ad-root">
      <header className="ad-bar">
        <Link href="/admin" className="ad-bar-back">
          Dashboard
        </Link>
        <span className="ad-bar-title">A shared note</span>
        <span />
      </header>

      <div className="ad-main">
        <section className="ad-card">
          <h1 className="ad-card-title">{book.title}</h1>
          <p className="ad-card-sub">
            {chapter?.label ?? annotation.chapterLabel} · paragraph{' '}
            {annotation.paragraphOrdinal}
          </p>

          <blockquote className="ad-quote">{annotation.quote}</blockquote>

          {annotation.note ? (
            <p className="ad-note-body">{annotation.note}</p>
          ) : (
            <p className="ad-card-sub">A highlight, with nothing written about it.</p>
          )}

          {annotation.anchorState === 'ok' ? (
            <p style={{ marginTop: '1rem' }}>
              <Link href={passageHref} className="ad-btn">
                Open this passage
              </Link>
            </p>
          ) : (
            <p className="ad-note ad-note--bad" role="status">
              The manuscript has changed since this was marked, so it no longer points at
              the same words. The passage above is what was saved; it is not shown in the
              text, and it needs relocating.
            </p>
          )}
        </section>
      </div>
    </div>
  )
}
