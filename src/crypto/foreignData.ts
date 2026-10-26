/**
 * A shell-safe signal module (same rule as `./lock.ts`: signals only, never a
 * core import chain from the app shell): set when a read encounters ciphertext
 * this device's key ring cannot open — records encrypted on another device
 * with a different key (Decision 3.3's blocked state) or tampered beyond GCM's
 * reach (Decision 9 — the two are physically indistinguishable, ADR-007 §15).
 *
 * Consumers: the data-safety banner (`crypto-blocked`) renders the blocked
 * state; CryptoSection offers the join flow. Cleared when the ring can read
 * the data again — a successful device join (Decision 3.3 heals via
 * `clearDecryptQuarantine`) or a completed disable.
 */
import { signal } from '@preact/signals';

/** `true` once unreadable ciphertext has been seen this session. */
export const foreignCiphertext = signal(false);
