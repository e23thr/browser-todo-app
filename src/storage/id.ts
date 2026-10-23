/**
 * ULID generation (ADR-002 Decision 4.1) — self-contained, zero dependencies.
 *
 * 26-char uppercase Crockford base32: 10 chars of 48-bit ms timestamp + 16 chars
 * (80 bits) of randomness. Monotonic within a millisecond: same-ms generation
 * increments the random component, so ids minted together sort in creation order.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const MAX_TIME = 281474976710655; // 2^48 - 1

let lastTime = -1;
const lastRandom: number[] = new Array<number>(RANDOM_LEN).fill(0);

function randomDigits(): number[] {
  const digits = new Array<number>(RANDOM_LEN);
  const bytes = new Uint8Array(RANDOM_LEN);
  globalThis.crypto.getRandomValues(bytes);
  for (let i = 0; i < RANDOM_LEN; i += 1) {
    // Bounds are fixed (i < RANDOM_LEN === bytes.length), so indexing is safe;
    // the cast avoids untestable defensive branches under noUncheckedIndexedAccess.
    digits[i] = (bytes[i] as number) % 32;
  }
  return digits;
}

function incrementRandom(): boolean {
  for (let i = RANDOM_LEN - 1; i >= 0; i -= 1) {
    const d = lastRandom[i] as number;
    if (d < 31) {
      lastRandom[i] = d + 1;
      return true;
    }
    lastRandom[i] = 0;
  }
  return false; // overflow
}

function encodeTime(ms: number): string {
  let out = '';
  let t = ms;
  for (let i = 0; i < TIME_LEN; i += 1) {
    out = (CROCKFORD[t % 32] as string) + out;
    t = Math.floor(t / 32);
  }
  return out;
}

export function isUlid(value: unknown): value is string {
  return typeof value === 'string' && ULID_RE.test(value);
}

/**
 * Mint a new ULID. `now` is injectable (`() => number` clock discipline, ADR-002
 * Decision 5) and defaults to `Date.now()`.
 */
export function newUlid(now: number = Date.now()): string {
  const time = Math.max(Math.floor(now), lastTime);
  if (time === lastTime) {
    if (!incrementRandom()) {
      // Random component exhausted within the same ms: bump the encoded time.
      lastTime = time + 1;
      for (let i = 0; i < RANDOM_LEN; i += 1) lastRandom[i] = 0;
    }
  } else {
    lastTime = time;
    const digits = randomDigits();
    for (let i = 0; i < RANDOM_LEN; i += 1) lastRandom[i] = digits[i] ?? 0;
  }
  if (lastTime > MAX_TIME) throw new RangeError('ULID timestamp overflow');
  let out = encodeTime(lastTime);
  for (let i = 0; i < RANDOM_LEN; i += 1) {
    out += CROCKFORD[lastRandom[i] as number] as string;
  }
  return out;
}

/** Test seam: reset monotonic state between test cases. */
export function resetUlidStateForTests(): void {
  lastTime = -1;
  for (let i = 0; i < RANDOM_LEN; i += 1) lastRandom[i] = 0;
}
