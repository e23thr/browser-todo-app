import { describe, expect, it } from 'vitest';

import {
  beginEdit,
  editInFlight,
  markEditPersisted,
  nextUpdate,
  startEditGuard,
  type UpdateEvent,
  type UpdateState,
} from '../../src/app/update';

/**
 * ADR-005 Decision 9 (unit): the update state machine reducer covers every transition of
 * Decision 5 — including apply-during-edit failure (Decision 7 / E9) — and can never reach the
 * single reload effect without a user-initiated apply.
 */

const STATES: readonly UpdateState[] = [
  'idle',
  'checking',
  'update-found',
  'update-ready',
  'reload-pending',
  'applying',
  'reloading',
  'check-failed',
  'applied-elsewhere',
];

function reduced(state: UpdateState, event: UpdateEvent): UpdateState {
  return nextUpdate(state, event).state;
}

describe('nextUpdate — check lifecycle (Decision 5 rules 1–3, Decision 6)', () => {
  it('runs checks only from idle/check-failed and completes back to idle', () => {
    expect(reduced('idle', { type: 'check-started' })).toBe('checking');
    expect(reduced('check-failed', { type: 'check-started' })).toBe('checking');
    expect(reduced('checking', { type: 'check-completed' })).toBe('idle');
    expect(reduced('checking', { type: 'check-failed' })).toBe('check-failed');
    // A check never clobbers a pending update or an apply in progress.
    for (const state of ['update-ready', 'reload-pending', 'applying', 'reloading'] as const) {
      expect(reduced(state, { type: 'check-started' })).toBe(state);
      expect(reduced(state, { type: 'check-completed' })).toBe(state);
      expect(reduced(state, { type: 'check-failed' })).toBe(state);
    }
  });

  it('tracks a discovered update through install to the waiting toast', () => {
    expect(reduced('checking', { type: 'update-found' })).toBe('update-found');
    expect(reduced('update-found', { type: 'installed-waiting' })).toBe('update-ready');
    expect(reduced('idle', { type: 'installed-waiting' })).toBe('update-ready');
  });

  it('treats a first install as idle — no toast when there is nothing to update', () => {
    expect(reduced('update-found', { type: 'installed-first' })).toBe('idle');
    expect(reduced('checking', { type: 'installed-first' })).toBe('idle');
    // ...but never clobbers a real update surface.
    expect(reduced('update-ready', { type: 'installed-first' })).toBe('update-ready');
  });

  it('treats a redundant worker as a silent check failure (Decision 6)', () => {
    expect(reduced('update-found', { type: 'worker-redundant' })).toBe('check-failed');
    expect(reduced('checking', { type: 'worker-redundant' })).toBe('check-failed');
    expect(reduced('update-ready', { type: 'worker-redundant' })).toBe('update-ready');
  });
});

describe('nextUpdate — user-gated apply (Decision 5 rules 4–7, Decision 7 / E9)', () => {
  it('snoozes the toast in-session on dismiss, leaving no auto-reload path', () => {
    expect(reduced('update-ready', { type: 'dismiss' })).toBe('idle');
    expect(reduced('applied-elsewhere', { type: 'dismiss' })).toBe('applied-elsewhere');
  });

  it('apply with no edit in flight goes straight to skip-waiting', () => {
    const transition = nextUpdate('update-ready', {
      type: 'apply-requested',
      editInFlight: false,
      origin: 'update-ready',
    });
    expect(transition).toEqual({ state: 'applying', effect: 'skip-waiting', error: null });
  });

  it('apply during an edit flushes first (E9: no reload over uncommitted content)', () => {
    const transition = nextUpdate('update-ready', {
      type: 'apply-requested',
      editInFlight: true,
      origin: 'update-ready',
    });
    expect(transition).toEqual({ state: 'reload-pending', effect: 'flush', error: null });

    const flushed = nextUpdate('reload-pending', { type: 'flush-ok' });
    expect(flushed).toEqual({ state: 'applying', effect: 'skip-waiting', error: null });
  });

  it('a failed flush aborts the reload and keeps the edit surface intact', () => {
    for (const flavor of ['save', 'blocked'] as const) {
      const transition = nextUpdate('reload-pending', {
        type: 'flush-failed',
        flavor,
        returnTo: 'update-ready',
      });
      expect(transition).toEqual({ state: 'update-ready', effect: 'none', error: flavor });
    }
    // Refresh from the applied-elsewhere notice returns to its own surface on failure.
    expect(
      nextUpdate('reload-pending', {
        type: 'flush-failed',
        flavor: 'blocked',
        returnTo: 'applied-elsewhere',
      }),
    ).toEqual({ state: 'applied-elsewhere', effect: 'none', error: 'blocked' });
  });

  it('the reload effect fires ONLY on our own controllerchange after apply', () => {
    expect(nextUpdate('applying', { type: 'controller-ours' })).toEqual({
      state: 'reloading',
      effect: 'reload',
      error: null,
    });
    // Every other transition in the machine must never produce the reload effect.
    const nonApplyEvents: UpdateEvent[] = [
      { type: 'check-started' },
      { type: 'check-completed' },
      { type: 'check-failed' },
      { type: 'update-found' },
      { type: 'installed-waiting' },
      { type: 'installed-first' },
      { type: 'worker-redundant' },
      { type: 'dismiss' },
      { type: 'flush-ok' },
      { type: 'flush-failed', flavor: 'save', returnTo: 'update-ready' },
      { type: 'controller-elsewhere' },
    ];
    for (const state of STATES) {
      for (const event of nonApplyEvents) {
        const transition = nextUpdate(state, event);
        expect(transition.effect).not.toBe('reload');
      }
    }
    for (const state of STATES) {
      if (state === 'applying') continue;
      expect(nextUpdate(state, { type: 'controller-ours' }).effect).not.toBe('reload');
    }
  });

  it('a sibling tab is never reloaded — controllerchange without apply announces only', () => {
    for (const state of STATES) {
      const transition = nextUpdate(state, { type: 'controller-elsewhere' });
      expect(transition.effect).not.toBe('reload');
      if (state !== 'reloading' && state !== 'applying') {
        expect(transition.state).toBe('applied-elsewhere');
      }
    }
  });

  it('apply is ignored unless the user is on an apply surface', () => {
    for (const state of ['idle', 'checking', 'update-found', 'check-failed'] as const) {
      const transition = nextUpdate(state, {
        type: 'apply-requested',
        editInFlight: true,
        origin: 'update-ready',
      });
      expect(transition).toEqual({ state, effect: 'none', error: null });
    }
  });
});

describe('edit tracking (Decision 7)', () => {
  it('exposes edit-in-flight through the explicit begin/persist lifecycle', () => {
    expect(editInFlight.value).toBe(false);
    beginEdit();
    expect(editInFlight.value).toBe(true);
    markEditPersisted();
    expect(editInFlight.value).toBe(false);
  });

  it('treats any number of open edits as one in-flight session', () => {
    beginEdit();
    beginEdit();
    markEditPersisted();
    expect(editInFlight.value).toBe(false);
  });
});

describe('edit guard — DOM dirty detection (Decision 7 `edit-begin` definition)', () => {
  it('flags a dirty editable field and clears it when the content reverts', () => {
    const dispose = startEditGuard();
    const input = document.createElement('input');
    document.body.appendChild(input);

    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    input.value = 'uncommitted text';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(editInFlight.value).toBe(true);

    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(editInFlight.value).toBe(false);

    dispose();
    input.remove();
  });

  it('ignores non-editable controls (checkboxes, buttons)', () => {
    const dispose = startEditGuard();
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    document.body.appendChild(checkbox);

    checkbox.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('input', { bubbles: true }));
    expect(editInFlight.value).toBe(false);

    dispose();
    checkbox.remove();
  });
});
