/**
 * S10 File System Access primitives (§9.4): feature detection, the gesture-safe
 * pickers, dismissal-as-cancel, and the write helper. Every global is installed
 * and removed around each test — jsdom ships no FSA APIs, so the "absent" path
 * is the natural one and the "present" path is explicit.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  openPickedFile,
  pickSaveFile,
  supportsFsaOpen,
  supportsFsaSave,
  writeTextToHandle,
  type FsaFileHandle,
} from '../../../src/portability/fsa';

type Globals = { showSaveFilePicker?: unknown; showOpenFilePicker?: unknown };
const g = globalThis as Globals;

function abortError(): Error {
  const e = new Error('The user aborted a request.');
  e.name = 'AbortError';
  return e;
}

afterEach(() => {
  delete g.showSaveFilePicker;
  delete g.showOpenFilePicker;
});

describe('feature detection', () => {
  it('reports unsupported when the globals are absent (Safari/Firefox)', () => {
    expect(supportsFsaSave()).toBe(false);
    expect(supportsFsaOpen()).toBe(false);
  });

  it('reports supported when the globals exist (Chromium)', () => {
    g.showSaveFilePicker = (): Promise<never> => Promise.reject(abortError());
    g.showOpenFilePicker = (): Promise<never> => Promise.reject(abortError());
    expect(supportsFsaSave()).toBe(true);
    expect(supportsFsaOpen()).toBe(true);
  });
});

describe('pickSaveFile', () => {
  it('returns the handle and passes the suggested name and extension types', async () => {
    const handle = { name: 'backup.json', createWritable: vi.fn() };
    const api = vi.fn(async () => handle);
    g.showSaveFilePicker = api;

    const outcome = await pickSaveFile({ suggestedName: 'backup.json', extensions: ['.json'] });
    expect(outcome).toEqual({ status: 'picked', value: handle });
    expect(api).toHaveBeenCalledWith({
      suggestedName: 'backup.json',
      types: [{ accept: { 'application/json': ['.json'] } }],
    });
  });

  it('treats AbortError (user closed the dialog) as a cancel, not an error', async () => {
    g.showSaveFilePicker = (): Promise<never> => Promise.reject(abortError());
    const outcome = await pickSaveFile({ suggestedName: 'a.json', extensions: ['.json'] });
    expect(outcome.status).toBe('dismissed');
  });

  it('surfaces any other rejection as a typed error', async () => {
    g.showSaveFilePicker = (): Promise<never> => Promise.reject(new Error('no disk'));
    const outcome = await pickSaveFile({ suggestedName: 'a.json', extensions: ['.json'] });
    expect(outcome).toEqual({ status: 'error', message: 'no disk' });
  });

  it('reports unsupported when the picker is missing', async () => {
    const outcome = await pickSaveFile({ suggestedName: 'a.json', extensions: ['.json'] });
    expect(outcome.status).toBe('error');
  });
});

describe('writeTextToHandle', () => {
  const text = '{"format":"local-first-todo-backup"}';

  it('writes and closes the stream', async () => {
    const write = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const handle = { createWritable: async () => ({ write, close }) } as unknown as FsaFileHandle;
    await expect(writeTextToHandle(handle, text)).resolves.toBe(true);
    expect(write).toHaveBeenCalledWith(text);
    expect(close).toHaveBeenCalledOnce();
  });

  it('returns false when the write fails (caller falls back to download)', async () => {
    const handle = {
      createWritable: async () => ({
        write: vi.fn(async () => Promise.reject(new Error('disk full'))),
        close: vi.fn(async () => undefined),
      }),
    } as unknown as FsaFileHandle;
    await expect(writeTextToHandle(handle, text)).resolves.toBe(false);
  });

  it('returns false when the stream cannot even be opened', async () => {
    const handle = {
      createWritable: () => Promise.reject(new Error('locked')),
    } as unknown as FsaFileHandle;
    await expect(writeTextToHandle(handle, text)).resolves.toBe(false);
  });
});

describe('openPickedFile', () => {
  const extensions = ['.json', '.txt', '.csv'];

  it('returns the picked File and passes the extension filter', async () => {
    const file = { name: 'todo.txt' } as unknown as File;
    const api = vi.fn(async () => [{ getFile: async () => file }]);
    g.showOpenFilePicker = api;

    const outcome = await openPickedFile({ extensions });
    expect(outcome).toEqual({ status: 'picked', value: file });
    expect(api).toHaveBeenCalledWith({
      multiple: false,
      types: [{ accept: { 'application/json': ['.json', '.txt', '.csv'] } }],
    });
  });

  it('treats a cancelled dialog as a cancel', async () => {
    g.showOpenFilePicker = (): Promise<never> => Promise.reject(abortError());
    expect((await openPickedFile({ extensions })).status).toBe('dismissed');
  });

  it('treats an empty handle list as a cancel', async () => {
    g.showOpenFilePicker = async (): Promise<never[]> => [];
    expect((await openPickedFile({ extensions })).status).toBe('dismissed');
  });

  it('surfaces other rejections as typed errors (caller falls back to upload)', async () => {
    g.showOpenFilePicker = (): Promise<never> => Promise.reject(new Error('not allowed'));
    expect(await openPickedFile({ extensions })).toEqual({
      status: 'error',
      message: 'not allowed',
    });
  });
});
