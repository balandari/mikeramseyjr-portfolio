import type { Viewport } from "next";

import SiteFooter from "@/components/site/SiteFooter";
import SiteHeader from "@/components/site/SiteHeader";

/**
 * The chrome for the public site, and only for the public site.
 *
 * `/review` deliberately sits outside this route group. The private reader has
 * its own layout, its own stylesheet and its own `robots` metadata; nothing
 * here reaches it.
 *
 * There is no script in this layout. The public pages ship no motion, no
 * observer and no overlay; the only client component on them is the header,
 * which needs the pathname to mark the current page.
 */
export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3ecdf" },
    { media: "(prefers-color-scheme: dark)", color: "#100d0b" },
  ],
};

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <a href="#main" className="ms-skip">
        Skip to content
      </a>

      <SiteHeader />
      <main id="main" tabIndex={-1}>
        {children}
      </main>
      <SiteFooter />
    </>
  );
}
