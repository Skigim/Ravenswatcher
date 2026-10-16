#!/usr/bin/env node
'use strict';

/**
 * app/reader/bench/rtti-names.js
 *
 * Enumerates every MSVC RTTI type-descriptor name in the module's .data
 * section and prints the ones matching a regex. Use it instead of guessing a
 * mangled name for rtti.resolveVtableRvas / resolveAllVtableRvas.
 *
 * Usage:
 *   node app/reader/bench/rtti-names.js MagicalObject
 *   node app/reader/bench/rtti-names.js "Viewer|Miniature"
 */

const { openProcess, findPid, moduleBase } = require('../win32');
const { PROCESS_NAME } = require('../state');
const rtti = require('../rtti');

const pattern = process.argv[2];
if (!pattern) {
  console.error('Usage: node app/reader/bench/rtti-names.js <regex>');
  process.exit(1);
}
const re = new RegExp(pattern, 'i');

const pid = findPid(PROCESS_NAME);
if (!pid) {
  console.error(`[ERROR] ${PROCESS_NAME} is not running.`);
  process.exit(1);
}
const mod = moduleBase(pid);
const proc = openProcess(pid);
console.log(`Attached to ${PROCESS_NAME} (PID ${pid}, base 0x${mod.base.toString(16).toUpperCase()})`);

const { data } = rtti.sectionsOf(proc, mod.base);
if (!data) {
  console.error('[ERROR] Could not locate the .data section.');
  proc.close();
  process.exit(1);
}

// RTTI type descriptor names are NUL-terminated and all begin ".?AV" (class)
// or ".?AU" (struct), sitting at TypeDescriptor + 0x10.
const t0 = process.hrtime.bigint();
const hits = [];
for (const needle of ['.?AV', '.?AU']) {
  for (const addr of rtti.scanSection(proc, mod.base, data, Buffer.from(needle, 'latin1'))) {
    const buf = proc.read(addr, 192);
    if (!buf) continue;
    const z = buf.indexOf(0);
    if (z < 0) continue;
    const name = buf.subarray(0, z).toString('latin1');
    if (!/^[\x20-\x7e]+$/.test(name)) continue;
    if (!name.endsWith('@@')) continue;
    hits.push({ addr, name });
  }
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;

const seen = new Set();
const matched = [];
for (const h of hits) {
  if (seen.has(h.name)) continue;
  seen.add(h.name);
  if (re.test(h.name)) matched.push(h);
}
matched.sort((a, b) => a.name.localeCompare(b.name));

console.log(`Scanned .data in ${ms.toFixed(0)} ms: ${hits.length} descriptor names, ${seen.size} unique.`);
console.log(`${matched.length} match /${pattern}/i:\n`);
for (const m of matched) {
  console.log(`  0x${m.addr.toString(16).toUpperCase()}  ${m.name}`);
}
proc.close();
