'use client'

import { useEffect, useRef, useState } from 'react'

import { EASE, duration, loadGsap, prefersReducedMotion } from './motion'

/**
 * The seam for curated passage artwork, built now and carrying nothing yet.
 *
 * The idea it exists for: a handful of chapters in a finished book might each
 * have one piece of commissioned artwork, and moving between them should be a
 * slow cross-fade behind the text rather than a cut. This is the mechanism for
 * that, and only the mechanism. **No artwork ships with it.** `scene` is `null`
 * everywhere in this codebase today, and with `scene` null this component
 * renders nothing at all -- no element, no layer, no cost.
 *
 * Nothing here invents a scene, picks an image, or decides which passage gets
 * one. Those are Mike's decisions about his own book, and inventing a placeholder
 * would be the fastest way to end up shipping one.
 *
 * ## The rule this component exists to keep
 *
 * **Artwork is peripheral. The text is not on top of it -- the text has its own
 * opaque surface, and the artwork lives in the margins around it.** A page of
 * prose over a picture is unreadable at some point on some screen in some light,
 * and "some" is not good enough for a novel. So the scene layer is painted at
 * the very back (`z-index: 0`), the reading column keeps a solid background of
 * its own, and a scene is dimmed by a scrim before the column is even reached.
 *
 * ## How it moves
 *
 * Two stacked panes, A and B. The incoming scene is painted into the idle pane
 * at `opacity: 0` and faded up while the outgoing one fades down -- opacity
 * only, on a layer that contains no text, so nothing about the reading position
 * or the layout can be disturbed by it. Nothing is scroll-driven. Nothing
 * loops. Nothing moves once the fade has finished.
 *
 * Under `prefers-reduced-motion`, or with GSAP unavailable, the swap is
 * instantaneous: the right scene is shown, just without the fade. The reader
 * never ends up with a blank layer or a half-faded one.
 */

export type Scene = {
  /** Stable identifier. A change of id is what triggers a transition. */
  id: string
  /**
   * A CSS `background-image` value for the artwork -- typically a `url(...)`.
   * Whatever is supplied here is Mike's own artwork; nothing in this repository
   * generates, selects or ships one.
   */
  image?: string
  /** A CSS colour painted under the artwork, and used alone when there is none. */
  tint?: string
}

export default function SceneBackground({ scene }: { scene: Scene | null }) {
  const paneA = useRef<HTMLDivElement | null>(null)
  const paneB = useRef<HTMLDivElement | null>(null)
  /** Which pane is currently showing. The other is the one to paint into. */
  const [front, setFront] = useState<'a' | 'b'>('a')
  const shownId = useRef<string | null>(null)

  useEffect(() => {
    // Nothing to show, and nothing rendered to show it in.
    if (!scene) {
      shownId.current = null
      return undefined
    }

    if (shownId.current === scene.id) return undefined

    const incoming = (front === 'a' ? paneB : paneA).current
    const outgoing = (front === 'a' ? paneA : paneB).current
    if (!incoming) return undefined

    // Paint the incoming pane before anything is faded, so a cross-fade can
    // never reveal an empty layer.
    incoming.style.backgroundImage = scene.image ?? 'none'
    incoming.style.backgroundColor = scene.tint ?? 'transparent'

    const first = shownId.current === null
    shownId.current = scene.id

    const settle = () => {
      incoming.style.opacity = '1'
      if (outgoing) outgoing.style.opacity = '0'
      setFront((current) => (current === 'a' ? 'b' : 'a'))
    }

    // The first scene of a session has nothing to cross-fade from, so it is
    // simply there. Fading it up would be an entrance animation, which this
    // site does not do.
    if (first || prefersReducedMotion()) {
      settle()
      return undefined
    }

    let cancelled = false
    const tweens: { kill: () => void }[] = []

    void loadGsap().then((gsap) => {
      if (cancelled) return
      if (!gsap) {
        settle()
        return
      }

      const seconds = duration('sceneCrossfade')
      tweens.push(gsap.to(incoming, { opacity: 1, duration: seconds, ease: EASE }))
      if (outgoing) {
        tweens.push(gsap.to(outgoing, { opacity: 0, duration: seconds, ease: EASE }))
      }
      setFront((current) => (current === 'a' ? 'b' : 'a'))
    })

    return () => {
      cancelled = true
      for (const tween of tweens) tween.kill()
    }
  }, [scene, front])

  // No scene, no layer. This is the state the site is actually in.
  if (!scene) return null

  return (
    <div className="rv-scene" aria-hidden="true">
      <div className="rv-scene-pane" ref={paneA} />
      <div className="rv-scene-pane" ref={paneB} />
      {/*
       * The scrim. Artwork is never shown at full strength behind a reading
       * surface; this is what keeps it peripheral even before the column's own
       * opaque background is reached.
       */}
      <div className="rv-scene-scrim" />
    </div>
  )
}
