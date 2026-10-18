'use strict';
// Melody availability reader module.
//
// Melodies are run-specific passives selected by the map generator (3 per run
// out of a total pool of 12). This module resolves:
//  1. The 12-melody static registry (via heap scan over MelodyEntityCpnt vtables)
//  2. The 3 selected melodies for the active run (from SceneContext GUIDs)
//  3. The per-melody lifecycle states (locked, active, completed from hero components)

import * as rtti from './rtti';
import { scanPointers } from './scan';
import type { ScanSource } from './scan';
import type { ByteSource } from './pe';

/**
 * What this module reads through.
 *
 * Extends ScanSource as well as ByteSource because findHeroes calls
 * scanPointers, which needs .regions() and .readInto(). Declaring only
 * ByteSource let a file-backed source satisfy this type and crash inside the
 * scan -- see the warning in scan.d.ts.
 *
 * Structural: win32.js is still JavaScript, and the fake-heap tests supply
 * their own object of the same shape.
 */
export interface MelodySource extends ByteSource, ScanSource {
  readPtr(addr: number): number | null;
  readI32(addr: number): number | null;
}

// RTTI mangled names (confirmed live)
const HERO_CONTROLLER_RTTI = '.?AVoCDtEntityCpntHeroController@@\0';
const MELODY_CPNT_RTTI = '.?AVMelodyEntityCpnt@dt@oe@@\0';

// Object Offsets (confirmed live)
const HERO_ENTITY_OFFSET = 0x08;
const ENTITY_CONTEXT_OFFSET = 0x30;
const CONTEXT_GUIDS_OFFSET = 0x760;
// The linked array is a {ptr, u32 count, u32 capacity} vector. The October
// 2026 game update moved it 0x18 later (was 0x13a0 / 0x13a8); the old slot now
// holds another vector's {count, capacity} pair, 0x800000001, which is why a
// stale offset reads as a non-pointer rather than as null.
const HERO_LINKED_MELODIES_OFFSET = 0x13b8;
const HERO_LINKED_COUNT_OFFSET = 0x13c0;
const MELODY_LIFECYCLE_OFFSET = 0x68;

const BASE_CPNT_ENTITY_OFFSET = 0x08;
const ENTITY_B_OBJECT_OFFSET = 0x28;
const B_GUID_OFFSET = 0x1c8;

export interface MelodyDefinition {
  readonly internal_name: string;
  readonly name: string;
  readonly notes: number;
  readonly icon: string;
  readonly effect: string;
}

/**
 * The three lifecycle values the game stores, as literals.
 *
 * The JavaScript rejected anything outside this set with an explicit
 * three-way test and there are tests asserting -1, 3, 99 and 255 are refused.
 * As a union the set is stated once and LIFECYCLE_STRINGS can be indexed
 * without a bounds check.
 */
export type Lifecycle = 0 | 1 | 2;
export type LifecycleName = 'locked' | 'active' | 'completed';

/** The run's three melodies, in slot order. Exactly three, always. */
export type MelodyPool = readonly [MelodyDefinition, MelodyDefinition, MelodyDefinition];

/** GUID (lowercase hex) -> definition. */
export type MelodyRegistry = ReadonlyMap<string, MelodyDefinition>;

export interface MelodyVtables {
  melodyCpntVt?: number;
  heroControllerVt?: number;
}

/** resolveRegistry's success shape: both vtables present, never partial. */
export interface ResolvedRegistry {
  readonly registry: MelodyRegistry;
  readonly melodyCpntVt: number;
  readonly heroControllerVt: number;
}

/** One row of the payload the renderer paints. */
export interface MelodySlotView {
  readonly slot: number;
  readonly internal_name: string;
  readonly name: string;
  readonly icon: string;
  readonly notes: number;
  /** Earned notes for the active melody; null means unreadable/not applicable. */
  readonly notes_earned: number | null;
  readonly state: LifecycleName | null;
  readonly effect: string;
}

// Static table of all 12 melodies in the game.
// `effect` is written to one line at the width a melody tile gets, so the long
// ones were cut to a reminder rather than a description -- the reader already
// knows the game. Where a line was cut, the game's full wording is kept above
// it as `full:` so nothing is lost if the layout ever affords more room.
const MELODY_DEFINITIONS: readonly MelodyDefinition[] = [
  {
    internal_name: 'Instant_Level_Up',
    name: 'Fairy Godmother',
    notes: 4,
    icon: 'UI_Melody_Icon_Godfairy.png',
    effect: 'The group of heroes instantly levels up',
  },
  {
    internal_name: 'Increase_Move_Speed_At_Day',
    name: 'Tortoise',
    notes: 4,
    icon: 'UI_Melody_Icon_Turtle.png',
    effect: 'Increases move speed for all heroes by 20%',
  },
  {
    internal_name: 'Increase_Fountain_Effect',
    name: 'Lady of the Lake',
    notes: 4,
    icon: 'UI_Melody_Icon_LadyLake.png',
    // full: Healing Fountains and Sacrificial Idols grant +100% VITALITY or DMG
    effect: 'Fountains/Idols Upgraded',
  },
  {
    internal_name: 'Fully_Heal',
    name: 'Galahad',
    notes: 4,
    icon: 'UI_Melody_Icon_Galahad.png',
    // full: Fully heals all heroes and grants 1 Raven's Feather at the start of
    // each day or night
    effect: '+1 Feather & Heal each day/night',
  },
  {
    internal_name: 'Remove_Key_Requirement',
    name: 'Merry Men',
    notes: 5,
    icon: 'UI_Melody_Icon_MerryMen.png',
    // full: Locks no longer need keys; each key grants 150 Dream Shards instead
    effect: 'No keys; +150 shards each',
  },
  {
    internal_name: 'Deal_Damage_Around',
    name: 'Goose Girl',
    notes: 5,
    icon: 'UI_Melody_Icon_Goose.png',
    // full: In combat, every 15s each hero unleashes a wind dealing area damage
    // around them
    effect: 'AOE burst every 15s',
  },
  {
    internal_name: 'Grant_Damage_Overtime',
    name: 'Hansel & Gretel',
    notes: 5,
    icon: 'UI_Melody_Icon_Hansel.png',
    // full: Once the Master Nightmare is awake, grants DMG every 20s until the
    // final showdown
    effect: '+DMG every 20s in overtime',
  },
  {
    internal_name: 'Power_Up_Level_Max',
    name: 'Little Tailor',
    notes: 5,
    icon: 'UI_Melody_Icon_Tailor.png',
    // full: Grants 3 consumables each time the group reaches a level above 10
    effect: '+3 consumes per level >10',
  },
  {
    internal_name: 'Reduce_MO_Per_Collection',
    name: 'Lucky Hans',
    notes: 6,
    icon: 'UI_Melody_Icon_LuckyHans.png',
    // full: Magical Object collections require 1 item less to be considered
    // completed
    effect: '1 less item per collection',
  },
  {
    internal_name: 'Slow_Hourglass_Flow',
    name: 'Otohime',
    notes: 6,
    icon: 'UI_Melody_Icon_OtoHime.png',
    effect: 'The Hourglass of Dreams empties 25% slower',
  },
  {
    internal_name: 'Reveal_Map',
    name: 'Long John Silver',
    notes: 6,
    icon: 'UI_Melody_Icon_LongJohnSilver.png',
    effect: 'Reveals all Raven Marks on the map',
  },
  {
    internal_name: 'Refill_Sandman_Dreams',
    name: 'Sheherazad',
    notes: 6,
    icon: 'UI_Melody_Icon_Sherazade.png',
    // full: Dreams obtained from the Sandman are restocked 1 time after being
    // purchased
    effect: 'Restock Sandman',
  },
];

const MELODY_DEFINITIONS_BY_NAME: Readonly<Record<string, MelodyDefinition>> =
  Object.fromEntries(MELODY_DEFINITIONS.map(d => [d.internal_name, d]));

const STATIC_MELODY_GUIDS: Readonly<Record<string, string>> = {
  'aa26da2300c9814da9d936b65f2c4418': 'Deal_Damage_Around',
  '81b92a3b8b658e41919c36bba7de848a': 'Fully_Heal',
  'fbd02d0e4f962942b6df6f2d8521021a': 'Grant_Damage_Overtime',
  '390f6d753f4da64397a4cd42b03d84e4': 'Increase_Fountain_Effect',
  '8e39850c20f70d4e8976e964bf56f4a1': 'Increase_Move_Speed_At_Day',
  '1f8363450d4b9d4a9bd5ef4efae46c7b': 'Instant_Level_Up',
  'd74b15932844974c8ac874e1575ac8f3': 'Power_Up_Level_Max',
  'eeb9b5b237666f4babe0c686efd464ff': 'Reduce_MO_Per_Collection',
  'a1ce4719ced3564cb6c1780fb4b4c7e2': 'Refill_Sandman_Dreams',
  '6d6b4135c454104dad62d371c7306295': 'Remove_Key_Requirement',
  '3aad65b7e8682c48b1d9e81ebb0c2bda': 'Reveal_Map',
  '5eb132959ec7de4bb19611ac926140f2': 'Slow_Hourglass_Flow',
};

export function getStaticRegistry(): Map<string, MelodyDefinition> {
  const map = new Map<string, MelodyDefinition>();
  for (const [guid, internalName] of Object.entries(STATIC_MELODY_GUIDS)) {
    const def = MELODY_DEFINITIONS_BY_NAME[internalName];
    if (def) map.set(guid, def);
  }
  return map;
}

const LIFECYCLE_STRINGS: readonly [LifecycleName, LifecycleName, LifecycleName] =
  ['locked', 'active', 'completed'];

/** Narrow an arbitrary read to the three values the game actually stores. */
function isLifecycle(v: number | null): v is Lifecycle {
  return v === 0 || v === 1 || v === 2;
}

export function guidToHex(buf: Buffer | string | null | undefined): string {
  if (!buf) return '';
  if (typeof buf === 'string') return buf.toLowerCase();
  return Buffer.from(buf).toString('hex').toLowerCase();
}

export function isZeroGuid(buf: Buffer | null | undefined): boolean {
  if (!buf) return true;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0) return false;
  }
  return true;
}

/**
 * Resolve the 12-melody registry, and the vtables the melody reads need.
 *
 * The registry itself is static: STATIC_MELODY_GUIDS covers all 12, so there
 * is nothing to scan for. The only work here is resolving the two vtables,
 * which the caller caches.
 *
 * Returns null rather than a partial object when either vtable is missing --
 * sweeper.js latches a truthy result and drops retry for the session, so a
 * half-resolved registry would poison the whole run. The return type says so
 * now: ResolvedRegistry has both vtables as plain numbers, so there is no
 * shape in which one is undefined.
 */
export function resolveRegistry(
  proc: MelodySource,
  base: number,
  vtables: MelodyVtables = {},
): ResolvedRegistry | null {
  let melodyCpntVt = vtables.melodyCpntVt;
  if (!melodyCpntVt) {
    const rva = rtti.resolveAllVtableRvas(proc, base, MELODY_CPNT_RTTI)[0];
    if (rva !== undefined) melodyCpntVt = base + rva;
  }

  let heroControllerVt = vtables.heroControllerVt;
  if (!heroControllerVt) {
    const rva = rtti.resolveAllVtableRvas(proc, base, HERO_CONTROLLER_RTTI)[0];
    if (rva !== undefined) heroControllerVt = base + rva;
  }

  if (!melodyCpntVt || !heroControllerVt) return null;

  return { registry: getStaticRegistry(), melodyCpntVt, heroControllerVt };
}

/**
 * Whether a hero controller is in use right now.
 *
 * The vtable does not answer this. Controllers are pooled and recycled, and a
 * retired one keeps its vtable for the life of the process, so a vtable match
 * says only "this is a hero controller" and never "this one belongs to a live
 * player". Holding a scene context is what separates the two.
 *
 * Both callers below need the same answer, so both ask this; two copies of
 * the test are how `readStates` and `findHeroes` once came to disagree.
 */
export function isLiveHero(proc: MelodySource, heroAddr: number): boolean {
  const entity = proc.readPtr(heroAddr + HERO_ENTITY_OFFSET);
  if (!entity) return false;
  return Boolean(proc.readPtr(entity + ENTITY_CONTEXT_OFFSET));
}

/**
 * Every live hero controller instance, as plain addresses.
 *
 * Fast path re-verifies cached addresses with two pointer reads each and no
 * scan. Falls back to a heap scan when no cached address is still live.
 *
 * A cached address has to pass both tests, not just the vtable. Testing the
 * vtable alone meant a single retired controller validated forever, and one
 * validating address was enough to skip the scan -- so a controller allocated
 * later was never discovered and the melody pool was read off a desk nobody
 * was sitting at.
 *
 * A live cached address short-circuits the scan, so this alone cannot notice
 * a controller appearing *alongside* a cached one that is also still live --
 * the second-player case. Passing `cachedHeroes` as null is what forces the
 * scan; sweeper.js does that on a fixed cadence (HERO_RESCAN_SWEEPS) so the
 * alongside case is found within one map segment.
 */
export function findHeroes(
  proc: MelodySource,
  vtables: MelodyVtables | null,
  cachedHeroes: readonly number[] | null = null,
): number[] {
  if (!vtables || !vtables.heroControllerVt) return [];
  const heroVt = vtables.heroControllerVt;

  if (cachedHeroes && cachedHeroes.length > 0) {
    const valid: number[] = [];
    for (const addr of cachedHeroes) {
      if (proc.readPtr(addr) !== heroVt) continue;
      if (!isLiveHero(proc, addr)) continue;
      valid.push(addr);
    }
    if (valid.length > 0) return valid;
  }

  const hits = scanPointers(proc, [heroVt], { writableOnly: true });
  return ((hits.get(heroVt) ?? []) as (number | [number, number])[])
    .map(h => (Array.isArray(h) ? h[0] : h));
}

export function readPool(
  proc: MelodySource,
  vtables: MelodyVtables | null,
  registry: MelodyRegistry | null,
  heroes: readonly number[] | null = null,
): MelodyPool | null {
  if (!registry || !vtables || !vtables.heroControllerVt) return null;

  const list = heroes ?? findHeroes(proc, vtables);
  if (!list.length) return null;

  for (const heroAddr of list) {
    const entity = proc.readPtr(heroAddr + HERO_ENTITY_OFFSET);
    if (!entity) continue;

    const sceneContext = proc.readPtr(entity + ENTITY_CONTEXT_OFFSET);
    if (!sceneContext) continue;

    const guidBytes = proc.read(sceneContext + CONTEXT_GUIDS_OFFSET, 48);
    if (!guidBytes || guidBytes.length < 48) continue;

    const g0 = guidBytes.subarray(0, 16);
    const g1 = guidBytes.subarray(16, 32);
    const g2 = guidBytes.subarray(32, 48);

    if (isZeroGuid(g0) || isZeroGuid(g1) || isZeroGuid(g2)) continue;

    const hex0 = guidToHex(g0);
    const hex1 = guidToHex(g1);
    const hex2 = guidToHex(g2);

    // GUIDs must be 3 distinct values. A stale or recycled hero controller
    // may hold duplicates or invalid GUIDs; continue rather than aborting the
    // entire sweep so a live hero later in scan order can still resolve.
    if (hex0 === hex1 || hex1 === hex2 || hex0 === hex2) continue;

    const def0 = registry.get(hex0);
    const def1 = registry.get(hex1);
    const def2 = registry.get(hex2);

    if (!def0 || !def1 || !def2) continue;

    return [def0, def1, def2];
  }

  return null;
}

interface Observation {
  readonly guidHex: string;
  readonly internalName: string | null;
  readonly lifecycle: Lifecycle;
}

/**
 * Read lifecycle state for each pool slot from hero controllers.
 * Matches linked melody components to pool slots by GUID identity.
 */
export function readStates(
  proc: MelodySource,
  vtables: MelodyVtables | null,
  pool: MelodyPool | null,
  registry: MelodyRegistry | null,
  heroes: readonly number[] | null = null,
): [number, number, number] | null {
  if (!vtables || !vtables.heroControllerVt) return null;
  // Length is guaranteed by MelodyPool, but this module is called from
  // JavaScript that the compiler does not check, so the runtime guard stays.
  if (!pool || !Array.isArray(pool) || pool.length !== 3) return null;

  const melodyVt = vtables.melodyCpntVt;
  const list = heroes ?? findHeroes(proc, vtables);
  if (!list.length) return null;

  const observations: Observation[] = [];
  let validHeroFound = false;

  for (const heroAddr of list) {
    // Only a hero holding a scene context is a live player. The controllers
    // are pooled and recycled: observed live, the context moved from one
    // instance to another WITHIN a single run, and the set grows across runs
    // rather than shrinking -- one context and two controllers in a
    // single-player run, two contexts and three in a two-player one. The
    // address is not an identity, so liveness has to be re-tested every sweep.
    //
    // Skipping the context-less ones is what keeps a previous run out of this
    // one. A recycled controller can still be holding the linked array it had
    // before, and merging is max(), which would latch a stale "completed"
    // melody and never let it go.
    if (!isLiveHero(proc, heroAddr)) continue;

    const buf = proc.readPtr(heroAddr + HERO_LINKED_MELODIES_OFFSET);
    const countBuf = proc.read(heroAddr + HERO_LINKED_COUNT_OFFSET, 4);
    const count = countBuf ? countBuf.readUInt32LE(0) : 0;

    if (!buf || count === 0) continue;
    // A buffer whose first entry cannot be read is not an array, and treating
    // it as one reports every slot "locked" with full confidence. That is how
    // a moved offset hid after a game update: the read landed on another
    // field, found nothing, and the overlay said locked forever. Leaving
    // validHeroFound unset makes the whole channel null, which the overlay
    // draws as unresolved -- visibly wrong instead of plausibly wrong.
    if (proc.readPtr(buf) === null) continue;
    validHeroFound = true;

    const maxCount = Math.min(count, 16);
    for (let i = 0; i < maxCount; i++) {
      const cpnt = proc.readPtr(buf + i * 8);
      if (!cpnt) continue;

      // Skip non-melody components instead of invalidating the read
      if (melodyVt) {
        const vt = proc.readPtr(cpnt);
        if (vt !== melodyVt) continue;
      }

      const lifecycle = proc.readI32(cpnt + MELODY_LIFECYCLE_OFFSET);
      if (!isLifecycle(lifecycle)) continue;

      const cpntEntity = proc.readPtr(cpnt + BASE_CPNT_ENTITY_OFFSET);
      if (!cpntEntity) continue;

      const objB = proc.readPtr(cpntEntity + ENTITY_B_OBJECT_OFFSET);
      if (!objB) continue;

      const guidBytes = proc.read(objB + B_GUID_OFFSET, 16);
      if (!guidBytes || isZeroGuid(guidBytes)) continue;
      const guidHex = guidToHex(guidBytes);

      // No name-recovery path here on purpose. The registry is always the
      // static 12 (getStaticRegistry), and every recovery route ends in a
      // MELODY_DEFINITIONS_BY_NAME lookup over those same 12 -- so a GUID the
      // registry does not know is a name that table does not know either, and
      // recovery could only ever return null in the one branch that ran it.
      // A 13th melody needs STATIC_MELODY_GUIDS regenerated, not a fallback.
      // The recovery walk lives in bench/melody-bench.js, as a measurement
      // rather than a read path.
      const internalName = registry?.get(guidHex)?.internal_name ?? null;

      observations.push({ guidHex, internalName, lifecycle });
    }
  }

  if (!validHeroFound) return null;
  return attributeStates(observations, pool, registry);
}

/**
 * Which pool slot each observed component belongs to, merged.
 *
 * Split out of readStates so it can be tested. readStates itself needs a live
 * heap scan to reach its inputs, so anything left inline there can only ever
 * be covered by a hand copy in the test file -- which passes whether or not
 * this module agrees. The attribution rule is the part that was wrong once
 * already, so it is the part that has to be reachable from a test.
 *
 * Attribution is by identity, never by array index. The linked array holds the
 * melodies engaged so far and grows during the run -- observed live at count 1
 * on a three-melody run -- so entry `i` says nothing about slot `i`.
 *
 * A slot no observation names has not been engaged, which is a real reading of
 * "locked" rather than a missing one: the array was read, and this melody was
 * not in it. `null` for the whole channel is the caller's business, and means
 * the array could not be read at all.
 */
export function attributeStates(
  observations: readonly Observation[] | null,
  pool: MelodyPool,
  registry: MelodyRegistry | null,
): [number, number, number] {
  const slotObserved: [number[], number[], number[]] = [[], [], []];
  for (const o of observations ?? []) {
    const slot = pool.findIndex(p =>
      (registry && registry.get(o.guidHex) === p) ||
      (o.internalName !== null && p.internal_name === o.internalName)
    );
    if (slot !== -1) slotObserved[slot as 0 | 1 | 2].push(o.lifecycle);
  }
  // max() across heroes absorbs the multiplayer sync lag where one client's
  // array has updated and another's has not.
  return slotObserved.map(seen => (seen.length ? Math.max(...seen) : 0)) as [number, number, number];
}

export interface MelodyProgress { readonly earned: number | null; readonly required: number }

/** The same uint16 event counter read by the game's melody completion handler. */
export function readHeroNoteCount(proc: MelodySource, hero: number): number | null {
  const data = proc.readPtr(hero + 0x1da8);
  if (!data) return null;
  const header = proc.read(data + 0x48, 16);
  if (!header || header.length !== 16) return null;
  const count = header.readUInt32LE(8), capacity = header.readUInt32LE(12);
  if (count > 256 || capacity < count || capacity > 65536) return null;
  if (count === 0) return 0;
  const entries = proc.readPtr(data + 0x48);
  if (!entries) return null;
  const bytes = proc.read(entries, count * 24);
  if (!bytes || bytes.length !== count * 24) return null;
  let result: number | null = null;
  for (let i = 0; i < count; i++) {
    if (bytes.readUInt32LE(i * 24 + 8) !== 0xc978d974) continue;
    if (result !== null) return null; // ambiguous progress context
    result = bytes.readUInt16LE(i * 24 + 12);
  }
  return result ?? 0;
}

/** Progress is shared by a hero's current melody, never all three pool slots. */
export function readProgress(
  proc: MelodySource, vtables: MelodyVtables | null, pool: MelodyPool,
  states: readonly number[] | null, registry: MelodyRegistry | null,
  heroes: readonly number[],
): (MelodyProgress | null)[] {
  const found: MelodyProgress[][] = [[], [], []];
  if (!vtables?.heroControllerVt || !vtables.melodyCpntVt || !states || !registry) return found.map(() => null);
  for (const hero of heroes) {
    if (proc.readPtr(hero) !== vtables.heroControllerVt || !isLiveHero(proc, hero)) continue;
    const array = proc.readPtr(hero + HERO_LINKED_MELODIES_OFFSET);
    const n = proc.readI32(hero + HERO_LINKED_COUNT_OFFSET);
    if (!array || n === null || n < 1 || n > 16) continue;
    const active: { slot: number; required: number }[] = [];
    for (let i = 0; i < n; i++) {
      const cpnt = proc.readPtr(array + i * 8);
      if (!cpnt || proc.readPtr(cpnt) !== vtables.melodyCpntVt || proc.readI32(cpnt + 0x68) !== 1) continue;
      const entity = proc.readPtr(cpnt + 8), object = entity ? proc.readPtr(entity + 0x28) : null;
      const guid = object ? proc.read(object + 0x1c8, 16) : null;
      const def: MelodyDefinition | null | undefined = guid ? registry.get(guidToHex(guid)) : null;
      const slot = def ? pool.findIndex(p => p.internal_name === def.internal_name) : -1;
      if (slot < 0 || states[slot] !== 1) continue;
      const definition = proc.readPtr(cpnt + 0x168);
      const required = definition ? proc.readI32(definition + 0x320) : null;
      if (required !== null && required > 0 && required <= 65535) active.push({ slot, required });
    }
    // Never attach one shared counter to multiple active melodies on one hero.
    const only = active.length === 1 ? active[0] : undefined;
    if (!only) continue;
    const earned = readHeroNoteCount(proc, hero);
    found[only.slot]?.push({ required: only.required, earned: earned !== null && earned <= only.required ? earned : null });
  }
  return found.map(rows => {
    const first = rows[0];
    if (!first || new Set(rows.map(r => r.required)).size !== 1) return null;
    const known = rows.flatMap(r => r.earned === null ? [] : [r.earned]);
    return { required: first.required, earned: known.length ? Math.max(...known) : null };
  });
}

/**
 * Combine pool and lifecycle states into the final output contract.
 * Unresolved states remain null and must render as unresolved.
 */
export function combineMelodies(
  pool: MelodyPool | null,
  states: readonly number[] | null,
  progress: readonly (MelodyProgress | null)[] | null = null,
): MelodySlotView[] | null {
  if (!pool || !Array.isArray(pool) || pool.length !== 3) return null;

  return pool.map((def, slot) => {
    let stateStr: LifecycleName | null = null;
    const s = states ? states[slot] : undefined;
    if (s !== undefined && isLifecycle(s)) stateStr = LIFECYCLE_STRINGS[s];
    return {
      slot,
      internal_name: def.internal_name,
      name: def.name,
      icon: def.icon,
      notes: progress?.[slot]?.required ?? def.notes,
      notes_earned: stateStr === 'active' ? progress?.[slot]?.earned ?? null : null,
      state: stateStr,
      effect: def.effect,
    };
  });
}

export {
  MELODY_DEFINITIONS,
  MELODY_DEFINITIONS_BY_NAME,
  HERO_CONTROLLER_RTTI,
  MELODY_CPNT_RTTI,
  HERO_ENTITY_OFFSET,
  ENTITY_CONTEXT_OFFSET,
  CONTEXT_GUIDS_OFFSET,
  HERO_LINKED_MELODIES_OFFSET,
  HERO_LINKED_COUNT_OFFSET,
  MELODY_LIFECYCLE_OFFSET,
  BASE_CPNT_ENTITY_OFFSET,
  ENTITY_B_OBJECT_OFFSET,
  B_GUID_OFFSET,
  STATIC_MELODY_GUIDS,
};
