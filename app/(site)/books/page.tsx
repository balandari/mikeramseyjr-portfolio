import type { Metadata } from "next";

import Bookshelf from "@/components/site/Bookshelf";
import { loadShelf } from "@/lib/bookshelf";

export const metadata: Metadata = {
  title: "Books — Mike Ramsey Jr",
  description: "The books of Mike Ramsey Jr, and what stage each one is at.",
};

/**
 * The whole shelf on its own page.
 *
 * With one title this is a short page, and that is the correct short page: it
 * exists so the second title has somewhere to arrive, and so the homepage never
 * has to become a catalogue.
 */
export default function BooksPage() {
  const books = loadShelf();

  return (
    <section className="ms-section" aria-labelledby="books-title">
      <div className="ms-shell">
        <p className="ms-eyebrow ms-rise">Bookshelf</p>

        <h1 id="books-title" className="ms-display ms-rise" data-delay="1" style={{ marginTop: "1rem" }}>
          Books
        </h1>

        <p className="ms-lede ms-rise" data-delay="2" style={{ marginTop: "1.5rem" }}>
          {books.length === 1
            ? "One book, in progress. Nothing is listed here before it exists."
            : "Nothing is listed here before it exists."}
        </p>

        <div className="ms-reveal" data-delay="2">
          <Bookshelf books={books} />
        </div>
      </div>
    </section>
  );
}
