'use strict';
// The readout as a stream: one JSON object per line on stdout, at POLL_MS.
// app/main.js parses this shape.
//
// stdout carries data and nothing else -- the attach banner and any fatal
// error go to stderr, because a consumer splitting on newlines cannot be
// handed prose. A failed poll is emitted as an {"error": ...} line rather
// than killing the stream.
//
// The stdin dead-man's switch is armed below. It backstops a hard external
// kill of the Electron parent (Task Manager "End Task", `taskkill /F`) that
// no JS cleanup handler runs for: the OS closes every handle the terminated
// process owned, including this pipe's write end, so the read here sees EOF
// and the reader exits itself rather than surviving as an orphan still
// attached to the game.

const fs = require('fs');
const path = require('path');
const { readState, POLL_MS, SWEEP_INTERVAL, PROCESS_NAME } = require('./state');

// Exit status for "the game isn't there" -- either it has not started yet, or
// it was running and has now closed. Deliberately distinct from 1 (a genuine
// fault: a PID that does not exist, a refused OpenProcess, several copies
// running, a reader bug), because the supervisor treats the two differently:
// this one is a steady wait for the game to come back, not a failure to back
// off from.
// KEEP IN SYNC WITH app/sidecar.js's EXIT_NO_GAME.
const EXIT_NO_GAME = 3;

/**
 * Exit when the parent that spawned us goes away, but ONLY when stdin is
 * actually a pipe from that parent.
 *
 * The gate matters as much as the switch. Arming unconditionally would kill
 * every other way of running this: a console inherits a stdin that is at EOF
 * or never readable, and `> file` and `< NUL` do too, so an unconditional
 * watcher exits instantly and prints nothing.
 *
 * isFIFO() is not the test: on Windows, Node reports a spawned pipe as
 * neither a FIFO nor a character device -- measured as isFIFO() false,
 * isCharacterDevice() false, constructor Socket, while a console and a
 * `stdio: 'ignore'` handle both come back isCharacterDevice() true. So the
 * gate is written from what is actually distinguishable: not a character
 * device, not a regular file, not a TTY.
 *
 * Data is discarded rather than treated as a signal. Nothing is ever written
 * to this pipe, but a producer that did write must not be mistaken for a
 * parent that died -- only EOF means that.
 */
function armDeadMansSwitch(onDead) {
  let st;
  try { st = fs.fstatSync(0); } catch { return false; }
  const isPipe = !st.isCharacterDevice() && !st.isFile() && !process.stdin.isTTY;
  if (!isPipe) return false;
  process.stdin.on('data', () => {});
  process.stdin.on('end', onDead);
  process.stdin.on('close', onDead);
  process.stdin.on('error', onDead);
  process.stdin.resume();
  return true;
}

function main(argv) {
  let pid = null;
  if (argv.length) {
    pid = parseInt(argv[0], 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      process.stderr.write(`not a PID: ${argv[0]}\n`);
      process.exit(1);
    }
  }

  let reader = null;
  // Assigned below, once the poll timer exists; declared here because the
  // game-exited path inside tick() calls it.
  let stopping = null;
  let stop = () => Promise.resolve();
  const exitAfterStop = (code) => {
    if (stopping) return stopping;
    stopping = stop().then(() => process.exit(code), error => {
      process.stderr.write(`reader shutdown failed: ${error.message}\n`);
      process.exit(1);
    });
    return stopping;
  };
  const { Reader } = require('./reader');
  try {
    reader = new Reader(pid);
  } catch (e) {
    process.stderr.write(String(e.message || e) + '\n');
    // findPid tags the nothing-is-running case; everything else that can
    // fail in the constructor needs a human, not a retry loop.
    process.exit(e && e.code === 'ENOGAME' ? EXIT_NO_GAME : 1);
  }
  process.stderr.write(`${PROCESS_NAME} pid ${reader.pid}, module base 0x`
    + reader.base.toString(16).toUpperCase().padStart(16, '0')
    + ` -- first sweep takes a second or two, then every ${SWEEP_INTERVAL}s\n`);

  const tick = () => {
    if (stopping) return;
    // The game closing does not end this process by itself. Our handle stays
    // valid -- that is what a handle is -- ReadProcessMemory simply starts
    // failing, and every failed read is reported as `null`, which is the same
    // thing the reader says about an address this sweep has not resolved. So
    // without this check the reader sits attached to a dead PID emitting a
    // fully-dashed frame forever, and a restarted game (which gets a NEW pid)
    // is never picked up. Exiting hands that to the supervisor, whose
    // existing restart re-runs findPid and attaches to whatever is running
    // now.
    if (reader && !reader.alive()) {
      process.stderr.write(`${PROCESS_NAME} has exited -- waiting for the game to start again\n`);
      void exitAfterStop(EXIT_NO_GAME);
      return;
    }

    let line;
    try {
      const state = readState(reader, {
        runtime: {
          sweeps: reader.sweeps, found: reader.found(),
          pid: reader.pid, base: reader.base,
          install_dir: path.dirname(reader.exePath),
          placement_misses: reader.placementMisses,
        },
      });
      state.poll_ms = POLL_MS;
      state.sweep_interval = SWEEP_INTERVAL;
      line = JSON.stringify(state);
    } catch (e) {          // a dead handle shouldn't end the stream
      line = JSON.stringify({ error: String(e.message || e) });
    }
    process.stdout.write(line + '\n');
  };

  // `timer` is read lazily inside stop() rather than captured, so the first
  // tick() -- which runs before setInterval below -- can still stop cleanly
  // if it finds the game already gone.
  let timer = null;
  stop = () => {
    if (timer) clearInterval(timer);
    return reader ? reader.close() : Promise.resolve();
  };

  reader.onSandmanChange = () => {
    tick();
    if (timer && !stopping) {
      clearInterval(timer);
      timer = setInterval(tick, POLL_MS);
    }
  };
  reader.onRunSummary = reader.onSandmanChange;

  tick();
  if (!stopping) timer = setInterval(tick, POLL_MS);
  process.on('SIGINT', () => { void exitAfterStop(0); });
  process.on('SIGTERM', () => { void exitAfterStop(0); });
  process.stdout.on('error', () => { void exitAfterStop(0); });

  let dead = false;
  armDeadMansSwitch(() => {
    if (dead) return;   // end/close/error can all fire for one disappearance
    dead = true;
    void exitAfterStop(0);
  });
}

module.exports = { main, EXIT_NO_GAME };
if (require.main === module) main(process.argv.slice(2));
