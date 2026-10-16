'use strict';
// Where placedAmong's minutes actually go.
//
// placement-bench.js times the whole call. This one splits it into the stages
// the function is built from and times each, alongside the cost of a single
// bare pass over writable memory so every number can be read as "how many
// memory passes is this stage worth".
//
// Run with Ravenswatch running: node app/reader/bench/placement-profile.js

const { openProcess, findPid, moduleBase } = require('../win32');
const { scanPointers, scanPointerRanges, scanStrings, iterChunks, CHUNK_SIZE } = require('../scan');
const { objectStrings } = require('../placement');
const rtti = require('../rtti');
const { MARKER_PATHS, PROCESS_NAME } = require('../state');
const { ENTITY_RTTI, ENTITY_RESOURCE_OFFSET, RESOURCE_OBJECT_WINDOW } = require('../placement');

const pid = findPid(PROCESS_NAME);
const mod = moduleBase(pid);
const proc = openProcess(pid);

const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
function time(label, fn) {
  const t0 = process.hrtime.bigint();
  const v = fn();
  const took = ms(t0);
  console.log(`  ${label.padEnd(34)} ${took.toFixed(0).padStart(8)} ms`);
  return { v, took };
}

console.log(`pid ${pid}  base 0x${mod.base.toString(16)}  ${MARKER_PATHS.length} marker paths`);

// --- floor: what one bare pass over writable memory costs, and how much there is
let bytes = 0, chunks = 0;
const floor = time('0. one bare pass (no matching)', () => {
  for (const [, nq] of iterChunks(proc, true)) { bytes += nq * 8; chunks++; }
  return null;
});
console.log(`     ${(bytes / 1e9).toFixed(2)} GB of writable memory in ${chunks} chunks of <=${CHUNK_SIZE / 1e6} MB`);
console.log(`     => ${(bytes / 1e9 / (floor.took / 1000)).toFixed(2)} GB/s read floor\n`);

// --- stage 1: locate the path strings
const strings = time('1. scanStrings(MARKER_PATHS)', () =>
  scanStrings(proc, MARKER_PATHS));
const pathOfString = new Map();
for (const p of MARKER_PATHS) for (const a of strings.v.get(p) || []) pathOfString.set(a, p);
console.log(`     ${pathOfString.size} string sites  (${MARKER_PATHS.length} indexOf passes per chunk)\n`);

// --- stage 2: pointers to those strings = the {char*,len,flags} triples
const triples = time('2. scanPointers(string sites)', () =>
  scanPointers(proc, [...pathOfString.keys()]));
let tripleSites = 0;
for (const sites of triples.v.values()) tripleSites += sites.length;
console.log(`     ${pathOfString.size} targets -> ${tripleSites} triple sites\n`);

// --- stage 3: one range per triple, instead of 41 addresses each
const ranges = [];
const expand = time('3. range construction (CPU only)', () => {
  for (const sites of triples.v.values()) {
    for (const t of sites) ranges.push([t - RESOURCE_OBJECT_WINDOW, t]);
  }
  return ranges;
});
const SLOTS = 1 << 20;
const est = 100 * (1 - Math.pow(1 - 1 / SLOTS, ranges.length * 2));
const oldT = tripleSites * (RESOURCE_OBJECT_WINDOW / 8 + 1);
const oldEst = 100 * (1 - Math.pow(1 - 1 / (1 << 13), oldT));
console.log(`     ${ranges.length} ranges of ${RESOURCE_OBJECT_WINDOW} bytes`);
console.log(`     prefilter is ${SLOTS} slots -> ~${est.toFixed(3)}% saturated`);
console.log(`     (was ${oldT} equality targets in 8192 slots -> ~${oldEst.toFixed(1)}%)\n`);

// --- stage 4: find references into those windows. The stage that was 94%.
const refs = time('4. scanPointerRanges(ranges)', () =>
  scanPointerRanges(proc, ranges));
let refSites = 0;
for (const sites of refs.v.values()) refSites += sites.length;
console.log(`     ${refs.v.size} distinct bases, ${refSites} reference sites\n`);

// --- stage 5: attribute each reference to the path its object really carries
const cache = {};
const attribute = time('5. RTTI + attribution loop', () => {
  const rvas = rtti.resolveAllVtableRvas(proc, mod.base, ENTITY_RTTI);
  if (!rvas.length) return null;
  cache.entity = rvas;
  const entityVts = new Set(rvas.map(r => mod.base + r));
  const wanted = new Set(MARKER_PATHS);
  const ents = new Map();
  for (const [obj, sites] of refs.v) {
    if (!sites.length) continue;
    let carried = null;
    for (const r of sites) {
      const ent = r - ENTITY_RESOURCE_OFFSET;
      if (!entityVts.has(proc.readPtr(ent))) continue;
      if (carried === null) {
        carried = objectStrings(proc, obj, RESOURCE_OBJECT_WINDOW + 0x20)
          .filter(s => wanted.has(s));
        if (!carried.length) break;
      }
      for (const p of carried) {
        if (!ents.has(p)) ents.set(p, new Set());
        ents.get(p).add(ent);
      }
    }
  }
  return ents;
});
if (attribute.v) for (const [p, set] of attribute.v) console.log(`     x${set.size}  ${p}`);

// --- summary
const stages = [
  ['1. scanStrings', strings.took],
  ['2. scanPointers(strings)', triples.took],
  ['3. range construction', expand.took],
  ['4. scanPointerRanges', refs.took],
  ['5. attribution', attribute.took],
];
const total = stages.reduce((a, [, t]) => a + t, 0);
console.log(`\n  ${'TOTAL'.padEnd(34)} ${total.toFixed(0).padStart(8)} ms`);
for (const [label, t] of stages) {
  const share = (100 * t / total).toFixed(1);
  const passes = (t / floor.took).toFixed(1);
  console.log(`  ${label.padEnd(34)} ${share.padStart(5)}%  = ${passes.padStart(6)} bare passes`);
}
proc.close();
