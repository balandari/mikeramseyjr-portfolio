import type { Metadata } from "next";
import Link from "next/link";

import AuthorLogo from "@/components/site/AuthorLogo";
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
      {/*
       * The introduction, on ink, with the medallion beside it.
       *
       * `ms-section--ink` is what makes the band black, and it is a *fixed*
       * ground: it does not follow the reader's colour scheme, because the
       * point of this page is black introduction then tan book, in that order,
       * and a ground built out of `--inv-*` would swap the two at night. The
       * class remaps the semantic tokens, so every control inside — both
       * buttons, their hover and their focus ring — comes out right without one
       * rule of its own.
       *
       * The medallion beside the copy is the *logo*, at full strength — not a
       * watermark, and not faded. On a laptop it is the mark itself, the way
       * it was accepted: brass, silver, the letters and the open book, whole.
       *
       * It is rendered here and hidden below 52rem rather than being a
       * background, because on a laptop it is content: it carries the
       * identity, and it has alt text. A phone gets the stationary watermark
       * instead (`.ms-hero::before` and its siblings), and two marks in one
       * band would be one too many — so exactly one of them is ever visible.
       *
       * It comes after the copy in source order, so the name and the first
       * sentence are what a screen reader and a keyboard reach first.
       */}
      <section className="ms-hero ms-section--ink" aria-labelledby="hero-title">
        <div className="ms-shell ms-hero-inner">
          <div className="ms-hero-copy">
            <p className="ms-eyebrow">Fiction</p>

            <h1 id="hero-title" className="ms-display ms-hero-title">
              Mike Ramsey Jr
            </h1>

            <p className="ms-sub">I write fiction.</p>

            <p className="ms-lede ms-hero-lede">
              <em>The Backward Becoming</em> is the novel I am working on now —
              unfinished, and out with a handful of readers who are telling me
              the truth about it. <em>PERSISTENT</em> is a finished draft, not
              yet read back.
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

            {/*
             * The invited reader's entrance, on the first screen.
             *
             * Somebody who was handed nothing but `mikeramseyjr.com` and a code
             * has to be able to see where to go without being told and without
             * scrolling. That is what this line is for, and it is why it is a
             * line and not a card: it must be unmistakable to the one visitor
             * it is addressed to and nearly invisible to everybody else, which
             * a banner cannot do.
             *
             * It is deliberately weaker than the book button above it. The
             * public offer of this page is the novel; this is a side door with
             * a light on.
             *
             * `/review` routes by session -- a signed-in reviewer lands in
             * their library, a signed-out one at code entry -- so the same link
             * serves the first visit and the fiftieth.
             */}
            <p className="ms-hero-invite">
              <Link href="/review" rel="nofollow">
                Invited to read? Enter your reviewer code
                <span className="ms-arrow" aria-hidden="true">
                  &rarr;
                </span>
              </Link>
            </p>
          </div>

          <AuthorLogo
            className="ms-hero-mark"
            sizes="(min-width: 75rem) 15rem, (min-width: 43.75rem) 20vw, 8.75rem"
            priority
          />
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
            <Portrait
              className="ms-portrait ms-portrait--home"
              sizes="(min-width: 64rem) 10rem, (min-width: 30rem) 26vw, 6rem"
            />

            <div>
              <p className="ms-eyebrow">About</p>

              <h2 id="about-title" className="ms-h2" style={{ marginTop: "0.75rem" }}>
                Mike Ramsey Jr
              </h2>

              {/*
               * This section is about Mike. That is the whole of its job.
               *
               * It used to also invite advance readers and carry an "Open
               * advance reading" control, which made a short introduction do two
               * unrelated things and put the reviewer door in the least likely
               * place to be looked for. The door is now on the first screen
               * above, in the current-book band, in the navigation and in the
               * footer -- four places, all of them nearer than this one -- so
               * removing it here costs an invited reader nothing and gives the
               * page back its subject.
               */}
              <p className="ms-lede" style={{ marginTop: "1rem" }}>
                I write fiction. Two books so far — one still being written, one
                finished as a draft and waiting to be read back.
              </p>

              <div className="ms-about-actions">
                <Link href="/about" className="ms-link">
                  More about Mike, and how to reach him
                  <span className="ms-arrow" aria-hidden="true">
                    &rarr;
                  </span>
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
