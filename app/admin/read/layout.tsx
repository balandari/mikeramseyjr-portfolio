import type { Metadata } from 'next'

import '../../review/review.css'

export const metadata: Metadata = {
  title: 'Read my books',
  description: 'Administration.',
  keywords: null,
  robots: { index: false, follow: false, noarchive: true, nocache: true },
}

/**
 * The author's reading area, inside the protected `/admin` route family.
 *
 * It borrows the reader's stylesheet wholesale rather than growing a second
 * one. Mike should be reading his manuscript in the same surface his reviewers
 * are -- same measure, same serif, same paper, same purple accent on a
 * highlight -- because the point of reading it here is to see what they see.
 *
 * `data-rv` is what that stylesheet keys its page background off, and scroll
 * restoration is handed to the reader for the same reason it is under
 * `/review`: the reader resumes at a saved paragraph rather than at whatever
 * offset the browser remembers. Both are set here, identically to
 * `app/review/layout.tsx`, because this route group does not pass through it.
 */
const SCROLL_BOOTSTRAP = `(function(){try{
document.documentElement.setAttribute('data-rv','');
if('scrollRestoration' in history){history.scrollRestoration='manual';}
}catch(e){}})();`

export default function AdminReadLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: SCROLL_BOOTSTRAP }} />
      {children}
    </>
  )
}
