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
 * The homepage.
 *
 * Four movements: who this is, the book he is writing, the shelf, and a short
 * way in to the person. Nothing on the page names a title in code — the
 * featured book and the shelf are both read from `content/bookshelf/`, so a
 * further title changes this page without editing it.
 */
export default function HomePage() {
  const books = loadShelf();
  const featured = featuredBook(books);

  return (
    <>
      {/* ------------------------------------------------------------ hero */}
      <section className="ms-hero" aria-labelledby="hero-title">
        <div className="ms-shell">
          <p className="ms-eyebrow ms-rise">Fiction</p>

          <h1 id="hero-title" className="ms-display ms-hero-title ms-rise" data-delay="1">
            Mike Ramsey Jr
          </h1>

          <p className="ms-lede ms-hero-lede ms-rise" data-delay="2">
            I write about ordinary lives, with the small parts left in.{" "}
            <em>The Backward Becoming</em> is the novel I am working on now —
            unfinished, and out with a handful of readers who are telling me the
            truth about it.
          </p>

          <div className="ms-hero-actions ms-rise" data-delay="3">
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

      {/* -------------------------------------------------------- featured */}
      {featured ? <FeaturedBook book={featured} /> : null}

      {/* ------------------------------------------------------- bookshelf */}
      <section className="ms-section" aria-labelledby="shelf-title">
        <div className="ms-shell">
          <p className="ms-eyebrow ms-reveal">Bookshelf</p>

          <h2 id="shelf-title" className="ms-h2 ms-reveal" style={{ marginTop: "0.75rem" }}>
            Everything with a name on it
          </h2>

          <p className="ms-lede ms-reveal" data-delay="1" style={{ marginTop: "0.85rem" }}>
            One novel still being written, and one finished draft waiting to be read
            back.
          </p>

          <div className="ms-reveal" data-delay="2">
            <Bookshelf books={books} />
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------- about */}
      <section className="ms-section" aria-labelledby="about-title" style={{ paddingTop: 0 }}>
        <div className="ms-shell">
          <div className="ms-split">
            <div className="ms-reveal">
              <Portrait />
            </div>

            <div className="ms-reveal" data-delay="1">
              <p className="ms-eyebrow">About</p>

              <h2 id="about-title" className="ms-h2" style={{ marginTop: "0.75rem" }}>
                A short introduction
              </h2>

              <div className="ms-prose" style={{ marginTop: "1.25rem" }}>
                <p>
                  I&apos;m Mike Ramsey Jr. I write fiction about ordinary people and
                  the small, specific things their lives turn out to be made of — a
                  crust crimped with a fork, a sandbar below town, a watch counting
                  down a drip rate in a tent in the heat.
                </p>
                <p>
                  <em>The Backward Becoming</em> is the book I&apos;m working on. It
                  opens in 1972 and then turns back to a Kentucky childhood in the
                  late forties and early fifties, and works forward from there. It
                  isn&apos;t finished. <em>PERSISTENT</em> is finished as a draft and
                  hasn&apos;t been read back yet.
                </p>
                <p>
                  A few chapters of <em>The Backward Becoming</em> are out with a
                  small circle of advance readers right now. If you&apos;re one of
                  them, there&apos;s a door below. If you just want to say something
                  about the work, my address is down there too.
                </p>
              </div>

              <p style={{ marginTop: "1.5rem" }}>
                <Link href="/about" className="ms-link">
                  More about Mike
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
