'use strict';
// The conclusiveness rule and the latch rule. Pure logic over plain data --
// no process, no memory, no fixtures beyond path strings.

const {
  QUEST_MARKERS, MARKER_PATHS, QUEST_PAIR_BY_MAP,
  ELIMINATION_BY_MAP, PLACEMENT_ELIMINATION_SWEEPS, eliminatedQuest,
  questFromPlacement, nextPlacement, placementDue, readState,
} = require('../state');
const { mergeMapNames, heroRescanDue, fallbackHeroSource,
  HERO_RESCAN_SWEEPS, nextMelodies, nextMelodyStatus, MELODY_FAIL_SWEEPS,
  nextPlacementMisses } = require('../sweeper');

const DEMO_MAPS = { 0: 'Dark Hills', 1: 'Storm Island', 2: 'Avalon' };
const ZERO = {
  Mordred_Quest_Current_Step: 0, Tree_Quest_Current_Step: 0,
  Roc_Quest_Current_Step: 0, Cyclop_Quest_Cave_Current_Step: 0,
  Jack_Quest_Current_Step: 0, Current_House_Type: 0,
  Current_House_State: 0, Pig_House_Resources_To_Collect_Count: 0,
};
function state(values, placement, opts = {}) {
  return readState(null, { values, maps: DEMO_MAPS, placement, ...opts });
}

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

const TREE = 'Avalon\\Objects_Tree_Quest\\Tree_Quest_Main_Manager.entity.ot';
// The confirmed-placing candidate, not Mordred_Quest_Manager -- that path
// never places (see state.ts QUEST_MARKERS.mordred) and isn't in the table.
const MORDRED = 'Avalon\\Mordred\\Mordred_Quest_Destructible_Door.entity.ot';
const JACK = 'DarkHills\\Jack\\Jack_Quest_Manager.entity.ot';
const WOOD_HOUSE = 'DarkHills\\Houses_3Pigs\\Wood_Pig_House.entity.ot';

function main() {
  console.log('\ntest-questline: placement conclusiveness and latching');

  check('every quest key in a map pair has markers',
    Object.values(QUEST_PAIR_BY_MAP).flat().every(k => (QUEST_MARKERS[k] || []).length > 0));
  check('MARKER_PATHS is the de-duplicated flat marker list',
    MARKER_PATHS.length === new Set(Object.values(QUEST_MARKERS).flat()).size);
  check('the marker table names the two Avalon paths verified live',
    QUEST_MARKERS.tree.includes(TREE) && QUEST_MARKERS.mordred.includes(MORDRED));

  // --- conclusiveness
  check('exactly one side placed is an answer',
    questFromPlacement('Avalon', new Set([TREE])) === 'tree');
  check('the other side, likewise',
    questFromPlacement('Avalon', new Set([MORDRED])) === 'mordred');
  check('neither side placed is not an answer',
    questFromPlacement('Avalon', new Set()) === null);
  check('both sides placed is not an answer either -- that is a broken read',
    questFromPlacement('Avalon', new Set([TREE, MORDRED])) === null);
  check('a marker from another map does not answer this one',
    questFromPlacement('Avalon', new Set([JACK])) === null);
  check('a map with no known pair yields null',
    questFromPlacement('Baba Yaga Map', new Set([TREE])) === null);
  check('an unresolved map name yields null',
    questFromPlacement(null, new Set([TREE])) === null);
  check('any one of the three pig houses names the pigs run',
    questFromPlacement('Dark Hills', new Set([WOOD_HOUSE])) === 'pigs');

  // --- latching
  const conclusive = new Map([[TREE, 1]]);
  const inconclusive = new Map();

  const first = nextPlacement(null, 2, 'Avalon', conclusive);
  check('a conclusive read is stored', first.placed.includes(TREE) && first.mapId === 2);

  const kept = nextPlacement(first, 2, 'Avalon', inconclusive);
  check('an inconclusive read keeps the previous answer -- a despawned manager '
    + 'must not blank a resolved questline', kept.placed.includes(TREE));

  const failedSweep = nextPlacement(first, 2, 'Avalon', null);
  check('a sweep that could not run keeps it too', failedSweep.placed.includes(TREE));

  const moved = nextPlacement(first, 0, 'Dark Hills', inconclusive);
  check('a map change clears it -- the old map answer must not leak',
    moved.placed.length === 0 && moved.mapId === 0);

  const darkHills = nextPlacement(moved, 0, 'Dark Hills', new Map([[JACK, 1]]));
  check('map id 0 is a real map, not a falsy one',
    darkHills.placed.includes(JACK) && darkHills.mapId === 0);

  const restarted = nextPlacement(darkHills, 0, 'Dark Hills', new Map([[WOOD_HOUSE, 1]]));
  check('a conclusive read on the same map id replaces -- restart onto the same '
    + 'map may carry the other questline', restarted.placed.includes(WOOD_HOUSE)
    && !restarted.placed.includes(JACK));

  // --- scheduling
  // What the sweeper does between scans. placedAmong is a multi-second sweep of
  // all writable memory, so "when not to run it" is as load-bearing as the
  // answer it produces.
  check('a map with no questline pair never scans -- the camp is the live case',
    placementDue('Baba Yaga Map', false) === false);
  check('an unresolved map name never scans either',
    placementDue(null, false) === false);
  check('a quest map with an inconclusive answer scans',
    placementDue('Avalon', false) === true);
  check('a quest map with a conclusive answer does not scan',
    placementDue('Avalon', true) === false);
  check('Dark Hills with inconclusive answer scans',
    placementDue('Dark Hills', false) === true);
  check('Dark Hills with conclusive answer does not scan',
    placementDue('Dark Hills', true) === false);

  // The sweeper's loop: tracks lastMapId and conclusive status.
  function simulateSweeper(steps) {
    let placed = null, lastMapId = null, conclusive = false;
    const log = [];
    for (let i = 0; i < steps.length; i++) {
      const { mapId, scanResult = null } = steps[i];
      let scanned = false;
      if (mapId !== null) {
        if (lastMapId === null || mapId !== lastMapId) {
          lastMapId = mapId;
          conclusive = false;
        }
        const mapName = DEMO_MAPS[mapId] !== undefined ? DEMO_MAPS[mapId] : null;
        if (placementDue(mapName, conclusive)) {
          scanned = true;
          const placedNow = scanResult;
          if (placedNow && questFromPlacement(mapName, new Set(placedNow.keys())) !== null) {
            conclusive = true;
          }
          placed = nextPlacement(placed, mapId, mapName, placedNow);
        }
      }
      log.push({
        step: i, mapId, scanned, conclusive,
        placed: placed ? placed.placed : [],
      });
    }
    return log;
  }

  // Same-map restart sequence: map 0 -> map -1 -> map 0
  const restartSteps = [
    { mapId: 0, scanResult: new Map([[JACK, 1]]) },       // sweep 0: run 1 on map 0, scan finds Jack, conclusive!
    { mapId: 0 },                                          // sweep 1: still map 0, conclusive -> no scan
    { mapId: 0 },                                          // sweep 2: still map 0, conclusive -> no scan
    { mapId: -1 },                                         // sweep 3: between runs (-1), no scan
    { mapId: -1 },                                         // sweep 4: between runs (-1), no scan
    { mapId: 0, scanResult: new Map() },                   // sweep 5: new run loads map 0! First scan is inconclusive (loading)
    { mapId: 0, scanResult: new Map([[WOOD_HOUSE, 1]]) }, // sweep 6: retry scan finds Wood House, conclusive!
    { mapId: 0 },                                          // sweep 7: still map 0, conclusive -> no scan
  ];
  const restartLog = simulateSweeper(restartSteps);
  check('same-map restart sequence (0 -> -1 -> 0) triggers scan on return to map 0',
    restartLog[0].scanned && !restartLog[1].scanned && !restartLog[3].scanned && restartLog[5].scanned && restartLog[6].scanned && !restartLog[7].scanned);
  check('inconclusive first scan after restart keeps previous questline on screen',
    restartLog[5].placed.includes(JACK));
  check('conclusive scan after restart latches new questline',
    restartLog[6].placed.includes(WOOD_HOUSE) && !restartLog[6].placed.includes(JACK));

  // Unresolved map id (null) neither triggers nor clobbers latch
  const unresMapSteps = [
    { mapId: 0, scanResult: new Map([[JACK, 1]]) },
    { mapId: null }, // unresolved sweep: does not clobber lastMapId or trigger scan
    { mapId: 0 },    // same map: still conclusive, no scan
  ];
  const unresLog = simulateSweeper(unresMapSteps);
  check('an unresolved map id (null) does not trigger a scan or clobber conclusive state',
    unresLog[0].scanned && !unresLog[1].scanned && !unresLog[2].scanned);

  // Map-to-map change (0 -> 1 -> 2)
  const mapProgressionSteps = [
    { mapId: 0, scanResult: new Map([[JACK, 1]]) },
    { mapId: 1, scanResult: new Map() },            // Storm Island loading
    { mapId: 1, scanResult: new Map() },            // Still loading, scans again
    { mapId: 2, scanResult: new Map([[TREE, 1]]) }, // Avalon conclusive!
    { mapId: 2 },                                   // Avalon conclusive -> stops scanning
  ];
  const progLog = simulateSweeper(mapProgressionSteps);
  check('map transitions (0 -> 1 -> 2) trigger placement scans on each new map',
    progLog[0].scanned && progLog[1].scanned && progLog[2].scanned && progLog[3].scanned && !progLog[4].scanned);

  // Camp map never triggers scans
  const campSteps = [
    { mapId: 3 },
    { mapId: 3 },
  ];
  const campLog = simulateSweeper(campSteps);
  check('camp map never triggers placement scan',
    !campLog[0].scanned && !campLog[1].scanned);

  // Inconclusive scans continue every sweep until conclusive
  const retrySteps = [
    { mapId: 0, scanResult: new Map() },
    { mapId: 0, scanResult: new Map() },
    { mapId: 0, scanResult: new Map([[JACK, 1]]) },
    { mapId: 0 },
  ];
  const retryLog = simulateSweeper(retrySteps);
  check('inconclusive scans continue every sweep until an answer is resolved',
    retryLog[0].scanned && retryLog[1].scanned && retryLog[2].scanned && !retryLog[3].scanned);

  // --- hero rescan cadence
  //
  // These are the two rules the sweeper's melody block is built from, lifted
  // out of the worker loop so a test can reach them. They do not prove the
  // loop calls them -- nothing exported can, the loop has no seam -- but they
  // do pin the two decisions that were wrong before: the cadence itself, and
  // the fallback repeating the scan it had just run.
  const cadence = [];
  for (let n = 0; n < 12; n++) if (heroRescanDue(n)) cadence.push(n);
  check(`a cold scan is forced every ${HERO_RESCAN_SWEEPS} sweeps`,
    cadence.join(',') === '0,4,8', cadence.join(','));
  check('and not on the sweeps between them',
    !heroRescanDue(1) && !heroRescanDue(2) && !heroRescanDue(3));

  // The double-scan defect: on a rescan sweep the first attempt is already a
  // cold scan, so the fallback must not run another one.
  check('the fallback after a forced rescan tries the cache, never a second scan',
    fallbackHeroSource(true, true) === 'cache');
  check('the fallback on an ordinary sweep goes cold, since the cache was used',
    fallbackHeroSource(false, true) === 'scan');
  check('with no cache there is no second source -- the first attempt already scanned',
    fallbackHeroSource(true, false) === null && fallbackHeroSource(false, false) === null);

  // --- the melody hold. Held because the payload returns before the loading
  // screen clears, so melodies cannot have changed across the gap.
  const PAYLOAD = [{ slot: 0, name: 'Tortoise', state: 'locked', notes: 3 }];
  const OTHER = [{ slot: 0, name: 'Little Tailor', state: 'active', notes: 5 }];

  check('a resolved payload is stored',
    nextMelodies(null, 0, PAYLOAD) === PAYLOAD);
  check('a sweep that resolved nothing keeps the previous payload',
    nextMelodies(PAYLOAD, 0, null) === PAYLOAD);
  check('a new payload replaces the held one',
    nextMelodies(PAYLOAD, 0, OTHER) === OTHER);
  check('a map change within a run does NOT clear it -- melodies are per hero',
    nextMelodies(PAYLOAD, 1, null) === PAYLOAD);
  check('map id -1 clears it: the run ended',
    nextMelodies(PAYLOAD, -1, null) === null);
  check('map id -1 clears it even when a payload came in',
    nextMelodies(PAYLOAD, -1, OTHER) === null);
  check('map id 0 is a real map, not a falsy clear',
    nextMelodies(PAYLOAD, 0, null) === PAYLOAD);

  // --- melody status. Failure has to be reportable or the readiness gate in
  // state.ts would wait forever on a channel that will never answer.
  check('status starts pending', nextMelodyStatus('pending', false, 0) === 'pending');
  check('one miss is not a failure', nextMelodyStatus('pending', false, 1) === 'pending');
  check('two misses are not a failure', nextMelodyStatus('pending', false, 2) === 'pending');
  check(`${MELODY_FAIL_SWEEPS} consecutive misses is a failure`,
    nextMelodyStatus('pending', false, MELODY_FAIL_SWEEPS) === 'failed');
  check('a resolved read is ok', nextMelodyStatus('pending', true, 0) === 'ok');
  check('ok latches -- a channel that worked once is not a broken channel',
    nextMelodyStatus('ok', false, 99) === 'ok');
  check('failed recovers when a read finally lands',
    nextMelodyStatus('failed', true, 0) === 'ok');
  check('MELODY_FAIL_SWEEPS is three', MELODY_FAIL_SWEEPS === 3);

  // --- Mordred-by-elimination. Tree_Quest_Main_Manager is the only Avalon
  // marker ever confirmed to place and persist (map_verification_log.md);
  // Mordred_Quest_Manager is confirmed to never place at all, the same
  // failure Roc's manager has. Absence of the confirmed side, once the scan
  // has actually run (not just failed to resolve RTTI), names the other side
  // -- same one-hit-of-two-candidates logic as Roc vs Cyclop, just with only
  // one candidate ever observed to place.
  check('Avalon elimination rule points tree -> mordred',
    ELIMINATION_BY_MAP.Avalon.confirmed === 'tree'
    && ELIMINATION_BY_MAP.Avalon.inferred === 'mordred');
  check('a map with no elimination rule never advances the miss counter',
    nextPlacementMisses(undefined, new Map(), 5) === 5);
  check('a scan that did not run (null) does not advance the miss counter',
    nextPlacementMisses(ELIMINATION_BY_MAP.Avalon, null, 2) === 2);
  check('a real scan without the confirmed marker advances the miss counter',
    nextPlacementMisses(ELIMINATION_BY_MAP.Avalon, new Map(), 0) === 1);
  check('seeing the confirmed marker resets the miss counter',
    nextPlacementMisses(ELIMINATION_BY_MAP.Avalon, new Map([[TREE, 1]]), 2) === 0);
  check('the confirmed marker in the map still resets it even amid other entries',
    nextPlacementMisses(ELIMINATION_BY_MAP.Avalon, new Map([[MORDRED, 1], [TREE, 1]]), 2) === 0);

  check('below threshold, elimination names nothing',
    eliminatedQuest('Avalon', PLACEMENT_ELIMINATION_SWEEPS - 1) === null);
  check('at threshold, elimination names the inferred side',
    eliminatedQuest('Avalon', PLACEMENT_ELIMINATION_SWEEPS) === 'mordred');
  check('past threshold stays named -- the latch keeps working once it fires',
    eliminatedQuest('Avalon', PLACEMENT_ELIMINATION_SWEEPS + 5) === 'mordred');
  check('a map with no elimination rule never infers anything',
    eliminatedQuest('Dark Hills', 99) === null);
  check('an unresolved map name never infers anything',
    eliminatedQuest(null, 99) === null);
  check('PLACEMENT_ELIMINATION_SWEEPS is three', PLACEMENT_ELIMINATION_SWEEPS === 3);

  // readState wiring: a direct placement hit still wins even once the miss
  // counter has cleared the threshold -- elimination is the fallback, never
  // the first check.
  const avalonZeroForElim = { ...ZERO, 'Hero Level': 20, 'Is In Combat': 0, 'Current map id': 2 };
  const eliminated = state(avalonZeroForElim, null,
    { runtime: { placement_misses: PLACEMENT_ELIMINATION_SWEEPS } });
  check('readState infers mordred once placement_misses clears the threshold',
    eliminated.quest_key === 'mordred');
  const notYetEliminated = state(avalonZeroForElim, null,
    { runtime: { placement_misses: PLACEMENT_ELIMINATION_SWEEPS - 1 } });
  check('readState stays undetermined below the threshold',
    notYetEliminated.quest_key === null);
  const directHitOverridesElimination = state(avalonZeroForElim, { mapId: 2, placed: [TREE] },
    { runtime: { placement_misses: PLACEMENT_ELIMINATION_SWEEPS } });
  check('a direct placement hit wins over elimination, not the other way round',
    directHitOverridesElimination.quest_key === 'tree');

  // --- readState
  const avalonZero = { ...ZERO, 'Hero Level': 20, 'Is In Combat': 0, 'Current map id': 2 };

  // The frame carries no candidate list. The assertions split: the frame
  // says "undetermined", QUEST_PAIR_BY_MAP says which two.
  const blind = state(avalonZero, null);
  check('with no placement, Avalon at step 0 is undetermined',
    blind.quest_key === null);
  check('and its two candidates are still named by the table',
    QUEST_PAIR_BY_MAP.Avalon.length === 2
    && QUEST_PAIR_BY_MAP.Avalon.includes('mordred')
    && QUEST_PAIR_BY_MAP.Avalon.includes('tree'),
    QUEST_PAIR_BY_MAP.Avalon.join(', '));

  const dhZero = { ...ZERO, 'Hero Level': 20, 'Is In Combat': 0, 'Current map id': 0 };
  const dhBlind = state(dhZero, null);
  check('with no placement, Dark Hills at step 0 is undetermined',
    dhBlind.quest_key === null);
  check('and Dark Hills still has two candidates in the table',
    QUEST_PAIR_BY_MAP['Dark Hills'].length === 2, QUEST_PAIR_BY_MAP['Dark Hills'].join(', '));

  const siZero = { ...ZERO, 'Hero Level': 20, 'Is In Combat': 0, 'Current map id': 1 };
  const siBlind = state(siZero, null);
  check('with no placement, Storm Island at step 0 is undetermined',
    siBlind.quest_key === null);
  check('and Storm Island still has two candidates in the table',
    QUEST_PAIR_BY_MAP['Storm Island'].length === 2, QUEST_PAIR_BY_MAP['Storm Island'].join(', '));

  const named = state(avalonZero, { mapId: 2, placed: [TREE] });
  check('placement names the questline at step 0, which no GlobalValue can',
    named.quest_key === 'tree');

  const stale = state(avalonZero, { mapId: 0, placed: [JACK] });
  check('a latched answer from another map is ignored', stale.quest_key === null);

  const stalePigs = state(siZero, { mapId: 0, placed: [WOOD_HOUSE] });
  check('a latched pig house from another map is ignored',
    stalePigs.quest_key === null && stalePigs.quest_name === 'Undetermined');

  const menuState = state({ ...ZERO, 'Hero Level': 0, 'Is In Combat': 0, 'Current map id': 2 },
    { mapId: 2, placed: [TREE] });
  check('placement is not cleared at level 0 -- menu holds previous questline',
    menuState.quest_key === 'tree');

  const ticked = state({ ...avalonZero, Mordred_Quest_Current_Step: 4 },
    { mapId: 2, placed: [MORDRED] });
  check('a ticked step and placement agreeing names the placed questline',
    ticked.quest_key === 'mordred' && ticked.quest_name === 'Mordred');

  const disagree = state({ ...avalonZero, Mordred_Quest_Current_Step: 4 },
    { mapId: 2, placed: [TREE] });
  check('placement wins over a step counter that disagrees',
    disagree.quest_key === 'tree');

  const staleJackWithTreeTicked = state({
    ...avalonZero,
    Jack_Quest_Current_Step: 4, // stale step counter from another map
    Tree_Quest_Current_Step: 3, // real progress on placed tree quest
  }, { mapId: 2, placed: [TREE] });
  check('placement override names the placed quest, not the stale one',
    staleJackWithTreeTicked.quest_key === 'tree' && staleJackWithTreeTicked.quest_name === 'Tree / Morgan');

  const dh = state({ ...ZERO, 'Hero Level': 3, 'Is In Combat': 0, 'Current map id': 0 },
    { mapId: 0, placed: [WOOD_HOUSE] });
  check('map id 0 with a conclusive placement resolves', dh.quest_key === 'pigs');
  check('map id 0 with a conclusive wood placement has wood house icon', dh.quest_icon === 'house_wood.png');
  check('map id 0 with a conclusive wood placement is headed Wood House', dh.quest_name === 'Wood House');

  const dhStraw = state({ ...ZERO, 'Hero Level': 3, 'Is In Combat': 0, 'Current map id': 0, Current_House_Type: 1 },
    { mapId: 0, placed: [WOOD_HOUSE] });
  check('pigs quest with straw house has straw house icon', dhStraw.quest_icon === 'house_straw.png');
  check('and is headed Straw House', dhStraw.quest_name === 'Straw House');

  const dhWood = state({ ...ZERO, 'Hero Level': 3, 'Is In Combat': 0, 'Current map id': 0, Current_House_Type: 2 },
    { mapId: 0, placed: [WOOD_HOUSE] });
  check('pigs quest with wood house has wood house icon', dhWood.quest_icon === 'house_wood.png');
  check('and is headed Wood House', dhWood.quest_name === 'Wood House');

  const dhStone = state({ ...ZERO, 'Hero Level': 3, 'Is In Combat': 0, 'Current map id': 0, Current_House_Type: 3 },
    { mapId: 0, placed: [WOOD_HOUSE] });
  check('pigs quest with stone house has stone house icon', dhStone.quest_icon === 'house_stone.png');
  check('and is headed Stone House', dhStone.quest_name === 'Stone House');

  // --- staleness: a step counter from the previous map must not name a
  // questline. Measured live: step counters reset ~2s AFTER the map id moves,
  // and placement needs a sweep to answer, so this window is real.
  const staleJack = state(
    { ...ZERO, 'Hero Level': 5, 'Is In Combat': 0, 'Current map id': 1,
      Jack_Quest_Current_Step: 7 },
    { mapId: 1, placed: [] });
  check('a stale Jack step with inconclusive placement names no questline',
    staleJack.quest_key === null && staleJack.quest_name === 'Undetermined');

  const staleOther = state(
    { ...ZERO, 'Hero Level': 5, 'Is In Combat': 0, 'Current map id': 0,
      Mordred_Quest_Current_Step: 4 },
    { mapId: 0, placed: [] });
  check('a stale Mordred step on Dark Hills names no questline either',
    staleOther.quest_key === null);

  const staleHouse = state(
    { ...ZERO, 'Hero Level': 5, 'Is In Combat': 0, 'Current map id': 1,
      Current_House_Type: 2 },
    { mapId: 1, placed: [] });
  check('a stale house type does not name the pigs run on Storm Island',
    staleHouse.quest_key === null);

  // --- placement still answers, and the step counter still writes the line
  const jackStarted = state(
    { ...ZERO, 'Hero Level': 5, 'Is In Combat': 0, 'Current map id': 0,
      Jack_Quest_Current_Step: 7 },
    { mapId: 0, placed: [JACK] });
  check('conclusive placement names the questline',
    jackStarted.quest_key === 'jack' && jackStarted.quest_name === 'Jack');
  check('and no step is described', !('line' in jackStarted));

  const jackNotStarted = state(
    { ...ZERO, 'Hero Level': 5, 'Is In Combat': 0, 'Current map id': 0 },
    { mapId: 0, placed: [JACK] });
  check('a placed questline with a zero step is still named',
    jackNotStarted.quest_key === 'jack' && jackNotStarted.quest_name === 'Jack');

  const pigsFromHouse = state(
    { ...ZERO, 'Hero Level': 5, 'Is In Combat': 0, 'Current map id': 0,
      Current_House_Type: 2 },
    { mapId: 0, placed: [WOOD_HOUSE] });
  check('a placed pig house names the pigs run',
    pigsFromHouse.quest_key === 'pigs' && pigsFromHouse.quest_name === 'Wood House');
  check('and takes its icon from the house type',
    pigsFromHouse.quest_icon === 'house_wood.png');

  const pigsFromPathOnly = state(
    { ...ZERO, 'Hero Level': 5, 'Is In Combat': 0, 'Current map id': 0 },
    { mapId: 0, placed: [WOOD_HOUSE] });
  check('the house type is synthesised from the placed path when the value is 0',
    pigsFromPathOnly.quest_key === 'pigs' && pigsFromPathOnly.quest_name === 'Wood House');

  const camp = state(
    { ...ZERO, 'Hero Level': 5, 'Is In Combat': 0, 'Current map id': 9,
      Jack_Quest_Current_Step: 7 },
    null);
  check('a map with no marker pair shows no questline at all -- there is none',
    camp.quest_key === null);

  // --- no_run (between runs)
  check('no_run is true for map id -1 with level 0',
    state({ 'Current map id': -1, 'Hero Level': 0 }, null).no_run === true);
  // The level is not consulted. Measured 2026-09-01 (run1.jsonl): the main
  // menu sits at Hero Level 1 before any hero exists, and the level only
  // reaches 0 in hero select -- so a level term makes the main menu read as a
  // run in progress. At the other end it is worse: leaving a run drops map id
  // to -1 about 10.8 s before the level reaches 0.
  check('no_run is true for map id -1 at the main menu, which reads level 1',
    state({ 'Current map id': -1, 'Hero Level': 1 }, null).no_run === true);
  check('no_run is true the instant a run ends, before the level falls',
    state({ 'Current map id': -1, 'Hero Level': 14 }, null).no_run === true);
  check('no_run is false for map id 0 with level 0',
    state({ 'Current map id': 0, 'Hero Level': 0 }, null).no_run === false);
  check('no_run is false for map id 1 with level 0',
    state({ 'Current map id': 1, 'Hero Level': 0 }, null).no_run === false);
  check('no_run is false for map id 2 with level 20',
    state({ 'Current map id': 2, 'Hero Level': 20 }, null).no_run === false);
  check('no_run is false when map id is null with level 0',
    state({ 'Current map id': null, 'Hero Level': 0 }, null).no_run === false);
  check('no_run is true when map id is -1 and the level has not resolved',
    state({ 'Current map id': -1, 'Hero Level': null }, null).no_run === true);

  // The renderer never touches this object -- it receives JSON over stdio and
  // a structured clone over IPC, and BOTH drop a non-enumerable property. A
  // flag that reads correctly here and vanishes in transit is worse than no
  // flag, because every assertion above still passes. Check the wire, not the
  // object.
  const betweenRuns = state({ 'Current map id': -1, 'Hero Level': 0 }, null);
  check('no_run is an enumerable key, not a hidden property',
    Object.keys(betweenRuns).includes('no_run'));
  check('and it survives the JSON trip the renderer actually receives',
    JSON.parse(JSON.stringify(betweenRuns)).no_run === true);
  check('and reads false over the wire during a run',
    JSON.parse(JSON.stringify(state({ 'Current map id': 0, 'Hero Level': 5 }, null))).no_run === false);

  // --- the readiness gate. One rule, here, so the renderer never re-derives it.
  const MELODIES = [{ slot: 0, name: 'Tortoise', state: 'locked', notes: 3 }];
  const LIVE = { ...ZERO, 'Hero Level': 5, 'Is In Combat': 0, 'Current map id': 0,
    Jack_Quest_Current_Step: 7 };
  const PLACED = { mapId: 0, placed: [JACK] };

  check('every channel resolved is ready',
    state(LIVE, PLACED, { melodies: MELODIES, melody_status: 'ok' }).ready === true);
  check('an unresolved level is not ready',
    state({ ...LIVE, 'Hero Level': null }, PLACED,
      { melodies: MELODIES, melody_status: 'ok' }).ready === false);
  check('an unresolved combat flag is not ready',
    state({ ...LIVE, 'Is In Combat': null }, PLACED,
      { melodies: MELODIES, melody_status: 'ok' }).ready === false);
  check('an unresolved map id is not ready',
    state({ ...LIVE, 'Current map id': null }, PLACED,
      { melodies: MELODIES, melody_status: 'ok' }).ready === false);
  check('a map id with no name is not ready',
    state({ ...LIVE, 'Current map id': 42 }, PLACED,
      { melodies: MELODIES, melody_status: 'ok' }).ready === false);
  check('an unnamed questline is not ready -- this is the stale-panel window',
    state(LIVE, { mapId: 0, placed: [] },
      { melodies: MELODIES, melody_status: 'ok' }).ready === false);
  check('missing melodies are not ready while the channel is still pending',
    state(LIVE, PLACED, { melodies: null, melody_status: 'pending' }).ready === false);
  check('a failed melody channel does not hold the gate shut',
    state(LIVE, PLACED, { melodies: null, melody_status: 'failed' }).ready === true);
  check('a level of 0 is a resolved reading, not an unresolved one',
    state({ ...LIVE, 'Hero Level': 0 }, PLACED,
      { melodies: MELODIES, melody_status: 'ok' }).ready === true);

  const between = state(
    { ...ZERO, 'Hero Level': 0, 'Is In Combat': 0, 'Current map id': -1 },
    null, { melodies: MELODIES, melody_status: 'ok' });
  check('between runs is never ready', between.no_run === true && between.ready === false);

  check('melody_status defaults to pending when the source does not supply it',
    state(LIVE, PLACED).melody_status === 'pending');

  // --- sweeper mapNames accumulation (Fix 7)
  console.log('\n--- test-questline: sweeper mapNames accumulation (Fix 7) ---');

  function makeStubIndex(entries) {
    const map = new Map();
    for (const [k, v] of Object.entries(entries)) {
      map.set(k, v);
    }
    return {
      names: map,
      resolve(name) {
        if (!map.has(name)) return { status: 'unresolved', value: null };
        const entry = map.get(name);
        if (entry === null || entry === undefined) return { status: 'unresolved', value: null };
        if (typeof entry === 'object' && 'status' in entry) return entry;
        return { status: 'ok', value: entry };
      },
    };
  }

  let mapNames = null;

  // Case 1: Pre-resolution (nothing resolves -> null)
  const emptyIndex = makeStubIndex({});
  mapNames = mergeMapNames(mapNames, emptyIndex);
  check('mapNames remains null when no map id resolves', mapNames === null);

  // Case 2: Sweep 1 (partial resolution with controls for non-suffix and CURRENT_MAP_ID)
  const sweep1Index = makeStubIndex({
    'Dark Hills map id': { status: 'ok', value: 0 },
    'Hero Level': { status: 'ok', value: 3 },
    'Current map id': { status: 'ok', value: 0 },
    'Unresolved map id': { status: 'unresolved', value: null },
  });
  mapNames = mergeMapNames(mapNames, sweep1Index);
  check('sweep 1 resolves Dark Hills at map id 0',
    mapNames !== null && mapNames[0] === 'Dark Hills' && mapNames[1] === undefined);
  check('control: names without suffix and CURRENT_MAP_ID are excluded',
    mapNames !== null && !Object.values(mapNames).includes('Hero Level') && !Object.values(mapNames).includes('Current'));

  // Case 3: Sweep 2 (accumulates newly resolved map ids without losing previous ones)
  const sweep2Index = makeStubIndex({
    'Dark Hills map id': { status: 'ok', value: 0 },
    'Storm Island map id': { status: 'ok', value: 1 },
    'Avalon map id': { status: 'ok', value: 2 },
  });
  mapNames = mergeMapNames(mapNames, sweep2Index);
  check('sweep 2 accumulates newly resolved map ids rather than freezing at first sweep',
    mapNames !== null && mapNames[0] === 'Dark Hills' && mapNames[1] === 'Storm Island' && mapNames[2] === 'Avalon');

  console.log(failures === 0 ? '  test-questline: all passed' : `  ${failures} failed`);
  return failures;
}

if (require.main === module) process.exit(main() ? 1 : 0);
module.exports = { main };
