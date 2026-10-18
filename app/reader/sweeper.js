'use strict';
// The discovery sweep, on a worker thread.
//
// A worker and not an async function: the scan is plain synchronous JS, so a
// sweep on the main thread would block the event loop for its whole length
// and swallow the 250 ms poll frames behind it.
//
// The worker opens its own read-only handle to the same PID rather than
// sharing the main thread's.
//
// It posts back addresses, never values. Polling those addresses stays on the
// main thread so a frame is never one sweep-interval stale.

const { parentPort, workerData, isMainThread } = require('worker_threads');
const { openProcess } = require('./win32');
const { WorkerControl } = require('./worker-control');
const rtti = require('./rtti');
const values = require('./values');
const placement = require('./placement');
const melodies = require('./melodies');
const { TRACKED_NAMES, CURRENT_MAP_ID, MAP_ID_SUFFIX, SWEEP_INTERVAL,
  MARKER_PATHS, QUEST_MARKERS, ELIMINATION_BY_MAP,
  nextPlacement, placementDue, questFromPlacement } = require('./state');

function fail(message) {
  if (parentPort) {
    parentPort.postMessage({ type: 'fatal', message });
  }
}

// How often the hero cache is forced cold, in sweeps.
//
// Measured 2026-08-31 against a live single-player run: a cold findHeroes
// costs 583/654/683 ms and full melody resolution 1316.8 ms, against a 5 s
// sweep. Rescanning every sweep is 12-14% of the interval and doubles the
// melody channel's cost for a case single-player cannot produce; every fourth
// sweep is a quarter of that and still notices a joining second player inside
// one map segment. The controller set also grows as runs accumulate, so this
// is a floor on a fresh process, not a fixed cost.
const HERO_RESCAN_SWEEPS = 4;

/** Whether this sweep forces findHeroes to ignore the cache and scan. */
function heroRescanDue(sweeps) {
  return (sweeps % HERO_RESCAN_SWEEPS) === 0;
}

/**
 * Which hero source the `!pool` fallback should try, or null for none.
 *
 * The rule is "never the source the first attempt already used". Repeating a
 * cold scan costs a second full heap pass for a result that cannot differ;
 * repeating the cache is equally pointless. Without a cache the first attempt
 * was already a scan, so there is no second source left to try.
 *
 * @returns {'cache'|'scan'|null}
 */
function fallbackHeroSource(rescanDue, hadCache) {
  if (!hadCache) return null;
  return rescanDue ? 'cache' : 'scan';
}

// Three sweeps, not one. A single empty read is normal while the game is still
// loading; three consecutive ones (15 s) is a channel that is not going to
// answer. resolveRegistry throwing leaves melodyRegistry null and the loop
// retries it every sweep, so without this the readiness gate in state.ts would
// wait on melodies forever and the app would sit on "Loading run" saying
// nothing about why.
const MELODY_FAIL_SWEEPS = 3;

// The payload the next frame should carry. Held across a sweep that resolved
// nothing: the reader payload returns before the loading screen clears and the
// player regains control, so melodies cannot have changed across the gap.
// Melodies are per hero and survive map changes within a run, so only the run
// ending clears -- map id -1 is the game's own "no map" reading, and map ids
// start at 0, so this compares the value and never truthiness.
function nextMelodies(prev, mapId, incoming, isRunReset = false) {
  if (mapId === -1 || isRunReset) return null;
  return incoming !== null ? incoming : prev;
}

// 'pending' -> nothing has resolved yet. 'ok' -> a payload landed, and latches,
// because a channel that worked once is not a broken channel. 'failed' -> it
// has missed MELODY_FAIL_SWEEPS in a row without ever working.
function nextMelodyStatus(prev, resolved, consecutiveMisses) {
  if (resolved || prev === 'ok') return 'ok';
  return consecutiveMisses >= MELODY_FAIL_SWEEPS ? 'failed' : 'pending';
}

/**
 * Consecutive real scans that searched for an ELIMINATION_BY_MAP confirmed
 * marker and did not find it, for the current map generation.
 *
 * `placedNow === null` means the scan did not run at all this sweep (entity
 * RTTI still unresolved) -- that is not evidence, so the counter holds rather
 * than advancing. `elimRule === undefined` means this map has no elimination
 * pair at all, so it always reads 0. Seeing the confirmed marker resets to 0,
 * the same way finding a payload resets melodyMisses -- a channel that
 * answers once should not need to answer again to stay trusted for this
 * generation.
 */
function nextPlacementMisses(elimRule, placedNow, prevMisses) {
  if (!elimRule || !placedNow) return prevMisses;
  const confirmedHit = QUEST_MARKERS[elimRule.confirmed].some(p => placedNow.has(p));
  return confirmedHit ? 0 : prevMisses + 1;
}

/**
 * Extract and accumulate map id -> name mappings from a value index.
 *
 * Each "<Map name> map id" is a static id constant; resolve them on every
 * sweep and merge into the accumulated table. A partial table resolved
 * early (at the menu or mid-load) must not freeze for the whole session.
 *
 * @param {Object|null} prev Previous accumulated map table, or null
 * @param {Object|null} index ValueIndex instance with .names and .resolve()
 * @returns {Object|null} Accumulated table, or null if no map id has ever resolved
 */
function mergeMapNames(prev, index) {
  if (!index || !index.names) return prev;
  const m = {};
  for (const name of index.names.keys()) {
    if (!name.endsWith(MAP_ID_SUFFIX) || name === CURRENT_MAP_ID) continue;
    const r = index.resolve(name);
    if (r.status === 'ok' && r.value !== null) {
      m[r.value] = name.slice(0, -MAP_ID_SUFFIX.length);
    }
  }
  if (Object.keys(m).length === 0) return prev;
  return Object.assign(prev || {}, m);
}

/**
 * Whether the sweep pays for another buildIndex() this pass.
 *
 * Measured with bench/binding-stability.js: every TRACKED_NAMES binding
 * and settings address, plus every "<Map> map id" constant, held one
 * address for the life of the game process. 2026-09-15, one Dark Hills
 * run: two level-ups, 25+ combat toggles, a Sandman visit and shard
 * spending, 35+ full rebuilds. 2026-09-18, one process for 68 min: a
 * Dark Hills -> Storm Island transition (map id 0 -> 1), three run
 * restarts, eleven level-ups, 24 rebuilds, 0 of 13 moved at every
 * checkpoint. Names for maps not yet loaded (Mordred, Tree, Roc, Cyclop
 * steps, every map id) were already bound on Dark Hills. At process exit
 * the union vtable slot on every binding stopped matching ~2 s before the
 * handle closed.
 *
 * So four signals, not one:
 *
 * 1. No index yet.
 * 2. Any tracked name did not resolve `ok`. `stale-binding` is the union
 *    vtable slot no longer matching, which catches a freed-and-reused
 *    binding and process teardown. A binding not found at all is the main
 *    menu, where this rebuilds every sweep.
 * 3. The map changed.  4. The run reset (Hero Level dropped).
 *
 * 3 and 4 are a belt: nothing has moved on either event. They stay because
 * a binding that is freed but not reused keeps its old vtable pointer, so
 * signal 2 alone would read it as live and hand back a frozen value. Both
 * are things the sweep already detects off the two names with the
 * strongest evidence, and they cost a build per map transition, a few per
 * run, instead of one per sweep.
 *
 * @param {boolean} hasIndex
 * @param {string[]} statuses One Resolution status per TRACKED_NAMES entry
 * @param {boolean} mapChanged
 * @param {boolean} runReset
 */
function indexRebuildDue(hasIndex, statuses, mapChanged, runReset) {
  if (!hasIndex || mapChanged || runReset) return true;
  return statuses.some(s => s !== 'ok');
}

/**
 * Resolve every tracked name off `index`: the addresses the main thread
 * polls, and the status per name that indexRebuildDue decides on.
 */
function resolveTracked(index) {
  const found = {};
  const statuses = [];
  if (index === null) return { found, statuses };
  const types = values.valueTypes();
  for (const name of TRACKED_NAMES) {
    const r = index.resolve(name);
    statuses.push(r.status);
    if (r.status !== 'ok') continue;
    found[name] = {
      binding_addr: parseInt(r.binding_addr, 16),
      variant: r.variant,
      is_float: types[name] === values.TYPE_FLOAT,
    };
  }
  return { found, statuses };
}

async function main(pid, base) {
  const proc = openProcess(pid);
  const control = new WorkerControl(parentPort);
  if (parentPort) parentPort.unref();
  try {

  const rvas = rtti.resolveVtableRvas(proc, base);
  const settingsVt = rvas.oCGlobalEntityValueSettings != null
    ? base + rvas.oCGlobalEntityValueSettings : null;
  const unionVt = rvas.oCEntityValueUnion != null ? base + rvas.oCEntityValueUnion : null;
  if (settingsVt === null || unionVt === null) {
    return fail('could not resolve RTTI vtables -- is the PID correct and the process still running?');
  }

  // BINDING_VTABLE_RVA is a constant measured against one game build, so this
  // is a plain sum and not a search. When a patch moves the vtable, the
  // empty-index diagnostic below says which constant went stale and how to
  // regenerate it.
  const bindingVt = base + values.BINDING_VTABLE_RVA;
  parentPort.postMessage({ type: 'binding_vt', ready: true });

  const placementVtables = {};
  const melodyVtables = {};
  let index = null;           // the held ValueIndex -- see indexRebuildDue
  let melodyRegistry = null;
  let cachedHeroes = null;
  let placed = null;          // {mapId, placed: string[]} once resolved
  let lastMapId = null;       // last resolved map id seen by the sweeper
  let lastHeroLevel = null;   // last resolved hero level seen by the sweeper
  let conclusive = false;     // whether current generation has a conclusive answer
  let placementMisses = 0;    // consecutive real scans that missed the confirmed
                               // ELIMINATION_BY_MAP marker for this generation
  let heldMelodies = null;    // last resolved payload, cleared when the run ends
  let melodyMisses = 0;       // consecutive sweeps that resolved no payload
  let melodyStatus = 'pending';
  let mapNames = null;
  let sweeps = 0;
  let emptySweeps = 0;      // consecutive sweeps that built an index but resolved nothing
  let staleReported = false;

  // A Windows process handle remains valid after the process terminates, so
  // reads return null and never throw. Without an explicit aliveness check the
  // worker would loop forever scanning a dead handle. The check runs at the top
  // of each pass, before the expensive index build; on a dead process the
  // worker posts 'gone' and breaks out to close its handle and exit. Reader
  // otherwise sends a cooperative stop message.
  while (!control.stopped) {
    if (!proc.isAlive()) {
      if (parentPort) parentPort.postMessage({ type: 'gone' });
      break;
    }

    // The index is built once and held across sweeps. A buildIndex() is a
    // full writable-heap scan, 1600-1935 ms live (peak 3385 ms, 5030 regions,
    // 1.7 GB, 2026-09-15); resolving a tracked name off a held index is three
    // reads. The signals that pay for another build are in indexRebuildDue,
    // and the rebuild is applied at the end of the sweep so `found` and the
    // map-change/run-reset detection on a rebuild sweep come from the index
    // built on that sweep.
    const t0 = Date.now();
    let builtThisSweep = false;
    if (index === null) {
      index = values.buildIndex(proc, base, settingsVt, unionVt, bindingVt);
      builtThisSweep = true;
    }
    let { found, statuses } = resolveTracked(index);
    mapNames = mergeMapNames(mapNames, index);

    // The worker reads Current map id directly rather than waiting for the
    // main thread to poll it -- placement is keyed on the map, and a map
    // change must re-run it on the same sweep that noticed.
    //
    // Tracking lastMapId separately from placed.mapId catches restarts onto the
    // same map (0 -> -1 -> 0) directly.
    let runReset = false;
    let mapChanged = false;
    if (index !== null) {
      const curLvl = index.resolve('Hero Level');
      const curLevel = (curLvl.status === 'ok' && curLvl.value !== null) ? curLvl.value : null;
      if (curLevel !== null) {
        if (lastHeroLevel !== null && curLevel < lastHeroLevel) {
          runReset = true;
          conclusive = false;
          placementMisses = 0;
          placed = null;
          // Re-arm the map-change path. A run restarted onto the map it was
          // already on leaves lastMapId reading that map, so `mapChanged` is
          // false and placement cleared on the line above is never read
          // again. Clearing this is what makes the new run's first sweep re-read,
          // and it is the same signal placement already restarts on.
          lastMapId = null;
        }
        lastHeroLevel = curLevel;
      }

      const cur = index.resolve(CURRENT_MAP_ID);
      const mapId = (cur.status === 'ok' && cur.value !== null) ? cur.value : null;
      if (mapId !== null) {
        mapChanged = lastMapId === null || mapId !== lastMapId;
        if (mapChanged) {
          lastMapId = mapId;
          conclusive = false;
          placementMisses = 0;
        }

        const mapName = (mapNames && mapNames[mapId] !== undefined)
          ? mapNames[mapId] : null;
        if (placementDue(mapName, conclusive)) {
          // `placedNow`, not `found` -- the loop above already binds `found` for
          // the resolved value addresses, and shadowing it here would be a trap
          // for the next reader.
          let placedNow = null;
          try { placedNow = placement.placedAmong(proc, base, MARKER_PATHS, placementVtables); }
          catch { placedNow = null; }
          if (placedNow && questFromPlacement(mapName, new Set(placedNow.keys())) !== null) {
            conclusive = true;
          }
          // Elimination miss-counting, independent of the pair test above --
          // see nextPlacementMisses for why a null scan doesn't advance it.
          placementMisses = nextPlacementMisses(
            ELIMINATION_BY_MAP[mapName], placedNow, placementMisses);
          placed = nextPlacement(placed, mapId, mapName, placedNow);
        }
      }
    }


    if (!builtThisSweep && indexRebuildDue(index !== null, statuses, mapChanged, runReset)) {
      index = values.buildIndex(proc, base, settingsVt, unionVt, bindingVt);
      ({ found, statuses } = resolveTracked(index));
      mapNames = mergeMapNames(mapNames, index);
    }

    // An index that builds but resolves nothing means the settings and union
    // vtables were found while BINDING_VTABLE_RVA was not -- which is exactly
    // what a game patch that moves the binding vtable looks like. Left alone it
    // presents as every value reading as a dash forever, with nothing saying
    // why. Say why instead, and name the step that fixes it.
    //
    // Three consecutive sweeps, not one: a single empty pass during a load
    // should not be reported.
    //
    // Reported, NOT fatal, and the wording hedges on purpose. Whether binding
    // objects exist before a run has started has never been measured, so an
    // empty index at the main menu may be the ordinary state rather than a
    // stale constant. Killing the sweep on an unmeasured heuristic would trade
    // a silent failure for a confident wrong one. If that reading is ever
    // taken and menus do carry bindings, this can become a fail().
    if (index !== null && Object.keys(found).length === 0) {
      emptySweeps += 1;
      if (emptySweeps === 3 && !staleReported) {
        staleReported = true;
        if (parentPort) {
          parentPort.postMessage({ type: 'diagnostic', message:
            `resolved 0 of ${TRACKED_NAMES.length} tracked values across three sweeps while `
            + `the RTTI vtables resolved. If this persists inside a run, `
            + `BINDING_VTABLE_RVA (0x${values.BINDING_VTABLE_RVA.toString(16).toUpperCase()}) `
            + `is stale for this game build -- re-run tools/discover_values.py against it.` });
        }
      }
    } else if (Object.keys(found).length > 0) {
      emptySweeps = 0;
      staleReported = false;
    }

    if (melodyRegistry === null) {
      try {
        const reg = melodies.resolveRegistry(proc, base, melodyVtables);
        if (reg) {
          melodyRegistry = reg.registry;
          if (reg.melodyCpntVt) melodyVtables.melodyCpntVt = reg.melodyCpntVt;
          if (reg.heroControllerVt) melodyVtables.heroControllerVt = reg.heroControllerVt;
        }
      } catch {
        melodyRegistry = null;
      }
    }

    let melodiesData = null;
    if (melodyRegistry !== null) {
      try {
        // Force a cold scan every HERO_RESCAN_SWEEPS sweeps. findHeroes
        // returns early whenever one cached address is still live, so a
        // controller allocated alongside a live cached one -- a second player
        // joining mid-run -- is invisible until the cached set goes cold.
        // Passing null is what makes it look.
        const rescanDue = heroRescanDue(sweeps);
        let heroes = melodies.findHeroes(
          proc, melodyVtables, rescanDue ? null : cachedHeroes);
        let pool = melodies.readPool(proc, melodyVtables, melodyRegistry, heroes);
        if (!pool) {
          // Try the source the line above did NOT use, never the same one
          // twice. On a rescan sweep `heroes` is already a cold scan, so
          // repeating it costs a second full heap pass (~650 ms) for a result
          // that cannot differ; the untried source there is the cache. On an
          // ordinary sweep the cache was used, so the untried source is a cold
          // scan -- and only when there was a cache at all, since without one
          // findHeroes already scanned.
          const hadCache = cachedHeroes !== null && cachedHeroes.length > 0;
          const source = fallbackHeroSource(rescanDue, hadCache);
          const alternative = source === 'cache' ? cachedHeroes
            : source === 'scan' ? melodies.findHeroes(proc, melodyVtables, null)
            : null;
          if (alternative && alternative.length > 0) {
            const altPool = melodies.readPool(
              proc, melodyVtables, melodyRegistry, alternative);
            // Adopt it only if it actually resolved. Taking it unconditionally
            // would let a cold scan that found a new controller but no pool be
            // thrown away in favour of the cache that missed the controller.
            if (altPool) {
              heroes = alternative;
              pool = altPool;
            }
          }
        }
        // A scan that comes back empty must not erase a working cache.
        if (heroes && heroes.length > 0) cachedHeroes = heroes;
        if (pool) {
          const states = melodies.readStates(
            proc, melodyVtables, pool, melodyRegistry, heroes);
          const progress = melodies.readProgress(proc, melodyVtables, pool, states, melodyRegistry, heroes);
          melodiesData = melodies.combineMelodies(pool, states, progress);
        }
      } catch {
        melodiesData = null;
      }
    }

    melodyMisses = melodiesData === null ? melodyMisses + 1 : 0;
    melodyStatus = nextMelodyStatus(melodyStatus, melodiesData !== null, melodyMisses);
    heldMelodies = nextMelodies(heldMelodies, lastMapId, melodiesData, runReset);

    sweeps += 1;
    parentPort.postMessage({
      type: 'sweep', found, mapNames, placement: placed, melodies: heldMelodies,
      melody_status: melodyStatus, sweeps,
      placement_misses: placementMisses,
      took_ms: Date.now() - t0,
      mapId: lastMapId,
      runReset,
    });
    await control.wait(SWEEP_INTERVAL * 1000);
  }
  } finally {
    control.dispose();
    proc.close();
  }
}

module.exports = { mergeMapNames, heroRescanDue, fallbackHeroSource,
  nextMelodies, nextMelodyStatus, indexRebuildDue, resolveTracked,
  HERO_RESCAN_SWEEPS, MELODY_FAIL_SWEEPS, nextPlacementMisses };

if (!isMainThread && workerData) {
  const { pid, base } = workerData;
  main(pid, base).catch(e => fail(String(e && e.message ? e.message : e)));
}
