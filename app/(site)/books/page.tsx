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
 * It says nothing about how many titles there are: the count is whatever is in
 * `content/bookshelf/`, and the page reads the same with two as it will with
 * five.
 */
export default function BooksPage() {
  const books = loadShelf();

  return (
    <section className="ms-section" aria-labelledby="books-title">
      <div className="ms-shell">
        <p className="ms-eyebrow">Bookshelf</p>

        <h1 id="books-title" className="ms-display" style={{ marginTop: "0.85rem" }}>
          Books
        </h1>

        <p className="ms-sub">
          Each one with its real stage next to it. Nothing is listed here before it
          exists.
        </p>

        <Bookshelf books={books} />
      </div>
    </section>
  );
}
