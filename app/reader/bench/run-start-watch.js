'use strict';
// Ordering at the START of a run: does Hero Level rise before map id leaves -1?
//
//   node app/reader/bench/run-start-watch.js [outfile]
//
// Start it BEFORE clicking into a run. It polls the Reader's own 250 ms value
// path and prints every change to map id and Hero Level with a timestamp, so
// the order of the two is read off the log rather than inferred.
//
// WHY IT MATTERS. `no_run` in state.js tests map id AND Hero Level. The level
// term is documented as stopping a mid-run load from flashing the between-runs
// screen. Mid-run loads were measured on 2026-08-29 never to produce -1, so
// that is not what it does; what it actually does is delay the between-runs
// screen by ~11 s at the end of every run. Dropping the term is safe only if
// entering a run does not raise the level while map id is still -1. This is
// that reading.
//
// It also captures the new run's scene context address. A map transition keeps
// the context address and a run boundary changes it, which is the discriminator
// open_findings.md proposes for holding the melody payload across a load. The
// stated risk is that a freed address gets reused; logging the address on each
// fresh run is how that gets tested rather than assumed.

const fs = require('fs');
const { Reader } = require('../reader');
const { CURRENT_MAP_ID, TRACKED_NAMES } = require('../state');
const { openProcess, moduleBase } = require('../win32');
const melodies = require('../melodies');
const rtti = require('../rtti');

const POLL_MS = 250;
const out = process.argv[2] || null;
const t0 = Date.now();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function say(line) {
  const t = ((Date.now() - t0) / 1000).toFixed(2).padStart(8);
  const s = `[${t}s] ${line}`;
  console.log(s);
  if (out) { try { fs.appendFileSync(out, s + '\n'); } catch {} }
}

(async () => {
  const reader = new Reader();
  say(`attached pid ${reader.pid} base 0x${reader.base.toString(16).toUpperCase()}`);
  say('waiting for the run to start -- map id and Hero Level, 250 ms');

  // Separate handle for the context read. The Reader's own worker is busy
  // sweeping; this is three pointer reads per hero off a cached vtable.
  const proc = openProcess(reader.pid);
  const mod = moduleBase(reader.pid);
  const heroRvas = rtti.resolveAllVtableRvas(proc, mod.base, melodies.HERO_CONTROLLER_RTTI);
  const heroVt = heroRvas.length ? mod.base + heroRvas[0] : null;
  let contexts = null;

  function readContexts() {
    if (!heroVt) return null;
    const found = melodies.findHeroes(proc, { heroControllerVt: heroVt }, null);
    const rows = [];
    for (const h of found) {
      const e = proc.readPtr(h + melodies.HERO_ENTITY_OFFSET);
      const c = e ? proc.readPtr(e + melodies.ENTITY_CONTEXT_OFFSET) : 0;
      if (c) rows.push(`0x${h.toString(16)}->0x${c.toString(16)}`);
    }
    return rows.length ? rows.join(' ') : '(none)';
  }

  let ready = false;
  let lastId, lastLvl;
  let firstMove = null;      // which of the two moved first
  let leftMinusOne = null;   // when map id stopped being -1

  process.on('SIGINT', () => {
    say('STOP');
    try { proc.close(); } catch {}
    process.exit(0);
  });

  for (;;) {
    if (!reader.alive()) { say('game process exited'); break; }
    if (reader.fatal) { say(`fatal: ${reader.fatal}`); break; }

    if (!ready && reader.found() > 0) {
      ready = true;
      say(`sweep resolved ${reader.found()}/${TRACKED_NAMES.length}`);
      contexts = readContexts();
      say(`baseline contexts ${contexts}`);
    }

    if (ready) {
      const id = reader.get(CURRENT_MAP_ID);
      const lvl = reader.get('Hero Level');

      if (id !== lastId || lvl !== lastLvl) {
        const moved = [];
        if (id !== lastId) moved.push('map id');
        if (lvl !== lastLvl) moved.push('Hero Level');
        say(`map id ${lastId} -> ${id}   Hero Level ${lastLvl} -> ${lvl}   [${moved.join(' + ')}]`);

        // The answer, stated once, at the moment it becomes knowable.
        if (lastId !== undefined) {
          const levelRose = lvl !== null && lastLvl !== null && lvl > lastLvl;
          const stillMinusOne = id === -1;
          if (firstMove === null && levelRose && stillMinusOne) {
            firstMove = 'level';
            say('  >> Hero Level ROSE WHILE map id is still -1 -- the no_run level term is load-bearing');
          }
          if (leftMinusOne === null && lastId === -1 && id !== -1 && id !== null) {
            leftMinusOne = Date.now();
            if (firstMove === null) {
              firstMove = 'mapid';
              say('  >> map id left -1 with Hero Level unchanged -- the level term can go');
            }
          }
        }

        lastId = id; lastLvl = lvl;

        const now = readContexts();
        if (now !== contexts) {
          say(`  contexts ${contexts} -> ${now}`);
          contexts = now;
        }
      }
    }

    await sleep(POLL_MS);
  }
})();
