/**
 * List options — the shell's mount point for list data (design §4.1 sidebar/drawer, §4.9
 * default-list setting).
 *
 * The domain layer and the core-UI card land after this shell, so the shell reads list data
 * from this store instead of importing IndexedDB or repositories itself. Whoever wires the
 * domain calls `setListOptions()` once (and again whenever lists change); until then the shell
 * renders its documented empty state ("No lists yet").
 */

import { signal } from '@preact/signals';

/** The only list fields the shell needs: link target + label (+ select option text). */
export interface ListOption {
  readonly id: string;
  readonly name: string;
}

const listOptions = signal<readonly ListOption[]>([]);

/** Replace the shell's view of the lists (id order = display order). */
export function setListOptions(next: readonly ListOption[]): void {
  listOptions.value = next.slice();
}

/**
 * Sidebar drop-target highlight while a task drag is in flight (design §8.1
 * "desktop extra"). The drag layer (`features/tasks`) writes the list currently
 * hovered; the shell's list links read the signal to render the highlight. `null`
 * = no drag / not over a list.
 */
const dropHoverListId = signal<string | null>(null);

export function setDropHoverListId(id: string | null): void {
  dropHoverListId.value = id;
}

export function useDropHoverListId(): string | null {
  return dropHoverListId.value;
}

/** Non-reactive read (tests, drag layer). */
export function getDropHoverListId(): string | null {
  return dropHoverListId.value;
}

/** Current options (non-reactive read; components should use `useListOptions`). */
export function getListOptions(): readonly ListOption[] {
  return listOptions.value;
}

/** Reactive accessor — reading the signal inside render re-renders the component on change. */
export function useListOptions(): readonly ListOption[] {
  return listOptions.value;
}
