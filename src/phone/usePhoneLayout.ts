/**
 * The one place that decides whether this is a phone.
 *
 * Below {@link PHONE_BREAKPOINT} the app renders the stacked read-only phone
 * layout; at or above it, the desktop three-column stage renders exactly as it
 * always has. The two are separate trees rather than one tree restyled, which is
 * what makes "desktop is untouched" checkable: no phone component, class or
 * store flag exists above the breakpoint.
 *
 * The query is `max-width: 899.98px` rather than `899px`: a viewport can land on
 * a fractional CSS pixel (browser zoom, a scaled device), and a plain `899px`
 * would leave 899.5px matching neither layout.
 */
import { useEffect, useState } from 'react';

/** Phone layout applies strictly below this width, in CSS pixels. */
export const PHONE_BREAKPOINT = 900;

/** The media query the layout switch is driven from. Exported so the stylesheet
 *  and the tests can be held to the same number as the component tree. */
export const PHONE_MEDIA_QUERY = `(max-width: ${PHONE_BREAKPOINT - 0.02}px)`;

/**
 * Is the viewport narrower than the breakpoint right now?
 *
 * Re-read on change, so rotating the phone or dragging a desktop window across
 * 900px swaps the layout without a reload. Environments with no `matchMedia`
 * (tests, SSR) get `false` — the desktop layout, which is the one that does not
 * depend on a viewport measurement.
 */
export function useIsPhone(): boolean {
  const [isPhone, setIsPhone] = useState(
    () => typeof matchMedia === 'function' && matchMedia(PHONE_MEDIA_QUERY).matches,
  );

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(PHONE_MEDIA_QUERY);
    const onChange = () => setIsPhone(mq.matches);
    // Re-read on mount too: the query can have changed between the initial
    // state being computed and this effect running.
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return isPhone;
}
