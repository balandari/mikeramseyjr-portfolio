'use client'

import { useEffect, useRef } from 'react'

import { EASE, duration, isCompactViewport, loadGsap, prefersReducedMotion } from './motion'

/**
 * The homepage's one moment of motion: the current book's cover settling.
 *
 * A book arriving on a table. It happens once, when the cover first comes into
 * view, and then the page is still forever. There is no scroll-driven anything
 * here -- the observer below notices that the element is on screen and then
 * disconnects; it never reads a scroll position, never ties progress to one,
 * and never moves the page.
 *
 * Nothing around it moves. The band's heading, the description, the details and
 * the links are all untouched: this animates one wrapper, which contains one
 * cover, and it animates it with `transform` and `opacity` only, so no text
 * near it can reflow.
 *
 * The static page is the real page. This renders its children plainly; the
 * "from" state is applied by script only after GSAP has actually loaded and
 * reduced motion has been ruled out. If any of that fails -- no JS, a blocked
 * chunk, a reader who asked for stillness -- the cover is simply there, which
 * is what it would have animated to anyway.
 */
export default function CoverSettle({ children }: { children: React.ReactNode }) {
  const holder = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const element = holder.current
    if (!element) return undefined
    if (prefersReducedMotion()) return undefined
    if (typeof IntersectionObserver === 'undefined') return undefined

    let cancelled = false
    let tween: { kill: () => void } | null = null
    let observer: IntersectionObserver | null = null

    void loadGsap().then((gsap) => {
      if (cancelled || !gsap) return

      const compact = isCompactViewport()

      const play = () => {
        tween = gsap.fromTo(
          element,
          {
            opacity: 0,
            // A phone sees the whole gesture at once, so it gets a smaller one.
            y: compact ? 10 : 18,
            // Barely a scale at all. Enough to read as weight, not as a zoom.
            scale: compact ? 1 : 0.985,
          },
          {
            opacity: 1,
            y: 0,
            scale: 1,
            duration: duration('coverSettle'),
            ease: EASE,
            // Leave no transform behind once it has landed, so the element is
            // exactly as the stylesheet left it.
            clearProps: 'transform,opacity',
          },
        )
      }

      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue
            // Once. The observer's whole job is to notice the first time.
            observer?.disconnect()
            observer = null
            play()
          }
        },
        { threshold: 0.25 },
      )

      observer.observe(element)
    })

    return () => {
      cancelled = true
      observer?.disconnect()
      tween?.kill()
    }
  }, [])

  return (
    <div ref={holder} className="ms-settle">
      {children}
    </div>
  )
}
