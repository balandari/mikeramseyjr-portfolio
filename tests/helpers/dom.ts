/**
 * A browser, for the length of one test file.
 *
 * Node has no DOM, so a component test has to bring one. This builds a single
 * jsdom window, publishes the handful of globals React and Testing Library read
 * off `globalThis`, and hands back a function that puts every one of them back
 * the way it found it.
 *
 * ## What is shimmed, and why each one is here
 *
 * Only what the real component actually touches. A shim that nothing needs is a
 * quiet claim that the code depends on it, and a shim that returns something
 * convenient is a way to prove the harness rather than the product.
 *
 *   - **`matchMedia`** — jsdom does not implement it, and `components/motion`
 *     calls it on every mount. It answers *deterministically*: reduced motion
 *     is on, so `BookmarkRibbon` sets its final state and returns before it
 *     would dynamically import GSAP. That is real production behaviour for a
 *     reader who has asked for stillness, not a stub of the ribbon.
 *
 *   - **`requestAnimationFrame` / `cancelAnimationFrame`** — jsdom provides
 *     these only with `pretendToBeVisual`, and even then on a real clock. The
 *     reader schedules its scroll and measurement work through them, so they
 *     are provided here as immediate macrotasks: the callback runs, once, soon,
 *     and a cancelled one does not run at all.
 *
 *   - **`scrollTo`** — jsdom has no layout, so it declines to scroll and logs
 *     a "not implemented" error through its virtual console. The reader calls
 *     it on mount. A no-op keeps the noise out of the test output without
 *     hiding anything: there is nothing to scroll in a document with no layout.
 *
 *   - **`IS_REACT_ACT_ENVIRONMENT`** — React 18 warns on every state update
 *     outside `act()` unless this flag says the environment is a test one.
 *     Testing Library's `render` and `fireEvent` wrap their work in `act`; the
 *     flag is what lets them.
 *
 *   - **`self`** — `next/link` prefetches through
 *     `next/dist/client/request-idle-callback`, which reads `self` rather than
 *     `window`. jsdom's window has it; Node's global object does not, and the
 *     real `Link` throws a `ReferenceError` out of its mount effect without it.
 *     It is the same object as `window`.
 *
 * `next/link` is otherwise **not** shimmed, and neither is the app router. The
 * real `Link` renders its anchor with no router context in place -- it only
 * declines to prefetch -- so there is nothing to mock, and mocking it would
 * replace production code with a double for no reason. If that ever stops being
 * true, the mock belongs here and the fact belongs in the report.
 *
 * ## Restoring
 *
 * `installDom()` records the previous value of every global it writes --
 * including "there was no such property", which is not the same as `undefined`
 * -- and `restore()` deletes what it created and reassigns what it replaced.
 * Nothing is left behind for the next test, and `node --test` runs each file in
 * its own process anyway, so the two together make leakage twice-impossible.
 */

import { JSDOM } from 'jsdom'

/**
 * The globals taken straight off the jsdom window.
 *
 * Not the complete published set, and it does not claim to be: `matchMedia` is
 * published too, in the line just below the loop, because it is a shim written
 * here rather than a value read off the window. Restoration does not depend on
 * this array either way -- `publish()` saves a descriptor for every key it
 * writes and `restore()` reinstates all of them, `matchMedia` included.
 */
const PUBLISHED = [
  'window',
  'self',
  'document',
  'navigator',
  'location',
  'history',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'CustomEvent',
  'DocumentFragment',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'IS_REACT_ACT_ENVIRONMENT',
] as const

type Slot = { descriptor: PropertyDescriptor | undefined }

export type DomHandle = {
  window: JSDOM['window']
  /** Put every global back exactly as it was, and close the window. */
  restore: () => void
}

/**
 * Build the window and publish it.
 *
 * `url` matters: the reader builds a private-link URL from
 * `window.location.origin`, and `localStorage` refuses to exist on
 * `about:blank`.
 */
export function installDom(options: { url?: string } = {}): DomHandle {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: options.url ?? 'https://mikeramseyjr.test/review/the-book/one',
    pretendToBeVisual: false,
  })

  const win = dom.window as unknown as Record<string, unknown> & JSDOM['window']

  /* Deterministic, and deterministically still. */
  Object.defineProperty(win, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      media: query,
      matches: query.includes('prefers-reduced-motion'),
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })

  /* Immediate, cancellable, and not on a real clock. */
  let frame = 0
  const frames = new Map<number, ReturnType<typeof setTimeout>>()
  const raf = (callback: (time: number) => void): number => {
    frame += 1
    const id = frame
    frames.set(
      id,
      setTimeout(() => {
        frames.delete(id)
        callback(0)
      }, 0),
    )
    return id
  }
  const caf = (id: number): void => {
    const timer = frames.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      frames.delete(id)
    }
  }
  Object.defineProperty(win, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: raf,
  })
  Object.defineProperty(win, 'cancelAnimationFrame', {
    configurable: true,
    writable: true,
    value: caf,
  })

  /* There is no layout to scroll. Saying so is quieter than being told. */
  Object.defineProperty(win, 'scrollTo', { configurable: true, writable: true, value: () => {} })
  Object.defineProperty(win, 'scroll', { configurable: true, writable: true, value: () => {} })

  /*
   * Written with `defineProperty` rather than assignment, and restored from
   * the saved descriptor. Some of these -- `navigator` is the one that bites --
   * are accessor properties on Node's global object, and assigning to a
   * getter-only property throws. Saving the descriptor also distinguishes "this
   * global did not exist" from "this global was `undefined`", which is the
   * difference between leaving the process as it was found and leaving a
   * plausible-looking hole in it.
   */
  const host = globalThis as unknown as Record<string, unknown>
  const saved = new Map<string, Slot>()
  const publish = (key: string, value: unknown) => {
    if (!saved.has(key)) {
      saved.set(key, { descriptor: Object.getOwnPropertyDescriptor(host, key) })
    }
    Object.defineProperty(host, key, {
      configurable: true,
      writable: true,
      enumerable: true,
      value,
    })
  }

  for (const key of PUBLISHED) {
    publish(
      key,
      key === 'IS_REACT_ACT_ENVIRONMENT' ? true : (win as unknown as Record<string, unknown>)[key],
    )
  }
  publish('matchMedia', win.matchMedia)

  return {
    window: dom.window,
    restore: () => {
      // `forEach` rather than `for…of`: the repository's TypeScript target is
      // the default, which does not allow iterating a Map directly.
      saved.forEach((slot, key) => {
        if (slot.descriptor) Object.defineProperty(host, key, slot.descriptor)
        else delete host[key]
      })
      saved.clear()
      frames.forEach((timer) => clearTimeout(timer))
      frames.clear()
      dom.window.close()
    },
  }
}
