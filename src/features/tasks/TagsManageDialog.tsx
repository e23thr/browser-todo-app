/**
 * Tag management (S1): rename and delete the tags in use, one row per tag with
 * its usage count. Both actions are ONE sweep transaction under the hood
 * (`MutationRunner.renameTag` / `deleteTag` over the denormalized `tags: string[]`
 * model, ADR-002 §3.5) — renaming to an existing name MERGES the two tags.
 *
 * A11y: a real dialog (focus trap via `Dialog`), inline rename is a labelled
 * input, delete goes through the S7-style confirm, and both outcomes announce
 * politely (`a11y.tagRenamed` / `a11y.tagDeleted`).
 */

import { useState } from 'preact/hooks';
import type { JSX } from 'preact';

import { announce } from '../../app/announce';
import { t } from '../../app/i18n';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Dialog } from '../../components/Dialog';
import { isValidTagName } from './fields';
import { allTags, deleteTag, renameTag } from './store';

export interface TagsManageDialogProps {
  readonly onClose: () => void;
}

export function TagsManageDialog({ onClose }: TagsManageDialogProps): JSX.Element {
  const usage = allTags();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  const trimmed = draft.trim();
  const renameValid = renaming !== null && isValidTagName(trimmed);

  const startRename = (name: string): void => {
    setRenaming(name);
    setDraft(name);
  };

  const commitRename = (): void => {
    const from = renaming;
    if (from === null || !renameValid) return;
    setRenaming(null);
    void renameTag(from, trimmed).then((result) => {
      if (result.ok) announce(t('a11y.tagRenamed', { name: trimmed }));
    });
  };

  const footer = (
    <button type="button" class="button button-secondary" data-autofocus="" onClick={onClose}>
      {t('editor.cancel')}
    </button>
  );

  return (
    <>
      <Dialog title={t('tags.manage')} onClose={onClose} footer={footer}>
        {usage.length === 0 ? (
          <p class="dialog-text">{t('tags.empty')}</p>
        ) : (
          <ul class="tag-manage-list" aria-label={t('tags.manage')}>
            {usage.map((entry) => (
              <li key={entry.name} class="tag-manage-row">
                {renaming === entry.name ? (
                  <div class="tag-input-row">
                    <input
                      class="input"
                      type="text"
                      maxlength={100}
                      data-autofocus=""
                      aria-label={t('tags.rename')}
                      value={draft}
                      onInput={(event) => {
                        setDraft(event.currentTarget.value);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          commitRename();
                        } else if (event.key === 'Escape') {
                          event.preventDefault();
                          event.stopPropagation();
                          setRenaming(null);
                        }
                      }}
                    />
                    <button
                      type="button"
                      class="button button-primary"
                      disabled={!renameValid}
                      onClick={commitRename}
                    >
                      {t('tags.save')}
                    </button>
                  </div>
                ) : (
                  <>
                    <span class="tag-manage-name">
                      {entry.name}
                      <span class="tag-manage-count">
                        {t('tags.count', { count: entry.count })}
                      </span>
                    </span>
                    <span class="tag-manage-actions">
                      <button
                        type="button"
                        class="button button-secondary"
                        onClick={() => {
                          startRename(entry.name);
                        }}
                      >
                        {t('tags.rename')}
                      </button>
                      <button
                        type="button"
                        class="button button-danger"
                        onClick={() => {
                          setConfirmingDelete(entry.name);
                        }}
                      >
                        {t('tags.delete')}
                      </button>
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Dialog>

      {confirmingDelete !== null ? (
        <ConfirmDialog
          titleKey="confirm.deleteTag.title"
          bodyKey="confirm.deleteTag.body"
          params={{ name: confirmingDelete }}
          confirmKey="confirm.deleteTag.confirm"
          tone="danger"
          onConfirm={() => {
            const name = confirmingDelete;
            setConfirmingDelete(null);
            void deleteTag(name).then((result) => {
              if (result.ok) announce(t('a11y.tagDeleted', { name }));
            });
          }}
          onCancel={() => {
            setConfirmingDelete(null);
          }}
        />
      ) : null}
    </>
  );
}
