'use strict';
// Find where a placed TILE carries its tier.
//
// The companion probe (selector-tier-field.js) found the tier on the reward
// selector: a float at +0x68 reading 0.15 / 0.5 / 1.0 for T1 / T2 / T3. That
// covers camp rewards -- chests, eyes, crystals. It does not cover thieves
// stashes, which are tiles from the spawner and carry no selector at all.
//
// Two jobs here, and the first is what makes the second trustworthy:
//
//   1. Cross-check the float theory against the tiles whose tier IS in the
//      name -- cauldrons, wishing wells, grimoires, astrolabs all ship as
//      _T1/_T2/_T3 tile variants. If the same three constants show up on the
//      tile side, the theory holds on a second, independent population.
//   2. Read whatever that turns out to be for the Thieves_Stashes tiles.
//
// Searches the 88-byte TileSlot first, then the live entity it points at,
// because the slot is mostly pointers and may not carry per-instance state.
//
// Read-only. Degrades with a diagnostic if the game is not running.

const { openProcess, findPid, moduleBase } = require('../win32');
const { PROCESS_NAME } = require('../state');
const tiles = require('../tiles');

const ENTITY_BYTES = 0x400;
const TIER_FLOATS = [0.15, 0.5, 1.0];   // what the selector probe measured
const hex = n => `0x${n.toString(16).toUpperCase()}`;
const off = n => `+0x${n.toString(16).padStart(3, '0')}`;

const nameTier = name => {
  const m = /_T([123])(?:_|$)/i.exec(name);
  return m ? Number(m[1]) : null;
};
const isStash = name => /Thieves_?Stash/i.test(name);

let pid;
try {
  pid = findPid(PROCESS_NAME);
} catch (err) {
  console.error(`Target process ${PROCESS_NAME} not found: ${err.message}`);
  process.exit(1);
}

const mod = moduleBase(pid);
const proc = openProcess(pid);

console.log('='.repeat(70));
console.log(' Placed tile tier field probe');
console.log(` ${PROCESS_NAME} (PID ${pid})  module base ${hex(mod.base)}`);
console.log('='.repeat(70));

const vtables = {};
if (!tiles.resolveVtables(proc, mod.base, vtables)) {
  console.error('Could not resolve tile vtables via RTTI.');
  proc.close();
  process.exit(1);
}

const chain = tiles.findSpawnerByChain(proc, mod.base, { vtables });
if (!chain || !chain.ok || !chain.spawner) {
  console.error(`Chain did not reach the spawner: ${chain && chain.diagnostic}`);
  proc.close();
  process.exit(1);
}
console.log(`\nSpawner: ${hex(chain.spawner)}`);

// ------------------------------------------------------- walk the slot arrays
// readPlacedTiles does not hand back slot addresses, and the addresses are the
// whole point here, so the vectors are walked directly.
const slots = [];

function collect(dataPtr, count, source) {
  for (let i = 0; i < count; i++) {
    const addr = dataPtr + i * tiles.TILE_SLOT_STRIDE;
    const tile = tiles.readTileSlot(proc, addr, source, null);
    if (!tile) continue;
    const buf = proc.read(addr, tiles.TILE_SLOT_STRIDE);
    if (!buf || buf.length < tiles.TILE_SLOT_STRIDE) continue;
    slots.push({ addr, name: tile.name, tier: nameTier(tile.name), buf });
  }
}

const catPtr = proc.readPtr(chain.spawner + tiles.SPAWNER_CATEGORY_VECTOR_OFFSET);
const catCount = tiles.readU32(proc, chain.spawner + tiles.SPAWNER_CATEGORY_COUNT_OFFSET);
if (catPtr && catCount) {
  for (let c = 0; c < catCount; c++) {
    const slice = catPtr + c * tiles.CATEGORY_SLICE_STRIDE;
    const data = proc.readPtr(slice + tiles.CATEGORY_SLICE_DATA_OFFSET);
    const n = tiles.readU32(proc, slice + tiles.CATEGORY_SLICE_COUNT_OFFSET);
    if (data && n) collect(data, n, 'category');
  }
}

const subPtr = proc.readPtr(chain.spawner + tiles.SPAWNER_SUBLEVEL_VECTOR_OFFSET);
const subCount = tiles.readU32(proc, chain.spawner + tiles.SPAWNER_SUBLEVEL_COUNT_OFFSET);
if (subPtr && subCount) collect(subPtr, subCount, 'sublevel');

console.log(`Placed slots read: ${slots.length}`);

const control = slots.filter(s => s.tier !== null);
const stashes = slots.filter(s => isStash(s.name));
const tiersSeen = new Set(control.map(s => s.tier));

console.log(`\n--- control: ${control.length} tile(s) with a tier in the name, tiers {${[...tiersSeen].sort().join(',')}} ---`);
for (const s of control) console.log(`  T${s.tier}  ${hex(s.addr).padEnd(14)} ${s.name}`);
console.log(`\n--- subjects: ${stashes.length} thieves stash tile(s) ---`);
for (const s of stashes) console.log(`      ${hex(s.addr).padEnd(14)} ${s.name}`);

if (control.length === 0) {
  console.log('\nNo named-tier tiles on this map -- nothing to cross-check against.');
  proc.close();
  process.exit(0);
}

// ------------------------------------------- 1. does the slot itself carry it?
console.log('\n--- stage 1: the 88-byte TileSlot ---');
const slotHits = [];
for (let o = 0; o + 4 <= tiles.TILE_SLOT_STRIDE; o += 4) {
  const vals = control.map(s => s.buf.readFloatLE(o));
  if (vals.every(v => TIER_FLOATS.includes(Number(v.toFixed(4))))) slotHits.push(o);
}
if (slotHits.length === 0) {
  console.log('  No float in the slot reads one of 0.15 / 0.5 / 1.0 on every');
  console.log('  named-tier tile. The slot does not carry the tier.');
} else {
  for (const o of slotHits) {
    const line = control.map(s => `T${s.tier}=${s.buf.readFloatLE(o).toFixed(2)}`).join('  ');
    console.log(`  ${off(o)}   ${line}`);
  }
}

// ------------------------------------ 2. the live entity the slot points at
console.log('\n--- stage 2: the live entity at slot+0x18 ---');

function entityBuf(s) {
  const ent = proc.readPtr(s.addr + tiles.SLOT_ENTITY_OFFSET);
  if (!ent || ent < tiles.MIN_VALID_ADDR) return null;
  const buf = proc.read(ent, ENTITY_BYTES);
  return buf && buf.length >= ENTITY_BYTES ? { ent, buf } : null;
}

for (const s of [...control, ...stashes]) s.entity = entityBuf(s);
const withEntity = control.filter(s => s.entity);
console.log(`  control tiles with a live entity: ${withEntity.length}/${control.length}`);
console.log(`  stash tiles with a live entity:   ${stashes.filter(s => s.entity).length}/${stashes.length}`);

if (withEntity.length === 0) {
  console.log('  Nothing to search.');
  proc.close();
  process.exit(0);
}

// An offset qualifies only if every control entity reads a tier constant there
// AND the value it reads agrees with that tile's named tier under one single
// mapping. A field that happens to hold 0.5 everywhere is not a tier field.
const MAP = { 0.15: 1, 0.5: 2, 1: 3 };
const hits = [];
for (let o = 0; o + 4 <= ENTITY_BYTES; o += 4) {
  let ok = true;
  for (const s of withEntity) {
    const v = Number(s.entity.buf.readFloatLE(o).toFixed(4));
    if (MAP[v] !== s.tier) { ok = false; break; }
  }
  if (ok) hits.push(o);
}

if (hits.length === 0) {
  console.log(`  No float in the first ${hex(ENTITY_BYTES)} bytes of the entity maps to`);
  console.log('  the named tier. The tier is deeper -- try the component array at');
  console.log('  entity+0x190 (count at +0x198), the way the spawner chain walks it.');
} else {
  console.log(`  ${hits.length} offset(s) map to the named tier:`);
  for (const o of hits) {
    const c = withEntity.map(s => `T${s.tier}=${s.entity.buf.readFloatLE(o).toFixed(2)}`).join('  ');
    console.log(`    ${off(o)}   control: ${c}`);
    const st = stashes.filter(s => s.entity)
      .map(s => s.entity.buf.readFloatLE(o).toFixed(2)).join('  ');
    console.log(`    ${' '.repeat(6)}   stashes: ${st || '(none with an entity)'}`);
  }
}

proc.close();
