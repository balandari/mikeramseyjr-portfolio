'use client'

import { useCallback, useLayoutEffect, useRef, useState } from 'react'

import {
  alnumBefore,
  caretAfterGrouping,
  groupAccessCode,
} from '@/lib/access-code-format'

/**
 * The access-code field, grouped as it is typed.
 *
 * A reviewer is handed a code that looks like `ABCD-EFGH-JKLM-NPQR`, and on a
 * phone they type it into a box that showed it back as one unbroken run of
 * nineteen characters with the dashes they typed silently accepted but never
 * shown. It is hard to check a code against a message that way, and harder to
 * find the place you went wrong. So the field now groups what it is given:
 * four characters, a dash, four characters, for as long as the code runs.
 *
 * What it accepts, deliberately widely: the code as printed, the code with no
 * dashes at all, lower case, spaces, a paste from a message, a paste on top of
 * a selection. Everything that is not a letter or a digit is discarded and the
 * grouping is re-derived from scratch, so there is no state to get out of step
 * and no sequence of edits that can leave a stray dash behind.
 *
 * **The security semantics are untouched.** This is presentation. The server
 * still receives whatever this field holds, still runs it through
 * `normalizeAccessCode` -- which upper-cases and strips every non-alphanumeric
 * character before anything is compared -- and still fingerprints the result
 * under the same keyed HMAC. A code typed with dashes, without them, or with
 * the wrong ones verifies identically, exactly as it did before, and this
 * component cannot change what is accepted.
 *
 * It is also a progressive enhancement rather than a requirement. The field is
 * server-rendered with its name, its `required`, and all of its input hints
 * intact, so with JavaScript unavailable it is an ordinary text input in an
 * ordinary form and the sign-in works exactly as it always did.
 */

export default function CodeField({
  id,
  name,
  className,
  describedBy,
  placeholder,
  maxLength,
}: {
  id: string
  name: string
  className: string
  describedBy: string
  placeholder: string
  maxLength: number
}) {
  const ref = useRef<HTMLInputElement | null>(null)
  const [value, setValue] = useState('')
  /** Where to put the caret once React has painted the regrouped value. */
  const caret = useRef<number | null>(null)

  // Before paint, so the caret never flickers to the end of the field first.
  useLayoutEffect(() => {
    const input = ref.current
    if (!input || caret.current === null) return
    const at = caret.current
    caret.current = null
    input.setSelectionRange(at, at)
  }, [value])

  const onChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const raw = event.target.value
    const selection = event.target.selectionStart ?? raw.length

    const formatted = groupAccessCode(raw)
    caret.current = caretAfterGrouping(formatted, alnumBefore(raw, selection))
    setValue(formatted)
  }, [])

  /**
   * Make Backspace and Delete behave as though the dashes were not there.
   *
   * Without this, backspacing onto a dash deletes the dash, the value is
   * regrouped, the dash comes straight back, and the field appears frozen --
   * the reviewer presses the key and nothing happens. Moving the caret across
   * the separator first means the keystroke removes the character they were
   * actually aiming at, and the default behaviour otherwise stays intact
   * (including native undo, and deleting a selection).
   */
  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const start = input.selectionStart
    const end = input.selectionEnd
    // A selection is being replaced or removed wholesale; nothing to adjust.
    if (start === null || end === null || start !== end) return

    if (event.key === 'Backspace' && start > 0 && input.value[start - 1] === '-') {
      input.setSelectionRange(start - 1, start - 1)
      return
    }

    if (event.key === 'Delete' && input.value[start] === '-') {
      input.setSelectionRange(start + 1, start + 1)
    }
  }, [])

  return (
    <input
      ref={ref}
      id={id}
      name={name}
      className={className}
      type="text"
      required
      value={value}
      onChange={onChange}
      onKeyDown={onKeyDown}
      maxLength={maxLength}
      autoComplete="off"
      autoCapitalize="characters"
      autoCorrect="off"
      spellCheck={false}
      enterKeyHint="go"
      /*
       * A code is letters and digits, so a phone should offer a keyboard that
       * has both. `inputMode="text"` rather than `numeric`: the alphabet is
       * Crockford-style and mostly letters.
       */
      inputMode="text"
      placeholder={placeholder}
      aria-describedby={describedBy}
    />
  )
}
