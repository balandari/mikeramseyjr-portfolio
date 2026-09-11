import type { Metadata } from "next";
import Link from "next/link";

import Portrait from "@/components/site/Portrait";
import { loadShelf } from "@/lib/bookshelf";

export const metadata: Metadata = {
  title: "About — Mike Ramsey Jr",
  description:
    "Mike Ramsey Jr writes fiction. What he is working on, and how to reach him.",
};

/**
 * The author page, and the site's contact path.
 *
 * Everything on it is either a fact about the writing or a way to reach Mike.
 * There is no biography beyond what he has said himself, and no
 * characterisation of his work in anyone's voice but his -- which, until he
 * supplies one, means none. The photograph is his own, supplied for this.
 */
export default function AboutPage() {
  const books = loadShelf();

  return (
    <>
      <section className="ms-hero" aria-labelledby="about-title">
        <div className="ms-shell">
          <p className="ms-eyebrow">About</p>

          <h1 id="about-title" className="ms-display" style={{ marginTop: "0.85rem" }}>
            Mike Ramsey Jr
          </h1>

          <p className="ms-sub">I write fiction.</p>
        </div>
      </section>

      <section className="ms-section ms-section--inverse" aria-labelledby="about-work">
        <div className="ms-shell">
          <div className="ms-split">
            <div>
              <Portrait priority />
              <p className="ms-meta ms-portrait-caption">
                Mike Ramsey Jr. Photograph supplied by the author.
              </p>
            </div>

            <div>
              <h2 id="about-work" className="ms-h2">
                What I&apos;m writing
              </h2>

              <div className="ms-prose" style={{ marginTop: "1.25rem" }}>
                <p>
                  <em>The Backward Becoming</em> is the novel I&apos;m working on now.
                  It opens in the spring of 1972, in a cholera-relief camp outside
                  Dacca, and then turns back to Calder, Kentucky — a front room in
                  1946, a tenth birthday the January after, a July afternoon at the
                  river in 1951 — and works forward from there.
                </p>
                <p>
                  It isn&apos;t finished. Four chapters are with a small circle of
                  advance readers who are reading them properly and telling me what
                  is and isn&apos;t working. That is the only place any of it can be
                  read right now.
                </p>
                <p>
                  <em>PERSISTENT</em> is the other one: twenty-nine chapters, written
                  through to the end, and not yet read back. When it has had the
                  line-by-line pass it needs, I&apos;ll have something to say about
                  it. Until then it is a finished draft and nothing more.
                </p>
              </div>

              <ul className="ms-footer-links" style={{ marginTop: "1.5rem" }}>
                {books.map((book) => (
                  <li key={book.slug}>
                    <Link href={`/books/${book.slug}`} className="ms-link">
                      {book.title}
                      <span className="ms-arrow" aria-hidden="true">
                        &rarr;
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section className="ms-section" aria-labelledby="about-contact">
        <div className="ms-shell">
          <div className="ms-split">
            <p className="ms-eyebrow">Contact</p>

            <div>
              <h2 id="about-contact" className="ms-h2">
                Get in touch
              </h2>

              <p className="ms-lede" style={{ marginTop: "1rem" }}>
                Write to me. I read everything, and I answer what I can.
              </p>

              <p style={{ marginTop: "1.5rem" }}>
                <a href="mailto:mike@mikeramseyjr.com" className="ms-link">
                  mike@mikeramseyjr.com
                  <span className="ms-arrow" aria-hidden="true">
                    &rarr;
                  </span>
                </a>
              </p>

              <p className="ms-meta" style={{ marginTop: "2rem", maxWidth: "34rem" }}>
                There is no mailing list, no newsletter and nothing to subscribe to.
                If you were given a code for the advance reading,{" "}
                <Link href="/review/login" className="ms-inline-link" rel="nofollow">
                  sign in here
                </Link>
                . Software and other projects live at{" "}
                <a
                  href="https://tcbyws.com"
                  className="ms-inline-link"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  tcbyws.com
                </a>
                .
              </p>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
