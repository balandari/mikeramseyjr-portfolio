import Link from "next/link";

import AuthorMark from "./AuthorMark";

/**
 * The footer carries the three things the site owes a visitor: how to reach
 * Mike, where the books are, and -- for the small number of people who have
 * been given a code -- the way into the private advance-reading area.
 *
 * It is also the single place the software work is acknowledged, as one link
 * off to tcbyws.com. That is where those projects live now; this site is about
 * the books.
 *
 * The footer is the page's one dark band -- see `.ms-footer` -- which is what
 * lets the warm paper above it read as paper rather than as the whole world.
 */
export default function SiteFooter() {
  return (
    <footer className="ms-footer" id="contact">
      <div className="ms-shell">
        <div className="ms-footer-grid">
          <div>
            {/*
              * Small, and beside the name rather than over it. The footer is
              * the page's dark band, which is the one ground the mark's own
              * near-black tile disappears into — so it is sized to read as a
              * signature at the foot of a page, not as a logo lockup.
              */}
            <p className="ms-footer-name">
              <AuthorMark size={26} className="ms-footer-mark" />
              <span className="ms-h3">Mike Ramsey Jr</span>
            </p>
            <hr className="ms-rule" />
            <p className="ms-meta" style={{ marginTop: "1rem", maxWidth: "22rem" }}>
              Fiction. <em>The Backward Becoming</em> is in progress. If you want to
              say something about the work, write to me — I read everything.
            </p>
          </div>

          <div>
            <h2>Read</h2>
            <ul className="ms-footer-links">
              <li>
                <Link href="/books/the-backward-becoming" className="ms-quiet">
                  The Backward Becoming
                </Link>
              </li>
              <li>
                <Link href="/books" className="ms-quiet">
                  All books
                </Link>
              </li>
              <li>
                <Link href="/about" className="ms-quiet">
                  About Mike
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <h2>Elsewhere</h2>
            <ul className="ms-footer-links">
              <li>
                <a href="mailto:mike@mikeramseyjr.com" className="ms-quiet">
                  mike@mikeramseyjr.com
                </a>
              </li>
              <li>
                <a
                  href="https://tcbyws.com"
                  className="ms-quiet"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Software &amp; other projects
                </a>
              </li>
              <li>
                <Link href="/review/login" className="ms-quiet" rel="nofollow">
                  Reviewer access
                </Link>
              </li>
            </ul>
          </div>
        </div>

        <div className="ms-footer-bottom">
          <p className="ms-meta">&copy; 2026 Mike Ramsey Jr.</p>
          <p className="ms-meta">
            Advance reading is by invitation and is not open to the public.
          </p>
          {/*
            * The way in for the person whose site this is.
            *
            * Quiet, and deliberately not hidden. `/admin` is an ordinary route
            * that answers to anybody; it is protected by asking Google who you
            * are and checking that against an allowlist, not by being difficult
            * to find. A link here costs nothing and saves Mike hunting for his
            * own dashboard on a phone.
            */}
          <Link href="/admin" className="ms-footer-author" rel="nofollow">
            Author access
          </Link>
        </div>
      </div>
    </footer>
  );
}
