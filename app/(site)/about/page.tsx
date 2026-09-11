import type { Metadata } from "next";
import Link from "next/link";

import { featuredBook, loadShelf } from "@/lib/bookshelf";

export const metadata: Metadata = {
  title: "About — Mike Ramsey Jr",
  description:
    "Mike Ramsey Jr writes fiction. What he is working on, and how to reach him.",
};

/**
 * The author page, and the site's contact path.
 *
 * Everything on it is either about the writing or a way to reach Mike. There
 * is no biography beyond what he has said himself, no photograph, and no
 * credentials, because inventing any of those would be worse than a page that
 * is simply short.
 *
 * ASSET: an approved author photograph would belong in the left column here,
 * beside the pull quote. Until one exists the column carries type instead.
 */
export default function AboutPage() {
  const featured = featuredBook(loadShelf());

  return (
    <>
      <section className="ms-hero" aria-labelledby="about-title">
        <div className="ms-shell">
          <p className="ms-eyebrow ms-rise">About</p>

          <h1 id="about-title" className="ms-display ms-rise" data-delay="1" style={{ marginTop: "1rem" }}>
            {"Mike "}
            <br />
            Ramsey Jr
          </h1>

          <p className="ms-hero-sub ms-rise" data-delay="2">
            I write about the parts of a life nobody thought to write down.
          </p>
        </div>
      </section>

      <section className="ms-section ms-section--paper" aria-labelledby="about-work">
        <div className="ms-shell">
          <div className="ms-split">
            <div className="ms-reveal">
              <p className="ms-eyebrow">The work</p>
              <p className="ms-pull" style={{ marginTop: "1.25rem" }}>
                A person is assembled out of afternoons.
              </p>
            </div>

            <div className="ms-reveal" data-delay="1">
              <h2 id="about-work" className="ms-h2">
                What I&apos;m writing
              </h2>

              <div className="ms-prose" style={{ marginTop: "1.5rem" }}>
                <p>
                  I write fiction about ordinary people, and about the small,
                  specific things their lives turn out to be made of. The kitchen
                  more than the war. The sandbar more than the city. What somebody
                  learned at nine that they were still carrying at thirty-five.
                </p>
                <p>
                  <em>The Backward Becoming</em> is the novel I&apos;m working on now.
                  It opens in the spring of 1972, in a cholera-relief camp outside
                  Dacca, and then turns back to Calder, Kentucky — a front room in
                  1946, a tenth birthday the January after, a July afternoon at the
                  river in 1951 — and works forward through the days that made the
                  woman in that tent.
                </p>
                <p>
                  It isn&apos;t finished, and I&apos;m not going to pretend otherwise.
                  Four chapters are with a small circle of advance readers who are
                  reading them properly and telling me what is and isn&apos;t working.
                  That is the only place any of it can be read right now.
                </p>
              </div>

              {featured ? (
                <p style={{ marginTop: "1.75rem" }}>
                  <Link href={`/books/${featured.slug}`} className="ms-link">
                    About {featured.title}
                    <span className="ms-arrow" aria-hidden="true">
                      &rarr;
                    </span>
                  </Link>
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <section className="ms-section" aria-labelledby="about-contact">
        <div className="ms-shell">
          <div className="ms-split">
            <div className="ms-reveal">
              <p className="ms-eyebrow">Contact</p>
            </div>

            <div className="ms-reveal" data-delay="1">
              <h2 id="about-contact" className="ms-h2">
                Get in touch
              </h2>

              <p className="ms-lede" style={{ marginTop: "1.25rem" }}>
                Write to me. I read everything, and I answer what I can.
              </p>

              <p style={{ marginTop: "1.75rem" }}>
                <a href="mailto:mike@mikeramseyjr.com" className="ms-link">
                  mike@mikeramseyjr.com
                  <span className="ms-arrow" aria-hidden="true">
                    &rarr;
                  </span>
                </a>
              </p>

              <p className="ms-meta" style={{ marginTop: "2.25rem", maxWidth: "34rem" }}>
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
