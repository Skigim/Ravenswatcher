'use strict';
// Placed Tiles & Rewards live census benchmark.
//
// Sweeps the running game's memory to produce a complete census of:
//   1. Placed camps and standing POIs (via oCDtEntityCpntTileSpawner category vector)
//   2. Underground and interior sublevel rooms (via oCDtEntityCpntTileSpawner sublevel vector)
//   3. Camp rewards rolled by selectors (via oCDtRewardEntitySelectorToSpawnEntityCpnt)
//
// Degrades honestly with a clean diagnostic if Ravenswatch.exe is absent.

const { openProcess, findPid, moduleBase } = require('../win32');
const { PROCESS_NAME } = require('../state');
const tiles = require('../tiles');

const hex = n => `0x${n.toString(16).toUpperCase()}`;

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

console.log(`================================================================`);
console.log(` Ravenswatch Placed Tiles & Rewards Census`);
console.log(` Process: ${PROCESS_NAME} (PID ${pid})`);
console.log(` Module Base: ${hex(mod.base)}`);
console.log(`================================================================\n`);

// ----------------------------------------------------------- RTTI & discovery
console.log(`[1/5] Resolving RTTI vtables...`);
const vtables = {};
const tRtti0 = process.hrtime.bigint();
const resolved = tiles.resolveVtables(proc, mod.base, vtables);
const rttiMs = Number(process.hrtime.bigint() - tRtti0) / 1e6;

if (!resolved) {
  console.error(`ERROR: Failed to resolve tile spawner or reward selector vtables via RTTI.`);
  proc.close();
  process.exit(1);
}

console.log(`  Spawner Vtable:  ${hex(resolved.spawnerVt)}`);
console.log(`  Selector Vtable: ${hex(resolved.selectorVt)}`);
console.log(`  RTTI resolution took: ${rttiMs.toFixed(2)} ms\n`);

console.log(`[2/5] Scanning heap for instances (combined 2-target scan)...`);
const tScan0 = process.hrtime.bigint();
const discovered = tiles.findInstances(proc, resolved);
const scanMs = Number(process.hrtime.bigint() - tScan0) / 1e6;

console.log(`  Combined scan took: ${scanMs.toFixed(2)} ms`);
console.log(`  Tile Spawner:  ${discovered.spawnerAddr ? hex(discovered.spawnerAddr) : 'NOT FOUND'}`);
console.log(`  Selectors:     ${discovered.selectorAddrs.length} instance(s) found\n`);

if (!discovered.spawnerAddr) {
  console.error(`ERROR: No oCDtEntityCpntTileSpawner instance found in writable memory.`);
  proc.close();
  process.exit(1);
}

// ----------------------------------------------------------- Raw reader sweep
console.log(`[3/5] Reading placed tiles & rewards roster...`);
const tRead0 = process.hrtime.bigint();
const rawRoster = tiles.readPlacedTiles(proc, mod.base, resolved, discovered);
const readMs = Number(process.hrtime.bigint() - tRead0) / 1e6;

if (!rawRoster) {
  console.error(`ERROR: Failed to read placed tiles from spawner.`);
  proc.close();
  process.exit(1);
}

console.log(`  Direct memory read took: ${readMs.toFixed(2)} ms`);
console.log(`  Total placed items in raw roster: ${rawRoster.length}`);

// Category count from spawner + 0x118
const catCount = tiles.readU32(proc, discovered.spawnerAddr + tiles.SPAWNER_CATEGORY_COUNT_OFFSET);
const subCount = tiles.readU32(proc, discovered.spawnerAddr + tiles.SPAWNER_SUBLEVEL_COUNT_OFFSET);
console.log(`  Spawner category vector count: ${catCount} slice(s)`);
console.log(`  Spawner sublevel vector count: ${subCount} slot(s)\n`);

// -------------------------------------------------- Name sweep verification
console.log(`[4/5] Verification: Name read sweep across all placed slots...`);
let totalPlacedSlots = 0;
let plausibleNames = 0;
let failedNames = 0;

// Category slices sweep
const catVecPtr = proc.readPtr(discovered.spawnerAddr + tiles.SPAWNER_CATEGORY_VECTOR_OFFSET);
if (catVecPtr && catCount) {
  for (let c = 0; c < catCount; c++) {
    const sliceAddr = catVecPtr + c * tiles.CATEGORY_SLICE_STRIDE;
    const slotsPtr = proc.readPtr(sliceAddr + tiles.CATEGORY_SLICE_DATA_OFFSET);
    const slotCount = tiles.readU32(proc, sliceAddr + tiles.CATEGORY_SLICE_COUNT_OFFSET);
    if (!slotsPtr || !slotCount) continue;

    for (let s = 0; s < slotCount; s++) {
      const slotAddr = slotsPtr + s * tiles.TILE_SLOT_STRIDE;
      const res = proc.readPtr(slotAddr + tiles.SLOT_RESOURCE_OFFSET);
      if (!res || res < tiles.MIN_VALID_ADDR) continue;
      const weightBuf = proc.read(slotAddr + tiles.SLOT_WEIGHT_OFFSET, 4);
      if (weightBuf && weightBuf.readFloatLE(0) === -1.0) continue;

      totalPlacedSlots++;
      const name = tiles.readStringTriple(proc, res + tiles.RESOURCE_NAME_OFFSET);
      if (name && name.length > 0) {
        plausibleNames++;
      } else {
        failedNames++;
      }
    }
  }
}

// Sublevel sweep
const subVecPtr = proc.readPtr(discovered.spawnerAddr + tiles.SPAWNER_SUBLEVEL_VECTOR_OFFSET);
if (subVecPtr && subCount) {
  for (let s = 0; s < subCount; s++) {
    const slotAddr = subVecPtr + s * tiles.TILE_SLOT_STRIDE;
    const res = proc.readPtr(slotAddr + tiles.SLOT_RESOURCE_OFFSET);
    if (!res || res < tiles.MIN_VALID_ADDR) continue;
    const weightBuf = proc.read(slotAddr + tiles.SLOT_WEIGHT_OFFSET, 4);
    if (weightBuf && weightBuf.readFloatLE(0) === -1.0) continue;

    totalPlacedSlots++;
    const name = tiles.readStringTriple(proc, res + tiles.RESOURCE_NAME_OFFSET);
    if (name && name.length > 0) {
      plausibleNames++;
    } else {
      failedNames++;
    }
  }
}

console.log(`  Placed slots swept: ${totalPlacedSlots}`);
console.log(`  Plausible names:    ${plausibleNames}`);
console.log(`  Failed names:       ${failedNames}`);
console.log(`  Sweep coverage:     ${totalPlacedSlots > 0 ? ((plausibleNames / totalPlacedSlots) * 100).toFixed(1) : 0}%\n`);

// ------------------------------------------------ Distinct tile_kind values
//
// Counting resolved names alone cannot tell "this slot has no kind" apart from
// "this slot has a kind whose name would not read", and those demand opposite
// follow-ups. So the pointer at slot+0x50 is counted separately from the name,
// and one live kind object is dumped: the name offset inside oCDtTileKind is
// unknown, and a dump is the only thing that makes the next run able to find it.
console.log(`tile_kind (slot + 0x50) across all placed slots:`);
const kindCounts = new Map();
let kindPtrNull = 0;
let kindPtrPresent = 0;
let sampleKindAddr = null;
const distinctKindAddrs = new Set();
const resolvedKindAddrs = new Set();

function eachPlacedSlot(fn) {
  const catVec = proc.readPtr(discovered.spawnerAddr + tiles.SPAWNER_CATEGORY_VECTOR_OFFSET);
  if (catVec && catCount) {
    for (let c = 0; c < catCount; c++) {
      const sliceAddr = catVec + c * tiles.CATEGORY_SLICE_STRIDE;
      const slotsPtr = proc.readPtr(sliceAddr + tiles.CATEGORY_SLICE_DATA_OFFSET);
      const n = tiles.readU32(proc, sliceAddr + tiles.CATEGORY_SLICE_COUNT_OFFSET);
      if (!slotsPtr || !n) continue;
      for (let s = 0; s < n; s++) fn(slotsPtr + s * tiles.TILE_SLOT_STRIDE);
    }
  }
  const subVec = proc.readPtr(discovered.spawnerAddr + tiles.SPAWNER_SUBLEVEL_VECTOR_OFFSET);
  if (subVec && subCount) {
    for (let s = 0; s < subCount; s++) fn(subVec + s * tiles.TILE_SLOT_STRIDE);
  }
}

eachPlacedSlot((slotAddr) => {
  const res = proc.readPtr(slotAddr + tiles.SLOT_RESOURCE_OFFSET);
  if (!res || res < tiles.MIN_VALID_ADDR) return;
  const weightBuf = proc.read(slotAddr + tiles.SLOT_WEIGHT_OFFSET, 4);
  if (weightBuf && weightBuf.readFloatLE(0) === -1.0) return;

  const kindPtr = proc.readPtr(slotAddr + tiles.SLOT_TILE_KIND_OFFSET);
  if (!kindPtr || kindPtr < tiles.MIN_VALID_ADDR) {
    kindPtrNull++;
    return;
  }
  kindPtrPresent++;
  distinctKindAddrs.add(kindPtr);
  if (sampleKindAddr === null) sampleKindAddr = kindPtr;
  const k = tiles.readTileKind(proc, kindPtr);
  if (k) resolvedKindAddrs.add(kindPtr);
  kindCounts.set(k || '<name unresolved>', (kindCounts.get(k || '<name unresolved>') || 0) + 1);
});

// Slot counts alone cannot distinguish "8 slots share one kind object" from
// "8 separate objects agree", and only the second would make a one-letter tag
// like "F" credible as a real name rather than a coincidentally well-formed
// triple at the wrong offset.
console.log(`  Slots with no kind pointer:   ${kindPtrNull}`);
console.log(`  Slots with a kind pointer:    ${kindPtrPresent}`);
console.log(`  Distinct kind objects:        ${distinctKindAddrs.size}`
  + ` (${resolvedKindAddrs.size} resolved a name at +0xA0)`);
for (const [k, count] of kindCounts.entries()) {
  console.log(`    ${k.padEnd(25)} ${count}`);
}
if (sampleKindAddr !== null) {
  const dump = proc.read(sampleKindAddr, 0x60);
  if (dump && dump.length >= 0x60) {
    console.log(`  Sample oCDtTileKind @ ${hex(sampleKindAddr)} -- first 0x60 bytes as qwords:`);
    for (let off = 0; off < 0x60; off += 8) {
      const q = dump.readBigUInt64LE(off);
      console.log(`    +0x${off.toString(16).padStart(2, '0')}  0x${q.toString(16).padStart(16, '0')}`);
    }
  }
}
console.log();

// --------------------------------------- Selector floats & Refugee selectors
console.log(`Reward Selector Coordinates & Float Verification (+0x60):`);
console.log(`  ${'Address'.padEnd(18)} ${'X (+0x6C)'.padStart(10)} ${'Z (+0x70)'.padStart(10)} ${'Y (+0x74)'.padStart(10)}  ${'Reward Entity Name'}`);
console.log(`  ${'-'.repeat(75)}`);

const refugeeSelectors = [];
for (const selAddr of discovered.selectorAddrs) {
  const fBuf = proc.read(selAddr + 0x60, 24);
  let xStr = '?', zStr = '?', yStr = '?';
  if (fBuf && fBuf.length >= 24) {
    const x = fBuf.readFloatLE(12);
    const z = fBuf.readFloatLE(16);
    const y = fBuf.readFloatLE(20);
    xStr = x.toFixed(1);
    zStr = z.toFixed(1);
    yStr = y.toFixed(1);
  }

  const res = proc.readPtr(selAddr + tiles.SELECTOR_RESOURCE_OFFSET);
  const name = res ? tiles.readStringTriple(proc, res + tiles.RESOURCE_NAME_OFFSET) : null;
  const displayName = name || '<unreadable>';

  console.log(`  ${hex(selAddr).padEnd(18)} ${xStr.padStart(10)} ${zStr.padStart(10)} ${yStr.padStart(10)}  ${displayName}`);

  if (displayName.includes('Refugee')) {
    refugeeSelectors.push({ addr: selAddr, name: displayName, x: xStr, y: yStr, z: zStr });
  }
}
console.log();

// Refugees arrive as selectors on some runs and as plain tiles on others, so
// both are counted here. Reporting only the selectors printed "No refugee
// selectors present" on a Dark Hills map that was carrying three refugee tiles,
// which reads as "no refugees" and is the opposite of what was measured.
console.log(`Refugee Analysis (selectors and tiles):`);
const refugeeTiles = rawRoster.filter(
  t => t.source !== 'selector' && /Refugee/i.test(t.name));

if (refugeeSelectors.length > 0) {
  console.log(`  Refugee selectors: ${refugeeSelectors.length}`);
  for (const r of refugeeSelectors) {
    console.log(`    ${hex(r.addr)}: "${r.name}" at (${r.x}, ${r.z}, ${r.y})`);
  }
  const uniqueNames = new Set(refugeeSelectors.map(r => r.name));
  console.log(`  Distinct selector names: ${uniqueNames.size} (${[...uniqueNames].join(', ')})`);
  console.log(uniqueNames.size > 1
    ? `  -> The three cages ARE individually named.`
    : `  -> The cages are NOT individually named; they share one reward name.`);
} else {
  console.log(`  Refugee selectors: 0`);
}

console.log(`  Refugee tiles:     ${refugeeTiles.length}`
  + (refugeeTiles.length ? ` (${[...new Set(refugeeTiles.map(t => t.name))].join(', ')})` : ''));

if (refugeeSelectors.length === 0 && refugeeTiles.length > 0) {
  console.log(`  -> This run carries refugee TILES but no refugee selector.`);
  console.log(`     Another Dark Hills run placed a 40x40 refugee camp with 3`);
  console.log(`     selectors, so the variant differs per run and the census`);
  console.log(`     must read both sources to cover every run.`);
}
console.log();

// ---------------------------------------------------- Filtered Wanted Census
console.log(`[5/5] Filtered Map Census (Wanted Set):`);
console.log(`  (Camps, POIs, Sublevels, Rewards; excluding questlines & start spawn)\n`);

function isWanted(tile) {
  const name = tile.name;

  // 1. Exclude questline-specific tiles
  if (name.includes('Tree_Quest_Orchard')) return false;
  if (name.includes('Round_Table_Room_Entrance')) return false;
  if (name.includes('JackQuest_')) {
    // Keep Stingy_Jack_Reward_*_T3 (reward item variant in chest quota)
    if (!name.includes('Stingy_Jack_Reward_')) return false;
  }

  // 2. Exclude run start spawn
  if (/_Start_/i.test(name) || /_Start$/i.test(name)) return false;

  // 3. Selectors are camp rewards -> always wanted
  if (tile.source === 'selector') return true;

  // 4. Sublevel rooms -> always wanted
  if (tile.source === 'sublevel') return true;

  // 5. The 3x3 and 6x6 tiers are noise -- blockers, props, crystals, healing and
  //    bleeding fountains, teleporters, and roaming spawns. On Dark Hills they
  //    are 119 of 139 placed tiles.
  //
  //    The rule here used to readmit anything in those tiers matching
  //    /Camp|Refugee/, which put six Basic_Enemy_Camp_Wandering back in the
  //    census. Wandering camps are roaming spawns, not placed camps, and the
  //    reference roster this census is checked against lists none of them.
  //
  //    Refugees are the one real exception and are allowed back by name, not by
  //    a broad pattern, because the refugee camp is placed as more than one
  //    tile variant and they are not all the same size.
  //
  //    This varies per RUN, not per chapter -- an earlier reading of it as a
  //    per-chapter split was wrong, and two Dark Hills runs on 2026-09-06
  //    disproved it. One run placed three 6x6_Dark_Hills_Refugee_01 tiles and
  //    zero refugee selectors; the next placed one
  //    40x40_Dark_Hills_Refugee_Camp_01 and three selectors. So the 6x6 variant
  //    has to survive the tier cut or that first run reports no refugees at all.
  if (tile.width !== null && tile.width <= 6 && tile.height !== null && tile.height <= 6) {
    if (!/Refugee/i.test(name)) return false;
  }

  return true;
}

const wantedList = rawRoster.filter(isWanted);

// Group by source / type
const standingTiles = wantedList.filter(t => t.source === 'category');
const sublevelTiles = wantedList.filter(t => t.source === 'sublevel');
const rewardTiles = wantedList.filter(t => t.source === 'selector');

console.log(`--- Standing Camps & POIs (${standingTiles.length}) ---`);
for (const t of standingTiles) {
  const size = (t.width && t.height) ? `[${t.width}x${t.height}]` : '[??]';
  const kind = t.kind ? `(${t.kind})` : '';
  console.log(`  ${size.padEnd(9)} ${t.name} ${kind}`);
}
console.log();

console.log(`--- Interior & Underground Sublevels (${sublevelTiles.length}) ---`);
for (const t of sublevelTiles) {
  console.log(`  [sublevel] ${t.name}`);
}
console.log();

console.log(`--- Camp Rewards (${rewardTiles.length}) ---`);
for (const t of rewardTiles) {
  console.log(`  [reward]   ${t.name}`);
}
console.log();

console.log(`Total census items: ${wantedList.length} (out of ${rawRoster.length} raw placed items)`);
console.log(`================================================================`);

proc.close();
process.exit(0);
