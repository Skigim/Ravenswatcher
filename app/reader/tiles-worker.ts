'use strict';
// Placed tiles and camp rewards channel, on its own worker thread.
//
// A dedicated worker because the roster needs tiles.findSelectors(), a heap
// scan measured at ~1.3 s (895-1562 ms), and reward selectors spawn
// progressively during map load, taking 3-5 passes to reach stability. On
// the 5 s sweep that was 25-40 s of tile latency, and it blocked the
// values/placement/melodies sweep. At TILES_POLL_MS = 1500 ms (sleep after
// scan) stabilization takes ~8-14 s and the main sweep stays unblocked.
//
// It never stops scanning a map. Measured on a cold load (2026-09-17,
// bench/selector-plateau-watch.js): the worker's first roster carried 6
// selectors while 9 existed, and the next scan read 9. Two scans agreeing is
// not completeness, and there is no completeness signal to wait for: the
// roster does not know how many rewards it is owed (see tiles.ts
// findSelectors). So stability picks the cadence rather than ending it:
// TILES_POLL_MS while the count is moving, TILES_SETTLED_POLL_MS once it has
// held. A late batch is caught within one settled interval, at the cost of
// one ~1.3 s scan per interval.

import { parentPort, workerData, isMainThread } from 'worker_threads';
import * as tiles from './tiles';
import type { PlacedTile, TilesVtables, TilesSource } from './tiles';

// win32.js is still JavaScript; require it directly.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { openProcess } = require('./win32');

export const TILES_POLL_MS = 1500;
export const TILES_SETTLED_POLL_MS = 15000;

interface WorkerProcess extends TilesSource {
  isAlive(): boolean;
  close(): void;
}

/** What Reader (or a test) posts to this worker. */
export type TilesWorkerMessage =
  | { type: 'map'; mapId: number | null; reset?: boolean }
  | { type: 'clear' }
  | { type: 'stop' };

/** The half of a MessagePort this worker uses; a test can pass its own. */
export interface TilesPort {
  postMessage(value: unknown): void;
  on(event: 'message', listener: (value: TilesWorkerMessage) => void): void;
  unref?(): void;
}

export interface RunWorkerOptions {
  proc?: WorkerProcess;
  port?: TilesPort;
  pollMs?: number;
  settledPollMs?: number;
  vtables?: TilesVtables;
}

export function nextTiles(
  prev: readonly PlacedTile[] | null,
  mapId: number,
  incoming: readonly PlacedTile[] | null | undefined
): readonly PlacedTile[] | null {
  if (mapId === -1) return null;
  return incoming !== undefined ? incoming : prev;
}

/** Whether there is a map to scan at all. The lobby (-1) and no map never look. */
export function tilesDue(mapId: number | null | undefined): boolean {
  return !(mapId === -1 || mapId === null || mapId === undefined);
}

/** The sleep after a scan: fast while the selector count is moving, slow once it holds. */
export function tilesPollMs(
  stable: boolean,
  moving: number = TILES_POLL_MS,
  settled: number = TILES_SETTLED_POLL_MS
): number {
  return stable ? settled : moving;
}

export function nextTilesStable(
  prevStable: boolean,
  prevSelectorCount: number,
  incomingTiles: readonly PlacedTile[] | null | undefined
): { stable: boolean; selectorCount: number } {
  if (!Array.isArray(incomingTiles)) {
    return { stable: prevStable, selectorCount: prevSelectorCount };
  }
  const selectorCount = incomingTiles.filter(t => t.source === 'selector').length;
  return { stable: selectorCount > 0 && selectorCount === prevSelectorCount, selectorCount };
}

function fail(message: string, port?: TilesPort | null): void {
  const p = port || parentPort;
  if (p) {
    p.postMessage({ type: 'fatal', message });
  }
}

export async function runWorker(
  pid: number,
  base: number,
  options?: RunWorkerOptions
): Promise<void> {
  const port = options?.port || parentPort;
  let proc: WorkerProcess;
  if (options?.proc) {
    proc = options.proc;
  } else {
    try {
      proc = openProcess(pid) as WorkerProcess;
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e), port);
    }
  }

  const pollMs = options?.pollMs ?? TILES_POLL_MS;
  const settledPollMs = options?.settledPollMs ?? TILES_SETTLED_POLL_MS;
  let stopped = false;
  let currentMapId: number | null = null;
  let heldTiles: readonly PlacedTile[] | null = null;
  let lastPostedTiles: readonly PlacedTile[] | null = null;
  let tilesStable = false;
  let lastSelectorCount = -1;

  const tileVtables: TilesVtables = options?.vtables || {};

  let wake: (() => void) | null = null;
  function interruptibleSleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      let timer: NodeJS.Timeout | null = null;
      const onWake = () => {
        if (timer) clearTimeout(timer);
        wake = null;
        resolve();
      };
      wake = onWake;
      timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
    });
  }

  if (port) {
    // 'stop' ends the loop. Reader never sends it -- it terminates the
    // worker -- but the tests drive runWorker in-process and need a way out.
    port.on('message', (m: TilesWorkerMessage) => {
      if (m.type === 'stop') {
        stopped = true;
        if (wake) wake();
      } else if (m.type === 'map') {
        const incomingMapId = typeof m.mapId === 'number' ? m.mapId : null;
        const isReset = !!m.reset;
        if (isReset || incomingMapId !== currentMapId) {
          currentMapId = incomingMapId;
          heldTiles = null;
          lastPostedTiles = null;
          tilesStable = false;
          lastSelectorCount = -1;
          if (wake) wake();
        }
      } else if (m.type === 'clear') {
        heldTiles = null;
        lastPostedTiles = null;
        tilesStable = false;
        lastSelectorCount = -1;
        currentMapId = null;
        if (wake) wake();
      }
    });
    if (typeof port.unref === 'function') {
      port.unref();
    }
  }

  try {
    while (!stopped) {
      if (!proc.isAlive()) {
        if (port) port.postMessage({ type: 'gone', message: 'target process exited' });
        break;
      }

      if (!tilesDue(currentMapId)) {
        // No map. Wait until interrupted by a message ('map', 'clear', 'stop')
        // or a periodic wake check.
        await interruptibleSleep(1000);
        continue;
      }

      // Perform a scan attempt
      try {
        tiles.resolveVtables(proc, base, tileVtables);
      } catch {
        // Reported below if chain walk or selector scan fails
      }

      // Never throws: a failed walk comes back as ok:false with a diagnostic.
      const chainResult = tiles.findSpawnerByChain(proc, base,
        { vtables: tileVtables as Record<string, unknown> });

      let incomingTiles: readonly PlacedTile[] | null = null;
      if (chainResult.ok && chainResult.spawner) {
        try {
          const selectorVt = tileVtables.selectorVt;
          let selectorAddrs: number[] = [];
          if (selectorVt) {
            try {
              selectorAddrs = tiles.findSelectors(proc, selectorVt);
            } catch {
              selectorAddrs = [];
            }
          }
          incomingTiles = tiles.readPlacedTiles(proc, base, null, {
            spawnerAddr: chainResult.spawner,
            selectorAddrs,
          });
        } catch {
          incomingTiles = null;
        }
      } else {
        incomingTiles = null;
        if (chainResult.diagnostic && port) {
          port.postMessage({ type: 'diagnostic', message: chainResult.diagnostic });
        }
      }

      ({ stable: tilesStable, selectorCount: lastSelectorCount } =
        nextTilesStable(tilesStable, lastSelectorCount, incomingTiles));

      heldTiles = nextTiles(heldTiles, currentMapId ?? -1, incomingTiles);

      if (tiles.tilesChanged(lastPostedTiles, heldTiles)) {
        lastPostedTiles = heldTiles;
        if (port) {
          port.postMessage({ type: 'tiles', tiles: heldTiles });
        }
      }

      // Sleep before the next scan; a 'map' message cuts the sleep short.
      if (!stopped) {
        await interruptibleSleep(tilesPollMs(tilesStable, pollMs, settledPollMs));
      }
    }
  } finally {
    proc.close();
  }
}

if (!isMainThread && workerData) {
  const { pid, base } = workerData as { pid: number; base: number };
  runWorker(pid, base).catch(e => fail(e instanceof Error ? e.message : String(e)));
}
