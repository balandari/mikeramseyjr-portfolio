import type { Metadata } from "next";
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
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "16x16 32x32 48x48" },
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
