/**
 * Shared harness for the core-UI component suites.
 *
 * `seed()` builds a real `MutationRunner` over in-memory ports (fixtures.ts), loads it
 * and binds it to the task store, so every suite drives the production optimistic
 * pipeline without IndexedDB. `regions` mounts the two global live regions for
 * announcement assertions (announce() is a silent no-op without them).
 */

import { bindRunnerForTest, resetTaskStore } from '../../src/features/tasks/store';
import { clearToasts } from '../../src/features/tasks/toasts';
import {
  makeList,
  makeTask,
  makeTestRunner,
  mountLiveRegions,
  stubWideViewport,
  type TestRunner,
} from './fixtures';

export { makeList, makeTask, makeTestRunner, stubWideViewport };
export type { TestRunner };

type Mounted = ReturnType<typeof mountLiveRegions>;

let mounted: Mounted | null = null;

/** The mounted live regions (announcements land after the 60 ms region delay). */
export const regions = {
  get polite(): HTMLElement | null {
    return mounted?.polite ?? null;
  },
  get assertive(): HTMLElement | null {
    return mounted?.assertive ?? null;
  },
};

/** Reset the store signals + toasts and mount fresh live regions. */
export function setUpCoreUi(): void {
  resetTaskStore();
  clearToasts();
  mounted?.dispose();
  mounted = mountLiveRegions();
}

export function tearDownCoreUi(): void {
  mounted?.dispose();
  mounted = null;
}

/** Bind a freshly loaded in-memory runner to the store. State is ready on return. */
export async function seed(input: {
  tasks?: readonly import('../../src/domain/model').Task[];
  lists?: readonly import('../../src/domain/model').List[];
}): Promise<TestRunner> {
  const built = makeTestRunner(input);
  bindRunnerForTest(built.runner);
  const loaded = await built.runner.load();
  if (!loaded.ok) throw new Error('seed load failed');
  return built;
}
