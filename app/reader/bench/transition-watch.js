'use strict';
// Watch a map transition live: ordering across the boundary, marker
// classification on the map you land on, and the melody channel throughout.
//
//   node app/reader/bench/transition-watch.js [outfile]
//
// Run it BEFORE the transition. It polls at the app's own cadence, timestamps
// every change, and classifies markers once the new map has actually placed
// its entities.
//
// WHY IT RETRIES RATHER THAN CLASSIFYING ONCE. Map id changes before the
// generator has placed anything. Measured 2026-08-29 on a Dark Hills -> Storm
// Island transition: three seconds after the id flipped, every marker on the
// new map read LOADED with zero entities and the pair test was inconclusive.
// Classifying once on a timer reports "nothing placed" and looks like a
// broken marker. The app avoids this because placementDue() keeps scanning
// every sweep while the answer is inconclusive and stops once it is not; this
// mirrors that, and logs each attempt so the delay is visible rather than
// smoothed away.
//
// The melody columns are here because the pool and the lifecycle come from
// different reads and fail independently. The pool resolves from a static
// registry; the lifecycle is read per hero. When the lifecycle read drops out
// the renderer dims every row, which looks like the melodies changed when
// only the read did. Logging them separately shows which one actually moved.

const fs = require('fs');
const { Reader } = require('../reader');
const { placedAmong } = require('../placement');
const { scanStrings, scanPointers } = require('../scan');
const {
  questFromPlacement, MARKER_PATHS, QUEST_MARKERS,
  QUEST_PAIR_BY_MAP, TRACKED_NAMES, CURRENT_MAP_ID,
} = require('../state');

const POLL_MS = 250;
const FIRST_TRY_MS = 2000;      // first classification attempt after a map id change
const RETRY_MS = 4000;          // gap between attempts while inconclusive
const MAX_TRIES = 12;
const out = process.argv[2] || null;
const t0 = Date.now();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function say(line) {
  const t = ((Date.now() - t0) / 1000).toFixed(1).padStart(7);
  const s = `[${t}s] ${line}`;
  console.log(s);
  if (out) { try { fs.appendFileSync(out, s + '\n'); } catch {} }
}

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
  const rows = new Map();
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
    rows.set(p, { state, copies, trip, ents });
  }
  return { rows, placed };
}

/** @returns true when the pair test on this map came out conclusive. */
function attempt(reader, mapName, n) {
  const t = Date.now();
  const { rows, placed } = classify(reader.proc, reader.base);
  const ms = Date.now() - t;
  const set = placed ? new Set(placed.keys()) : null;
  const answer = questFromPlacement(mapName, set);
  const pair = QUEST_PAIR_BY_MAP[mapName] || [];

  const anyPlaced = [...rows.values()].some(r => r.ents);
  say(`classify #${n} on ${mapName} (${ms} ms): ${answer === null ? 'INCONCLUSIVE' : answer}${anyPlaced ? '' : ' -- nothing placed anywhere yet'}`);

  if (answer !== null || n >= MAX_TRIES) {
    for (const key of Object.keys(QUEST_MARKERS)) {
      for (const p of QUEST_MARKERS[key]) {
        const r = rows.get(p);
        const ents = r.ents === null ? '?' : String(r.ents);
        const mark = pair.includes(key) ? ' *' : '  ';
        const leaf = p.split('\\').pop();
        say(`   ${mark} ${key.padEnd(8)} ${r.state.padEnd(10)} copies ${String(r.copies).padStart(3)}  triples ${String(r.trip).padStart(3)}  entities ${ents.padStart(3)}  ${leaf}`);
      }
    }
    for (const map of Object.keys(QUEST_PAIR_BY_MAP)) {
      const q = questFromPlacement(map, set);
      say(`     pair ${map.padEnd(14)} ${q === null ? 'inconclusive' : q}${map === mapName ? '  <- current' : ''}`);
    }
  }
  return answer !== null;
}

function melodySig(ms) {
  if (!ms) return 'null';
  return ms.map(m => `${m.slot}:${m.name}/${m.notes}/${m.state === null || m.state === undefined ? 'UNRESOLVED' : m.state}`).join('  ');
}

async function main() {
  const reader = new Reader();
  say(`attached pid ${reader.pid} base 0x${reader.base.toString(16).toUpperCase()}`);

  const watch = [CURRENT_MAP_ID, 'Hero Level',
    ...TRACKED_NAMES.filter(n => n.endsWith('_Step') || n.startsWith('Current_House') || n.startsWith('Pig_House'))];
  const last = new Map();
  let lastMapId = null;
  let lastMel = undefined;
  let nextTry = null;
  let tries = 0;
  let settled = null;
  let ready = false;

  for (;;) {
    if (!reader.alive()) { say('game process exited'); break; }
    if (reader.fatal) { say(`fatal: ${reader.fatal}`); break; }

    if (!ready && reader.found() > 0) {
      ready = true;
      say(`sweep resolved ${reader.found()}/${TRACKED_NAMES.length}`);
    }

    if (ready) {
      for (const n of watch) {
        const v = reader.get(n);
        if (last.has(n) && last.get(n) === v) continue;
        if (last.has(n)) say(`${n}: ${last.get(n)} -> ${v}`);
        last.set(n, v);
      }

      // The melody channel, pool and lifecycle together. Logged on any change
      // so a transient all-UNRESOLVED window shows up with its duration.
      const sig = melodySig(reader.melodies());
      if (sig !== lastMel) {
        say(`MELODIES ${sig}`);
        lastMel = sig;
      }

      const id = reader.get(CURRENT_MAP_ID);
      if (id !== lastMapId) {
        const name = reader.maps()[id];
        say(`MAP ID ${lastMapId} -> ${id}${name === undefined ? '' : `  (${name})`}`);
        lastMapId = id;
        settled = null;
        tries = 0;
        nextTry = (id !== null && id >= 0) ? Date.now() + FIRST_TRY_MS : null;
      }

      if (nextTry !== null && Date.now() >= nextTry && settled === null) {
        const name = reader.maps()[id];
        if (name === undefined || !QUEST_PAIR_BY_MAP[name]) {
          nextTry = null;
        } else {
          tries++;
          const ok = attempt(reader, name, tries);
          if (ok) { settled = name; nextTry = null; say(`answer settled after ${tries} attempt(s)`); }
          else if (tries >= MAX_TRIES) { nextTry = null; say(`gave up after ${tries} attempts -- still inconclusive`); }
          else nextTry = Date.now() + RETRY_MS;
        }
      }
    }

    await sleep(POLL_MS);
  }
  reader.close();
}

main().then(() => process.exit(0));
