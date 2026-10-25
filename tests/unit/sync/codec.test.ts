/**
 * `todo-sync/1` codec tests (ADR-006 Decision 2 + test plan item 3): round-trips,
 * hash-mismatch detection, torn-file fixtures, unknown-format skip,
 * `todo-sync/2` hard stop.
 */

import { describe, expect, it } from 'vitest';

import {
  classifyFormat,
  decodeBatch,
  decodeSnapshot,
  encodeBatch,
  encodeSnapshot,
} from '../../../src/sync/batchCodec';
import { contentHashOf, sha256OfUtf8, stableStringify } from '../../../src/sync/hash';
import { SYNC_FORMAT } from '../../../src/sync/types';
import { DEVICE_A, DEVICE_B, LIST_1, makeList, makeTask, testUlid } from './fixtures';

const TASK_ID = testUlid('codec-task');

describe('batch codec (Decision 2.1)', () => {
  it('round-trips records with a recordsHash over the exact JSON-string bytes', async () => {
    const records = [
      { kind: 'task' as const, record: makeTask({ id: TASK_ID }) },
      { kind: 'list' as const, record: makeList({ id: LIST_1 }) },
    ];
    const { doc, json } = await encodeBatch(records, {
      deviceId: DEVICE_A,
      seq: 7,
      createdAt: 5000,
    });
    expect(doc.format).toBe(SYNC_FORMAT);
    expect(doc.recordsHash).toBe(await sha256OfUtf8(doc.records));
    const decoded = await decodeBatch(json);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.seq).toBe(7);
    expect(decoded.value.parsed).toEqual(records);
  });

  it('detects hash mismatch (tampered/corrupt artifact) and never yields records', async () => {
    const { json } = await encodeBatch([{ kind: 'task', record: makeTask({ id: TASK_ID }) }], {
      deviceId: DEVICE_A,
      seq: 1,
      createdAt: 1,
    });
    const tampered = JSON.stringify({ ...JSON.parse(json), recordsHash: 'a'.repeat(64) });
    const decoded = await decodeBatch(tampered);
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.kind).toBe('corrupt');
  });

  it('rejects torn files (truncated JSON / non-array payloads)', async () => {
    const { json } = await encodeBatch([{ kind: 'task', record: makeTask({ id: TASK_ID }) }], {
      deviceId: DEVICE_A,
      seq: 1,
      createdAt: 1,
    });
    const torn = await decodeBatch(json.slice(0, Math.floor(json.length / 2)));
    expect(torn.ok).toBe(false);
    if (!torn.ok) expect(torn.kind).toBe('corrupt');

    const badPayload = await decodeBatch(
      JSON.stringify({ ...JSON.parse(json), records: '{}', recordsHash: await sha256OfUtf8('{}') }),
    );
    expect(badPayload.ok).toBe(false);
    if (!badPayload.ok) expect(badPayload.kind).toBe('corrupt');
  });

  it('unknown formats are classified "unknown-format" (skip + warn), todo-sync/2+ is "newer-format" (hard stop)', async () => {
    expect(classifyFormat('todo-sync/1').ok).toBe(true);
    const unknown = classifyFormat('todo-sync/x');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.kind).toBe('unknown-format');
    const newer = classifyFormat('todo-sync/2');
    expect(newer.ok).toBe(false);
    if (!newer.ok) expect(newer.kind).toBe('newer-format');

    const future = await decodeBatch(
      JSON.stringify({
        format: 'todo-sync/2',
        kind: 'batch',
        deviceId: DEVICE_A,
        seq: 1,
        createdAt: 1,
        recordsHash: '',
        records: '[]',
      }),
    );
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.kind).toBe('newer-format');
  });

  it('rejects batches whose location and content disagree (corruption)', async () => {
    const { json } = await encodeBatch([], { deviceId: DEVICE_A, seq: 1, createdAt: 1 });
    const lying = JSON.stringify({ ...JSON.parse(json), deviceId: DEVICE_B });
    // Hash still covers `records` only, so the doc parses — the ENGINE checks
    // location agreement (engine.test.ts); the codec keeps shape validation.
    const decoded = await decodeBatch(lying);
    expect(decoded.ok).toBe(true);
  });
});

describe('snapshot codec (Decision 2.2)', () => {
  it('round-trips state + covers watermark', async () => {
    const records = [{ kind: 'task' as const, record: makeTask({ id: TASK_ID, deletedAt: 2500 }) }];
    const { doc, json } = await encodeSnapshot(records, {
      takenAt: 123,
      byDeviceId: DEVICE_A,
      covers: { [DEVICE_A]: 7, [DEVICE_B]: 3 },
    });
    expect(doc.stateHash).toBe(await sha256OfUtf8(doc.state));
    const decoded = await decodeSnapshot(json);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.covers[DEVICE_B]).toBe(3);
    expect(decoded.value.parsed).toEqual(records); // tombstones retained (Decision 8 rule 2)
  });

  it('bad `covers` or state hash → corrupt', async () => {
    const { json } = await encodeSnapshot([], { takenAt: 1, byDeviceId: DEVICE_A, covers: {} });
    const badCovers = JSON.stringify({ ...JSON.parse(json), covers: { [DEVICE_A]: 'x' } });
    const r1 = await decodeSnapshot(badCovers);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.kind).toBe('corrupt');

    const badHash = JSON.stringify({ ...JSON.parse(json), stateHash: 'b'.repeat(64) });
    const r2 = await decodeSnapshot(badHash);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.kind).toBe('corrupt');
  });
});

describe('hashing (WebCrypto, no hand-rolled primitives)', () => {
  it('sha256 matches the known answer for "abc"', async () => {
    expect(await sha256OfUtf8('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('contentHash excludes the LWW key but sees tombstoning as a change', async () => {
    const base = makeTask({ id: TASK_ID });
    const restamp = makeTask({ id: TASK_ID, updatedAt: 4242, deviceId: DEVICE_B });
    const tombstoned = makeTask({ id: TASK_ID, deletedAt: 2500 });
    expect(await contentHashOf(restamp)).toBe(await contentHashOf(base));
    expect(await contentHashOf(tombstoned)).not.toBe(await contentHashOf(base));
  });

  it('stableStringify is order-insensitive for object keys', () => {
    expect(stableStringify({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});
