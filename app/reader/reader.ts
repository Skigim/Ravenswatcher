'use strict';
// Attach, run the four workers, hand back a polling source.

import * as path from 'path';
import { Worker } from 'worker_threads';
import { getProcessBackend } from './backend';
import type { ProcessBackend, ProcessHandle } from './process';
import { pollBinding } from './values';
import { PROCESS_NAME, SANDMAN_SHOP_GATE } from './state';
import type { LiveSource, MelodyStatus, Placement } from './state';
import { RUN_VALUE_NAMES } from './runs';
import type { RunSummary } from './runs';
import type { MelodySlotView } from './melodies';
import type { SandmanOffer, SandmanStatus } from './sandman';
import type { PlacedTile } from './tiles';
import type {
  RunsWorkerInbound, SandmanWorkerInbound, TilesWorkerInbound, ValueBinding,
} from './worker-messages';

/**
 * The one running copy's PID. Refuses rather than guessing when zero or
 * several are running -- same contract as discover_values.find_pid().
 */
export function resolvePid(backend: ProcessBackend, exeName: string): number {
  const found = backend.findProcesses(exeName);
  const first = found[0];
  if (first === undefined) {
    // Tagged, not matched on by message: stdio.js exits with a distinct
    // status for this case so the supervisor can retry at a steady cadence
    // instead of backing off as it would for a genuine fault. The
    // several-copies-running error below is deliberately NOT tagged -- that
    // one needs a human, and retrying it every couple of seconds forever
    // would just be noise.
    throw Object.assign(
      new Error(`${exeName} is not running -- start the game first, or pass a PID explicitly`),
      { code: 'ENOGAME' },
    );
  }
  if (found.length > 1) {
    throw new Error(`more than one ${exeName} is running (${found.map(c => c.pid).join(', ')}) -- pass the PID you want explicitly`);
  }
  return first.pid;
}

/** One resolved value, as the sweep posts it. */
interface FoundEntry { binding_addr: number; variant: string | null; is_float: boolean }

/** The fields of the sweeper message that Reader reads. */
interface SweepMessage {
  type: 'sweep';
  found?: Record<string, FoundEntry>;
  mapNames?: Record<number, string>;
  placement?: Placement | null;
  placement_misses?: number;
  melodies?: MelodySlotView[] | null;
  melody_status?: MelodyStatus;
  runReset?: boolean;
  mapId?: number | null;
  sweeps: number;
  took_ms: number;
}

type WorkerMessage = SweepMessage
  | { type: 'binding_vt'; ready: boolean }
  | { type: 'sandman'; offers: SandmanOffer[] | null; status: SandmanStatus }
  | { type: 'tiles'; tiles: PlacedTile[] | null }
  | { type: 'run'; summary?: RunSummary }
  | { type: 'fatal' | 'gone' | 'diagnostic'; message?: string };

/** Anything an own worker posts has a string type; fields are checked where they are read. */
function isWorkerMessage(m: unknown): m is WorkerMessage {
  return typeof m === 'object' && m !== null && 'type' in m && typeof m.type === 'string';
}

export interface ReaderOptions {
  /** The process backend. Defaults to the host platform. */
  backend?: ProcessBackend;
  /**
   * Start the four worker threads. On by default. A test of attach, liveness
   * and close turns it off, because workers open the process through
   * getProcessBackend() on their own thread and cannot be handed a fake.
   */
  spawnWorkers?: boolean;
}

export type SandmanChangeListener = (offers: SandmanOffer[] | null, status: SandmanStatus) => void;

export class Reader implements LiveSource {
  pid: number;
  base: number;
  exePath: string;
  proc: ProcessHandle;
  resolved: Record<string, FoundEntry> = {};
  mapNames: Record<number, string> = {};
  placed: Placement | null = null;
  placementMisses = 0;
  melodiesData: MelodySlotView[] | null = null;
  melodyStatus: MelodyStatus = 'pending';
  sandmanData: SandmanOffer[] | null = null;
  sandmanStatus: SandmanStatus = 'pending';
  tilesRoster: PlacedTile[] | null = null;
  // Finished runs not yet emitted. A queue, not a slot: two runs ending
  // inside one poll is not expected, but losing one would be silent.
  runSummaries: RunSummary[] = [];
  sweeps = 0;
  lastSweepMs: number | undefined = undefined;
  bindingVtReady = false;
  fatal: string | null = null;
  diagnostic: string | null = null;
  closing = false;
  // Assigned by the caller when it wants the Sandman channel to push rather
  // than wait for the next poll -- see stdio.ts, which uses it to emit a
  // frame the moment an offer flips to sold instead of up to POLL_MS later.
  onSandmanChange: SandmanChangeListener | null = null;
  // The same, for a finished run: stdio.ts emits it at once.
  onRunSummary: (() => void) | null = null;

  worker: Worker | null = null;
  sandmanWorker: Worker | null = null;
  tilesWorker: Worker | null = null;
  runsWorker: Worker | null = null;

  private _lastRelayedRunValues: string | null = null;
  private _closePromise: Promise<void> | null = null;
  private readonly _workerExits = new Map<Worker, Promise<unknown>>();
  private _lastHeroLevel: number | null = null;
  private _lastObservedMapId: number | null = null;
  private _lastRelayedGateAddr: number | null = null;
  private _lastRelayedMapId: number | null = null;

  constructor(pid?: number | null, options: ReaderOptions = {}) {
    const backend = options.backend ?? getProcessBackend();
    const target = pid === undefined || pid === null ? resolvePid(backend, PROCESS_NAME) : pid;
    const mod = backend.moduleInfo(target);
    this.pid = target;
    this.base = mod.base;
    this.exePath = mod.exePath;
    this.proc = backend.open(target);

    if (options.spawnWorkers !== false) {
      this.worker = this._spawn('sweeper.js', (m) => this._handleSweepMessage(m));
      this.sandmanWorker = this._spawn('sandman-worker.js', (m) => this._handleSandmanMessage(m));
      this.tilesWorker = this._spawn('tiles-worker.js', (m) => this._handleTilesMessage(m));
      this.runsWorker = this._spawn('runs-worker.js', (m) => this._handleRunsMessage(m));
    }
  }

  // Each worker opens its own handle to the same PID. The four share one
  // failure vocabulary: fatal and gone stop the reader, diagnostic is
  // something a human should see that must not stop the reader or break a
  // bench loop watching .fatal. Everything else goes to the worker handler.
  // An exit that close() did not ask for is recorded as fatal, so
  // downstream consumers notice that a channel has stopped.
  private _spawn(file: string, onMessage: (m: WorkerMessage) => void): Worker {
    const w = new Worker(path.join(__dirname, file),
      { workerData: { pid: this.pid, base: this.base } });
    w.unref();
    this._workerExits.set(w, new Promise(resolve => w.once('exit', resolve)));
    w.on('message', (m: unknown) => {
      if (this.closing) return;
      if (!isWorkerMessage(m)) return;
      const msg = m;
      if (msg.type === 'fatal') this.fatal = msg.message ?? null;
      else if (msg.type === 'gone') this.fatal = msg.message || 'target process exited';
      else if (msg.type === 'diagnostic') this.diagnostic = msg.message ?? null;
      else onMessage(msg);
    });
    w.on('error', (e: Error) => { this.fatal = String(e.message || e); });
    w.on('exit', (code: number) => {
      if (!this.closing && this.fatal === null) {
        this.fatal = `worker exited unexpectedly (code ${code})`;
      }
    });
    return w;
  }

  private _handleSweepMessage(m: WorkerMessage): void {
    if (m.type === 'sweep') {
      // Replace wholesale, never merge: an address the new sweep did not
      // find must disappear, not linger from the previous one.
      this.resolved = m.found ?? {};
      if (m.mapNames) this.mapNames = m.mapNames;
      // Placement is latched per map in the worker (via nextPlacement) and
      // posted on each sweep; store it directly.
      if (m.placement !== undefined) this.placed = m.placement;
      if (m.placement_misses !== undefined) this.placementMisses = m.placement_misses;
      if (m.melodies !== undefined) this.melodiesData = m.melodies;
      if (m.runReset || m.melodies !== undefined) {
        // The runs worker snapshots the last in-run payload at the end edge,
        // before the sweep clears its live display for the menu.
        const out: RunsWorkerInbound = { type: 'melodies', melodies: m.melodies ?? null, mapId: m.mapId ?? null, reset: !!m.runReset };
        this.runsWorker?.postMessage(out);
      }
      if (m.melody_status !== undefined) this.melodyStatus = m.melody_status;
      this.sweeps = m.sweeps;
      this.lastSweepMs = m.took_ms;

      // The tiles worker reads the roster once per map, so it needs to hear
      // when the map changes or the run restarts onto the same one.
      if (m.mapId !== undefined && m.mapId !== null) {
        const isReset = !!m.runReset;
        if (m.mapId !== this._lastRelayedMapId || isReset) {
          this._lastRelayedMapId = m.mapId;
          const out: TilesWorkerInbound = {
            type: 'map',
            mapId: m.mapId,
            ...(isReset ? { reset: true } : {}),
          };
          this.tilesWorker?.postMessage(out);
        }
      }

      // The Sandman worker polls the shop gate itself, off the address the
      // sweep resolved; relay it whenever it changes, including to absent.
      const gateEntry = m.found?.[SANDMAN_SHOP_GATE];
      const gateAddr = gateEntry ? gateEntry.binding_addr : null;
      if (gateAddr !== this._lastRelayedGateAddr) {
        this._lastRelayedGateAddr = gateAddr;
        const out: SandmanWorkerInbound = gateEntry
          ? { type: 'gate', addr: gateAddr, variant: gateEntry.variant, is_float: gateEntry.is_float }
          : { type: 'gate', addr: null, variant: null, is_float: false };
        this.sandmanWorker?.postMessage(out);
      }
      // The run-end worker polls its values itself; relay their bindings
      // whenever any of them changes, including to absent.
      const runValues: Record<string, ValueBinding> = {};
      for (const name of RUN_VALUE_NAMES) {
        const e = m.found?.[name];
        if (e) runValues[name] = { addr: e.binding_addr, variant: e.variant, is_float: e.is_float };
      }
      const runKey = JSON.stringify(runValues);
      if (runKey !== this._lastRelayedRunValues) {
        this._lastRelayedRunValues = runKey;
        const out: RunsWorkerInbound = { type: 'values', bindings: runValues };
        this.runsWorker?.postMessage(out);
      }
    } else if (m.type === 'binding_vt') {
      this.bindingVtReady = m.ready;
    }
  }

  private _handleSandmanMessage(m: WorkerMessage): void {
    if (m.type === 'sandman') {
      this.sandmanData = m.offers;
      this.sandmanStatus = m.status;
      if (typeof this.onSandmanChange === 'function') {
        this.onSandmanChange(m.offers, m.status);
      }
    }
  }

  private _handleTilesMessage(m: WorkerMessage): void {
    if (m.type === 'tiles') this.tilesRoster = m.tiles;
  }

  private _handleRunsMessage(m: WorkerMessage): void {
    if (m.type !== 'run' || !m.summary) return;
    const map = m.summary.map;
    const name = map !== null ? this.mapNames[map] : undefined;
    this.runSummaries.push({
      ...m.summary,
      map_name: name !== undefined ? name : null,
    });
    if (typeof this.onRunSummary === 'function') this.onRunSummary();
  }

  /** The oldest finished run not yet emitted, or null. Removes it. */
  take_run_summary(): RunSummary | null {
    return this.runSummaries.shift() ?? null;
  }

  clearRun(): void {
    // This clears the Live view, including at the end screen. History keeps
    // its last in-run snapshot until a sweep confirms the next run began.
    this.placed = null;
    this.placementMisses = 0;
    this.melodiesData = null;
    this.melodyStatus = 'pending';
    this.sandmanData = null;
    this.sandmanStatus = 'pending';
    this.tilesRoster = null;
    this._lastRelayedMapId = null;
    const sandman: SandmanWorkerInbound = { type: 'clear' };
    const tiles: TilesWorkerInbound = { type: 'clear' };
    this.sandmanWorker?.postMessage(sandman);
    this.tilesWorker?.postMessage(tiles);
  }

  /** One live value, or null when this sweep has not resolved its address. */
  get(name: string): number | null {
    const entry = this.resolved[name];
    if (entry === undefined) return null;
    return this.pollValue(entry.binding_addr, entry.variant, entry.is_float);
  }

  updateTransitions(heroLevel: number | null, mapId: number | null): void {
    const reset = heroLevel !== null && this._lastHeroLevel !== null && heroLevel < this._lastHeroLevel;
    const outsideRun = mapId === -1 && this._lastObservedMapId !== -1;
    if (reset || outsideRun) this.clearRun();
    if (heroLevel !== null) this._lastHeroLevel = heroLevel;
    if (mapId !== null) this._lastObservedMapId = mapId;
  }

  pollValue(bindingAddr: number, variant: string | null, isFloat: boolean): number | null {
    return pollBinding(this.proc, bindingAddr, variant, isFloat);
  }

  /**
   * False once the game process we attached to has exited. The handle stays
   * valid across that (see ProcessHandle.isAlive), so nothing else in the read
   * path notices: values just quietly go null forever, which is why the
   * poll loop asks this directly.
   */
  alive(): boolean { return this.proc.isAlive(); }

  maps(): Record<number, string> { return this.mapNames; }
  placement(): Placement | null { return this.placed; }
  melodies(): MelodySlotView[] | null { return this.melodiesData; }
  melody_status(): MelodyStatus { return this.melodyStatus; }
  sandman(): SandmanOffer[] | null { return this.sandmanData; }
  sandman_status(): SandmanStatus { return this.sandmanStatus; }
  tiles(): PlacedTile[] | null { return this.tilesRoster; }
  found(): number { return Object.keys(this.resolved).length; }

  close(): Promise<void> {
    if (this._closePromise) return this._closePromise;
    this.closing = true;
    this.onSandmanChange = null;
    this.onRunSummary = null;
    for (const worker of this._workerExits.keys()) {
      worker.ref(); // Keep the reader process alive until native work has drained.
      worker.postMessage({ type: 'stop' });
    }
    this._closePromise = Promise.all(this._workerExits.values()).then(() => this.proc.close());
    return this._closePromise;
  }
}
