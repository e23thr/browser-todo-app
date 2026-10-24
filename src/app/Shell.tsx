/**
 * App shell (design §4.1) — responsive chrome, landmarks, drawer, live regions.
 *
 * Structure (both patterns): one `header`, one `nav`, one `main`, a skip link as the first
 * focusable element, and the two persistent live regions of §11.2. Exactly one chrome is
 * rendered at a time (`useMediaQuery` on the §3.6 1024 px split) so there is never a second
 * nav landmark or a duplicated link in the accessibility tree.
 *
 * Compact (< 1024 px): app bar + bottom tab bar (5 tabs) + drawer + FAB, safe-area aware.
 * Wide (>= 1024 px): persistent sidebar (header + nav) + main column.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren, JSX, TargetedEvent } from 'preact';

import { registerLiveRegions } from './announce';
import { Icon, IconSprite, type IconName } from './icons';
import { t } from './i18n';
import { useDropHoverListId, useListOptions } from './lists';
import { useMediaQuery, WIDE_QUERY } from './media';
import { startQuickAdd } from './quickAdd';

interface NavItem {
  readonly pattern: string;
  readonly aliases: readonly string[];
  readonly href: string;
  readonly labelKey: string;
  readonly icon: IconName;
}

/** Primary destinations (design §2). `/` and `/next7` are aliases of their canonical routes. */
const PRIMARY_NAV: readonly NavItem[] = [
  { pattern: '/today', aliases: ['/'], href: '#/today', labelKey: 'nav.today', icon: 'sun' },
  {
    pattern: '/week',
    aliases: ['/next7'],
    href: '#/week',
    labelKey: 'nav.next7days',
    icon: 'calendar',
  },
  { pattern: '/all', aliases: [], href: '#/all', labelKey: 'nav.allOpen', icon: 'file-text' },
  {
    pattern: '/completed',
    aliases: [],
    href: '#/completed',
    labelKey: 'nav.completed',
    icon: 'check-circle',
  },
];

function isCurrent(pattern: string | null, item: NavItem): boolean {
  if (pattern === null) return false;
  return pattern === item.pattern || item.aliases.includes(pattern);
}

function currentAttr(condition: boolean): 'page' | undefined {
  return condition ? 'page' : undefined;
}

/** Links to the lists the shell knows about, or the documented empty state. */
function ListLinks({ onNavigate }: { readonly onNavigate: () => void }): JSX.Element {
  const lists = useListOptions();
  const dropHover = useDropHoverListId();

  if (lists.length === 0) {
    return <li class="nav-empty">{t('list.empty.title')}</li>;
  }

  return (
    <>
      {lists.map((list) => (
        <li key={list.id}>
          <a
            href={`#/list/${encodeURIComponent(list.id)}`}
            onClick={onNavigate}
            // §8.1 desktop extra: during a task drag every sidebar list is a
            // move-to-list drop target (the drag layer hit-tests this attribute).
            data-drop-list-id={list.id}
            data-drop-hover={dropHover === list.id ? 'true' : undefined}
          >
            <Icon name="folder" size={18} />
            <span class="nav-label">{list.name}</span>
          </a>
        </li>
      ))}
    </>
  );
}

export interface ShellProps {
  readonly pattern: string | null;
  readonly children: ComponentChildren;
}

export function Shell({ pattern, children }: ShellProps): JSX.Element {
  const wide = useMediaQuery(WIDE_QUERY);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const politeRef = useRef<HTMLDivElement | null>(null);
  const assertiveRef = useRef<HTMLDivElement | null>(null);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // One polite + one assertive region for the lifetime of the shell (§11.2).
  useEffect(
    () =>
      registerLiveRegions({
        polite: politeRef.current,
        assertive: assertiveRef.current,
      }),
    [],
  );

  // The drawer only exists in the compact pattern.
  useEffect(() => {
    if (wide && drawerOpen) setDrawerOpen(false);
  }, [wide, drawerOpen]);

  // Focus moves into the dialog when it opens (§6.9).
  useEffect(() => {
    if (drawerOpen) drawerRef.current?.focus();
  }, [drawerOpen]);

  const openDrawer = (event: TargetedEvent<HTMLElement>): void => {
    openerRef.current = event.currentTarget;
    setDrawerOpen(true);
  };

  const closeDrawer = (returnFocus = true): void => {
    setDrawerOpen(false);
    if (returnFocus) openerRef.current?.focus();
  };

  // Esc closes and returns focus to the opener; Tab cycles inside the drawer only (§6.9).
  // Listened on the document while the drawer is open: it is a `dialog`, and its background
  // is hidden from assistive tech for as long as it is modal.
  useEffect(() => {
    if (!drawerOpen) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeDrawer();
        return;
      }
      if (event.key !== 'Tab') return;

      const root = drawerRef.current;
      if (root === null) return;
      const focusable = [
        ...root.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, select'),
      ];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;

      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === root)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [drawerOpen]);

  const onFabClick = (): void => {
    startQuickAdd();
  };

  const navItem = (item: NavItem): JSX.Element => (
    <li key={item.pattern}>
      <a href={item.href} aria-current={currentAttr(isCurrent(pattern, item))}>
        <Icon name={item.icon} size={18} />
        <span class="nav-label">{t(item.labelKey)}</span>
      </a>
    </li>
  );

  return (
    <div class="shell">
      <IconSprite />
      <div class="shell-body" aria-hidden={drawerOpen ? 'true' : undefined}>
        <a class="skip-link" href="#main">
          {t('a11y.skipToContent')}
        </a>

        {wide ? (
          <header class="sidebar">
            <p class="wordmark">{t('app.name')}</p>
            <nav aria-label={t('a11y.navLabel')}>
              <ul class="nav-list">
                <li>
                  <a href="#/search" aria-current={currentAttr(pattern === '/search')}>
                    <Icon name="search" size={18} />
                    <span class="nav-label">{t('nav.search')}</span>
                  </a>
                </li>
                {PRIMARY_NAV.map(navItem)}
              </ul>
              <h2 class="nav-heading">{t('nav.lists')}</h2>
              <ul class="nav-list">
                <ListLinks onNavigate={() => undefined} />
              </ul>
              <ul class="nav-list">
                <li>
                  <a href="#/lists" aria-current={currentAttr(pattern === '/lists')}>
                    <Icon name="folder" size={18} />
                    <span class="nav-label">{t('list.manage')}</span>
                  </a>
                </li>
              </ul>
              <ul class="nav-list">
                <li>
                  <a href="#/settings" aria-current={currentAttr(pattern === '/settings')}>
                    <span class="nav-label">{t('nav.settings')}</span>
                  </a>
                </li>
              </ul>
            </nav>
          </header>
        ) : (
          <header class="appbar">
            <button
              type="button"
              class="icon-button"
              aria-label={t('a11y.openMenu')}
              aria-haspopup="dialog"
              aria-expanded={drawerOpen}
              onClick={openDrawer}
            >
              <Icon name="menu" size={24} />
            </button>
            <a class="icon-button appbar-search" href="#/search" aria-label={t('search.label')}>
              <Icon name="search" size={22} />
            </a>
          </header>
        )}

        <main id="main" class="app-main" tabindex={-1}>
          {children}
        </main>

        {!wide ? (
          <>
            <nav class="tabbar" aria-label={t('a11y.navLabel')}>
              <ul>
                {PRIMARY_NAV.map((item) => (
                  <li key={item.pattern}>
                    <a
                      href={item.href}
                      class="tab"
                      aria-current={currentAttr(isCurrent(pattern, item))}
                    >
                      <Icon name={item.icon} size={22} />
                      <span class="tab-label">{t(item.labelKey)}</span>
                    </a>
                  </li>
                ))}
                <li>
                  <button
                    type="button"
                    class="tab"
                    aria-haspopup="dialog"
                    aria-expanded={drawerOpen}
                    onClick={openDrawer}
                  >
                    <Icon name="more-vertical" size={22} />
                    <span class="tab-label">{t('nav.more')}</span>
                  </button>
                </li>
              </ul>
            </nav>
            <button
              type="button"
              class="fab"
              aria-label={t('task.action.add')}
              onClick={onFabClick}
            >
              <Icon name="plus" size={26} />
            </button>
          </>
        ) : null}
      </div>

      {drawerOpen ? (
        <div class="drawer-layer">
          <button
            type="button"
            class="drawer-scrim"
            tabIndex={-1}
            aria-label={t('a11y.closeMenu')}
            onClick={() => {
              closeDrawer();
            }}
          />
          <div
            class="drawer"
            role="dialog"
            aria-modal="true"
            aria-label={t('nav.menu')}
            tabIndex={-1}
            ref={drawerRef}
          >
            <div class="drawer-head">
              <p class="wordmark">{t('app.name')}</p>
              <button
                type="button"
                class="icon-button"
                aria-label={t('a11y.closeMenu')}
                onClick={() => {
                  closeDrawer();
                }}
              >
                <Icon name="x" size={22} />
              </button>
            </div>
            <nav aria-label={t('a11y.navLabel')}>
              <ul class="nav-list">
                <li>
                  <a href="#/search" aria-current={currentAttr(pattern === '/search')}>
                    <Icon name="search" size={18} />
                    <span class="nav-label">{t('nav.search')}</span>
                  </a>
                </li>
              </ul>
              <h2 class="nav-heading">{t('nav.lists')}</h2>
              <ul class="nav-list">
                <ListLinks
                  onNavigate={() => {
                    closeDrawer(false);
                  }}
                />
              </ul>
              <ul class="nav-list">
                <li>
                  <a
                    href="#/lists"
                    aria-current={currentAttr(pattern === '/lists')}
                    onClick={() => {
                      closeDrawer(false);
                    }}
                  >
                    <Icon name="folder" size={18} />
                    <span class="nav-label">{t('list.manage')}</span>
                  </a>
                </li>
              </ul>
              <ul class="nav-list">
                <li>
                  <a
                    href="#/settings"
                    aria-current={currentAttr(pattern === '/settings')}
                    onClick={() => {
                      closeDrawer(false);
                    }}
                  >
                    <span class="nav-label">{t('nav.settings')}</span>
                  </a>
                </li>
              </ul>
            </nav>
          </div>
        </div>
      ) : null}

      <div class="live-regions">
        <div ref={politeRef} class="visually-hidden" role="status" aria-live="polite" />
        <div ref={assertiveRef} class="visually-hidden" role="alert" aria-live="assertive" />
      </div>
    </div>
  );
}
