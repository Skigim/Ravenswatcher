'use strict';
// Stub child process used by test-sidecar.js to exercise createSidecar's
// process supervision without running the actual reader or touching the game.

const fs = require('fs');

const mode = process.env.SIDECAR_TEST_MODE || 'fail';
process.stdin.on('data', () => {});
process.stdin.on('end', () => { if (mode !== 'ignore-stop') process.exit(0); });
process.stdin.resume();

// The supervisor forwards only lines that pass sidecar-frame's state-frame
// check, so every stub frame carries the full field set; `extra` rides along.
function frame(extra) {
  return JSON.stringify({
    no_run: true, ready: false, coop: false, process: 'stub', sweeps: 0,
    poll_ms: 0, sweep_interval: 0, level: null, in_combat: null, map_id: null,
    pid: process.pid, dream_shards: null, melodies: null, sandman: null,
    tiles: null, run_summary: null, ...extra,
  }) + '\n';
}

if (mode === 'fail') {
  process.stderr.write('stub child failure\n');
  process.exit(1);
} else if (mode === 'fail-once-file') {
  const stateFile = process.env.SIDECAR_STATE_FILE;
  let count = 0;
  if (stateFile && fs.existsSync(stateFile)) {
    try { count = parseInt(fs.readFileSync(stateFile, 'utf8'), 10) || 0; } catch {}
  }
  count += 1;
  if (stateFile) {
    fs.writeFileSync(stateFile, String(count));
  }
  if (count === 1) {
    process.stderr.write('stub first failure\n');
    process.exit(1);
  } else {
    process.stdout.write(frame({ state: 'recovered', count }));
    // Keep alive until killed
    setInterval(() => {}, 60000);
  }
} else if (mode === 'preempt-race') {
  const stateFile = process.env.SIDECAR_STATE_FILE;
  let count = 0;
  if (stateFile && fs.existsSync(stateFile)) {
    try { count = parseInt(fs.readFileSync(stateFile, 'utf8'), 10) || 0; } catch {}
  }
  count += 1;
  if (stateFile) {
    fs.writeFileSync(stateFile, String(count));
  }
  if (count === 1) {
    process.stderr.write('stub initial failure for timer test\n');
    process.exit(1);
  } else {
    process.stdout.write(frame({ count }));
    setInterval(() => {}, 60000);
  }
} else if (mode === 'stay' || mode === 'ignore-stop') {
  process.stdout.write(frame({ ok: true }));
  setInterval(() => {}, 60000);
} else {
  process.exit(0);
}
