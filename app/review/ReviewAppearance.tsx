/**
 * Applies this reviewer's saved appearance before the first paint.
 *
 * Every authorized page renders this immediately inside `.rv-root`, ahead of
 * its content, so the inline script runs while the browser is still parsing and
 * the page paints once, in the theme and at the type size the reviewer chose.
 * Without it, a reviewer who reads in dark would get a frame of paper white on
 * every navigation, and a restored reading position would be measured against a
 * layout about to change height.
 *
 * The namespace is this reviewer's own opaque storage prefix, resolved on the
 * server from their signed cookie. Two reviewers sharing one browser profile
 * therefore never read each other's preferences, position, or bookmarks: the
 * keys they address do not overlap, and neither can derive the other's.
 */
export default function ReviewAppearance({ namespace }: { namespace: string }) {
  // The namespace is base64url from an HMAC, so it contains no quote, no
  // backslash and no angle bracket. It is still encoded rather than
  // interpolated raw, because a value that reaches a script tag should never
  // depend on an invariant proved somewhere else in the codebase.
  const script = `(function(){try{
var r=document.documentElement;
var ns=${JSON.stringify(namespace)};
r.setAttribute('data-rv-ns',ns);
var s=window.localStorage.getItem('rv.'+ns+'.prefs');
if(!s){return;}
var v=JSON.parse(s);
if(v&&(v.theme==='dark'||v.theme==='light'||v.theme==='sepia')){r.setAttribute('data-rv-theme',v.theme);}
else{r.removeAttribute('data-rv-theme');}
if(v&&typeof v.size==='number'&&v.size>=0&&v.size<=4){r.setAttribute('data-rv-size',String(v.size));}
}catch(e){}})();`

  return <script dangerouslySetInnerHTML={{ __html: script }} />
}
