'use strict';
// Do the tracked bindings keep their addresses across a map change and a run
// restart?
//
//   node app/reader/bench/binding-stability.js [outfile] [--events-only]
//
// --events-only drops the 15 s periodic rebuild and scans only on map id,
// Hero Level and run-end events. Each rebuild is ~2 s of one core and the
// periodic ones showed up as in-game CPU spikes (2026-09-18); the map-change
// question only needs the rebuild at the transition.
//
// This is the instrument behind sweeper.js's indexRebuildDue. The 2026-09-15
// session that justified holding the values index across sweeps observed
// two level-ups and a full run's value churn on one map. It did NOT observe
// a map change within a run, or a run restart for any name beyond Hero Level
// and Current map id. Those two events are what this script exists to sit
// through: start it in a run, play through to the next map, then quit to the
// menu and start another run.
//
// What it does. One values.buildIndex() at attach records the settings and
// binding address of every TRACKED_NAMES entry and every "<Map> map id"
// constant -- the baseline. From then on it reads every value directly off
// the baseline binding every 250 ms, and every 15 s builds a fresh index and
// diffs its addresses against the baseline. It prints a checkpoint table on
// every map id change, every Hero Level change, every map id -1 (run end),
// on every rebuild that finds a moved address, and at exit.
//
// It calls buildIndex() itself and never goes through the sweeper. A probe
// routed through the code under test would only report what that code
// believes; this compares the held addresses against an independent scan.
//
// Reads only. It opens its own read handle and writes nothing to the game.

const fs = require('fs');
const { openProcess, findPid, moduleBase } = require('../win32');
const { PROCESS_NAME, TRACKED_NAMES, CURRENT_MAP_ID, MAP_ID_SUFFIX } = require('../state');
const values = require('../values');
const rtti = require('../rtti');

const POLL_MS = 250;
const REBUILD_MS = 15000;
const HERO_LEVEL = 'Hero Level';

const args = process.argv.slice(2);
const eventsOnly = args.includes('--events-only');
const out = args.find(a => !a.startsWith('--')) || null;
const t0 = Date.now();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const hex = (n) => (n === null || n === undefined) ? '-' : '0x' + n.toString(16).toUpperCase();

function say(line) {
  const t = ((Date.now() - t0) / 1000).toFixed(2).padStart(8);
  const s = `[${t}s] ${line}`;
  console.log(s);
  if (out) { try { fs.appendFileSync(out, s + '\n'); } catch {} }
}

/** name -> { settings, binding } for every name this script watches. */
function snapshot(index) {
  const rows = new Map();
  const names = [...TRACKED_NAMES];
  for (const n of index.names.keys()) {
    if (n.endsWith(MAP_ID_SUFFIX) && !names.includes(n)) names.push(n);
  }
  for (const name of names) {
    const settings = index.names.get(name);
    const binding = settings !== undefined ? index.bindings.get(settings) : undefined;
    rows.set(name, {
      settings: settings === undefined ? null : settings,
      binding: binding === undefined ? null : binding,
    });
  }
  return rows;
}

/** Print baseline vs current for every watched name; returns the moved count. */
function checkpoint(label, baseline, current) {
  say(`--- checkpoint: ${label}`);
  let moved = 0;
  for (const [name, b] of baseline) {
    const c = current.get(name) || { settings: null, binding: null };
    const same = c.settings === b.settings && c.binding === b.binding;
    if (!same) moved += 1;
    say(`  ${same ? 'same ' : 'MOVED'}  ${name.padEnd(40)} binding ${hex(b.binding).padEnd(14)} -> ${hex(c.binding).padEnd(14)}`
      + `  settings ${hex(b.settings)} -> ${hex(c.settings)}`);
  }
  say(`  ${moved} of ${baseline.size} moved`);
  return moved;
}

(async () => {
  let pid;
  try { pid = findPid(PROCESS_NAME); }
  catch (e) { console.error(e.message); process.exit(e.code === 'ENOGAME' ? 2 : 1); }
  const base = moduleBase(pid).base;
  const proc = openProcess(pid);
  say(`attached pid ${pid} base ${hex(base)}`);

  const rvas = rtti.resolveVtableRvas(proc, base);
  const settingsVt = rvas.oCGlobalEntityValueSettings != null ? base + rvas.oCGlobalEntityValueSettings : null;
  const unionVt = rvas.oCEntityValueUnion != null ? base + rvas.oCEntityValueUnion : null;
  if (settingsVt === null || unionVt === null) {
    say('could not resolve the RTTI vtables; is this the right build?');
    proc.close();
    process.exit(1);
  }
  const bindingVt = base + values.BINDING_VTABLE_RVA;

  function build() {
    const t = Date.now();
    const index = values.buildIndex(proc, base, settingsVt, unionVt, bindingVt);
    return { index, ms: Date.now() - t };
  }

  let { index, ms } = build();
  if (index === null) { say('buildIndex returned null'); proc.close(); process.exit(1); }
  let baseline = snapshot(index);
  const bound = [...baseline.values()].filter(r => r.binding !== null).length;
  say(`baseline: ${baseline.size} names, ${bound} bound, build ${ms} ms`);
  if (bound === 0) {
    say('nothing is bound yet -- start this inside a run. Polling until something binds.');
  }
  checkpoint('baseline', baseline, baseline);

  // Direct read off the baseline binding, the way the held index reads.
  function readDirect(name) {
    const r = baseline.get(name);
    if (!r || r.binding === null) return null;
    const res = values.readBinding(proc, name, r.settings, r.binding, unionVt);
    return res.status === 'ok' ? res.value : `stale(${res.value})`;
  }

  let lastMapId = null;
  let lastLevel = null;
  let lastRebuild = Date.now();
  let totalMoved = 0;
  let rebuilds = 0;

  // `rebuild` is false once the process is gone: a scan of a dead handle
  // finds nothing and would print every row as moved.
  function stop(reason, rebuild) {
    say(`STOP: ${reason}`);
    if (rebuild) {
      const { index: fresh } = build();
      if (fresh) totalMoved += checkpoint('exit', baseline, snapshot(fresh));
    }
    say(`${rebuilds} rebuilds, ${totalMoved} moved rows in total`);
    try { proc.close(); } catch {}
    process.exit(0);
  }
  process.on('SIGINT', () => stop('SIGINT', true));

  for (;;) {
    if (!proc.isAlive()) {
      say('game process exited');
      break;
    }

    const mapId = readDirect(CURRENT_MAP_ID);
    const level = readDirect(HERO_LEVEL);
    let event = null;
    if (mapId !== lastMapId) {
      event = mapId === -1 ? `run end (map id ${lastMapId} -> -1)` : `map id ${lastMapId} -> ${mapId}`;
    } else if (level !== lastLevel) {
      event = `Hero Level ${lastLevel} -> ${level}`;
    }
    lastMapId = mapId;
    lastLevel = level;

    const due = event !== null || (!eventsOnly && (Date.now() - lastRebuild) >= REBUILD_MS);
    if (due) {
      const built = build();
      rebuilds += 1;
      lastRebuild = Date.now();
      if (built.index === null) {
        say(`rebuild returned null (${built.ms} ms)`);
      } else {
        const current = snapshot(built.index);
        if (bound === 0 && [...current.values()].some(r => r.binding !== null)
            && [...baseline.values()].every(r => r.binding === null)) {
          // Attached before anything was bound: adopt the first bound scan
          // as the baseline rather than reporting every name as moved.
          baseline = current;
          say(`baseline adopted from rebuild (${built.ms} ms)`);
          checkpoint('baseline', baseline, baseline);
        } else {
          const anyMoved = [...baseline].some(([n, b]) => {
            const c = current.get(n) || { settings: null, binding: null };
            return c.settings !== b.settings || c.binding !== b.binding;
          });
          if (event !== null || anyMoved) {
            totalMoved += checkpoint(`${event || 'periodic rebuild'} (build ${built.ms} ms)`, baseline, current);
          } else {
            say(`rebuild ${rebuilds}: all ${baseline.size} addresses unchanged (${built.ms} ms)`
              + `  map ${mapId} level ${level}`);
          }
        }
      }
    }

    await sleep(POLL_MS);
  }
  stop('process gone', false);
})();
