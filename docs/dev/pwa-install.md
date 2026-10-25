# PWA installability (V1 S13) — flows, verification & device coverage

Implementation: ADR-008 (all four decisions). Code: `scripts/webmanifest.mjs`,
`scripts/generate-icons.mjs`, `src/features/install/`, `tests/e2e/install.spec.ts`.
This document is the honest account of what the install experience does and what has — and has
**not** — been verified on real hardware.

## 1. What ships

- `manifest.webmanifest`, **generated at build time** with the configured base path baked into
  `id`/`start_url`/`scope` (ADR-008 Decision 1). Emitted by the `app:webmanifest` Vite plugin in
  every build, including the E2E fixture builds.
- Self-hosted icons under `public/icons/` (ADR-008 Decision 2): `any` 192/512, `maskable`
  192/512 (glyph inside the central 80% safe zone) and `apple-touch-icon-180.png`. Generated
  procedurally, committed, byte-deterministic (`npm run icons` to regenerate,
  `npm run icons:check` to verify the committed bytes).
- `index.html`: `rel=manifest` + `rel=apple-touch-icon` links and the `apple-mobile-web-app-*`
  meta tags iOS Safari needs for its Add-to-Home-Screen flow.
- The install offer (ADR-008 Decision 3): `src/features/install/installPrompt.ts` (state
  machine) + `InstallNotice.tsx` (one non-modal card).

## 2. Base-path correctness

`start_url`/`scope`/`id` are the normalized `BASE_PATH` (slash-terminated), which is exactly the
ADR-005 Decision 8 service-worker scope (`${BASE_URL}sw.js`, scope `${BASE_URL}`). The e2e suite
proves the agreement against the live `navigator.serviceWorker.getRegistration().scope` under
both `/browser-todo-app/` (GitHub Pages project pages) and `/`:

    npm run build                    # BASE_PATH=/ by default -> dist/manifest.webmanifest
    BASE_PATH=/browser-todo-app/ npm run build
    node scripts/webmanifest.mjs --base /browser-todo-app/ --check dist

A mismatch of manifest scope and SW scope is a bug: the installed app must launch `start_url`
inside the SW's scope so the home-screen entry boots through the app-shell cache.

## 3. Install flows per platform

| Platform | Mechanism | What the user sees |
|---|---|---|
| Android Chrome (≥110), desktop Chrome/Edge | `beforeinstallprompt` (captured, never auto-triggered) | After their **first task of the session**: "Keep your tasks — install Todo" with **Install** / **No thanks** |
| iOS Safari (≥16.4), any iOS browser | No install API exists — Share-sheet flow | After the first task: "Add Todo to your Home Screen" with the two steps (Share button → "Add to Home Screen") and **Got it** |
| Anything else (e.g. desktop Firefox) | none | Nothing — the app is complete without install (§9.4 graceful degradation; no dead UI) |
| Already installed (home-screen launch) | `display-mode: standalone\|fullscreen`, iOS `navigator.standalone`, `appinstalled` | Nothing, ever |

Discipline (acceptance criteria): the offer never appears before the first task of the session;
"No thanks" — or declining the native install dialog — is a permanent, cross-session dismissal
(`install-prompt` in the ADR-002 Decision 7 `dismissedBanners` key); there is no snooze and no
re-prompt loop; the card is non-modal, announced in one polite live region and never steals
focus (WCAG 2.2 AA).

## 4. Post-install behaviour

The home-screen entry launches `start_url` in `display: standalone` within the manifest scope —
the same app-shell cache and the same IndexedDB origin as the browser tab. The service worker is
unchanged (ADR-005), `storage.persist()` and the backup discipline **remain** after install
(belt and braces — PROJECT_ANALYSIS §5.5).

## 5. The iOS ITP exemption (why this card exists)

PROJECT_ANALYSIS §5.5 / R1: iOS Safari's Intelligent Tracking Prevention deletes a website's
script-writable storage (localStorage, IndexedDB, Cache API) after **7 days without user
interaction** — but **installed home-screen web apps are exempt** from this rule (Apple's
documented behaviour; "web apps saved to the home screen" are treated as first-party apps).

Expectation, stated honestly: this exemption is Apple platform behaviour, not something this
codebase can force or prove. It **cannot be verified in CI** (it needs a real iPhone/iPad, a real
7-day absence, and observation of storage survival). What we ship is the mechanism Apple
describes (a properly installed home-screen web app: manifest + apple-touch meta + standalone
display) and the guidance to install. The pre-install mitigations (persist(), backup nudges,
eviction detection, recovery screen) are deliberately UNCHANGED.

## 6. Device coverage — what was verified, what was not

Verified mechanically (CI + local Chromium 156 via Playwright, `tests/e2e/install.spec.ts`):

- manifest validity and base-path `start_url`/`scope`/`id` agreement with the real SW scope
  (both bases), icon resolution under the base;
- offer timing (nothing before the first task, offered after), permanent dismissal surviving a
  reload, Install button wiring (captured `prompt()` invoked exactly once);
- post-install launch semantics under emulated `display-mode: standalone`: shell boots, offer
  never appears;
- unit/component suites: prompt state machine (tiers, dismissal persistence, hostile
  `beforeinstallprompt` after install), manifest builder, icon determinism + maskable safe
  zone, en+th copy of the notice.

NOT verified on real hardware at implementation time (no Android/iOS device attached to CI or
this environment):

- the real Android Chrome install dialog and home-screen launch;
- the real iOS Safari Share → "Add to Home Screen" flow and its home-screen launch;
- the iOS 7-day ITP exemption itself (needs a device + 7-day absence — see §5).

Manual checklist for whoever has the devices (the E6 test card t_3d254f0f owns the report):

1. Android Chrome: open the deployed URL, create a task, tap **Install** → accept → launch from
   the home screen → app opens standalone (no browser chrome), works offline.
2. Android Chrome: create a task, tap **No thanks** → reload → no offer (ever).
3. iOS Safari: open the deployed URL, create a task, follow the two steps → home-screen icon
   shows `apple-touch-icon-180.png` → launch opens standalone (no Safari UI), works offline.
4. Both: `start_url` under the project base (deployed under `/<repo>/`) launches correctly from
   the home screen — never a 404 or a root-domain leak.
5. Long-run (post-hoc, ≥7 days on iOS): data of an *installed* app survives; document the
   observation in docs/qa/.

## 7. Developer notes

- The manifest is **build-only**: `vite dev` serves no `manifest.webmanifest` (install QA runs
  against `npm run build && npm run preview` or a deploy).
- Icons are committed artifacts; `npm run icons` regenerates them (deterministic bytes —
  a regeneration that changes bytes is a deliberate design change and must update the ADR).
- The manifest is intentionally **not** in the SW precache (ADR-005 Decision 2 exclusion kept):
  it is install-time metadata, not part of offline boot.
- Strings: `install.*` in `src/i18n/en.json`/`th.json` (i18n parity is CI-enforced). The
  manifest's `name`/`description` are English-only (per-locale manifests are out of scope).
