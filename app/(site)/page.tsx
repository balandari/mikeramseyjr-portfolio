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

              <p className="ms-lede" style={{ marginTop: "1rem" }}>
                I write fiction. Two books so far — one still being written, one
                finished as a draft and waiting to be read back. If you were
                invited to read <em>The Backward Becoming</em> early, you can open
                your private reading area here.
              </p>

              {/*
               * The advance reading is named in this paragraph, so the way in
               * belongs beside it. It used to say the door was "in the footer",
               * which asked an invited reader to go hunting for a link on a page
               * they had never seen; an instruction to search is not access.
               *
               * `/review` decides what to do: an authenticated reviewer lands in
               * their library, a signed-out one is redirected to code entry. So
               * one control serves both, and neither has to know which they are.
               *
               * Reviewer access stays in the header and footer as navigation, but
               * nothing on this page depends on a reader finding it there now.
               */}
              <div className="ms-about-actions">
                <Link href="/review" className="ms-btn ms-btn--ghost">
                  Open advance reading
                  <span className="ms-arrow" aria-hidden="true">
                    &rarr;
                  </span>
                </Link>

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
