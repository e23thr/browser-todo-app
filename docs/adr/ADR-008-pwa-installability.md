# ADR-008: PWA installability — manifest, install offer & home-screen install

**Status**: Accepted
**Decider**: h_senior_coder (task t_4dfee282, epic E6 / V1 S13)
**Date**: 2026-10-26

**Context**: PROJECT_ANALYSIS §4 S13 makes home-screen install the structural fix for R1 (§5.5:
iOS Safari's ITP rule deletes script-writable storage after 7 days without visits — **installed
home-screen web apps are exempt**). PO Q12 excluded installability from MVP, so ADR-005 was
written with "no web app manifest" as a binding scope note; that note describes the MVP release
only and is historical from V1 onward — this ADR adds installability without changing any ADR-005
behaviour (its `*.webmanifest` precache exclusion stays, Decision 1 below). Constraints that bind
this card: icons self-hosted (zero third-party bytes, §7.2), all strings via `t()` (en+th), the
prompt UI meets WCAG 2.2 AA, `storage.persist()` + backup discipline **remain** after install
(belt and braces), and `start_url`/`scope` must respect the configurable base path exactly like
the ADR-005 Decision 8 service-worker scope (`/<repo>/` on GitHub Pages project pages).

## Decision 1 — Manifest is generated at build time, keyed to the base path

`scripts/webmanifest.mjs` is the single source of truth for the manifest's shape; the
`app:webmanifest` Vite plugin (`vite.config.ts`) emits `manifest.webmanifest` into every build
output — including the E2E fixture builds, which run the same config. Fields:

- `id` = `start_url` = `scope` = the **normalized base** (slash-terminated — the same
  normalization as Vite `base`, so the manifest and the SW scope cannot drift);
- `display: "standalone"`, `name`/`short_name`/`description` from the English catalog (the
  manifest is install-time metadata; per-locale manifests are out of scope);
- icons per Decision 2, all URLs base-prefixed.

The file is **not** precached: it is install-time metadata the browser fetches when installing,
not an app-shell artifact needed for offline boot (ADR-005 Decision 2's `*.webmanifest`
exclusion stays in force with this updated rationale). `index.html` carries
`<link rel="manifest" href="/manifest.webmanifest">`; Vite (and, defensively, the plugin's
`transformIndexHtml` post-pass) rewrites the href to the configured base at build time.

## Decision 2 — Self-hosted, procedurally generated icons

`scripts/generate-icons.mjs` draws the icons (accent tile + white checkmark, matching
`public/favicon.svg`) with pure pixel math and a ~60-line PNG encoder (zlib + CRC-32) — no image
tooling, no new dependencies — and the bytes are committed under `public/icons/`:

| File | Size | Purpose |
|---|---|---|
| `icon-192.png`, `icon-512.png` | 192², 512² | `any` — the Chromium installability floor |
| `maskable-192.png`, `maskable-512.png` | 192², 512² | `maskable` — Android adaptive icons (glyph inside the central 80% safe zone) |
| `apple-touch-icon-180.png` | 180² | iOS Safari home-screen icon (full-bleed, no transparency) |

Determinism is a test invariant (`tests/unit/generate-icons.test.ts` decodes the committed PNGs
and compares their pixels with fresh generator output — not the deflate bytes, which differ
between node's patched zlib 1.3.1-e00f703 in CI and plain zlib 1.3.1 on the dev box), so icons
can never drift silently. Icons ride the existing budget exclusion (`**/icons/**`, §9.2) and the
ADR-005 Decision 2 artifact set (precached like every other app artifact). `npm run icons`
regenerates.

## Decision 3 — The install offer: one seam, three tiers, permanent dismissal

**Timing** (the card's "right moment"): the offer becomes eligible exactly when E3 requests
`navigator.storage.persist()` — the first *successful task write of the session* (the
`noteFirstMeaningfulWrite` seam in `src/features/tasks/store.ts`, now also calling
`noteTaskCreated()`). Never before the first task, at most once per session, and a returning
user sees it at their next task creation.

**Tiers** (§9.4 feature detection — never dead UI):

- `prompt` — the browser fires `beforeinstallprompt` (Chromium desktop + Android): the offer
  carries an **Install** button backed by the captured event (`prompt()` + `userChoice`).
- `manual` — iOS Safari and every other iOS browser (Apple exposes no install API; this is the
  one documented UA/platform sniff in the app): the offer shows the Share-sheet “Add to Home
  Screen” steps instead of a button that could not work.
- unsupported — anything else (e.g. desktop Firefox): no surface is ever mounted.

**Dismissal** ("never aggressive"): "No thanks" — or declining the native install dialog — is a
PERMANENT, cross-session dismissal, stored in the ADR-002 Decision 7 `dismissedBanners` array
(`'install-prompt'`, written only by `src/features/data-safety/flags.ts`, which owns that key's
in-memory mirror). No snooze, no re-prompt loop. Already-installed detection
(`display-mode: standalone|fullscreen`, iOS `navigator.standalone`, and the `appinstalled`
event) suppresses everything.

**UI contract** (WCAG 2.2 AA): one non-modal fixed-position card in its own body-level container
(like the ADR-005 update toast), a single `role="status"` polite live region, real buttons with
≥ 44 px targets, no focus theft, no auto-dismiss. Copy is `t()`-driven (en+th) and presents
install as the durable-storage option; the onboarding copy (first run) does the same while
keeping the backup discipline visible (belt and braces).

## Decision 4 — Test strategy + honest device coverage

- unit: manifest base invariants, icon determinism/safe zone, the prompt state machine
  (timing, tiers, dismissal, post-install suppression);
- component: the notice's live-region/button contract, en+th copy;
- e2e (`tests/e2e/install.spec.ts`, joined into the ADR-005 Decision 9 SW suite): manifest
  `start_url`/`scope` vs. real `navigator.serviceWorker.getRegistration().scope` under BOTH
  `/<repo>/` and `/`, icon resolution, prompt-before/after-first-task, dismissal across reload,
  and `display-mode: standalone` suppression (emulated via the exact media query the app checks);
- Real-device verification (Android Chrome install dialog, iOS Safari A2HS, the ITP 7-day
  exemption) cannot run in CI: `docs/dev/pwa-install.md` carries the manual checklist and an
  explicit statement of what was and was not machine-verified.

## Alternatives Considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Static `public/manifest.webmanifest` | dead simple | `start_url`/`scope`/icons cannot carry the configured base; breaks under `/<repo>/` | rejected — the base-path requirement is binding (§9.5) |
| Post-build script in the `npm run build` chain | no config plugin | the E2E fixture builds would need separate wiring; easy to forget | rejected — the Vite plugin covers every build automatically |
| Serve a rewritten manifest from the Service Worker | runtime base detection (like the cache slug) | changes ADR-005 routing (out of scope by binding decision) and the manifest is fetched *before* SW control exists | rejected |
| Offer install at boot / after onboarding | maximum reach | violates "only after first task creation"; nags empty profiles | rejected |
| Snoozable dismissal (like the 7-day backup nudge) | second chances | "remembered dismissal / never aggressive" is the acceptance criterion | rejected — permanent only |
| Manifest `id` omitted (default = `start_url`) | less JSON | Chromium derives identity implicitly; two bases could collide on some engines | rejected — pin `id` to the scope |

## Consequences

- **Positive**: R1's structural mitigation exists; install works from any base; zero third-party
  bytes; the offer cannot nag (one dismissal forever); the whole surface degrades to "nothing"
  where unsupported.
- **Negative**: the manifest only exists in a *build* (`vite dev` serves no manifest — manual
  install QA runs against `npm run build && npm run preview` or a deploy); the iOS path is
  instructions-only; one UA sniff is unavoidable (Apple exposes no install API); the English
  manifest name is fixed (per-locale manifests out of scope).
- **Risks**: installability criteria differ subtly per Chromium version (covered by the e2e
  manifest assertions + a manual smoke checklist); the iOS ITP exemption is Apple-documented
  behaviour and cannot be proven in CI — `docs/dev/pwa-install.md` states this explicitly.
- **Migration**: none. Existing profiles see the offer at their next successful task creation
  (or never, if dismissed/installed); storage, sync and backup behaviour are untouched.

## Links

- PROJECT_ANALYSIS.md §4 (S13), §5.5 (R1), §9.4/§9.5, §12 (Q12)
- ADR-005 (service worker: Decision 2 precache exclusion, Decision 8 scope handling) — unchanged
- docs/dev/pwa-install.md (flows, device-coverage statement, manual checklist)
- Task t_4dfee282 (impl), t_3d254f0f (test), t_6e9e4f81 (review)
