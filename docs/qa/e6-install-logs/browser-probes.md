# E6 install QA — live browser probe transcript (t_3d254f0f)

Raw outputs of the first-hand browser probes behind `docs/qa/e6-install.md`. Copied verbatim
from the tool transcripts of the 2026-10-26 run (labels slightly trimmed for readability).

**Environment**

- Browser: Hermes browser harness Chromium — `Mozilla/5.0 (X11; Linux x86_64) … HeadlessChrome/145.0.0.0 Safari/537.36` (headless).
- Secondary browser: the repo's Playwright-bundled Chromium via `playwright-native-bip.mjs`.
- Served build: `BASE_PATH=/browser-todo-app/ npm run build` output of clean clone `c4cb303`,
  served by the repo's own GitHub-Pages-like fixture server (`tests/e2e/fixtures/static-server.mjs`,
  no SPA rewrite, `cache-control: no-cache`) at `http://127.0.0.1:4183/browser-todo-app/`;
  a second identical server on `:4184` provided a fresh origin for the first-visit probe.
- Profiles: session `e6-install-qa` (warm, pre-existing SW), session `e6-qa-2` (fresh profile),
  Playwright script (fresh profile).
- Test data names below ("Install QA List", "…probe task") are QA fixtures, not app strings.

---

## P1 — base-path scope: manifest vs live service-worker scope

```
UA: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/145.0.0.0 Safari/537.36
manifest link: http://127.0.0.1:4183/browser-todo-app/manifest.webmanifest
manifest fetch: {"id":"/browser-todo-app/","start_url":"/browser-todo-app/","scope":"/browser-todo-app/","display":"standalone","icons":["/browser-todo-app/icons/icon-192.png|192x192|any","/browser-todo-app/icons/icon-512.png|512x512|any","/browser-todo-app/icons/maskable-192.png|192x192|maskable","/browser-todo-app/icons/maskable-512.png|512x512|maskable"]}
SW scope: http://127.0.0.1:4183/browser-todo-app/ | active: activated
display-mode standalone: False | notice count: 0
apple tags: {"capable":"yes","title":"Todo","touch":"http://127.0.0.1:4183/browser-todo-app/icons/apple-touch-icon-180.png"}
onboarding present: True
```

⇒ manifest `id`/`start_url`/`scope` == live `navigator.serviceWorker.getRegistration().scope`
under the `/<repo>/` base; HTTP checks: index/manifest/sw.js/icons all `200`
(manifest `application/manifest+json`, icons `image/png`), root `/manifest.webmanifest` → `404`.

## P2 — prompt tier: timing discipline + Install wiring (synthetic event, post-boot)

```
onboarding clicked: True
notice BEFORE first task (synthetic BIP already captured): 0
NOTICE after first task: {"present":true,"text":"Keep your tasks — install Todo | Installing adds an app icon and runs Todo in its own window. On iPhones and iPads, installed apps are exempt from Safari's 7-day website-data cleanup — the strongest protection against losing your tasks. Keep backing up too. | Install | No thanks","role":"status","live":"polite","buttons":["Install","No thanks"],"focus":"INPUT/"}
prompt() calls: 1
notice after Install: 0
```

⇒ offer never renders before the first task; renders after it with the prompt face;
`role=status`/`aria-live=polite`, focus not stolen; Install invokes the captured `prompt()` exactly once.

## P3/P4 — NATIVE event: app does not capture it; state machine itself is fine

```
native BIP events (real browser, 3s window): 1
NOTICE (native, default UA): {"present":false}
task visible: True
dismissal flag still empty: ["had-data"]
--- P4 same session ---
BIP log (t, prevented-at-callback, hasPrompt): [{"t":1792957137293,"prevented":false,"hasPrompt":true}]
prevented flag after app fully booted: false
notice after task (native BIP only): False
notice immediately after SYNTHETIC dispatch (same session): Keep your tasks — install Todo | …
```

⇒ the browser DID deliver `beforeinstallprompt`; the app's handler never ran (no
`preventDefault`), so `deferred` stayed null; the same session/state machine raises the offer
from a post-boot event ⇒ defect is capture timing, not offer logic.

## P5 — timing: native event vs listener attach

```
native BIP at ms-after-nav: 21
DOMContentLoaded at ms: 16
install-notice-root mounted at ms: 28      (= bootInstallFlow attach, main.tsx order)
app's preventDefault on native event (live re-read): false
event has prompt(): function
notice after task: False
```

## P6 — consistency: 5 return-visits, warm SW (no synthetic event anywhere)

| run | native BIP at | attach at | preventDefault (500ms re-read) | native events | offer after 1st task |
|---|---|---|---|---|---|
| 0 | 21 ms | 26 ms | false | 1 | ABSENT |
| 1 | 19 ms | 24 ms | false | 1 | ABSENT |
| 2 | 19 ms | 24 ms | false | 1 | ABSENT |
| 3 | 19 ms | 24 ms | false | 1 | ABSENT |
| 4 | 114 ms | 135 ms | false | 1 | ABSENT |

⇒ **7/7 loads total (P3–P7): the event always precedes the app's listener and is lost.**

## P7 — first visit, fresh origin (`:4184`, no SW, onboarding shown)

```
TIMELINE: {"bips":[178],"root":220,"controller":378,"swReady":377}
OFFER after first task on first visit: {"present":false}
```

⇒ even before the service worker is ready (Chrome's installability check no longer requires an
SW), the event fires before `bootInstallFlow()` attaches; the first-ever visitor also gets no offer.

## P8 — iOS manual tier (iPhone Safari UA override; real iOS never fires BIP at all)

```
UA now: Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 … Version/17.5 …
native BIP count under iPhone UA: 1        (engine still fired; missed — irrelevant on real iOS)
MANUAL FACE: {"present":true,"text":"Add Todo to your Home Screen | Install it from the Share menu — on iPhones and iPads, home-screen apps are exempt from Safari's 7-day website-data cleanup, the strongest protection against losing your tasks. | Tap the Share button in Safari. | Choose \"Add to Home Screen\", then tap Add. | Got it","steps":["Tap the Share button in Safari.","Choose \"Add to Home Screen\", then tap Add."],"buttons":["Got it"],"role":"status","live":"polite","focusAfterRender":"INPUT"}
```

## P9 — unsupported tier (early listener blocks the engine event = Firefox/Safari-desktop reality)

```
UNSUPPORTED TIER STATE: {"notice":false,"installishDom":["Install QA List","Install probe task"],"emptyContainer":true,"taskVisible":true,"composerWorks":true}
```

⇒ no notice, `#install-notice-root` present but EMPTY (no dead UI), app fully functional.
(`installishDom` matches are only QA fixture data.)

## P10 — dismissal is permanent across app sessions (fresh profile, prompt face)

```
task created: True
OFFER: {"present":true,"buttons":["Install","No thanks"]}
notice after No thanks: False
FLAG: ["had-data","install-prompt"]
SESSION 2 (reload) task created: True   SESSION 2 offer: False   FLAG: ["had-data","install-prompt"]
SESSION 3 (2nd tab)  task created: True  SESSION 3 offer: False
```

⇒ "No thanks" writes the ADR-002 D7 `dismissedBanners` sentinel `install-prompt`; a reload AND a
second tab in the same profile, each with a fresh prompt-tier event and a new task, never re-offer.
(First attempt at this probe was vacuous — the fresh profile had no list, so no task was created;
corrected by creating the list first. Probe error, not app defect.)

## P11 — standalone (home-screen) suppression

CDP `Emulation.setEmulatedMedia {display-mode: standalone}` did NOT affect `matchMedia` on this
Chromium (`matches:false` → offer appeared, as designed for non-standalone), so the e2e method
(`matchMedia` override, same as `install.spec.ts`) was used:

```
flag after clean: ["had-data"]
matchMedia standalone (overridden): True
task created: True
STANDALONE OFFER (must be ABSENT, flag only has had-data): False
flag unchanged: ["had-data"]
empty install container: True
```

⇒ with the dismissal flag NOT set and a captured prompt-tier event eligible, standalone
suppresses the offer entirely (the `display-mode: standalone|fullscreen` branch).

## P12 — offline FROM the home screen (standalone emulated + origin genuinely dead)

Servers killed first — `curl` to both ports returned `000` (connection refused), then:

```
offline manifest fetch detail: {"status":200,"ct":"application/manifest+json","body":"{\n \"id\": \"/browser-todo-app/\", …"}
offline icon fetch detail: {"status":200,"ct":"image/png","len":2240}
offline unknown-path fetch: {"err":"TypeError: Failed to fetch"}
OFFLINE home-screen boot: {"booted":true,"standalone":true,"notice":false,"swController":true}
tasks visible offline: {"Session 2 task": true, "Standalone online task": true, "Offline home-screen task": true, "Standalone suppress task": true}
offline write visible: True
after offline reload — new task present: True
still standalone: True
```

⇒ with the origin unreachable: the shell boots from the SW cache in standalone mode, all prior
tasks render, a task can be created fully offline and survives an offline reload (IndexedDB),
and no offer renders. Unknown deep paths fail honestly (no bogus offline page for non-navigations).

Cache inspection in that offline state:

```
todo-shell:browser-todo-app:v:495873b9502f09fb — 17 entries (incl. manifest.webmanifest — see E6-D2)
todo-shell:browser-todo-app:v:467bf9e61dc7636c — 16 entries (stale, see O2)
```

## P13 — repo's Playwright-bundled Chromium (fresh profile): event never fires there

`playwright-native-bip.mjs` output (also in `native-bip-playwright.log`):

```
visit1-fresh (ms after nav): {"bip":null,"root":62,"prev":null,"n":0}
visit2-warm (ms after nav): {"bip":null,"root":60,"prev":null,"n":0}
task created: true
offer after first task (native capture only): ABSENT
final: {"bip":null,"root":60,"prev":null,"n":0}
```

⇒ `n=0`: this build/headless never delivers the event at all, which is why the upstream e2e
premise ("never fires headless") looked correct — while Chromium 145 in P3–P7 delivered it in
**every** load. Headless firing is browser-build/profile-dependent; the capture race is real
either way (a delivered event is always lost).
