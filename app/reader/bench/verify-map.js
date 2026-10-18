'use strict';
// Per-map verification probe. Run with Ravenswatch running, on the map you
// want to check:  node app/reader/bench/verify-map.js
//
// WHAT THIS CAN AND CANNOT DO. It reads through the same code the app reads
// through, so it cannot be a second opinion on the app's answer -- if the
// marker table is wrong, this is wrong the same way. Ground truth is the game
// on screen, and that is the operator's job, not this file's.
//
// What it does instead is print the intermediate state the panel throws away,
// so that a wrong answer has a chance to LOOK wrong. The panel shows a
// conclusion. A wrong conclusion built from plausible working is
// indistinguishable from a right one; wrong working usually is not.
//
// THE DISTINCTION THAT MATTERS, and the reason a plain hit/miss is useless
// here. A marker path that does not match can be in one of two completely
// different states, and only one of them is a defect:
//
//   ABSENT  the string is nowhere in the process. The path is misspelled, or
//           the map that loads it is not the one running. On its OWN map this
//           is a defect and needs no live run to interpret.
//   LOADED  the string is resident and carries resource-object triples, but
//           nothing points at it from oCEntity+0x38. Correct and expected for
//           the half of a pair that was not chosen this run.
//   PLACED  entities reference it. This is what names a questline.
//
// Roc sat where neither of those reads as a defect: its manager path was
// LOADED on every run, on both sides of the pair, and PLACED on none. A pair
// where one side is never PLACED on either run is the shape to look for, and
// it takes a run on each side to see it.
//
// placedAmong() computes residency and triples at its steps 1 and 2 and then
// discards both, returning only the verdict. This re-derives them with the
// same primitives so the three states can be told apart.

const { Reader } = require('../reader');
const { placedAmong } = require('../placement');
const { scanStrings, scanPointers } = require('../scan');
const {
  readState, questFromPlacement, QUESTLINES,
  MARKER_PATHS, QUEST_MARKERS, QUEST_PAIR_BY_MAP,
  TRACKED_NAMES, CURRENT_MAP_ID,
} = require('../state');

const TIMEOUT_MS = 45000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** The three-way state of every marker path, plus the counts behind it. */
function classify(proc, base) {
  const strings = scanStrings(proc, MARKER_PATHS);
  const addrOf = new Map();
  const all = [];
  for (const p of MARKER_PATHS) {
    const a = strings.get(p) || [];
    addrOf.set(p, a);
    all.push(...a);
  }
  const triples = all.length ? scanPointers(proc, all) : new Map();
  const placed = placedAmong(proc, base, MARKER_PATHS, {});

  const out = new Map();
  for (const p of MARKER_PATHS) {
    const copies = addrOf.get(p).length;
    let trip = 0;
    for (const a of addrOf.get(p)) trip += (triples.get(a) || []).length;
    const ents = placed === null ? null : (placed.get(p) || 0);
    let state;
    if (ents) state = 'PLACED';
    else if (copies === 0) state = 'ABSENT';
    else if (trip === 0) state = 'NO-TRIPLE';
    else state = 'LOADED';
    out.set(p, { state, copies, trip, ents });
  }
  return { rows: out, placed };
}

async function main() {
  const reader = new Reader();
  console.log(`attached  pid ${reader.pid}  base 0x${reader.base.toString(16).toUpperCase()}`);

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (reader.fatal) { console.error(`fatal: ${reader.fatal}`); process.exit(1); }
    if (reader.found() > 0 && reader.placed !== null) break;
    await sleep(250);
  }
  if (reader.found() === 0) { console.error('no values resolved before timeout'); process.exit(1); }

  const mapId = reader.get(CURRENT_MAP_ID);
  const mapName = reader.maps()[mapId];
  console.log(`sweeps ${reader.sweeps}  resolved ${reader.found()}/${TRACKED_NAMES.length}`);
  console.log(`map id ${mapId} -> ${mapName === undefined ? '(unknown)' : mapName}\n`);

  console.log('-- tracked values --');
  for (const name of TRACKED_NAMES) {
    const v = reader.get(name);
    console.log(`  ${v === null ? '  ?' : String(v).padStart(3)}  ${name}`);
  }

  console.log('\n-- marker paths: residency, triples, entities --');
  const t0 = process.hrtime.bigint();
  const { rows, placed } = classify(reader.proc, reader.base);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (placed === null) console.log('  oCEntity unresolved -- entity column is meaningless this pass');
  console.log(`  ${ms.toFixed(0)} ms\n`);
  console.log('      state      copies  triples  entities  path');
  const pair = QUEST_PAIR_BY_MAP[mapName] || [];
  for (const key of Object.keys(QUEST_MARKERS)) {
    console.log(`  ${key}${pair.includes(key) ? '  [this map]' : ''}`);
    for (const p of QUEST_MARKERS[key]) {
      const r = rows.get(p);
      const ents = r.ents === null ? '?' : String(r.ents);
      console.log(`      ${r.state.padEnd(10)} ${String(r.copies).padStart(6)} ${String(r.trip).padStart(8)} ${ents.padStart(9)}  ${p}`);
    }
  }

  // The reading that needs a human, spelled out rather than left implied.
  console.log('\n-- what to check by eye --');
  for (const key of pair) {
    const st = QUEST_MARKERS[key].map(p => rows.get(p).state);
    if (st.includes('PLACED')) {
      console.log(`  ${key}: PLACED. This is the questline placement names.`);
    } else if (st.every(x => x === 'ABSENT')) {
      console.log(`  ${key}: every path ABSENT on its own map. Suspect the SPELLING --`);
      console.log('      a path that is not resident cannot be the one the game loads.');
    } else {
      console.log(`  ${key}: LOADED, not placed. Expected for the side not chosen.`);
      console.log(`      Only a run on the ${key} side proves it can ever be PLACED.`);
    }
  }
  const offMap = [];
  for (const key of Object.keys(QUEST_MARKERS)) {
    if (pair.includes(key)) continue;
    for (const p of QUEST_MARKERS[key]) {
      const st = rows.get(p).state;
      if (st !== 'ABSENT') offMap.push([key, p, st]);
    }
  }
  if (offMap.length) {
    console.log("  OTHER MAPS' markers are present in this process:");
    for (const [k, p, st] of offMap) console.log(`      ${st.padEnd(10)} ${k}  ${p}`);
    console.log('      Cross-map residency does not break the pair test on its own.');
    console.log('      A cross-map PLACED would. Read the entity column above.');
  } else {
    console.log("  No other map's marker path is even resident. Marker sets do not");
    console.log('      leak across maps on this run.');
  }

  const set = placed ? new Set(placed.keys()) : null;
  console.log('\n-- pair test --');
  for (const map of Object.keys(QUEST_PAIR_BY_MAP)) {
    const q = questFromPlacement(map, set);
    const mark = map === mapName ? ' <- current map' : '';
    console.log(`  ${map.padEnd(14)} ${q === null ? 'inconclusive' : q}${mark}`);
  }

  const state = readState(reader);
  console.log('\n-- what the panel should show --');
  console.log(`  map        ${state.map_name}  (${state.map_sub})`);
  console.log(`  level      ${state.level}`);
  console.log(`  combat     ${state.in_combat === null ? '?' : (state.in_combat ? 'IN COMBAT' : 'OUT OF COMBAT')}`);
  console.log(`  questline  ${state.quest_name} (${state.quest_key === null ? 'undetermined' : state.quest_key})`);
  console.log(`  line       ${state.line}`);
  // Only the undetermined case, which is the one this bench is used to diagnose.
  if (state.quest_key === null) {
    const pair = QUEST_PAIR_BY_MAP[state.map_name];
    console.log(`  expected   ${pair ? pair.map(k => QUESTLINES[k][0]).join(' or ') : 'no side questline known'}`);
  }

  console.log('\n-- melodies --');
  if (!state.melodies) console.log('  none resolved');
  else for (const m of state.melodies) {
    console.log(`  slot ${m.slot}  ${String(m.notes).padStart(2)} notes  ${m.state.padEnd(9)} ${m.name}  (${m.internal_name})`);
  }

  reader.close();
}

main().then(() => process.exit(0));
