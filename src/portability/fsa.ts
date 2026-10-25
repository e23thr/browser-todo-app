/**
 * File System Access save/open (S10, §9.4 feature detection).
 *
 * The universal path is unchanged: Blob + anchor download for saving, the
 * hidden `<input type="file">` for opening — those work on every supported
 * browser. On Chromium, `showSaveFilePicker`/`showOpenFilePicker` upgrade that
 * to "choose the exact file/location" (and overwrite in place). Safari and
 * Firefox never see dead UI: they never offer the FSA affordance because every
 * call site feature-detects through `supportsFsaSave()` / `supportsFsaOpen()`.
 *
 * Gesture rule (the reason pickers are separate from writes): both pickers may
 * only be CALLED synchronously inside a user gesture (a click handler), so
 * `pickSaveFile`/`openPickedFile` invoke the picker BEFORE their first `await`
 * and the caller does likewise. Writing to the handle happens later, after the
 * backup is serialized — the handle outlives the gesture.
 *
 * A user closing the picker dialog throws `AbortError`: that is a CANCEL, not
 * an error, and callers fall back to nothing (never to a scary message).
 * Every other failure is a typed `error` outcome and the caller falls back to
 * the universal download/upload path.
 */

/** The minimal handle surface this module uses (structural — no WICG types needed). */
export type FsaWritableHandle = {
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
};

export type FsaFileHandle = FsaWritableHandle & {
  readonly name: string;
  getFile(): Promise<File>;
};

type PickerOutcome<T> =
  | { readonly status: 'picked'; readonly value: T }
  | { readonly status: 'dismissed' }
  | { readonly status: 'error'; readonly message: string };

/** Outcome of `pickSaveFile` — picked handle, user cancel, or a typed failure. */
export type SavePickOutcome = PickerOutcome<FsaFileHandle>;
/** Outcome of `openPickedFile` — picked file, user cancel, or a typed failure. */
export type OpenPickOutcome = PickerOutcome<File>;

type FsaGlobals = {
  // `unknown` returns on purpose: the runtime shape is validated below (the
  // WICG types are not in lib.dom, and a polyfill/mocked global can lie).
  showSaveFilePicker?: (options?: Record<string, unknown>) => Promise<unknown>;
  showOpenFilePicker?: (options?: Record<string, unknown>) => Promise<unknown>;
};

function fsaGlobals(): FsaGlobals {
  return globalThis as unknown as FsaGlobals;
}

/** Chromium (and anything else exposing the save picker). §9.4 detection seam. */
export function supportsFsaSave(): boolean {
  return typeof fsaGlobals().showSaveFilePicker === 'function';
}

/** Chromium open picker. Detection seam — callers keep the upload fallback. */
export function supportsFsaOpen(): boolean {
  return typeof fsaGlobals().showOpenFilePicker === 'function';
}

/** Classify a picker rejection: AbortError = the user closed the dialog. */
function pickerError<T>(e: unknown): PickerOutcome<T> {
  const name = e instanceof Error ? e.name : '';
  if (name === 'AbortError') return { status: 'dismissed' };
  return { status: 'error', message: e instanceof Error ? e.message : String(e) };
}

export type SavePickerOptions = {
  readonly suggestedName: string;
  /** Accepted extensions, e.g. `['.json']`. */
  readonly extensions: readonly string[];
  readonly description?: string;
};

/**
 * Open the SYSTEM save dialog. Call this synchronously inside the click
 * handler that triggers the export — never after an `await`.
 */
export async function pickSaveFile(options: SavePickerOptions): Promise<SavePickOutcome> {
  const api = fsaGlobals().showSaveFilePicker;
  if (typeof api !== 'function')
    return { status: 'error', message: 'File System Access unsupported' };
  try {
    const accept: Record<string, string[]> = {};
    accept[guessMime(options.extensions)] = [...options.extensions];
    const handle: unknown = await api({
      suggestedName: options.suggestedName,
      types: [
        {
          ...(options.description === undefined ? {} : { description: options.description }),
          accept,
        },
      ],
    });
    if (
      typeof handle !== 'object' ||
      handle === null ||
      typeof (handle as Partial<FsaFileHandle>).createWritable !== 'function'
    ) {
      return { status: 'error', message: 'save picker returned no usable handle' };
    }
    return { status: 'picked', value: handle as FsaFileHandle };
  } catch (e) {
    return pickerError(e);
  }
}

/** Write the whole document to the chosen file (truncating it). */
export async function writeTextToHandle(handle: FsaFileHandle, text: string): Promise<boolean> {
  try {
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    return true;
  } catch {
    return false;
  }
}

export type OpenPickerOptions = {
  /** Accepted extensions, e.g. `['.json', '.txt', '.csv']`. */
  readonly extensions: readonly string[];
  readonly description?: string;
};

/**
 * Open the SYSTEM open dialog and return the picked file. Call synchronously
 * inside the click handler (same gesture rule as `pickSaveFile`).
 */
export async function openPickedFile(options: OpenPickerOptions): Promise<OpenPickOutcome> {
  const api = fsaGlobals().showOpenFilePicker;
  if (typeof api !== 'function')
    return { status: 'error', message: 'File System Access unsupported' };
  try {
    const accept: Record<string, string[]> = {};
    accept[guessMime(options.extensions)] = [...options.extensions];
    const result: unknown = await api({
      multiple: false,
      types: [
        {
          ...(options.description === undefined ? {} : { description: options.description }),
          accept,
        },
      ],
    });
    const handle: FsaFileHandle | undefined = Array.isArray(result)
      ? (result[0] as FsaFileHandle | undefined)
      : undefined;
    if (handle === undefined || typeof handle.getFile !== 'function') {
      return { status: 'dismissed' }; // no handle picked (empty selection)
    }
    return { status: 'picked', value: await handle.getFile() };
  } catch (e) {
    return pickerError(e);
  }
}

/** Coarse MIME for the picker dialog — the extensions do the real filtering. */
function guessMime(extensions: readonly string[]): string {
  if (extensions.includes('.json')) return 'application/json';
  if (extensions.includes('.csv')) return 'text/csv';
  return 'text/plain';
}
