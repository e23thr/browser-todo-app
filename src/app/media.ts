/**
 * Responsive breakpoint hook (design §3.6).
 *
 * The shell renders exactly ONE navigation chrome at a time — compact (< 1024 px) or wide
 * (>= 1024 px) — so there is a single `nav` landmark, a single "primary" label and no
 * duplicated links in the accessibility tree. `matchMedia` is optional (jsdom and old engines),
 * in which case the shell falls back to the compact pattern.
 */

import { useEffect, useState } from 'preact/hooks';

/** Design §3.6: the compact/wide split (lg breakpoint). */
export const WIDE_QUERY = '(min-width: 1024px)';

function matchMediaSafe(query: string): MediaQueryList | null {
  const matchMediaFn: unknown = globalThis.matchMedia;
  if (typeof matchMediaFn !== 'function') return null;
  try {
    return (matchMediaFn as (q: string) => MediaQueryList)(query);
  } catch {
    return null;
  }
}

/** Synchronous match of a media query; `false` when the API is unavailable. */
export function matchesQuery(query: string): boolean {
  return matchMediaSafe(query)?.matches ?? false;
}

/** Subscribe to a media query for the lifetime of the component. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => matchesQuery(query));

  useEffect(() => {
    const mediaQuery = matchMediaSafe(query);
    if (mediaQuery === null) return;
    const onChange = (): void => {
      setMatches(mediaQuery.matches);
    };
    onChange();
    mediaQuery.addEventListener('change', onChange);
    return () => {
      mediaQuery.removeEventListener('change', onChange);
    };
  }, [query]);

  return matches;
}
