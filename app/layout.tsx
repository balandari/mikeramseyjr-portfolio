import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

/*
 * One webfont, and it is not the one doing the writing.
 *
 * The reading faces are the same book-serif stack the private reader has used
 * from the start -- Iowan Old Style, Palatino, Book Antiqua, Charter, Georgia --
 * declared in `globals.css` and loaded from nobody. They are ordinary faces
 * that have set actual books for decades, they cost nothing to fetch, and a
 * page set in them looks like a page rather than like a brand.
 *
 * Inter is kept for the functional layer only -- navigation, small labels,
 * buttons, form fields -- and because the reader's stylesheet asks for
 * `--font-inter` by name.
 */
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

/*
 * No `title.template` on purpose. The private reader sets its own title and
 * its own `robots`, and a site-wide template would rewrite both of those from
 * here. Each public page states its full title instead.
 */
export const metadata: Metadata = {
  /* The site's own domain, so the share image resolves to an absolute URL. */
  metadataBase: new URL("https://mikeramseyjr.com"),
  title: "Mike Ramsey Jr — Author",
  description:
    "Mike Ramsey Jr writes fiction. The Backward Becoming, a novel, is in progress.",
  keywords: [
    "Mike Ramsey Jr",
    "author",
    "fiction",
    "novel",
    "The Backward Becoming",
  ],
  authors: [{ name: "Mike Ramsey Jr" }],
  creator: "Mike Ramsey Jr",
  openGraph: {
    type: "website",
    locale: "en_US",
    title: "Mike Ramsey Jr — Author",
    description:
      "Mike Ramsey Jr writes fiction. The Backward Becoming, a novel, is in progress.",
    siteName: "Mike Ramsey Jr",
  },
  twitter: {
    card: "summary_large_image",
    title: "Mike Ramsey Jr — Author",
    description:
      "Mike Ramsey Jr writes fiction. The Backward Becoming, a novel, is in progress.",
  },
  /*
   * The favicon family, all of it the simplified mark and all of it built from
   * Mike's one approved render by `scripts/brand/build_brand.py`.
   *
   * The `.ico` carries three real bitmaps -- 16, 32 and 48 -- as uncompressed
   * 32-bit DIBs rather than embedded PNGs, because that is the form every
   * reader of the format understands, and a favicon is fetched once and cached
   * for a year. The PNGs beside it are what a modern browser prefers when it is
   * offered the choice, and `/icon-192` and `/icon-512` are what Android and an
   * installed web app ask for.
   *
   * The tile is opaque on purpose: the glyph is ivory, so on a transparent
   * ground it would vanish against a light tab strip. Verified in a real tab on
   * both light and dark browser chrome.
   */
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "16x16 32x32 48x48" },
      { url: "/brand/mark-32.png", sizes: "32x32", type: "image/png" },
      { url: "/brand/mark-48.png", sizes: "48x48", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [
      { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  },
  robots: {
    index: true,
    follow: true,
  },
};

/*
 * One viewport declaration for the whole site, and the reason is `viewportFit`.
 *
 * The private reader and the reviewer gate have asked for
 * `env(safe-area-inset-*)` from the beginning -- the fixed dock reserves room
 * for the home indicator, the gate pads its foot, the sheets pad theirs. None
 * of it was doing anything: without `viewport-fit=cover` in the viewport meta,
 * every one of those insets resolves to `0px`, and on a notched phone the dock
 * sat under the home indicator.
 *
 * Setting it here turns those insets on everywhere at once. It also means page
 * content may now run under the notch, so the two sticky bars -- the public
 * header and the reader's chapter bar -- pad themselves by the top inset in
 * their own stylesheets.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
