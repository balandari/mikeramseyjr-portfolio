"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import AuthorMark from "./AuthorMark";

/**
 * The site's only navigation.
 *
 * Four destinations and no more: the books, the person, and the quiet door for
 * advance readers. "Reviewer access" is deliberately the smallest thing in the
 * header -- it is a real route that a handful of people need, not an offer to
 * the public -- and it drops out below 26rem so that on a phone the two public
 * links keep their full touch targets.
 */
const LINKS = [
  { href: "/books", label: "Books" },
  { href: "/about", label: "About" },
];

export default function SiteHeader() {
  const pathname = usePathname();

  const current = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`) ? "page" : undefined;

  return (
    <header className="ms-header">
      <div className="ms-shell ms-header-inner">
        {/*
          * The mark belongs to the name, so it lives inside the same link
          * rather than beside it: one target, one thing to read. It carries no
          * alt text for exactly that reason — the words are right there, and a
          * screen reader saying the name twice is worse than saying it once.
          */}
        <Link href="/" className="ms-wordmark" aria-current={pathname === "/" ? "page" : undefined}>
          <AuthorMark size={30} className="ms-wordmark-mark" />
          Mike Ramsey Jr
        </Link>

        <nav className="ms-nav" aria-label="Primary">
          {LINKS.map((link) => (
            <Link key={link.href} href={link.href} aria-current={current(link.href)}>
              {link.label}
            </Link>
          ))}
          <Link href="/review/login" className="ms-nav-quiet" rel="nofollow">
            Reviewer access
          </Link>
        </nav>
      </div>
    </header>
  );
}
