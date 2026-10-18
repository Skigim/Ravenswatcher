'use strict';
// The view model. `readState()` is the whole output contract: one poll of
// everything the readout shows, as plain data.
//
// Two rules every reader of a frame keeps:
//
//  * Map ids start at 0. Nothing here hardcodes a map id -- ids come from the
//    "<Map name> map id" constants read out of the process, and `maps` is
//    just that lookup. Dark Hills is 0, so a map id of 0 must never be
//    treated as falsy.
//  * A zero is a real reading, distinct from unresolved. Unresolved means the
//    sweep has not resolved the address; `0` means the value is genuinely zero.
//
//    The type system holds both: a polled value is a `Reading`, never a bare
//    `number | null`, and there is no `.value` to reach until `.ok` has been
//    checked. `if (!mapId)` cannot be written against a Reading in a way that
//    compiles AND yields a number. `strictNullChecks` alone does NOT give you
//    this -- it is happy with `if (!x)` on a `number | null`, which is
//    precisely the bug shape.
//
// Nothing here caches. The sweeper holds the value index across sweeps; this
// turns one poll into one frame.

import { BINDING_VTABLE_RVA } from './values';
// Type-only: erased at emit, so this adds no runtime dependency on melodies.
import type { MelodySlotView } from './melodies';
import type { SandmanOffer, SandmanStatus } from './sandman';
import { bucketTier, type PlacedTile } from './tiles';
import { DEFEAT_FLAG, VICTORY_FLAG, GAME_DIFFICULTY, CURRENT_CHAPTER, type RunSummary } from './runs';

// ---------------------------------------------------------------- readings --

/**
 * One polled value: resolved to a number, or not resolved at all.
 *
 * The whole point of the wrapper is that the number is unreachable without
 * narrowing, so "absent" can never be silently read as "zero". Use `ticked()`
 * for the recurring "resolved and non-zero" question rather than open-coding
 * it, and `raw()` only at the JSON boundary, where a union cannot survive.
 */
export type Reading =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false };

const UNRESOLVED: Reading = { ok: false };

/** Wrap a raw poll result. `undefined` and `null` are both "not resolved". */
export function reading(v: number | null | undefined): Reading {
  return (v === null || v === undefined) ? UNRESOLVED : { ok: true, value: v };
}

/** Unwrap for serialisation. The only place a Reading becomes number|null. */
export function raw(r: Reading): number | null {
  return r.ok ? r.value : null;
}

/**
 * Resolved AND non-zero -- "this counter has actually ticked".
 *
 * Named because it is the test the questline cascade asks six times, and
 * because writing it out each time is where the truthiness bug keeps trying
 * to get back in. All six sites call it.
 *
 * A type predicate, so the true branch narrows and `.value` is reachable
 * without a second check. It asserts only the `.ok` half -- the non-zero half
 * is not expressible as a type -- which is sound: nothing here needs the
 * compiler to know the value is non-zero, only that it exists.
 */
export function ticked(r: Reading): r is { ok: true; value: number } {
  return r.ok && r.value !== 0;
}

// ------------------------------------------------------------------ tables --

export type QuestKey = 'pigs' | 'jack' | 'mordred' | 'tree' | 'roc' | 'cyclop';

const TRACKED_NAMES_PROCESS = 'Ravenswatch.exe';
const SWEEP_INTERVAL = 5;
const POLL_MS = 250;

type LabelTable = Readonly<Record<number, string>>;

const HOUSE_TYPE_LABELS: LabelTable = { 0: 'None', 1: 'Straw', 2: 'Wood', 3: 'Stone' };
// The house type is the only questline progress the tile shows. It is the
// header itself for Three Pigs ("Wood House" in place of the questline
// name), because the house is what the player picked and the game does not
// say it anywhere. No other questline shows progress: the step enums are the
// game's own, and a phase reduced from them could not say "failed" for any
// questline but Tree.

// Runtime resource paths, derived from the decoded tree by dropping the
// EntitySettings/ prefix and turning `!` into `\`. The map-folder names are
// irregular -- DarkHills unsuffixed against Storm_Island and Avalon -- and all
// three are confirmed live: an Avalon run observes DarkHills\Objects_DarkHills
// and Storm_Island\Objects_Storm_Island among its loaded resources.
//
// Both Storm Island questlines are three-level paths. Roc and Cyclops are
// siblings under Quest_Sinbad, not peers of it. Each path here is the runtime
// column of decoded_final.md verbatim; check a misbehaving marker against
// that file rather than against the shape of its neighbours.
//
// A RESIDENT PATH IS NOT A PLACED ENTITY, and Roc is where that bites.
// Measured on a live Roc run (2026-08-29), Roc_Quest_Manager's path is
// resident in six copies with six pointer triples, and NOTHING points at it
// from oCEntity+0x38. It is never
// placed. Keying Roc on the manager entity cannot work no matter how the path
// is spelled. What that run did place, one entity each:
//
//   Roc_Cave_Entrance_A_In, Roc_Cave_Entrance_A_Out,
//   Roc_Cave_Entrance_B_Out, Roc_Quest_FogOfWar_Eraser
//
// So Roc takes a list, and takes all four rather than the one that looks most
// canonical: B_In was NOT placed on that run, which is the evidence that no
// single entrance is guaranteed. Cyclops keeps its manager, which does get
// placed -- that asymmetry is exactly what let the Roc side look fine.
//
// Standing risk, from one run of evidence: if a CYCLOPS run also places any
// Roc_* entity, both sides of the pair hit and questFromPlacement goes
// inconclusive, which would break a Cyclops read that works today. Nothing
// observed says it does. A Cyclops run is the reading that would settle it.
//
// 3 Pigs has no manager entity -- it is the one questline whose state lives in
// GlobalValues_Common rather than a per-map quest folder -- so its houses are
// its markers, and a marker is a list rather than a string.
const QUEST_MARKERS: Readonly<Record<QuestKey, readonly string[]>> = {
  pigs: [
    'DarkHills\\Houses_3Pigs\\Straw_Pig_House.entity.ot',
    'DarkHills\\Houses_3Pigs\\Wood_Pig_House.entity.ot',
    'DarkHills\\Houses_3Pigs\\Stone_Pig_House.entity.ot',
  ],
  jack: ['DarkHills\\Jack\\Jack_Quest_Manager.entity.ot'],
  roc: [
    'Storm_Island\\Quest_Sinbad\\Quest_Roc\\Roc_Cave_Entrance_A_In.entity.ot',
    'Storm_Island\\Quest_Sinbad\\Quest_Roc\\Roc_Cave_Entrance_A_Out.entity.ot',
    'Storm_Island\\Quest_Sinbad\\Quest_Roc\\Roc_Cave_Entrance_B_In.entity.ot',
    'Storm_Island\\Quest_Sinbad\\Quest_Roc\\Roc_Cave_Entrance_B_Out.entity.ot',
    'Storm_Island\\Quest_Sinbad\\Quest_Roc\\Roc_Quest_FogOfWar_Eraser.entity.ot',
  ],
  cyclop: ['Storm_Island\\Quest_Sinbad\\Quest_Cyclop\\Sinbad_Cyclop_Quest_Main_Manager.entity.ot'],
  // Mordred_Quest_Manager never places -- confirmed live on a run with
  // Mordred_Quest_Current_Step ticked to 2 (CrossingUnderground),
  // placedAmong() found it absent while seven other Avalon\Mordred\* paths
  // placed with one entity each. Same failure shape as Roc's manager
  // (placement.js), and just as permanent: no known Mordred entity has been
  // observed to persist the way a manager would.
  //
  // BEST-EFFORT FAST PATH ONLY. The real answer for Mordred comes from
  // ELIMINATION_BY_MAP: Tree_Quest_Main_Manager is the confirmed, persistent
  // marker, and Mordred is inferred from its sustained absence rather than
  // from anything placed on this side. This list exists so a lucky sweep can
  // still resolve instantly instead of waiting out
  // PLACEMENT_ELIMINATION_SWEEPS -- it is not load-bearing.
  // Residency here is inconsistent, not simply quest-step-gated: one live run
  // found all seven despawned by Mordred_Quest_Current_Step 6 (Finished);
  // another found all seven still placed at that same step. Most likely
  // explanation is spatial streaming (props unload when the hero is far from
  // them) rather than the quest step itself, but that is unconfirmed. Do not
  // add a manager-class Mordred entity here on the strength of a guess;
  // confirm it persists regardless of hero position first, or it will
  // regress to the same trap.
  mordred: [
    'Avalon\\Mordred\\Mordred_Quest_Destructible_Door.entity.ot',
    'Avalon\\Mordred\\Mordred_Portcullis.entity.ot',
    'Avalon\\Mordred\\Mordred_Arena_Teleporter_In.entity.ot',
    'Avalon\\Mordred\\Mordred_Arena_Teleporter_Out.entity.ot',
    'Avalon\\Mordred\\Mordred_Undergound_Teleporter_In.entity.ot',
    'Avalon\\Mordred\\Mordred_Undergound_Teleporter_Out.entity.ot',
    'Avalon\\Mordred\\Mordred_Undergound_Entrance_Minimap_Marker.entity.ot',
  ],
  tree: ['Avalon\\Objects_Tree_Quest\\Tree_Quest_Main_Manager.entity.ot'],
};

const MARKER_PATHS: readonly string[] = [...new Set(Object.values(QUEST_MARKERS).flat())];

const QUEST_PAIR_BY_MAP: Readonly<Record<string, readonly [QuestKey, QuestKey]>> = {
  'Dark Hills': ['pigs', 'jack'],
  'Storm Island': ['roc', 'cyclop'],
  Avalon: ['mordred', 'tree'],
};

/**
 * Maps where one side of the pair has a manager-class entity confirmed to
 * place and persist for the run (map_verification_log.md, Tree_Quest_Main_Manager
 * observed placed at hero level 9), while the other side has no marker known
 * to place at all (Mordred_Quest_Manager: confirmed absent, same failure as
 * Roc's manager -- see placement.js). For these maps the confirmed side's
 * placement is trusted as a hard binary switch, the same way Roc vs Cyclop is
 * decided by two markers that both place -- Avalon just only has one that
 * reliably does. Absence of the confirmed side, once the scan has actually
 * converged, names the other side by elimination rather than waiting on a
 * marker that has never been observed to place.
 */
const ELIMINATION_BY_MAP: Readonly<Record<string, { confirmed: QuestKey; inferred: QuestKey }>> = {
  Avalon: { confirmed: 'tree', inferred: 'mordred' },
};

// Mirrors MELODY_FAIL_SWEEPS in sweeper.js: one empty sweep is normal while
// placement is still lagging the map-id change (measured 24-38s on a Storm
// Island -> Avalon transition, map_verification_log.md). Three consecutive
// sweeps where the confirmed marker was searched for and not found is what
// turns "hasn't been seen yet" into "isn't going to be seen this generation".
export const PLACEMENT_ELIMINATION_SWEEPS = 3;

/**
 * The other side of an ELIMINATION_BY_MAP pair, once the confirmed side has
 * been searched for and missed PLACEMENT_ELIMINATION_SWEEPS sweeps running.
 * `misses` must only count sweeps where placedAmong actually returned a
 * result (a real search that came back without the confirmed marker) -- a
 * scan that failed to run at all (entity RTTI unresolved) is not evidence and
 * must not advance this counter. See sweeper.js for where misses is tracked.
 */
export function eliminatedQuest(mapName: string | null, misses: number): QuestKey | null {
  if (mapName === null) return null;
  const rule = ELIMINATION_BY_MAP[mapName];
  if (!rule) return null;
  return misses >= PLACEMENT_ELIMINATION_SWEEPS ? rule.inferred : null;
}

const CURRENT_MAP_ID = 'Current map id';
const MAP_ID_SUFFIX = ' map id';
const HERO_LEVEL = 'Hero Level';
const GAME_SESSION_SIZE = 'Game Session Size';
const DREAM_SHARDS = 'Current dream shards count';
// Spelled the way the game spells it, lower case and spaced, unlike its
// Is_Sandman_* neighbours. Exported so reader.js relays the same string the
// sweep resolves -- a second copy of this literal is how the relay came to be
// wired to a key that was never populated.
const SANDMAN_SHOP_GATE = 'Is in sandman shop';

const TRACKED_NAMES: readonly string[] = [
  HERO_LEVEL, 'Is In Combat', CURRENT_MAP_ID, DREAM_SHARDS,
  'Current_House_Type', 'Current_House_State', 'Pig_House_Resources_To_Collect_Count',
  GAME_SESSION_SIZE,
  // Tracked but never displayed. The Sandman worker needs this gate's binding
  // address to tell "the shop is open but the grid will not read" apart from
  // "the shop is shut", and the only channel it has for one is the sweep's
  // `found` map -- which carries the tracked names and nothing else. The
  // worker never builds a value index of its own.
  SANDMAN_SHOP_GATE,
  // Tracked for the run-end worker, which polls them off the bindings the
  // sweep resolves and Reader relays. Never displayed live.
  DEFEAT_FLAG, VICTORY_FLAG, GAME_DIFFICULTY, CURRENT_CHAPTER,
];

/** [display name, icon, map] */
const QUESTLINES: Readonly<Record<QuestKey, readonly [string, string, string]>> = {
  pigs: ['Three Pigs', 'icon_house_run.png', 'Dark Hills'],
  jack: ['Jack', 'icon_jack.png', 'Dark Hills'],
  mordred: ['Mordred', 'map_boss_den.png', 'Avalon'],
  tree: ['Tree / Morgan', 'icon_morgana.png', 'Avalon'],
  roc: ['Roc', 'map_final_boss.png', 'Storm Island'],
  cyclop: ["Sinbad's Cyclop", 'icon_sindbad.png', 'Storm Island'],
};

const MAP_CHAPTER: Readonly<Record<string, readonly [number, string]>> = {
  'Dark Hills': [1, 'chapter1.png'],
  'Storm Island': [2, 'chapter2.png'],
  Avalon: [3, 'chapter3.png'],
};
const ROMAN: Readonly<Record<number, string>> = { 1: 'I', 2: 'II', 3: 'III' };

const HOUSE_ICON: LabelTable = { 0: 'icon_house_run.png', 1: 'house_straw.png', 2: 'house_wood.png', 3: 'house_stone.png' };

// ------------------------------------------------------------------ shapes --

/** Whether the melody channel has answered, or has given up. */
export type MelodyStatus = 'pending' | 'ok' | 'failed';

/** One cell in the placed-tiles panel. */
export interface TileIconView {
  /** Asset filename of the game's own minimap icon for this thing. */
  readonly icon: string;
  /**
   * The tier ring drawn behind the icon, or null for a thing that has no
   * tiers. An alpha silhouette the page tints; see TILE_TIER_COLOUR.
   */
  readonly outline: string | null;
  /** 1, 2 or 3, or null where the thing is not tiered. */
  readonly tier: number | null;
  /** How many the generator placed. Drawn only above one. */
  readonly count: number;
  /** What it is, for a hover title. Never painted as visible text. */
  readonly label: string;
  /** Expected optional boss, when the placed tile identifies a known variant. */
  readonly boss?: string;
}

/**
 * The things worth walking to, and the icon the game's own minimap gives each.
 *
 * This table is the filter as much as it is the artwork. The roster is the
 * whole generated map -- 148 entries on a measured Dark Hills run, most of it
 * scenery: blockers, ruins, ambient crystal props, wandering camp markers.
 * Listing all of it was noise. Anything without an entry here is not drawn, so
 * adding a concept and giving it an icon are the same edit and neither can be
 * forgotten.
 *
 * Deliberately absent, because they are everywhere and nobody detours for
 * them: teleporters, healing shrines, sacrificial idols and loose crystals.
 * Questline pieces and boss dens are out too -- the questline has its own cell
 * in the band, and the boss is not optional.
 *
 * Matched against the raw engine name, case-insensitively, first hit wins --
 * so order matters wherever one pattern would also match another's name, and
 * the more specific one goes first.
 *
 * The label is the game's own minimap marker text, from the `MinimapMarker_*`
 * rows of the Common text table, so the tooltip says what the in-game map
 * says. Three entries have no marker row (the greater chest, the Sandman,
 * Stingy Jack) and keep a plain name. A stash entrance whose room type the
 * roster gives away carries that room's marker in brackets.
 */
const TILE_ICONS: readonly (readonly [RegExp, string, string])[] = [
  // -- rewards ------------------------------------------------------------
  [/Baba_?Yaga_?Eye/i, 'map_baba_yaga_eye.png', 'Vision Tower'],
  [/Astrolab/i, 'map_astrolab.png', 'Astral Shrine'],
  [/Locked_?Chest|Chest_?Locked/i, 'map_chest_locked.png', 'Locked Chest'],
  [/Super_?Chest|Chest_?Super/i, 'map_chest_super.png', 'Greater Chest'],
  // Every ordinary chest is one picture. T1/T2/T3 is the tier ring, not a
  // different chest -- which is exactly what the ring is for.
  [/Chest/i, 'map_chest.png', 'Chest'],
  [/DreamCrystal|CrystalField/i, 'map_crystal.png', 'Large Dream Crystal'],
  // -- points of interest --------------------------------------------------
  // The optional den you open with the red key -- a detour with a reward, and
  // the thing the loose key on the map is for. Matched on Shrine/Den and NOT
  // on "Boss", because the chapter boss is also named with that word
  // (`64x64_Dark_Hills_Map_Boss_Update3`) and is not optional, so it stays
  // out. The art is the locked variant: whether this particular den has been
  // opened yet is not something the roster says.
  // The occupant may sit between Boss and Den: the live Ghoul entrance is
  // 40x40_Boss_Ghoul_Den_Entrance (2026-10-12), with its underground room
  // counted separately in the raw roster and excluded by groupTiles.
  //
  // `map_boss_den_locked.png`, NOT `map_boss_den.png` -- that name was
  // already taken by the Mordred questline's KPI icon in QUESTLINES below,
  // and writing this art over it silently changed that cell.
  [/Boss_?Shrine|Boss_?Den|Boss_(?:[A-Za-z0-9]+_)+Den_Entrance(?:_|$)/i, 'map_boss_den_locked.png', 'Optional Boss'],
  [/Altar_?Of_?Heroes/i, 'map_altar.png', 'Altar of Heroes'],
  [/Cauldron/i, 'map_cauldron.png', 'Leprechaun\'s Cauldron'],
  [/Grimoire/i, 'map_grimoire.png', 'Grimoire'],
  // The entrance tile exposes the room type before the player enters.
  // The game keeps a generic minimap entrance, but this panel surfaces the
  // type with existing game art: mirror, harp, HUD combat swords and the
  // score page's cursed-room emblem. Unknown types keep the generic stash.
  [/Thieves_?Stashes?_Entrance_Mirror_?Room/i, 'map_mirror.png', 'Thieves\' Stash (Magic Mirror)'],
  [/Thieves_?Stashes?_Entrance_Gold_?Room/i, 'map_harp.png', 'Thieves\' Stash (Dagda\'s Harp)'],
  [/Thieves_?Stashes?_Entrance_Combat_?Room/i, 'icon_in_combat.png', 'Thieves\' Stash (Combat)'],
  [/Thieves_?Stashes?_Entrance_Cursed_?Room/i, 'score_cursed_room.png', 'Thieves\' Stash (Cursed)'],
  [/Thieves_?Stash/i, 'map_thieves_stash.png', 'Thieves\' Stash'],
  [/Wishing_?Well/i, 'map_wishing_well.png', 'Wishing Well'],
  [/Refugee/i, 'map_refugees.png', 'Refugees\' Camp'],
  [/Tumor/i, 'map_tumor.png', 'Nightmare Tumor'],
  [/Key_?Keeper/i, 'map_keykeeper.png', 'Blood Ritual'],
  [/Collectible_?Key/i, 'map_key.png', 'Nightmare Key'],
  [/Sandman/i, 'map_sandman.png', 'Sandman'],
  [/Bloody_?Mary|Mirror/i, 'map_mirror.png', 'Magic Mirror'],
  [/Harp/i, 'map_harp.png', 'Dagda\'s Harp'],
  [/Stingy_?Jack/i, 'map_stingy_jack.png', 'Stingy Jack'],
  [/Corpse/i, 'map_corpse.png', 'Corpse'],
];

// Individual names checked against Enemy_Common~GAM.xls.LocalText.gen.LangEN
// on 2026-10-12. The witch trio's collective name is The Coven
// (https://ravenswatch.fandom.com/wiki/Bosses).
// An unknown variant keeps the generic den hover rather than inventing a name.
const OPTIONAL_BOSS_NAMES: readonly (readonly [RegExp, string])[] = [
  [/White_?Lady/i, 'Brigit, the White Lady'],
  [/Ghoul/i, 'Mother Ghoul, Underground Terror'],
  [/Jinn/i, 'Abu Al Jann, Father of all Jinns'],
  [/Crab/i, 'Karkinos, Scourge of the Reefs'],
  [/Witch/i, 'The Coven'],
  [/Wolf/i, 'Melion, the Cursed Knight'],
];

/**
 * Icons that ship a tier ring. The game draws the ring behind the icon and
 * colours it for the tier; only things that actually have tiers have one, so
 * this set is also the answer to "is this tiered at all".
 */
const TILE_OUTLINES: ReadonlySet<string> = new Set([
  'map_astrolab.png', 'map_baba_yaga_eye.png', 'map_grimoire.png',
  'map_cauldron.png', 'map_chest.png', 'map_chest_super.png',
  'map_chest_locked.png', 'map_crystal.png', 'map_wishing_well.png',
  'map_harp.png', 'map_mirror.png', 'map_thieves_stash.png',
]);

/**
 * Checked before TILE_ICONS, and nothing that matches is ever drawn.
 *
 * Enemy camps are named after what is in them, so a camp with a chest reads
 * `64x64_Chest_Graveyard_WhiteLadies_Camp` and matches the chest rule on the
 * word "Chest". It is a camp, not a chest -- its reward is already in the
 * roster separately, as the selector entry the generator rolled for it. Kept
 * as its own list rather than tightened into every pattern above, because the
 * rule is "a camp is not a landmark" and it belongs in one place.
 */
const TILE_NEVER: readonly RegExp[] = [
  /_Camp(_|$)/i,
];

/** The icon and label for a placed tile, or null if it is not worth drawing. */
export function tileIcon(name: string): readonly [string, string] | null {
  for (const pattern of TILE_NEVER) {
    if (pattern.test(name)) return null;
  }
  for (const [pattern, icon, label] of TILE_ICONS) {
    if (pattern.test(name)) return [icon, label];
  }
  return null;
}

/**
 * The roster reduced to the icon grid the panel draws.
 *
 * Collapsed by icon, tier and expected boss. By icon, because the panel shows
 * pictures: two roster entries that draw the same picture drawn twice in a row
 * read as a rendering bug rather than as two of the thing. And by tier,
 * because the ring is the difference between a tier 1 chest and a tier 3 one,
 * and merging those would throw away the only reason to walk to the far one.
 *
 * Sublevel tiles do not add to the panel's count (e.g. thieves stashes
 * underground room).
 *
 * Order is first-placed-first, which is the generator's own. The roster
 * carries no position to sort on, and that order is at least stable across
 * sweeps of the same map.
 */
export function groupTiles(tiles: readonly PlacedTile[] | null): TileIconView[] | null {
  if (!tiles) return null;
  const cells = new Map<string, TileIconView>();
  for (const tile of tiles) {
    if (tile.source === 'sublevel') continue;
    const hit = tileIcon(tile.name);
    if (hit === null) continue;
    const [icon, label] = hit;
    const boss = icon === 'map_boss_den_locked.png'
      ? OPTIONAL_BOSS_NAMES.find(([pattern]) => pattern.test(tile.name))?.[1]
      : undefined;
    const outline = TILE_OUTLINES.has(icon) ? icon.replace(/\.png$/, '_outline.png') : null;
    // A tier read off a thing with no ring to show it on would sort cells
    // apart for a difference the panel cannot draw.
    const tier = outline === null ? null : bucketTier(tile.tier);
    // Keep separately named POIs apart even when they share artwork, so the
    // hover label never promises a different kind of location.
    // Different bosses cannot share one cell whose hover promises only one.
    const key = `${icon}#${label}#${tier ?? ''}#${boss ?? ''}`;
    const seen = cells.get(key);
    if (seen) cells.set(key, { ...seen, count: seen.count + 1 });
    else cells.set(key, { icon, outline, tier, count: 1, label, ...(boss ? { boss } : {}) });
  }
  return [...cells.values()];
}

/** What a sweep leaves behind for the next readState. */
export interface Placement {
  mapId: number | null;
  placed: readonly string[];
}

/** The live Reader, structurally. reader.js is still JavaScript. */
export interface LiveSource {
  get(name: string): number | null;
  updateTransitions?(heroLevel: number | null, mapId: number | null): void;
  maps(): Record<number, string>;
  placement?(): Placement | null;
  melodies?(): MelodySlotView[] | null;
  melody_status?(): MelodyStatus;
  sandman?(): SandmanOffer[] | null;
  sandman_status?(): SandmanStatus;
  tiles?(): PlacedTile[] | null;
  /** The next finished run not yet emitted, removed as it is taken. */
  take_run_summary?(): RunSummary | null;
  found?(): number;
}

export interface ReadStateOptions {
  values?: Record<string, number | null> | null;
  maps?: Record<number, string> | null;
  placement?: Placement | null;
  melodies?: MelodySlotView[] | null;
  melody_status?: MelodyStatus;
  sandman?: SandmanOffer[] | null;
  sandman_status?: SandmanStatus;
  tiles?: PlacedTile[] | null;
  run_summary?: RunSummary | null;
  runtime?: {
    sweeps?: number;
    found?: number;
    pid?: number | null;
    base?: number | null;
    /** Directory of the game executable, from the module snapshot. */
    install_dir?: string | null;
    // Consecutive sweeps the current map generation's ELIMINATION_BY_MAP
    // confirmed marker was searched for and not found. See eliminatedQuest().
    placement_misses?: number;
  };
}

/** The frame the renderer receives. Plain JSON -- no Reading survives here. */
export interface ReadoutState {
  level: number | null;
  in_combat: number | null;
  map_id: number | null;
  map_name: string | null;
  no_run: boolean;
  coop: boolean;
  map_sub: string;
  chapter_icon: string;
  quest_key: QuestKey | null;
  quest_name: string;
  quest_icon: string;
  tracked: number;
  found: number;
  sweeps: number;
  pid: number | null;
  base: number | null;
  install_dir: string | null;
  process: string;
  binding_vtable: number;
  melodies: MelodySlotView[] | null;
  melody_status: MelodyStatus;
  /** Dream Shards on hand. A plain GlobalValue -- it does not need the shop. */
  dream_shards: number | null;
  sandman: SandmanOffer[] | null;
  sandman_status: SandmanStatus;
  /**
   * What the map generator placed, grouped for display. `null` until the
   * roster has been read once for the current map; an empty array is a map
   * that genuinely placed nothing the reader recognises, and the panel says
   * so rather than waiting forever.
   */
  tiles: TileIconView[] | null;
  /**
   * A finished run, on the one frame that carries it, and null on every
   * other. The main process appends it to the run history and drops a
   * repeated id.
   */
  run_summary: RunSummary | null;
  /**
   * Every channel the readout paints has answered. The renderer holds the page
   * behind this so the panels appear together instead of assembling
   * themselves piecewise on screen. Computed here and only here, for the same
   * reason no_run is: two copies of the rule would drift.
   */
  ready: boolean;
}

// --------------------------------------------------------------- functions --

/** The label for `value`, or '?' for one the table does not know. */
function label(labels: LabelTable, value: number): string {
  const v = labels[value];
  return v === undefined ? '?' : v;
}

/**
 * The questline a map's placed entities name, or null when the read is not
 * conclusive.
 *
 * Exactly one side of the pair present is an answer. Zero or both is not, and
 * that is the point: every other discriminator tried here was an absence test,
 * where "no signal" and "wrong answer" look identical. This one is positive on
 * both branches, so a marker path that is wrong or a sweep that missed can
 * only fail to answer -- never answer wrongly.
 */
export function questFromPlacement(
  mapName: string | null,
  placed: ReadonlySet<string> | null,
): QuestKey | null {
  const pair = mapName === null ? undefined : QUEST_PAIR_BY_MAP[mapName];
  if (!pair || !placed) return null;
  const hits = pair.filter(k => QUEST_MARKERS[k].some(p => placed.has(p)));
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

/**
 * Whether this sweep should run the placement scan.
 *
 * A map with no questline pair has no answer to find -- the camp is the live
 * case -- and scanning there is pure cost.
 *
 * Scanning runs on every sweep while the answer for the current map generation
 * is inconclusive (e.g. while the map generator places marker entities). Once
 * a conclusive answer is resolved for this generation, scanning stops
 * completely until the generation changes again (tracked via map id transitions).
 */
export function placementDue(mapName: string | null, conclusive = false): boolean {
  if (!mapName || QUEST_PAIR_BY_MAP[mapName] === undefined) return false;
  return !conclusive;
}

/**
 * The placement state a sweep leaves behind. A conclusive read replaces the
 * stored paths; anything else keeps what was there.
 *
 * Two failure modes ride on that. Both quest managers carry
 * oCEntityCpntDespawnSettings -- the Mordred one has an explicit Despawn
 * Tester -- so a manager that goes away when its quest completes would blank a
 * fresh read; latching keeps the answer. And a restart onto the same map has
 * the same map id but may carry the other questline; a later conclusive read
 * replaces the stale one, which is why this does not latch permanently.
 *
 * A map change clears, so the previous map's answer cannot leak. Map ids start
 * at 0, so the comparison is `!==`, never truthiness.
 */
export function nextPlacement(
  prev: Placement | null,
  mapId: number | null,
  mapName: string | null,
  placed: ReadonlyMap<string, unknown> | null,
): Placement {
  const carried = (prev !== null && prev.mapId === mapId) ? prev.placed : [];
  if (!placed) return { mapId, placed: carried };
  const paths = [...placed.keys()];
  if (questFromPlacement(mapName, new Set(paths)) === null) {
    return { mapId, placed: carried };
  }
  return { mapId, placed: paths };
}

/**
 * One poll of everything the readout shows.
 *
 * `values`/`maps` stand in for the process, so a fixture renders through
 * this logic rather than a parallel copy.
 */
export function readState(src: LiveSource | null, opts: ReadStateOptions = {}): ReadoutState {
  const { values = null, maps: mapsIn = null, runtime = {} } = opts;
  let get: (name: string) => Reading;
  let maps: Record<number, string>;
  let placement: Placement | null;
  let melodies: MelodySlotView[] | null;
  let melodyStatus: MelodyStatus;
  let sandman: SandmanOffer[] | null;
  let sandmanStatus: SandmanStatus;
  let tiles: PlacedTile[] | null;
  let runSummary: RunSummary | null;
  if (values === null) {
    // A null `values` means live mode, which needs a source to read.
    if (src === null) throw new Error('readState: no source and no fixture values');
    const live = src;
    const heroLevel = live.get(HERO_LEVEL);
    const currentMapId = live.get(CURRENT_MAP_ID);
    live.updateTransitions?.(heroLevel, currentMapId);
    get = (name) => reading(name === HERO_LEVEL ? heroLevel : name === CURRENT_MAP_ID ? currentMapId : live.get(name));
    maps = live.maps();
    placement = live.placement ? live.placement() : null;
    melodies = live.melodies ? live.melodies() : null;
    melodyStatus = live.melody_status ? live.melody_status() : 'pending';
    sandman = live.sandman ? live.sandman() : null;
    sandmanStatus = live.sandman_status ? live.sandman_status() : 'pending';
    tiles = live.tiles ? live.tiles() : null;
    runSummary = live.take_run_summary ? live.take_run_summary() : null;
  } else {
    // A name missing from `values` reads as unresolved, and serialises as null.
    get = (name) => reading(values[name]);
    maps = mapsIn || {};
    placement = opts.placement === undefined ? null : opts.placement;
    melodies = opts.melodies === undefined ? null : opts.melodies;
    melodyStatus = opts.melody_status === undefined ? 'pending' : opts.melody_status;
    sandman = opts.sandman === undefined ? null : opts.sandman;
    sandmanStatus = opts.sandman_status === undefined ? 'pending' : opts.sandman_status;
    tiles = opts.tiles === undefined ? null : opts.tiles;
    runSummary = opts.run_summary === undefined ? null : opts.run_summary;
  }

  const level = get('Hero Level');
  const inCombat = get('Is In Combat');
  const dreamShards = get(DREAM_SHARDS);
  const houseType = get('Current_House_Type');
  const mapId = get(CURRENT_MAP_ID);
  const sessionSize = get(GAME_SESSION_SIZE);
  const coop = sessionSize.ok && sessionSize.value >= 2;

  // Dark Hills is map id 0 -- the Reading wrapper is what keeps that honest.
  const mapName = mapId.ok ? (maps[mapId.value] ?? null) : null;

  // Placement names the questline from map load, on every map. A latched
  // answer is scoped to the map it was read on -- map ids start at 0, so this
  // compares values, never truthiness.
  // Compare inside the narrowed branch rather than via raw(). Unwrapping
  // first re-creates a `number | null` on both sides, and `null === null`
  // then reads an unresolved map id as "same map as the stored placement"
  // and applies its questline. sweeper.js only stores a non-null mapId, so
  // that is unreachable in production -- but it is reachable from a fixture,
  // and it is precisely the confusion Reading exists to remove.
  const placedQuest = (placement && mapId.ok && placement.mapId === mapId.value)
    ? questFromPlacement(mapName, new Set(placement.placed)) : null;

  // Before Current_House_Type reads, the placed house says which it is.
  // QUEST_MARKERS.pigs lists the houses in that value's order, Straw (1) to
  // Stone (3).
  let pigHouseType = houseType;
  if ((!pigHouseType.ok || pigHouseType.value === 0) && placedQuest === 'pigs' && placement) {
    const placed = placement.placed;
    const house = QUEST_MARKERS.pigs.findIndex(p => placed.includes(p));
    if (house !== -1) pigHouseType = { ok: true, value: house + 1 };
  }

  // Placement is the only source. Step counters are not one: they reset ~2 s
  // AFTER the map id moves (measured live), and placement needs up to one 5 s
  // sweep to answer, so through that window a counter names the PREVIOUS
  // map's questline.
  //
  // questFromPlacement is positive on both branches -- exactly one side of the
  // pair placed, or no answer -- so it can only ever fail to name a questline,
  // never name a wrong one. A `?` for one sweep is the trade.
  //
  // eliminatedQuest is the fallback, not the first check: a direct placement
  // hit is always preferred when one lands, and elimination only fires after
  // PLACEMENT_ELIMINATION_SWEEPS consecutive misses on the confirmed marker
  // (see ELIMINATION_BY_MAP) -- for maps with no elimination rule, or before
  // the miss count clears the threshold, it returns null and changes nothing.
  const active: QuestKey | null = placedQuest !== null
    ? placedQuest
    : eliminatedQuest(mapName, runtime.placement_misses ?? 0);
  const chapterEntry = mapName === null ? undefined : MAP_CHAPTER[mapName];
  const chapter = chapterEntry ? chapterEntry[0] : null;
  const chapterIcon = chapterEntry ? chapterEntry[1] : 'icon_question.png';
  let mapSub: string;
  if (chapter !== null && mapId.ok) mapSub = `Chapter ${ROMAN[chapter]} · map id ${mapId.value}`;
  else if (mapId.ok) mapSub = `map id ${mapId.value}`;
  else mapSub = 'unresolved';

  const found = runtime.found !== undefined ? runtime.found
    : (src && src.found ? src.found() : 0);

  // Three Pigs is headed by the house once one is known -- see the note
  // above HOUSE_TYPE_LABELS. Before that it is "Three Pigs" like any other
  // questline is its name.
  let questName = 'Undetermined';
  if (active === 'pigs' && ticked(pigHouseType)) {
    questName = `${label(HOUSE_TYPE_LABELS, pigHouseType.value)} House`;
  } else if (active) {
    questName = QUESTLINES[active][0];
  }

  let questIcon = 'icon_question.png';
  if (active) {
    if (active === 'pigs') {
      const houseIcon = ticked(pigHouseType) ? HOUSE_ICON[pigHouseType.value] : undefined;
      questIcon = houseIcon ?? QUESTLINES.pigs[1];
    } else {
      questIcon = QUESTLINES[active][1];
    }
  }

  // Map id alone. -1 is the game's own "no map loaded" reading, and it covers
  // the main menu, hero select and the moment a run ends. Mid-run loads never
  // produce -1 (measured 2026-08-29). Hero Level is no help here: a finished
  // run takes ~10.8 s to drop it to 0, and the main menu reads level 1 before
  // any hero exists, so gating on it would report the menu as a run.
  // An unresolved map id is deliberately NOT this: "we have not read it yet"
  // and "the game says there is no map" are different facts.
  const noRun = mapId.ok && mapId.value === -1;

  // A failed melody channel is allowed through: sweeper.js reports 'failed'
  // only after three consecutive empty sweeps, and holding the whole readout
  // hostage to one dead channel would show "Loading run" forever with nothing
  // saying why. The melody panel draws its own `?` in that case.
  //
  // Sandman is deliberately absent from this gate, and not for the melody
  // reason. A shop that has not been visited yet reads 'pending' -- which is
  // a correct steady state, not a channel still resolving -- and most runs
  // spend minutes there. Gating on it would hold the page behind a shop the
  // player has not walked to. The panel asks for that visit itself.
  const ready = !noRun
    && level.ok
    && inCombat.ok
    && mapName !== null
    && active !== null
    && (melodies !== null || melodyStatus === 'failed');

  return {
    level: raw(level),
    in_combat: raw(inCombat),
    map_id: raw(mapId),
    map_name: mapName,
    no_run: noRun,
    // Solo is 1, a two-player run is 2 (measured 2026-09-13). Unresolved reads
    // false: a half-loaded frame must never raise the consent dialog.
    coop,
    map_sub: mapSub,
    chapter_icon: chapterIcon,
    quest_key: active,
    quest_name: questName,
    quest_icon: questIcon,
    tracked: TRACKED_NAMES.length,
    found,
    sweeps: runtime.sweeps !== undefined ? runtime.sweeps : 0,
    pid: runtime.pid !== undefined ? runtime.pid : null,
    base: runtime.base !== undefined ? runtime.base : null,
    install_dir: runtime.install_dir !== undefined ? runtime.install_dir : null,
    process: TRACKED_NAMES_PROCESS,
    binding_vtable: BINDING_VTABLE_RVA,
    melodies: melodies !== undefined ? melodies : null,
    melody_status: melodyStatus,
    dream_shards: raw(dreamShards),
    sandman,
    sandman_status: sandmanStatus,
    // Deliberately not part of `ready`. Reading the roster costs ~830 ms on
    // map load (measured 2026-09-06: 95 ms for the pointer chain to the
    // spawner, 732 ms for the reward-selector scan). Gating the page on it
    // would black out the whole readout for most of a second on every map
    // change, to hold back a panel that can say "Loading…" for itself.
    tiles: groupTiles(tiles),
    run_summary: runSummary,
    ready,
  };
}

export {
  QUEST_MARKERS, MARKER_PATHS, QUEST_PAIR_BY_MAP, ELIMINATION_BY_MAP,
  TRACKED_NAMES, QUESTLINES,
  CURRENT_MAP_ID, MAP_ID_SUFFIX, HERO_LEVEL, GAME_SESSION_SIZE, SANDMAN_SHOP_GATE,
  SWEEP_INTERVAL, POLL_MS,
  TRACKED_NAMES_PROCESS as PROCESS_NAME,
};
