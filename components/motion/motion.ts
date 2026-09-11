/**
 * The site's entire motion policy, in one file.
 *
 * There is deliberately very little motion here. This is an author's site and a
 * reading surface; the things that move are a book cover settling once when the
 * homepage opens, a ribbon unfurling when a reviewer bookmarks a line, and a
 * background seam that is not yet carrying anything. That is the whole
 * inventory, and it is meant to stay that way.
 *
 * Four rules hold everywhere, and the helpers below exist to make them cheap to
 * obey rather than to remember:
 *
 *   1. **The static page is the real page.** Nothing is hidden by CSS waiting to
 *      be revealed by script. Every element animated here is fully visible,
 *      fully laid out and fully readable before any of this loads -- the motion
 *      code sets a "from" state only after it has decided to animate, and puts
 *      it back immediately if it cannot. So no-JS, reduced-motion, a failed
 *      import, a slow phone and a blocked CDN all produce the finished page
 *      rather than a blank one. This is the rule that matters most; the others
 *      are details.
 *
 *   2. **Never touch scrolling, and never move text.** No scroll-driven
 *      timelines, no scroll hijacking, no pinning, no smooth-scroll
 *      interception, no paragraph-by-paragraph reveals. A reader's position in
 *      a page belongs to the reader. Nothing here animates a block of running
 *      prose.
 *
 *   3. **Transform and opacity only.** Both are compositor properties, so an
 *      animation cannot cause layout or reflow the text around it.
 *
 *   4. **Once, never continuously.** Every animation here has an end. There is
 *      no idle loop, no parallax, no grain, no particles, and nothing that keeps
 *      a phone's compositor awake after the moment it belongs to.
 */

/** Media queries, read at the moment of use rather than cached at import. */
function matches(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia(query).matches
  } catch {
    return false
  }
}

/**
 * Has the reader asked for stillness?
 *
 * Treated as an instruction, not a hint. When this is true nothing on the site
 * animates at all: the static page is served as-is and the motion code is never
 * even fetched.
 */
export function prefersReducedMotion(): boolean {
  return matches('(prefers-reduced-motion: reduce)')
}

/**
 * Is this a phone?
 *
 * Used only to make the same animation smaller and shorter, never to add one.
 * A coarse pointer or a narrow viewport is enough to say yes.
 */
export function isCompactViewport(): boolean {
  return matches('(max-width: 47.999rem)') || matches('(pointer: coarse)')
}

/** The subset of GSAP this site uses. Narrow on purpose. */
export type Gsap = {
  set: (targets: unknown, vars: Record<string, unknown>) => unknown
  to: (targets: unknown, vars: Record<string, unknown>) => { kill: () => void }
  fromTo: (
    targets: unknown,
    from: Record<string, unknown>,
    to: Record<string, unknown>,
  ) => { kill: () => void }
}

/**
 * Fetch GSAP, once, and only if it is going to be used.
 *
 * A dynamic import so the library is its own chunk and never lands in the
 * initial bundle of a page that may not animate at all. It is called from
 * inside effects, after the reduced-motion check, so a reader who has asked for
 * stillness downloads none of it.
 *
 * Returns null rather than throwing when the import fails. A missing animation
 * is not a broken page -- see rule 1 -- and a motion library is the last thing
 * that should be able to take a page of prose down with it.
 */
let pending: Promise<Gsap | null> | null = null

export function loadGsap(): Promise<Gsap | null> {
  if (typeof window === 'undefined') return Promise.resolve(null)
  if (prefersReducedMotion()) return Promise.resolve(null)

  if (!pending) {
    pending = import('gsap')
      .then((module) => (module.gsap ?? module.default) as Gsap)
      .catch(() => null)
  }

  return pending
}

/** Test seam. Drops the memoised import so a test can drive both outcomes. */
export function __resetGsap(): void {
  pending = null
}

/**
 * Durations, in seconds, in one place so "restrained" is a number rather than
 * an intention. The compact variants are what a phone gets: shorter, because a
 * small screen shows the whole gesture at once and a long one just delays the
 * page.
 */
export const DURATION = {
  coverSettle: { full: 0.62, compact: 0.42 },
  ribbon: { full: 0.34, compact: 0.24 },
  sceneCrossfade: { full: 0.9, compact: 0.6 },
} as const

/** One easing curve, shared, so nothing here can feel like a different site. */
export const EASE = 'power2.out'

export function duration(step: keyof typeof DURATION): number {
  return isCompactViewport() ? DURATION[step].compact : DURATION[step].full
}
