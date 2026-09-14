import type { ReactNode } from 'react'

import AuthorMark from '@/components/site/AuthorMark'

/**
 * The quiet side entrance, as a shape four pages now share.
 *
 * `/review/login` was the only page dressed like this; reviewer onboarding adds
 * the request form, the activation page and the two sign-in pages, and every
 * one of them is met by somebody who has no session and may have no idea what
 * this site is. They should all look like the same door.
 *
 * The gate itself keeps its own copy of this markup rather than being rewritten
 * to use this component: it is the accepted, measured page, and this work has
 * no business changing its DOM. What is shared is the stylesheet.
 *
 * Nothing rendered here depends on who is looking, and nothing here names a
 * book, a title, a reviewer, or how a code or a credential is shaped.
 */

/**
 * Marks the document as the gate before first paint, so the gate stylesheet can
 * repaint `body` in the public site's ground rather than the reader's theme.
 * Identical to the gate's own bootstrap, deliberately.
 */
const GATE_BOOTSTRAP = `(function(){try{
document.documentElement.setAttribute('data-rv-gate','');
}catch(e){}})();`

export default function GateShell({
  eyebrow,
  heading,
  children,
}: {
  eyebrow: string
  heading: string
  children: ReactNode
}) {
  return (
    <div className="rv-root rv-root--gate">
      <script dangerouslySetInnerHTML={{ __html: GATE_BOOTSTRAP }} />

      <div className="rv-gate">
        <div className="rv-gate-top">
          <a href="/" className="rv-gate-wordmark">
            <AuthorMark size={28} className="rv-gate-mark" />
            Mike Ramsey Jr
          </a>
        </div>

        <div className="rv-gate-panel">
          <p className="rv-gate-eyebrow">{eyebrow}</p>
          <h1>{heading}</h1>
          <hr className="rv-gate-rule" />
          {children}
        </div>

        <div className="rv-gate-foot">
          <a href="/" className="rv-gate-back">
            <span aria-hidden="true">&larr;</span>
            Back to mikeramseyjr.com
          </a>
        </div>
      </div>
    </div>
  )
}
