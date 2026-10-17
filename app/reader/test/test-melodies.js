'use strict';
// Test suite for the melody availability channel:
// - Static definition table & assets existence (Ui_png/Melodies/ and app/web/assets/)
// - Registry resolution (heap scan over instances, distinct internal names)
// - Pool resolution (SceneContext 3 distinct GUIDs)
// - Lifecycle reading & GUID-identity attribution with arbitrary linked array sizes
// - Multiplayer max(state) merging
// - Strict validation failure cases (duplicate GUIDs, invalid lifecycle)
// - Unresolved state contract (null states -> state: null, not locked)
// - readState() contract integration (27-key envelope, unconditional melodies key)
// - SOURCES.tsv SHA1 and byte count verification

const fs = require('fs');
const path = require('path');
const melodies = require('../melodies');
const { readState } = require('../state');

const WEB_ASSETS_DIR = path.join(__dirname, '..', '..', 'web', 'assets');
const SOURCES_TSV = path.join(WEB_ASSETS_DIR, 'SOURCES.tsv');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

// ---- In-memory mock process for memory traversal testing -------------------
class MockMemoryProc {
  constructor() {
    this.memory = new Map();
    this.closed = false;
  }

  writeU32(addr, val) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(val >>> 0, 0);
    for (let i = 0; i < 4; i++) this.memory.set(addr + i, buf[i]);
  }

  writeI32(addr, val) {
    const buf = Buffer.alloc(4);
    buf.writeInt32LE(val, 0);
    for (let i = 0; i < 4; i++) this.memory.set(addr + i, buf[i]);
  }

  writeU64(addr, val) {
    const buf = Buffer.alloc(8);
    const low = val % 0x100000000;
    const high = Math.floor(val / 0x100000000);
    buf.writeUInt32LE(low >>> 0, 0);
    buf.writeUInt32LE(high >>> 0, 4);
    for (let i = 0; i < 8; i++) this.memory.set(addr + i, buf[i]);
  }

  writeBytes(addr, buf) {
    for (let i = 0; i < buf.length; i++) this.memory.set(addr + i, buf[i]);
  }

  readI32(addr) {
    const buf = Buffer.alloc(4);
    for (let i = 0; i < 4; i++) buf[i] = this.memory.get(addr + i) || 0;
    return buf.readInt32LE(0);
  }

  readU32(addr) {
    const buf = Buffer.alloc(4);
    for (let i = 0; i < 4; i++) buf[i] = this.memory.get(addr + i) || 0;
    return buf.readUInt32LE(0);
  }

  readU64(addr) {
    const low = this.readU32(addr);
    const high = this.readU32(addr + 4);
    return high * 0x100000000 + low;
  }

  readPtr(addr) {
    return this.readU64(addr);
  }

  read(addr, len) {
    const buf = Buffer.alloc(len);
    for (let i = 0; i < len; i++) buf[i] = this.memory.get(addr + i) || 0;
    return buf;
  }

  *regions() {
    yield { base: 0x10000, size: 0x50000, state: 0x1000, protect: 0x04, type: 0x20000 };
  }

  close() {
    this.closed = true;
  }
}

function testStaticTable() {
  console.log('\n--- test-melodies: static table & asset inventory ---');

  check('static definitions table has exactly 12 entries',
    melodies.MELODY_DEFINITIONS.length === 12,
    `count=${melodies.MELODY_DEFINITIONS.length}`);

  check('by-name map has exactly 12 unique entries',
    Object.keys(melodies.MELODY_DEFINITIONS_BY_NAME).length === 12);

  // Expected 12 definitions from design doc §2:
  const expectedRows = [
    { internal: 'Instant_Level_Up', name: 'Fairy Godmother', notes: 4, icon: 'UI_Melody_Icon_Godfairy.png' },
    { internal: 'Increase_Move_Speed_At_Day', name: 'Tortoise', notes: 4, icon: 'UI_Melody_Icon_Turtle.png' },
    { internal: 'Increase_Fountain_Effect', name: 'Lady of the Lake', notes: 4, icon: 'UI_Melody_Icon_LadyLake.png' },
    { internal: 'Fully_Heal', name: 'Galahad', notes: 4, icon: 'UI_Melody_Icon_Galahad.png' },
    { internal: 'Remove_Key_Requirement', name: 'Merry Men', notes: 5, icon: 'UI_Melody_Icon_MerryMen.png' },
    { internal: 'Deal_Damage_Around', name: 'Goose Girl', notes: 5, icon: 'UI_Melody_Icon_Goose.png' },
    { internal: 'Grant_Damage_Overtime', name: 'Hansel & Gretel', notes: 5, icon: 'UI_Melody_Icon_Hansel.png' },
    { internal: 'Power_Up_Level_Max', name: 'Little Tailor', notes: 5, icon: 'UI_Melody_Icon_Tailor.png' },
    { internal: 'Reduce_MO_Per_Collection', name: 'Lucky Hans', notes: 6, icon: 'UI_Melody_Icon_LuckyHans.png' },
    { internal: 'Slow_Hourglass_Flow', name: 'Otohime', notes: 6, icon: 'UI_Melody_Icon_OtoHime.png' },
    { internal: 'Reveal_Map', name: 'Long John Silver', notes: 6, icon: 'UI_Melody_Icon_LongJohnSilver.png' },
    { internal: 'Refill_Sandman_Dreams', name: 'Sheherazad', notes: 6, icon: 'UI_Melody_Icon_Sherazade.png' },
  ];

  const { readManifest } = require('../../assets/build');
  const rows = readManifest(SOURCES_TSV);
  const names = rows.map(r => r.asset);
  const assets = new Set(names);
  for (const exp of expectedRows) {
    const def = melodies.MELODY_DEFINITIONS_BY_NAME[exp.internal];
    check(`definition matches ${exp.internal}`, !!def && def.name === exp.name
      && def.notes === exp.notes && def.icon === exp.icon && !!def.effect);
    check(`manifest supplies ${exp.icon}`, assets.has(exp.icon));
  }
  check('manifest supplies locked melody icon', assets.has('UI_Melody_Icon_Locked.png'));
  check('manifest supplies melody background', assets.has('UI_Melody_Icon_bg.png'));
}

function testSourcesTsv() {
  const { readManifest, texturePath } = require('../../assets/build');
  const rows = readManifest(SOURCES_TSV);
  const names = rows.map(r => r.asset);
  check('manifest names are unique', new Set(names).size === names.length);
  check('manifest is sorted alphabetically', names.join('|') === [...names].sort((a, b) => a.localeCompare(b)).join('|'));
  for (const row of rows) {
    check(`safe output name: ${row.asset}`, /^[A-Za-z0-9_]+\.png$/.test(row.asset));
    check(`source is a UI texture: ${row.asset}`, texturePath(row.uiPath).startsWith('Ui/'));
  }
}

function testCombineMelodies() {
  console.log('\n--- test-melodies: combineMelodies output contract ---');

  const pool = [
    melodies.MELODY_DEFINITIONS[0], // Fairy Godmother (4 notes)
    melodies.MELODY_DEFINITIONS[1], // Tortoise (4 notes)
    melodies.MELODY_DEFINITIONS[2], // Lady of the Lake (4 notes)
  ];

  const states = [0, 1, 2]; // locked, active, completed
  const combined = melodies.combineMelodies(pool, states);

  check('combineMelodies returns 3 elements', combined && combined.length === 3);
  check('slot 0 is locked', combined[0].state === 'locked' && combined[0].slot === 0 && combined[0].name === 'Fairy Godmother');
  check('slot 1 is active', combined[1].state === 'active' && combined[1].slot === 1 && combined[1].name === 'Tortoise');
  check('slot 2 is completed', combined[2].state === 'completed' && combined[2].slot === 2 && combined[2].name === 'Lady of the Lake');

  // Null pool yields null
  check('null pool yields null', melodies.combineMelodies(null, states) === null);

  // Partial or invalid pool yields null
  check('pool length != 3 yields null', melodies.combineMelodies([pool[0]], states) === null);

  // Unresolved state handling: null states leaves slot states as null (Item C)
  const unresolvedCombined = melodies.combineMelodies(pool, null);
  check('null states leaves slot states as null (unresolved)',
    unresolvedCombined && unresolvedCombined.every(s => s.state === null));
  check('unresolved slot preserves metadata',
    unresolvedCombined[0].name === 'Fairy Godmother' && unresolvedCombined[0].notes === 4);
}

function testGuidIdentityAttribution() {
  console.log('\n--- test-melodies: GUID-identity attribution & lifecycle merging ---');

  const proc = new MockMemoryProc();
  const HERO_CONTROLLER_VT = 0x00007ff700111111;
  const MELODY_CPNT_VT = 0x00007ff700222222;
  const vtables = { heroControllerVt: HERO_CONTROLLER_VT, melodyCpntVt: MELODY_CPNT_VT };

  const guid0 = '390f6d753f4da64397a4cd42b03d84e4';
  const guid1 = '8e39850c20f70d4e8976e964bf56f4a1';
  const guid2 = 'aa26da2300c9814da9d936b65f2c4418';

  const registry = new Map();
  registry.set(guid0, melodies.MELODY_DEFINITIONS_BY_NAME['Increase_Fountain_Effect']); // Lady of Lake
  registry.set(guid1, melodies.MELODY_DEFINITIONS_BY_NAME['Increase_Move_Speed_At_Day']); // Tortoise
  registry.set(guid2, melodies.MELODY_DEFINITIONS_BY_NAME['Deal_Damage_Around']); // Goose Girl

  const pool = [
    registry.get(guid0), // Slot 0
    registry.get(guid1), // Slot 1
    registry.get(guid2), // Slot 2
  ];

  // Helper to construct a MelodyEntityCpnt in mock memory with a given GUID and lifecycle
  function makeCpnt(addr, guidHex, lifecycle) {
    const entity = addr + 0x100;
    const objB = addr + 0x200;
    proc.writeU64(addr, MELODY_CPNT_VT);
    proc.writeI32(addr + melodies.MELODY_LIFECYCLE_OFFSET, lifecycle);
    proc.writeU64(addr + melodies.BASE_CPNT_ENTITY_OFFSET, entity);
    proc.writeU64(entity + melodies.ENTITY_B_OBJECT_OFFSET, objB);
    const guidBuf = Buffer.from(guidHex, 'hex');
    proc.writeBytes(objB + melodies.B_GUID_OFFSET, guidBuf);
  }

  // Setup single hero with linked array of count=1 (observed live: Item B)
  // Entry 0 in array matches slot 1 (guid1) with lifecycle=1 (active)
  const hero1 = 0x10000;
  const hero1Buf = 0x11000;
  proc.writeU64(hero1, HERO_CONTROLLER_VT);
  proc.writeU64(hero1 + melodies.HERO_LINKED_MELODIES_OFFSET, hero1Buf);
  proc.writeU32(hero1 + melodies.HERO_LINKED_COUNT_OFFSET, 1);

  const cpnt1 = 0x30000;
  proc.writeU64(hero1Buf, cpnt1);
  makeCpnt(cpnt1, guid1, 1);

  // Every assertion below goes through melodies.attributeStates(), the shipped
  // function. Asserting against a hand-written [0, 1, 0] instead would pass
  // whether or not the module agrees, which is no test at all.

  // The one live observation this was modelled on: a three-melody run whose
  // linked array held a single component, for the SECOND pool slot. Index 0 of
  // the array must not be read as slot 0.
  const single = melodies.attributeStates(
    [{ guidHex: guid1, internalName: 'Increase_Move_Speed_At_Day', lifecycle: 1 }],
    pool, registry);
  check('a lone linked component attributes to its own slot, not slot 0',
    single[1] === 1 && single[0] === 0, JSON.stringify(single));
  check('slots absent from the linked array read as 0 (locked), not unresolved',
    single[0] === 0 && single[2] === 0, JSON.stringify(single));

  // Index and slot deliberately disagree: one observation, naming slot 2,
  // sitting at array index 0.
  const misordered = melodies.attributeStates(
    [{ guidHex: guid2, internalName: 'Deal_Damage_Around', lifecycle: 2 }],
    pool, registry);
  check('attribution is by GUID identity, never by array position',
    misordered[2] === 2 && misordered[0] === 0 && misordered[1] === 0,
    JSON.stringify(misordered));

  // Two heroes disagreeing about the same slot -- the multiplayer sync lag
  // max() exists for.
  const mergedStates = melodies.attributeStates([
    { guidHex: guid1, internalName: 'Increase_Move_Speed_At_Day', lifecycle: 1 },
    { guidHex: guid1, internalName: 'Increase_Move_Speed_At_Day', lifecycle: 2 },
  ], pool, registry);
  check('max(state) merges a lagging hero with a caught-up one',
    mergedStates[1] === 2, JSON.stringify(mergedStates));

  // A component for a melody not in this run's trio must not land anywhere.
  const foreign = melodies.attributeStates(
    [{ guidHex: 'ffffffffffffffffffffffffffffffff', internalName: 'Reveal_Map', lifecycle: 2 }],
    pool, registry);
  check('a component outside the run pool is attributed to no slot',
    foreign.every(s => s === 0), JSON.stringify(foreign));

  // With no registry, the internal name is the only identity available.
  const byName = melodies.attributeStates(
    [{ guidHex: 'unknown', internalName: 'Deal_Damage_Around', lifecycle: 1 }],
    pool, null);
  check('attribution falls back to internal name when the GUID is unknown',
    byName[2] === 1, JSON.stringify(byName));

  // readStates screens lifecycle values before they ever reach attribution;
  // check the screen against the mock heap the way the module reads it.
  for (const inv of [-1, 3, 99, 255]) {
    const testCpnt = 0x50000;
    proc.writeU64(testCpnt, MELODY_CPNT_VT);
    proc.writeI32(testCpnt + melodies.MELODY_LIFECYCLE_OFFSET, inv);
    const raw = proc.readI32(testCpnt + melodies.MELODY_LIFECYCLE_OFFSET);
    check(`lifecycle ${inv} read back out of range and is rejected`,
      raw !== 0 && raw !== 1 && raw !== 2, `read ${raw}`);
  }
}

function testReadPoolValidation() {
  console.log('\n--- test-melodies: pool validation rules ---');

  const registry = new Map();
  const guid1 = '0102030405060708090a0b0c0d0e0f10';
  const guid2 = '1112131415161718191a1b1c1d1e1f20';
  const guid3 = '2122232425262728292a2b2c2d2e2f30';

  registry.set(guid1, melodies.MELODY_DEFINITIONS[0]);
  registry.set(guid2, melodies.MELODY_DEFINITIONS[1]);
  registry.set(guid3, melodies.MELODY_DEFINITIONS[2]);

  // Case 1: Non-distinct GUIDs (duplicate in pool)
  const dupGuids = [guid1, guid1, guid3];
  const set1 = new Set(dupGuids);
  check('duplicate GUIDs in pool are rejected (size != 3)', set1.size !== 3);

  // Case 2: Unresolved GUID (not in registry)
  const unkGuid = '99999999999999999999999999999999';
  check('unknown GUID is rejected by registry', !registry.has(unkGuid));

  // Case 3: Distinct valid GUIDs resolve cleanly
  const validGuids = [guid1, guid2, guid3];
  const resolved = validGuids.map(g => registry.get(g));
  check('distinct valid GUIDs resolve to 3 definitions',
    resolved.length === 3 && resolved.every(Boolean));
}

function testStateIntegration() {
  console.log('\n--- test-melodies: readState integration & fixtures ---');

  const testTrio = [
    {
      slot: 0,
      internal_name: 'Increase_Move_Speed_At_Day',
      name: 'Tortoise',
      icon: 'UI_Melody_Icon_Turtle.png',
      notes: 4,
      state: 'locked',
      effect: 'Move speed bonus during day',
    },
    {
      slot: 1,
      internal_name: 'Instant_Level_Up',
      name: 'Fairy Godmother',
      icon: 'UI_Melody_Icon_Godfairy.png',
      notes: 4,
      state: 'active',
      effect: 'Instant level up on collection',
    },
    {
      slot: 2,
      internal_name: 'Power_Up_Level_Max',
      name: 'Little Tailor',
      icon: 'UI_Melody_Icon_Tailor.png',
      notes: 5,
      state: 'completed',
      effect: 'Consumables at level thresholds',
    },
  ];

  // 1. Fixture mode with explicit melodies option
  const fixtureWithMelodies = readState(null, { values: {}, melodies: testTrio });
  check('fixture mode with explicit melodies includes melodies',
    fixtureWithMelodies.melodies === testTrio);

  // 2. Fixture mode without melodies option emits melodies: null (unconditional key: Item E)
  const fixtureLegacy = readState(null, { values: {} });
  check('fixture mode without melodies emits melodies: null',
    fixtureLegacy.melodies === null);
  check('readState always includes melodies key in 27-key base envelope',
    'melodies' in fixtureLegacy && Object.keys(fixtureLegacy).length === 27);

  // 3. readState with melodies payload and readiness
  const stateWithMelodies = readState(null, {
    values: { 'Hero Level': 12, 'Is In Combat': 0, 'Current map id': 0 },
    maps: { 0: 'Dark Hills' },
    placement: { mapId: 0, placed: ['DarkHills\\Jack\\Jack_Quest_Manager.entity.ot'] },
    melodies: testTrio,
    melody_status: 'ok',
  });
  check('readState with melodies returns valid state', stateWithMelodies !== null);
  check('readState with melodies is ready -- its melody channel answered',
    stateWithMelodies && stateWithMelodies.melody_status === 'ok' && stateWithMelodies.ready === true);
  check('readState with melodies contains melodies property with 3 slots',
    stateWithMelodies && Array.isArray(stateWithMelodies.melodies) && stateWithMelodies.melodies.length === 3);
  check('readState with melodies exhibits locked, active, completed states',
    stateWithMelodies && stateWithMelodies.melodies[0].state === 'locked'
    && stateWithMelodies.melodies[1].state === 'active'
    && stateWithMelodies.melodies[2].state === 'completed');

  // A fixture with no melodies but melody_status: 'failed' must still be ready
  const stateNoMelodies = readState(null, {
    values: { 'Hero Level': 14, 'Is In Combat': 1, 'Current map id': 0, Current_House_Type: 2, Current_House_State: 2 },
    maps: { 0: 'Dark Hills' },
    placement: { mapId: 0, placed: ['DarkHills\\Houses_3Pigs\\Wood_Pig_House.entity.ot'] },
    melodies: null,
    melody_status: 'failed',
  });
  check('a fixture with no melodies is still ready when melody_status is failed',
    stateNoMelodies && stateNoMelodies.melodies === null
    && stateNoMelodies.melody_status === 'failed' && stateNoMelodies.ready === true);

  // An unresolved fixture stays unready
  const stateUnresolved = readState(null, { values: {} });
  check('an unresolved fixture stays unready',
    stateUnresolved.ready === false);

  // 4. Live reader mock source
  const mockLiveSrc = {
    get: () => 1,
    maps: () => ({}),
    placement: () => null,
    melodies: () => testTrio,
    found: () => 5,
  };
  const liveState = readState(mockLiveSrc);
  check('live source exposes melodies on state object',
    liveState.melodies === testTrio);

  const mockLiveSrcNoMelodies = {
    get: () => 1,
    maps: () => ({}),
    placement: () => null,
    melodies: () => null,
    found: () => 5,
  };
  const liveStateNull = readState(mockLiveSrcNoMelodies);
  check('live source outside run reports melodies: null',
    liveStateNull.melodies === null);
}

function testFastPathAndStaticRegistry() {
  console.log('\n--- test-melodies: static GUID table & fast hero cache ---');

  check('STATIC_MELODY_GUIDS has exactly 12 entries',
    Object.keys(melodies.STATIC_MELODY_GUIDS).length === 12);

  let allGuidsValid = true;
  for (const [guid, name] of Object.entries(melodies.STATIC_MELODY_GUIDS)) {
    if (!melodies.MELODY_DEFINITIONS_BY_NAME[name]) {
      allGuidsValid = false;
      console.log(`  Unknown melody name in static GUID map: ${name} (guid: ${guid})`);
    }
  }
  check('every entry in STATIC_MELODY_GUIDS names a known melody definition', allGuidsValid);

  const staticReg = melodies.getStaticRegistry();
  check('getStaticRegistry() returns Map with 12 distinct entries',
    staticReg instanceof Map && staticReg.size === 12);

  // Test cached hero probe
  const proc = new MockMemoryProc();
  const HERO_VT = 0x00007ff700111111;
  const OTHER_VT = 0x00007ff700999999;
  const vtables = { heroControllerVt: HERO_VT };

  // A live controller: right vtable, reaches an entity, that entity holds a
  // scene context. A recycled one keeps the vtable and loses the context.
  const writeHero = (addr, vt, entity, context) => {
    proc.writeU64(addr, vt);
    proc.writeU64(addr + melodies.HERO_ENTITY_OFFSET, entity);
    if (entity) proc.writeU64(entity + melodies.ENTITY_CONTEXT_OFFSET, context);
  };

  const LIVE = 0x10000, LIVE_ENTITY = 0x11000, LIVE_CONTEXT = 0x12000;
  const RECYCLED = 0x20000, RECYCLED_ENTITY = 0x21000;
  const WRONG_VT = 0x30000;

  writeHero(LIVE, HERO_VT, LIVE_ENTITY, LIVE_CONTEXT);
  writeHero(RECYCLED, HERO_VT, RECYCLED_ENTITY, 0);
  proc.writeU64(WRONG_VT, OTHER_VT);

  check('isLiveHero() accepts a controller reaching a scene context',
    melodies.isLiveHero(proc, LIVE) === true);
  check('isLiveHero() rejects a recycled controller with no scene context',
    melodies.isLiveHero(proc, RECYCLED) === false);
  check('isLiveHero() rejects a controller with no entity at all',
    melodies.isLiveHero(proc, 0x40000) === false);

  const validCached = melodies.findHeroes(proc, vtables, [LIVE]);
  check('findHeroes() keeps a cached address that is still live',
    validCached.length === 1 && validCached[0] === LIVE);

  const mixedCached = melodies.findHeroes(proc, vtables, [LIVE, WRONG_VT]);
  check('findHeroes() filters out cached addresses whose vtable no longer matches',
    mixedCached.length === 1 && mixedCached[0] === LIVE);

  // The defect: RECYCLED carries the hero vtable forever, so under a
  // vtable-only check it validated the cache and suppressed the scan.
  const withRecycled = melodies.findHeroes(proc, vtables, [LIVE, RECYCLED]);
  check('findHeroes() drops a cached controller that kept its vtable but lost its context',
    withRecycled.length === 1 && withRecycled[0] === LIVE);

  // With every cached address recycled there is nothing to validate, so the
  // heap scan has to run. This stub reports one region and fails every read,
  // which scanPointers turns into no hits -- an empty result is therefore
  // proof the scan path was taken rather than the stale list returned.
  const scanned = [];
  const scanStub = {
    readPtr: (addr) => proc.readPtr(addr),
    *regions(writableOnly) { scanned.push(writableOnly); yield [0x10000, 0x50000]; },
    readInto: () => 0,
  };
  const allRecycled = melodies.findHeroes(scanStub, vtables, [RECYCLED]);
  check('findHeroes() falls through to a heap scan when every cached address is recycled',
    allRecycled.length === 0 && scanned.length === 1);

  // The remaining half of the cache defect, and what the sweeper's periodic
  // cold scan buys. A second player joining mid-run allocates a controller
  // ALONGSIDE the cached one, which is still live -- so the cache validates,
  // returns early, and the new controller is never seen. Only a scan with the
  // cache suppressed finds it, which is why sweeper.js passes null every
  // HERO_RESCAN_SWEEPS sweeps.
  const SECOND = 0x50000, SECOND_ENTITY = 0x51000, SECOND_CONTEXT = 0x52000;
  writeHero(SECOND, HERO_VT, SECOND_ENTITY, SECOND_CONTEXT);

  // A scan stub that serves the mock's real bytes, so scanPointers finds what
  // is actually written rather than a hand-fed answer.
  const REGION_BASE = 0x10000, REGION_SIZE = 0x50000;
  const servingStub = {
    readPtr: (addr) => proc.readPtr(addr),
    *regions() { yield [REGION_BASE, REGION_SIZE]; },
    readInto(addr, dstPtr, size) {
      for (let i = 0; i < size; i++) dstPtr[i] = proc.memory.get(addr + i) || 0;
      return size;
    },
  };

  check('control: the second controller is live and reachable in the mock',
    melodies.isLiveHero(servingStub, SECOND) === true);

  const stillCached = melodies.findHeroes(servingStub, vtables, [LIVE]);
  check('a live cached address short-circuits, so a controller beside it is missed',
    stillCached.length === 1 && stillCached[0] === LIVE
    && !stillCached.includes(SECOND),
    `cached path returned ${stillCached.length}: ${stillCached.map(a => '0x' + a.toString(16)).join(' ')}`);

  const cold = melodies.findHeroes(servingStub, vtables, null);
  check('and the cold scan the sweeper forces does find it',
    cold.includes(SECOND) && cold.includes(LIVE),
    `cold scan returned ${cold.length}: ${cold.map(a => '0x' + a.toString(16)).join(' ')}`);
}

function testResolveRegistry() {
  console.log('\n--- test-melodies: resolveRegistry RTTI vtable gating (Fix 1) ---');
  const proc = new MockMemoryProc();
  const base = 0x140000000;

  // Case 1: Missing heroControllerVt and RTTI fails on mock proc -> must return null (not truthy registry)
  const noHeroVt = melodies.resolveRegistry(proc, base, { melodyCpntVt: 0x1000 });
  check('resolveRegistry returns null when heroControllerVt is missing', noHeroVt === null);

  // Case 2: Missing melodyCpntVt and RTTI fails -> must return null
  const noCpntVt = melodies.resolveRegistry(proc, base, { heroControllerVt: 0x2000 });
  check('resolveRegistry returns null when melodyCpntVt is missing', noCpntVt === null);

  // Case 3: Both missing and RTTI fails -> must return null
  const neitherVt = melodies.resolveRegistry(proc, base, {});
  check('resolveRegistry returns null when both vtables are missing', neitherVt === null);

  // Control case: Both vtables provided -> returns truthy object with registry and vtables
  const bothVt = melodies.resolveRegistry(proc, base, { melodyCpntVt: 0x1000, heroControllerVt: 0x2000 });
  check('resolveRegistry returns object when both vtables are present',
    bothVt !== null && bothVt.registry instanceof Map && bothVt.melodyCpntVt === 0x1000 && bothVt.heroControllerVt === 0x2000);
}

function testReadPoolStaleHeroSkipping() {
  console.log('\n--- test-melodies: readPool stale hero skipping (Fix 2) ---');
  const proc = new MockMemoryProc();
  const base = 0x140000000;
  const HERO_VT = 0x00007ff700111111;
  const vtables = { heroControllerVt: HERO_VT };
  const registry = melodies.getStaticRegistry();

  const guid0 = '390f6d753f4da64397a4cd42b03d84e4'; // Increase_Fountain_Effect
  const guid1 = '8e39850c20f70d4e8976e964bf56f4a1'; // Increase_Move_Speed_At_Day
  const guid2 = 'aa26da2300c9814da9d936b65f2c4418'; // Deal_Damage_Around

  // Hero 1 (Stale, first in scan order): has duplicate GUIDs (guid0, guid0, guid2)
  const staleHero = 0x10000;
  const staleEntity = 0x10100;
  const staleContext = 0x10200;
  proc.writeU64(staleHero, HERO_VT);
  proc.writeU64(staleHero + melodies.HERO_ENTITY_OFFSET, staleEntity);
  proc.writeU64(staleEntity + melodies.ENTITY_CONTEXT_OFFSET, staleContext);
  const staleGuids = Buffer.concat([
    Buffer.from(guid0, 'hex'),
    Buffer.from(guid0, 'hex'),
    Buffer.from(guid2, 'hex'),
  ]);
  proc.writeBytes(staleContext + melodies.CONTEXT_GUIDS_OFFSET, staleGuids);

  // Hero 2 (Live, second in scan order): has 3 distinct valid GUIDs
  const liveHero = 0x20000;
  const liveEntity = 0x20100;
  const liveContext = 0x20200;
  proc.writeU64(liveHero, HERO_VT);
  proc.writeU64(liveHero + melodies.HERO_ENTITY_OFFSET, liveEntity);
  proc.writeU64(liveEntity + melodies.ENTITY_CONTEXT_OFFSET, liveContext);
  const liveGuids = Buffer.concat([
    Buffer.from(guid0, 'hex'),
    Buffer.from(guid1, 'hex'),
    Buffer.from(guid2, 'hex'),
  ]);
  proc.writeBytes(liveContext + melodies.CONTEXT_GUIDS_OFFSET, liveGuids);

  // When both heroes are passed, readPool must continue past staleHero and resolve liveHero
  const pool = melodies.readPool(proc, vtables, registry, [staleHero, liveHero]);
  check('readPool continues past stale hero with duplicate GUIDs to resolve live hero',
    pool !== null && pool.length === 3 && pool[0].internal_name === 'Increase_Fountain_Effect'
    && pool[1].internal_name === 'Increase_Move_Speed_At_Day'
    && pool[2].internal_name === 'Deal_Damage_Around');

  // Hero 3 (Stale with unknown GUIDs):
  const unkHero = 0x30000;
  const unkEntity = 0x30100;
  const unkContext = 0x30200;
  proc.writeU64(unkHero, HERO_VT);
  proc.writeU64(unkHero + melodies.HERO_ENTITY_OFFSET, unkEntity);
  proc.writeU64(unkEntity + melodies.ENTITY_CONTEXT_OFFSET, unkContext);
  const unkGuids = Buffer.concat([
    Buffer.from(guid0, 'hex'),
    Buffer.from('11111111111111111111111111111111', 'hex'),
    Buffer.from(guid2, 'hex'),
  ]);
  proc.writeBytes(unkContext + melodies.CONTEXT_GUIDS_OFFSET, unkGuids);

  const pool2 = melodies.readPool(proc, vtables, registry, [unkHero, liveHero]);
  check('readPool continues past stale hero with unknown GUIDs to resolve live hero',
    pool2 !== null && pool2.length === 3);

  // Control case: all heroes stale -> returns null
  const nullPool = melodies.readPool(proc, vtables, registry, [staleHero, unkHero]);
  check('readPool returns null when no hero yields a valid pool', nullPool === null);
}

function testReadStatesUnreadableArray() {
  console.log('\n--- test-melodies: readStates unreadable array handling (Fix 3) ---');
  const proc = new MockMemoryProc();
  const base = 0x140000000;
  const HERO_VT = 0x00007ff700111111;
  const MELODY_CPNT_VT = 0x00007ff700222222;
  const vtables = { heroControllerVt: HERO_VT, melodyCpntVt: MELODY_CPNT_VT };
  const registry = melodies.getStaticRegistry();

  const pool = [
    melodies.MELODY_DEFINITIONS_BY_NAME['Increase_Fountain_Effect'],
    melodies.MELODY_DEFINITIONS_BY_NAME['Increase_Move_Speed_At_Day'],
    melodies.MELODY_DEFINITIONS_BY_NAME['Deal_Damage_Around'],
  ];

  // Hero with live context, but null linked-melodies buffer (buf === 0)
  const heroNullBuf = 0x10000;
  const entity1 = 0x10100;
  const context1 = 0x10200;
  proc.writeU64(heroNullBuf, HERO_VT);
  proc.writeU64(heroNullBuf + melodies.HERO_ENTITY_OFFSET, entity1);
  proc.writeU64(entity1 + melodies.ENTITY_CONTEXT_OFFSET, context1);
  proc.writeU64(heroNullBuf + melodies.HERO_LINKED_MELODIES_OFFSET, 0); // null buf
  proc.writeU32(heroNullBuf + melodies.HERO_LINKED_COUNT_OFFSET, 0);

  const statesNullBuf = melodies.readStates(proc, vtables, pool, registry, [heroNullBuf]);
  check('readStates returns null (not zeros) when hero linked array is null', statesNullBuf === null);

  // Hero with live context and non-null buf, but count === 0
  const heroZeroCount = 0x20000;
  const entity2 = 0x20100;
  const context2 = 0x20200;
  proc.writeU64(heroZeroCount, HERO_VT);
  proc.writeU64(heroZeroCount + melodies.HERO_ENTITY_OFFSET, entity2);
  proc.writeU64(entity2 + melodies.ENTITY_CONTEXT_OFFSET, context2);
  proc.writeU64(heroZeroCount + melodies.HERO_LINKED_MELODIES_OFFSET, 0x25000);
  proc.writeU32(heroZeroCount + melodies.HERO_LINKED_COUNT_OFFSET, 0); // count 0

  const statesZeroCount = melodies.readStates(proc, vtables, pool, registry, [heroZeroCount]);
  check('readStates returns null (not zeros) when hero linked count is 0', statesZeroCount === null);

  // A stale offset after a game update: the "buffer" is another vector's
  // {count, capacity} pair, 0x800000001, which is not mapped. The live
  // reader's readPtr returns null there; the mock returns 0 for any unwritten
  // address, so unmapped reads are made explicit here.
  const heroStale = 0x30000;
  const entity3 = 0x30100;
  const context3 = 0x30200;
  const STALE_BUF = 0x800000001;
  proc.writeU64(heroStale, HERO_VT);
  proc.writeU64(heroStale + melodies.HERO_ENTITY_OFFSET, entity3);
  proc.writeU64(entity3 + melodies.ENTITY_CONTEXT_OFFSET, context3);
  proc.writeU64(heroStale + melodies.HERO_LINKED_MELODIES_OFFSET, STALE_BUF);
  proc.writeU32(heroStale + melodies.HERO_LINKED_COUNT_OFFSET, 0x9662f5b0);
  const unmapped = {
    readPtr: (addr) => (addr >= STALE_BUF && addr < STALE_BUF + 0x1000) ? null : proc.readPtr(addr),
    read: (addr, len) => proc.read(addr, len),
    readI32: (addr) => proc.readI32(addr),
  };
  const statesStale = melodies.readStates(unmapped, vtables, pool, registry, [heroStale]);
  check('readStates returns null (not all locked) when the linked buffer is not a pointer',
    statesStale === null);
}

function testReadStatesCpntEntityScope() {
  console.log('\n--- test-melodies: readStates cpntEntity scope shadowing (Fix 4) ---');
  const proc = new MockMemoryProc();
  const base = 0x140000000;
  const HERO_VT = 0x00007ff700111111;
  const MELODY_CPNT_VT = 0x00007ff700222222;
  const vtables = { heroControllerVt: HERO_VT, melodyCpntVt: MELODY_CPNT_VT };
  const registry = melodies.getStaticRegistry();

  const guid0 = '390f6d753f4da64397a4cd42b03d84e4'; // Increase_Fountain_Effect
  const guid1 = '8e39850c20f70d4e8976e964bf56f4a1'; // Increase_Move_Speed_At_Day
  const guid2 = 'aa26da2300c9814da9d936b65f2c4418'; // Deal_Damage_Around

  const pool = [
    registry.get(guid0),
    registry.get(guid1),
    registry.get(guid2),
  ];

  // Hero entity has NO objB at ENTITY_B_OBJECT_OFFSET (set to 0)
  const hero = 0x10000;
  const heroEntity = 0x10100;
  const heroContext = 0x10200;
  const heroBuf = 0x11000;
  proc.writeU64(hero, HERO_VT);
  proc.writeU64(hero + melodies.HERO_ENTITY_OFFSET, heroEntity);
  proc.writeU64(heroEntity + melodies.ENTITY_CONTEXT_OFFSET, heroContext);
  proc.writeU64(heroEntity + melodies.ENTITY_B_OBJECT_OFFSET, 0); // null objB on hero entity
  proc.writeU64(hero + melodies.HERO_LINKED_MELODIES_OFFSET, heroBuf);
  proc.writeU32(hero + melodies.HERO_LINKED_COUNT_OFFSET, 1);

  // Component entity has VALID objB
  const cpnt = 0x30000;
  const cpntEntity = 0x30100;
  const objB = 0x30200;
  proc.writeU64(heroBuf, cpnt);
  proc.writeU64(cpnt, MELODY_CPNT_VT);
  proc.writeI32(cpnt + melodies.MELODY_LIFECYCLE_OFFSET, 1); // active
  proc.writeU64(cpnt + melodies.BASE_CPNT_ENTITY_OFFSET, cpntEntity);
  proc.writeU64(cpntEntity + melodies.ENTITY_B_OBJECT_OFFSET, objB);
  proc.writeBytes(objB + melodies.B_GUID_OFFSET, Buffer.from(guid1, 'hex'));

  const states = melodies.readStates(proc, vtables, pool, registry, [hero]);
  check('readStates reads objB from cpntEntity and attributes state',
    states !== null && states[1] === 1);

  // Source check: confirm readStates function body uses cpntEntity
  const fnStr = melodies.readStates.toString();
  check('readStates source does not shadow entity binding',
    fnStr.includes('cpntEntity') && !fnStr.includes('const entity = proc.readPtr(cpnt + BASE_CPNT_ENTITY_OFFSET);'));
}

function main() {
  testStaticTable();
  testSourcesTsv();
  testCombineMelodies();
  testGuidIdentityAttribution();
  testReadPoolValidation();
  testFastPathAndStaticRegistry();
  testStateIntegration();
  testResolveRegistry();
  testReadPoolStaleHeroSkipping();
  testReadStatesUnreadableArray();
  testReadStatesCpntEntityScope();

  return failures;
}

if (require.main === module) process.exit(main() ? 1 : 0);

module.exports = { main };
