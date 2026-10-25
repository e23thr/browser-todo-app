/**
 * Shortcuts help dialog (V1 S8 discoverability requirement).
 *
 * The map is rendered STRAIGHT from `keymap.SHORTCUTS` (single source of truth —
 * the unit suite pins the table), plus the widget-level keys the M6/M4 layers
 * already own (core-domain §8.2/§9.5) as documented rows. Fully keyboard
 * operable by construction: `Dialog` gives it focus trap, Escape and focus
 * return (§9.6).
 */

import type { JSX } from 'preact';

import { t } from '../../app/i18n';
import { Dialog } from '../../components/Dialog';
import { SHORTCUTS, formatCombo } from './keymap';
import { openCommandPalette } from './openers';

/** Widget-level keys owned by other layers — documented here, never rebound. */
const WIDGET_ROWS: readonly { readonly labelKey: string; readonly comboKey: string }[] = [
  { labelKey: 'shortcuts.row.move', comboKey: 'shortcuts.row.move.combo' },
  { labelKey: 'shortcuts.row.topBottom', comboKey: 'shortcuts.row.topBottom.combo' },
  { labelKey: 'shortcuts.row.save', comboKey: 'shortcuts.row.save.combo' },
  { labelKey: 'shortcuts.row.close', comboKey: 'shortcuts.row.close.combo' },
];

export interface ShortcutsHelpDialogProps {
  readonly onClose: () => void;
}

export function ShortcutsHelpDialog({ onClose }: ShortcutsHelpDialogProps): JSX.Element {
  return (
    <Dialog title={t('shortcuts.title')} panelClass="shortcuts-help" onClose={onClose}>
      <p class="shortcuts-intro">{t('shortcuts.intro')}</p>

      <h3 class="shortcuts-group">{t('shortcuts.group.global')}</h3>
      <ul class="shortcut-list" data-testid="shortcut-map">
        {SHORTCUTS.map((binding) => (
          <li class="shortcut-row" key={binding.id} data-shortcut-id={binding.id}>
            <span class="shortcut-label">{t(binding.labelKey)}</span>
            <kbd class="shortcut-combo">{formatCombo(binding.combo)}</kbd>
            <span class="shortcut-desc">{t(binding.descriptionKey)}</span>
          </li>
        ))}
      </ul>

      <h3 class="shortcuts-group">{t('shortcuts.group.lists')}</h3>
      <ul class="shortcut-list">
        {WIDGET_ROWS.map((row) => (
          <li class="shortcut-row" key={row.labelKey}>
            <span class="shortcut-label">{t(row.labelKey)}</span>
            <kbd class="shortcut-combo">{t(row.comboKey)}</kbd>
          </li>
        ))}
      </ul>

      <p class="shortcuts-note">{t('shortcuts.note.textFields')}</p>

      <div class="shortcuts-actions">
        <button
          type="button"
          class="button button-primary"
          onClick={() => {
            onClose();
            openCommandPalette();
          }}
        >
          {t('shortcuts.openPalette')}
        </button>
        <button type="button" class="button button-secondary" onClick={onClose}>
          {t('shortcuts.close')}
        </button>
      </div>
    </Dialog>
  );
}
