'use strict';
// End-to-end sweep cost against a REAL process, through the real code path:
// OpenProcess (read-only) -> VirtualQueryEx region walk -> ReadProcessMemory
// into the shared external buffer -> aligned qword scan.
//
// The target is bench/hog.js, not Ravenswatch.exe -- the game cannot be
// started in this environment. hog.js commits a comparable writable heap and
// plants needles at known addresses, so this measures the real syscall and
// scan costs AND checks that the sweep finds exactly what was planted.

const { spawn } = require('child_process');
const path = require('path');
const { openProcess } = require('../win32');
const { scanPointers } = require('../scan');

const GB = Number(process.argv[2] || 1.8);
const REPS = Number(process.env.REPS || 3);

const child = spawn(process.execPath, [path.join(__dirname, 'hog.js'), String(GB)],
  { stdio: ['ignore', 'pipe', 'inherit'] });

let acc = '';
child.stdout.on('data', d => {
  acc += d;
  if (!acc.includes('\n')) return;
  const info = JSON.parse(acc.split('\n')[0]);
  try { main(info); } finally { child.kill(); }
});

function sweepBytes(proc) {
  let total = 0;
  for (const [, size] of proc.regions(true)) total += size;
  return total;
}

function main(info) {
  console.log(`node ${process.version}`);
  console.log(`target pid ${info.pid}, committed ${(info.bytes / 1e9).toFixed(2)} GB in the hog's own blocks`);
  const proc = openProcess(info.pid);

  const t0 = process.hrtime.bigint();
  const writable = sweepBytes(proc);
  const t1 = process.hrtime.bigint();
  console.log(`writable region walk: ${(Number(t1 - t0) / 1e6).toFixed(1)} ms, `
    + `${(writable / 1e9).toFixed(2)} GB across the whole process`);

  // Split the cost: how much is the kernel reads, how much is the scan loop.
  {
    const { iterChunks } = require('../scan');
    const times = [];
    for (let r = 0; r < REPS; r++) {
      const s0 = process.hrtime.bigint();
      let q = 0;
      for (const [, nq] of iterChunks(proc, true)) q += nq;
      const s1 = process.hrtime.bigint();
      times.push(Number(s1 - s0) / 1e6);
    }
    times.sort((a, b) => a - b);
    const med = times[times.length >> 1];
    console.log(`\nReadProcessMemory only (no scan): median ${med.toFixed(0)} ms  `
      + `(${((writable / 1e9) / (med / 1000)).toFixed(2)} GB/s)`);
  }

  for (const nTargets of [2, 6]) {
    const targets = [info.needleA, info.needleB];
    for (let i = 2; i < nTargets; i++) targets.push(0x00007ff600000000 + i * 0x1000);
    const times = [];
    let hits = null;
    for (let r = 0; r < REPS; r++) {
      const s0 = process.hrtime.bigint();
      hits = scanPointers(proc, targets, { writableOnly: true, withPrev: [info.needleA] });
      const s1 = process.hrtime.bigint();
      times.push(Number(s1 - s0) / 1e6);
    }
    times.sort((a, b) => a - b);
    const med = times[times.length >> 1];
    const a = hits.get(info.needleA), b = hits.get(info.needleB);
    const expected = info.planted.a.length;
    const addrsOk = a.map(x => x[0]).sort().join() === info.planted.a.slice().sort().join();
    const prevOk = a.every(x => x[1] === info.prevA);
    console.log(
      `\n${nTargets} targets, ${REPS} reps, median ${med.toFixed(0)} ms  `
      + `(${((writable / 1e9) / (med / 1000)).toFixed(2)} GB/s over the whole writable set)`);
    console.log(`  needleA hits ${a.length}/${expected} addresses-match=${addrsOk} with_prev-match=${prevOk}`);
    console.log(`  needleB hits ${b.length}/${expected}`);
    console.log(`  times: ${times.map(t => t.toFixed(0)).join(', ')} ms`);
  }
  proc.close();
}
