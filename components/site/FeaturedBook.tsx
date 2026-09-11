import Link from "next/link";

import type { ShelfBook } from "@/lib/bookshelf";
import BookPlate from "./BookPlate";
import StatusBadge from "./StatusBadge";

/**
 * The homepage's presentation of the current book.
 *
 * This is the one band on the page set on the opposite ground -- ink on the
 * paper site, paper when the reader's system is dark -- so the book gets the
 * page's single moment of contrast. It is also the only place the typographic
 * plate is used.
 *
 * It takes whichever title is marked `featured`, so promoting the next book is
 * moving one boolean between two content files.
 */
export default function FeaturedBook({ book }: { book: ShelfBook }) {
  return (
    <section className="ms-section ms-section--inverse" aria-labelledby="featured-title">
      <div className="ms-shell">
        <div className="ms-featured">
          <BookPlate book={book} />

          <div>
            <p className="ms-eyebrow">The current book</p>

            <h2 id="featured-title" className="ms-h2" style={{ marginTop: "0.75rem" }}>
              {book.title}
            </h2>

            <p className="ms-sub">{book.tagline}</p>

            <div style={{ marginTop: "1.5rem" }}>
              <StatusBadge book={book} />
              <p className="ms-meta" style={{ marginTop: "0.75rem", maxWidth: "30rem" }}>
                {book.statusNote}
              </p>
            </div>

            <div className="ms-prose" style={{ marginTop: "1.75rem" }}>
              {book.description.slice(0, 2).map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </div>

            <dl className="ms-detail-list">
              {book.details.map((detail) => (
                <div className="ms-detail" key={detail.label}>
                  <dt>{detail.label}</dt>
                  <dd>{detail.value}</dd>
                </div>
              ))}
            </dl>

            <div
              style={{
                marginTop: "2rem",
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: "0.75rem 1.75rem",
              }}
            >
              <Link href={`/books/${book.slug}`} className="ms-btn">
                About this book
              </Link>
              {book.reviewerAccess ? (
                <Link href="/review/login" className="ms-quiet" rel="nofollow">
                  Reviewer access
                  <span className="ms-arrow" aria-hidden="true">
                    &rarr;
                  </span>
                </Link>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
