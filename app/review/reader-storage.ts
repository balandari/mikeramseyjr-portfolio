/**
 * This browser's own reading state, namespaced per reviewer.
 *
 * Three things are kept here and nothing else: appearance preferences, the last
 * place this reviewer was reading, and their bookmarks. All three are
 * conveniences that belong to a device rather than to an account, which is why
 * they are not sent to the server.
 *
 * What is deliberately NOT kept here: the access code, the session cookie
 * (HttpOnly, so script cannot read it anyway), the reviewer's name or id, and
 * any manuscript text. A bookmark is an identifier, never a passage.
 *
 * Every key is prefixed with the reviewer's opaque server-derived namespace, so
 * two reviewers sharing a browser profile cannot read, resume, or overwrite
 * each other's state, and neither can work out the other's prefix.
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

/** Where a reviewer last was, across the whole library. */
export type Position = {
  bookSlug: string
  bookTitle: string
  chapterSlug: string
  chapterLabel: string
  /** The topmost paragraph in view when they left. */
  paragraphId: string | null
  /** Epoch milliseconds, used only to show "where you left off". */
  at: number
}

/** chapterSlug -> the bookmarked paragraph in that chapter. One per chapter. */
export type Bookmarks = Record<string, string>

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

/* ------------------------------------------------------------ position */

export function readPosition(namespace: string): Position | null {
  const stored = read<Partial<Position>>(key(namespace, 'pos'))
  if (
    !stored ||
    typeof stored.bookSlug !== 'string' ||
    typeof stored.chapterSlug !== 'string'
  ) {
    return null
  }

  return {
    bookSlug: stored.bookSlug,
    bookTitle: typeof stored.bookTitle === 'string' ? stored.bookTitle : '',
    chapterSlug: stored.chapterSlug,
    chapterLabel: typeof stored.chapterLabel === 'string' ? stored.chapterLabel : '',
    paragraphId: typeof stored.paragraphId === 'string' ? stored.paragraphId : null,
    at: typeof stored.at === 'number' ? stored.at : 0,
  }
}

/**
 * Record where the reviewer is.
 *
 * Two things are written, because they answer two different questions. The
 * `pos` key is the single most recent place in the whole library, which is what
 * "Continue reading" on the landing page offers. The per-book map is a place
 * per chapter, so that a reviewer who reads chapter one, skips ahead to look at
 * chapter three, and comes back is returned to where they actually stopped in
 * chapter one rather than to its first line.
 */
export function writePosition(namespace: string, value: Position): void {
  write(key(namespace, 'pos'), value)

  if (value.paragraphId) {
    const marks = readChapterMarks(namespace, value.bookSlug)
    marks[value.chapterSlug] = value.paragraphId
    write(key(namespace, `rp.${value.bookSlug}`), marks)
  }
}

/** chapterSlug -> the paragraph this reviewer last reached in that chapter. */
export type ChapterMarks = Record<string, string>

export function readChapterMarks(namespace: string, bookSlug: string): ChapterMarks {
  const stored = read<ChapterMarks>(key(namespace, `rp.${bookSlug}`))
  if (!stored || typeof stored !== 'object') return {}

  const clean: ChapterMarks = {}
  for (const [chapterSlug, paragraphId] of Object.entries(stored)) {
    if (typeof paragraphId === 'string') clean[chapterSlug] = paragraphId
  }
  return clean
}

/** Where this reviewer stopped in one specific chapter, if anywhere. */
export function readChapterPosition(
  namespace: string,
  bookSlug: string,
  chapterSlug: string,
): string | null {
  return readChapterMarks(namespace, bookSlug)[chapterSlug] ?? null
}

/* ----------------------------------------------------------- bookmarks */

export function readBookmarks(namespace: string, bookSlug: string): Bookmarks {
  const stored = read<Bookmarks>(key(namespace, `bm.${bookSlug}`))
  if (!stored || typeof stored !== 'object') return {}

  const clean: Bookmarks = {}
  for (const [chapterSlug, paragraphId] of Object.entries(stored)) {
    if (typeof paragraphId === 'string') clean[chapterSlug] = paragraphId
  }
  return clean
}

export function writeBookmarks(
  namespace: string,
  bookSlug: string,
  value: Bookmarks,
): void {
  write(key(namespace, `bm.${bookSlug}`), value)
}
