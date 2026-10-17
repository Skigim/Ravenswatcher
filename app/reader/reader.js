'use strict';
// Attach, run the four workers, hand back a polling source.

const path = require('path');
const { Worker } = require('worker_threads');
const { openProcess, findPid, moduleBase } = require('./win32');
const { pollBinding } = require('./values');
const { PROCESS_NAME, SANDMAN_SHOP_GATE } = require('./state');
const { RUN_VALUE_NAMES } = require('./runs');

class Reader {
  constructor(pid) {
    if (pid === undefined || pid === null) pid = findPid(PROCESS_NAME);
    const mod = moduleBase(pid);
    this.pid = pid;
    this.base = mod.base;
    this.exePath = mod.exePath;
    this.proc = openProcess(pid);
    this.resolved = {};
    this.mapNames = {};
    this.placed = null;
    this.placementMisses = 0;
    this.melodiesData = null;
    this.melodyStatus = 'pending';
    this.sandmanData = null;
    this.sandmanStatus = 'pending';
    this.tilesRoster = null;
    // Finished runs not yet emitted. A queue, not a slot: two runs ending
    // inside one poll is not expected, but losing one would be silent.
    this.runSummaries = [];
    this._lastRelayedRunValues = null;
    this.sweeps = 0;
    this.bindingVtReady = false;
    this.fatal = null;
    this.diagnostic = null;
    this.closing = false;
    this._lastHeroLevel = null;
    this._lastRelayedGateAddr = null;
    this._lastRelayedMapId = null;
    // Assigned by the caller when it wants the Sandman channel to push rather
    // than wait for the next poll -- see stdio.js, which uses it to emit a
    // frame the moment an offer flips to sold instead of up to POLL_MS later.
    this.onSandmanChange = null;
    // The same, for a finished run: stdio.js emits it at once.
    this.onRunSummary = null;

    this.worker = this._spawn('sweeper.js', (m) => this._handleSweepMessage(m));
    this.sandmanWorker = this._spawn('sandman-worker.js', (m) => this._handleSandmanMessage(m));
    this.tilesWorker = this._spawn('tiles-worker.js', (m) => this._handleTilesMessage(m));
    this.runsWorker = this._spawn('runs-worker.js', (m) => this._handleRunsMessage(m));
  }

  // Each worker opens its own handle to the same PID. The four share one
  // failure vocabulary: 'fatal' and 'gone' stop the reader, 'diagnostic' is
  // something a human should see that must not stop the reader or break a
  // bench loop watching .fatal. Everything else goes to the worker's own
  // handler. An exit that close() did not ask for is recorded as fatal, so
  // downstream consumers notice that a channel has stopped.
  _spawn(file, onMessage) {
    const w = new Worker(path.join(__dirname, file),
      { workerData: { pid: this.pid, base: this.base } });
    w.unref();
    w.on('message', (m) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'fatal') this.fatal = m.message;
      else if (m.type === 'gone') this.fatal = m.message || 'target process exited';
      else if (m.type === 'diagnostic') this.diagnostic = m.message;
      else onMessage(m);
    });
    w.on('error', (e) => { this.fatal = String(e.message || e); });
    w.on('exit', (code) => {
      if (!this.closing && this.fatal === null) {
        this.fatal = `worker exited unexpectedly (code ${code})`;
      }
    });
    return w;
  }

  _handleSweepMessage(m) {
    if (m.type === 'sweep') {
      // Replace wholesale, never merge: an address the new sweep did not
      // find must disappear, not linger from the previous one.
      this.resolved = m.found;
      if (m.mapNames) this.mapNames = m.mapNames;
      // Placement is latched per map in the worker (via nextPlacement) and
      // posted on each sweep; store it directly.
      if (m.placement !== undefined) this.placed = m.placement;
      if (m.placement_misses !== undefined) this.placementMisses = m.placement_misses;
      if (m.melodies !== undefined) this.melodiesData = m.melodies;
      if (m.melody_status !== undefined) this.melodyStatus = m.melody_status;
      this.sweeps = m.sweeps;
      this.lastSweepMs = m.took_ms;

      // The tiles worker reads the roster once per map, so it needs to hear
      // when the map changes or the run restarts onto the same one.
      if (m.mapId !== undefined && m.mapId !== null) {
        const isReset = !!m.runReset;
        if (m.mapId !== this._lastRelayedMapId || isReset) {
          this._lastRelayedMapId = m.mapId;
          this.tilesWorker.postMessage({
            type: 'map',
            mapId: m.mapId,
            ...(isReset ? { reset: true } : {}),
          });
        }
      }

      // The Sandman worker polls the shop gate itself, off the address the
      // sweep resolved; relay it whenever it changes, including to absent.
      const gateEntry = m.found && m.found[SANDMAN_SHOP_GATE];
      const gateAddr = gateEntry ? gateEntry.binding_addr : null;
      if (gateAddr !== this._lastRelayedGateAddr) {
        this._lastRelayedGateAddr = gateAddr;
        this.sandmanWorker.postMessage(gateEntry
          ? { type: 'gate', addr: gateAddr, variant: gateEntry.variant, is_float: gateEntry.is_float }
          : { type: 'gate', addr: null, variant: null, is_float: false });
      }
      // The run-end worker polls its values itself; relay their bindings
      // whenever any of them changes, including to absent.
      const runValues = {};
      for (const name of RUN_VALUE_NAMES) {
        const e = m.found && m.found[name];
        if (e) runValues[name] = { addr: e.binding_addr, variant: e.variant, is_float: e.is_float };
      }
      const runKey = JSON.stringify(runValues);
      if (runKey !== this._lastRelayedRunValues) {
        this._lastRelayedRunValues = runKey;
        this.runsWorker.postMessage({ type: 'values', bindings: runValues });
      }
    } else if (m.type === 'binding_vt') {
      this.bindingVtReady = m.ready;
    }
  }

  _handleSandmanMessage(m) {
    if (m.type === 'sandman') {
      this.sandmanData = m.offers;
      this.sandmanStatus = m.status;
      if (typeof this.onSandmanChange === 'function') {
        this.onSandmanChange(m.offers, m.status);
      }
    }
  }

  _handleTilesMessage(m) {
    if (m.type === 'tiles') this.tilesRoster = m.tiles;
  }

  _handleRunsMessage(m) {
    if (m.type !== 'run' || !m.summary) return;
    const map = m.summary.map;
    this.runSummaries.push({
      ...m.summary,
      map_name: map !== null && this.mapNames[map] !== undefined ? this.mapNames[map] : null,
    });
    if (typeof this.onRunSummary === 'function') this.onRunSummary();
  }

  /** The oldest finished run not yet emitted, or null. Removes it. */
  take_run_summary() {
    return this.runSummaries.length ? this.runSummaries.shift() : null;
  }

  clearRun() {
    this.placed = null;
    this.placementMisses = 0;
    this.melodiesData = null;
    this.melodyStatus = 'pending';
    this.sandmanData = null;
    this.sandmanStatus = 'pending';
    this.tilesRoster = null;
    this._lastRelayedMapId = null;
    this.sandmanWorker.postMessage({ type: 'clear' });
    this.tilesWorker.postMessage({ type: 'clear' });
  }

  /** One live value, or null when this sweep has not resolved its address. */
  get(name) {
    const entry = this.resolved[name];
    if (entry === undefined) return null;
    const val = this.pollValue(entry.binding_addr, entry.variant, entry.is_float);
    if (name === 'Hero Level' && val !== null) {
      if (this._lastHeroLevel !== null && val < this._lastHeroLevel) {
        this.clearRun();
      }
      this._lastHeroLevel = val;
    }
    if (name === 'Current map id' && val === -1) {
      this.clearRun();
    }
    return val;
  }

  pollValue(bindingAddr, variant, isFloat) {
    return pollBinding(this.proc, bindingAddr, variant, isFloat);
  }

  /**
   * False once the game process we attached to has exited. The handle stays
   * valid across that (see Process.isAlive), so nothing else in the read
   * path notices -- values just quietly go null forever, which is why the
   * poll loop asks this directly.
   */
  alive() { return this.proc.isAlive(); }

  maps() { return this.mapNames; }
  placement() { return this.placed; }
  melodies() { return this.melodiesData; }
  melody_status() { return this.melodyStatus; }
  sandman() { return this.sandmanData; }
  sandman_status() { return this.sandmanStatus; }
  tiles() { return this.tilesRoster; }
  found() { return Object.keys(this.resolved).length; }

  close() {
    this.closing = true;
    // Known and accepted: terminate() landing while a worker is inside a native
    // ReadProcessMemory throws a napi fatal that takes the whole process down
    // rather than exiting cleanly. Observed 2026-09-04. It only happens on the
    // way out, so the exit status is wrong and nothing else is -- not worth a
    // graceful-shutdown handshake.
    this.worker.terminate();
    this.sandmanWorker.terminate();
    this.tilesWorker.terminate();
    this.runsWorker.terminate();
    this.proc.close();
  }
}

module.exports = { Reader };
