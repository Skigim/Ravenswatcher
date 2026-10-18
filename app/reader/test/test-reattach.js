'use strict';
// Does the reader notice its target going away, and let itself be restarted
// onto the next one?
//
// The bug this pins down: a handle stays valid after its process exits, so
// every read simply starts failing and win32.js reports each failure as
// `null` -- exactly what an unresolved address looks like. Nothing crashed,
// nothing exited, so the supervisor never restarted the reader, and a game
// closed and started again (a NEW pid) was never picked up.
//
// Target is a throwaway Node child, never Ravenswatch.exe. That is the whole
// point: liveness has nothing to do with which process it is.

const { spawn } = require('child_process');
const path = require('path');
const win32 = require('../win32');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

/** A child that sits idle until killed, and a promise for its death. */
function spawnVictim() {
  const proc = spawn(process.execPath,
    ['-e', 'process.stdout.write("up\\n"); setInterval(() => {}, 1 << 30);'],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  const up = new Promise(res => proc.stdout.once('data', res));
  const dead = new Promise(res => proc.once('exit', res));
  return { proc, up, dead };
}

async function testHandleLiveness() {
  const { proc, up, dead } = spawnVictim();
  await up;

  const target = win32.openProcess(proc.pid);
  check('a running target reports alive', target.isAlive() === true);

  proc.kill();
  await dead;
  // The exit event fires when Node reaps the child; the kernel has already
  // signalled the process object by then, so no settling delay is needed.

  check('the same handle reports the exited target as gone',
    target.isAlive() === false);

  // The symptom, asserted directly: reads through the stale handle are
  // indistinguishable from "not resolved yet", which is why isAlive() has to
  // be asked rather than inferred.
  check('reads through the stale handle just come back null',
    target.readI32(0x10000) === null && target.readPtr(0x10000) === null);

  target.close();
  check('a closed handle reports gone rather than calling into Win32',
    target.isAlive() === false);
}

function testNotRunningIsTagged() {
  let err = null;
  try {
    win32.findPid('a-process-that-is-definitely-not-running-9f3c.exe');
  } catch (e) {
    err = e;
  }
  check('findPid tags "nothing is running" as ENOGAME',
    err !== null && err.code === 'ENOGAME', err ? `code=${err.code}` : 'did not throw');
}

function testExitCodesAgree() {
  // Two literals, one meaning -- the supervisor cannot require the reader's
  // module (it must not load koffi in the Electron main process), so the
  // constant is written twice with a KEEP IN SYNC comment. This is the check
  // that keeps that honest.
  const { EXIT_NO_GAME: fromReader } = require('../stdio');
  const { EXIT_NO_GAME: fromSupervisor } = require('../../sidecar');
  check('reader and supervisor agree on the no-game exit status',
    fromReader === fromSupervisor && fromReader === 3,
    `reader=${fromReader}, supervisor=${fromSupervisor}`);
}

/**
 * End to end: attach the real stdio entry point to a live target, watch it
 * stream, kill the target, and require the reader to exit with the no-game
 * status instead of streaming dashes forever.
 */
async function testReaderExitsWhenTargetDies() {
  const { proc: victim, up, dead } = spawnVictim();
  await up;

  const reader = spawn(process.execPath,
    [path.join(__dirname, '..', 'stdio.js'), String(victim.pid)],
    { stdio: ['pipe', 'pipe', 'pipe'] });

  let frames = 0;
  let buffered = '';
  reader.stdout.on('data', (c) => {
    buffered += c.toString('utf8');
    let at;
    while ((at = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      if (line.trim()) frames += 1;
    }
  });
  let stderrText = '';
  reader.stderr.on('data', (c) => { stderrText += c.toString('utf8'); });

  const exited = new Promise(res => reader.once('close', (code) => res(code)));

  // Wait for proof it is streaming before taking the target away, so a exit
  // for some unrelated startup reason cannot pass as the behaviour under
  // test.
  await new Promise(res => setTimeout(res, 800));
  const framesBeforeKill = frames;
  check('the reader streams frames while its target lives', framesBeforeKill > 0,
    `${framesBeforeKill} frame(s)`);

  victim.kill();
  await dead;

  const code = await Promise.race([
    exited,
    new Promise(res => setTimeout(() => res('timeout'), 5000)),
  ]);
  if (code === 'timeout') {
    reader.kill();
    check('the reader exits once its target is gone', false,
      `still running after 5s, ${frames - framesBeforeKill} further frame(s)`);
    return;
  }
  check('the reader exits once its target is gone', true, `code=${code}`);
  check('it exits with the no-game status, not a fault', code === 3, `code=${code}`);
  check('and says why on stderr', /has exited/.test(stderrText),
    JSON.stringify(stderrText.slice(-120)));
}

async function main() {
  console.log('\ntest-reattach: noticing the target process going away');
  await testHandleLiveness();
  testNotRunningIsTagged();
  testExitCodesAgree();
  await testReaderExitsWhenTargetDies();
  return failures;
}

if (require.main === module) main().then(f => process.exit(f ? 1 : 0));
module.exports = { main };
