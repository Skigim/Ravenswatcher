'use strict';
// Does the sweep worker thread lifecycle integrate correctly with the parent
// Reader without clobbering fatal error states or treating planned shutdowns
// as crashes?
//
// Target is a throwaway Node child, never Ravenswatch.exe.

const { spawn } = require('child_process');
const { Reader } = require('../reader');

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

/**
 * A deliberate close() must not set fatal.
 *
 * Reader.close() terminates the worker thread, which fires the worker's
 * 'exit' event. Because this is an intentional shutdown, Reader.close() sets
 * this.closing = true to prevent the exit handler from marking the reader as
 * crashed.
 */
async function testDeliberateCloseDoesNotSetFatal() {
  const { proc, up, dead } = spawnVictim();
  await up;

  const reader = new Reader(proc.pid);
  const workerExited = new Promise(res => reader.worker.once('exit', res));

  const closing = reader.close();
  check("repeated close shares its completion", reader.close() === closing);
  await closing;
  await workerExited;

  check('a deliberate close() does not set fatal', reader.fatal === null,
    reader.fatal ? `fatal=${reader.fatal}` : '');

  proc.kill();
  await dead;
}

/**
 * An unexpected worker exit must not clobber a specific fatal message.
 *
 * Against a stand-in Node process, the sweeper fails to resolve Ravenswatch's
 * RTTI vtables and posts a specific fatal message before returning from main(),
 * causing the worker thread to exit on its own. The exit event must not
 * overwrite that specific diagnostic with a generic "worker exited unexpectedly"
 * message.
 */
async function testWorkerExitDoesNotClobberSpecificFatal() {
  const { proc, up, dead } = spawnVictim();
  await up;

  const reader = new Reader(proc.pid);
  const workerExited = new Promise(res => reader.worker.once('exit', res));

  await workerExited;

  const isSpecificRttiMessage = typeof reader.fatal === 'string'
    && /could not resolve RTTI vtables/.test(reader.fatal)
    && !/worker exited unexpectedly/.test(reader.fatal);

  check('an unexpected worker exit does not clobber a specific fatal',
    isSpecificRttiMessage,
    reader.fatal ? `fatal=${reader.fatal}` : 'fatal is null');

  const closing = reader.close();
  check("repeated close shares its completion", reader.close() === closing);
  await closing;
  proc.kill();
  await dead;
}

async function main() {
  console.log('\ntest-worker-lifecycle: sweeper thread lifecycle and exit handling');
  await testDeliberateCloseDoesNotSetFatal();
  await testWorkerExitDoesNotClobberSpecificFatal();
  return failures;
}

if (require.main === module) main().then(f => process.exit(f ? 1 : 0));
module.exports = { main };
