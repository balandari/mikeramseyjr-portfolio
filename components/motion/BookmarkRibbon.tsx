'use client'

import { useEffect, useRef } from 'react'

import { EASE, duration, loadGsap, prefersReducedMotion } from './motion'

/**
 * The ribbon that marks a reviewer's bookmarked line.
 *
 * A silk marker falling into place. It unfurls downward when a paragraph is
 * bookmarked and draws back up when the bookmark is removed -- the one piece of
 * motion in the reader, and the only one it will get.
 *
 * It is absolutely positioned against its paragraph, which is already
 * `position: relative`, so it occupies no space in the text flow. That is not a
 * detail: the reading column must not shift by a pixel because somebody
 * bookmarked a line, and a ribbon that participated in layout would reflow the
 * paragraph it was marking.
 *
 * `transform-origin: top` plus `scaleY` is the whole trick -- a compositor
 * property, so the unfurl cannot cause layout, and nothing around it repaints.
 *
 * Without GSAP, without JavaScript, or for a reader who has asked for
 * stillness, the ribbon is simply present or simply absent. It is drawn by CSS
 * at full size; this only animates the way it arrives.
 */
export default function BookmarkRibbon({ active }: { active: boolean }) {
  const ref = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    const element = ref.current
    if (!element) return undefined

    /*
     * The finished state, set first and unconditionally. Everything below is an
     * embellishment on top of a ribbon that is already correct -- so a failed
     * import or a reduced-motion preference leaves the right thing on screen
     * rather than an invisible one.
     */
    element.style.opacity = active ? '1' : '0'
    element.style.transform = active ? 'scaleY(1)' : 'scaleY(0)'

    if (prefersReducedMotion()) return undefined

    let cancelled = false
    let tween: { kill: () => void } | null = null

    void loadGsap().then((gsap) => {
      if (cancelled || !gsap) return

      tween = gsap.fromTo(
        element,
        {
          scaleY: active ? 0 : 1,
          opacity: active ? 0 : 1,
        },
        {
          scaleY: active ? 1 : 0,
          opacity: active ? 1 : 0,
          duration: duration('ribbon'),
          ease: EASE,
        },
      )
    })

    return () => {
      cancelled = true
      tween?.kill()
    }
  }, [active])

  return <span ref={ref} className="rv-ribbon" aria-hidden="true" />
}
