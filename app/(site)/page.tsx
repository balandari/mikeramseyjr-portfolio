import type { Metadata } from "next";
import Link from "next/link";

import Bookshelf from "@/components/site/Bookshelf";
import FeaturedBook from "@/components/site/FeaturedBook";
import Portrait from "@/components/site/Portrait";
import { featuredBook, loadShelf } from "@/lib/bookshelf";

export const metadata: Metadata = {
  title: "Mike Ramsey Jr — Author",
  description:
    "Mike Ramsey Jr writes fiction. The Backward Becoming, a novel, is in progress; PERSISTENT is a complete draft.",
};

/**
 * The homepage, kept short.
 *
 * Who this is, the book he is writing, the shelf, and a few lines with his
 * photograph that hand off to the About page rather than repeating it. Nothing
 * on the page names a title in code — the featured book and the shelf are
 * both read from `content/bookshelf/`.
 *
 * "I write fiction." is deliberately plain. It stands in until Mike supplies
 * his own defining sentence; nothing invented is put in his mouth meanwhile.
 */
export default function HomePage() {
  const books = loadShelf();
  const featured = featuredBook(books);

  return (
    <>
      <section className="ms-hero" aria-labelledby="hero-title">
        <div className="ms-shell">
          <p className="ms-eyebrow">Fiction</p>

          <h1 id="hero-title" className="ms-display ms-hero-title">
            Mike Ramsey Jr
          </h1>

          <p className="ms-sub">I write fiction.</p>

          <p className="ms-lede ms-hero-lede">
            <em>The Backward Becoming</em> is the novel I am working on now —
            unfinished, and out with a handful of readers who are telling me the
            truth about it. <em>PERSISTENT</em> is a finished draft, not yet read
            back.
          </p>

          <div className="ms-hero-actions">
            {featured ? (
              <Link href={`/books/${featured.slug}`} className="ms-btn">
                {featured.title}
                <span className="ms-arrow" aria-hidden="true">
                  &rarr;
                </span>
              </Link>
            ) : null}
            <Link href="/books" className="ms-btn ms-btn--ghost">
              All books
            </Link>
          </div>
        </div>
      </section>

      {featured ? <FeaturedBook book={featured} /> : null}

      <section className="ms-section" aria-labelledby="shelf-title">
        <div className="ms-shell">
          <p className="ms-eyebrow">Bookshelf</p>

          <h2 id="shelf-title" className="ms-h2" style={{ marginTop: "0.75rem" }}>
            Everything with a name on it
          </h2>

          <Bookshelf books={books} />
        </div>
      </section>

      <section className="ms-section" aria-labelledby="about-title" style={{ paddingTop: 0 }}>
        <div className="ms-shell">
          <div className="ms-split">
            <Portrait />

            <div>
              <p className="ms-eyebrow">About</p>

              <h2 id="about-title" className="ms-h2" style={{ marginTop: "0.75rem" }}>
                Mike Ramsey Jr
              </h2>

              <p className="ms-lede" style={{ marginTop: "1rem" }}>
                I write fiction. Two books so far — one still being written, one
                finished as a draft and waiting to be read back. If you were given
                a code for the advance reading, the door is in the footer.
              </p>

              <p style={{ marginTop: "1.5rem" }}>
                <Link href="/about" className="ms-link">
                  More about Mike, and how to reach him
                  <span className="ms-arrow" aria-hidden="true">
                    &rarr;
                  </span>
                </Link>
              </p>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
