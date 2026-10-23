/**
 * Minimal typed re-exports for validate tests (fixtures module pulls in the
 * fake-indexeddb environment; keep this one pure).
 */
import { newUlid } from '../../../src/storage/id';

export const newUlidSafe = (): string => newUlid();

export { makeList, makeMeta, makeSettings, makeSnapshot, makeTask } from './fixtures';
