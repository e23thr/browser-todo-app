# Backlog — Local-First Todo App (decomposition of PROJECT_ANALYSIS.md)

Produced by h_pm, kanban card t_1b9ee0e6, 2026-10-23. Source of truth for scope remains
PROJECT_ANALYSIS.md (PO-validated; §0 decision register, §12 all 15 answers DECIDED).
This file is the human-readable index of the kanban backlog: 76 cards across 10 epics +
1 MVP release gate.

## Graph shape (IMPORTANT)

Dependency edges are parent-first in this dispatcher: a card runs only after ALL its
parents are done. Therefore epic tracking cards sit at the END of their work streams
(edges flow work-item -> epic): an epic promotes when its last test/review card is done,
then the h_pm run verifies the epic's acceptance criteria and reports to the PO.
Epic cards are NOT parents of work items (that would deadlock). Work-item cards name
their epic in the title tag [En] and body.

Pipeline per feature: Design (h_designer) / Arch ADR (h_senior_coder) -> Impl
(complex -> h_senior_coder, standard -> h_junior_coder) -> Test + Review (parallel,
h_reviewer) -> epic closeout (h_pm).

Shared workspace for every card: /home/ubuntu/workspace/browser-todo-app
Docs conventions: docs/adr/ADR-NNN-*.md, docs/design/*.md, docs/qa/*.md.

## Decisions settled by the decomposer (binding in card bodies)

- i18n API/format: `t(key, params?)`; src/i18n/en.json + th.json, flat dotted keys,
  `{name}` interpolation; setLocale() lazy-loads and sets document.documentElement.lang;
  en fallback + local log. (So shell and i18n cards could run in parallel without
  inventing competing schemes.)
- S3 priority model (V1): P1..P4 replacing 0|1|2 via migration (0->P1, 1->P2, 2->P3,
  unset->P4).
- Subtasks (V1): single level only; independent completion; parent deletion keeps a
  disposition dialog.
- Recurrence field format (V1): { freq: daily|weekly|monthly|weekdays, interval >= 1,
  until? } — no exceptions/end-count (R4 line). Semantics in the recurrence card,
  format reserved in the tags/subtasks migration (single decider chain).
- Undo toast (V1): single-step, 10s window; replaces delete-confirm for tasks;
  list deletion keeps its disposition dialog.

## Decisions reserved to Arch ADRs (sole deciders — never duplicated)

| Question | Sole decider card | Output |
|---|---|---|
| UI framework + build tooling | t_9fa51c86 ADR-001 | docs/adr/ADR-001-ui-framework.md |
| Storage schema + IDB wrapper | t_576c2376 ADR-002 | docs/adr/ADR-002-storage-schema.md |
| Domain layer / state / search | t_e0245a8c ADR-003 | docs/adr/ADR-003-domain-layer.md |
| Export/import file format | t_8c2e4e93 ADR-004 | docs/adr/ADR-004-export-import-format.md |
| Service worker strategy | t_a7b86d9c ADR-005 | docs/adr/ADR-005-service-worker.md |
| WebDAV sync protocol | t_6e4bb440 ADR-006 | docs/adr/ADR-006-webdav-sync.md |
| Encryption design | t_55accc9c ADR-007 | docs/adr/ADR-007-encryption.md |

Pre-decided policy nobody may change: per-record LWW keyed on (updatedAt, deviceId);
tombstone deletions; unmergeable conflicts -> visible "Conflict copy of <task>"
(section 6.2). No backend/accounts/telemetry; attachments out of scope entirely (Q7).

## Epic map (priority order)

### E1 — Infrastructure & DevOps (MVP foundation) — epic card t_18f28c32
- t_9fa51c86 ADR-001 UI framework & build tooling (h_senior_coder)
- t_576c2376 ADR-002 Storage schema & IndexedDB wrapper (h_senior_coder)
- t_3c5ef00d Impl: scaffold, build & GitHub Pages CI/CD + quality gates (h_junior_coder)
- t_eba4b531 Impl: IDB wrapper, schema versioning & migration/boot-validation (h_senior_coder)
- t_c7d6403e Test: scaffold & CI gates / t_51180c4b Review: scaffold & CI/CD
- t_ae894274 Test: storage & corruption drills / t_70062edb Review: storage framework

### E2 — Core Domain: Task & List Management (MVP) — epic card t_9b61ecf5
- t_a236d6ea Design: task & list interaction spec (h_designer)
- t_e0245a8c ADR-003 Domain layer, state & search-index (h_senior_coder)
- t_aee34500 Impl: domain core — repositories, optimistic pipeline, tombstones (h_senior_coder)
- t_a2c647e1 Impl: core UI — editor, lists, views, complete/uncomplete (h_junior_coder)
- t_8524d4d7 Impl: search, reorder (drag+keyboard), virtualization (h_junior_coder)
- t_7080a238 / t_371b966c Test/Review: domain core
- t_8227547d / t_3650ed00 Test/Review: core UI
- t_fa0903f2 / t_64b514e2 Test/Review: search, reorder & virtualization

### E3 — Data Safety & Portability (MVP) — epic card t_57b9ef8f
- t_b859b131 Design: data-safety, backup & onboarding UX (h_designer)
- t_8c2e4e93 ADR-004 Export/import file format & merge semantics (h_senior_coder)
- t_a7c2087f Impl: export/import, snapshots, boot recovery, quota handling (h_senior_coder)
- t_9f6f9631 Impl: data-safety UX — panel, persist(), nudges, eviction detection (h_junior_coder)
- t_f0702c05 / t_6f04d146 Test/Review: export/import & recovery drills
- t_b1595f03 / t_3d95d5ef Test/Review: data-safety UX (R1 defence surface)

### E4 — Offline & App Shell (MVP; install = V1 E6) — epic card t_5ea89a3f
- t_a7b86d9c ADR-005 Service worker & update strategy (h_senior_coder)
- t_6460ac5a Impl: SW app shell, update flow, offline-complete (h_senior_coder)
- t_be7f0810 / t_5b4c7b35 Test/Review: offline journeys, update flow, cache lifecycle

### E5 — UX Foundation, Accessibility & i18n (MVP) — epic card t_db6845bc
- t_81b0df28 Design: UX foundation & design system incl. Thai typography (h_designer)
- t_afe9bb56 Impl: responsive shell, theme no-FOUC, minimal settings (h_junior_coder)
- t_5696ea45 Impl: i18n en+th (M15) (h_junior_coder)
- t_46150118 / t_01ee8f5a Test/Review: shell, theme & settings
- t_8e3c7e08 / t_8a0a176a Test/Review: i18n en+th
- t_b788bacf Test: WCAG 2.2 AA + Thai-text accessibility RELEASE GATE (M13)

### MVP release gate — t_7f1e8f29 (h_reviewer) — [MVP] Definition-of-Done verification (Q15)
Gated on all five MVP epic cards; gates everything V1/stretch. Includes the
scope-fidelity audit (Q7 no attachments, Q9 en+th, Q11 GitHub Pages, Q12 no PWA
install in MVP). The "30 days of daily use" criterion is PO-PENDING by design.

### E6 (V1) — PWA Installability (S13, R1 structural fix; FIRST V1 epic) — epic card t_e396a78f
- t_4dfee282 Impl: manifest, install prompt & home-screen install (h_senior_coder)
- t_3d254f0f / t_6e9e4f81 Test/Review: install flows & base-path scope

### E7 (V1) — Organization — epic card t_eb2174d7
- t_b5078638 Impl: tags, subtasks & priority model + V1 schema migration (h_senior_coder)
- t_354a153f Impl: RRULE-lite recurrence + undo toast (h_junior_coder)
- t_ed1fa949 / t_d45b8cf7 Test/Review: tags, subtasks, priority & migration
- t_a056b19f / t_ee0bbc61 Test/Review: recurrence & undo

### E8 (V1) — WebDAV Sync (opt-in, user-provided storage) — epic card t_15e14284
- t_6e4bb440 ADR-006 WebDAV sync protocol & merge engine (h_senior_coder)
- t_00d7f17b Impl: sync engine & conflict copies (h_senior_coder)
- t_5f4fe7db Impl: sync UI — setup, status, conflict surfacing (h_junior_coder)
- t_beed2e01 / t_057dcbc6 Test/Review: sync engine (merge/LWW/failure injection)
- t_98a1b4a5 / t_7567495e Test/Review: sync UI

### E9 (V1) — Experience & Utilities — epic card t_9b8b3000
- t_5166e154 Impl: archive/retention, storage dashboard, backup files, Todo.txt/CSV
  importers (h_junior_coder)
- t_ee8ecb0b Impl: shortcuts, command palette, quick add, local notifications (h_senior_coder)
- t_adbd2e36 / t_8f8242cc Test/Review: archive, dashboard & importers
- t_b3280190 / t_8f41af00 Test/Review: shortcuts, palette & notifications

### E10 (stretch) — Encryption at Rest (C1) — epic card t_b985546a
- t_55accc9c ADR-007 Encryption design (h_senior_coder)
- t_db67a322 Impl: encryption at rest + forced-backup & recovery-key UX (h_senior_coder)
- t_0a8e0c42 / t_0913b7e4 Test/Review: encryption & recovery flows

## Sequencing notes

- MVP wave 1 (dispatched immediately): the three design specs + ADR-001 + ADR-002.
- Everything impl-shaped is gated on the ADR it must implement against (handoff
  metadata carries the decisions; bodies restate the pre-settled ones).
- V1/Stretch impls are additionally gated on the MVP DoD card (t_7f1e8f29) — no V1
  work runs before MVP is verified. ADR-006/007 are docs-only and may be written any
  time (they only wait on ADR-002/each other).
- E6 (PWA install) is deliberately the first V1 epic: it is the structural fix for R1
  (iOS eviction), which the PO accepted as residual risk for MVP via Q12.
