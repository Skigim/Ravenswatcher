'use strict';
// The resource-name cipher. Cooked files and folders under
// DarkTalesResources/_Cooking carry names run through a fixed monoalphabetic
// substitution: one letter always maps to one letter, upper and lower case
// through independent tables, and every other character passes through.
// The tables are copied from ravenswatch_cipher.md at the repo root; that
// doc is the source, this file is its runtime copy.

const LOWER: Record<string, string> = {
  g: 'a', u: 'r', b: 'c', i: 't', q: 'e', v: 's', n: 'h', d: 'i', l: 'l', w: 'u',
  x: 'm', j: 'p', p: 'x', r: 'o', z: 'n', y: 'g', h: 'f', t: 'd', a: 'b', s: 'y',
  m: 'k', c: 'j', o: 'w', k: 'v', f: 'q', e: 'z',
};
const UPPER: Record<string, string> = {
  H: 'M', S: 'C', N: 'D', Q: 'T', J: 'U', F: 'S', I: 'K', X: 'I', G: 'L', K: 'G',
  D: 'V', A: 'H', M: 'E', B: 'B', C: 'Y', O: 'O', V: 'F', Z: 'X', L: 'R', T: 'P',
  W: 'A', R: 'W', U: 'N', E: 'J', P: 'Q', Y: 'Z',
};

const DECODE: Record<string, string> = { ...LOWER, ...UPPER };
const ENCODE: Record<string, string> = {};
for (const [cooked, plain] of Object.entries(DECODE)) ENCODE[plain] = cooked;

/** Cooked spelling to decoded. */
export function decodeName(s: string): string {
  let out = '';
  for (const ch of s) out += DECODE[ch] ?? ch;
  return out;
}

/** Decoded spelling to cooked: the name to open on disk. */
export function encodeName(s: string): string {
  let out = '';
  for (const ch of s) out += ENCODE[ch] ?? ch;
  return out;
}
