import Link from "next/link";

import type { ShelfBook } from "@/lib/bookshelf";
import CoverSettle from "@/components/motion/CoverSettle";
import BookPlate from "./BookPlate";
import StatusBadge from "./StatusBadge";

/**
 * The homepage's presentation of the current book.
 *
 * This band is **tan**, and the introduction above it is **ink** -- a fixed
 * pair, not the relative "one band on the opposite ground" the rest of the
 * site uses. It was that relative band until now, which meant it was ink by
 * day and paper by night; the hierarchy the homepage is meant to state is
 * black introduction, then the book on warm paper, and that has to hold in
 * both schemes rather than trading places at night. `.ms-section--paper` and
 * `.ms-section--ink` are the two fixed grounds, in `app/globals.css`.
 *
 * `/about` and a book page still use `.ms-section--inverse`, which follows the
 * reader. Those bands should.
 *
 * Everything in here reads the semantic tokens the ground remaps, so the
 * eyebrow, the status badge, the detail rules, the button and the quiet
 * reviewer link all resolve against tan without a single override of their
 * own. The one thing that does not follow the band is the book's temporary
 * cover, which is ink wherever it appears -- see `.ms-plate`.
 *
 * It takes whichever title is marked `featured`, so promoting the next book is
 * moving one boolean between two content files.
 *
 * The plate is wrapped in the site's one piece of motion -- a single settle the
 * first time it comes into view. Everything else in this band, including all of
 * the type beside it, is untouched and never moves. See
 * `components/motion/motion.ts` for why that is the only thing here that does.
 */
export default function FeaturedBook({ book }: { book: ShelfBook }) {
  return (
    <section className="ms-section ms-section--paper" aria-labelledby="featured-title">
      <div className="ms-shell">
        <div className="ms-featured">
          <CoverSettle>
            <BookPlate book={book} />
          </CoverSettle>

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
              {/*
                * "Reviewer access" named the destination; this names the act.
                * Beside "About this book" the reader is choosing between two
                * things they might do, and "Enter reviewer code" is the only
                * one of the two that tells somebody holding a code that it is
                * for them. It stays `.ms-quiet` -- the book is still the offer
                * of this band, and this must not compete with it.
                */}
              {book.reviewerAccess ? (
                <Link href="/review/login" className="ms-quiet" rel="nofollow">
                  Enter reviewer code
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
