/** Type surface for scripts/generate-icons.mjs (kept beside the script so tests stay typed). */

export interface IconSpec {
  readonly file: string;
  readonly size: number;
  readonly style: 'rounded' | 'full';
  readonly safe: boolean;
}

export const ICON_SPECS: readonly IconSpec[];

export function encodePng(size: number, rgba: Buffer): Buffer;

export function drawIcon(spec: IconSpec): Buffer;

export function generateIcons(outDir: string): { readonly file: string; readonly bytes: Buffer }[];
