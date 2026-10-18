'use strict';
// The placed-tiles panel's view model, offline.
//
// tiles.ts is tested against fixture memory; this covers the layer above it:
// the roster turned into what the panel draws. That transform lives in
// state.ts rather than in app.js because app.js decides nothing about what a
// value means, and because a browser script loaded by <script> cannot be
// required from here -- logic put there is logic no suite can reach.
//
// The fixture is a real Dark Hills roster, read from a live run on
// 2026-09-06: 148 tiles, 138 category / 1 sublevel / 9 selector. Most of it
// is scenery, which is the point -- the panel draws 8 icons out of this.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readState, groupTiles, tileIcon, QUESTLINES } = require('../state');

// The reader takes the tier off a float in memory, not off the name -- see
// bucketTier. This fixture is a recorded name list, so the float has to be
// reconstructed, and the _T suffix is the one place it can honestly come
// from: the six items whose tier is written in their name are exactly the
// controls that pinned 0.15 / 0.5 / 1.0 to tiers 1 / 2 / 3 in the first
// place. Everything else records no tier, which is what the untiered scenery
// in this roster reads live.
const TIER_FLOAT = { 1: 0.15, 2: 0.5, 3: 1.0 };

function tile(name, source) {
  const m = /_T([123])(?:_|$)/i.exec(name);
  return {
    name, source, categoryIndex: null,
    width: 40, height: 40,
    tier: m ? TIER_FLOAT[Number(m[1])] : 0,
  };
}

/** [name, how many the generator placed] */
const LIVE_CATEGORY = [
  ['3x3_Blocker_01', 4], ['3x3_Blocker_Props_01', 4], ['3x3_Blocker_Props_02', 4],
  ['3x3_Cart_3Pigs_Material', 3], ['3x3_Cart_3Pigs_Material_02', 3],
  ['3x3_Crystal_01', 22], ['3x3_Crystal_02', 22],
  ['40x40_Boss_Shrine_White_Lady', 1],
  ['40x40_Cenotaph_Statues_Alley_WhiteLadies_Camp', 1],
  ['40x40_Coach_Attack_Neutral_Camp', 1],
  ['40x40_DarkHills_Thieves_Stashes_Entrance_Combat_Room_01', 1],
  ['40x40_Dark_Hills_Altar_Of_Heroes', 1],
  ['40x40_Dark_Hills_Cauldron_T1', 1],
  ['40x40_Dark_Hills_Grimoire_T1', 1], ['40x40_Dark_Hills_Grimoire_T2', 1],
  ['40x40_Dark_Hills_Start_Update3', 1],
  ['40x40_Old_Shipyard_CrystalField', 1],
  ['40x40_Straw_House', 1], ['40x40_Straw_Reserve_01', 1], ['40x40_Straw_Reserve_02', 1],
  ['40x40_Windmill_Farm_Undead_Hogs_Camp', 1],
  ['64x64_Chest_Graveyard_WhiteLadies_Camp', 1],
  ['64x64_Dark_Hills_Map_Boss_Update3', 1],
  ['64x64_Dark_Hills_Menhir_Cultist_Camp', 1],
  ['64x64_HighFishermanPlatform_Ghouls_Camp', 1],
  ['64x64_Windmill_Hill_Neutral_Camp', 1],
  ['6x6_3Pigs_Material_Crates', 3], ['6x6_Bleeding_01', 2],
  ['6x6_Blocker_01', 1], ['6x6_Blocker_02', 2], ['6x6_Blocker_03', 1], ['6x6_Blocker_04', 1],
  ['6x6_Cart_3Pigs_Material_01', 3], ['6x6_Cart_3Pigs_Material_02', 3],
  ['6x6_Collectible_Key', 1], ['6x6_Crystal_01', 6],
  ['6x6_Dark_Hills_Refugee_01', 3], ['6x6_Healing_01', 5], ['6x6_Ruin_01', 3],
  ['6x6_Teleporter_01', 17], ['Dark_Hills_Basic_Enemy_Camp_Wandering', 6],
];
const LIVE_SUBLEVEL = [['DarkHill_Thieves_Stashes_Combat_Room_Underground_01', 1]];
const LIVE_SELECTOR = [
  ['Baba_Yaga_Eye', 2], ['Dark_Hills_Astrolab_T2', 1],
  ['Dark_Hills_Basic_Chest_T1', 1], ['Dark_Hills_Basic_Chest_T2', 2],
  ['Dark_Hills_Basic_Chest_T3', 1], ['DreamCrystal_Big', 2],
];

function expand(pairs, source) {
  const out = [];
  for (const [name, n] of pairs) for (let i = 0; i < n; i++) out.push(tile(name, source));
  return out;
}

function darkHillsRoster() {
  return [
    ...expand(LIVE_CATEGORY, 'category'),
    ...expand(LIVE_SUBLEVEL, 'sublevel'),
    ...expand(LIVE_SELECTOR, 'selector'),
  ];
}

/** Every distinct name the live roster carried. */
function allLiveNames() {
  return [...LIVE_CATEGORY, ...LIVE_SUBLEVEL, ...LIVE_SELECTOR].map(p => p[0]);
}

function testRosterFixtureIsTheMeasuredOne() {
  const roster = darkHillsRoster();
  assert.strictEqual(roster.length, 148);
  assert.strictEqual(roster.filter(t => t.source === 'category').length, 138);
  assert.strictEqual(roster.filter(t => t.source === 'sublevel').length, 1);
  assert.strictEqual(roster.filter(t => t.source === 'selector').length, 9);
}

// Scenery has no entry in the table, so it is simply not drawn. This is the
// bulk of a real roster -- 148 tiles in, a handful of icons out.
function testFiltersScenery() {
  for (const name of ['3x3_Blocker_01', '3x3_Blocker_Props_01', '6x6_Blocker_02',
                      '6x6_Ruin_01', '40x40_Dark_Hills_Start_Update3',
                      'Dark_Hills_Basic_Enemy_Camp_Wandering',
                      '40x40_Windmill_Farm_Undead_Hogs_Camp',
                      '64x64_Windmill_Hill_Neutral_Camp']) {
    assert.strictEqual(tileIcon(name), null, `should not be drawn: ${name}`);
  }
  // A camp is named after what is in it, so this one matches the chest rule
  // on the word "Chest". It is a camp. Its reward is in the roster already,
  // as the selector entry the generator rolled for it -- drawing the camp as
  // a chest would both mislabel it and double-count the reward.
  assert.strictEqual(tileIcon('64x64_Chest_Graveyard_WhiteLadies_Camp'), null);
}

// Named one at a time because each is a decision rather than a pattern: they
// are everywhere on every map and nobody detours for them.
function testExcludedByDecision() {
  const excluded = [
    // everywhere, and not a destination
    '6x6_Teleporter_01', '6x6_Healing_01', '6x6_Bleeding_01',
    '3x3_Crystal_01', '3x3_Crystal_02', '6x6_Crystal_01',
    // questline pieces -- the questline has its own cell in the band
    '40x40_Straw_House', '40x40_Straw_Reserve_01', '6x6_3Pigs_Material_Crates',
    '3x3_Cart_3Pigs_Material', '6x6_Cart_3Pigs_Material_01',
    '40x40_JackQuest_BeanstalkGrowsPlace',
    // the chapter boss is not optional, so it is not a detour worth marking
    '64x64_Dark_Hills_Map_Boss_Update3',
  ];
  for (const name of excluded) {
    assert.strictEqual(tileIcon(name), null, `should not be drawn: ${name}`);
  }

  // The key-locked den IS optional, and it is what the loose key on the map
  // is for. It shares the word "Boss" with the chapter boss above, so the two
  // have to be told apart by more than that word.
  assert.strictEqual(tileIcon('64x64_Storm_Island_Map_Boss'), null);

  // Every map rolls its own optional boss, so the rule has to key on the
  // Boss_Shrine / Boss_Den token and never on who is inside. The Ghoul
  // entrance form, captured later, is covered by its regression below.
  for (const who of ['White_Lady', 'Sandman', 'Wendigo', 'Anything_At_All']) {
    assert.strictEqual(tileIcon(`40x40_Boss_Shrine_${who}`)[0], 'map_boss_den_locked.png',
      `boss shrine not matched for ${who}`);
  }
  assert.strictEqual(tileIcon('40x40_Dark_Hills_Boss_Den')[0], 'map_boss_den_locked.png');
  assert.strictEqual(tileIcon('40x40_Avalon_BossDen_02')[0], 'map_boss_den_locked.png');

  // The shard deposit is a destination; the crystal props scattered around
  // the map are not, and the two must not match the same rule.
  assert.ok(tileIcon('40x40_Old_Shipyard_CrystalField'));
}

// No icon this table names may be one another panel already owns.
//
// This is not hypothetical. `map_boss_den.png` was already the Mordred
// questline's KPI icon, and adding the boss den here under that same name
// overwrote the file -- which changed the questline cell and passed every
// check, because the assets test compares each file against a SOURCES.tsv row
// that had been rewritten alongside it. Sharing a name is only safe when both
// sides genuinely want the same picture, and that is a decision, not a
// default.
function testIconNamesAreNotAlreadyClaimed() {
  const claimed = new Set();
  for (const [, icon] of Object.values(QUESTLINES)) claimed.add(icon);
  for (const name of allLiveNames().concat(['40x40_Boss_Shrine_White_Lady'])) {
    const hit = tileIcon(name);
    if (!hit) continue;
    assert.ok(!claimed.has(hit[0]),
      `${hit[0]} is already the questline icon for another panel`);
  }
  // The specific name this went wrong on, asserted directly so the reason
  // survives even if the roster fixture above changes.
  assert.notStrictEqual(tileIcon('40x40_Boss_Shrine_White_Lady')[0], 'map_boss_den.png');
}

// Captured 2026-10-12: the surface Ghoul entrance was dropped, while its
// underground room matched but was correctly excluded from the map count.
function testNamedBossDenEntranceIsCountedOnce() {
  const cells = groupTiles([
    tile('40x40_Boss_Ghoul_Den_Entrance', 'category'),
    tile('Ghoul_Underground_Boss_Den', 'sublevel'),
    tile('40x40_Dark_Hills_Key_Keeper', 'category'),
    tile('64x64_Dark_Hills_Map_Boss_Update3', 'category'),
  ]);
  assert.deepStrictEqual(cells.map(c => [c.label, c.icon, c.count, c.boss ?? null]), [
    ['Optional Boss', 'map_boss_den_locked.png', 1, 'Mother Ghoul, Underground Terror'],
    ['Blood Ritual', 'map_keykeeper.png', 1, null],
  ]);
}

function testBossVariantsKeepTheirExpectedNames() {
  const cells = groupTiles([
    tile('40x40_Boss_Ghoul_Den_Entrance', 'category'),
    tile('40x40_Boss_Shrine_White_Lady', 'category'),
  ]);
  assert.deepStrictEqual(cells.map(c => [c.boss, c.count]), [
    ['Mother Ghoul, Underground Terror', 1],
    ['Brigit, the White Lady', 1],
  ]);
  // A boss variant without a confirmed name still gets its icon, without
  // inventing a boss name or attaching one from a different definition.
  assert.strictEqual(groupTiles([tile('40x40_Boss_Shrine_Anything_At_All', 'category')])[0].boss, undefined);
}

// Surface paths from the live Dark Hills rosters and the Storm Island/Avalon
// tile definitions in the installed game. Underground rooms must not add a
// second cell for the same optional den.
function testOptionalBossPairsAcrossChapters() {
  const pairs = [
    ['40x40_Boss_Shrine_White_Lady', null, 'Brigit, the White Lady'],
    ['40x40_Boss_Ghoul_Den_Entrance', 'Ghoul_Underground_Boss_Den', 'Mother Ghoul, Underground Terror'],
    ['40x40_Jinn_Boss_Shrine_Arena', null, 'Abu Al Jann, Father of all Jinns'],
    ['40x40_Crab_Mini_Boss_Den_Entrance', 'Underground_Crab_Mini_Boss_Den', 'Karkinos, Scourge of the Reefs'],
    ['40x40_Witch_Boss_Shrine', null, 'The Coven'],
    ['40x40_Avalon_Wolf_Boss_Den_Entrance', 'Underground_Wolf_Boss_Den', 'Melion, the Cursed Knight'],
  ];
  for (const [surface, underground, boss] of pairs) {
    const roster = [tile(surface, 'category')];
    if (underground) roster.push(tile(underground, 'sublevel'));
    const cells = groupTiles(roster);
    assert.strictEqual(cells.length, 1, surface);
    assert.strictEqual(cells[0].icon, 'map_boss_den_locked.png', surface);
    assert.strictEqual(cells[0].boss, boss, surface);
    assert.strictEqual(cells[0].count, 1, surface);
  }
}

function testIconsForKeptThings() {
  const want = {
    '40x40_Dark_Hills_Altar_Of_Heroes': 'map_altar.png',
    '40x40_Dark_Hills_Cauldron_T1': 'map_cauldron.png',
    '40x40_Dark_Hills_Grimoire_T2': 'map_grimoire.png',
    '40x40_DarkHills_Thieves_Stashes_Entrance_Combat_Room_01': 'icon_in_combat.png',
    '40x40_Old_Shipyard_CrystalField': 'map_crystal.png',
    '6x6_Dark_Hills_Refugee_01': 'map_refugees.png',
    '6x6_Collectible_Key': 'map_key.png',
    'Baba_Yaga_Eye': 'map_baba_yaga_eye.png',
    'Dark_Hills_Astrolab_T2': 'map_astrolab.png',
    'Dark_Hills_Basic_Chest_T1': 'map_chest.png',
    'DreamCrystal_Big': 'map_crystal.png',
    'DarkHill_Thieves_Stashes_Combat_Room_Underground_01': 'map_thieves_stash.png',
  };
  for (const [name, icon] of Object.entries(want)) {
    const hit = tileIcon(name);
    assert.ok(hit, `no icon for ${name}`);
    assert.strictEqual(hit[0], icon, name);
  }
  // Every ordinary chest is the same picture at three tiers -- the ring says
  // which. Mapping T3 to the greater-chest art would be inventing a second
  // kind of chest out of a tier suffix.
  assert.strictEqual(tileIcon('Dark_Hills_Basic_Chest_T3')[0], 'map_chest.png');
  assert.strictEqual(tileIcon('Dark_Hills_Super_Chest')[0], 'map_chest_super.png');
}


// A tier only means something where the game ships a ring to draw it on.
// Reading one off an untiered thing would split cells apart over a difference
// the panel has no way to show.
function testOnlyRingedThingsCarryTier() {
  for (const cell of groupTiles(darkHillsRoster())) {
    if (cell.outline === null) {
      assert.strictEqual(cell.tier, null, `untiered thing carries a tier: ${cell.icon}`);
    } else {
      assert.strictEqual(cell.outline, cell.icon.replace(/\.png$/, '_outline.png'));
    }
  }
  const cells = groupTiles(darkHillsRoster());
  assert.strictEqual(cells.find(c => c.icon === 'map_altar.png').outline, null);
  assert.strictEqual(cells.find(c => c.icon === 'map_refugees.png').tier, null);
}

// Tiers separate cells: a tier 1 chest and a tier 3 chest are the reason to
// walk to one and not the other, and merging them throws that away.
function testTiersDoNotMerge() {
  const chests = groupTiles(darkHillsRoster()).filter(c => c.icon === 'map_chest.png');
  const byTier = Object.fromEntries(chests.map(c => [c.tier, c.count]));
  assert.deepStrictEqual(byTier, { 1: 1, 2: 2, 3: 1 });

  const books = groupTiles(darkHillsRoster()).filter(c => c.icon === 'map_grimoire.png');
  assert.deepStrictEqual(books.map(c => c.tier).sort(), [1, 2]);
}

// Every ring must have a resource mapping for the runtime asset decoder.
function testEveryOutlineExists() {
  const dir = path.join(__dirname, '..', '..', 'web', 'assets');
  const assets = new Set(require('../../assets/build').readManifest(path.join(dir, 'SOURCES.tsv')).map(row => row.asset));
  for (const cell of groupTiles(darkHillsRoster())) {
    if (!cell.outline) continue;
    assert.ok(assets.has(cell.outline), `missing ring mapping: ${cell.outline}`);
  }
}

// Every icon the table names must have a runtime resource mapping. A typo draws a
// blank square and says nothing about why.
function testEveryIconExists() {
  const dir = path.join(__dirname, '..', '..', 'web', 'assets');
  const assets = new Set(require('../../assets/build').readManifest(path.join(dir, 'SOURCES.tsv')).map(row => row.asset));
  const icons = new Set();
  for (const name of allLiveNames()) {
    const hit = tileIcon(name);
    if (hit) icons.add(hit[0]);
  }
  assert.ok(icons.size >= 8, `sample exercised only ${icons.size} icons`);
  for (const icon of icons) {
    assert.ok(assets.has(icon), `missing asset mapping: ${icon}`);
  }
}

function testCollapsesByIcon() {
  const cells = groupTiles(darkHillsRoster());

  // Two grimoire tiers are two roster entries and one picture. Drawing that
  // picture twice reads as a rendering bug rather than as two grimoires.
  // The two grimoires are two tiers, so they stay two cells -- see
  // testTiersDoNotMerge. Both draw the same picture.
  assert.strictEqual(cells.filter(c => c.icon === 'map_grimoire.png').length, 2);

  // Chest T1 and two T2s share one icon; T3 has its own, so it stays separate.
  // The shard deposit and the two big dream crystals are all one picture,
  // and none of them carries a tier suffix, so they are one cell.
  assert.strictEqual(cells.find(c => c.icon === 'map_crystal.png').count, 3);

  assert.strictEqual(cells.find(c => c.icon === 'map_baba_yaga_eye.png').count, 2);
  assert.strictEqual(cells.find(c => c.icon === 'map_refugees.png').count, 3);

  // One cell per icon+label+tier, never two.
  const keys = cells.map(c => c.icon + '#' + c.label + '#' + c.tier);
  assert.strictEqual(new Set(keys).size, cells.length);
}

// The panel distinguishes all four stash rooms using existing game art.
// Underground rooms must not add a second copy of their entrance.
function testStashRoomsStayApart() {
  const cells = groupTiles([
    tile('40x40_DarkHills_Thieves_Stashes_Entrance_Combat_Room_01', 'category'),
    tile('40x40_DarkHills_Thieves_Stashes_Entrance_Cursed_Room_01', 'category'),
    tile('40x40_DarkHills_Thieves_Stashes_Entrance_Gold_Room_01', 'category'),
    tile('40x40_DarkHills_Thieves_Stashes_Entrance_Mirror_Room_01', 'category'),
    tile('DarkHill_Thieves_Stashes_Combat_Room_Underground_01', 'sublevel'),
    tile('DarkHill_Thieves_Stashes_Cursed_Room_Underground_01', 'sublevel'),
  ]);
  assert.deepStrictEqual(cells.map(c => [c.icon, c.label, c.count]), [
    ['icon_in_combat.png', "Thieves' Stash (Combat)", 1],
    ['score_cursed_room.png', "Thieves' Stash (Cursed)", 1],
    ['map_harp.png', "Thieves' Stash (Dagda's Harp)", 1],
    ['map_mirror.png', "Thieves' Stash (Magic Mirror)", 1],
  ]);
  assert.ok(cells.slice(0, 2).every(c => c.outline === null && c.tier === null), 'swords and cursed emblem are untiered art');
  assert.strictEqual(tileIcon('40x40_Thieves_Stashes_Entrance_Unknown_Room_01')[0], 'map_thieves_stash.png', 'unknown rooms retain the generic stash');
}

// 148 tiles in. The whole complaint this replaced was that all of them were
// on screen; the panel is only useful if the answer is small.
function testTheGridIsSmall() {
  const cells = groupTiles(darkHillsRoster());
  assert.ok(cells.length > 0 && cells.length <= 20,
    `grid should be a handful of icons, got ${cells.length}`);
  // And it has to be a real reduction, not a light trim.
  assert.ok(cells.length < darkHillsRoster().length / 8,
    `${cells.length} cells out of ${darkHillsRoster().length} tiles is not a filter`);
}

function testEveryCellIsLabelled() {
  for (const cell of groupTiles(darkHillsRoster())) {
    assert.ok(cell.label, `cell has no label: ${cell.icon}`);
    // The label is a hover title, never painted -- but it still must not be a
    // raw engine identifier.
    assert.ok(!/_/.test(cell.label) && !/^\d+x\d+/.test(cell.label),
      `raw identifier reached the label: ${cell.label}`);
  }
}

// The distinction the panel's waiting state depends on. Both are
// falsy-looking and they mean opposite things: null is "not read yet, say
// Loading", [] is "read, and nothing on this map is worth marking".
function testNullIsNotEmpty() {
  assert.strictEqual(groupTiles(null), null);
  assert.deepStrictEqual(groupTiles([]), []);
  assert.deepStrictEqual(groupTiles([tile('3x3_Blocker_01', 'category')]), []);
}

function testFrameCarriesTiles() {
  const withTiles = readState(null, { values: {}, tiles: darkHillsRoster() });
  assert.ok(Array.isArray(withTiles.tiles));
  assert.ok(withTiles.tiles.length > 0);

  assert.strictEqual(readState(null, { values: {} }).tiles, null);
  assert.strictEqual(readState(null, { values: {}, tiles: null }).tiles, null);
  assert.deepStrictEqual(readState(null, { values: {}, tiles: [] }).tiles, []);
}

// The roster is not a readiness channel: it costs ~830 ms on map load and
// gating the page on it would black out every map change.
function testTilesDoNotGateReady() {
  const values = {};
  const a = readState(null, { values, tiles: null });
  const b = readState(null, { values, tiles: darkHillsRoster() });
  assert.strictEqual(a.ready, b.ready);
}

function main() {
  testRosterFixtureIsTheMeasuredOne();
  testFiltersScenery();
  testExcludedByDecision();
  testIconsForKeptThings();
  testIconNamesAreNotAlreadyClaimed();
  testNamedBossDenEntranceIsCountedOnce();
  testBossVariantsKeepTheirExpectedNames();
  testOptionalBossPairsAcrossChapters();
  testOnlyRingedThingsCarryTier();
  testTiersDoNotMerge();
  testEveryOutlineExists();
  testEveryIconExists();
  testCollapsesByIcon();
  testStashRoomsStayApart();
  testTheGridIsSmall();
  testEveryCellIsLabelled();
  testNullIsNotEmpty();
  testFrameCarriesTiles();
  testTilesDoNotGateReady();
  console.log('test-tiles-view: ok');
}

module.exports = { main };
if (require.main === module) main();
