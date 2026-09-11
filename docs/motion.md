# Motion

There is very little motion on this site, and that is the design rather than an
omission. This document says what moves, what will never move, and where the one
seam for future artwork is.

The code is `components/motion/`, and `components/motion/motion.ts` states the
policy at the top of the file. The rules are enforced by `tests/motion.test.ts`,
which is mostly a list of things the motion layer must not contain — so adding a
scroll-driven timeline later is noisy rather than easy.

---

## The whole inventory

Three things. That is not a starting point.

| What | Where | How long |
|---|---|---|
| The current book's cover settling, once, when it first comes into view | homepage featured band | 0.62s desktop, 0.42s phone |
| The bookmark ribbon unfurling and drawing back | chapter reader | 0.34s desktop, 0.24s phone |
| A cross-fade between background scenes | reader — **carrying nothing yet** | 0.9s desktop, 0.6s phone |

---

## The rules

**1. The static page is the real page.**

Nothing is hidden by CSS waiting to be revealed by script. Every animated
element is fully visible, fully laid out and fully readable before any of this
loads; the motion code sets a "from" state only after it has decided to animate.

So all of these produce the finished page rather than a blank one:

- JavaScript disabled or still loading
- `prefers-reduced-motion: reduce`
- the GSAP chunk blocked, failed or slow
- an old browser without `IntersectionObserver`

This is the rule that matters most. A missing animation is not a broken page,
and a motion library must never be able to take a page of prose down with it.

**2. Native scrolling and text position are never touched.**

No scroll-driven timelines, no `ScrollTrigger`, no pinning, no scroll hijacking,
no paragraph-by-paragraph reveals. A reader's place in a page belongs to the
reader. Nothing animates a block of running prose — the ribbon is a marker
*beside* a paragraph and is absolutely positioned, so the reading column cannot
shift by a pixel because somebody bookmarked a line.

The homepage's cover uses an `IntersectionObserver` to notice the first time it
is on screen, and then disconnects. It never reads a scroll position, never ties
progress to one, and never moves the page.

**3. Transform and opacity only.**

Both are compositor properties, so an animation cannot cause layout or reflow
the text around it.

**4. Once, never continuously.**

Every animation ends. There is no idle loop, no parallax, no animated grain, no
particles, and nothing that keeps a phone's compositor awake after the moment it
belongs to. No autoplaying sound of any kind, anywhere.

**5. Reduced motion is an instruction, not a hint.**

When the reader has asked for stillness, nothing animates — and GSAP is not even
fetched.

---

## Cost

GSAP is loaded through a dynamic `import()` from inside effects, after the
reduced-motion check. It is its own chunk (~53 kB) and is **not** in the shared
first-load bundle of any page. A reader who has asked for stillness downloads
none of it.

---

## The scene seam

`components/motion/SceneBackground.tsx` is the mechanism for a future idea: a
handful of chapters in a finished book might each carry one piece of
commissioned artwork, and moving between them should be a slow cross-fade rather
than a cut.

**It ships with no artwork.** `scene` is `null` everywhere in this codebase, and
with `scene` null the component renders nothing at all — no element, no layer,
no cost. Nothing here invents a scene, picks an image, or decides which passage
gets one. Those are Mike's decisions about his own book, and shipping a
placeholder is the fastest way to end up shipping it for real.

To use it later, render it inside the reader and pass a scene:

```tsx
<SceneBackground scene={{ id: 'chapter-four-river', image: 'url(/scenes/river.avif)' }} />
```

The rule it enforces, which must not be relaxed:

> **Artwork is peripheral. The text is not set on top of it.**

A page of prose over a picture is unreadable at some point, on some screen, in
some light — and "some" is not good enough for a novel. So the scene layer is
painted at the very back, a scrim dims it before the reading column is reached,
and the column states its own opaque background above it. Artwork lives in the
margins around the text, never behind it.

---

## What is deliberately absent

Scroll-triggered reveals · parallax · pinned sections · animated grain or
noise · particles · cursor followers · autoplaying audio or video · text that
types itself · counters that count up · anything that runs continuously on a
phone · entrance animations on page load · smooth-scroll interception.

Several of these were explicitly considered and rejected. If one is ever wanted,
it is a decision to make deliberately — and `tests/motion.test.ts` will fail
first, which is the point.
