/**
 * Repo adapters public surface (ADR-003 Decision 1): `src/storage/repos/`
 * implements the domain ports over `AppDB`. Adapters own stamping, tombstoning
 * + purge, validation, order-key math, list-delete disposition and RMW patch
 * merge; they return `Result<T, AppError>` and record failures in the
 * structured error log (ADR-002 §10.4).
 */

export { TaskRepo } from './taskRepo';
export { ListRepo } from './listRepo';
export { SettingsRepo } from './settingsRepo';
export type { RepoDeps, SiblingGroup } from './support';
export { evenOrderKeys, neighborsAround, taskGroupRows, listGroupRows, readRows } from './support';
