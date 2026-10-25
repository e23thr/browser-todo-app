/** Shared domain-test fixtures (ADR-002 shapes with deterministic stamps). */
import type { List, Settings, Task } from '../../../src/domain/model';

export const T0 = 1_700_000_000_000;

let seq = 0;
export function id(prefix = 'T'): string {
  seq += 1;
  // Valid ULID shape (26 chars, Crockford alphabet) with a deterministic body.
  return `${prefix}${String(seq).padStart(26 - prefix.length, '0')}`.slice(0, 26);
}

export function resetIds(): void {
  seq = 0;
}

export function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: id('A'),
    listId: id('L'),
    title: 'Write tests',
    notes: null,
    status: 'open',
    priority: 'P3',
    tags: [],
    sortOrder: 'h',
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
    deviceId: id('D'),
    ...over,
  };
}

export function makeList(over: Partial<List> = {}): List {
  return {
    id: id('L'),
    name: 'Inbox',
    color: '#336699',
    sortOrder: 'h',
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
    deviceId: id('D'),
    ...over,
  };
}

export function makeSettings(over: Partial<Settings> = {}): Settings {
  return {
    id: 'settings',
    theme: 'system',
    locale: 'en',
    weekStart: 1,
    defaultListId: null,
    notificationsEnabled: false,
    lastBackupAt: null,
    ...over,
  };
}
