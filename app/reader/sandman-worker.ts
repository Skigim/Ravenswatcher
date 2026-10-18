'use strict';
// The Sandman shop availability and offers channel, on its own worker thread.
//
// A dedicated worker because the discovery sweep in sweeper.js takes
// 1688-3115 ms (and ~9.9 s cold) against a 5 s interval. A shop poll sharing
// that thread was starved 34-62% of the time, and sold state lagged by up to
// ~3.6 s.
//
// Three numbers, all measured live on 2026-09-04 against the running game,
// decide the design:
//
// - sandman.readOffers() off a cached, validated controller costs 0.02 ms
//   (2 ms for 100 calls). It is effectively free and can be polled at 100 ms.
// - sandman.findController() costs ~1.0 s (888 / 1048 / 1026 ms). It is a
//   heap pointer scan and must never run in the hot loop.
// - The controller instance persists while the shop is shut. Three scans
//   taken with the shop closed all returned the same address, 0x2050f7c6d58,
//   and readOffers against it returned null only because no slot was bound to
//   an item. So the controller is found once per process, not once per shop
//   visit, and the cache survives between visits.
//
// Running on its own thread at SANDMAN_POLL_MS = 100 ms with a cached
// controller consumes ~0.02% of a core, is never blocked by the 5 s heap sweep,
// and brings the sold-state update latency down to ~100 ms.

import { parentPort, workerData, isMainThread } from 'worker_threads';
import * as sandman from './sandman';
import type { SandmanOffer, SandmanStatus, SandmanSource, ResolvedVtables } from './sandman';
import { pollBinding } from './values';
import { WorkerControl } from './worker-control';

// win32.js is still JavaScript; require it directly.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { openProcess } = require('./win32');

export const SANDMAN_POLL_MS = 100;
export const CONTROLLER_RESCAN_MS = 2000;
export const VTABLE_RETRY_MS = 5000;

export interface GateBinding {
  addr: number | null;
  variant: string | null;
  is_float: boolean;
}

interface WorkerProcess extends SandmanSource {
  isAlive(): boolean;
  close(): void;
}

/** What Reader posts to this worker. */
type SandmanWorkerMessage =
  | { type: 'gate'; addr: number | null; variant: string | null; is_float: boolean }
  | { type: 'clear' };

function fail(message: string): void {
  if (parentPort) {
    parentPort.postMessage({ type: 'fatal', message });
  }
}

export function pollGate(proc: SandmanSource, gate: GateBinding | null): boolean {
  if (!gate || !gate.addr) return false;
  try {
    return pollBinding(proc, gate.addr, gate.variant, gate.is_float) === 1;
  } catch {
    return false;
  }
}

export async function runWorker(pid: number, base: number): Promise<void> {
  const control = new WorkerControl(parentPort);
  let proc: WorkerProcess;
  try {
    proc = openProcess(pid) as WorkerProcess;
  } catch (e) {
    control.dispose();
    return fail(e instanceof Error ? e.message : String(e));
  }

  let gate: GateBinding | null = null;
  let heldOffers: readonly SandmanOffer[] | null = null;
  let lastPostedOffers: readonly SandmanOffer[] | null = null;
  let lastPostedStatus: SandmanStatus = 'pending';
  let firstOpenWithoutRead: number | null = null;

  let cachedController: number | null = null;
  let lastControllerScan = 0;

  const sandmanVtables: sandman.SandmanVtables = {};
  let resolvedVtables: ResolvedVtables | null = null;
  let lastVtableAttempt = 0;

  if (parentPort) {
    parentPort.on('message', (m: SandmanWorkerMessage) => {
      if (m.type === 'gate') {
        gate = m.addr ? { addr: m.addr, variant: m.variant, is_float: m.is_float } : null;
      } else if (m.type === 'clear') {
        heldOffers = null;
        lastPostedOffers = null;
        lastPostedStatus = 'pending';
        firstOpenWithoutRead = null;
      }
    });
    parentPort.unref();
  }

  try {
    while (!control.stopped) {
      if (!proc.isAlive()) {
        if (parentPort) parentPort.postMessage({ type: 'gone', message: 'target process exited' });
        break;
      }

      // Resolved once and cached for the life of the worker. The retry is
      // slow on purpose: a stale RTTI name will not become correct by being
      // asked again at 100 ms, and resolveVtables walks the PE to answer.
      if (!resolvedVtables) {
        const now = Date.now();
        if (now - lastVtableAttempt >= VTABLE_RETRY_MS) {
          lastVtableAttempt = now;
          try {
            resolvedVtables = sandman.resolveVtables(proc, base, sandmanVtables);
          } catch {
            resolvedVtables = null;
          }
          if (!resolvedVtables && parentPort) {
            parentPort.postMessage({
              type: 'diagnostic',
              message: 'could not resolve Sandman RTTI vtables -- '
                + 'CONTROLLER_RTTI or MAGICAL_OBJECT_RTTI is stale; '
                + 're-run app/reader/bench/sandman-cell-scan.js to inspect.',
            });
          }
        }
        if (!resolvedVtables) {
          await control.wait(SANDMAN_POLL_MS);
          continue;
        }
      }

      // Validating the cache costs one pointer read; finding the controller
      // costs ~1.0 s. So the cache is checked every tick and the scan is
      // rate-limited to CONTROLLER_RESCAN_MS -- a scan per tick would peg a
      // core and still answer no faster.
      if (cachedController !== null) {
        let vt: number | null = null;
        try {
          vt = proc.readPtr(cachedController);
        } catch {
          vt = null;
        }
        if (vt !== resolvedVtables.controllerVt) {
          cachedController = null;
        }
      }

      if (cachedController === null) {
        const now = Date.now();
        if (now - lastControllerScan >= CONTROLLER_RESCAN_MS) {
          lastControllerScan = now;
          try {
            cachedController = sandman.findController(proc, resolvedVtables.controllerVt);
          } catch {
            cachedController = null;
          }
        }
      }

      if (cachedController === null) {
        // A tick with no valid controller posts nothing and falls through to the sleep.
        await control.wait(SANDMAN_POLL_MS);
        continue;
      }

      // Named, not swallowed. A bare catch here made a stale offset and a
      // detached process look identical from the panel.
      let offersRead: readonly SandmanOffer[] | null = null;
      try {
        offersRead = sandman.readOffers(proc, resolvedVtables, cachedController);
      } catch (e) {
        if (parentPort) {
          parentPort.postMessage({
            type: 'diagnostic',
            message: 'Sandman offer read threw: ' + (e instanceof Error ? e.message : String(e)),
          });
        }
        offersRead = null;
      }

      // The gate is read for one reason only: 'unresolved', the state that
      // must not look like an empty shop. The read path above needs no gate --
      // readOffers already returns null when no slot is bound, which is
      // exactly a shut shop, and it costs 0.02 ms either way.
      const shopOpen = pollGate(proc, gate);
      if (!shopOpen || offersRead !== null) {
        firstOpenWithoutRead = null;
      } else if (firstOpenWithoutRead === null) {
        firstOpenWithoutRead = Date.now();
      }

      const elapsedFailMs = firstOpenWithoutRead !== null ? (Date.now() - firstOpenWithoutRead) : 0;

      // Hold the last read rather than following it down to null. Measured
      // live: closing the shop clears every cell's pointer to its item, so the
      // names and prices are gone and no later read recovers them. Holding is
      // the only way the panel can be a reference out in the field. Only the
      // run ending clears, and that arrives as a 'clear' message from the
      // parent -- run detection lives in Reader.clearRun and is not duplicated
      // here.
      if (offersRead !== null) {
        heldOffers = offersRead;
      }

      const status = sandman.nextSandmanStatus(heldOffers, shopOpen, elapsedFailMs);

      // Post if offers differ from last posted set or status changed
      if (sandman.offersChanged(lastPostedOffers, heldOffers) || status !== lastPostedStatus) {
        lastPostedOffers = heldOffers;
        lastPostedStatus = status;
        if (parentPort) {
          parentPort.postMessage({ type: 'sandman', offers: heldOffers, status });
        }
      }

      await control.wait(SANDMAN_POLL_MS);
    }
  } finally {
    control.dispose();
    proc.close();
  }
}

if (!isMainThread && workerData) {
  const { pid, base } = workerData as { pid: number; base: number };
  runWorker(pid, base).catch(e => fail(e instanceof Error ? e.message : String(e)));
}
