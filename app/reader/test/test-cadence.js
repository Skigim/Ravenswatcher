'use strict';
// Does the poll loop keep its 250 ms cadence while a ~1.2 s sweep runs?
//
// This is the one place the Node reader is structurally different from the
// Python sidecar it replaced. That ran discovery on a threading.Thread and kept
// cadence because ctypes releases the GIL for every ReadProcessMemory and
// numpy releases it for the comparison. Node's scan is plain JS on one
// thread, so the same shape would block the event loop.
//
// Target is bench/hog.js -- a Node child with a ~2 GB writable heap.
// Ravenswatch.exe is not attached to.
//
// This used to run the sweep twice, once on the main thread and once on a
// worker, and assert the main-thread run stalled the poll loop measurably
// worse. That assertion was a control, not a regression check: it verified the
// naive shape is bad rather than that the shipped one is good, and whether it
// held depended on machine contention at the moment it ran -- passing under
// load, failing on a quiet box, with the same worker number either way. It made
// the suite unusable as a pass/fail gate while telling nobody anything about
// whether the reader works. What remains is the assertion that does: the worker
// keeps cadence.

const { spawn } = require('child_process');
const path = require('path');
const { Worker } = require('worker_threads');

const POLL_MS = 250;
const RUN_MS = 6000;
const SWEEP_INTERVAL_MS = 5000;

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

function stats(gaps) {
  const s = gaps.slice().sort((a, b) => a - b);
  return { max: s[s.length - 1], p50: s[s.length >> 1], n: s.length };
}

function pollLoop(onTick) {
  const gaps = [];
  let last = Date.now();
  const t = setInterval(() => {
    const now = Date.now();
    gaps.push(now - last);
    last = now;
    if (onTick) onTick();
  }, POLL_MS);
  return { gaps, stop: () => clearInterval(t) };
}

async function workerRun(info, targets) {
  const loop = pollLoop();
  let sweeps = 0, took = 0;
  const w = new Worker(path.join(__dirname, 'sweep-worker.js'),
    { workerData: { pid: info.pid, targets, intervalMs: SWEEP_INTERVAL_MS } });
  w.on('message', (m) => { sweeps = m.sweeps; took = m.took_ms; });
  await new Promise(r => setTimeout(r, RUN_MS));
  loop.stop(); await w.terminate();
  return { ...stats(loop.gaps), sweeps, took };
}

async function run(info) {
  console.log(`\ntest-cadence: 250 ms poll loop against a ~${(info.bytes / 1e9).toFixed(1)} GB target (pid ${info.pid})`);
  const targets = [info.needleA, info.needleB];

  const worker = await workerRun(info, targets);
  console.log(`        worker:      ${worker.sweeps} sweeps (${worker.took} ms each), poll gap p50 ${worker.p50} ms, max ${worker.max} ms over ${worker.n} ticks`);

  // 450 against a 250 ms target: loose enough that ordinary scheduling jitter
  // does not trip it, tight enough that a sweep moving back onto the main
  // thread would -- the stalls that shape produces start around 300 ms and
  // climb with contention.
  check('a worker-thread sweep keeps the poll loop near cadence', worker.max < 450,
    `worst gap ${worker.max} ms`);
  check('the worker still completed sweeps', worker.sweeps >= 1, `${worker.sweeps}`);
  return failures;
}

function mainEntry() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'bench', 'hog.js'), '1.8'],
      { stdio: ['ignore', 'pipe', 'inherit'] });
    let acc = '';
    child.stdout.on('data', async (d) => {
      acc += d;
      if (!acc.includes('\n')) return;
      const info = JSON.parse(acc.split('\n')[0]);
      let f;
      try { f = await run(info); } finally { child.kill(); }
      resolve(f);
    });
  });
}

if (require.main === module) mainEntry().then(f => process.exit(f ? 1 : 0));
module.exports = { main: mainEntry };
