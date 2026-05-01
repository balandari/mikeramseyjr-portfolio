import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Mike Ramsey Jr — AI Developer",
  description:
    "AI developer building real products at the intersection of human creativity and artificial intelligence. Creator of TrovoPilot and PulseBoard.",
  keywords: [
    "Mike Ramsey Jr",
    "AI developer",
    "full-stack developer",
    "TrovoPilot",
    "PulseBoard",
    "Next.js",
    "React",
  ],
  authors: [{ name: "Mike Ramsey Jr" }],
  creator: "Mike Ramsey Jr",
  openGraph: {
    type: "website",
    locale: "en_US",
    title: "Mike Ramsey Jr — AI Developer",
    description:
      "AI developer building real products at the intersection of human creativity and artificial intelligence.",
    siteName: "Mike Ramsey Jr",
  },
  twitter: {
    card: "summary_large_image",
    title: "Mike Ramsey Jr — AI Developer",
    description:
      "AI developer building real products at the intersection of human creativity and artificial intelligence.",
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
    <html lang="en" className={`${inter.variable}`}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
