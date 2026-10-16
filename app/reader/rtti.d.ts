// Hand-written declarations for rtti.js, which is still JavaScript.
// Temporary: delete when rtti.ts replaces rtti.js. See scan.d.ts for why
// these exist at all, and for what happens when one of them is wrong.
//
// Only what TypeScript callers actually use is declared.

import type { ByteSource } from './pe';

/**
 * Class key -> vtable RVA.
 *
 * Three outcomes, and the difference matters:
 *   - a number, when the class resolved;
 *   - null, when the class was searched for and not found;
 *   - ABSENT, when the image had no .data/.rdata to search at all --
 *     `rtti.js` returns a bare `{}` in that case, so every key is missing
 *     rather than null.
 *
 * Compare with `!= null`, which covers both null and absent. A strict
 * `!== null` passes the absent case and the caller computes `base + undefined`,
 * which is NaN.
 */
export function resolveVtableRvas(
  source: ByteSource,
  base: number,
  names?: Record<string, string>,
): Record<string, number | null | undefined>;

/**
 * Every candidate vtable RVA for one class. Multiple-inheritance classes have
 * more than one and instances store the primary at +0x00, so callers try each.
 *
 * Empty when the class is absent or the image has no sections to search.
 */
export function resolveAllVtableRvas(
  source: ByteSource,
  base: number,
  name: string,
): number[];
