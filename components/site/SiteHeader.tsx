"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import AuthorMark from "./AuthorMark";
import { useRef } from "react";

/**
 * The site's only navigation.
 *
 * Four destinations and no more: the books, the person, and the quiet door for
 * advance readers. "Reviewer access" is deliberately the smallest thing in the
 * header -- it is a real route that a handful of people need, not an offer to
 * the public.
 *
 * On a phone it says **"Review"** instead. The full label needs 123px of a
 * header line that a 320-416px screen does not have to spare, and the door
 * used to simply disappear below 26rem -- which meant the one visitor who was
 * *given* a code and nothing else arrived on a phone and saw only "Books" and
 * "About". One link, one route, two labels; the widths are in `app/globals.css`.
 *
 * `aria-label` fixes the accessible name to "Reviewer access" at every width,
 * so a screen reader never hears the abbreviation and never has to guess what
 * "Review" leads to. The visible word is a prefix of that name, so the two
 * still agree (WCAG 2.5.3, Label in Name).
 */
const LINKS = [
  { href: "/books", label: "Books" },
  { href: "/about", label: "About" },
];

export default function SiteHeader() {
  const pathname = usePathname();
  const menu = useRef<HTMLDetailsElement>(null);

  const current = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`) ? "page" : undefined;

  return (
    <header className={`ms-header${pathname === "/" ? " ms-header--home" : ""}`}>
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
          <Link
            href="/review/login"
            className="ms-nav-quiet"
            rel="nofollow"
            aria-label="Reviewer access"
          >
            <span className="ms-nav-label-full">Reviewer access</span>
            <span className="ms-nav-label-compact">Review</span>
          </Link>
        </nav>
        {pathname === "/" ? (
          <details className="ms-mobile-menu" ref={menu} onKeyDown={(event) => {
            if (event.key === "Escape" && menu.current) {
              menu.current.open = false;
              menu.current.querySelector("summary")?.focus();
            }
          }}>
            <summary>Menu <span aria-hidden="true">☰</span></summary>
            <nav aria-label="Mobile primary" onClick={() => { if (menu.current) menu.current.open = false; }}>
              <Link href="/books">Books</Link>
              <Link href="/about">About</Link>
              <Link href="/review" rel="nofollow">Reviewer access</Link>
            </nav>
          </details>
        ) : null}
      </div>
    </header>
  );
}
