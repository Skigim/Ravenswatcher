'use strict';
// Minimal stand-in for src/sweeper.js used by test-cadence.js: the same
// scanPointers sweep, on a worker thread, against a pid and target set the
// test supplies (no RTTI, so it can run against a plain Node process).
const { parentPort, workerData } = require('worker_threads');
const { openProcess } = require('../win32');
const { scanPointers } = require('../scan');

const proc = openProcess(workerData.pid);
let n = 0;
(async () => {
  for (;;) {
    const t0 = Date.now();
    const hits = scanPointers(proc, workerData.targets, { writableOnly: true });
    parentPort.postMessage({ sweeps: ++n, took_ms: Date.now() - t0,
      hits: hits.get(workerData.targets[0]).length });
    await new Promise(r => setTimeout(r, workerData.intervalMs));
  }
})();
