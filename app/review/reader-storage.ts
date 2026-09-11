/**
 * This browser's own reading state, namespaced per reader.
 *
 * One thing is kept here now, and it is the only thing that belongs here:
 * **appearance**. Theme and text size are a property of the screen somebody is
 * reading on -- a phone in bed at night and a laptop at a desk want different
 * answers, and neither should overrule the other.
 *
 * What used to be kept here and no longer is: the reading position and the
 * bookmark. Both moved to the server, because both are a property of the
 * *person*. A reviewer who reads three chapters on their phone and then opens
 * the book on a laptop must find their place and their bookmarks there, and a
 * bookmark must be provably the work of the reviewer whose cookie signed the
 * request rather than of whoever happened to be using that browser. Keeping
 * them in `localStorage` made them a fact about a device, which is exactly what
 * they are not. See `lib/reviewer-reading.ts`.
 *
 * What is deliberately NOT kept here, and never was: the access code, the
 * session cookie (HttpOnly, so script cannot read it anyway), the reader's name
 * or id, and any manuscript text.
 *
 * Every key is prefixed with the reader's opaque server-derived namespace, so
 * two people sharing a browser profile cannot read or overwrite each other's
 * preferences, and neither can work out the other's prefix.
 *
 * Every read and write is wrapped: private browsing, disabled storage, a full
 * quota or a corrupt value must never stop someone reading.
 */

export type Theme = 'system' | 'light' | 'sepia' | 'dark'

export const SIZE_STEPS = 5
export const DEFAULT_SIZE = 1
export const DEFAULT_THEME: Theme = 'system'

export type Preferences = {
  theme: Theme
  size: number
}

function key(namespace: string, suffix: string): string {
  return `rv.${namespace}.${suffix}`
}

function read<T>(storageKey: string): T | null {
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return null
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function write(storageKey: string, value: unknown): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(value))
  } catch {
    // Storage being unavailable must never break reading.
  }
}

/* --------------------------------------------------------- preferences */

export function readPreferences(namespace: string): Preferences {
  const stored = read<Partial<Preferences>>(key(namespace, 'prefs'))

  const theme: Theme =
    stored?.theme === 'dark' || stored?.theme === 'light' || stored?.theme === 'sepia'
      ? stored.theme
      : DEFAULT_THEME

  const size =
    typeof stored?.size === 'number' && stored.size >= 0 && stored.size < SIZE_STEPS
      ? Math.floor(stored.size)
      : DEFAULT_SIZE

  return { theme, size }
}

export function writePreferences(namespace: string, value: Preferences): void {
  write(key(namespace, 'prefs'), value)
}

/** Reflect the chosen appearance onto the document. */
export function applyAppearance(preferences: Preferences): void {
  const root = document.documentElement
  if (preferences.theme === 'system') root.removeAttribute('data-rv-theme')
  else root.setAttribute('data-rv-theme', preferences.theme)
  root.setAttribute('data-rv-size', String(preferences.size))
}
