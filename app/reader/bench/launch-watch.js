'use strict';
// Watch the game from BEFORE it launches, through to mid-run.
//
//   node app/reader/bench/launch-watch.js [outfile.jsonl] [--pid=N] [--diagnostics]
//
// --diagnostics adds timestamped worker messages, raw rosters/bindings and
// one targeted RTTI/static-anchor check at attachment. It does not add heap
// discovery scans or change the shipped reader. Default output in this mode
// is a fresh build/compatibility-<UTC timestamp>.jsonl file.
//
// Start it first, then launch Ravenswatch. It waits for the process to
// appear, attaches, and records what every channel says at each stage of
// coming up: the process existing, the module list populating, the sweep
// resolving names one by one, the menu, a run loading, a run underway.
//
// WHAT IT IS FOR. The four stages are indistinguishable from the readout
// alone -- an unresolved channel and a channel that resolved to nothing both
// render as a placeholder, and `ready` collapses every channel into one bit
// on purpose. This writes the uncollapsed version to a file so the
// differences between the stages can be read off afterwards rather than
// guessed at from the window.
//
// PHASE LABELS ARE ANNOTATIONS, NOT A FILTER. Every record carries the full
// raw reading regardless of what `phase` says. The labelling rules in
// classify() are a hypothesis about where the boundaries fall; if the log
// shows them landing in the wrong place, the data underneath is still good
// and the rules are what get corrected.
//
// It attaches with the shipped Reader rather than a bespoke read path, so
// what lands in the file is what the app itself sees. Cost is low: the
// expensive placement sweep does not run while map id reads -1 (see
// reader/README.md), so the menu and the load stages add nothing, and a
// settled run performs none either. The region walk below is VirtualQuery
// only -- no reads -- and is sampled every couple of seconds rather than
// every poll.

const fs = require('fs');
const path = require('path');
const { Reader } = require('../reader');
const { readState, PROCESS_NAME, POLL_MS: APP_POLL_MS, SWEEP_INTERVAL } = require('../state');
const { findPids, moduleBase } = require('../win32');

const POLL_MS = 250;
const REGION_SAMPLE_MS = 2000;   // VirtualQuery walk: cheap, but not free
const HEARTBEAT_MS = 10000;      // so a quiet stretch is recorded as quiet
const PID_POLL_MS = 250;

// --pid=N skips the wait and attaches to a PID directly, the same escape
// hatch stdio.js has for when several copies are running. It also makes the
// attach-and-poll path testable without a game.
const argv = process.argv.slice(2);
const DIAGNOSTICS = argv.includes('--diagnostics');
const pidArg = argv.find(a => a.startsWith('--pid='));
const FORCED_PID = pidArg ? parseInt(pidArg.slice(6), 10) : null;
if (pidArg && (!Number.isInteger(FORCED_PID) || FORCED_PID <= 0)) {
  console.error(`not a PID: ${pidArg.slice(6)}`);
  process.exit(1);
}
const out = path.resolve(argv.find(a => !a.startsWith('--')) || (DIAGNOSTICS
  ? path.join(__dirname, '../../..', 'build', `compatibility-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`)
  : 'launch-watch.jsonl'));
fs.mkdirSync(path.dirname(out), { recursive: true });
const t0 = Date.now();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const since = (t) => (t === null ? null : +((Date.now() - t) / 1000).toFixed(2));

let tPid = null;      // when the process first appeared
let tAttach = null;   // when we got a handle and a module base

/** One record: JSON to the file, one compact line to the console. */
function emit(rec, note) {
  rec.utc = new Date().toISOString();
  rec.t = since(t0);
  rec.t_pid = since(tPid);
  rec.t_attach = since(tAttach);
  // A recording failure must stop visibly rather than pretending to watch.
  fs.appendFileSync(out, JSON.stringify(rec) + '\n');
  const stamp = String(rec.t).padStart(8);
  console.log(`[${stamp}s] ${String(rec.phase).padEnd(12)} ${note}`);
}

/** Retain every worker boundary, including diagnostics Reader otherwise overwrites. */
function observeWorkers(reader) {
  for (const [channel, worker] of [
    ['sweep', reader.worker], ['sandman', reader.sandmanWorker], ['tiles', reader.tilesWorker],
  ]) {
    worker.on('message', message => emit({ phase: 'worker', pid: reader.pid, channel, message },
      `${channel}: ${message.type}${message.message ? `: ${message.message}` : ''}`));
    worker.on('error', error => emit({ phase: 'worker-error', pid: reader.pid, channel,
      error: error.stack || String(error) }, `${channel}: ${error.message}`));
    worker.on('exit', code => emit({ phase: 'worker-exit', pid: reader.pid, channel, code },
      `${channel}: exit ${code}`));
  }
}

/** Module reads only; a reachable class does not prove its instances/layout. */
function recordAnchors(reader, mod) {
  const rtti = require('../rtti');
  const tiles = require('../tiles');
  const values = require('../values');
  const names = {
    ...rtti.RTTI_NAMES,
    heroController: '.?AVoCDtEntityCpntHeroController@@\0',
    melody: '.?AVMelodyEntityCpnt@dt@oe@@\0',
    sandmanController: '.?AVoCDtEntityCpntSandmanMenuUiController@@\0',
    tileSpawner: tiles.SPAWNER_RTTI,
    rewardSelector: tiles.SELECTOR_RTTI,
    gameScene: tiles.GAME_SCENE_RTTI,
    game: tiles.GAME_RTTI,
  };
  const classes = {};
  for (const [name, mangled] of Object.entries(names)) {
    try { classes[name] = { rvas: rtti.resolveAllVtableRvas(reader.proc, reader.base, mangled) }; }
    catch (e) { classes[name] = { error: String(e.message || e) }; }
  }
  const roots = {};
  for (const [name, rva] of [['scene', tiles.GAME_SCENE_STATIC_RVA], ['game', tiles.GAME_STATIC_RVA]]) {
    try {
      const addr = reader.proc.readPtr(reader.base + rva);
      const vt = addr ? reader.proc.readPtr(addr) : null;
      roots[name] = { rva, addr, vtable: vt,
        class: rtti.classOfVtable(reader.proc, reader.base, mod.size, vt) };
    } catch (e) { roots[name] = { rva, error: String(e.message || e) }; }
  }
  emit({ phase: 'anchors', pid: reader.pid, exe_path: reader.exePath,
    binding_vtable_rva: values.BINDING_VTABLE_RVA, classes, roots },
  `RTTI ${Object.values(classes).filter(c => c.rvas && c.rvas.length).length}/${Object.keys(classes).length}; static anchors recorded`);
}

/**
 * The stage this reading looks like. Ordered most-specific-last: each test
 * assumes the ones above it already failed.
 *
 * `ready` is the discriminator between loading a run and being in one. It is
 * the reader's own verdict that every channel has answered, which is exactly
 * the distinction a load blurs -- map id arrives well before placement does.
 */
function classify(s, found) {
  if (tPid === null) return 'pre-launch';
  if (tAttach === null) return 'pid-only';
  if (found === 0) return 'initial-load';
  if (s.map_id === null || s.map_id < 0) return 'menu';
  return s.ready ? 'mid-run' : 'game-load';
}

/** Total committed writable bytes -- load progress the contract does not expose. */
function writableFootprint(proc) {
  let bytes = 0, count = 0;
  try {
    for (const [, size] of proc.regions(true)) { bytes += size; count++; }
  } catch {
    return null;
  }
  return { bytes, regions: count };
}

/** Waits for exactly one copy of the game, however long that takes. */
async function waitForPid() {
  if (FORCED_PID !== null) {
    tPid = Date.now();
    emit({ phase: 'pid-only', pid: FORCED_PID, forced: true }, `attaching to pid ${FORCED_PID} (--pid)`);
    return FORCED_PID;
  }
  let saidWaiting = false, saidMany = null, saidSnapErr = null;
  for (;;) {
    let pids = [];
    try {
      pids = findPids(PROCESS_NAME);
    } catch (e) {
      // Not swallowed: a snapshot that cannot be taken looks exactly like a
      // game that has not started, and this would otherwise wait forever
      // while reporting that it was waiting normally.
      if (saidSnapErr !== String(e.message || e)) {
        saidSnapErr = String(e.message || e);
        emit({ phase: 'pre-launch', error: saidSnapErr },
          `cannot enumerate processes: ${saidSnapErr}`);
      }
    }
    if (pids.length === 1) {
      tPid = Date.now();
      emit({ phase: 'pid-only', pid: pids[0] }, `${PROCESS_NAME} appeared, pid ${pids[0]}`);
      return pids[0];
    }
    if (pids.length > 1 && saidMany !== pids.length) {
      // Same refusal findPid() makes: guessing which copy is wrong more
      // often than it is convenient.
      saidMany = pids.length;
      emit({ phase: 'pre-launch', pids }, `${pids.length} copies running (${pids.join(', ')}) -- waiting for one`);
    }
    if (!saidWaiting) {
      saidWaiting = true;
      emit({ phase: 'pre-launch' }, `waiting for ${PROCESS_NAME} to start`);
    }
    await sleep(PID_POLL_MS);
  }
}

/**
 * The module list is not populated the instant the process exists, so this
 * retries. The length of the gap is the first thing worth measuring: it is
 * dead time in which the app can see a PID and nothing else.
 */
async function waitForModule(pid) {
  let tries = 0;
  for (;;) {
    tries++;
    try {
      const mod = moduleBase(pid);
      if (mod && mod.base) return { mod, tries };
    } catch {}
    await sleep(POLL_MS);
  }
}

/** Polls one attached process until it exits. */
async function watch(reader) {
  let lastSig = null;
  let lastEmit = 0;
  let lastRegionSample = 0;
  let footprint = null;

  for (;;) {
    if (!reader.alive()) {
      emit({ phase: 'exited', pid: reader.pid }, `${PROCESS_NAME} exited -- waiting for it to start again`);
      return;
    }

    const now = Date.now();
    if (now - lastRegionSample >= REGION_SAMPLE_MS) {
      lastRegionSample = now;
      footprint = writableFootprint(reader.proc);
    }

    let state, err = null;
    try {
      state = readState(reader, {
        runtime: {
          sweeps: reader.sweeps, found: reader.found(),
          pid: reader.pid, base: reader.base,
          install_dir: path.dirname(reader.exePath),
          placement_misses: reader.placementMisses,
        },
      });
    } catch (e) {
      err = String(e.message || e);
      state = {};
    }
    // stdio.js appends these two before the frame goes out, so a record here
    // is the same frame object the app's own consumer parses, not a subset.
    state.poll_ms = APP_POLL_MS;
    state.sweep_interval = SWEEP_INTERVAL;

    const placement = reader.placement();
    const rec = {
      phase: classify(state, reader.found()),
      state,
      // Internals the frame contract folds away. Which names have resolved
      // is the difference between "the sweep has not found this yet" and
      // "the game has not written it yet", which the contract renders alike.
      resolved: Object.keys(reader.resolved).sort(),
      sweeps: reader.sweeps,
      last_sweep_ms: reader.lastSweepMs === undefined ? null : reader.lastSweepMs,
      binding_vt_ready: reader.bindingVtReady,
      placement: placement === null ? null
        : { map_id: placement.mapId, placed: placement.placed.length },
      writable: footprint,
      fatal: reader.fatal,
      diagnostic: reader.diagnostic,
      error: err,
      ...(DIAGNOSTICS ? {
        bindings: reader.resolved,
        map_names: reader.maps(),
        placement_raw: placement,
        placement_misses: reader.placementMisses,
        tiles_raw: reader.tiles(),
        sandman_raw: reader.sandman(),
        sandman_status: reader.sandman_status(),
      } : {}),
    };

    // Emit on change, plus a heartbeat, so a long quiet stretch is recorded
    // as having been quiet rather than as a hole in the file.
    const sig = JSON.stringify(rec);
    const heartbeat = now - lastEmit >= HEARTBEAT_MS;
    if (sig !== lastSig || heartbeat) {
      if (sig === lastSig) rec.heartbeat = true;
      const bits = [
        `map=${state.map_id}${state.map_name ? `(${state.map_name})` : ''}`,
        `lvl=${state.level}`,
        `ready=${state.ready}`,
        `found=${state.found}/${state.tracked}`,
        `melody=${state.melody_status}`,
        `quest=${state.quest_key}`,
        `shop=${reader.sandman_status()}`,
        `tiles=${reader.tiles() === null ? '?' : reader.tiles().length}`,
        `sweeps=${reader.sweeps}`,
        footprint ? `wr=${(footprint.bytes / 1048576).toFixed(0)}MB` : 'wr=?',
      ];
      emit(rec, bits.join(' ') + (rec.heartbeat ? ' (idle)' : ''));
      lastSig = sig;
      lastEmit = now;
    }

    await sleep(POLL_MS);
  }
}

(async () => {
  console.log(`writing ${out}`);
  emit({ phase: 'started', diagnostics: DIAGNOSTICS, output: out,
    node_version: process.version }, 'logger started');
  process.on('SIGINT', () => { emit({ phase: 'stopped' }, 'STOP'); process.exit(0); });

  // Outer loop: a game that closes and reopens is captured in the same file,
  // with the pre-launch wait running again rather than the watcher ending.
  for (;;) {
    const pid = await waitForPid();
    const { mod, tries } = await waitForModule(pid);
    tAttach = Date.now();

    let reader;
    try {
      reader = new Reader(pid);
    } catch (e) {
      emit({ phase: 'pid-only', pid, error: String(e.message || e) }, `attach failed: ${e.message || e}`);
      tPid = null; tAttach = null;
      await sleep(1000);
      continue;
    }

    emit({ phase: 'attached', pid, base: mod.base, module_size: mod.size, module_tries: tries },
      `attached, base 0x${mod.base.toString(16).toUpperCase()} `
      + `(module list took ${tries} ${tries === 1 ? 'try' : 'tries'})`);

    if (DIAGNOSTICS) {
      observeWorkers(reader);
      recordAnchors(reader, mod);
    }

    await watch(reader);
    try { reader.close(); } catch {}
    // An explicit --pid names one process, so its exit ends the watch. Only
    // the discovery path loops back round to wait for the next launch.
    if (FORCED_PID !== null) process.exit(0);
    tPid = null;
    tAttach = null;
  }
})().catch(error => {
  console.error(error.stack || String(error));
  process.exit(1);
});
