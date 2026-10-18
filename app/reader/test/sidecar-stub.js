'use strict';
// Stub child process used by test-sidecar.js to exercise createSidecar's
// process supervision without running the actual reader or touching the game.

const fs = require('fs');

const mode = process.env.SIDECAR_TEST_MODE || 'fail';
process.stdin.on('data', () => {});
process.stdin.on('end', () => { if (mode !== 'ignore-stop') process.exit(0); });
process.stdin.resume();

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
    process.stdout.write(JSON.stringify({ state: 'recovered', pid: process.pid, count }) + '\n');
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
    process.stdout.write(JSON.stringify({ pid: process.pid, count }) + '\n');
    setInterval(() => {}, 60000);
  }
} else if (mode === 'stay' || mode === 'ignore-stop') {
  process.stdout.write(JSON.stringify({ pid: process.pid, ok: true }) + '\n');
  setInterval(() => {}, 60000);
} else {
  process.exit(0);
}
