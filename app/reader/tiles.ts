'use strict';
// Placed tiles and rewards.
//
// Reads what tiles, interior/underground sublevels, and camp rewards are
// currently placed and active on the map by querying:
//   1. oCDtEntityCpntTileSpawner category vector (+0x110) -- camps, POIs, etc.
//   2. oCDtEntityCpntTileSpawner sublevel vector (+0x120) -- underground/interior rooms
//   3. oCDtRewardEntitySelectorToSpawnEntityCpnt instances -- pre-rolled camp rewards
//
// Coordinates and runtime entity transforms are not read.
// Classification is driven by the TileSlotSize descriptor (+0x14 width, +0x18 height),
// never by slice index or tile name parsing.

import type { ByteSource } from './pe';
import type { ScanSource } from './scan';
import * as rtti from './rtti';
import { scanPointers } from './scan';

// ---- RTTI mangled names (confirmed live) -----------------------------------
export const SPAWNER_RTTI = '.?AVoCDtEntityCpntTileSpawner@@\0';
export const SELECTOR_RTTI = '.?AVoCDtRewardEntitySelectorToSpawnEntityCpnt@@\0';
export const TILE_SLOT_SIZE_RTTI = '.?AVoCDtTileSlotSize@@\0';
export const TILE_KIND_RTTI = '.?AVoCDtTileKind@@\0';
export const GAME_SCENE_RTTI = '.?AVoCDtGameScene@@\0';
export const GAME_RTTI = '.?AVoCDtGame@@\0';
export const SPAWNER_GO_RTTI = '.?AVoCEntitySpawnerGo@@\0';
export const ENTITY_RTTI = '.?AVoCEntity@@\0';

// ---- Static Pointer Chain RVAs ---------------------------------------------
// Revalidated on 2026-10-12: both roots reached the independently scanned
// spawner on Dark Hills. Cross-map stability on this game build is not yet
// measured; the downstream layout and roster read matched (151 entries).
export const GAME_SCENE_STATIC_RVA = 0x1438e90;
export const GAME_STATIC_RVA = 0x146f8f8;

// ---- Struct offsets (confirmed live) ---------------------------------------
// Spawner layout (oCDtEntityCpntTileSpawner):
export const SPAWNER_CATEGORY_VECTOR_OFFSET = 0x110;  // TileCategorySlice*
export const SPAWNER_CATEGORY_COUNT_OFFSET = 0x118;   // uint32 count
export const SPAWNER_CATEGORY_CAP_OFFSET = 0x11c;     // uint32 cap
export const SPAWNER_SUBLEVEL_VECTOR_OFFSET = 0x120;  // TileSlot* (direct array)
export const SPAWNER_SUBLEVEL_COUNT_OFFSET = 0x128;   // uint32 count
export const SPAWNER_SUBLEVEL_CAP_OFFSET = 0x12c;     // uint32 cap

// Category slice layout (TileCategorySlice, 16 bytes per slice):
export const CATEGORY_SLICE_DATA_OFFSET = 0x00;       // TileSlot*
export const CATEGORY_SLICE_COUNT_OFFSET = 0x08;      // uint32 count
export const CATEGORY_SLICE_CAP_OFFSET = 0x0c;        // uint32 cap
export const CATEGORY_SLICE_STRIDE = 0x10;            // 16 bytes

// TileSlot struct layout (88 bytes / 0x58 stride):
export const SLOT_SPAWNER_OFFSET = 0x00;              // oCDtEntityCpntTileSpawner*
export const SLOT_SETTINGS_OFFSET = 0x08;             // oCDtTileSlotSettings*
export const SLOT_RESOURCE_OFFSET = 0x10;             // oCEntitySettingsResource* (placement indicator)
export const SLOT_ENTITY_OFFSET = 0x18;               // oCEntity* (live entity)
export const SLOT_WEIGHT_OFFSET = 0x20;               // float32 (-1.0f if unplaced)
export const SLOT_META_OFFSET = 0x28;
export const SLOT_LINKED_TILE_OFFSET = 0x30;
export const SLOT_LIST_OFFSET = 0x38;
export const SLOT_RESERVED_OFFSET = 0x40;
export const SLOT_TILE_DEF_OFFSET = 0x48;             // oCDtTileDefinition*
export const SLOT_TILE_KIND_OFFSET = 0x50;            // oCDtTileKind*
export const TILE_SLOT_STRIDE = 0x58;                 // 88 bytes

// Slot settings layout (oCDtTileSlotSettings):
export const SETTINGS_SIZE_OFFSET = 0x08;             // oCDtTileSlotSize*

// TileSlotSize layout (oCDtTileSlotSize):
export const SIZE_WIDTH_OFFSET = 0x14;                // int32
export const SIZE_HEIGHT_OFFSET = 0x18;               // int32

// EntitySettingsResource layout (oCEntitySettingsResource):
export const RESOURCE_NAME_OFFSET = 0xa0;             // char* data
export const RESOURCE_NAME_LEN_OFFSET = 0xa8;         // uint32 len (& 0x7FFFFFFF)
export const RESOURCE_NAME_FLAGS_OFFSET = 0xac;       // uint32 flags

// Reward selector layout (oCDtRewardEntitySelectorToSpawnEntityCpnt):
export const SELECTOR_TIER_OFFSET = 0x68;             // float32 tier (0.15f, 0.5f, 1.0f)
export const SELECTOR_RESOURCE_OFFSET = 0x78;         // oCEntitySettingsResource*

// Minimum address for valid user-space pointers
export const MIN_VALID_ADDR = 0x10000;

export interface TilesSource extends ByteSource, ScanSource {
  readPtr(addr: number): number | null;
  readI32(addr: number): number | null;
}

export type TileSourceType = 'category' | 'sublevel' | 'selector';

/**
 * Bucket a memory tier float into tier 1, 2, or 3.
 * Returns null if the value is not tiered (<= 0.05 or unassigned).
 * Buckets to nearest constant: 0.15 -> 1, 0.5 -> 2, 1.0 -> 3.
 */
export function bucketTier(val: number | null | undefined): number | null {
  if (val == null || !Number.isFinite(val) || val <= 0.05) return null;
  const d1 = Math.abs(val - 0.15);
  const d2 = Math.abs(val - 0.5);
  const d3 = Math.abs(val - 1.0);
  if (d1 <= d2 && d1 <= d3) return 1;
  if (d2 <= d3) return 2;
  return 3;
}

export interface PlacedTile {
  readonly name: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly source: TileSourceType;
  /** The category slice a tile was read from; null for sublevels and selectors. */
  readonly categoryIndex: number | null;
  readonly tier: number | null;
}

export interface TilesVtables {
  spawnerVt?: number;
  selectorVt?: number;
}

export interface ResolvedTilesVtables {
  readonly spawnerVt: number;
  readonly selectorVt: number;
}

export interface DiscoveredInstances {
  readonly spawnerAddr: number | null;
  readonly selectorAddrs: number[];
}

export interface SpawnerChainOptions {
  staticRva?: number;
  useDirectScene?: boolean;
  vtables?: Record<string, unknown> | null;
}

export interface SpawnerChainResult {
  readonly ok: boolean;
  readonly spawner: number | null;
  readonly spawnerAddr: number | null;
  readonly entity: number | null;
  readonly entityAddr: number | null;
  readonly level?: number | null;
  readonly go?: number | null;
  readonly goIndex?: number;
  readonly cpntIndex?: number;
  readonly scene?: number | null;
  readonly game?: number | null;
  readonly levelsSeen: number;
  readonly gosTried: number;
  readonly hops: number;
  readonly ms: number;
  readonly diagnostic?: string | null;
  readonly staticRva: number;
}

/** A uint32. No live source has a method for it, so it is read from bytes. */
export function readU32(proc: ByteSource, addr: number): number | null {
  const buf = proc.read(addr, 4);
  if (!buf || buf.length < 4) return null;
  return buf.readUInt32LE(0);
}

/**
 * Read an engine string triple {const char *data, uint32 len, uint32 flags} at addr.
 * Masking with 0x7FFFFFFF clears the static literal bit (0x80000000).
 */
export function readStringTriple(
  proc: TilesSource,
  tripleAddr: number,
  maxLen = 256,
): string | null {
  if (!tripleAddr || tripleAddr < MIN_VALID_ADDR) return null;
  const strPtr = proc.readPtr(tripleAddr);
  if (!strPtr || strPtr < MIN_VALID_ADDR) return null;

  const rawLen = readU32(proc, tripleAddr + 8);
  if (rawLen === null) return null;
  const len = rawLen & 0x7fffffff;
  if (len <= 0 || len > maxLen) return null;

  const buf = proc.read(strPtr, len);
  if (!buf || buf.length < len) return null;

  if (!buf.subarray(0, len).every(c => c >= 0x20 && c <= 0x7e)) return null;

  const nul = buf.indexOf(0);
  const effective = nul >= 0 ? buf.subarray(0, nul) : buf;
  return effective.toString('latin1');
}

/**
 * Read the classification tag from an oCDtTileKind instance at kindAddr.
 *
 * Whether +0xA0 is the name inside oCDtTileKind is not settled; it is the
 * convention every other named object in this reader follows. Measured live
 * on Dark Hills 2026-09-06: 95 of 140 placed slots carry a kind pointer,
 * reaching 11 distinct objects, and +0xA0 decodes on 1 of the 11, to the
 * single character "F". That reads as a coincidentally well-formed triple at
 * the wrong offset, so the roster does not carry a kind; the bench calls
 * this to keep testing the offset.
 */
export function readTileKind(proc: TilesSource, kindAddr: number): string | null {
  if (!kindAddr || kindAddr < MIN_VALID_ADDR) return null;
  return readStringTriple(proc, kindAddr + RESOURCE_NAME_OFFSET);
}

/**
 * Resolve the RTTI vtables for the Tile Spawner and Reward Selector components.
 *
 * Mutates caller-owned `vtables` cache and returns the resolved values,
 * or null if either cannot be resolved.
 */
export function resolveVtables(
  proc: ByteSource,
  base: number,
  vtables: TilesVtables = {},
): ResolvedTilesVtables | null {
  let spawnerVt = vtables.spawnerVt;
  if (!spawnerVt) {
    const rva = rtti.resolveAllVtableRvas(proc, base, SPAWNER_RTTI)[0];
    if (rva !== undefined) spawnerVt = base + rva;
  }

  let selectorVt = vtables.selectorVt;
  if (!selectorVt) {
    const rva = rtti.resolveAllVtableRvas(proc, base, SELECTOR_RTTI)[0];
    if (rva !== undefined) selectorVt = base + rva;
  }

  if (!spawnerVt || !selectorVt) return null;
  vtables.spawnerVt = spawnerVt;
  vtables.selectorVt = selectorVt;
  return { spawnerVt, selectorVt };
}

/**
 * Discover the single live spawner and all reward selectors in a single scan.
 * Targets both vtables simultaneously to take advantage of the T === 2 fast-path
 * in scanPointers.
 */
export function findInstances(
  proc: ScanSource,
  vtables: ResolvedTilesVtables,
): DiscoveredInstances {
  const hits = scanPointers(proc, [vtables.spawnerVt, vtables.selectorVt], { writableOnly: true });

  const rawSpawners = (hits.get(vtables.spawnerVt) ?? []) as (number | [number, number])[];
  const spawnerList = rawSpawners
    .map(h => (Array.isArray(h) ? h[0] : h))
    .filter(a => a >= MIN_VALID_ADDR);

  const rawSelectors = (hits.get(vtables.selectorVt) ?? []) as (number | [number, number])[];
  const selectorList = rawSelectors
    .map(h => (Array.isArray(h) ? h[0] : h))
    .filter(a => a >= MIN_VALID_ADDR);

  return {
    spawnerAddr: spawnerList[0] ?? null,
    selectorAddrs: selectorList,
  };
}

/**
 * Every live reward selector, by scanning for its vtable alone.
 *
 * WHY THIS EXISTS SEPARATELY FROM findInstances. findSpawnerByChain reaches the
 * tile spawner in ~25 ms and removes the need to scan for IT, but it does not
 * reach the reward selectors: they are components on entities that neither the
 * tile slots nor the level GO arrays lead to. Measured on 2026-09-06, walking
 * all 139 tile-slot entities and all 369 level GOs found 0 of the 9 selectors,
 * and the selector's own +0x08 owning entity (vtable-confirmed oCEntity) is not
 * among the tile-slot entities.
 *
 * So the selectors still cost a scan. It is a single-target scan run once per
 * map change rather than the two-target one, and the roster it completes would
 * otherwise be silently missing every Vision Tower, chest, Dream Crystal,
 * Astrolabe and refugee.
 */
export function findSelectors(
  proc: ScanSource,
  selectorVt: number,
): number[] {
  const hits = scanPointers(proc, [selectorVt], { writableOnly: true });
  const raw = (hits.get(selectorVt) ?? []) as (number | [number, number])[];
  return raw
    .map(h => (Array.isArray(h) ? h[0] : h))
    .filter(a => a >= MIN_VALID_ADDR);
}

/**
 * Read a single TileSlot record from memory.
 * Returns null if the slot is empty / unplaced or invalid.
 */
export function readTileSlot(
  proc: TilesSource,
  slotAddr: number,
  source: 'category' | 'sublevel',
  categoryIndex: number | null = null,
): PlacedTile | null {
  if (!slotAddr || slotAddr < MIN_VALID_ADDR) return null;

  // 1. Placement check: resource pointer at +0x10 must be valid
  const resource = proc.readPtr(slotAddr + SLOT_RESOURCE_OFFSET);
  if (!resource || resource < MIN_VALID_ADDR) return null;

  // 2. Weight check at +0x20: -1.0f indicates unplaced / empty
  const weightBuf = proc.read(slotAddr + SLOT_WEIGHT_OFFSET, 4);
  if (!weightBuf || weightBuf.length < 4) return null;
  const weight = weightBuf.readFloatLE(0);
  if (weight === -1.0) return null;

  // 3. Name triple at resource + 0xA0
  const name = readStringTriple(proc, resource + RESOURCE_NAME_OFFSET);
  if (!name) return null;

  // 4. Width and height from slot_settings + 0x08 -> sizePtr + 0x14, 0x18
  let width: number | null = null;
  let height: number | null = null;
  const settings = proc.readPtr(slotAddr + SLOT_SETTINGS_OFFSET);
  if (settings && settings >= MIN_VALID_ADDR) {
    const sizePtr = proc.readPtr(settings + SETTINGS_SIZE_OFFSET);
    if (sizePtr && sizePtr >= MIN_VALID_ADDR) {
      width = proc.readI32(sizePtr + SIZE_WIDTH_OFFSET);
      height = proc.readI32(sizePtr + SIZE_HEIGHT_OFFSET);
    }
  }

  // The tile kind at slot + 0x50 is not read; see readTileKind.
  return { name, width, height, source, categoryIndex, tier: weight };
}

/**
 * Read a reward entity selector at selectorAddr.
 * Does not read +0x08, +0x10, or coordinates.
 */
export function readRewardSelector(
  proc: TilesSource,
  selectorAddr: number,
): PlacedTile | null {
  if (!selectorAddr || selectorAddr < MIN_VALID_ADDR) return null;

  const tierBuf = proc.read(selectorAddr + SELECTOR_TIER_OFFSET, 4);
  if (!tierBuf || tierBuf.length < 4) return null;
  const tier = tierBuf.readFloatLE(0);

  const resource = proc.readPtr(selectorAddr + SELECTOR_RESOURCE_OFFSET);
  if (!resource || resource < MIN_VALID_ADDR) return null;

  const name = readStringTriple(proc, resource + RESOURCE_NAME_OFFSET);
  if (!name) return null;

  return { name, width: null, height: null, source: 'selector', categoryIndex: null, tier };
}

/**
 * Read all placed tiles and rewards across:
 *   1. Spawner category vector (+0x110)
 *   2. Spawner sublevel vector (+0x120)
 *   3. Reward selectors (+0x78)
 *
 * `instances`: Optional pre-discovered instances. May be a single spawner address
 * (number) for testing/backward compatibility, a DiscoveredInstances object, or null.
 */
export function readPlacedTiles(
  proc: TilesSource,
  base: number,
  vtables: TilesVtables | null,
  instances: DiscoveredInstances | null = null,
): PlacedTile[] | null {
  let spawnerAddr: number | null = null;
  let selectorAddrs: number[] = [];

  // Instances name the selectors explicitly. A spawner alone yields every
  // tile and sublevel and zero rewards, which looks like a working census
  // until someone counts the Vision Towers, so a caller holding only a
  // spawner writes selectorAddrs: [] and says so.
  if (instances && typeof instances === 'object') {
    spawnerAddr = instances.spawnerAddr;
    selectorAddrs = instances.selectorAddrs ?? [];
  } else if (vtables && vtables.spawnerVt && vtables.selectorVt) {
    const discovered = findInstances(proc, vtables as ResolvedTilesVtables);
    spawnerAddr = discovered.spawnerAddr;
    selectorAddrs = discovered.selectorAddrs;
  }

  if (!spawnerAddr || spawnerAddr < MIN_VALID_ADDR) {
    return null;
  }

  const results: PlacedTile[] = [];

  // 1. Spawner Category Vector (spawner + 0x110)
  // Count is read dynamically from uint32 at spawner + 0x118 (Dark Hills / Storm Island: 4, Avalon: 6).
  const catVecPtr = proc.readPtr(spawnerAddr + SPAWNER_CATEGORY_VECTOR_OFFSET);
  const catCount = readU32(proc, spawnerAddr + SPAWNER_CATEGORY_COUNT_OFFSET);

  if (catVecPtr && catVecPtr >= MIN_VALID_ADDR && catCount && catCount > 0 && catCount <= 32) {
    for (let c = 0; c < catCount; c++) {
      const sliceAddr = catVecPtr + c * CATEGORY_SLICE_STRIDE;
      const slotsPtr = proc.readPtr(sliceAddr + CATEGORY_SLICE_DATA_OFFSET);
      const slotCount = readU32(proc, sliceAddr + CATEGORY_SLICE_COUNT_OFFSET);

      if (!slotsPtr || slotsPtr < MIN_VALID_ADDR || !slotCount || slotCount <= 0 || slotCount > 1000) {
        continue;
      }

      for (let s = 0; s < slotCount; s++) {
        const slotAddr = slotsPtr + s * TILE_SLOT_STRIDE;
        const tile = readTileSlot(proc, slotAddr, 'category', c);
        if (tile) {
          results.push(tile);
        }
      }
    }
  }

  // 2. Spawner Sublevel Vector (spawner + 0x120)
  // Points directly to an array of TileSlot records; count read from uint32 at spawner + 0x128.
  const subVecPtr = proc.readPtr(spawnerAddr + SPAWNER_SUBLEVEL_VECTOR_OFFSET);
  const subCount = readU32(proc, spawnerAddr + SPAWNER_SUBLEVEL_COUNT_OFFSET);

  if (subVecPtr && subVecPtr >= MIN_VALID_ADDR && subCount && subCount > 0 && subCount <= 100) {
    for (let s = 0; s < subCount; s++) {
      const slotAddr = subVecPtr + s * TILE_SLOT_STRIDE;
      const tile = readTileSlot(proc, slotAddr, 'sublevel', null);
      if (tile) {
        results.push(tile);
      }
    }
  }

  // 3. Reward Selectors
  for (const selAddr of selectorAddrs) {
    const reward = readRewardSelector(proc, selAddr);
    if (reward) {
      results.push(reward);
    }
  }

  return results;
}

/**
 * Check whether two lists of placed tiles differ.
 */
export function tilesChanged(
  a: readonly PlacedTile[] | null,
  b: readonly PlacedTile[] | null,
): boolean {
  if (a === b) return false;
  if (!a || !b) return true;
  if (a.length !== b.length) return true;
  return a.some((tA, i) => {
    const tB = b[i];
    return tB === undefined ||
      tA.name !== tB.name ||
      tA.width !== tB.width ||
      tA.height !== tB.height ||
      tA.source !== tB.source ||
      tA.categoryIndex !== tB.categoryIndex ||
      tA.tier !== tB.tier;
  });
}

export const MAX_ARRAY_SCAN = 64;

/**
 * Test whether addr has a vtable in vts.
 */
export function isA(proc: TilesSource, addr: number | null, vts: ReadonlySet<number>): boolean {
  if (!addr || addr < MIN_VALID_ADDR) return false;
  const vt = proc.readPtr(addr);
  return !!vt && vts.has(vt);
}

/**
 * Scan array of 64-bit pointers for the first entry whose vtable is in vts.
 */
export function findByVtable(
  proc: TilesSource,
  array: number | null,
  count: number | null,
  vts: ReadonlySet<number>,
): { addr: number; index: number } | null {
  if (!array || !count || array < MIN_VALID_ADDR || count <= 0) return null;
  const n = Math.min(count, MAX_ARRAY_SCAN);
  for (let i = 0; i < n; i++) {
    const el = proc.readPtr(array + i * 8);
    if (isA(proc, el, vts) && el !== null) {
      return { addr: el, index: i };
    }
  }
  return null;
}

/**
 * Resolve all vtable addresses for a given RTTI type name into a Set.
 */
export function resolveVtableSet(proc: ByteSource, base: number, rttiName: string): Set<number> {
  const out = new Set<number>();
  try {
    const rvas = rtti.resolveAllVtableRvas(proc, base, rttiName);
    for (const rva of rvas) {
      out.add(base + rva);
    }
  } catch {
    // Unresolvable RTTI returns empty set
  }
  return out;
}

/**
 * Resolves oCDtEntityCpntTileSpawner via static module pointer chain.
 *
 * Candidate 1 (Direct Scene Anchor, default):
 *   MODULE + 0x1438E90 -> oCDtGameScene*
 *   scene + 0x658      -> oCGameLevel* head
 *   level + 0x80 / 88  -> GO array / count, searched for oCEntitySpawnerGo
 *   spawnerGo + 0x128  -> oCEntity*
 *   entity + 0x190/198 -> component array / count, searched for oCDtEntityCpntTileSpawner
 *
 * Candidate 2 (Game Singleton):
 *   MODULE + 0x146F8F8 -> oCDtGame*
 *   game + 0x18        -> oCDtGameScene*
 *   (subsequent hops identical to Candidate 1)
 */
export function findSpawnerByChain(
  proc: TilesSource,
  base: number,
  options?: SpawnerChainOptions,
): SpawnerChainResult {
  const staticRva = options?.staticRva ?? GAME_SCENE_STATIC_RVA;
  const useDirectScene = options?.useDirectScene ?? (staticRva === GAME_SCENE_STATIC_RVA);
  const tStart = process.hrtime.bigint();
  const elapsedMs = () => Number(process.hrtime.bigint() - tStart) / 1e6;

  // How far the walk got. Every failure reports it along with why it stopped.
  let hops = 0;
  let levelsSeen = 0;
  let gosTried = 0;
  let game: number | null = null;
  let scene: number | null = null;
  const fail = (diagnostic: string): SpawnerChainResult => ({
    ok: false, spawner: null, spawnerAddr: null, entity: null, entityAddr: null,
    game, scene, hops, levelsSeen, gosTried, ms: elapsedMs(), staticRva, diagnostic,
  });

  try {
    const cache = (options && options.vtables) || {};
    let spawnerVt = cache.spawnerVt as number | undefined;
    if (!spawnerVt) {
      const rvas = rtti.resolveAllVtableRvas(proc, base, SPAWNER_RTTI);
      if (rvas[0] !== undefined) {
        spawnerVt = base + rvas[0];
        cache.spawnerVt = spawnerVt;
      }
    }
    if (!spawnerVt) return fail('could not resolve oCDtEntityCpntTileSpawner vtable via RTTI');

    let spawnerGoVts = cache.spawnerGoVts as Set<number> | undefined;
    if (!spawnerGoVts) {
      spawnerGoVts = resolveVtableSet(proc, base, SPAWNER_GO_RTTI);
      cache.spawnerGoVts = spawnerGoVts;
    }
    if (spawnerGoVts.size === 0) return fail('could not resolve oCEntitySpawnerGo vtable via RTTI');

    let gameSceneVts = cache.gameSceneVts as Set<number> | undefined;
    if (!gameSceneVts) {
      gameSceneVts = resolveVtableSet(proc, base, GAME_SCENE_RTTI);
      cache.gameSceneVts = gameSceneVts;
    }
    if (gameSceneVts.size === 0) return fail('could not resolve oCDtGameScene vtable via RTTI');

    let gameVts = cache.gameVts as Set<number> | undefined;
    if (!gameVts && !useDirectScene) {
      gameVts = resolveVtableSet(proc, base, GAME_RTTI);
      cache.gameVts = gameVts;
      if (gameVts.size === 0) return fail('could not resolve oCDtGame vtable via RTTI');
    }

    const rootObj = proc.readPtr(base + staticRva);
    hops++;
    if (!rootObj || rootObj < MIN_VALID_ADDR) {
      return fail(`static pointer MODULE + 0x${staticRva.toString(16)} is null`);
    }
    const rootVt = proc.readPtr(rootObj);

    if (useDirectScene) {
      scene = rootObj;
      if (!rootVt || !gameSceneVts.has(rootVt)) {
        return fail(`root object at MODULE + 0x${staticRva.toString(16)} does not read as oCDtGameScene by vtable`);
      }
    } else {
      game = rootObj;
      if (!rootVt || (gameVts && !gameVts.has(rootVt))) {
        return fail(`root object at MODULE + 0x${staticRva.toString(16)} does not read as oCDtGame by vtable`);
      }
      const sceneAddr = proc.readPtr(game + 0x18);
      hops++;
      if (!sceneAddr || sceneAddr < MIN_VALID_ADDR) return fail('game + 0x18 (oCDtGameScene) is null');
      scene = sceneAddr;
      const sceneVt = proc.readPtr(scene);
      if (!sceneVt || !gameSceneVts.has(sceneVt)) {
        return fail('oCDtGameScene at game + 0x18 does not read as oCDtGameScene by vtable');
      }
    }

    const headLvl = proc.readPtr(scene + 0x658);
    hops++;
    if (!headLvl || headLvl < MIN_VALID_ADDR) return fail('scene + 0x658 (level list head) is null');

    const spawnerVtSet = new Set([spawnerVt]);
    let curr: number | null = headLvl;
    let listHops = 0;
    while (curr && curr >= MIN_VALID_ADDR && listHops < 50) {
      hops++;
      levelsSeen++;
      const arr = proc.readPtr(curr + 0x80);
      const n = Math.min(readU32(proc, curr + 0x88) ?? 0, MAX_ARRAY_SCAN);

      for (let i = 0; i < n; i++) {
        if (!arr || arr < MIN_VALID_ADDR) break;
        const go = proc.readPtr(arr + i * 8);
        if (!go || !isA(proc, go, spawnerGoVts)) continue;
        gosTried++;

        const ent = proc.readPtr(go + 0x128);
        if (!ent || ent < MIN_VALID_ADDR) continue;

        const hit = findByVtable(proc, proc.readPtr(ent + 0x190),
          readU32(proc, ent + 0x198) ?? 0, spawnerVtSet);
        if (hit) {
          hops++;
          return {
            ok: true,
            spawner: hit.addr,
            spawnerAddr: hit.addr,
            entity: ent,
            entityAddr: ent,
            level: curr,
            go,
            goIndex: i,
            cpntIndex: hit.index,
            game,
            scene,
            hops,
            levelsSeen,
            gosTried,
            ms: elapsedMs(),
            staticRva,
          };
        }
      }

      curr = proc.readPtr(curr + 0x10);
      listHops++;
    }

    return fail(`no tile spawner under ${gosTried} spawner GO(s) across ${levelsSeen} level(s)`);
  } catch (err) {
    return fail(String(err instanceof Error ? err.message : err));
  }
}
