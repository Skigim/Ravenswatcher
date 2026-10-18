'use strict';
// Offline unit test suite for the Placed Tiles reader module (tiles.ts).
// Tests layout walking, pointer dereferencing, and edge cases using an in-memory mock process:
//   1. RTTI vtable resolution and caching
//   2. String triple decoding and length high-bit masking (0x80000000 | len)
//   3. Placed vs unplaced discrimination (+0x10 null and +0x20 reading -1.0f)
//   4. Slice whose size descriptor disagrees with its index (classification by size, not index)
//   5. 6-slice category vector (Avalon map support via spawner + 0x118 count)
//   6. Sublevel vector carrying a mix of placed and unplaced entries (spawner + 0x120)
//   7. Reward selectors reading (+0x78 resource string, no coordinates)
//   8. Tile kind (oCDtTileKind* at slot + 0x50) decoding
//   9. tilesChanged equality and change detection checks
//  10. findInstances combined 2-target scan discovery

const tiles = require('../tiles');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

// ---- In-memory mock process for offline testing ----------------------------
class MockMemoryProc {
  constructor() {
    this.memory = new Map();
    this.closed = false;
  }

  isAlive() {
    return !this.closed;
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

  writeFloat(addr, val) {
    const buf = Buffer.alloc(4);
    buf.writeFloatLE(val, 0);
    for (let i = 0; i < 4; i++) this.memory.set(addr + i, buf[i]);
  }

  writeBytes(addr, buf) {
    for (let i = 0; i < buf.length; i++) this.memory.set(addr + i, buf[i]);
  }

  writeLatin1String(addr, str) {
    const buf = Buffer.from(str + '\0', 'latin1');
    this.writeBytes(addr, buf);
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
    if (low === null || high === null) return null;
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
    yield [0x10000, 0x100000];
  }

  readInto(addr, dstPtr, size) {
    for (let i = 0; i < size; i++) {
      dstPtr[i] = this.memory.get(addr + i) || 0;
    }
    return size;
  }

  close() {
    this.closed = true;
  }
}

// Helpers for writing synthetic structures in mock memory
function writeStringTriple(proc, tripleAddr, strAddr, str, setHighBit = false) {
  proc.writeU64(tripleAddr, strAddr);
  let len = Buffer.byteLength(str, 'latin1');
  if (setHighBit) len = (len | 0x80000000) >>> 0;
  proc.writeU32(tripleAddr + 8, len);
  proc.writeU32(tripleAddr + 12, 0); // flags
  proc.writeLatin1String(strAddr, str);
}

function writeSizeDescriptor(proc, sizeAddr, width, height) {
  proc.writeI32(sizeAddr + tiles.SIZE_WIDTH_OFFSET, width);
  proc.writeI32(sizeAddr + tiles.SIZE_HEIGHT_OFFSET, height);
}

function writeSlotSettings(proc, settingsAddr, sizeAddr) {
  proc.writeU64(settingsAddr + tiles.SETTINGS_SIZE_OFFSET, sizeAddr);
}

function writeTileKind(proc, kindAddr, strAddr, kindStr) {
  writeStringTriple(proc, kindAddr + tiles.RESOURCE_NAME_OFFSET, strAddr, kindStr);
}

function writeTileSlot(proc, slotAddr, {
  resourceAddr = null,
  entityAddr = 0x7ff62000,
  weight = 1.0,
  settingsAddr = null,
  kindAddr = null,
} = {}) {
  if (settingsAddr) proc.writeU64(slotAddr + tiles.SLOT_SETTINGS_OFFSET, settingsAddr);
  if (resourceAddr) proc.writeU64(slotAddr + tiles.SLOT_RESOURCE_OFFSET, resourceAddr);
  if (entityAddr) proc.writeU64(slotAddr + tiles.SLOT_ENTITY_OFFSET, entityAddr);
  proc.writeFloat(slotAddr + tiles.SLOT_WEIGHT_OFFSET, weight);
  if (kindAddr) proc.writeU64(slotAddr + tiles.SLOT_TILE_KIND_OFFSET, kindAddr);
}

// ============================================================================
// Test cases
// ============================================================================

function testVtableResolution() {
  console.log('\n--- test-tiles: vtable resolution and caching ---');

  const proc = new MockMemoryProc();
  const base = 0x7ff600000000;

  // Unresolved when mock has no PE image headers
  const empty = tiles.resolveVtables(proc, base, {});
  check('resolveVtables returns null when vtables cannot be resolved from PE', empty === null);

  // Cached vtables pass through directly without scan
  const cached = { spawnerVt: 0x7ff61000, selectorVt: 0x7ff62000 };
  const res = tiles.resolveVtables(proc, base, cached);
  check('resolveVtables passes through already-cached vtables',
    res !== null && res.spawnerVt === 0x7ff61000 && res.selectorVt === 0x7ff62000);

  // Mutates caller-owned object
  const toMutate = { spawnerVt: 0x7ff63000, selectorVt: 0x7ff64000 };
  tiles.resolveVtables(proc, base, toMutate);
  check('caller-owned vtables object is preserved and mutated',
    toMutate.spawnerVt === 0x7ff63000 && toMutate.selectorVt === 0x7ff64000);
}

function testStringTripleAndHighBit() {
  console.log('\n--- test-tiles: string triple decoding & length high-bit masking ---');

  const proc = new MockMemoryProc();

  // Normal string triple without high bit
  const triple1 = 0x20000;
  const str1 = 0x20100;
  writeStringTriple(proc, triple1, str1, '40x40_Windmill_Farm_Undead_Hogs_Camp', false);
  const read1 = tiles.readStringTriple(proc, triple1);
  check('readStringTriple decodes normal string', read1 === '40x40_Windmill_Farm_Undead_Hogs_Camp');

  // String triple with static-literal high bit set (0x80000000 | length)
  const triple2 = 0x20200;
  const str2 = 0x20300;
  writeStringTriple(proc, triple2, str2, 'Baba_Yaga_Eye_Storm_Island', true);
  // Verify length in raw memory has bit 31 set
  const rawLen = proc.readU32(triple2 + 8);
  check('high bit 0x80000000 is present in raw length field', (rawLen & 0x80000000) !== 0);
  const read2 = tiles.readStringTriple(proc, triple2);
  check('readStringTriple successfully strips high bit and decodes string',
    read2 === 'Baba_Yaga_Eye_Storm_Island');

  // Guard against non-printable ASCII or null pointers
  check('readStringTriple returns null on 0 address', tiles.readStringTriple(proc, 0) === null);
  const triple3 = 0x20400;
  proc.writeU64(triple3, 0x20500);
  proc.writeU32(triple3 + 8, 4);
  proc.writeBytes(0x20500, Buffer.from([0x01, 0x02, 0x03, 0x04]));
  check('readStringTriple rejects non-printable ASCII bytes', tiles.readStringTriple(proc, triple3) === null);
}

function testPlacedVsUnplacedDiscrimination() {
  console.log('\n--- test-tiles: placed vs unplaced discrimination ---');

  const proc = new MockMemoryProc();

  // Case A: Unplaced slot -- resource (+0x10) is null, weight (+0x20) is -1.0f (0xBF800000)
  const unplacedSlotAddr = 0x30000;
  writeTileSlot(proc, unplacedSlotAddr, {
    resourceAddr: null,
    entityAddr: null,
    weight: -1.0,
  });
  const unplacedRead = tiles.readTileSlot(proc, unplacedSlotAddr, 'category', 0);
  check('unplaced slot (+0x10 null, +0x20 is -1.0f) is rejected as null', unplacedRead === null);

  // Case B: Slot with valid resource address but weight -1.0f
  const weightUnplacedAddr = 0x30100;
  const resAddr = 0x30200;
  writeStringTriple(proc, resAddr + tiles.RESOURCE_NAME_OFFSET, 0x30300, 'Test_Tile_Negative_Weight');
  writeTileSlot(proc, weightUnplacedAddr, {
    resourceAddr: resAddr,
    entityAddr: 0x7ff62000,
    weight: -1.0,
  });
  const weightRead = tiles.readTileSlot(proc, weightUnplacedAddr, 'category', 0);
  check('slot with weight -1.0f is rejected as unplaced even if resource is present', weightRead === null);

  // Case C: Placed slot -- valid resource pointer and positive generation score weight
  const placedSlotAddr = 0x30400;
  const placedResAddr = 0x30500;
  writeStringTriple(proc, placedResAddr + tiles.RESOURCE_NAME_OFFSET, 0x30600, '64x64_Windmill_Hill_Neutral_Camp');
  writeTileSlot(proc, placedSlotAddr, {
    resourceAddr: placedResAddr,
    entityAddr: 0x7ff62000,
    weight: 0.5,
  });
  const placedRead = tiles.readTileSlot(proc, placedSlotAddr, 'category', 0);
  check('placed slot (+0x10 non-null, weight 0.5f) is accepted',
    placedRead !== null && placedRead.name === '64x64_Windmill_Hill_Neutral_Camp');
}

function testCategoryIndexVsSizeDescriptor() {
  console.log('\n--- test-tiles: size descriptor classification vs category index ---');

  const proc = new MockMemoryProc();

  // Test a slice whose size descriptor disagrees with its index:
  // E.g., on Storm Island large 40x40 tiles are placed at slice index 0 instead of 2.
  const slotAddr = 0x40000;
  const resAddr = 0x40100;
  const settingsAddr = 0x40200;
  const sizeAddr = 0x40300;

  writeStringTriple(proc, resAddr + tiles.RESOURCE_NAME_OFFSET, 0x40400, 'Storm_Island_Camp_No_Prefix');
  writeSizeDescriptor(proc, sizeAddr, 40, 40);
  writeSlotSettings(proc, settingsAddr, sizeAddr);
  writeTileSlot(proc, slotAddr, {
    resourceAddr: resAddr,
    settingsAddr: settingsAddr,
    weight: 1.0,
  });

  // Read with categoryIndex = 0 (which on Dark Hills was 3x3, but here has 40x40 size descriptor)
  const tile = tiles.readTileSlot(proc, slotAddr, 'category', 0);

  check('tile was successfully read', tile !== null);
  check('tile categoryIndex is 0', tile && tile.categoryIndex === 0);
  check('tile width classified from size descriptor as 40', tile && tile.width === 40);
  check('tile height classified from size descriptor as 40', tile && tile.height === 40);
  check('tile name without size prefix is preserved', tile && tile.name === 'Storm_Island_Camp_No_Prefix');
}

function testSixSliceCategoryVector() {
  console.log('\n--- test-tiles: 6-slice category vector (Avalon map support) ---');

  const proc = new MockMemoryProc();
  const spawnerAddr = 0x50000;
  const catVecPtr = 0x51000;

  // Set spawner category vector pointer and count = 6 (Avalon)
  proc.writeU64(spawnerAddr + tiles.SPAWNER_CATEGORY_VECTOR_OFFSET, catVecPtr);
  proc.writeU32(spawnerAddr + tiles.SPAWNER_CATEGORY_COUNT_OFFSET, 6);
  proc.writeU32(spawnerAddr + tiles.SPAWNER_CATEGORY_CAP_OFFSET, 6);

  // Set sublevel count to 0 for this test
  proc.writeU64(spawnerAddr + tiles.SPAWNER_SUBLEVEL_VECTOR_OFFSET, 0);
  proc.writeU32(spawnerAddr + tiles.SPAWNER_SUBLEVEL_COUNT_OFFSET, 0);

  // Sizes for Avalon's 6 slices: 3x3, 6x6, 40x40, 64x64, 9x9, 20x20
  const sliceSizes = [
    [3, 3],
    [6, 6],
    [40, 40],
    [64, 64],
    [9, 9],
    [20, 20],
  ];

  for (let c = 0; c < 6; c++) {
    const sliceAddr = catVecPtr + c * tiles.CATEGORY_SLICE_STRIDE;
    const slotsPtr = 0x52000 + c * 0x1000;
    proc.writeU64(sliceAddr + tiles.CATEGORY_SLICE_DATA_OFFSET, slotsPtr);
    proc.writeU32(sliceAddr + tiles.CATEGORY_SLICE_COUNT_OFFSET, 1);
    proc.writeU32(sliceAddr + tiles.CATEGORY_SLICE_CAP_OFFSET, 1);

    const slotAddr = slotsPtr;
    const resAddr = slotsPtr + 0x200;
    const settingsAddr = slotsPtr + 0x400;
    const sizeAddr = slotsPtr + 0x600;

    const [w, h] = sliceSizes[c];
    writeStringTriple(proc, resAddr + tiles.RESOURCE_NAME_OFFSET, slotsPtr + 0x800, `Avalon_Slice_${c}_Tile`);
    writeSizeDescriptor(proc, sizeAddr, w, h);
    writeSlotSettings(proc, settingsAddr, sizeAddr);
    writeTileSlot(proc, slotAddr, {
      resourceAddr: resAddr,
      settingsAddr: settingsAddr,
      weight: 1.0,
    });
  }

  const result = tiles.readPlacedTiles(proc, 0x7ff600000000, null, { spawnerAddr, selectorAddrs: [] });

  check('readPlacedTiles returns array', Array.isArray(result));
  check('all 6 slices of Avalon vector were read', result && result.length === 6);
  if (result) {
    for (let c = 0; c < 6; c++) {
      const t = result[c];
      const [expectedW, expectedH] = sliceSizes[c];
      check(`slice ${c} tile matches categoryIndex ${c}`, t && t.categoryIndex === c);
      check(`slice ${c} tile matches width ${expectedW}`, t && t.width === expectedW);
      check(`slice ${c} tile matches height ${expectedH}`, t && t.height === expectedH);
    }
  }
}

function testSublevelVectorMix() {
  console.log('\n--- test-tiles: sublevel vector carrying a mix of placed and unplaced entries ---');

  const proc = new MockMemoryProc();
  const spawnerAddr = 0x60000;
  const subVecPtr = 0x61000;

  // Category vector is empty for this test
  proc.writeU64(spawnerAddr + tiles.SPAWNER_CATEGORY_VECTOR_OFFSET, 0);
  proc.writeU32(spawnerAddr + tiles.SPAWNER_CATEGORY_COUNT_OFFSET, 0);

  // Sublevel vector has 5 entries (Dark Hills: Thieves stash underground + Jack arena placed, 3 unplaced)
  proc.writeU64(spawnerAddr + tiles.SPAWNER_SUBLEVEL_VECTOR_OFFSET, subVecPtr);
  proc.writeU32(spawnerAddr + tiles.SPAWNER_SUBLEVEL_COUNT_OFFSET, 5);
  proc.writeU32(spawnerAddr + tiles.SPAWNER_SUBLEVEL_CAP_OFFSET, 5);

  // Slot 0: Placed
  const slot0 = subVecPtr + 0 * tiles.TILE_SLOT_STRIDE;
  const res0 = 0x62000;
  writeStringTriple(proc, res0 + tiles.RESOURCE_NAME_OFFSET, 0x62100, 'DarkHill_Thieves_Stashes_Combat_Room_Underground_01');
  writeTileSlot(proc, slot0, { resourceAddr: res0, weight: 1.0 });

  // Slot 1: Unplaced (null resource, weight -1.0f)
  const slot1 = subVecPtr + 1 * tiles.TILE_SLOT_STRIDE;
  writeTileSlot(proc, slot1, { resourceAddr: null, weight: -1.0 });

  // Slot 2: Unplaced (null resource, weight -1.0f)
  const slot2 = subVecPtr + 2 * tiles.TILE_SLOT_STRIDE;
  writeTileSlot(proc, slot2, { resourceAddr: null, weight: -1.0 });

  // Slot 3: Placed
  const slot3 = subVecPtr + 3 * tiles.TILE_SLOT_STRIDE;
  const res3 = 0x63000;
  writeStringTriple(proc, res3 + tiles.RESOURCE_NAME_OFFSET, 0x63100, '64x64_JackQuest_OgreArena');
  writeTileSlot(proc, slot3, { resourceAddr: res3, weight: 1.0 });

  // Slot 4: Unplaced (null resource, weight -1.0f)
  const slot4 = subVecPtr + 4 * tiles.TILE_SLOT_STRIDE;
  writeTileSlot(proc, slot4, { resourceAddr: null, weight: -1.0 });

  const result = tiles.readPlacedTiles(proc, 0x7ff600000000, null, { spawnerAddr, selectorAddrs: [] });

  check('readPlacedTiles returns array', Array.isArray(result));
  check('exactly 2 placed sublevels returned out of 5 slots', result && result.length === 2);
  if (result && result.length === 2) {
    check('slot 0 name matches', result[0].name === 'DarkHill_Thieves_Stashes_Combat_Room_Underground_01');
    check('slot 0 source is sublevel', result[0].source === 'sublevel');
    check('slot 0 categoryIndex is null', result[0].categoryIndex === null);
    check('slot 3 name matches', result[1].name === '64x64_JackQuest_OgreArena');
    check('slot 3 source is sublevel', result[1].source === 'sublevel');
    check('slot 3 categoryIndex is null', result[1].categoryIndex === null);
  }
}

function testRewardSelectors() {
  console.log('\n--- test-tiles: reward selectors reading ---');

  const proc = new MockMemoryProc();
  const spawnerAddr = 0x70000;

  // Category & sublevel empty
  proc.writeU64(spawnerAddr + tiles.SPAWNER_CATEGORY_VECTOR_OFFSET, 0);
  proc.writeU32(spawnerAddr + tiles.SPAWNER_CATEGORY_COUNT_OFFSET, 0);
  proc.writeU64(spawnerAddr + tiles.SPAWNER_SUBLEVEL_VECTOR_OFFSET, 0);
  proc.writeU32(spawnerAddr + tiles.SPAWNER_SUBLEVEL_COUNT_OFFSET, 0);

  const sel1 = 0x71000;
  const res1 = 0x71100;
  writeStringTriple(proc, res1 + tiles.RESOURCE_NAME_OFFSET, 0x71200, 'Baba_Yaga_Eye_Storm_Island');
  proc.writeU64(sel1 + tiles.SELECTOR_RESOURCE_OFFSET, res1);

  const sel2 = 0x72000;
  const res2 = 0x72100;
  writeStringTriple(proc, res2 + tiles.RESOURCE_NAME_OFFSET, 0x72200, 'Storm_Island_Basic_Chest_T1');
  proc.writeU64(sel2 + tiles.SELECTOR_RESOURCE_OFFSET, res2);

  const instances = {
    spawnerAddr: spawnerAddr,
    selectorAddrs: [sel1, sel2],
  };

  const result = tiles.readPlacedTiles(proc, 0x7ff600000000, null, instances);

  check('readPlacedTiles returns array', Array.isArray(result));
  check('both selectors were read', result && result.length === 2);
  if (result && result.length === 2) {
    check('selector 1 name matches', result[0].name === 'Baba_Yaga_Eye_Storm_Island');
    check('selector 1 source is selector', result[0].source === 'selector');
    check('selector 1 width is null', result[0].width === null);
    check('selector 1 categoryIndex is null', result[0].categoryIndex === null);
    check('selector 2 name matches', result[1].name === 'Storm_Island_Basic_Chest_T1');
    check('selector 2 source is selector', result[1].source === 'selector');
  }
}

function testTileKindReading() {
  console.log('\n--- test-tiles: tile_kind classification tag reading ---');

  const proc = new MockMemoryProc();
  const slotAddr = 0x80000;
  const resAddr = 0x80100;
  const kindAddr = 0x80200;

  writeStringTriple(proc, resAddr + tiles.RESOURCE_NAME_OFFSET, 0x80300, '40x40_Old_Shipyard_CrystalField');
  writeTileKind(proc, kindAddr, 0x80400, 'Distance');

  writeTileSlot(proc, slotAddr, {
    resourceAddr: resAddr,
    kindAddr: kindAddr,
    weight: 1.0,
  });

  const tile = tiles.readTileSlot(proc, slotAddr, 'category', 2);
  check('tile was read', tile !== null);

  // The probe still decodes a +0xA0 triple when one is genuinely there, which
  // is what the bench relies on to keep testing the offset.
  check('readTileKind decodes a well-formed +0xA0 triple',
    tiles.readTileKind(proc, kindAddr) === 'Distance');

  // But the roster does not carry it. Measured live on Dark Hills 2026-09-06,
  // +0xA0 resolved on 1 of 11 distinct oCDtTileKind objects and returned "F",
  // so the offset is wrong and the field would be junk once per eleven. This
  // asserts the product path stays null even when a decodable triple is
  // present -- if someone rewires readTileSlot to read it again, this fails.
  check('roster carries no kind while the offset is unresolved',
    tile && !('kind' in tile));
}

function testTilesChanged() {
  console.log('\n--- test-tiles: tilesChanged equality checks ---');

  const tileA = {
    name: '40x40_Windmill_Farm_Undead_Hogs_Camp',
    width: 40,
    height: 40,
    source: 'category',
    categoryIndex: 2,
  };

  const tileB = {
    name: '64x64_Windmill_Hill_Neutral_Camp',
    width: 64,
    height: 64,
    source: 'category',
    categoryIndex: 3,
  };

  const list1 = [tileA, tileB];
  const list2 = [{ ...tileA }, { ...tileB }];

  check('tilesChanged(null, null) is false', tiles.tilesChanged(null, null) === false);
  check('tilesChanged(null, list1) is true', tiles.tilesChanged(null, list1) === true);
  check('tilesChanged(list1, null) is true', tiles.tilesChanged(list1, null) === true);
  check('tilesChanged(list1, list1) is false [identical reference]', tiles.tilesChanged(list1, list1) === false);
  check('tilesChanged(list1, list2) is false [identical contents]', tiles.tilesChanged(list1, list2) === false);

  const nameChanged = [{ ...tileA, name: 'Different_Name' }, tileB];
  check('tilesChanged returns true on name change', tiles.tilesChanged(list1, nameChanged) === true);

  const widthChanged = [{ ...tileA, width: 64 }, tileB];
  check('tilesChanged returns true on width change', tiles.tilesChanged(list1, widthChanged) === true);

  const heightChanged = [{ ...tileA, height: 64 }, tileB];
  check('tilesChanged returns true on height change', tiles.tilesChanged(list1, heightChanged) === true);

  const sourceChanged = [{ ...tileA, source: 'sublevel' }, tileB];
  check('tilesChanged returns true on source change', tiles.tilesChanged(list1, sourceChanged) === true);

  const lengthChanged = [tileA];
  check('tilesChanged returns true on length change', tiles.tilesChanged(list1, lengthChanged) === true);

  const tierChanged = [{ ...tileA, tier: 0.5 }, tileB];
  check('tilesChanged returns true on tier change', tiles.tilesChanged(list1, tierChanged) === true);
}

function testFindInstances() {
  console.log('\n--- test-tiles: findInstances combined scan discovery ---');

  const proc = new MockMemoryProc();
  const spawnerVt = 0x7ff600100000;
  const selectorVt = 0x7ff600200000;

  // Place a pointer to spawnerVt at 0x20000
  proc.writeU64(0x20000, spawnerVt);
  // Place pointers to selectorVt at 0x25000 and 0x26000
  proc.writeU64(0x25000, selectorVt);
  proc.writeU64(0x26000, selectorVt);

  const vtables = { spawnerVt, selectorVt };
  const disc = tiles.findInstances(proc, vtables);

  check('findInstances discovered spawner instance', disc.spawnerAddr === 0x20000);
  check('findInstances discovered both selector instances',
    disc.selectorAddrs.length === 2 &&
    disc.selectorAddrs.includes(0x25000) &&
    disc.selectorAddrs.includes(0x26000));
}

function testFindSpawnerByChain() {
  console.log('\n--- test-tiles: findSpawnerByChain pointer chain walking ---');

  const proc = new MockMemoryProc();
  const base = 0x7ff600000000;
  const spawnerVt = 0x7ff600100000;
  const spawnerGoVt = 0x7ff600200000;
  const gameSceneVt = 0x7ff600300000;
  const gameVt = 0x7ff600400000;

  const vtables = {
    spawnerVt,
    spawnerGoVts: new Set([spawnerGoVt]),
    gameSceneVts: new Set([gameSceneVt]),
    gameVts: new Set([gameVt]),
  };

  const sceneAddr = 0x20000;
  const gameAddr = 0x15000;
  const level1Addr = 0x30000;
  const level2Addr = 0x40000;
  const goArrAddr = 0x50000;
  const go0Addr = 0x60000;
  const go1Addr = 0x70000;
  const entAddr = 0x80000;
  const cpntArrAddr = 0x90000;
  const cpnt0Addr = 0x91000;
  const spawnerAddr = 0x92000;

  // Candidate 1 root
  proc.writeU64(base + 0x143ef70, sceneAddr);
  // Candidate 2 root
  proc.writeU64(base + 0x1475900, gameAddr);

  // Game object
  proc.writeU64(gameAddr, gameVt);
  proc.writeU64(gameAddr + 0x18, sceneAddr);

  // Scene object
  proc.writeU64(sceneAddr, gameSceneVt);
  proc.writeU64(sceneAddr + 0x658, level1Addr);

  // Level 1 (does not have target)
  proc.writeU64(level1Addr + 0x10, level2Addr);
  proc.writeU64(level1Addr + 0x80, 0);
  proc.writeU32(level1Addr + 0x88, 0);

  // Level 2 (has target)
  proc.writeU64(level2Addr + 0x10, 0);
  proc.writeU64(level2Addr + 0x80, goArrAddr);
  proc.writeU32(level2Addr + 0x88, 2);

  // GO array
  proc.writeU64(goArrAddr, go0Addr);
  proc.writeU64(goArrAddr + 8, go1Addr);

  // GO 0: wrong vtable
  proc.writeU64(go0Addr, 0x7ff699999);

  // GO 1: spawner GO
  proc.writeU64(go1Addr, spawnerGoVt);
  proc.writeU64(go1Addr + 0x128, entAddr);

  // Entity
  proc.writeU64(entAddr + 0x190, cpntArrAddr);
  proc.writeU32(entAddr + 0x198, 2);

  // Cpnt array
  proc.writeU64(cpntArrAddr, cpnt0Addr);
  proc.writeU64(cpntArrAddr + 8, spawnerAddr);

  // Cpnt 0: wrong vtable
  proc.writeU64(cpnt0Addr, 0x7ff688888);

  // Cpnt 1: spawner vtable
  proc.writeU64(spawnerAddr, spawnerVt);

  // Test Candidate 1 (Direct scene)
  const res1 = tiles.findSpawnerByChain(proc, base, { vtables, staticRva: 0x143ef70, useDirectScene: true });
  check('Candidate 1 returns ok: true', res1.ok === true);
  check('Candidate 1 resolves spawner address', res1.spawner === spawnerAddr);
  check('Candidate 1 resolves entity address', res1.entity === entAddr);
  check('Candidate 1 resolves level address', res1.level === level2Addr);
  check('Candidate 1 resolves go address and index', res1.go === go1Addr && res1.goIndex === 1);
  check('Candidate 1 resolves component index', res1.cpntIndex === 1);
  check('Candidate 1 tracks levelsSeen and gosTried', res1.levelsSeen === 2 && res1.gosTried === 1);

  // Test Candidate 2 (Game singleton)
  const res2 = tiles.findSpawnerByChain(proc, base, { vtables, staticRva: 0x1475900, useDirectScene: false });
  check('Candidate 2 returns ok: true', res2.ok === true);
  check('Candidate 2 resolves spawner address', res2.spawner === spawnerAddr);
  check('Candidate 2 resolves game and scene addresses', res2.game === gameAddr && res2.scene === sceneAddr);

  // Test export alias

  // Test helper functions isA and findByVtable
  check('isA matches valid vtable', tiles.isA(proc, spawnerAddr, new Set([spawnerVt])) === true);
  check('isA rejects non-matching vtable', tiles.isA(proc, cpnt0Addr, new Set([spawnerVt])) === false);
  check('isA rejects null address', tiles.isA(proc, null, new Set([spawnerVt])) === false);

  const foundCpnt = tiles.findByVtable(proc, cpntArrAddr, 2, new Set([spawnerVt]));
  check('findByVtable finds component and index', foundCpnt !== null && foundCpnt.addr === spawnerAddr && foundCpnt.index === 1);
}

function testFindSpawnerByChainDiagnostics() {
  console.log('\n--- test-tiles: findSpawnerByChain diagnostic error handling ---');

  const base = 0x7ff600000000;
  const spawnerVt = 0x7ff600100000;
  const spawnerGoVt = 0x7ff600200000;
  const gameSceneVt = 0x7ff600300000;
  const gameVt = 0x7ff600400000;

  const vtables = {
    spawnerVt,
    spawnerGoVts: new Set([spawnerGoVt]),
    gameSceneVts: new Set([gameSceneVt]),
    gameVts: new Set([gameVt]),
  };

  // 1. Static root null
  const procNull = new MockMemoryProc();
  const resNull = tiles.findSpawnerByChain(procNull, base, { vtables, staticRva: 0x143ef70, useDirectScene: true });
  check('Null root returns ok: false', resNull.ok === false);
  check('Null root diagnostic names static pointer', typeof resNull.diagnostic === 'string' && resNull.diagnostic.includes('static pointer MODULE + 0x143ef70 is null'));

  // 2. Root vtable mismatch
  const procBadVt = new MockMemoryProc();
  procBadVt.writeU64(base + 0x143ef70, 0x20000);
  procBadVt.writeU64(0x20000, 0x7ff699999); // bad vtable
  const resBadVt = tiles.findSpawnerByChain(procBadVt, base, { vtables, staticRva: 0x143ef70, useDirectScene: true });
  check('Bad root vtable returns ok: false', resBadVt.ok === false);
  check('Bad root vtable diagnostic names oCDtGameScene', typeof resBadVt.diagnostic === 'string' && resBadVt.diagnostic.includes('does not read as oCDtGameScene by vtable'));

  // 3. Level list head null
  const procNullList = new MockMemoryProc();
  procNullList.writeU64(base + 0x143ef70, 0x20000);
  procNullList.writeU64(0x20000, gameSceneVt);
  procNullList.writeU64(0x20000 + 0x658, 0); // null head
  const resNullList = tiles.findSpawnerByChain(procNullList, base, { vtables, staticRva: 0x143ef70, useDirectScene: true });
  check('Null level head returns ok: false', resNullList.ok === false);
  check('Null level head diagnostic names scene + 0x658', typeof resNullList.diagnostic === 'string' && resNullList.diagnostic.includes('scene + 0x658 (level list head) is null'));

  // 4. Missing spawner under spawner GO
  const procNoSpawner = new MockMemoryProc();
  procNoSpawner.writeU64(base + 0x143ef70, 0x20000);
  procNoSpawner.writeU64(0x20000, gameSceneVt);
  procNoSpawner.writeU64(0x20000 + 0x658, 0x30000); // level
  procNoSpawner.writeU64(0x30000 + 0x10, 0);
  procNoSpawner.writeU64(0x30000 + 0x80, 0x40000); // go array
  procNoSpawner.writeU32(0x30000 + 0x88, 1);
  procNoSpawner.writeU64(0x40000, 0x50000); // go
  procNoSpawner.writeU64(0x50000, spawnerGoVt);
  procNoSpawner.writeU64(0x50000 + 0x128, 0x60000); // entity
  procNoSpawner.writeU64(0x60000 + 0x190, 0x70000); // cpnt array
  procNoSpawner.writeU32(0x60000 + 0x198, 1);
  procNoSpawner.writeU64(0x70000, 0x80000);
  procNoSpawner.writeU64(0x80000, 0x7ff688888); // non-spawner component
  const resNoSpawner = tiles.findSpawnerByChain(procNoSpawner, base, { vtables, staticRva: 0x143ef70, useDirectScene: true });
  check('No spawner returns ok: false', resNoSpawner.ok === false);
  check('No spawner diagnostic names 1 spawner GO(s) across 1 level(s)', typeof resNoSpawner.diagnostic === 'string' && resNoSpawner.diagnostic.includes('no tile spawner under 1 spawner GO(s) across 1 level(s)'));
}

function testSweeperNextTiles() {
  console.log('\n--- test-tiles: sweeper nextTiles lifecycle logic ---');
  const { nextTiles } = require('../tiles-worker');

  const roster = [{ name: 'TileA', width: 1, height: 1, source: 'category', categoryIndex: 0 }];

  // 1. Initial read on map 0
  const t1 = nextTiles(null, 0, roster);
  check('nextTiles sets incoming roster on map load', t1 === roster);

  // 2. Unchanged sweep keeps held roster
  const t2 = nextTiles(t1, 0, undefined);
  check('nextTiles preserves held roster across sweeps', t2 === roster);

  // 3. Map change to lobby (-1) clears roster
  const t3 = nextTiles(t2, -1, undefined);
  check('nextTiles clears roster on mapId -1', t3 === null);

  // 4. A run reset clears the roster in the sweep loop, not here -- and a
  // roster read on that same sweep belongs to the new run, so it is kept.
  // Discarding it was what left the panel loading for the rest of the session
  // after a restart onto the same map.
  const t4 = nextTiles(null, 0, roster);
  check('a roster read on the reset sweep is kept, not discarded', t4 === roster);
}

function testSweeperTilesDue() {
  console.log('\n--- test-tiles: sweeper tilesDue gating ---');
  const { tilesDue, tilesPollMs, nextTilesStable, TILES_POLL_MS, TILES_SETTLED_POLL_MS } = require('../tiles-worker');

  check('a map looks', tilesDue(0) === true);
  check('the lobby never looks', tilesDue(-1) === false);
  check('no map never looks', tilesDue(null) === false);

  // Stability never stops the worker; it only slows it down. A cold load
  // measured 2026-09-17 put 6 selectors in the first roster while 9 existed,
  // and the next scan read 9 -- so two agreeing reads CAN agree on a partial
  // count, and a worker that stopped on agreement would have shipped that map
  // without three reward camps. The settled cadence bounds how late a batch
  // can land unseen.
  check('an unsettled count polls fast', tilesPollMs(false) === TILES_POLL_MS);
  check('a settled count polls slow', tilesPollMs(true) === TILES_SETTLED_POLL_MS);
  check('the settled cadence is slower than the moving one', TILES_SETTLED_POLL_MS > TILES_POLL_MS);
  check('callers can override both cadences', tilesPollMs(true, 15, 40) === 40 && tilesPollMs(false, 15, 40) === 15);

  // Reward selectors spawn one at a time, not all at once, so the first sweep
  // to find ANY of them can catch two out of five. `nextTilesStable` tells
  // "spawning has settled" apart from "spawning has started": two consecutive
  // reads must agree on the count before the cadence is allowed to slow.
  let stable = false;
  let selectorCount = -1;

  // Sweep 1: chain walk fails (still loading). No signal either way.
  ({ stable, selectorCount } = nextTilesStable(stable, selectorCount, null));
  check('a failed read is not read as agreement', stable === false);
  check('a failed read does not touch the count', selectorCount === -1);

  // Sweep 2: spawner up, 2 of 5 selectors have spawned so far.
  const twoSelectors = [
    { name: 'DreamCrystal_Big', source: 'selector' },
    { name: 'Refugee_Woman', source: 'selector' },
  ];
  ({ stable, selectorCount } = nextTilesStable(stable, selectorCount, twoSelectors));
  check('a first reward read is not yet stable (nothing to compare against)', stable === false);
  check('a first reward read keeps the fast cadence', tilesPollMs(stable) === TILES_POLL_MS);

  // Sweep 3: same 2 selectors again -- this is the bug this replaced.
  // A held-a-reward check would have already stopped after sweep 2 and never
  // seen sweeps 4/5 add the chest and the eye.
  ({ stable, selectorCount } = nextTilesStable(stable, selectorCount, twoSelectors));
  check('two reads agreeing on 2 count as stable even though the roster is incomplete',
    stable === true);

  check('agreement on the partial count slows the cadence', tilesPollMs(stable) === TILES_SETTLED_POLL_MS);

  // Sweep 4: a chest and an eye have since spawned -- 4 selectors now. The
  // worker is still scanning, on the settled cadence, so this read does run.
  const fourSelectors = [
    ...twoSelectors,
    { name: 'Dark_Hills_Basic_Chest_T1', source: 'selector' },
    { name: 'Baba_Yaga_Eye', source: 'selector' },
  ];
  ({ stable, selectorCount } = nextTilesStable(stable, selectorCount, fourSelectors));
  check('a count that grew since the last read is not stable', stable === false);
  check('the grown count is remembered for the next comparison', selectorCount === 4);
  check('growth drops back to the fast cadence', tilesPollMs(stable) === TILES_POLL_MS);

  // Sweep 5: 4 again -- now it is genuinely finished.
  ({ stable, selectorCount } = nextTilesStable(stable, selectorCount, fourSelectors));
  check('two reads agreeing on the true final count are stable', stable === true);
  check('the true final count settles the cadence', tilesPollMs(stable) === TILES_SETTLED_POLL_MS);

  // A map with no reward selectors at all (e.g. nothing left to roll) must
  // still keep retrying -- 0 never counts as agreement, so this can't latch
  // on an empty roster the way "held.some(selector)" never could either.
  const noSelectors = [{ name: '40x40_Dark_Hills_Cauldron_T1', source: 'category' }];
  let zeroStable = false, zeroCount = -1;
  ({ stable: zeroStable, selectorCount: zeroCount } = nextTilesStable(zeroStable, zeroCount, noSelectors));
  ({ stable: zeroStable, selectorCount: zeroCount } = nextTilesStable(zeroStable, zeroCount, noSelectors));
  check('a map with zero selectors across two reads never counts as stable', zeroStable === false);
  check('a zero-selector map keeps the fast cadence (no cap)', tilesPollMs(zeroStable) === TILES_POLL_MS);
}

function testTierBucketing() {
  console.log('\n--- test-tiles: tier float bucketing ---');
  const { bucketTier } = tiles;

  // The three constants mapping to tiers 1, 2, 3
  check('0.15 maps to tier 1 (bucketTier)', bucketTier(0.15) === 1);
  check('0.5 maps to tier 2 (bucketTier)', bucketTier(0.5) === 2);
  check('1.0 maps to tier 3 (bucketTier)', bucketTier(1.0) === 3);

  // Off-constant value (0.9955) bucketing rather than being dropped
  check('0.9955 buckets to tier 3 (bucketTier)', bucketTier(0.9955) === 3);
  check('0.2126 buckets to tier 1 (bucketTier)', bucketTier(0.2126) === 1);

  // 0.0 yielding no tier
  check('0.0 yields null tier (bucketTier)', bucketTier(0.0) === null);
  check('null yields null tier', bucketTier(null) === null);
  check('undefined yields null tier', bucketTier(undefined) === null);
  check('-1.0 yields null tier', bucketTier(-1.0) === null);
}

function testTierMemoryReading() {
  console.log('\n--- test-tiles: tier memory reading (+0x20 and +0x68) ---');
  const proc = new MockMemoryProc();
  const spawnerAddr = 0x80000;

  // Setup category vector with 1 slot
  const catVecPtr = 0x81000;
  proc.writeU64(spawnerAddr + tiles.SPAWNER_CATEGORY_VECTOR_OFFSET, catVecPtr);
  proc.writeU32(spawnerAddr + tiles.SPAWNER_CATEGORY_COUNT_OFFSET, 1);
  proc.writeU64(spawnerAddr + tiles.SPAWNER_SUBLEVEL_VECTOR_OFFSET, 0);
  proc.writeU32(spawnerAddr + tiles.SPAWNER_SUBLEVEL_COUNT_OFFSET, 0);

  const sliceAddr = catVecPtr;
  const slotsPtr = 0x82000;
  proc.writeU64(sliceAddr + tiles.CATEGORY_SLICE_DATA_OFFSET, slotsPtr);
  proc.writeU32(sliceAddr + tiles.CATEGORY_SLICE_COUNT_OFFSET, 1);
  proc.writeU32(sliceAddr + tiles.CATEGORY_SLICE_CAP_OFFSET, 1);

  // Slot in category with weight 0.5 (tier 2)
  const slotAddr = slotsPtr;
  const resAddr = 0x83000;
  writeStringTriple(proc, resAddr + tiles.RESOURCE_NAME_OFFSET, 0x83100, '40x40_Dark_Hills_Grimoire_T2');
  writeTileSlot(proc, slotAddr, { resourceAddr: resAddr, weight: 0.5 });

  // Reward selector with float 0.9955 at +0x68 (tier 3)
  const selAddr = 0x84000;
  const selResAddr = 0x85000;
  writeStringTriple(proc, selResAddr + tiles.RESOURCE_NAME_OFFSET, 0x85100, 'Baba_Yaga_Eye');
  proc.writeU64(selAddr + tiles.SELECTOR_RESOURCE_OFFSET, selResAddr);
  proc.writeFloat(selAddr + tiles.SELECTOR_TIER_OFFSET, 0.9955);

  const instances = { spawnerAddr, selectorAddrs: [selAddr] };
  const result = tiles.readPlacedTiles(proc, 0x7ff600000000, null, instances);

  check('readPlacedTiles returns 2 tiles', result && result.length === 2);
  if (result && result.length === 2) {
    check('slot tier float is read from +0x20', Math.abs(result[0].tier - 0.5) < 1e-5);
    check('selector tier float is read from +0x68', Math.abs(result[1].tier - 0.9955) < 1e-4);
  }
}

function testStashDeduplication() {
  console.log('\n--- test-tiles: stash pair deduplication ---');
  const { groupTiles } = require('../state');

  const entranceStash = {
    name: '40x40_DarkHills_Thieves_Stashes_Entrance_Combat_Room_01',
    width: 40,
    height: 40,
    source: 'category',
    categoryIndex: 2,
    tier: 0.5,
  };

  const undergroundStash = {
    name: 'DarkHill_Thieves_Stashes_Combat_Room_Underground_01',
    width: null,
    height: null,
    source: 'sublevel',
    categoryIndex: null,
    tier: 0.5,
  };

  // An entrance/underground stash pair yielding one cell with count 1
  const pairCells = groupTiles([entranceStash, undergroundStash]);
  check('stash pair yields exactly 1 cell', pairCells && pairCells.length === 1);
  if (pairCells && pairCells.length === 1) {
    check('combat cell uses crossed swords', pairCells[0].icon === 'icon_in_combat.png');
    check('cell count is 1', pairCells[0].count === 1);
    check('combat art has no tier outline', pairCells[0].tier === null && pairCells[0].outline === null);
  }

  // Two separate surface stashes yielding count 2
  const secondSurfaceStash = {
    ...entranceStash,
    categoryIndex: 3,
  };
  const twoStashesCells = groupTiles([entranceStash, secondSurfaceStash]);
  check('two surface stashes yield 1 cell', twoStashesCells && twoStashesCells.length === 1);
  if (twoStashesCells && twoStashesCells.length === 1) {
    check('two surface stashes cell count is 2', twoStashesCells[0].count === 2);
    check('two surface stashes keep untiered combat art', twoStashesCells[0].tier === null);
  }
}

async function testTilesWorker() {
  console.log('\n--- test-tiles: tiles-worker thread lifecycle & message handling ---');
  const { runWorker } = require('../tiles-worker');
  const { MessageChannel } = require('worker_threads');

  const base = 0x7ff600000000;
  const spawnerVt = 0x7ff600100000;
  const selectorVt = 0x7ff600150000;
  const spawnerGoVt = 0x7ff600200000;
  const gameSceneVt = 0x7ff600300000;
  const gameVt = 0x7ff600400000;

  const vtables = {
    spawnerVt,
    selectorVt,
    spawnerGoVts: new Set([spawnerGoVt]),
    gameSceneVts: new Set([gameSceneVt]),
    gameVts: new Set([gameVt]),
  };

  const proc = new MockMemoryProc();

  // Wire scene -> level -> go -> entity -> cpnt -> spawner
  const sceneAddr = 0x20000;
  proc.writeU64(base + tiles.GAME_SCENE_STATIC_RVA, sceneAddr);
  proc.writeU64(sceneAddr, gameSceneVt);

  const levelAddr = 0x30000;
  proc.writeU64(sceneAddr + 0x658, levelAddr);
  proc.writeU64(levelAddr + 0x10, 0); // end of list
  const goArrAddr = 0x40000;
  proc.writeU64(levelAddr + 0x80, goArrAddr);
  proc.writeU32(levelAddr + 0x88, 1);

  const goAddr = 0x50000;
  proc.writeU64(goArrAddr, goAddr);
  proc.writeU64(goAddr, spawnerGoVt);

  const entAddr = 0x60000;
  proc.writeU64(goAddr + 0x128, entAddr);
  const cpntArrAddr = 0x70000;
  proc.writeU64(entAddr + 0x190, cpntArrAddr);
  proc.writeU32(entAddr + 0x198, 1);

  const spawnerAddr = 0x80000;
  proc.writeU64(cpntArrAddr, spawnerAddr);
  proc.writeU64(spawnerAddr, spawnerVt);

  // Spawner category & sublevel vectors are empty
  proc.writeU64(spawnerAddr + tiles.SPAWNER_CATEGORY_VECTOR_OFFSET, 0);
  proc.writeU32(spawnerAddr + tiles.SPAWNER_CATEGORY_COUNT_OFFSET, 0);
  proc.writeU64(spawnerAddr + tiles.SPAWNER_SUBLEVEL_VECTOR_OFFSET, 0);
  proc.writeU32(spawnerAddr + tiles.SPAWNER_SUBLEVEL_COUNT_OFFSET, 0);

  // One reward selector in memory
  const selAddr = 0x90000;
  const resAddr = 0x91000;
  proc.writeU64(selAddr, selectorVt);
  proc.writeU64(selAddr + tiles.SELECTOR_RESOURCE_OFFSET, resAddr);
  writeStringTriple(proc, resAddr + tiles.RESOURCE_NAME_OFFSET, 0x92000, 'Dark_Hills_Basic_Chest_T1');

  const { port1, port2 } = new MessageChannel();
  const messages = [];
  port2.on('message', m => messages.push(m));

  const workerPromise = runWorker(0, base, {
    proc,
    port: port1,
    pollMs: 15,
    settledPollMs: 40,
    vtables,
  });

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // 1. Initial state: before 'map' message, no tiles are discovered or posted
  await sleep(40);
  check('worker posts nothing before map message', messages.filter(m => m.type === 'tiles').length === 0);

  // 2. Send 'map' message: triggers discovery attempt and posts tiles
  port2.postMessage({ type: 'map', mapId: 0 });
  await sleep(60);
  const tiles1 = messages.filter(m => m.type === 'tiles');
  check("'map' message triggers discovery and posts tiles", tiles1.length === 1);
  check('discovered tiles contain selector chest', tiles1[0] && tiles1[0].tiles && tiles1[0].tiles.length === 1 && tiles1[0].tiles[0].name === 'Dark_Hills_Basic_Chest_T1');

  // 3. Deduplication: stable roster does NOT produce additional posts
  await sleep(60);
  const tiles2 = messages.filter(m => m.type === 'tiles');
  check('unchanged roster does not post duplicate tiles (dedup)', tiles2.length === 1);

  // 3b. A selector that spawns AFTER the count has settled is still found.
  // This is the cold-load case measured 2026-09-17: the count agreed on a
  // partial roster, and a worker that stopped on agreement never saw the rest.
  // The settled cadence (40 ms here) must pick it up without a map message.
  const sel2Addr = 0xa0000;
  const res2Addr = 0xa1000;
  proc.writeU64(sel2Addr, selectorVt);
  proc.writeU64(sel2Addr + tiles.SELECTOR_RESOURCE_OFFSET, res2Addr);
  writeStringTriple(proc, res2Addr + tiles.RESOURCE_NAME_OFFSET, 0xa2000, 'Baba_Yaga_Eye');
  await sleep(120);
  const tilesLate = messages.filter(m => m.type === 'tiles');
  check('a selector spawning after the count settled is posted anyway', tilesLate.length === 2);
  check('the late post carries both selectors',
    tilesLate[1] && tilesLate[1].tiles && tilesLate[1].tiles.length === 2);

  // 4. Send { type: 'map', mapId: 0, reset: true }: re-arms even on the same map id
  port2.postMessage({ type: 'map', mapId: 0, reset: true });
  await sleep(60);
  const tiles3 = messages.filter(m => m.type === 'tiles');
  check('{ type: "map", reset: true } re-arms discovery on the same map id', tiles3.length === 3);

  // 5. Send 'clear' message: drops held roster and ceases polling
  port2.postMessage({ type: 'clear' });
  await sleep(60);
  const tiles4 = messages.filter(m => m.type === 'tiles');
  check("'clear' message drops roster and produces no further posts", tiles4.length === 3);

  // 6. Stop worker
  port2.postMessage({ type: 'stop' });
  await workerPromise;
  port1.close();
  port2.close();
  check('worker stops cleanly and closes proc', proc.closed === true);
}

async function main() {
  failures = 0;
  testVtableResolution();
  testStringTripleAndHighBit();
  testPlacedVsUnplacedDiscrimination();
  testCategoryIndexVsSizeDescriptor();
  testSixSliceCategoryVector();
  testSublevelVectorMix();
  testRewardSelectors();
  testTileKindReading();
  testTilesChanged();
  testFindInstances();
  testFindSpawnerByChain();
  testFindSpawnerByChainDiagnostics();
  testSweeperNextTiles();
  testSweeperTilesDue();
  testTierBucketing();
  testTierMemoryReading();
  testStashDeduplication();
  await testTilesWorker();

  if (failures > 0) {
    console.error(`\ntest-tiles: ${failures} check(s) failed`);
    return 1;
  }
  console.log('\ntest-tiles: all passed');
  return 0;
}

if (require.main === module) {
  main().then(f => process.exit(f));
}

module.exports = { main };
