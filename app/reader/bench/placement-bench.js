'use strict';
// How long placedAmong takes against the live game, and what it finds.
// Run with Ravenswatch running: node app/reader/bench/placement-bench.js

const { openProcess, findPid, moduleBase } = require('../win32');
const { placedAmong } = require('../placement');
const { MARKER_PATHS, questFromPlacement, PROCESS_NAME } = require('../state');

const pid = findPid(PROCESS_NAME);
const mod = moduleBase(pid);
const proc = openProcess(pid);
const cache = {};

for (let i = 0; i < 3; i++) {
  const t0 = process.hrtime.bigint();
  const placed = placedAmong(proc, mod.base, MARKER_PATHS, cache);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`pass ${i + 1}: ${ms.toFixed(0)} ms`);
  if (placed === null) { console.log('  oCEntity unresolved'); continue; }
  for (const [p, n] of placed) console.log(`  x${n}  ${p}`);
  for (const map of ['Dark Hills', 'Storm Island', 'Avalon']) {
    const q = questFromPlacement(map, new Set(placed.keys()));
    if (q) console.log(`  ${map} -> ${q}`);
  }
}
proc.close();
