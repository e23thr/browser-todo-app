import { afterEach, describe, expect, it, vi } from 'vitest';

import { getListOptions, setListOptions, type ListOption } from '../../src/app/lists';
import { registerQuickAddHandler, requestQuickAdd, startQuickAdd } from '../../src/app/quickAdd';

afterEach(() => {
  registerQuickAddHandler(null);
  setListOptions([]);
  window.history.replaceState(null, '', '/');
});

describe('quick-add seam (design §4.1 FAB / §6.8 composer)', () => {
  it('reports that nothing handled the request before a composer registers', () => {
    expect(requestQuickAdd()).toBe(false);
  });

  it('routes the request to the registered handler and back to null on dispose', () => {
    const handler = vi.fn();
    const dispose = registerQuickAddHandler(handler);

    expect(requestQuickAdd()).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);

    dispose();
    expect(requestQuickAdd()).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('falls back to the capture view when no composer is registered yet', () => {
    startQuickAdd();
    expect(window.location.hash).toBe('#/today');
  });

  it('does not navigate away from the capture view when a composer IS registered', () => {
    const handler = vi.fn();
    registerQuickAddHandler(handler);
    window.location.hash = '#/week';

    startQuickAdd();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe('#/week');
  });
});

describe('list-options mount point (design §4.1 sidebar/drawer, §4.9 default list)', () => {
  it('starts empty and reflects whatever the domain layer supplies', () => {
    expect(getListOptions()).toEqual([]);

    const lists: readonly ListOption[] = [
      { id: '01JBX000000000000000000001', name: 'Personal' },
      { id: '01JBX000000000000000000002', name: 'Work' },
    ];
    setListOptions(lists);

    expect(getListOptions().map((list) => list.name)).toEqual(['Personal', 'Work']);
  });

  it("copies the caller's array so later mutations cannot rewrite the store", () => {
    const lists: ListOption[] = [{ id: '01JBX000000000000000000001', name: 'Personal' }];
    setListOptions(lists);
    lists.push({ id: '01JBX000000000000000000002', name: 'Work' });

    expect(getListOptions()).toHaveLength(1);
  });
});
