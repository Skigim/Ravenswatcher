'use strict';
// Is this string anywhere in the running process?
//
//   node app/reader/bench/string-presence.js "Raven Claw" Icon_Object_RavenClaw
//
// The control for a walk that found nothing. A pointer chase that reaches none
// of its needles proves nothing until the needles are shown to be findable at
// all -- otherwise a misspelling, a localized name the object never carries, or
// a UTF-16 encoding reads exactly like a wrong offset. The Sandman work leaned
// on this: a depth-4 walk from the shop controller reached none of the six
// items on offer, and only this made that a real negative rather than a
// broken probe.
//
// writableOnly is off. Heap objects live in writable pages, but a string that
// exists only in image-backed read-only data is still present -- and knowing
// which of the two it is tells you whether to expect a live object to own it.
//
// scanStrings matches NUL-terminated, so a needle must be a WHOLE stored
// string, not a fragment of one. That strictness is the point -- it stops one
// path matching another that merely starts the same way -- but it makes ABSENT
// easy to misread:
//
//   "Icon_Object_"           ABSENT, it is only ever a prefix
//   "Icon_Object_RavenClaw"  ABSENT, stored inside a longer path with .png
//   "Raven Claw"             5 hits, stored as a whole string
//
// So ABSENT means "no string in memory is exactly this", never "this text does
// not appear". If a whole-string needle comes back ABSENT and you expected it,
// the next question is what it is stored as -- try the full path, or fall back
// to a substring scan over the same regions.

const { openProcess, findPid, moduleBase } = require('../win32');
const { scanStrings } = require('../scan');
const { PROCESS_NAME } = require('../state');

const needles = process.argv.slice(2);
if (!needles.length) {
  console.error('usage: string-presence.js <needle>...');
  process.exit(1);
}

const pid = findPid(PROCESS_NAME);
if (!pid) {
  console.error(`${PROCESS_NAME} is not running.`);
  process.exit(1);
}
const mod = moduleBase(pid);
const proc = openProcess(pid);
console.log(`pid ${pid}  base 0x${mod.base.toString(16).toUpperCase()}\n`);

const t0 = process.hrtime.bigint();
const found = scanStrings(proc, needles, { writableOnly: false });
const ms = Number(process.hrtime.bigint() - t0) / 1e6;

for (const n of needles) {
  const hits = found.get(n) ?? [];
  const tag = hits.length ? `${hits.length} hit(s)` : 'ABSENT';
  console.log(`${tag.padEnd(12)} ${n}`);
  for (const a of hits.slice(0, 3)) {
    console.log(`             0x${a.toString(16).toUpperCase()}`);
  }
  if (hits.length > 3) console.log(`             ... and ${hits.length - 3} more`);
}
console.log(`\n${ms.toFixed(0)} ms`);
proc.close();
