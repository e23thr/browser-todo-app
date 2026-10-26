# i18n — English + Thai (M15)

The app ships two locales at MVP (PO decision Q9, PROJECT_ANALYSIS §4 M15): English and Thai.
English is the **source of truth**; Thai is **PO-validated content**. This document is the
contract for how strings are stored, added and gated. The API itself is fixed by decomposition
card t_1b9ee0e6 — no card may redesign it.

## 1. The API (`src/i18n/index.ts`)

```ts
t(key: string, params?: Record<string, string | number>): string;
setLocale(locale: 'en' | 'th'): Promise<void>;   // lazy-loads the pack, sets document.documentElement.lang
initLocale(options?: { timeoutMs?: number }): Promise<Locale>;  // boot: persisted locale → pack → lang
getLocale(): Locale;        // plain read
useLocale(): Locale;        // reactive read — call during render to subscribe to switches
registerLocalePersistence(port | null): void;     // durable backend (null = session-only)
isLocaleLoaded(locale): boolean;                 // diagnostic: pack fetched/fetching
```

Rules the runtime guarantees:

- **Missing key** → falls back to the English string → then to the key itself, and logs with
  `console.warn` **once per key** (deduped). Local log only — §7.2 forbids telemetry, ever.
- **Missing param** → the `{placeholder}` stays visible (a QA defect signal) and is logged once
  per key+params.
- **Reactivity**: `t()` reads a Preact signal during render, so every component that renders
  `t(...)` re-renders automatically when the locale changes. No context, no hooks at call sites.
- **`document.documentElement.lang`** is set by `setLocale()` — this is what switches
  screen-reader pronunciation (§8), so it must never drift from the active catalog.

Shipped files:

| File                  | Role                                                                   |
| --------------------- | ---------------------------------------------------------------------- |
| `en.json`             | English catalog — source of truth, flat dotted keys                    |
| `th.json`             | Thai catalog — same key set, same `{name}` placeholders                |
| `locale-en.ts`        | Lazy pack wrapper (English) — a separate chunk, never in initial payload |
| `locale-th.ts`        | Lazy pack wrapper (Thai) — same                                          |
| `format.ts`           | Pure resolution + interpolation (no DOM, no state)                       |
| `index.ts`            | The runtime above                                                        |
| `settingsPersistence.ts` | ADR-002 adapter: durable `settings.locale` in IndexedDB                |

## 2. Key conventions

- Format: `domain.element[.state]`, flat (no nesting), segments start lowercase and may be
  camelCase: `confirm.deleteTask.body`, `a11y.taskMovedToList`, `settings.weekStart.monday`.
  Enforced by `npm run i18n:check` (`KEY_PATTERN` in `scripts/check-i18n.mjs`).
- Interpolation: `{name}` placeholders only (decomposition card decision). **Not** ICU message
  syntax, **not** `{{name}}` — design docs that write `{{x}}` (data-safety.md §6) normalize to
  `{x}` in the catalog.
- Namespaces and their owners:

| Prefix                             | English source                                            | Owner of the copy       |
| ---------------------------------- | --------------------------------------------------------- | ----------------------- |
| `nav.* view.* group.* task.* a11y.* reorder.* composer.* editor.* date.* priority.* search.* list.* confirm.* form.* error.* common.* *.empty.*` | core-domain.md §13 register | E2 core-UI/search cards |
| `app.* shell.* notFound.* settings.* theme/weekStart defaults` | ux-foundation.md §4 (shell & settings screens) | E5 shell card   |
| `update.*`                         | ux-foundation.md §4.9 "Update available" banner           | SW/update card           |
| `dataSafety.*`                     | data-safety.md §6/§7/§10 exact copy drafts                | E3 data-safety card (not yet minted — see §4) |

- **Precedence when sources disagree**: the core-domain §13 register wins for task/list/search
  copy (it is the register); ux-foundation §11.2 wins for announcement wording patterns; quotes
  inside other prose are illustrative. Any divergence gets a note here or in `th-notes.md`
  instead of a silent reword.
- **Endonyms are never translated**: `settings.language.english` = `English` and
  `settings.language.thai` = `ไทย` in BOTH files — a language switcher always names languages
  in their own language.
- **Sentence-split copy**: when markup splits a sentence around a link (e.g. `error.viewLoad.body`
  ends with `or `), keep the trailing space verbatim in both locales; do not "fix" it.
- **Plurals**: `t()` has no plural engine (fixed contract). Thai has no plural inflection, so a
  single form (`{count} งาน`) is always correct. Where English genuinely needs one/other, add a
  `.one` / `.other` key pair and choose it at the call site with `Intl.PluralRules` (ADR-001);
  never silently change an existing register key's wording — flag it for PO instead.

## 3. Adding a string (every UI card)

1. Add the key to **both** `src/i18n/en.json` and `src/i18n/th.json` (same key, same
   placeholders, flat order preserved).
2. Use `t('key', { …params })` in the component — never hardcode UI copy.
3. Run `npm run i18n:check` — it must print `RESULT: PASS`.
4. If the Thai phrasing is genuinely ambiguous, record it in
   [`th-notes.md`](th-notes.md) rather than guessing silently.

`npm run i18n:check` is wired into `npm run ci` and the GitHub Actions `lint` job. It **fails**
on: a key missing from either file, extra keys in `th`, placeholder-set mismatches, empty or
non-string values, malformed keys, duplicate JSON keys (which `JSON.parse` would silently
collapse), and any literal `t('…')` key in `src/` that `en.json` does not define.
`t(variable)` call sites are listed as informational only — they cannot be verified statically.

## 4. Strings that are NOT in these catalogs

- **`dataSafety.*`** (storage/backup/onboarding copy): data-safety.md §11 assigns that namespace
  to its own surface; the E3 card mints those keys into `en.json` + `th.json` when it lands
  (§6 of that doc is the English source; `{{x}}` → `{x}`; use `.one`/`.other` pairs for its
  `{{N}} days` plurals). The parity gate guarantees Thai completeness the moment they land.
- **Dates and numbers**: no catalog strings — format with `Intl.DateTimeFormat` /
  `Intl.NumberFormat` using the active locale; Thai uses Buddhist era
  (`th-TH-u-ca-buddhist`) per ux-foundation §9.4.
- **Rendering** (system font stack, Thai line-heights, wrapping): ux-foundation §9 + the styles
  cards. No webfont bytes ship with either locale (§9.2).
- **The static `<title>` / `meta name="description"` in `index.html`** — English **pre-paint
  fallback only**, not a second source of truth (documented account of QA defect D1,
  `docs/qa/e5-i18n.md`): the live values are the `app.documentTitle` / `app.metaDescription`
  catalog keys, applied by `src/i18n/documentMeta.ts` immediately after `initLocale()` and on
  every locale switch (the effect reads the catalog signal, so a pack that lands after the
  bounded-boot timeout self-heals the tab too — §5). `document.title = …` in that module is
  the single deliberate `document.title` write under `src/**` that the QA XSS grep counts; it
  is a text sink (no HTML parsed) whose value comes from `t()`.

## 5. Locale loading, boot and tests

- Each locale is a **lazy `import()` pack**. Manifest keys start with `src/i18n/` and the tag
  comes from `locale-<tag>.ts`, which is what makes the bundle gate count `en` inside the
  app-shell sum and keep both packs out of the initial JS closure (`locales` + `locales-lazy`
  gates, scripts/bundle-budgets.json).
- `src/app/main.tsx` calls `registerLocalePersistence(...)` then `await initLocale({ timeoutMs:
  2000 })` **before** `render()`, so first paint never shows raw keys. The wait is bounded: if
  storage or the pack is stuck, the UI mounts anyway and the strings self-heal when the pack
  lands.
- Persistence: ADR-002 `settings.locale` (IndexedDB) through `createSettingsLocalePersistence()`.
  localStorage is deliberately unused — Decision 7's allowed key list has no locale key.
  Without a registered port the locale is session-only (which is what unit tests use).
- Tests: `tests/setup.ts` runs `await setLocale('en')` before every test, because the packs are
  lazy — without priming, `t()` would resolve to raw keys. Switching tests simply `await
  setLocale('th')`.

## 6. Budget (§9.2)

Locale strings (en + th, lazy per locale) must stay **≤ 24 KB gzip total** (PO-ratified
2026-10-26, decision card t_3faa5d95; the budget was 20 KB when this card delivered — E10's
ADR-007 §7.3 mandated copy catalog moved it to 24 KB). Measured two ways:

```sh
npm run build && npm run budget     # `locales` gate: gzip-9 over the built packs in dist/
gzip -9 -c src/i18n/en.json | wc -c # source-level: the strings themselves
```

Measured on this card's delivery (190 keys each): source gzip-9 = 2,573 B (en) + 3,247 B (th)
= **5,820 B ≈ 5.7 KB of the then-20 KB budget**; built packs = 2.55 KB + 3.25 KB = 5.6 KB on the gate. Later
cards adding strings consume the remaining headroom — the `locales` gate is the enforcement
point.