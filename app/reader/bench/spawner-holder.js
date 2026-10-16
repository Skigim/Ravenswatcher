'use strict';
// Find a stable holder for the tile spawner pointer.
//
// WHY. Locating oCDtEntityCpntTileSpawner costs ~900 ms because scanPointers
// walks all of writable memory for it. The instance is reallocated on every map
// load, so unlike the Sandman controller it cannot simply be cached once per
// process -- two Dark Hills runs gave two different addresses. But an address
// that something else already holds does not need to be hunted. If some qword
// at a fixed module-relative address holds the current spawner, reading the
// spawner on map load is a pointer read and the scan is gone for good.
//
// This finds the candidates. It cannot confirm one on its own: a holder is only
// proven stable by appearing at the SAME address on a DIFFERENT map with its
// value updated to that map's spawner. So run it once per map, passing the same
// --state file, and the second run prints the intersection.
//
//   node app/reader/bench/spawner-holder.js --label dark-hills --state <path>
//   ... load a different map ...
//   node app/reader/bench/spawner-holder.js --label avalon     --state <path>

const fs = require('fs');
const { openProcess, findPid, moduleBase } = require('../win32');
const { PROCESS_NAME } = require('../state');
const { scanPointers, scanPointerRanges } = require('../scan');
const tiles = require('../tiles');
const rtti = require('../rtti');

const hex = n => `0x${n.toString(16).toUpperCase()}`;

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const label = arg('--label', 'run');
const statePath = arg('--state', null);
// A heap holder is rarely the answer itself; what points AT the object holding
// it may be. This is the window swept around each heap holder in hop 2.
const HOP2_WINDOW = 0x200;
const HOP2_MAX_HOLDERS = 64;

// ------------------------------------------------------------------ connect
let pid;
try {
  pid = findPid(PROCESS_NAME);
} catch (err) {
  console.error(`Target process ${PROCESS_NAME} not found: ${err.message}`);
  process.exit(1);
}

const mod = moduleBase(pid);
const proc = openProcess(pid);
const modLo = mod.base;
const modHi = mod.base + mod.size;
const inModule = a => a >= modLo && a < modHi;
const describe = a => (inModule(a) ? `MODULE +${hex(a - modLo)}` : 'heap');

console.log(`================================================================`);
console.log(` Tile spawner holder hunt -- label "${label}"`);
console.log(` Process: ${PROCESS_NAME} (PID ${pid})`);
console.log(` Module:  ${hex(modLo)} .. ${hex(modHi)}  (${hex(mod.size)} bytes)`);
console.log(`================================================================\n`);

// --------------------------------------------------------------- the spawner
const vtables = {};
const resolved = tiles.resolveVtables(proc, mod.base, vtables);
if (!resolved) {
  console.error('ERROR: could not resolve the tile spawner vtable via RTTI.');
  proc.close();
  process.exit(1);
}

const t0 = process.hrtime.bigint();
const discovered = tiles.findInstances(proc, resolved);
const findMs = Number(process.hrtime.bigint() - t0) / 1e6;

if (!discovered || !discovered.spawnerAddr) {
  console.error('ERROR: no oCDtEntityCpntTileSpawner instance in memory.');
  console.error('       Load a map before running this -- the component does not');
  console.error('       exist between maps.');
  proc.close();
  process.exit(1);
}
const spawner = discovered.spawnerAddr;
console.log(`Spawner: ${hex(spawner)}   (found by scan in ${findMs.toFixed(1)} ms)\n`);

// ------------------------------------------------ hop 1: who holds it exactly
console.log(`== hop 1: qwords holding ${hex(spawner)} ==`);
const t1 = process.hrtime.bigint();
const hop1 = scanPointers(proc, [spawner], { writableOnly: true }).get(spawner) || [];
const hop1Ms = Number(process.hrtime.bigint() - t1) / 1e6;
console.log(`  writable scan: ${hop1.length} holder(s) in ${hop1Ms.toFixed(1)} ms`);

// An all-regions pass was tried here and is not worth keeping: it took 39.8 s
// and returned the identical 145 holders. A pointer that is rewritten every map
// load lives in a writable section by necessity, so the writable pass is not
// missing it.

// Every TileSlot carries a back-pointer to its spawner at +0x00, so each placed
// and unplaced slot answers this scan. That is ~145 of the 145 hits and none of
// them are holders in any useful sense. They are excluded by computing the slot
// addresses from the spawner's own vectors rather than by guessing at strides.
const slotAddrs = new Set();
const catPtr = proc.readPtr(spawner + tiles.SPAWNER_CATEGORY_VECTOR_OFFSET);
const catN = tiles.readU32(proc, spawner + tiles.SPAWNER_CATEGORY_COUNT_OFFSET) || 0;
for (let c = 0; c < catN && catPtr; c++) {
  const slice = catPtr + c * tiles.CATEGORY_SLICE_STRIDE;
  const data = proc.readPtr(slice + tiles.CATEGORY_SLICE_DATA_OFFSET);
  const n = tiles.readU32(proc, slice + tiles.CATEGORY_SLICE_COUNT_OFFSET) || 0;
  for (let i = 0; i < n && data; i++) slotAddrs.add(data + i * tiles.TILE_SLOT_STRIDE);
}
const subPtr = proc.readPtr(spawner + tiles.SPAWNER_SUBLEVEL_VECTOR_OFFSET);
const subN = tiles.readU32(proc, spawner + tiles.SPAWNER_SUBLEVEL_COUNT_OFFSET) || 0;
for (let i = 0; i < subN && subPtr; i++) {
  slotAddrs.add(subPtr + i * tiles.TILE_SLOT_STRIDE);
}

const SELF_SPAN = 0x400;
const isSelf = a => (a >= spawner && a < spawner + SELF_SPAN) || slotAddrs.has(a);
const selfRefs = hop1.filter(isSelf).length;
const holders = hop1.filter(a => !isSelf(a));

console.log(`  ${selfRefs} slot back-pointer(s) and self-reference(s), excluded`
  + ` (${slotAddrs.size} slots known)`);
console.log(`  ${holders.length} external holder(s):`);
for (const h of holders.slice(0, 40)) {
  console.log(`    ${hex(h).padEnd(18)} ${describe(h)}`);
}
if (holders.length > 40) console.log(`    ... and ${holders.length - 40} more`);

// Naming the object each holder sits in is what decides the next move: a
// manager or registry is worth walking up from, a bare array is not. Walk back
// from the holder to the nearest qword that points into the module image --
// that is the object's vtable -- and ask RTTI what class it belongs to.
const BACKWALK = 0x600;
for (const h of holders) {
  let named = null;
  for (let off = 0; off <= BACKWALK && !named; off += 8) {
    const cand = proc.readPtr(h - off);
    if (!cand || !inModule(cand)) continue;
    const cls = rtti.classOfVtable(proc, modLo, mod.size, cand);
    if (cls) named = { off, vt: cand, cls };
  }
  console.log(named
    ? `    ${hex(h)}  is +${hex(named.off)} inside ${named.cls}`
      + `  (vtable ${hex(named.vt)} = MODULE +${hex(named.vt - modLo)})`
    : `    ${hex(h)}  no RTTI-named object within ${hex(BACKWALK)} bytes back`);
}
console.log();

const moduleHolders = holders.filter(inModule);
console.log(moduleHolders.length
  ? `\n  ${moduleHolders.length} holder(s) sit INSIDE the module image -- these are`
    + ` the candidates.`
  : `\n  No holder sits inside the module image. The chain does not bottom out`
    + ` in one hop; hop 2 looks for a static pointer to whatever holds it.`);
console.log();

// ------------------------------- hop 2: who points at the objects holding it
let hop2 = [];
if (!moduleHolders.length && holders.length) {
  console.log(`== hop 2: who points near those holders ==`);
  const targets = holders.slice(0, HOP2_MAX_HOLDERS);
  const ranges = targets.map(h => [h - HOP2_WINDOW, h + HOP2_WINDOW]);
  const t2 = process.hrtime.bigint();
  const refHits = scanPointerRanges(proc, ranges, { writableOnly: true });
  const hop2Ms = Number(process.hrtime.bigint() - t2) / 1e6;

  const seen = new Set();
  for (const [, addrs] of refHits.entries()) {
    for (const a of addrs) {
      if (seen.has(a)) continue;
      seen.add(a);
      hop2.push(a);
    }
  }
  const hop2Module = hop2.filter(inModule);
  console.log(`  ${hop2.length} referrer(s) in ${hop2Ms.toFixed(1)} ms,`
    + ` ${hop2Module.length} inside the module image`);
  for (const a of hop2Module.slice(0, 40)) {
    console.log(`    ${hex(a).padEnd(18)} ${describe(a)}`);
  }
  console.log();
}

// ------------------------------------------------------ persist and compare
const record = {
  label,
  spawner,
  moduleBase: modLo,
  moduleSize: mod.size,
  holders,
  moduleHolders,
  hop2Module: hop2.filter(inModule),
};

if (!statePath) {
  console.log('No --state given, so nothing was saved and nothing can be compared.');
  console.log('Pass the same --state path on a second map to find stable holders.');
  proc.close();
  process.exit(0);
}

let prior = [];
try {
  prior = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (!Array.isArray(prior)) prior = [];
} catch { prior = []; }

// Only a run against a DIFFERENT spawner address proves anything: the same map
// still loaded would make every holder look stable for the trivial reason that
// nothing moved.
const others = prior.filter(p => p.spawner !== spawner);

if (!others.length) {
  console.log(`Saved as "${label}". No earlier run against a different spawner yet,`);
  console.log(`so there is nothing to intersect. Load a different map and re-run`);
  console.log(`with the same --state path.`);
} else {
  console.log(`== stable across maps ==`);
  for (const p of others) {
    // RVAs, not absolute addresses. Both runs are the same process here so the
    // module base is identical, but comparing offsets keeps this honest if that
    // ever stops being true.
    const priorRvas = new Set(
      (p.moduleHolders || []).map(a => a - p.moduleBase));
    const nowRvas = (record.moduleHolders || []).map(a => a - modLo);
    const stable = nowRvas.filter(r => priorRvas.has(r));

    console.log(`  vs "${p.label}" (spawner ${hex(p.spawner)}):`);
    if (!stable.length) {
      console.log(`    no module-resident holder appears in both runs.`);
    }
    for (const rva of stable) {
      const addr = modLo + rva;
      const val = proc.readPtr(addr);
      const ok = val === spawner;
      console.log(`    MODULE +${hex(rva)}  ->  ${hex(val || 0)}`
        + `  ${ok ? 'MATCHES the current spawner' : 'does NOT match -- reject'}`);
    }

    const priorHop2 = new Set((p.hop2Module || []).map(a => a - p.moduleBase));
    const nowHop2 = (record.hop2Module || []).map(a => a - modLo);
    const stable2 = nowHop2.filter(r => priorHop2.has(r));
    if (stable2.length) {
      console.log(`    hop 2, stable in both runs: ${stable2.length} address(es)`);
      for (const rva of stable2.slice(0, 20)) {
        console.log(`      MODULE +${hex(rva)}`);
      }
    }
  }
}

prior.push(record);
fs.writeFileSync(statePath, JSON.stringify(prior, null, 2), 'utf8');
console.log(`\nState written to ${statePath} (${prior.length} run(s) recorded).`);

proc.close();
process.exit(0);
