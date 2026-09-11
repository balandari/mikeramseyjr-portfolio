import type { Metadata } from "next";
import { Fraunces, Inter, Spectral } from "next/font/google";
import "./globals.css";

/*
 * Three faces, each with one job.
 *
 * Fraunces sets the display voice -- a modern serif with enough character to
 * carry a page that has no artwork on it. Spectral reads the running text.
 * Inter is kept for the small mechanical labels, and because the private
 * reader's stylesheet already asks for `--font-inter` by name; removing it
 * would change `/review`, which this work does not touch.
 */
const fraunces = Fraunces({
  subsets: ["latin"],
  style: ["normal", "italic"],
  variable: "--font-fraunces",
  display: "swap",
});

const spectral = Spectral({
  subsets: ["latin"],
  weight: ["400", "600"],
  style: ["normal", "italic"],
  variable: "--font-spectral",
  display: "swap",
});

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
    <html
      lang="en"
      className={`${fraunces.variable} ${spectral.variable} ${inter.variable}`}
    >
      <body className="antialiased">{children}</body>
    </html>
  );
}
