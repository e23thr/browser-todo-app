# Epic E6 (V1) — PWA installability (S13): install flows & base-path scope QA

**Card:** t_3d254f0f · **Run:** h_reviewer · **Date:** 2026-10-26 · **Verified:** clean clone of
`c4cb303` (shared workspace has sibling V1 WIP — never tested in-tree) + live browser probes
against a `BASE_PATH=/browser-todo-app/` production build.

**Verdict:** **PASS on 8 of 9 scenarios; 1 HIGH defect (E6-D1)** — the Chromium `prompt`-tier
offer is never delivered natively because the app loses the `beforeinstallprompt` event to a
boot-order race. Fix card **`t_d7fed00c`** (gated on this card) must land — and this scenario
re-verified — before S13's "install prompt at the right moment (after the first task)" can be
claimed on Android/desktop Chrome. iOS `manual` tier, dismissal, standalone/offline behaviour,
scope correctness and graceful degradation all verified green.

Method: every scenario re-verified **first-hand** (automated gates + independent static probes +
real-browser behavioural probes), not re-read from the upstream handoff (t_4dfee282). Probe
transcript: `docs/qa/e6-install-logs/browser-probes.md`. Spec refs: `PROJECT_ANALYSIS.md` §4 S13,
§5.5 (R1), §9.4, §12 Q12; `docs/adr/ADR-008-pwa-installability.md`; `docs/dev/pwa-install.md`.

---

## 1. Scenario verdicts

| # | Scenario (goal list) | Verdict | First-hand evidence |
|---|---|---|---|
| S1 | Manifest validity + icons | **PASS** | Independent 24-check probe against built `dist/` for BOTH bases: required members, `display: standalone`, ≥4 icons (any+maskable × 192/512), PNG IHDR dimensions == declared sizes, maskable glyph inside the 80% safe zone (decoded pixels: 192 bbox `[57,65]-[134,128]`, 512 bbox `[153,175]-[358,344]`), exactly one `rel=manifest` link + `apple-touch-icon` + `apple-mobile-web-app-capable/title`. `node scripts/webmanifest.mjs --check dist` ok for `/` and `/browser-todo-app/`; `npm run icons:check` 5/5 committed bytes deterministic. Logs: `manifest-probe-root.log`, `manifest-probe-repo.log`, `gates.log` |
| S2 | Base-path scope: manifest `start_url`/`scope` + SW scope agree | **PASS** | Live browser (P1): manifest `id`=`start_url`=`scope`=`/browser-todo-app/` == `navigator.serviceWorker.getRegistration().scope` (`http://127.0.0.1:4183/browser-todo-app/`, SW `activated`); manifest link and all 4 icons resolve under the base (HTTP 200, correct content-types; root `/manifest.webmanifest` → 404 = no root-domain leak). Same agreement under `/` from the e2e suite (`install.spec.ts` 2/2, `e2e-sw.log`) |
| S3 | Offer appears ONLY after the first task; prompt-tier face correct | **PASS (logic)** / **FAIL natively → E6-D1** | With a prompt-tier event available: notice count `0` before the first task, offer renders after it with `role=status`/`aria-live=polite`, focus untouched, [Install] invokes captured `prompt()` exactly once, [No thanks] dismisses (P2). BUT with the browser's own event: see E6-D1 — 7/7 native loads lost, offer never appears (P3–P7) |
| S4 | Dismissal respected across sessions (no nagging) | **PASS** | Fresh profile (P10): [No thanks] → flag `todo:prefs:v1:dismissedBanners = ["had-data","install-prompt"]`; reload session AND second tab, each with a fresh prompt-tier event + a new task → offer ABSENT both times. Decline-the-native-dialog path covered by unit state-machine suite (40/40 install tests green) |
| S5 | Home-screen install on Android Chrome / iOS Safari | **PASS (emulated surfaces)** / **NOT TESTABLE on hardware** | Prompt face + Install wiring emulated (P2); iOS Share-sheet face verified under iPhone-Safari-UA with exact copy, both steps, single [Got it] (P8); `prompt()` hand-off verified by call counter. Real install dialogs on real devices: **no Android/iOS hardware in this environment** — see §3 device-coverage statement |
| S6 | Post-install launch with correct scope (incl. `/<repo>/` base) | **PASS (emulated)** | `display-mode: standalone` (e2e's `matchMedia` method): shell boots at `/browser-todo-app/`, nav + data present, offer suppressed even with the dismissal flag cleared and an eligible event captured (P11b); e2e `install.spec.ts` standalone test green (5/5). Real home-screen launch: pending hardware (§3) |
| S7 | Installed app works offline from the home screen | **PASS (emulated)** | Servers killed (`curl` → `000`, origin genuinely dead): standalone boot from the SW cache (`swController: true`), all 4 prior tasks render, a task created fully offline survives an offline reload (IndexedDB), manifest+icons served from the shell cache with correct content-types, unknown deep paths fail honestly (P12) |
| S8 | Unsupported browsers degrade gracefully (no dead UI) | **PASS** | Engine event blocked at document-start (= Firefox/Safari-desktop reality) + desktop UA: NO notice ever, `#install-notice-root` empty (0 interactive elements), app fully functional — task create/reload unaffected (P9). Silent listener attach/shutdown covered by unit suite |
| S9 | iOS ITP 7-day exemption documented as a manual verification note | **PASS** | `docs/dev/pwa-install.md` §5 states the exemption is Apple platform behaviour, "cannot be verified in CI", needs a real device + 7-day absence; §6 checklist item 5 assigns the post-hoc observation to this card's manual list (items OPEN pending hardware — §5 below). Onboarding copy names install as the durable-storage option (`install.body.*`, `dataSafety.onboarding.body3` — en catalog, i18n parity green) |

## 2. First-hand runs (clean clone of `c4cb303`, 2026-10-26)

| Gate / suite | Result |
|---|---|
| `npm run format:check` | exit 0 |
| `npm run lint` (`--max-warnings 0`) | exit 0 |
| `npm run typecheck` (`tsc -b`) | exit 0 |
| `npm run i18n:check` | PASS (en/th key sets, values, placeholders consistent) |
| `npm run icons:check` | 5/5 committed icons byte-deterministic |
| `npm run test` | **980 passed (980)**, 87 files, 27.4 s |
| install-specific suites (`install-prompt`, `webmanifest`, `generate-icons`, `install-notice`) | **40 passed (40)** |
| `npm run ci` (format+lint+tsc+i18n+coverage+build+budget, chained) | **exit 0**; budgets PASS (initial-js 66.6/100 KB, css 6.7/20, app-shell 83.4/200, locales 13.4/20); build leaves `src/sw/precache-manifest.ts` unchanged (precache-freshness gate would pass) |
| `npx playwright test --config playwright.sw.config.ts` | **21 passed** — incl. `install.spec.ts` 5/5 (scope/start_url vs live SW scope both bases, offer timing+dismissal, Install wiring, standalone launch) and the V1 scope guard (`offline-robustness.spec.ts`: one manifest, one shipped handler, manifest not precached) |
| `npm run audit:gate` (`npm audit --omit=dev --audit-level=high`) | **0 vulnerabilities** |
| Live HTTP checks (base build, Pages-like server) | index/manifest/sw.js/icons `200` with `application/manifest+json` / `image/png`; `/manifest.webmanifest` → `404` |
| Independent browser probes P1–P13 | transcript: `e6-install-logs/browser-probes.md` |

## 3. Device-coverage statement (explicit — acceptance criterion)

**No physical Android phone, iPhone/iPad, or desktop-Chrome install surface is attached to this
environment** (no adb device, no macOS/Xcode, no handset; browser runs are headless Linux
Chromium: harness `HeadlessChrome/145` + the repo's Playwright-bundled Chromium). Therefore:

- **Verified by execution:** manifest + icons (static, both bases); manifest↔SW scope agreement
  (live, both bases); offer timing discipline; prompt and iOS-manual **faces** with exact copy;
  permanent dismissal across reload and tabs; standalone launch semantics (emulated
  `display-mode: standalone`); full offline operation from a standalone context with the origin
  dead; unsupported-tier graceful degradation; all automated suites (21 e2e + 980 unit/component).
- **NOT verified on hardware (remains OPEN, checklist `docs/dev/pwa-install.md` §6 items 1–5,
  owned by this card):** the real Android Chrome install dialog + home-screen icon launch; the
  real iOS Safari Share → "Add to Home Screen" flow + its launch; a real home-screen offline run
  on either platform; the iOS 7-day ITP exemption itself (needs a device + ≥7-day absence — it is
  by design unprovable in CI, §5 of the dev doc); and **a real Chrome confirmation of E6-D1's
  fix** (the race is structurally proven on Chromium 145, but the winning-conditions after the
  fix should be spot-checked on real Chrome when hardware appears).
- Honest scope note: Chromium `prompt()` hands-off is verified by invocation counter, not by a
  real OS install dialog (headless has none).

## 4. Defect list

### E6-D1 — HIGH (blocks S13 acceptance on Chromium): native `beforeinstallprompt` is lost to a boot-order race — fix card `t_d7fed00c`

- **Observed:** on Chromium 145, the browser delivers `beforeinstallprompt` at **19–21 ms** (warm
  SW), 114 ms and **178 ms** (fresh origin, before its SW was even ready) after navigation, while
  the app attaches its listener only when `#install-notice-root` mounts at **24–220 ms** —
  `defaultPrevented` stayed `false` after full boot (app never saw the event). **7/7 loads lost**
  (5/5 repeat return-visits + first visit on a fresh origin); in every one of them, after the
  first task of the session the offer was **ABSENT**, while a synthetic **post-boot** event in the
  same state machine raised it immediately. Net effect: `installTier()` degrades to
  `unsupported` for Chromium users → the post-first-task install offer never appears natively on
  Android/desktop Chrome.
- **Root cause:** `src/app/main.tsx` `start()` awaits `initLocale({timeoutMs:2000})` and the
  prior-use `probe` **before** `bootInstallFlow()`. Chrome fires the event on manifest+icon
  validity (installability no longer waits for the service worker), i.e. before those awaits
  complete; a delivered event is never re-sent in the same navigation.
- **Why upstream e2e missed it:** `tests/e2e/install.spec.ts` synthesizes the event **after** boot
  and states it "never fires headless" — that premise is browser-build-dependent: true for the
  repo's Playwright Chromium (`n=0` in a fresh profile, `native-bip-playwright.log`), false for
  Chromium 145 (`n=1` per load). The suite therefore proves the state machine (correct) but not
  capture (broken).
- **Affected scenarios:** S3 natively (above). Unaffected: iOS manual tier (no event exists on
  iOS), unsupported tier, dismissal, standalone, offline, scope.
- **Fix requirements:** in `t_d7fed00c` — attach listeners synchronously at module-evaluation
  time (before any await), keep every existing discipline (timing after first task, permanent
  dismissal, standalone suppression), add a regression e2e that dispatches the event via
  `addInitScript` **before** app scripts, correct the spec's premise comment, re-run both suites.

### E6-D2 — INFO (non-blocking): manifest ends up in the shell cache at runtime

`docs/dev/pwa-install.md` §7 / ADR-008 say the manifest is "not precached" — true for the
build-time precache list (`generate-precache` excludes `*.webmanifest`; the e2e guard checks
this). But the SW's generic asset rule (`src/sw/routing.ts:137` — any in-scope GET that is not a
navigation or `sw.js` → cache-first, **write-through on miss**) puts `manifest.webmanifest` into
the shell cache on its first fetch (observed: 17-entry cache contains it). Behaviour is benign —
version-pinned per deploy, and it lets the manifest resolve offline — but the docs sentence
should be clarified ("not in the precache manifest; runtime-cached like any in-scope asset").
No functional impact; no fix required beyond one doc line (can ride along in `t_d7fed00c`).

### E6-D3 — NIT (non-blocking): `apple-mobile-web-app-status-bar-style` not shipped

`index.html` ships `apple-mobile-web-app-capable=yes` + `apple-mobile-web-app-title` (the tags
the A2HS flow needs; verified live). The optional status-bar-style meta is absent — cosmetic
only (status-bar tint), not required for install and not promised by ADR-008 or the dev doc.
Recorded for completeness; no action unless the design asks for it.

### Observations (not E6 defects)

- **O1:** during probing, two `todo-shell:browser-todo-app:v:*` caches coexisted on one origin —
  an artifact of my swapping builds under a live SW in one long-lived profile; the e2e
  `activate purges old VERSIONS` test is green (21/21) and ADR-005 owns cache lifecycle (E4
  scope), not this card.
- **O2:** the sibling-shared tree still breaks `npm run i18n:check` in-worktree
  (`notify.reminder.body` owned by another in-flight card, flagged by t_4dfee282); everything
  above was executed in a clean clone of `c4cb303` where it passes.

## 5. Manual-verification items still OPEN (documented, hardware-gated)

Per `docs/dev/pwa-install.md` §6 checklist (owned by this card):

1. Android Chrome: install dialog → home-screen launch (standalone, offline). **OPEN — no device.**
2. Android Chrome: [No thanks] → never re-offers. **OPEN — no device** (browser-side persistence
   proven P10; the Android-specific run remains).
3. iOS Safari: Share → "Add to Home Screen" → icon (`apple-touch-icon-180.png`) → standalone launch. **OPEN — no device** (manual face copy verified P8).
4. `start_url` under `/<repo>/` launches from the home screen without 404/root leak. **Browser-side OPEN-verified** (scope agreement + offline standalone boot at the base); the physical home-screen tap remains.
5. iOS ≥7-day ITP exemption observation on an installed app (post-hoc, document in docs/qa/). **OPEN — needs device + ≥7-day absence; unprovable in CI (dev doc §5).**

## 6. Conclusion

S13's mechanical contract is sound and well-tested: scope correctness under both bases, offer
timing discipline, permanent dismissal, standalone suppression, offline-from-install, and clean
degradation all hold first-hand, with the upstream suites green (980 + 21). The one release-
relevant gap is **E6-D1**: the very event the Chromium tier depends on is lost to a boot-order
race, so the "right moment" offer cannot surface on Chrome-family browsers as shipped. Track in
**`t_d7fed00c`**; re-verify S3 after the fix; keep §5's device checklist attached to this card
for when hardware becomes available.

## 7. Evidence index

`docs/qa/e6-install-logs/` — `browser-probes.md` (full P1–P13 transcript),
`gates.log` (format/lint/tsc/i18n/icons/audit), `unit.log` (980/980),
`e6-ci.log` (full chained `npm run ci`), `install-suites.log` (40/40),
`e2e-sw.log` (21/21), `manifest-probe-root.log` / `manifest-probe-repo.log` (24/24 each),
`build-base.log`, `native-bip-playwright.log` + the probe scripts
(`manifest-probe.mjs`, `playwright-native-bip.mjs`) for re-execution.
