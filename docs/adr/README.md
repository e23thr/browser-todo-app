# Architecture Decision Records

This directory holds the project's ADRs: one record per material architectural decision, written
before the affected code lands, by the decision owner. ADRs are append-only; a superseded decision
keeps its record with `Status: Superseded by ADR-NNN` and a pointer.

## Conventions

- **File naming**: `ADR-NNN-short-title.md` (NNN zero-padded, sequential, never reused).
- **Status**: `Proposed` → `Accepted` → (`Superseded by ADR-NNN`). Accepted = the decision binds
  downstream cards; re-opening requires a scope change and a new ADR that supersedes the old one.
- **Ownership**: each ADR names its decider. Framework/toolchain has a single decider
  (h_senior_coder, task t_9fa51c86) — other cards must not re-decide what an accepted ADR settled.
- **Evidence**: prefer measured facts (bundle sizes, timings) over estimates; record how and when
  measured.

## Index

| ADR | Title | Status | Decider | Scope |
|---|---|---|---|---|
| [ADR-001](ADR-001-ui-framework.md) | UI framework & build tooling | **Accepted** (2026-10-23) | h_senior_coder | Preact + signals + Vite + npm + TS strict + ESLint/Prettier + CI matrix + bundle-budget gates + repo layout |

## Planned (required by PROJECT_ANALYSIS.md §9.5)

| ADR | Title | Owner | Notes |
|---|---|---|---|
| ADR-002 | Storage wrapper & schema (IndexedDB) | h_senior_coder | `idb` wrapper class (§5.2), store/index layout (§5.3), migration chain + snapshots (§5.4) |
| ADR-003 | Service worker strategy | h_senior_coder | app-shell precache, update flow ("never force reload", E9), scope derived from `BASE_PATH` (§6.1/§9.5) |
| ADR-004 | Sync protocol (V1, WebDAV) | h_senior_coder | LWW conflict policy is pre-decided (§6.2); protocol + conflict copies |
| ADR-005 | Encryption at rest (stretch C1) | h_senior_coder | WebCrypto AES-GCM + PBKDF2, forced-backup UX (§7.3); any WASM (e.g. Argon2) is a bundle-budget exception requiring explicit framing |

Planned rows are placeholders with numbers reserved so downstream cards link to stable identifiers;
each is created when its card is worked. A budget exception (WASM) additionally requires an ADR that
updates the `no-wasm` CI gate alongside the payload.
