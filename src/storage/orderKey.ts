/**
 * Base-36 fractional order keys (ADR-002 Decision 4.2) — pure, dependency-free.
 *
 * A key is a non-empty string over `0-9a-z`, canonical form: never ends in `'0'`,
 * hard-capped at 32 characters. Comparison is plain ordinal string comparison,
 * which on canonical keys equals numeric comparison of the base-36 fraction
 * `0.d1d2…dn`. Sibling-group ordering always tie-breaks by record id.
 *
 * `orderKeyBetween` throws `OrderKeyError` only for programmer errors (invalid
 * input) or when no midpoint fits the 32-char cap (`code: 'EXHAUSTED'` — the
 * caller's rebalance hatch, ADR-002 §4.2 rule 4).
 */

export const ORDER_KEY_MAX = 32;
export const ORDER_KEY_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const FIRST_KEY = 'h'; // middle of the alphabet: headroom both ways

export type OrderKeyErrorCode = 'INVALID_INPUT' | 'EXHAUSTED';

export class OrderKeyError extends Error {
  readonly code: OrderKeyErrorCode;
  constructor(code: OrderKeyErrorCode, message: string) {
    super(message);
    this.name = 'OrderKeyError';
    this.code = code;
  }
}

function digitAt(key: string, i: number): number {
  const ch = key[i];
  if (ch === undefined) return 0; // conceptually zero-padded
  return ORDER_KEY_ALPHABET.indexOf(ch);
}

export function isCanonicalOrderKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length === 0 || key.length > ORDER_KEY_MAX) return false;
  if (key.endsWith('0')) return false;
  for (const ch of key) {
    if (!ORDER_KEY_ALPHABET.includes(ch)) return false;
  }
  return true;
}

function mustBeCanonical(key: string | null, label: string): void {
  if (key !== null && !isCanonicalOrderKey(key)) {
    throw new OrderKeyError('INVALID_INPUT', `${label} is not a canonical order key: ${JSON.stringify(key)}`);
  }
}

function finish(result: string): string {
  // Strip accidental trailing zeros (canonicity), then enforce the cap.
  let out = result.replace(/0+$/u, '');
  if (out.length === 0) {
    // Degenerate: result was all zeros. One step above zero keeps canonicity.
    out = '0h';
  }
  if (out.length > ORDER_KEY_MAX) {
    throw new OrderKeyError('EXHAUSTED', `no midpoint within ${String(ORDER_KEY_MAX)} chars (rebalance required)`);
  }
  return out;
}

/**
 * Midpoint `m` with `(a ?? -∞) < m < (b ?? +∞)`. Near the arithmetic middle as
 * digit alignment allows, so key length grows ~log₂ of adjacent insertions.
 */
export function orderKeyBetween(a: string | null, b: string | null): string {
  mustBeCanonical(a, 'a');
  mustBeCanonical(b, 'b');
  if (a !== null && b !== null && a >= b) {
    throw new OrderKeyError('INVALID_INPUT', `a must be < b (got ${JSON.stringify(a)} >= ${JSON.stringify(b)})`);
  }
  if (a === null && b === null) return FIRST_KEY;
  if (b === null) {
    // After the last key: appending one digit is always strictly greater.
    return finish((a as string) + FIRST_KEY);
  }

  // Digit scan with implicit zero-padding of the lower bound ('' when a is null).
  const lower = a ?? '';
  let result = '';
  const scanLen = Math.max(lower.length, b.length) + 1;
  for (let i = 0; i < scanLen; i += 1) {
    const ca = digitAt(lower, i);
    const cb = digitAt(b, i);
    const diff = cb - ca;
    if (diff >= 2) {
      const mid = ca + Math.floor(diff / 2);
      return finish(result + (ORDER_KEY_ALPHABET[mid] as string) + FIRST_KEY);
    }
    if (diff === 1) {
      // Take ca; any tail > lower's tail keeps m > a, and m < b holds because
      // the digit is below cb. The simplest such tail is lower's tail + 'h'.
      return finish(result + (ORDER_KEY_ALPHABET[ca] as string) + lower.slice(i + 1) + FIRST_KEY);
    }
    // diff === 0 (or diff < 0 padding edge): copy the shared digit and continue.
    if (i >= lower.length && i >= b.length) break;
    result += ORDER_KEY_ALPHABET[ca] as string;
  }
  throw new OrderKeyError('INVALID_INPUT', 'no midpoint exists between identical keys');
}

export function orderKeyFirst(): string {
  return orderKeyBetween(null, null);
}

export function orderKeyAfter(a: string): string {
  return orderKeyBetween(a, null);
}

export function orderKeyBefore(b: string): string {
  return orderKeyBetween(null, b);
}
