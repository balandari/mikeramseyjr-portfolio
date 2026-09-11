import RevealOnScroll from "@/components/site/RevealOnScroll";
import SiteFooter from "@/components/site/SiteFooter";
import SiteHeader from "@/components/site/SiteHeader";

/**
 * The chrome for the public site, and only for the public site.
 *
 * `/review` deliberately sits outside this route group. The private reader has
 * its own layout, its own stylesheet and its own `robots` metadata, and giving
 * it this header, this footer or this grain would change the thing a reviewer
 * sits down with. Nothing here reaches it.
 *
 * The inline script marks the document as scripting-capable before first paint.
 * The reveal styles hide content only under `html.js`, so a visitor with
 * JavaScript off is never shown a blank page waiting for an observer that will
 * not run.
 */
const JS_FLAG = `(function(){try{document.documentElement.classList.add('js')}catch(e){}})();`;

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: JS_FLAG }} />

      <a href="#main" className="ms-skip">
        Skip to content
      </a>

      <div className="ms-grain" aria-hidden="true" />

      <div className="ms-page">
        <div className="ms-wash" aria-hidden="true" />
        <SiteHeader />
        <main id="main" tabIndex={-1}>
          {children}
        </main>
        <SiteFooter />
      </div>

      <RevealOnScroll />
    </>
  );
}
