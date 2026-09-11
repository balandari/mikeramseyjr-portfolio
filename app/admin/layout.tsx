import type { Metadata, Viewport } from 'next'

import './admin.css'

/**
 * The administration area.
 *
 * It sits outside the public site's route group, like `/review` does, so it
 * inherits none of the site's chrome: no header, no footer, no skip link into a
 * `main` that is not there. What it does inherit, deliberately, is
 * `globals.css` from the root layout -- that is where the paper-and-ink tokens
 * live, and the dashboard is the same property in the same palette.
 *
 * Nothing here is indexable, and nothing here is cacheable. The middleware sets
 * the same headers at the boundary; this states it in the document as well, so
 * the rule survives a route that is somehow reached without passing through it.
 */
/*
 * Every metadata field the root layout sets is overridden here with something
 * that names nothing.
 *
 * The root layout's description, keywords and share text all name the current
 * book -- correct for the public site, and inherited by default by every route
 * beneath it, including this one. The reviewer gate already had to say
 * otherwise for itself; so does this. A rendered-page test scans the whole
 * document, head included, and it is what caught this being inherited.
 */
export const metadata: Metadata = {
  title: 'Reviewers',
  description: 'Administration.',
  keywords: null,
  openGraph: {
    title: 'Reviewers',
    description: 'Administration.',
    siteName: 'Mike Ramsey Jr',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'Reviewers',
    description: 'Administration.',
  },
  robots: { index: false, follow: false, noarchive: true, nocache: true },
}

/**
 * `viewportFit: 'cover'` is what makes `env(safe-area-inset-*)` non-zero on a
 * notched phone. Without it the insets this stylesheet asks for all resolve to
 * 0px and the sticky bar sits under the status bar.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  colorScheme: 'light dark',
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return children
}
