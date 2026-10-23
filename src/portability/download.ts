/**
 * Download helpers (ADR-004 Decision 9): Blob + anchor `download`, user-initiated,
 * local only — a download is not a transmission (§6.1: nothing leaves the browser).
 * Feature-detected and never-throwing: a hardened environment without
 * `URL.createObjectURL` degrades to "no download happened", never a crash.
 */

/**
 * Trigger a browser download for `text`. Returns `true` when the download was
 * handed to the browser, `false` when the environment cannot (caller decides
 * what to surface).
 */
export function downloadTextFile(fileName: string, text: string): boolean {
  try {
    const urlApi = (globalThis as { URL?: typeof URL }).URL;
    const doc = (globalThis as { document?: Document }).document;
    if (
      typeof urlApi?.createObjectURL !== 'function' ||
      typeof urlApi.revokeObjectURL !== 'function' ||
      doc === undefined
    ) {
      return false;
    }
    const blob = new Blob([text], { type: 'application/json' });
    const url = urlApi.createObjectURL(blob);
    const anchor = doc.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    doc.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    urlApi.revokeObjectURL(url);
    return true;
  } catch {
    return false;
  }
}
