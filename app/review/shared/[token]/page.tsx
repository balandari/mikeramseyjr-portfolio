import type { Metadata } from 'next'
import Link from 'next/link'

import { reviewerStorageNamespace } from '@/lib/reviewer-access'
import { reviewerContext } from '@/lib/reading-session'
import { openSharedAnnotation } from '@/lib/reading-service'
import ReviewAppearance from '../../ReviewAppearance'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'A shared note',
  robots: { index: false, follow: false, noarchive: true, nocache: true },
}

/**
 * Opening an annotation from its private link.
 *
 * **The link is a locator, not a key.** It says which note is meant and nothing
 * else. Reaching the note still requires a reviewer session that the live
 * roster currently entitles to that exact book, and the annotation still has to
 * actually be shared by link -- all of which `openSharedAnnotation` checks
 * before any content is read.
 *
 * This path is reachable without a session on purpose, and it is the only such
 * path under `/review` besides signing in. That is because the administrator
 * cookie is scoped to `/admin` and is therefore not sent here: if the boundary
 * bounced an unauthenticated visitor straight to the reviewer sign-in form,
 * Mike would be asked for a reviewer access code to read a note somebody shared
 * with him. So the page answers for itself, and offers both doors.
 *
 * **Nothing about the annotation is disclosed before authorization.** A visitor
 * with no session, a reviewer who is not entitled to the book, a revoked
 * reviewer, and a token nobody ever minted all receive exactly the same page.
 * The link cannot be used to learn whether a note exists, which book it is in,
 * or who wrote it.
 */
export default async function SharedAnnotationPage({
  params,
}: {
  params: { token: string }
}) {
  const context = await reviewerContext()

  if (!context) {
    return <NeedsAccess token={params.token} />
  }

  const result = await openSharedAnnotation(context.viewer, params.token)
  if (!result.ok) {
    return <NeedsAccess token={params.token} signedIn />
  }

  const { annotation, book, chapter } = result.value
  const namespace = await reviewerStorageNamespace(context.reviewer)
  const passageHref = `/review/${book.slug}/${annotation.chapterSlug}#${annotation.paragraphId}`

  return (
    <div className="rv-root">
      <ReviewAppearance namespace={namespace} />

      <header className="rv-bar">
        <Link href="/review" className="rv-icon-btn" aria-label="All titles">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </Link>
        <span className="rv-bar-title">A shared note</span>
        <span className="rv-icon-btn" aria-hidden="true" />
      </header>

      <div className="rv-main rv-page">
        <div className="rv-hero">
          <p className="rv-hero-eyebrow">{book.title}</p>
          <h1 className="rv-hero-title">{chapter?.label ?? annotation.chapterLabel}</h1>
          <p className="rv-hero-sub">paragraph {annotation.paragraphOrdinal}</p>
        </div>

        <blockquote className="rv-quote">
          <span className="rv-quote-tag">The passage, as it was marked</span>
          {annotation.quote}
        </blockquote>

        {annotation.note ? (
          <p className="rv-shared-note">{annotation.note}</p>
        ) : (
          <p className="rv-empty rv-empty--tight">
            A highlight, with nothing written about it.
          </p>
        )}

        {annotation.anchorState === 'ok' ? (
          <Link href={passageHref} className="rv-btn rv-btn--primary rv-btn--block">
            Open this passage
          </Link>
        ) : (
          <p className="rv-note rv-note--bad" role="status">
            The manuscript has changed since this was marked, so it no longer points at
            the same words. The passage above is what was saved; it needs relocating
            before it can be opened.
          </p>
        )}

        <footer className="rv-foot">
          <span>Signed in as {context.reviewer.name}</span>
          <Link href="/review/my-reading">My reading</Link>
        </footer>
      </div>
    </div>
  )
}

/**
 * The one answer given to everybody who may not see the note.
 *
 * It is identical whether the token is real, the reader is not entitled, or
 * there is no session at all -- deliberately, so that the page reveals nothing
 * by how it differs.
 */
function NeedsAccess({ token, signedIn = false }: { token: string; signedIn?: boolean }) {
  const here = `/review/shared/${token}`

  return (
    <div className="rv-root">
      <div className="rv-main rv-page">
        <div className="rv-hero">
          <p className="rv-hero-eyebrow">Advance reading</p>
          <h1 className="rv-hero-title">You need access to open this.</h1>
          <p className="rv-hero-sub">
            A link like this one points at a note. It is not a way in: opening it needs
            Mike&rsquo;s own sign-in, or a reviewer who has been given this book.
          </p>
        </div>

        <div className="rv-stack">
          {signedIn ? null : (
            <Link
              href={`/review/login?next=${encodeURIComponent(here)}`}
              className="rv-card"
            >
              <h2 className="rv-card-title">Sign in as a reviewer</h2>
              <p className="rv-card-by">With the access code Mike gave you.</p>
            </Link>
          )}
          <Link href={`/admin/shared/${token}`} className="rv-card">
            <h2 className="rv-card-title">Open as the author</h2>
            <p className="rv-card-by">Mike&rsquo;s own sign-in.</p>
          </Link>
        </div>
      </div>
    </div>
  )
}
