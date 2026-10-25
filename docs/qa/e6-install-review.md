# E6 review — PWA installability (S13), round 1

- Review task: t_6e9e4f81 · Reviewer: h_reviewer · Reviewed SHA: `c4cb303` (impl handoff), clean detached worktree
- **VERDICT: REQUEST CHANGES** — 1 blocking (WCAG 2.2 AA / design §6.10) + 3 non-blocking
- Parallel test card: t_3d254f0f found a separate HIGH defect (E6-D1, listener attach timing → fix card t_d7fed00c). This report's finding is independent of D1 — placement/occlusion, not capture timing.
- Evidence logs + reviewer probe specs: `docs/qa/e6-install-review-logs/` (this commit) and the review task's attachments.

## 1. Automated gates — all PASS at c4cb303

| Gate | Result |
|---|---|
| `npm run ci` | exit 0 — format:check, lint `--max-warnings 0`, `tsc -b`, `i18n:check` (en/th parity), vitest **980/980**, build, budgets (initial-js 66.6/100KB, css 6.7/20KB, app-shell 83.4/200KB, locales 13.4/20KB, `no-external-refs` 0 hits, no-wasm) |
| Coverage | overall 85.73% stmts; `features/install` 93.15%; `installPrompt.ts` 98.43 stmts / 87.87 branch / 100 funcs / 100 lines |
| Precache freshness | build leaves `src/sw/precache-manifest.ts` unchanged (`[unchanged]`) |
| `npm run audit:gate` | 0 vulnerabilities |
| `npm run icons:check` | 5/5 icons ok (byte-deterministic) |
| Main e2e (`npm run e2e`) | **66/66** incl. axe scans light+dark |
| SW e2e (`npm run e2e:sw`) | 20/21 — single failure `offline-robustness.spec.ts:102` perf assertion (108.2ms vs <100ms) under parallel load; passed isolated on retry (5.3s). Not install-related (non-blocking #3). |

## 2. Review-card checklist

| Item | Verdict | Evidence |
|---|---|---|
| Base-path scope | **PASS** | Root and `/<repo>/` builds both `webmanifest --check` ok; manifest `id`/`start_url`/`scope` = normalized base, all icon URLs base-prefixed; `index.html` manifest + apple-touch hrefs rewritten to base at build; e2e `install.spec` 5/5 asserts manifest scope/start_url == **live** `navigator.serviceWorker.getRegistration().scope` under both bases. |
| Prompt timing / dismissal | **PASS** | 13 unit tests (silent before first task, one offer/session, tier gating, permanent dismissal incl. declined native dialog, standalone/`appinstalled` suppression) + component suite + e2e (offer absent before first task, present after, dismissal survives reload). Single seam: `store.ts` `addTask` `result.ok` → `noteTaskCreated()`. Dismissal rides ADR-002 D7 `dismissedBanners['install-prompt']`, single writer `flags.ts`, try-guarded. |
| iOS behavior documentation | **PASS** | `docs/dev/pwa-install.md` §5 states the ITP exemption as Apple behaviour that **cannot be proven in CI**; §6 splits verified (CI/Chromium) vs NOT verified (Android install dialog, iOS A2HS, 7-day exemption) + 5-item manual checklist owned by the test card. |
| i18n of prompt copy | **PASS** | en/th `install.*` parity enforced by `i18n:check`; component test renders the Thai notice after `setLocale('th')`; onboarding body2–4 name the iOS 7-day rule, install as the strongest protection, backups belt-and-braces (R1 honesty), copy contracts updated in 28a9993. |
| a11y of the prompt UI | **FAIL → §3** | The notice's own markup passes everything (below), but its **placement** fails WCAG 2.2 SC 2.4.11 at compact widths. |
| Zero third-party | **PASS** | Icons procedurally generated (pure-node PNG encoder, no new deps — `package.json` diff = 2 script lines, lockfile untouched), `no-external-refs` budget 0 hits, all manifest icons relative paths, audit 0. |

### The notice's own a11y — PASS (reviewer probes)

- **axe-core** (`wcag2a/2aa/21a/21aa/22aa`): **0 violations** in light, dark, **and** the iOS manual tier (3 runs).
- **Touch targets ≥44px measured in-browser**: Install 79.98×44, No thanks 110.75×44, Got it 75.18×44.
- **Contrast computed from tokens.css**: all AA — light title 16.51:1, secondary 6.07:1, primary label on accent 6.93:1; dark title 12.88:1, secondary 7.12:1, label on accent (#0f1216 on #5b7cfa) 5.1:1; control borders ≥3.34:1 (UI 3:1).
- **Keyboard**: notice buttons reachable by Tab (light+dark); no focus theft (activeElement on arrival = composer input, not the notice); one polite `role="status"` live region; no auto-dismiss.

## 3. BLOCKING — WCAG 2.2 SC 2.4.11 (Focus Not Obscured – Minimum, AA) + design §6.10

SC text: *"When a user interface component receives keyboard focus, the component is not
entirely hidden due to author-created content."* WCAG 2.2 AA is the project's release gate
(PROJECT_ANALYSIS §8 / M13: failed criteria block release).

`.install-notice-stack` (src/styles/install.css:9-18) is `position: fixed; right/bottom:
var(--space-4); z-index: 100` in a body-level container appended after `#app` — with the
tab bar and FAB also at `z-index: 100` but earlier in DOM, the notice paints **above both**.

Measured (reviewer probes `e6-install-review-occlusion.spec.ts`, `e6-install-review-tabtraversal.spec.ts`):

| Probe | 360×740 | 768×900 |
|---|---|---|
| notice rect | x 16–344, y 421–724 | bottom 884 (same pattern) |
| FAB rect | x 288–344, y 612–668 → **entirely inside** the notice | overlap 56×56 px = fully covered |
| `elementFromPoint()` at FAB center **and all 4 corners** | `P.install-notice-body` (`entirelyOccluded:true`) | same |
| **Real Tab traversal** (not synthetic focus) | focus sequence … `A.tab`s → `BUTTON.fab [HIDDEN-BEHIND-NOTICE]` → `Install` | — |
| tab bar | notice covers y 684–724 of the 56px bar; tab-center hit-test → `SECTION.install-notice`; only a **16px** strip exposed | overlap 384×41 px |

Consequences:

1. **2.4.11 failure**: the focused FAB is *entirely* hidden behind author-created content
   (the threshold is "entirely" — partial obscuring passes; this is total).
2. **Pointer**: the FAB — the primary capture control on compact layouts, i.e. the exact
   devices this feature targets — is unclickable until the card is dismissed; tab targets
   are largely intercepted too.
3. **Design spec deviation**: ux-foundation.md §6.10 requires bottom-fixed surfaces to sit
   "above tab bar/FAB"; `.toast-stack` (data-safety.css:433-437) honors this with
   `bottom: calc(var(--tabbar-h) + var(--space-4))`, the install notice does not.

**Required fix (acceptance criteria, author's approach):**

- At <1024px, while the notice is visible: the focused FAB must never be entirely hidden
  and must stay pointer-usable, and the tab bar must stay usable. Note: copying
  `.toast-stack`'s `--tabbar-h` offset alone clears the tab bar but **still fully covers
  the FAB** (at 360px the card is near viewport-width and the FAB sits above the tab bar) —
  also lift above the FAB (or cap card width / reposition the stack).
- Verify ≥1024px too: focused content in the bottom-right of the content column must not
  end up entirely behind the notice.
- **Regression test** required: notice rect must not intersect `.fab`/`.tabbar` rects at
  360px and 768px, and an `elementFromPoint` probe on the focused FAB must not resolve
  inside `.install-notice`. Reviewer probe specs are in this commit as a starting point —
  put the new test in a **new spec file** (`tests/e2e/install-placement.spec.ts` matches
  the SW-suite `testMatch`), **not** in `tests/e2e/install.spec.ts` (claimed by fix card
  t_d7fed00c, see §5).

## 4. Non-blocking (fix in the same pass, no re-review)

1. **install.css:4-6 comment is overstated** — it claims "every value is a REAL tokens.css
   variable", but line 13 `z-index: 100` (token `--z-sticky` exists) and line 26
   `box-shadow: 0 4px 16px rgb(0 0 0 / 18%)` (≠ `--shadow-md`) are magic literals copied
   from update.css. Use the tokens or correct the claim.
2. **`.install-action` has no `:hover` state** (design-spec state checklist;
   `.button-primary:hover` precedent shell.css:352). `update.css` shares the gap — the
   follow-up card t_8f6a2009 covers the update notice.
3. **Observation**: `offline-robustness.spec.ts:102` perf assertion flaked once at 108.2ms
   vs <100ms under parallel load; passed isolated. Environment flake, not E6 code — no
   action unless it recurs.
4. **Pre-existing, out of E6 scope**: `update.css:7-11` `.update-notice-stack` uses
   identical placement → same 2.4.11 exposure while the update toast shows. Follow-up card
   **t_8f6a2009** (h_junior_coder).

## 5. Verified PASS detail (no action)

- **Base-path**: both builds + `--check` + e2e SW-scope agreement (root and `/<repo>/`).
- **Timing/dismissal**: never before first task; permanent cross-session dismissal; a
  declined native dialog counts as dismissal; standalone/`appinstalled` suppress
  everything; unsupported tier renders nothing (no dead UI, §9.4).
- **Onboarding honesty (R1)**: body2 names the iOS 7-day rule outright; body3 presents
  home-screen install as the strongest protection; body4 keeps backups belt-and-braces.
- **ADR compliance**: ADR-008 D1 (build-time base-keyed manifest, **not** precached —
  confirmed absent from `PRECACHE_ENTRIES`), D2 (icons committed + byte-deterministic unit
  test + maskable safe-zone proof), D3 (one seam, three tiers, permanent dismissal), D4
  (test strategy + honest device coverage). ADR-005 unchanged (`*.webmanifest` exclusion
  kept with updated rationale).
- **Security**: no new dependencies (lockfile untouched), no secrets, CSP untouched (e2e
  CSP collector clean), the single documented UA sniff confined to `isIosPlatform()`,
  every prefs write try-guarded through the existing single-writer `flags.ts`.

## 6. Disposition

- Blocking + non-blocking 1-2 → fix card **[E6] Fix: install review round 1** (h_junior_coder),
  gated as a parent of Epic E6 (t_e396a78f) so the epic cannot close over a known AA failure —
  same pattern as E1/E2/E3 fix cards.
- Non-blocking 4 → follow-up card **t_8f6a2009** (h_junior_coder), outside E6 scope.
- Parallel E6 defect D1 → fix card **t_d7fed00c** (h_senior_coder, already ready).
  File-disjointness rule between the two fix cards is spelled out in both card bodies
  (§3 and the D1 card): `install.spec.ts` and `installPrompt.ts`/`main.tsx` are D1's;
  `install.css` + new `install-placement.spec.ts` are this fix's.
