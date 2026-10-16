'use strict';
// Standing watcher for the gap between the tile roster resolving and reward
// selectors becoming readable.
//
//   node app/reader/bench/tile-reward-timing.js [outfile]
//
// Uses the real Reader (same sweeper.js worker the app runs), so
// reader.sweeps and reader.tiles() are the actual production signals -- not
// a reimplementation of the chain/selector reads.
//
// T0 = first sweep on a map where reader.tiles() is non-null (roster
// resolved). T1 = first sweep afterward where the roster holds a 'selector'
// entry (rewards readable). Logged for every map transition seen, not just
// the first -- this is meant to run across a whole play session.
//
// Once a roster resolves with zero rewards, it tracks the miss streak length
// and reports each reward-less sweep until selectors become readable.
//
// RECONNECTS ACROSS GAME RESTARTS. Rare bugs mean long unattended sessions;
// exiting when the process dies would silently stop watching after the
// first crash/relaunch. Instead this closes the dead reader and polls for
// the process to reappear, logging a clear session boundary either way.
//
// MANUAL FLAGS. Typing a line into this process's stdin and pressing enter
// timestamps it into the log verbatim -- use it to mark "icons missing here"
// the moment it's noticed in game, so the log has a human anchor to check
// the automatic verdict against.

const fs = require('fs');
const { Reader } = require('../reader');
const { findPid } = require('../win32');
const { CURRENT_MAP_ID, PROCESS_NAME } = require('../state');

const POLL_MS = 250;
const RECONNECT_POLL_MS = 2000;
const out = process.argv[2] || null;
const t0 = Date.now();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function say(line) {
  const t = ((Date.now() - t0) / 1000).toFixed(1).padStart(7);
  const s = `[${t}s] ${line}`;
  console.log(s);
  if (out) { try { fs.appendFileSync(out, s + '\n'); } catch {} }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (line.trim()) say(`FLAG: ${line.trim()}`);
  }
});

async function watchOneSession(reader) {
  say(`attached pid ${reader.pid} base 0x${reader.base.toString(16).toUpperCase()}`);

  let lastMapId = null;
  let lastSweeps = -1;
  let rosterSweep = null;   // sweep number at T0 for the current map
  let rosterAt = null;      // Date.now() at T0
  let rewardSweep = null;   // sweep number at T1 for the current map
  let rewardMisses = 0;     // count of reward-less sweeps since T0

  for (;;) {
    if (!reader.alive()) { say('game process exited'); return; }
    if (reader.fatal) { say(`fatal: ${reader.fatal}`); return; }

    const id = reader.get(CURRENT_MAP_ID);
    if (id !== lastMapId) {
      say(`MAP ID ${lastMapId} -> ${id}`);
      lastMapId = id;
      rosterSweep = null;
      rosterAt = null;
      rewardSweep = null;
      rewardMisses = 0;
    }

    if (reader.sweeps !== lastSweeps) {
      lastSweeps = reader.sweeps;
      const roster = reader.tiles();

      if (roster !== null && rosterSweep === null) {
        rosterSweep = reader.sweeps;
        rosterAt = Date.now();
        say(`T0 roster resolved: sweep ${rosterSweep}, ${roster.length} item(s), 0 reward(s) so far`);
      }

      if (roster !== null && rosterSweep !== null && rewardSweep === null) {
        const rewards = roster.filter(t => t.source === 'selector').length;
        if (rewards > 0) {
          rewardSweep = reader.sweeps;
          const gapSweeps = rewardSweep - rosterSweep;
          const gapMs = Date.now() - rosterAt;
          say(`T1 rewards readable: sweep ${rewardSweep}, ${rewards} selector(s) -- `
            + `gap from T0: ${gapSweeps} sweep(s), ${(gapMs / 1000).toFixed(1)}s`);
        } else {
          rewardMisses += 1;
          say(`   still no rewards: ${rewardMisses} reward-less sweep(s) since T0`);
        }
      }
    }

    await sleep(POLL_MS);
  }
}

async function main() {
  say(`watching for ${PROCESS_NAME}...`);
  for (;;) {
    let pid;
    try {
      pid = findPid(PROCESS_NAME);
    } catch {
      await sleep(RECONNECT_POLL_MS);
      continue;
    }
    const reader = new Reader(pid);
    await watchOneSession(reader);
    reader.close();
    say('waiting for game to relaunch...');
    await sleep(RECONNECT_POLL_MS);
  }
}

main();
