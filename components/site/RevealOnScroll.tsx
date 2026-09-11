"use client";

import { useEffect } from "react";

/**
 * One client island for the whole site's motion.
 *
 * Every revealed element is rendered on the server with `.ms-reveal`; this
 * component only decides when each one becomes visible. That keeps the pages
 * themselves server components, and keeps the amount of JavaScript on a
 * reading site to roughly nothing.
 *
 * Three behaviours are deliberate:
 *
 *  - `prefers-reduced-motion: reduce` skips the observer entirely and marks
 *    everything visible at once. The CSS also removes the transition, so a
 *    reader who asked for no motion gets none rather than a faster version.
 *  - A browser with no `IntersectionObserver` gets the same immediate reveal.
 *  - Elements already above the fold are handled by the observer's first
 *    callback, which fires on observe, so nothing waits for a scroll that may
 *    never happen.
 */
export default function RevealOnScroll() {
  useEffect(() => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(".ms-reveal"));
    if (nodes.length === 0) return;

    const showAll = () => nodes.forEach((node) => node.classList.add("is-visible"));

    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduced || typeof IntersectionObserver === "undefined") {
      showAll();
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.08, rootMargin: "0px 0px -40px 0px" },
    );

    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, []);

  return null;
}
