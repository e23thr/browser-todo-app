/**
 * Icon sprite (design §6.16) — inline SVG, 24×24 grid, 1.75 px stroke, round caps.
 *
 * Zero remote icons (§7.2): the sprite is bundled in the shell and referenced with the
 * in-document `#i-*` fragment. Icons are decorative (`aria-hidden`) — every icon-only control
 * carries its own accessible name (§6.2).
 */

import type { JSX } from 'preact';

/** The MVP icon set listed in design §6.16. */
export type IconName =
  | 'menu'
  | 'search'
  | 'plus'
  | 'check'
  | 'check-circle'
  | 'alert-circle'
  | 'alert-triangle'
  | 'info'
  | 'calendar'
  | 'flag'
  | 'flag-high'
  | 'flag-medium'
  | 'notes'
  | 'file-text'
  | 'more-vertical'
  | 'x'
  | 'trash'
  | 'edit'
  | 'chevron-right'
  | 'chevron-down'
  | 'folder'
  | 'sun'
  | 'moon'
  | 'monitor'
  | 'download'
  | 'upload'
  | 'database'
  | 'grip';

/** Path/shape data per icon, all drawn on the 24×24 grid. */
const PATHS: Readonly<Record<IconName, JSX.Element>> = {
  menu: (
    <>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="m5 13 4 4 10-10" />,
  'check-circle': (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12.5 2.5 2.5L16 9.5" />
    </>
  ),
  'alert-circle': (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5" />
      <path d="M12 16.5h.01" />
    </>
  ),
  'alert-triangle': (
    <>
      <path d="M12 4.5 3.5 19h17L12 4.5Z" />
      <path d="M12 10v4" />
      <path d="M12 17h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5" />
      <path d="M12 7.5h.01" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" />
    </>
  ),
  flag: (
    <>
      <path d="M6 21V4.5" />
      <path d="M6 5h11l-2.5 4L17 13H6" />
    </>
  ),
  // Priority icons differ BY SHAPE (design D4, §12): high = filled pennant,
  // medium = half-filled pennant, low = no icon. Fills override the sprite's
  // `fill="none"` group attribute.
  'flag-high': (
    <>
      <path d="M6 21V4.5" />
      <path d="M6 5h11l-2.5 4L17 13H6Z" fill="currentColor" stroke="none" />
      <path d="M6 5h11l-2.5 4L17 13H6" />
    </>
  ),
  'flag-medium': (
    <>
      <path d="M6 21V4.5" />
      <path d="M6 5h5.6L6 13Z" fill="currentColor" stroke="none" />
      <path d="M6 5h11l-2.5 4L17 13H6" />
    </>
  ),
  notes: (
    <>
      <rect x="4.5" y="4.5" width="15" height="15" rx="2" />
      <path d="M8 9.5h8M8 13h8M8 16.5h5" />
    </>
  ),
  'file-text': (
    <>
      <path d="M14 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V7.5L14 3.5Z" />
      <path d="M13.5 4v4H18M9 13h6M9 16.5h6" />
    </>
  ),
  'more-vertical': (
    <>
      <circle cx="12" cy="5.5" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="12" cy="18.5" r="1.4" />
    </>
  ),
  x: <path d="m6 6 12 12M18 6 6 18" />,
  trash: (
    <>
      <path d="M4.5 6.5h15M9.5 6.5V4.8A1.3 1.3 0 0 1 10.8 3.5h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7" />
      <path d="M6.5 6.5 7.4 19a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-12.5" />
      <path d="M10.5 10v6.5M13.5 10v6.5" />
    </>
  ),
  edit: (
    <>
      <path d="M4.5 19.5h4l10-10a2.1 2.1 0 0 0-3-3l-10 10v3Z" />
      <path d="m14.5 6.5 3 3" />
    </>
  ),
  'chevron-right': <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />,
  'chevron-down': <path d="m5.5 9.5 6.5 6.5 6.5-6.5" />,
  folder: (
    <path d="M3.5 6.8A1.3 1.3 0 0 1 4.8 5.5h4.3l2 2.4h8.1a1.3 1.3 0 0 1 1.3 1.3v8.5a1.3 1.3 0 0 1-1.3 1.3H4.8a1.3 1.3 0 0 1-1.3-1.3V6.8Z" />
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6" />
    </>
  ),
  moon: <path d="M20 14.4A8.5 8.5 0 0 1 9.6 4 8.5 8.5 0 1 0 20 14.4Z" />,
  monitor: (
    <>
      <rect x="3.5" y="4.5" width="17" height="12" rx="1.5" />
      <path d="M9 20.5h6M12 16.5v4" />
    </>
  ),
  download: (
    <>
      <path d="M12 3.5v11M7.5 10.5 12 15l4.5-4.5" />
      <path d="M4.5 17.5v1.8a1.2 1.2 0 0 0 1.2 1.2h12.6a1.2 1.2 0 0 0 1.2-1.2v-1.8" />
    </>
  ),
  upload: (
    <>
      <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" />
      <path d="M4.5 17.5v1.8a1.2 1.2 0 0 0 1.2 1.2h12.6a1.2 1.2 0 0 0 1.2-1.2v-1.8" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="6" rx="7.5" ry="3" />
      <path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6" />
      <path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" />
    </>
  ),
  // Grip (reorder handle §8.1): two columns of three round-cap dots on the 24 grid.
  grip: <path d="M9 7h.01M15 7h.01M9 12h.01M15 12h.01M9 17h.01M15 17h.01" />,
};

/**
 * Mount the sprite once, inside the shell. Symbols are `aria-hidden` and non-focusable.
 */
export function IconSprite(): JSX.Element {
  return (
    <svg class="icon-sprite" aria-hidden="true" width="0" height="0">
      <defs>
        {(Object.keys(PATHS) as IconName[]).map((name) => (
          <symbol id={`i-${name}`} viewBox="0 0 24 24" key={name}>
            <g
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {PATHS[name]}
            </g>
          </symbol>
        ))}
      </defs>
    </svg>
  );
}

export interface IconProps {
  readonly name: IconName;
  readonly size?: number;
  readonly class?: string;
}

/** A decorative icon: `aria-hidden`, `currentColor`, sized in CSS px. */
export function Icon({ name, size = 20, class: className }: IconProps): JSX.Element {
  return (
    <svg
      class={['icon', className].filter(Boolean).join(' ')}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <use href={`#i-${name}`} />
    </svg>
  );
}
