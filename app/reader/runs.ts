'use strict';
// The run-end channel: what the victory or defeat summary showed, read once
// per run. See run_history_plan.md for the design and live_memory_reading.md
// ("The run record", "Run score and score details", "Run talents") for the
// layout each reader below follows.
//
// Three sources, read at different times:
//
//  * The run record (oCDtCurrentRunProfileData) is complete the moment either
//    end flag rises, and clears within a second of End. It is read on the edge.
//  * Selected talents hang off the same record and are readable on the edge.
//  * The score page is NOT current on the edge. A second run in one process
//    showed the previous run's total and detail lines for over 25 s, with the
//    label and the int cache agreeing. What moved when the current score
//    arrived was the detail vector's buffer at controller +0x1F8, so the
//    buffer pointer seen on the edge is the baseline, and a read counts only
//    once the buffer differs from it (scoreReady).
//
// Every reader throws on a layout it does not recognise rather than returning
// a partial answer. The worker turns a throw into a missing field, never into
// a zero.

import type { ByteSource } from './pe';
import type { MelodySlotView } from './melodies';

/** Mangled RTTI names, as resolveAllVtableRvas takes them (without the NUL). */
export const RUN_CLASSES = {
  record: '.?AVoCDtCurrentRunProfileData@@',
  controller: '.?AVoCDtEntityCpntHeroController@@',
  smooth: '.?AVoCEntityCpntSmoothValue@@',
  hero: '.?AVoCDtEntityCpntHeroControllerPersistentData@@',
  skill: '.?AVoCDtEntityCpntSkillControllerPersistentData@@',
  settings: '.?AVoCDtEntityCpntSkillControllerSettings@@',
  runtime: '.?AVoCDtEntityCpntSkillController@@',
  text: '.?AV?$DynamicCpntValueListenerData@V?$oCTStr@D@@@oe@@',
  int: '.?AV?$DynamicCpntValueListenerData@H@oe@@',
  localText: '.?AVoCLocalText@@',
  score: '.?AVEntityCpntBookScoreUiController@dt@oe@@',
  entity: '.?AVoCEntity@@',
  label: '.?AVoCEntityCpntLabelUi@@',
  operations: '.?AVoCEntityCpntValueOperations@EntityCpntValueOperations@oe@@',
} as const;

export type RunClassKey = keyof typeof RUN_CLASSES;

/** The mangled class name of the object at an address, or null. */
export type ClassOf = (addr: number) => string | null;

/** The GlobalValues the channel polls. Tracked by the sweep, relayed here. */
export const DEFEAT_FLAG = 'Is in defeat sequence';
export const VICTORY_FLAG = 'Is in victory sequence';
export const GAME_DIFFICULTY = 'Game Difficulty';
export const CURRENT_CHAPTER = 'Current chapter';
/** Same string as state.ts's CURRENT_MAP_ID; repeated so this module imports nothing. */
const MAP_ID = 'Current map id';

/** The names Reader relays to the worker. Kept here so the relay and the poll agree. */
export const RUN_VALUE_NAMES: readonly string[] = [
  DEFEAT_FLAG, VICTORY_FLAG, GAME_DIFFICULTY, CURRENT_CHAPTER, MAP_ID,
];

// Record offsets. HeroScoreData is embedded at +0xD8; the statistics below are
// record offsets, already including it.
const RECORD = {
  persistent: 0x10,
  heroSettings: 0x20,
  heroDefinition: 0x70,
  playtime: 0x9C,
  level: 0xA0,
  objects: 0xE0,
  objectCounts: 0xF0,
} as const;

/** Statistics page rows, grouped as the game groups them. All float32. */
export const STAT_ROWS = {
  damage: {
    total: 0x180, dash: 0x184, trait: 0x188, attack: 0x18C, power: 0x190,
    special: 0x194, defense: 0x198, ultimate: 0x19C, other: 0x1A0, highest: 0x1A4,
  },
  support: {
    self_heal: 0x1A8, ally_heal: 0x1AC, self_shield: 0x1B0, ally_shield: 0x1B4,
    blocked: 0x1B8, revive_assists: 0x1BC,
  },
  sufferings: { taken: 0x1C0, deaths_doors: 0x1C4, feathers: 0x1C8 },
  resources: {
    shards_amassed: 0x1CC, shards_spent: 0x1D0, stars_of_fate: 0x1D4, objects_collected: 0x1D8,
  },
} as const;

type StatGroup = keyof typeof STAT_ROWS;
export type RunStats = { [G in StatGroup]: { [K in keyof typeof STAT_ROWS[G]]: number } };

/** Rarity codes, screen-matched except Rare=1, which the player supplied. */
export const RARITY: Readonly<Record<number, string>> = {
  0: 'Common', 1: 'Rare', 2: 'Epic', 3: 'Legendary', 4: 'Ultimate',
};

// A playtime or level outside these is a stale address or a moved layout,
// not a run, and is dropped rather than stored.
export const PLAYTIME_MAX_S = 14400;
export const LEVEL_MIN = 1;
export const LEVEL_MAX = 99;

// ------------------------------------------------------------- primitives --

const hex = (n: number): string => '0x' + n.toString(16).toUpperCase();

function bytes(proc: ByteSource, addr: number, size: number): Buffer {
  const b = proc.read(addr, size);
  if (!b || b.length < size) throw new Error(`unreadable ${hex(addr)} (${size} bytes)`);
  return b;
}

function ptr(proc: ByteSource, addr: number): number {
  return Number(bytes(proc, addr, 8).readBigUInt64LE());
}

function i32(proc: ByteSource, addr: number): number {
  return bytes(proc, addr, 4).readInt32LE();
}

function f32(proc: ByteSource, addr: number): number {
  return bytes(proc, addr, 4).readFloatLE();
}

function guidAt(proc: ByteSource, addr: number): string {
  return bytes(proc, addr, 16).toString('hex');
}

/** A game string header: data pointer, byte length (high bit is a flag), capacity. */
export function stringAt(proc: ByteSource, field: number, maxLength = 1024): string {
  const header = bytes(proc, field, 16);
  const data = Number(header.readBigUInt64LE());
  const length = header.readUInt32LE(8) & 0x7fffffff;
  if (length === 0) return '';
  if (data < 0x10000 || length > maxLength) throw new Error(`invalid string at ${hex(field)}`);
  const text = bytes(proc, data, length).toString('utf8').replace(/\0$/, '');
  if (text.includes('\uFFFD') || text.includes('\0')) throw new Error(`invalid UTF-8 at ${hex(field)}`);
  return text;
}

export interface VectorHeader { ptr: number; count: number; capacity: number }

/** A vector header: pointer, int32 count, int32 capacity. */
export function vectorAt(proc: ByteSource, field: number, maxCount: number): VectorHeader {
  const b = bytes(proc, field, 16);
  const p = Number(b.readBigUInt64LE());
  const count = b.readInt32LE(8);
  const capacity = b.readInt32LE(12);
  if (count < 0 || count > maxCount || capacity < count || (count && p < 0x10000)) {
    throw new Error(`invalid vector at ${hex(field)}`);
  }
  return { ptr: p, count, capacity };
}

// ------------------------------------------------------------ run record --

export interface RunRecord {
  /** Skin entity name, for example Hero_Kintaro_Jungle. */
  hero: string;
  /** Hero definition path, for example Heroes\Juliet_Update6.herodef.ot. */
  hero_definition: string;
  playtime_s: number;
  level: number;
  stats: RunStats;
  /** Magical object GUIDs, as the 16 bytes in memory order, hex. */
  objects: string[];
  /** uint16 quantities parallel to objects; null means the counts could not be read. */
  object_counts: number[] | null;
}

/** The hero's code from its definition path: Heroes\Juliet_Update6.herodef.ot -> Juliet. */
export function heroCode(definition: string): string {
  const file = definition.split(/[\\/]/).pop() ?? '';
  return file.replace(/\.herodef\.ot$/i, '').replace(/_Update\d+$/i, '');
}

export function readRecord(proc: ByteSource, record: number, classOf: ClassOf): RunRecord {
  if (classOf(record) !== RUN_CLASSES.record) throw new Error('wrong run record class');
  const hero = stringAt(proc, ptr(proc, record + RECORD.heroSettings) + 8, 256);
  if (!/^Hero_/.test(hero)) throw new Error('missing hero identity');
  const definition = stringAt(proc, record + RECORD.heroDefinition, 512);

  const stats = {} as Record<string, Record<string, number>>;
  for (const [group, rows] of Object.entries(STAT_ROWS)) {
    const out: Record<string, number> = {};
    for (const [name, offset] of Object.entries(rows)) out[name] = f32(proc, record + offset);
    stats[group] = out;
  }

  const objects: string[] = [];
  const vec = vectorAt(proc, record + RECORD.objects, 256);
  for (let i = 0; i < vec.count; i++) objects.push(guidAt(proc, vec.ptr + i * 16));

  // A failed quantity read must not lose the rest of the run. Keep unknown
  // distinct from an empty inventory or a real zero quantity.
  let objectCounts: number[] | null = null;
  try {
    const counts = vectorAt(proc, record + RECORD.objectCounts, 256);
    if (counts.count === vec.count) {
      const raw = counts.count ? bytes(proc, counts.ptr, counts.count * 2) : Buffer.alloc(0);
      objectCounts = Array.from({ length: counts.count }, (_, i) => raw.readUInt16LE(i * 2));
    }
  } catch { /* quantities unavailable; the GUIDs and statistics remain valid */ }

  return {
    hero,
    hero_definition: definition,
    playtime_s: f32(proc, record + RECORD.playtime),
    level: f32(proc, record + RECORD.level),
    stats: stats as unknown as RunStats,
    objects,
    object_counts: objectCounts,
  };
}

/** Why a record read is not a run, or null when it is one. */
export function recordProblem(r: RunRecord): string | null {
  if (!(r.playtime_s > 0)) return 'zero playtime';
  if (r.playtime_s > PLAYTIME_MAX_S) return `playtime ${r.playtime_s} out of range`;
  if (!(r.level >= LEVEL_MIN && r.level <= LEVEL_MAX)) return `level ${r.level} out of range`;
  return null;
}

// Hero attributes reset before the persistent result book closes. Snapshot
// these HUD display fields during play; do not read them after the end edge.
export const HERO_STAT_NAMES = {
  damage: 'AP Smooth Value', armor: 'Armour Smooth Value',
  crit_chance: 'Crit Chance Smooth Value', crit_damage: 'Crit Damage Smooth Value',
  vitality: 'Vitality Smooth Value',
} as const;
export type HeroStats = { -readonly [K in keyof typeof HERO_STAT_NAMES]: number };
export interface HeroStatFields {
  controller: number;
  entity: number;
  context: number;
  fields: { [K in keyof HeroStats]: number };
}
export function findHeroStatFields(proc: ByteSource, hero: string, classOf: ClassOf, controllers: readonly number[]): HeroStatFields | null {
  const matches: HeroStatFields[] = [];
  for (const controller of controllers) {
    if (classOf(controller) !== RUN_CLASSES.controller) continue;
    try {
      const entity = ptr(proc, controller + 8);
      const context = ptr(proc, entity + 0x30);
      if (!context || stringAt(proc, ptr(proc, entity + 0x28) + 8, 256) !== hero) continue;
      const components = vectorAt(proc, entity + 0x190, 10000);
      const fields: Partial<HeroStatFields['fields']> = {};
      for (let i = 0; i < components.count; i++) {
        const c = ptr(proc, components.ptr + i * 8);
        if (classOf(c) !== RUN_CLASSES.smooth || ptr(proc, c + 8) !== entity) continue;
        const name = stringAt(proc, ptr(proc, c + 0x10) + 0xE8, 256);
        for (const [key, expected] of Object.entries(HERO_STAT_NAMES)) {
          if (name !== expected) continue;
          const stat = key as keyof HeroStats;
          if (fields[stat] !== undefined) throw new Error('duplicate hero attribute');
          fields[stat] = c + 0x130;
        }
      }
      if (Object.keys(fields).length === Object.keys(HERO_STAT_NAMES).length) {
        matches.push({ controller, entity, context, fields: fields as HeroStatFields['fields'] });
      }
    } catch { /* unsupported or stale entity; do not guess */ }
  }
  return matches.length === 1 ? matches[0] ?? null : null;
}
export function readHeroStats(proc: ByteSource, held: HeroStatFields, classOf: ClassOf): HeroStats {
  if (classOf(held.controller) !== RUN_CLASSES.controller || ptr(proc, held.controller + 8) !== held.entity
    || ptr(proc, held.entity + 0x30) !== held.context) throw new Error('stale hero attribute owner');
  const stats = {} as HeroStats;
  for (const [key, addr] of Object.entries(held.fields)) {
    if (classOf(addr - 0x130) !== RUN_CLASSES.smooth || ptr(proc, addr - 0x130 + 8) !== held.entity) {
      throw new Error('stale hero attribute field');
    }
    const value = f32(proc, addr);
    if (!Number.isFinite(value)) throw new Error('invalid hero attribute');
    stats[key as keyof HeroStats] = value;
  }
  return stats;
}

// --------------------------------------------------------------- talents --

export interface Talent {
  /** Display name, in the game's language. */
  name: string;
  /** Internal skill name from the settings, for example Skill_Kintaro_Dash. */
  key: string;
  rarity: string | null;
  rarity_code: number;
  /** Already formatted by the game, including current numbers and markup. */
  description?: string | null;
  description_sampled_at?: string | null;
}

function localizedName(proc: ByteSource, payload: number, classOf: ClassOf): string | null {
  if (!payload) return null;
  const table = ptr(proc, payload + 0x40);
  if (!table || classOf(table) !== RUN_CLASSES.localText) return null;
  const key = stringAt(proc, payload + 0x58, 256);
  if (!key) return null;
  const keys = vectorAt(proc, table + 0x80, 10000);
  const texts = vectorAt(proc, table + 0xA0, 10000);
  let index = i32(proc, payload + 0x50);
  if (index < 0 || index >= keys.count || stringAt(proc, keys.ptr + index * 16, 256) !== key) {
    const matches: number[] = [];
    for (let i = 0; i < keys.count; i++) {
      if (stringAt(proc, keys.ptr + i * 16, 256) === key) matches.push(i);
    }
    const only = matches.length === 1 ? matches[0] : undefined;
    if (only === undefined) throw new Error(`ambiguous or missing localization key ${key}`);
    index = only;
  }
  if (index >= texts.count) throw new Error('localization value missing');
  const name = stringAt(proc, texts.ptr + index * 16, 1024);
  if (!name) throw new Error('empty localized talent name');
  return name;
}

/** Runtime controllers owned by this hero entity, with no new heap scan. */
export function findTalentRuntimes(proc: ByteSource, entity: number, classOf: ClassOf): number[] {
  const components = vectorAt(proc, entity + 0x190, 10000);
  const result: number[] = [];
  for (let i = 0; i < components.count; i++) {
    const runtime = ptr(proc, components.ptr + i * 8);
    if (runtime && classOf(runtime) === RUN_CLASSES.runtime && ptr(proc, runtime + 8) === entity) result.push(runtime);
  }
  return result;
}

/** Missing or disagreeing live texts are unavailable, not guessed from a baseline. */
export function talentDescription(proc: ByteSource, def: number, classOf: ClassOf, runtimes: readonly number[]): string | null {
  const descriptions = new Set<string>();
  for (const runtime of runtimes) {
    try {
      if (classOf(runtime) !== RUN_CLASSES.runtime || ptr(proc, runtime + 0x10) !== def) continue;
      const entity = ptr(proc, runtime + 8);
      if (!entity || !ptr(proc, entity + 0x30)) continue;
      const text = stringAt(proc, runtime + 0x90, 8192);
      if (text.trim()) descriptions.add(text);
    } catch { /* a retired or unreadable runtime cannot erase the run */ }
  }
  return descriptions.size === 1 ? [...descriptions][0] ?? null : null;
}

/** Prefer the last in-run text over a potentially reset end-screen value. */
export function retainTalentDescriptions(current: readonly Talent[], previous: readonly Talent[] | null): Talent[] {
  return current.map(t => {
    const old = previous?.find(p => p.key === t.key && p.rarity_code === t.rarity_code);
    return old?.description ? { ...t, description: old.description, description_sampled_at: old.description_sampled_at ?? null } : { ...t };
  });
}

/**
 * The selected talents, in screen order.
 *
 * `settings` and `runtimes` are every address a heap scan found holding one of
 * the skill-settings or skill-controller vtables. The settings scan also finds
 * secondary-vtable hits; only a primary object, whose +0x18 points to itself,
 * is a definition.
 */
export function readTalents(
  proc: ByteSource,
  record: number,
  classOf: ClassOf,
  settings: readonly number[],
  runtimes: readonly number[],
): Talent[] {
  if (classOf(record) !== RUN_CLASSES.record) throw new Error('wrong run record class');
  const owner = 'Hero_' + heroCode(stringAt(proc, record + RECORD.heroDefinition, 512));

  const persistent = vectorAt(proc, record + RECORD.persistent, 512);
  const byGuid = new Map<string, number>();
  const heroes: number[] = [];
  for (let i = 0; i < persistent.count; i++) {
    const entry = ptr(proc, persistent.ptr + i * 8);
    const cls = classOf(entry);
    if (cls === RUN_CLASSES.hero) heroes.push(entry);
    if (cls === RUN_CLASSES.skill) {
      const guid = guidAt(proc, entry + 0x20);
      if (byGuid.has(guid)) throw new Error('duplicate persistent skill GUID');
      byGuid.set(guid, i32(proc, entry + 0x50));
    }
  }
  const hero = heroes.length === 1 ? heroes[0] : undefined;
  if (hero === undefined) throw new Error(`expected one hero persistent entry, got ${heroes.length}`);

  const chosen = vectorAt(proc, hero + 0xE8, 128);
  const selected: string[] = [];
  for (let i = 0; i < chosen.count; i++) selected.push(guidAt(proc, chosen.ptr + i * 16));
  if (new Set(selected).size !== selected.length) throw new Error('duplicate chosen talent GUID');

  const definitions = new Map<string, number[]>(selected.map(g => [g, []]));
  for (const addr of settings) {
    if (classOf(addr) !== RUN_CLASSES.settings) continue;
    if (ptr(proc, addr + 0x18) !== addr) continue;
    const list = definitions.get(guidAt(proc, addr + 0x88));
    if (!list) continue;
    const ownerSettings = ptr(proc, addr + 0x48);
    if (!ownerSettings || stringAt(proc, ownerSettings + 8, 256) !== owner) continue;
    list.push(addr);
  }

  return selected.map((guid) => {
    const rarityCode = byGuid.get(guid);
    if (rarityCode === undefined) throw new Error(`chosen GUID ${guid} missing from persistent skills`);
    const candidates = definitions.get(guid) ?? [];
    const def = candidates.length === 1 ? candidates[0] : undefined;
    if (def === undefined) throw new Error(`expected one ${owner} definition for ${guid}, got ${candidates.length}`);

    // Settings +0x180 embeds the name picker; its payload pointer is at +0x68.
    let name = localizedName(proc, ptr(proc, def + 0x180 + 0x68), classOf);
    if (name === null) {
      // Delegated: the runtime controller for these settings carries the name.
      const names = new Set<string>();
      for (const rt of runtimes) {
        if (classOf(rt) !== RUN_CLASSES.runtime || ptr(proc, rt + 0x10) !== def) continue;
        const listener = ptr(proc, rt + 0xA8);
        if (!listener || classOf(listener) !== RUN_CLASSES.text) continue;
        const text = stringAt(proc, listener + 8, 1024);
        if (text) names.add(text);
      }
      const only = names.size === 1 ? [...names][0] : undefined;
      if (only === undefined) throw new Error(`talent name unavailable or ambiguous for ${guid}`);
      name = only;
    }
    return { name, key: stringAt(proc, def + 0xE8, 256), rarity: RARITY[rarityCode] ?? null, rarity_code: rarityCode,
      description: talentDescription(proc, def, classOf, runtimes) };
  });
}

// ----------------------------------------------------------------- score --

export interface ScoreRead {
  total: number;
  details: string[];
  /** The detail vector's buffer pointer: the readiness signal. */
  detail_buffer: number;
}

/** The detail buffer pointer on its own, or null when the header is unreadable. */
export function detailBuffer(proc: ByteSource, controller: number): number | null {
  const b = proc.read(controller + 0x1F8, 8);
  return b && b.length === 8 ? Number(b.readBigUInt64LE()) : null;
}

export function readScore(proc: ByteSource, controller: number, classOf: ClassOf): ScoreRead {
  if (classOf(controller) !== RUN_CLASSES.score) throw new Error('wrong score controller class');
  const entity = ptr(proc, controller + 8);
  if (classOf(entity) !== RUN_CLASSES.entity) throw new Error('missing score entity');
  if (stringAt(proc, ptr(proc, entity + 0x28) + 8, 256) !== 'Score_Book_Page') {
    throw new Error('unexpected score entity');
  }

  const components = vectorAt(proc, entity + 0x190, 512);
  let label: number | null = null;
  let operation: number | null = null;
  for (let i = 0; i < components.count; i++) {
    const c = ptr(proc, components.ptr + i * 8);
    const cls = classOf(c);
    if (cls !== RUN_CLASSES.label && cls !== RUN_CLASSES.operations) continue;
    if (ptr(proc, c + 8) !== entity) continue;
    const name = stringAt(proc, ptr(proc, c + 0x10) + 0xE8, 256);
    if (cls === RUN_CLASSES.label && name === 'Score Label') {
      if (label !== null) throw new Error('ambiguous Score Label');
      label = c;
    }
    if (cls === RUN_CLASSES.operations && name === 'Score Display Operation') {
      if (operation !== null) throw new Error('ambiguous Score Display Operation');
      operation = c;
    }
  }
  if (label === null) throw new Error('Score Label component not found');

  const listener = ptr(proc, label + 0x170);
  if (classOf(listener) !== RUN_CLASSES.text) throw new Error('wrong score text listener class');
  const displayed = stringAt(proc, listener + 8, 64);
  if (!/^\d+$/.test(displayed)) throw new Error('non-numeric score label');
  const total = Number(displayed);
  if (!Number.isSafeInteger(total) || total > 0x7fffffff) throw new Error('score outside int32 range');

  if (operation !== null) {
    const inputs = vectorAt(proc, operation + 0x68, 64);
    const caches: number[] = [];
    for (let i = 0; i < inputs.count; i++) {
      const l = ptr(proc, inputs.ptr + i * 0x18 + 8);
      if (l && classOf(l) === RUN_CLASSES.int) caches.push(i32(proc, l + 8));
    }
    if (caches.length && !caches.includes(total)) throw new Error('displayed total disagrees with integer cache');
  }

  const vec = vectorAt(proc, controller + 0x1F8, 128);
  const details: string[] = [];
  for (let i = 0; i < vec.count; i++) details.push(stringAt(proc, vec.ptr + i * 0x20 + 8));
  return { total, details, detail_buffer: vec.ptr };
}

/**
 * Whether a score read belongs to the run that just ended: its detail buffer
 * is not one seen on the end flag's edge. On the first run of a session there
 * is no earlier page, so the baseline is empty and any filled buffer counts.
 */
export function scoreReady(baseline: ReadonlySet<number>, read: ScoreRead): boolean {
  return read.detail_buffer !== 0 && !baseline.has(read.detail_buffer);
}

/** History outlives the Live view's clearing on the summary/menu screen. */
export interface RunMelodySnapshot {
  melodies: MelodySlotView[] | null;
  outsideRun: boolean;
}
export function nextRunMelodySnapshot(previous: RunMelodySnapshot, mapId: number | null,
  reset: boolean, current: readonly MelodySlotView[] | null): RunMelodySnapshot {
  if (mapId === null) return previous;
  // A level reset on the end screen must not erase the run awaiting capture.
  if (mapId < 0) return { melodies: previous.melodies, outsideRun: true };
  const startsRun = previous.outsideRun || reset;
  return {
    outsideRun: false,
    melodies: current === null ? (startsRun ? null : previous.melodies) : current.map(m => {
      const old = !startsRun ? previous.melodies?.find(p => p.internal_name === m.internal_name && p.state === 'active' && p.notes === m.notes) : null;
      return m.state === 'active' && m.notes_earned == null && old?.notes_earned != null ? { ...m, notes_earned: old.notes_earned } : { ...m };
    }),
  };
}

// --------------------------------------------------------------- summary --

export type RunResult = 'defeat' | 'victory';

/** One stored run. Raw values; the renderer words them at display time. */
export interface RunSummary {
  v: 1;
  /** Wall-clock milliseconds of the end flag's edge. Unique per run. */
  id: number;
  ended: string;
  result: RunResult;
  hero: string;
  hero_definition: string;
  difficulty: number | null;
  map: number | null;
  map_name: string | null;
  chapter: number | null;
  playtime_s: number;
  level: number;
  score: { total: number; details: string[] } | null;
  talents: Talent[] | null;
  hero_stats: HeroStats | null;
  hero_stats_sampled_at: string | null;
  melodies: MelodySlotView[] | null;
  damage: RunStats['damage'];
  support: RunStats['support'];
  sufferings: RunStats['sufferings'];
  resources: RunStats['resources'];
  objects: string[];
  /** uint16 quantities parallel to objects; null means the counts could not be read. */
  object_counts: number[] | null;
}

export interface RunContext {
  id: number;
  result: RunResult;
  difficulty: number | null;
  map: number | null;
  chapter: number | null;
}

export function buildSummary(ctx: RunContext, record: RunRecord, talents: Talent[] | null, melodies: readonly MelodySlotView[] | null = null, heroStats: HeroStats | null = null, heroStatsAt: string | null = null): RunSummary {
  return {
    v: 1,
    id: ctx.id,
    ended: new Date(ctx.id).toISOString(),
    result: ctx.result,
    hero: record.hero,
    hero_definition: record.hero_definition,
    difficulty: ctx.difficulty,
    map: ctx.map,
    map_name: null,
    chapter: ctx.chapter,
    playtime_s: record.playtime_s,
    level: record.level,
    score: null,
    talents,
    hero_stats: heroStats === null ? null : { ...heroStats },
    hero_stats_sampled_at: heroStatsAt,
    melodies: melodies === null ? null : melodies.map(m => ({ ...m })),
    ...record.stats,
    objects: record.objects,
    object_counts: record.object_counts,
  };
}

/**
 * Which end flag rose between two polls, or null. `prev` null means the flag
 * has not been read yet: a summary already up when the reader attaches is
 * not an edge, because its score baseline cannot be known.
 */
export function endEdge(
  prev: { defeat: number | null; victory: number | null } | null,
  now: { defeat: number | null; victory: number | null },
): RunResult | null {
  if (prev === null) return null;
  if (prev.defeat === 0 && now.defeat === 1) return 'defeat';
  if (prev.victory === 0 && now.victory === 1) return 'victory';
  return null;
}
