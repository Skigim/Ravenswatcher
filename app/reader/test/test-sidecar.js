'use strict';
// Supervision lifecycle tests: exercises createSidecar, start(), and stop()
// against a stub child without touching the game or spawning the real reader.
//
// Regressions covered:
// 1. start() after stop() resets stopped flag so supervisor reconnects on exit
// 2. start() cancels pending retryTimer to prevent duplicate child spawns

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSidecar, BASE_RETRY_MS } = require('../../sidecar');
const { createLifecycle } = require('../../lifecycle');
const assert = require('assert');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

const STUB_PATH = path.join(__dirname, 'sidecar-stub.js');
const STATE_FILE = path.join(os.tmpdir(), 'sidecar_test_state.tmp');

function cleanupStateFile() {
  try { if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE); } catch {}
}

/**
 * Control case: A single start() with no prior stop() supervises the child,
 * observes the failure, schedules a retry, and restarts the child.
 */
async function testControlSingleStart() {
  cleanupStateFile();
  process.env.SIDECAR_TEST_MODE = 'fail-once-file';
  process.env.SIDECAR_STATE_FILE = STATE_FILE;

  const downEvents = [];
  const frameEvents = [];

  const sidecar = createSidecar({
    packaged: false,
    repoRoot: path.join(__dirname, '..', '..', '..'),
    readerEntry: STUB_PATH,
    onDown: (info) => downEvents.push(info),
    onFrame: (frame) => frameEvents.push(frame),
  });

  sidecar.start();

  // Child 1 exits immediately. Wait for onDown and then the retryTimer (BASE_RETRY_MS) to fire.
  const recovered = await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), BASE_RETRY_MS + 1500);
    const checkInterval = setInterval(() => {
      if (frameEvents.length > 0) {
        clearTimeout(timeout);
        clearInterval(checkInterval);
        resolve(true);
      }
    }, 50);
  });

  await sidecar.stop();

  check('control: single start notices failure and calls onDown',
    downEvents.length === 1 && downEvents[0].attempt === 1,
    `downEvents=${downEvents.length}`);
  check('control: retry timer fires and recovers child after failure',
    recovered === true && frameEvents.some(f => f.state === 'recovered'),
    `recovered=${recovered}, frames=${frameEvents.length}`);

  cleanupStateFile();
}

/**
 * Regression Fix A1: After stop() is called, a subsequent start() must reset
 * stopped to false so that if the new child exits unexpectedly, handleSidecarExit
 * does not bail early at `if (stopped) return;` and instead supervises/retries.
 */
/**
 * Wait until `pred()` is true, or give up after `timeoutMs`.
 *
 * Replaces the fixed sleeps this file used to use. A sleep long enough on an
 * idle machine is not long enough on a loaded one, and the failure mode was
 * not a flaky assertion but a broken PRECONDITION: if child 1 had not failed
 * yet when the 150 ms sleep expired, the manual start() below ran before any
 * retry was scheduled, a third child spawned, and two separate checks failed
 * for a reason that had nothing to do with what they test.
 *
 * Waiting on the condition instead makes the test stricter, not looser: the
 * timeout is generous, and exhausting it is a real failure rather than a
 * scheduling accident.
 */
async function waitFor(pred, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise(r => setTimeout(r, 10));
  }
  return false;
}

async function testRestartAfterStopSupervises() {
  process.env.SIDECAR_TEST_MODE = 'fail';
  delete process.env.SIDECAR_STATE_FILE;

  const downEvents = [];

  const sidecar = createSidecar({
    packaged: false,
    repoRoot: path.join(__dirname, '..', '..', '..'),
    readerEntry: STUB_PATH,
    onDown: (info) => downEvents.push(info),
  });

  // 1. First run
  sidecar.start();
  // Wait for the first child exit to be processed.
  await waitFor(() => downEvents.length >= 1);

  const firstDownCount = downEvents.length;

  // 2. Stop supervisor
  await sidecar.stop();

  // 3. Start supervisor again
  sidecar.start();
  // Wait for the second child exit, which is what the check below asserts.
  await waitFor(() => downEvents.length > firstDownCount);

  await sidecar.stop();

  check('start() after stop() resets stopped flag and supervises exit',
    downEvents.length > firstDownCount,
    `downEvents before stop: ${firstDownCount}, after restart: ${downEvents.length}`);
}

/**
 * Regression Fix A2: When a child exits unexpectedly and schedules retryTimer,
 * calling start() manually before the timer expires must clear the pending timer
 * so it does not fire later and spawn a duplicate child.
 */
async function testManualStartCancelsPendingRetryTimer() {
  cleanupStateFile();
  process.env.SIDECAR_TEST_MODE = 'preempt-race';
  process.env.SIDECAR_STATE_FILE = STATE_FILE;

  const frames = [];
  const downEvents = [];

  const sidecar = createSidecar({
    packaged: false,
    repoRoot: path.join(__dirname, '..', '..', '..'),
    readerEntry: STUB_PATH,
    onDown: (info) => downEvents.push(info),
    onFrame: (f) => frames.push(f),
  });

  // 1. First start: child 1 fails immediately with code 1, scheduling retry in BASE_RETRY_MS (2000ms)
  sidecar.start();
  // The whole test depends on child 1 having already failed before start() is
  // called again. Wait for that rather than assuming 150 ms is enough.
  await waitFor(() => downEvents.length >= 1);

  check('initial child failure scheduled retry',
    downEvents.length === 1 && downEvents[0].attempt === 1,
    `downEvents=${downEvents.length}`);

  // 2. Caller directly calls start() before the 2000ms timer fires
  sidecar.start();

  // Wait for child 2 to start and report a frame.
  await waitFor(() => frames.length > 0);
  const framesAfterManualStart = frames.length;
  check('manual start successfully spawned replacement child',
    framesAfterManualStart > 0,
    `frames=${framesAfterManualStart}`);

  // 3. Wait past the original retry timer window (total wait > BASE_RETRY_MS)
  // This one stays a sleep on purpose: it proves an ABSENCE -- that the
  // cancelled retry timer never fires -- and there is no condition to wait
  // for. Slack raised from 500 ms so a loaded machine does not cut the window
  // short before the timer would have fired.
  await new Promise(r => setTimeout(r, BASE_RETRY_MS + 1500));

  let finalCount = 0;
  if (fs.existsSync(STATE_FILE)) {
    try { finalCount = parseInt(fs.readFileSync(STATE_FILE, 'utf8'), 10) || 0; } catch {}
  }

  await sidecar.stop();

  // If retryTimer was not cancelled, finalCount would be 3 (child 1 + manual start child 2 + timer child 3).
  // With cancellation, finalCount is exactly 2.
  check('start() disarms pending retryTimer avoiding duplicate child spawn',
    finalCount === 2,
    `total children spawned: ${finalCount} (expected 2)`);

  cleanupStateFile();
}

async function main() {
  console.log('\ntest-sidecar: supervisor start/stop and restart regression');
  await testControlSingleStart();
  await testRestartAfterStopSupervises();
  await testManualStartCancelsPendingRetryTimer();
  for (const mode of ['stay', 'ignore-stop']) {
    process.env.SIDECAR_TEST_MODE = mode;
    let pid;
    const sidecar = createSidecar({ repoRoot: path.join(__dirname, '../../..'),
      readerEntry: STUB_PATH, shutdownGraceMs: 100,
      onFrame: frame => { pid = frame.pid; },
      onDown: () => { throw Error('intentional shutdown must not retry'); },
    });
    sidecar.start();
    assert.ok(await waitFor(() => pid !== undefined));
    const events = [];
    const lifecycle = createLifecycle({ stop: () => {
      const first = sidecar.stop();
      assert.strictEqual(sidecar.stop(), first);
      return first.then(() => events.push('closed'));
    }, quit: () => events.push('quit'), relaunch: () => events.push('relaunch'), focus() {} });
    const done = lifecycle.beforeQuit({ preventDefault() {} });
    lifecycle.secondInstance(); lifecycle.secondInstance();
    await done;
    assert.deepStrictEqual(events, ['closed', 'relaunch', 'quit']);
    assert.throws(() => process.kill(pid, 0), 'old process has exited before relaunch');
  }
  return failures;
}

if (require.main === module) main().then(f => process.exit(f ? 1 : 0));
module.exports = { main };
