/**
 * Shared dialog shell (`src/components/Dialog.tsx`) — focus-restore contract (§9.6).
 *
 * Pins QA defect D1 (found by t_b3280190 against 595c1f0, fixed on t_46fc5a3c): the
 * unmount cleanup used to restore focus to the opener UNCONDITIONALLY, stealing it
 * back from a newer focus target — the palette's "Add a task" focuses the composer
 * synchronously and the cleanup then yanked focus to the opener (the view heading),
 * making the command a no-op from any non-composer keyboard state.
 *
 * Standard dialog semantics: focus returns to the opener only while focus still
 * belongs to the closing panel (or left the document with it). Anything newer wins.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/preact';

import { Dialog } from '../../src/components/Dialog';

/** Stand-in for a dialog trigger, e.g. the view h1 or a task row. */
function mountOpener(): HTMLButtonElement {
  const opener = document.createElement('button');
  opener.type = 'button';
  opener.textContent = 'opener';
  document.body.append(opener);
  opener.focus();
  return opener;
}

describe('Dialog focus return (shared shell)', () => {
  it('returns focus to the opener when the dialog closes with focus inside', () => {
    const opener = mountOpener();
    const view = render(
      <Dialog title="Confirm" onClose={() => undefined}>
        <button type="button" data-autofocus="">
          inside
        </button>
      </Dialog>,
    );
    // Initial focus moved into the dialog (data-autofocus).
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'inside' }));

    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('never steals focus back from a newer focus target (D1 pin)', () => {
    const opener = mountOpener();
    const capture = document.createElement('input');
    document.body.append(capture);

    const view = render(
      <Dialog title="Confirm" onClose={() => undefined}>
        <button type="button" data-autofocus="">
          inside
        </button>
      </Dialog>,
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'inside' }));

    // The closing action moved focus somewhere newer first — exactly what the
    // palette's "Add a task" does with the composer title before unmounting.
    capture.focus();
    view.unmount();

    expect(document.activeElement).toBe(capture);
    capture.remove();
    opener.remove();
  });
});
