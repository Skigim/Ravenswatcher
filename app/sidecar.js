// Supervision of the reader process.
//
// This module owns the child process and nothing else: spawning it in either
// layout, parsing its newline-delimited JSON stdout, keeping a stderr tail
// for the down message, noticing when it goes away, restarting it with
// backoff, and draining it on shutdown with a bounded tree-kill fallback. It deliberately does NOT
// require('electron') and does NOT know any IPC channel name -- it hands
// parsed frames and down-notices to the two callbacks its caller supplies,
// and main.js decides what to do with them (which window, which channel).
// That keeps the seam at "process supervision" vs "app lifecycle", and it
// means this file can be exercised by a plain `node` script with no Electron
// runtime at all, which is how the failed-spawn path gets tested.

const { spawn, execFileSync } = require('child_process');
const path = require('path');

// Restart policy: automatic retry with backoff. Doubles from BASE_RETRY_MS
// up to MAX_RETRY_MS on each consecutive failure; resets the moment the
// sidecar proves it's alive by writing anything to stdout.
const BASE_RETRY_MS = 2000;
const MAX_RETRY_MS = 30000;
const SHUTDOWN_GRACE_MS = 30000;

// The reader exits with this when the game is simply not there -- it has not
// been started yet, or it was running and the player closed it. That is not a
// fault, so it does not feed the backoff: escalating to a 30s gap would mean
// the app can sit for half a minute after the game is back before it notices.
// Every other non-zero exit backs off.
// KEEP IN SYNC WITH app/reader/stdio.js's EXIT_NO_GAME.
const EXIT_NO_GAME = 3;

// Cap on how much stderr text we hold onto for the "down" message -- the
// sidecar only ever writes a couple of short lines (the attach banner, or a
// one-line fatal message), but this keeps a runaway stack trace from an
// unanticipated crash out of the renderer payload.
const STDERR_TAIL_LIMIT = 4000;

// Kills the sidecar's whole process tree, not just the direct child.
//
// The reader is Electron's own binary and its sweeps are worker threads, so
// there is normally nothing below the direct child. `taskkill /T` is a
// backstop: it costs nothing on a tree of one, and a reader process
// surviving the app that owns it, still attached to the game, is bad enough
// to guard against with no known path to it.
//
// The fallback also serves fatal app exits, where an asynchronous kill could race exit.
function killSidecarTree(proc) {
  if (!proc || proc.pid == null) return;
  try {
    execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
      timeout: 2000,
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch (err) {
    // Non-zero exit (process already gone), timeout, or taskkill missing
    // from PATH all land here -- proc.kill() below is the fallback.
    console.error('[sidecar] taskkill failed:', err.message);
  }
  // Best-effort direct signal too, in case taskkill itself couldn't run
  // (missing from PATH, permissions) -- harmless if taskkill already won.
  try {
    proc.kill();
  } catch {
    // proc may already be gone; nothing to do.
  }
}

// createSidecar({packaged, resourcesPath, repoRoot, onFrame, onDown, readerEntry})
//   -> { start(), stop() }
//
// `packaged`, `resourcesPath` and `repoRoot` are passed in rather than read
// off `app`/`process` here, for the same reason the paths were app-relative
// in the first place: the two layouts are the seam where dev-works /
// packaged-fails, so the caller states which one it is instead of this file
// guessing. resourcesPath is only consulted in the packaged layout.
//
// `readerEntry` is an optional override for the child entry script, defaulting
// to ./reader/stdio.js. This lets tests drive the supervisor against a stub
// child rather than spawning the real reader.
//
// onFrame(frame)   -- one parsed JSON object from the reader's stdout.
// onDown({message, retryDelayMs, attempt}) -- the child went away (exited,
//   or never started at all) and a retry has been scheduled.
// Both are called with no `this`, may be omitted, and are the only way
// anything leaves this module.
function createSidecar({ packaged, resourcesPath, repoRoot, onFrame, onDown, readerEntry, shutdownGraceMs = SHUTDOWN_GRACE_MS }) {
  // Two layouts, one spawn. The reader is plain JS running on the Node
  // runtime Electron already ships, so there is no second interpreter to
  // locate: process.execPath IS the command in both layouts, with
  // ELECTRON_RUN_AS_NODE telling it to start as node rather than as an app.
  // From source and packaged therefore run the same command against the same
  // entry point, which is the whole reason there is no branch here.
  //
  // __dirname anchors the entry in both layouts without either branch
  // knowing which it is: this file sits at app/sidecar.js from source and at
  // app.asar/sidecar.js packaged, so ./reader/stdio.js resolves beside it
  // either way.
  const READER_ENTRY = readerEntry || path.join(__dirname, 'reader', 'stdio.js');

  // Stage-dist preserves this layout. Explicit environment overrides also
  // work for a developer investigating a patch with private research tools.
  const VALUE_TYPES_JSON = process.env.RAVENSWATCH_VALUE_TYPES
    || path.join(__dirname, 'value_types.json');
  const GEN_ROOT = process.env.RAVENSWATCH_GEN_ROOT || null;

  let proc = null;
  let stdoutBuffer = '';
  let stderrTail = '';
  let stopped = false;         // true once stop() has been called; suppresses retry
  let stopPromise = null;
  let shutdownTimer = null;
  let retryTimer = null;
  let retryAttempt = 0;

  function start() {
    if (proc) throw new Error("Wait for the previous reader to close before restarting.");
    stopPromise = null;
    // Reset stopped and cancel any pending retry timer before spawning.
    // If stop() was called earlier, stopped must be cleared or the next
    // exit handler treats any exit as intentional and never reconnects.
    // If an unexpected exit already scheduled a retry timer and caller
    // invokes start() explicitly before it fires, the timer must be
    // disarmed so it does not fire later and spawn a second child.
    stopped = false;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    stderrTail = '';
    stdoutBuffer = '';

    // stdin is a real pipe, not 'ignore' -- nothing is ever written to it.
    // It exists purely as a dead-man's switch for a hard external kill of
    // the *Electron main* process (Task Manager "End Task", `taskkill /F`)
    // that no JS cleanup handler gets a chance to run for: the OS closes
    // every handle a terminated process owned, including this pipe's write
    // end, so the sidecar's blocking stdin read in stdio.js returns EOF and
    // it exits itself. This is a backstop, not the primary mechanism --
    // normal shutdown closes this pipe and waits for the reader to drain.
    // A deadline or fatal error falls back to killSidecarTree().
    //
    // cwd MUST be a real directory on disk. Packaged, READER_ENTRY lives
    // inside app.asar, and its dirname is therefore a path no process can
    // chdir into -- Node's spawn fails that with ENOENT and, misleadingly,
    // names the *command* rather than the cwd, so the renderer shows
    // "failed to launch <the app's own exe>: ... ENOENT" for an executable
    // that is plainly running. Nothing the reader opens resolves against cwd
    // (both inputs arrive as absolute paths below), so this only has to
    // exist: resourcesPath packaged, the repo root from source.
    const command = process.execPath;
    const commandArgs = [READER_ENTRY];

    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1',
                  RAVENSWATCH_VALUE_TYPES: VALUE_TYPES_JSON };
    if (GEN_ROOT) env.RAVENSWATCH_GEN_ROOT = GEN_ROOT;

    // windowsHide is kept even though the Node reader has no console of its
    // own to show: process.execPath is a GUI-subsystem binary here, and the
    // flag costs nothing while covering any future change of command.
    proc = spawn(
      command,
      commandArgs,
      { cwd: packaged ? resourcesPath : repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env }
    );

    proc.stdout.on('data', handleSidecarStdout);
    proc.stderr.on('data', handleSidecarStderr);
    proc.on('error', (err) => {
      console.error('[sidecar] failed to start:', err);
      if (!stderrTail) stderrTail = `failed to launch ${command}: ${err.message}`;
    });
    // 'close', not 'exit'. A process that never started -- binary missing,
    // quarantined by AV, not executable -- emits 'error' and 'close' but
    // never 'exit', because there was no child to exit. Listening on 'exit'
    // alone means that case notifies nothing: no sidecar-down frame reaches
    // the renderer and no retry is ever scheduled, so the window sits
    // forever on index.html's static markup and looks like a healthy app
    // waiting on its first sweep. 'close' fires for
    // both that case and a normal exit, and carries the same (code, signal).
    proc.stdin.on('error', () => {}); // EOF may race a child that already exited.
    proc.on('close', handleSidecarExit);
  }

  // The reader's stdio.js writes one JSON object per line, but Node
  // hands stdout to us as arbitrary chunks -- a line can arrive split across
  // two 'data' events, or one chunk can carry several lines. Buffer text
  // until a newline shows up and only ever parse complete lines.
  function handleSidecarStdout(chunk) {
    if (stopped) return;
    // Any stdout at all is proof the sidecar attached successfully. Forget
    // the backoff history so a later, unrelated failure starts counting from
    // BASE_RETRY_MS again instead of picking up where a resolved problem left
    // off.
    retryAttempt = 0;

    stdoutBuffer += chunk.toString('utf8');

    let newlineAt;
    while ((newlineAt = stdoutBuffer.indexOf('\n')) !== -1) {
      const line = stdoutBuffer.slice(0, newlineAt);
      stdoutBuffer = stdoutBuffer.slice(newlineAt + 1);
      if (!line.trim()) continue;

      let frame;
      try {
        frame = JSON.parse(line);
      } catch (err) {
        // The line itself, not just the parser's complaint -- "Unexpected
        // token" says nothing about which frame broke or how. Truncated
        // because a runaway line shouldn't flood the log.
        console.error('[sidecar] unparseable state line:', err.message,
          '| line:', JSON.stringify(line.slice(0, 400)));
        continue;
      }
      // A successfully parsed frame means the tail is no longer diagnostic --
      // it's the attach banner or an old traceback that already did its job.
      // Clearing it here (not just on stdout arrival, which fires on partial
      // lines too) means a later exit's "down" message is only ever text
      // written *after* the last good frame, never a stale success banner
      // dragged forward from spawn time.
      stderrTail = '';
      if (onFrame) onFrame(frame);
    }
  }

  // stderr is diagnostic text, never a state frame -- piped straight through
  // to our own stderr. It's also the only place the reader's fatal message
  // (for example the "not running" line) ever appears, so the tail is kept to
  // hand to the renderer if the process then exits.
  function handleSidecarStderr(chunk) {
    process.stderr.write(`[sidecar] ${chunk}`);
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_LIMIT);
  }

  function handleSidecarExit(code, signal) {
    console.log(`[sidecar] exited (code=${code}, signal=${signal})`);
    proc = null;
    if (shutdownTimer) clearTimeout(shutdownTimer);
    shutdownTimer = null;
    if (stopped) return; // the app asked for this; don't reconnect

    // "Waiting for the game" is a steady poll at the base delay, not a fault
    // to back off from, and it must not leave the counter raised either --
    // otherwise the first genuine failure after a session of waiting starts
    // partway up the curve.
    const waitingForGame = code === EXIT_NO_GAME;
    retryAttempt = waitingForGame ? 0 : retryAttempt + 1;
    const delay = waitingForGame
      ? BASE_RETRY_MS
      : Math.min(BASE_RETRY_MS * 2 ** (retryAttempt - 1), MAX_RETRY_MS);
    const message = stderrTail.trim() || `sidecar exited unexpectedly (code=${code}, signal=${signal})`;
    console.log(`[sidecar] down: ${message} (retrying in ${delay}ms${waitingForGame ? '' : `, attempt ${retryAttempt}`})`);

    if (onDown) {
      onDown({
        message,
        retryDelayMs: delay,
        attempt: retryAttempt,
      });
    }

    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!stopped) start();
    }, delay);
  }

  // Holds until the next start(): `stopped` suppresses the retry that the
  // exit handler would otherwise schedule.
  function stop() {
    stopped = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (stopPromise) return stopPromise;
    if (!proc) return (stopPromise = Promise.resolve());
    const target = proc;
    stopPromise = new Promise(resolve => {
      target.once('close', () => resolve());
      shutdownTimer = setTimeout(() => {
        console.error('[sidecar] graceful shutdown timed out; stopping reader process');
        killSidecarTree(target);
      }, shutdownGraceMs);
      target.stdin.end();
    });
    return stopPromise;
  }

  function forceStop() {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    if (shutdownTimer) clearTimeout(shutdownTimer);
    shutdownTimer = null;
    killSidecarTree(proc);
  }

  return { start, stop, forceStop };
}

module.exports = {
  createSidecar,
  killSidecarTree,
  EXIT_NO_GAME,
  BASE_RETRY_MS,
  MAX_RETRY_MS,
  SHUTDOWN_GRACE_MS,
  STDERR_TAIL_LIMIT,
};
