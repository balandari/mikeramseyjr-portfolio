import type { Metadata } from 'next'

import './review.css'

export const metadata: Metadata = {
  title: 'Advance reading',
  robots: { index: false, follow: false, noarchive: true, nocache: true },
}

/**
 * Two things that apply to the whole `/review` area and depend on nothing about
 * who is signed in, so they run here rather than on each page.
 *
 * `data-rv` marks the document as a reader page. The portfolio's root layout
 * paints `body` in its marketing dark, which the reader would otherwise show
 * behind an over-scroll bounce; the marker lets the reader's stylesheet repaint
 * `body` without reaching any other route on the site.
 *
 * Scroll restoration is taken over by the reader itself, which resumes a
 * reviewer at their own saved paragraph rather than at whatever offset the
 * browser remembers.
 */
const SCROLL_BOOTSTRAP = `(function(){try{
document.documentElement.setAttribute('data-rv','');
if('scrollRestoration' in history){history.scrollRestoration='manual';}
}catch(e){}})();`

export default function ReviewLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: SCROLL_BOOTSTRAP }} />
      {children}
    </>
  )
}
