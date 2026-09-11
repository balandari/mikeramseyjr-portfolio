import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import StatusBadge from "@/components/site/StatusBadge";
import { findShelfBook, loadShelf } from "@/lib/bookshelf";

/**
 * One title's public page, set in type.
 *
 * Statically generated from the shelf, and `dynamicParams = false` so that a
 * slug which is not on the shelf is a 404 at the edge rather than a request
 * that reaches the filesystem. Nothing here can address the manuscript: the
 * private prose lives under `content/books/`, behind `/review`, and this page
 * has no route to it.
 *
 * The plate is deliberately not used here -- it is reserved for the featured
 * presentation on the homepage. A book's own page is its title, its stage, and
 * what Mike has written about it.
 */
export const dynamicParams = false;

export function generateStaticParams() {
  return loadShelf().map((book) => ({ slug: book.slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const book = findShelfBook(params.slug);
  if (!book) return {};

  return {
    title: `${book.title} — Mike Ramsey Jr`,
    description: book.tagline,
    openGraph: {
      type: "book",
      title: `${book.title} — Mike Ramsey Jr`,
      description: book.tagline,
    },
  };
}

export default function BookPage({ params }: { params: { slug: string } }) {
  const book = findShelfBook(params.slug);
  if (!book) notFound();

  return (
    <>
      <section className="ms-hero" aria-labelledby="book-title">
        <div className="ms-shell ms-shell--narrow">
          <p style={{ margin: 0 }}>
            <Link href="/books" className="ms-quiet">
              <span className="ms-arrow" aria-hidden="true">
                &larr;
              </span>
              All books
            </Link>
          </p>

          <p className="ms-eyebrow" style={{ marginTop: "1.5rem" }}>
            {book.kind}
          </p>

          <h1 id="book-title" className="ms-display" style={{ marginTop: "0.75rem" }}>
            {book.title}
          </h1>

          <p className="ms-sub">{book.tagline}</p>

          <div style={{ marginTop: "1.75rem" }}>
            <StatusBadge book={book} />
            <p className="ms-meta" style={{ marginTop: "0.75rem", maxWidth: "30rem" }}>
              {book.statusNote}
            </p>
          </div>

          <dl className="ms-detail-list">
            {book.details.map((detail) => (
              <div className="ms-detail" key={detail.label}>
                <dt>{detail.label}</dt>
                <dd>{detail.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/*
        The description sits on the opposite ground, at a reading measure. It
        is the closest the public site comes to the book itself -- and it is
        description, never the book's own prose. No chapter text is published
        here or anywhere else on the public site.
      */}
      <section className="ms-section ms-section--inverse" aria-labelledby="book-about">
        <div className="ms-shell ms-shell--narrow">
          <p className="ms-eyebrow">About the book</p>

          <h2 id="book-about" className="ms-h3" style={{ marginTop: "0.75rem" }}>
            {book.title}
          </h2>

          <div className="ms-prose" style={{ marginTop: "1.25rem" }}>
            {book.description.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
        </div>
      </section>

      {book.reviewerAccess ? (
        <section className="ms-section" aria-labelledby="book-reviewers">
          <div className="ms-shell ms-shell--narrow">
            <p className="ms-eyebrow">Advance readers</p>

            <h2 id="book-reviewers" className="ms-h3" style={{ marginTop: "0.75rem" }}>
              Reading it before it&apos;s finished
            </h2>

            <p className="ms-meta" style={{ marginTop: "1rem", maxWidth: "34rem" }}>
              Early chapters are shared privately, by invitation, with a small number
              of readers. If Mike has given you a code, this is the way in. There is
              nothing to sign up for, and the manuscript is not public.
            </p>

            <p style={{ marginTop: "1.5rem" }}>
              <Link href="/review/login" className="ms-link" rel="nofollow">
                Reviewer access
                <span className="ms-arrow" aria-hidden="true">
                  &rarr;
                </span>
              </Link>
            </p>
          </div>
        </section>
      ) : null}
    </>
  );
}
