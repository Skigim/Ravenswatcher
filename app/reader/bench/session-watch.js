'use strict';
// Which GlobalValues move when the game enters and leaves a co-op lobby?
//
//   node app/reader/bench/session-watch.js [outfile]
//
// Start it at the main menu, then walk the game through: host a lobby, have a
// second player join, start a run, leave. It prints every change to the
// session-shaped values with a timestamp, so the state each one tracks is
// read off the log rather than inferred from the name.
//
// The index is held between polls instead of rebuilt (buildIndex is ~800 ms,
// resolve is three reads). readBinding reports `stale-binding` when the bound
// object has been freed under us, and that is the trigger for one rebuild.

const fs = require('fs');
const { openProcess, findPid, moduleBase } = require('../win32');
const values = require('../values');
const { PROCESS_NAME, CURRENT_MAP_ID } = require('../state');

const WATCH = [
  CURRENT_MAP_ID,
  'Game Session Size',
  'Is Connected to Session',
  'Is Session Host',
  'AutoJoinLobby',
  'Hide party code',
  'EOS Multithread',
];

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

const pid = findPid(PROCESS_NAME);
if (!pid) {
  console.error(`${PROCESS_NAME} is not running.`);
  process.exit(1);
}
const mod = moduleBase(pid);
const proc = openProcess(pid);
say(`attached pid ${pid} base 0x${mod.base.toString(16).toUpperCase()}`);

function build() {
  const t = process.hrtime.bigint();
  const idx = values.buildIndex(proc, mod.base);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  say(idx
    ? `index: ${idx.names.size} live, ${idx.bindings.size} bound, ${ms.toFixed(0)} ms`
    : `index: null (no settings vtable resolved)`);
  return idx;
}

function snapshot(idx) {
  const row = {};
  let stale = false;
  for (const name of WATCH) {
    const r = idx.resolve(name);
    if (r.status === 'stale-binding') stale = true;
    row[name] = r.status === 'ok' ? r.value : `<${r.status}>`;
  }
  return { row, stale };
}

process.on('SIGINT', () => {
  say('STOP');
  try { proc.close(); } catch {}
  process.exit(0);
});

(async () => {
  let idx = build();
  let last = null;
  for (;;) {
    if (!idx) { await sleep(2000); idx = build(); continue; }
    const { row, stale } = snapshot(idx);
    if (stale) {
      say('stale binding -- rebuilding index');
      idx = build();
      continue;
    }
    if (last === null) {
      say('baseline ' + WATCH.map(n => `${n}=${row[n]}`).join('  '));
    } else {
      const moved = WATCH.filter(n => row[n] !== last[n]);
      if (moved.length) {
        say(moved.map(n => `${n} ${last[n]} -> ${row[n]}`).join('   '));
      }
    }
    last = row;
    await sleep(POLL_MS);
  }
})();
