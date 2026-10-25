/**
 * Install-prompt state machine (ADR-008 Decision 3, S13 / PROJECT_ANALYSIS §4 S13, §5.5 R1).
 *
 * WHY THIS EXISTS: iOS Safari's ITP rule deletes a website's script-writable storage after 7
 * days without visits — EXCEPT for installed home-screen web apps (§5.5). Installing is the
 * structural fix for R1, so the offer to install must reach the user at a moment where it is
 * useful and never obnoxious.
 *
 * TIMING (the "right moment", acceptance criterion): the offer appears ONLY after the first
 * task of the session is successfully created — the exact seam where E3 asks for
 * `navigator.storage.persist()` (`noteFirstMeaningfulWrite` in the data-safety feature). A
 * brand-new empty profile is never nagged; a returning user sees it at their next task
 * creation. At most one offer per session.
 *
 * CAPTURE TIMING (E6-D1 fix): the `beforeinstallprompt`/`appinstalled` listeners attach at
 * MODULE EVALUATION (top-level side effect below), synchronously — before any async boot work
 * can delay them. Chromium fires `beforeinstallprompt` as soon as manifest+icon validity is
 * known (it does not wait for the service worker since ~Chrome 106): observed at 19–178 ms
 * after navigation while a boot-order attach landed at 24–220 ms, so the event was lost on
 * every load (7/7, docs/qa/e6-install-logs/browser-probes.md). Offer ELIGIBILITY is
 * unchanged: capture early, offer only after the first task.
 *
 * DISMISSAL ("never aggressive"): "No thanks" — or declining the native install dialog — is a
 * PERMANENT dismissal, remembered across sessions in the ADR-002 Decision 7 flags (one writer:
 * `features/data-safety/flags.ts`). There is no snooze, no re-prompt loop, and nothing steals
 * focus.
 *
 * SUPPORT TIERS (§9.4 feature detection, graceful degradation — never dead UI):
 *   - `prompt`: the browser fires `beforeinstallprompt` (Chromium desktop + Android) — the
 *     offer carries an Install button backed by the captured event.
 *   - `manual`: iOS Safari (and any iOS browser) — no `beforeinstallprompt` exists, so the
 *     offer shows the Share-sheet "Add to Home Screen" steps instead of a dead button.
 *   - unsupported: any other browser — the offer never renders, the app is fully functional.
 *
 * ALREADY INSTALLED (post-install launch): `display-mode: standalone|fullscreen` or iOS
 * `navigator.standalone` suppresses everything. `storage.persist()` and backup discipline
 * REMAIN after install (belt and braces) — this module never touches them.
 */

import { signal } from '@preact/signals';

import { markInstallPromptDismissed, wasInstallPromptDismissed } from '../data-safety/flags';

/** Which install affordance this browser actually supports (§9.4). */
export type InstallTier = 'prompt' | 'manual' | 'unsupported';

/** The visible surface; `none` renders nothing. */
export type InstallSurface = 'none' | 'prompt' | 'manual';

/** The captured `beforeinstallprompt` event (not in lib.dom — minimal structural type). */
export interface DeferredInstallPrompt {
  readonly prompt: () => Promise<void>;
  readonly userChoice: Promise<{ readonly outcome: 'accepted' | 'dismissed' }>;
}

/** Visible surface, read by `InstallNotice`. */
export const installSurface = signal<InstallSurface>('none');

let deferred: DeferredInstallPrompt | null = null;
let firstTaskCreated = false;
let settled = false;

function mediaMatches(query: string): boolean {
  try {
    return globalThis.matchMedia(query).matches;
  } catch {
    // Hardened/legacy contexts without a working matchMedia read as "not installed" — the
    // offer may show once, but the app never crashes over a media query (§9.4).
    return false;
  }
}

function isStandalone(): boolean {
  const iosStandalone = (globalThis.navigator as { standalone?: boolean }).standalone === true;
  return (
    iosStandalone ||
    mediaMatches('(display-mode: standalone)') ||
    mediaMatches('(display-mode: fullscreen)')
  );
}

/**
 * iOS detection has no feature-detection equivalent (Apple exposes no install API at all), so
 * this is the one documented UA/platform sniff in the app (ADR-008 Decision 3). iPadOS 13+
 * masquerades as macOS but still reports touch points.
 */
export function isIosPlatform(): boolean {
  const nav = globalThis.navigator as {
    userAgent?: string;
    platform?: string;
    maxTouchPoints?: number;
  };
  const ua = nav.userAgent ?? '';
  const platform = nav.platform ?? '';
  if (/iPhone|iPad|iPod/u.test(ua) || /iPhone|iPad|iPod/u.test(platform)) return true;
  return platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1;
}

/** Which tier this browser gets (exposed for tests and the notice copy). */
export function installTier(): InstallTier {
  if (deferred !== null) return 'prompt';
  return isIosPlatform() ? 'manual' : 'unsupported';
}

function evaluate(): void {
  if (settled) {
    installSurface.value = 'none';
    return;
  }
  if (isStandalone() || wasInstallPromptDismissed()) {
    settled = true;
    installSurface.value = 'none';
    return;
  }
  if (!firstTaskCreated) return;
  const tier = installTier();
  installSurface.value = tier === 'unsupported' ? 'none' : tier;
}

/**
 * The first successful task write of the session (called by the task store next to E3's
 * `noteFirstMeaningfulWrite`). Idempotent: only the first call can raise the surface.
 */
export function noteTaskCreated(): void {
  firstTaskCreated = true;
  evaluate();
}

function onBeforeInstallPrompt(event: Event): void {
  // Chrome auto-shows its own mini-infobar unless the app calls preventDefault() and installs
  // later — we own the timing (ADR-008 Decision 3), so the default is always prevented.
  event.preventDefault();
  deferred = event as unknown as DeferredInstallPrompt;
  evaluate();
}

function onInstalled(): void {
  settled = true;
  deferred = null;
  installSurface.value = 'none';
}

/**
 * Attach the capture listeners. Called at MODULE EVALUATION (the side effect below) so no
 * async boot work can ever delay capture (E6-D1), and again from `bootInstallFlow()` —
 * idempotent, because `addEventListener` ignores an identical registration.
 */
function attachCaptureListeners(): void {
  globalThis.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
  globalThis.addEventListener('appinstalled', onInstalled);
}

// E6-D1: capture starts HERE, at module evaluation — strictly before any await in the entry
// (src/app/main.tsx imports this module statically, so this runs before `start()` even
// begins). The only window this cannot cover is an event delivered before this module
// evaluates at all; closing that would need an inline capture script in index.html — a
// second `beforeinstallprompt` site the shipped-JS guard deliberately forbids.
attachCaptureListeners();

/**
 * Idempotent boot seam: re-attach (a no-op when the module-evaluation listeners are already
 * in place), evaluate the current state, and return a disposer for tests. Silent and inert
 * where unsupported (§9.4): no listeners leak, no UI ever renders, the app is complete
 * without any of it.
 */
export function bootInstallFlow(): () => void {
  attachCaptureListeners();
  evaluate();
  return () => {
    globalThis.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    globalThis.removeEventListener('appinstalled', onInstalled);
  };
}

/**
 * The Install button: hand the captured event to the browser's native install dialog. A
 * declined dialog counts as a dismissal (the user said no — never re-ask), an accepted one
 * closes the surface and waits for `appinstalled` to confirm.
 */
export async function promptInstall(): Promise<void> {
  const event = deferred;
  if (event === null) return;
  installSurface.value = 'none';
  try {
    await event.prompt();
    const choice = await event.userChoice;
    deferred = null;
    if (choice.outcome === 'accepted') {
      settled = true;
    } else {
      dismissInstall();
    }
  } catch (error: unknown) {
    // A rejected prompt() (not allowed, or the event was consumed): never a crash, never a
    // dead button — fall back to the dismissal path so the surface cannot get stuck.
    console.warn('install: prompt() failed', error);
    deferred = null;
    dismissInstall();
  }
}

/** "No thanks" — permanent, remembered across sessions. */
export function dismissInstall(): void {
  settled = true;
  installSurface.value = 'none';
  markInstallPromptDismissed();
}

/** Test seam: forget every captured event and session fact. */
export function resetInstallFlow(): void {
  deferred = null;
  firstTaskCreated = false;
  settled = false;
  installSurface.value = 'none';
}
