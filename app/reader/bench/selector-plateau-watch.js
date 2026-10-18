'use strict';
// Does the tiles worker declare a map stable on a partial selector count?
//
//   node app/reader/bench/selector-plateau-watch.js [outfile]
//
// Two counts per line, on purpose. `prod` is the selector count in the
// production roster (reader.tiles(), the tiles worker's output), which
// freezes once the worker declares the map stable. `live` is an independent
// findSelectors() heap scan on a second handle, every LIVE_MS, which keeps
// counting after the worker has stopped. The worker is the code under test,
// so its own output cannot be the control.
//
// The race is confirmed if `live` keeps rising after `prod` has frozen.
// The race is refuted if `prod` always reaches the final `live` count.

const fs = require('fs');
const { Reader } = require('../reader');
const { findPid, openProcess } = require('../win32');
const tiles = require('../tiles');
const { CURRENT_MAP_ID, PROCESS_NAME } = require('../state');

const LIVE_MS = 1500;
const out = process.argv[2] || null;
const t0 = Date.now();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function say(line) {
  const s = `[${((Date.now() - t0) / 1000).toFixed(1).padStart(7)}s] ${line}`;
  console.log(s);
  if (out) fs.appendFileSync(out, s + '\n');
}

async function main() {
  say(`watching for ${PROCESS_NAME}...`);
  let pid;
  for (;;) {
    try { pid = findPid(PROCESS_NAME); break; } catch { await sleep(2000); }
  }
  const reader = new Reader(pid);
  const proc = openProcess(pid);
  const vt = {};
  say(`attached pid ${pid}`);

  let lastMapId = undefined;
  let lastProd = null;
  let lastLive = null;
  let lastSweeps = -1;

  for (;;) {
    if (!reader.alive()) { say('game process exited'); return; }
    if (reader.fatal) { say(`fatal: ${reader.fatal}`); return; }

    const id = reader.get(CURRENT_MAP_ID);
    if (id !== lastMapId) {
      say(`MAP ID ${lastMapId} -> ${id}`);
      lastMapId = id; lastProd = null; lastLive = null;
    }

    const roster = reader.tiles();
    const prod = roster === null ? null : roster.filter(t => t.source === 'selector').length;

    let live = null;
    try {
      const r = tiles.resolveVtables(proc, reader.base, vt);
      if (r && r.selectorVt) live = tiles.findSelectors(proc, r.selectorVt).length;
    } catch (e) { live = `err ${e.message}`; }

    if (prod !== lastProd || live !== lastLive || reader.sweeps !== lastSweeps) {
      const rosterN = roster === null ? '-' : roster.length;
      say(`map ${id} sweep ${reader.sweeps}  prod ${prod === null ? '-' : prod}  live ${live === null ? '-' : live}  roster ${rosterN}`);
      lastProd = prod; lastLive = live; lastSweeps = reader.sweeps;
    }
    await sleep(LIVE_MS);
  }
}

main();
