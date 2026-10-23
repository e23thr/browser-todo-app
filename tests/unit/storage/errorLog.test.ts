/** Structured local error log (ADR-002 §10.4): JSON ring buffer, downloadable, no telemetry. */
import { describe, expect, it } from 'vitest';

import { createErrorLog, defaultErrorLog, logAppError } from '../../../src/storage/errorLog';

describe('errorLog: ring buffer', () => {
  it('records entries with timestamps and lists them in order', () => {
    let now = 1000;
    const log = createErrorLog({ now: () => now });
    log.record({ layer: 'repos', op: 'patch', error: { code: 'UNKNOWN' } });
    now = 2000;
    log.record({ layer: 'domain', op: 'move', error: { code: 'RULE' }, detail: 'x' });
    const entries = log.list();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ at: 1000, layer: 'repos', op: 'patch' });
    expect(entries[1]).toMatchObject({ at: 2000, detail: 'x' });
  });

  it('caps at capacity (oldest dropped first)', () => {
    const log = createErrorLog({ capacity: 3, now: () => 0 });
    for (let i = 0; i < 5; i += 1) {
      log.record({ layer: 'storage', op: `op-${String(i)}`, error: { code: 'UNKNOWN' } });
    }
    expect(log.list().map((e) => e.op)).toEqual(['op-2', 'op-3', 'op-4']);
  });

  it('clear() empties the buffer', () => {
    const log = createErrorLog();
    log.record({ layer: 'storage', op: 'x', error: { code: 'UNKNOWN' } });
    log.clear();
    expect(log.list()).toEqual([]);
  });

  it('download() produces loadable JSON with every entry verbatim', () => {
    let now = Date.UTC(2026, 9, 23, 12, 0, 0);
    const log = createErrorLog({ now: () => now });
    log.record({
      layer: 'repos',
      op: 'reorder-rebalance',
      error: { code: 'UNKNOWN', cause: 'boom' },
    });
    const file = log.download();
    expect(file.filename).toMatch(/^local-first-todo-errors-.*\.json$/u);
    const parsed = JSON.parse(file.json) as { format: string; entries: unknown[] };
    expect(parsed.format).toBe('local-first-todo-errors');
    expect(parsed.entries).toHaveLength(1);
    now += 1;
  });

  it('logAppError forwards typed errors and is a no-op without a log', () => {
    const log = createErrorLog();
    logAppError(log, 'repos', 'create', { code: 'QUOTA_EXCEEDED' }, 'detail');
    expect(log.list()[0]).toMatchObject({ layer: 'repos', op: 'create', detail: 'detail' });
    expect(() => {
      logAppError(undefined, 'domain', 'x', { code: 'UNKNOWN' });
    }).not.toThrow();
  });

  it('defaultErrorLog is a usable module-level buffer', () => {
    defaultErrorLog.clear();
    defaultErrorLog.record({ layer: 'storage', op: 'boot', error: { code: 'UNKNOWN' } });
    expect(defaultErrorLog.list().length).toBeGreaterThanOrEqual(1);
    defaultErrorLog.clear();
  });
});
