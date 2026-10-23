/**
 * Update flow — the user-gated state machine of ADR-005 Decisions 5–7.
 *
 * Update state machine (Decision 5, normative): checks run when online (throttled), a new worker
 * installs and WAITS, the toast appears, and the update applies only on an explicit user click.
 * `applyUpdate()` is the single flush-then-reload call site (Decision 7): it durably flushes any
 * in-flight edit through the ADR-002 storage layer before the ONE `location.reload()` in the
 * codebase, and aborts the reload entirely if that flush cannot be confirmed — a mid-edit session
 * is never force-reloaded (E9). A sibling tab that loses its controller gets an "updated —
 * refresh when ready" notice and is never reloaded.
 *
 * `nextUpdate()` is the pure reducer over the Decision 5 transition table and is exhaustively
 * unit-tested (Decision 9); everything below it is thin, injectable runtime wiring.
 *
 * Edit tracking (Decision 7): an edit is in flight from `beginEdit` (or a detected dirty
 * editable field) until `markEditPersisted` (the committing IDB transaction acked `Ok`). The
 * flush itself is a registered port, in the house style of `registerQuickAddHandler` — the
 * editor/domain layer owns the durable write; this module only sequences it.
 */

import { computed, signal } from '@preact/signals';

// ---------------------------------------------------------------------------------------------
// Pure state machine (ADR-005 Decision 5)
// ---------------------------------------------------------------------------------------------

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'update-found'
  | 'update-ready'
  | 'reload-pending'
  | 'applying'
  | 'reloading'
  | 'check-failed'
  | 'applied-elsewhere';

export type UpdateEvent =
  | { readonly type: 'check-started' }
  | { readonly type: 'check-completed' }
  | { readonly type: 'check-failed' }
  | { readonly type: 'update-found' }
  /** Installed while a controller existed: a new version is waiting. */
  | { readonly type: 'installed-waiting' }
  /** First install (no previous controller): claim quietly, nothing to update. */
  | { readonly type: 'installed-first' }
  /** Installing worker died before `installed` (corrupt/truncated download) — silent. */
  | { readonly type: 'worker-redundant' }
  | { readonly type: 'dismiss' }
  | {
      readonly type: 'apply-requested';
      readonly editInFlight: boolean;
      /** Where Apply started, so a failed flush returns to the right surface. */
      readonly origin: 'update-ready' | 'applied-elsewhere';
    }
  | { readonly type: 'flush-ok' }
  | {
      readonly type: 'flush-failed';
      readonly flavor: 'save' | 'blocked';
      readonly returnTo: 'update-ready' | 'applied-elsewhere';
    }
  /** `controllerchange` that follows OUR Apply. */
  | { readonly type: 'controller-ours' }
  /** `controllerchange` without our Apply (a sibling tab applied the update). */
  | { readonly type: 'controller-elsewhere' };

/** Side effects the runtime driver must perform after a transition. */
export type UpdateEffect = 'none' | 'flush' | 'skip-waiting' | 'reload';

export interface UpdateTransition {
  readonly state: UpdateState;
  readonly effect: UpdateEffect;
  /** Set when a flush failed: `save` = storage error copy, `blocked` = unsaved edit, no flusher. */
  readonly error: 'save' | 'blocked' | null;
}

const UNCHANGED = (state: UpdateState): UpdateTransition => ({
  state,
  effect: 'none',
  error: null,
});

/**
 * The Decision 5 transition table. Unknown/unexpected events are no-ops: the machine never
 * crashes and never reloads without an explicit user action.
 */
export function nextUpdate(state: UpdateState, event: UpdateEvent): UpdateTransition {
  switch (event.type) {
    case 'check-started':
      return state === 'idle' || state === 'check-failed'
        ? { state: 'checking', effect: 'none', error: null }
        : UNCHANGED(state);
    case 'check-completed':
      return state === 'checking'
        ? { state: 'idle', effect: 'none', error: null }
        : UNCHANGED(state);
    case 'check-failed':
      return state === 'checking'
        ? { state: 'check-failed', effect: 'none', error: null }
        : UNCHANGED(state);
    case 'update-found':
      return state === 'idle' || state === 'checking' || state === 'check-failed'
        ? { state: 'update-found', effect: 'none', error: null }
        : UNCHANGED(state);
    case 'installed-waiting':
      return state === 'reloading'
        ? UNCHANGED(state)
        : { state: 'update-ready', effect: 'none', error: null };
    case 'installed-first':
      return state === 'idle' ||
        state === 'checking' ||
        state === 'update-found' ||
        state === 'check-failed'
        ? { state: 'idle', effect: 'none', error: null }
        : UNCHANGED(state);
    case 'worker-redundant':
      return state === 'checking' || state === 'update-found'
        ? { state: 'check-failed', effect: 'none', error: null }
        : UNCHANGED(state);
    case 'dismiss':
      return state === 'update-ready'
        ? { state: 'idle', effect: 'none', error: null }
        : UNCHANGED(state);
    case 'apply-requested':
      if (state !== 'update-ready' && state !== 'applied-elsewhere') return UNCHANGED(state);
      return event.editInFlight
        ? { state: 'reload-pending', effect: 'flush', error: null }
        : { state: 'applying', effect: 'skip-waiting', error: null };
    case 'flush-ok':
      return state === 'reload-pending'
        ? { state: 'applying', effect: 'skip-waiting', error: null }
        : UNCHANGED(state);
    case 'flush-failed':
      return state === 'reload-pending'
        ? { state: event.returnTo, effect: 'none', error: event.flavor }
        : UNCHANGED(state);
    case 'controller-ours':
      return state === 'applying'
        ? { state: 'reloading', effect: 'reload', error: null }
        : UNCHANGED(state);
    case 'controller-elsewhere':
      return state === 'reloading' || state === 'applying'
        ? UNCHANGED(state)
        : { state: 'applied-elsewhere', effect: 'none', error: null };
  }
}

// ---------------------------------------------------------------------------------------------
// Reactive surface (Decision 5: `updateState`, `canApply`, `editInFlight`)
// ---------------------------------------------------------------------------------------------

export const updateState = signal<UpdateState>('idle');
export const updateError = signal<'save' | 'blocked' | null>(null);

const explicitEdits = signal(0);
const dirtyFields = signal(0);

/** True while an edit is uncommitted (explicit `beginEdit` or a detected dirty field). */
export const editInFlight = computed(() => explicitEdits.value > 0 || dirtyFields.value > 0);

/** True when the user may apply a waiting update. */
export const canApply = computed(() => updateState.value === 'update-ready');

/** Toast/notice surface that should be on screen for the current state. */
export const updateSurface = computed<
  'none' | 'toast' | 'flushing' | 'updating' | 'applied-elsewhere'
>(() => {
  switch (updateState.value) {
    case 'update-ready':
      return 'toast';
    case 'reload-pending':
      return 'flushing';
    case 'applying':
    case 'reloading':
      return 'updating';
    case 'applied-elsewhere':
      return 'applied-elsewhere';
    default:
      return 'none';
  }
});

function dispatch(event: UpdateEvent): UpdateTransition {
  const transition = nextUpdate(updateState.value, event);
  updateState.value = transition.state;
  updateError.value = transition.error;
  return transition;
}

// ---------------------------------------------------------------------------------------------
// Edit tracking (Decision 7) — explicit API + conservative DOM dirty detection
// ---------------------------------------------------------------------------------------------

/** Durable write of the in-flight edit through the ADR-002 storage layer. */
export type FlushOutcome = { readonly ok: true } | { readonly ok: false };

export type EditFlusher = () => Promise<FlushOutcome>;

let flusher: EditFlusher | null = null;

/**
 * Register the flush the update must await before reloading (the editor/domain layer owns the
 * durable write — Decision 7 rule 2). Returns a disposer.
 */
export function registerEditFlusher(next: EditFlusher | null): () => void {
  flusher = next;
  return () => {
    if (flusher === next) flusher = null;
  };
}

/** Mark an edit in flight (dirty, uncommitted content or a pending optimistic write). */
export function beginEdit(): void {
  explicitEdits.value += 1;
}

/** The committing transaction acked `Ok` — the edit is durable (or was discarded). */
export function markEditPersisted(): void {
  explicitEdits.value = 0;
  dirtyFields.value = 0;
  dirtyElements.clear();
}

const dirtyElements = new Set<Element>();

const NON_EDITABLE_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'reset',
  'submit',
]);

function isEditableElement(element: Element | null): element is HTMLElement {
  if (element === null) return false;
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement) return !NON_EDITABLE_INPUT_TYPES.has(element.type);
  return element instanceof HTMLElement && element.isContentEditable;
}

function readValue(element: Element): string {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.value;
  }
  return element.textContent;
}

const baselines = new WeakMap<Element, string>();

function onFocusIn(event: Event): void {
  const element = event.target instanceof Element ? event.target : null;
  if (!isEditableElement(element)) return;
  baselines.set(element, readValue(element));
}

function onInput(event: Event): void {
  const element = event.target instanceof Element ? event.target : null;
  if (!isEditableElement(element)) return;
  const baseline = baselines.get(element) ?? '';
  if (readValue(element) === baseline) dirtyElements.delete(element);
  else dirtyElements.add(element);
  dirtyFields.value = dirtyElements.size;
}

function onSubmitted(): void {
  // A submitted form's content has been handed to its owner; only an explicit flush ack counts.
  dirtyElements.clear();
  dirtyFields.value = 0;
}

/**
 * Start the conservative DOM-level half of edit detection (Decision 7's `edit-begin` definition:
 * "focus in an editable field with dirty, uncommitted content"). The explicit API above remains
 * the primary contract; this guard protects editors that have not wired it yet. Returns a
 * disposer.
 */
export function startEditGuard(): () => void {
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('input', onInput, true);
  document.addEventListener('submit', onSubmitted, true);
  return () => {
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('submit', onSubmitted, true);
  };
}

// ---------------------------------------------------------------------------------------------
// Runtime driver
// ---------------------------------------------------------------------------------------------

/** `SKIP_WAITING` — the message the single `skipWaiting()` call site (sw.ts) understands. */
export const SKIP_WAITING_MESSAGE = { type: 'SKIP_WAITING' } as const;

let registration: ServiceWorkerRegistration | null = null;
let applyPending = false;
let hadController = false;
let resolveControllerChange: (() => void) | null = null;

function waitForControllerChange(timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    resolveControllerChange = () => {
      clearTimeout(timer);
      resolveControllerChange = null;
      resolve();
    };
  });
}

function onControllerChange(): void {
  if (applyPending) {
    applyPending = false;
    resolveControllerChange?.();
    return;
  }
  if (!hadController) {
    // First install claimed this page — no version changed, nothing to announce.
    hadController = true;
    return;
  }
  dispatch({ type: 'controller-elsewhere' });
}

/**
 * Wire a registration to the machine: waiting-worker adoption, `updatefound` tracking and
 * `controllerchange` handling. Returns a disposer.
 */
export function initUpdateFlow(options: {
  readonly registration: ServiceWorkerRegistration;
  readonly controller: boolean;
}): () => void {
  registration = options.registration;
  hadController = options.controller;

  // A worker already waiting (applied elsewhere is impossible; a dismissed toast from a previous
  // session or a browser-initiated download) -> the toast must come back (Decision 5 rule 4).
  if (registration.waiting !== null) dispatch({ type: 'installed-waiting' });

  const onUpdateFound = (): void => {
    const installing = registration?.installing;
    if (installing === null || installing === undefined) return;
    dispatch({ type: 'update-found' });
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed') {
        if (navigator.serviceWorker.controller !== null) {
          // Update: the new version is complete and waiting — safe to apply even offline.
          dispatch({ type: 'installed-waiting' });
        } else {
          // First install: `clients.claim()` takes over quietly, nothing to update.
          dispatch({ type: 'installed-first' });
        }
      } else if (installing.state === 'redundant') {
        dispatch({ type: 'worker-redundant' });
      }
    });
  };
  registration.addEventListener('updatefound', onUpdateFound);
  navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

  return () => {
    registration?.removeEventListener('updatefound', onUpdateFound);
    navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    registration = null;
    resolveControllerChange = null;
  };
}

async function runFlush(): Promise<'ok' | 'save' | 'blocked'> {
  if (flusher === null) return 'blocked'; // Decision 7: never reload over unflushable content
  try {
    const outcome = await flusher();
    return outcome.ok ? 'ok' : 'save';
  } catch {
    return 'save';
  }
}

export type ApplyResult = 'reloaded' | 'save-failed' | 'unsupported';

/**
 * THE single flush-then-reload call site (Decision 7 rule 1) — used by the toast's Apply button
 * and the explicit Refresh button of the `applied-elsewhere` notice. Never called automatically.
 *
 * Sequence: flush the in-flight edit (abort on failure) -> `SKIP_WAITING` (the single
 * `skipWaiting()` trigger) -> wait for `controllerchange` -> the ONE `location.reload()`.
 */
export async function applyUpdate(): Promise<ApplyResult> {
  const origin = updateState.value === 'applied-elsewhere' ? 'applied-elsewhere' : 'update-ready';
  const hasEdit = editInFlight.value;
  const openedWith = registration;

  dispatch({ type: 'apply-requested', editInFlight: hasEdit, origin });
  if (hasEdit) {
    const flushed = await runFlush();
    if (flushed !== 'ok') {
      dispatch({ type: 'flush-failed', flavor: flushed, returnTo: origin });
      return 'save-failed';
    }
    markEditPersisted();
    dispatch({ type: 'flush-ok' });
  }

  applyPending = true;
  const waiting = openedWith?.waiting ?? null;
  if (waiting !== null) {
    waiting.postMessage(SKIP_WAITING_MESSAGE);
    await waitForControllerChange();
  }
  dispatch({ type: 'controller-ours' }); // -> 'reloading', effect 'reload'
  // The only `location.reload()` in the codebase (lint-restricted to this module).
  location.reload();
  return 'reloaded';
}

/** Snooze the toast for this session (Decision 5 rule 4). A new waiting version re-toasts. */
export function dismissUpdate(): void {
  dispatch({ type: 'dismiss' });
}

// ---------------------------------------------------------------------------------------------
// Update checks (Decisions 5 rule 1 and 6)
// ---------------------------------------------------------------------------------------------

export const CHECK_INTERVAL_MS = 30 * 60 * 1000;
export const CHECK_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

let lastCheckAt = 0;
let consecutiveFailures = 0;

/** Throttle window: 30 min, doubling on consecutive failures, capped at 24 h (Decision 6). */
export function checkIntervalMs(): number {
  return Math.min(CHECK_INTERVAL_MS * 2 ** consecutiveFailures, CHECK_BACKOFF_MAX_MS);
}

/**
 * Run a throttled update check. Failsures are SILENT (Decision 6): no toast, no error UI —
 * offline is the app's normal mode. Never checks while offline.
 *
 * @returns whether a check actually ran.
 */
export async function checkForUpdate(options: { readonly force?: boolean } = {}): Promise<boolean> {
  if (registration === null) return false;
  if (!navigator.onLine) return false;

  const now = Date.now();
  if (options.force !== true && now - lastCheckAt < checkIntervalMs()) return false;
  lastCheckAt = now;

  dispatch({ type: 'check-started' });
  try {
    await registration.update();
    consecutiveFailures = 0;
    dispatch({ type: 'check-completed' });
  } catch {
    consecutiveFailures += 1;
    dispatch({ type: 'check-failed' }); // silent: no UI change, retry per Decision 6
  }
  return true;
}
