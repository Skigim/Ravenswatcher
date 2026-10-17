'use strict';
// Every test in this prototype. None of them attach to Ravenswatch.exe.
const path = require('path');
const { spawnSync } = require('child_process');

const SUITES = [
  ['test-readonly', () => require('./test-readonly').main()],
  ['test-value-types', () => require('./test-value-types').main()],
  ['test-rtti-pefile', () => require('./test-rtti-pefile').main()],
  ['test-chain', () => require('./test-chain').main()],
  ['test-placement', () => require('./test-placement').main()],
  ['test-scan-retry', () => require('./test-scan-retry').main()],
  ['test-binding-cache', () => require('./test-binding-cache').main()],
  ['test-questline', () => require('./test-questline').main()],
  ['test-stdio', () => require('./test-stdio').main()],
  ['test-cadence', () => require('./test-cadence').main()],
  ['test-reattach', () => require('./test-reattach').main()],
  ['test-worker-lifecycle', () => require('./test-worker-lifecycle').main()],
  ['test-melodies', () => require('./test-melodies').main()],
  ['test-sandman', () => require('./test-sandman').main()],
  ['test-tiles', () => require('./test-tiles').main()],
  ['test-tiles-view', () => require('./test-tiles-view').main()],
  ['test-sidecar', () => require('./test-sidecar').main()],
  ['test-external-links', () => require('./test-external-links').main()],
  ['test-item-tables', () => require('./test-item-tables').main()],
  ['test-assets-cipher', () => require('./test-assets-cipher').main()],
  ['test-assets-texture', () => require('./test-assets-texture').main()],
  ['test-assets-png', () => require('./test-assets-png').main()],
  ['test-assets-tables', () => require('./test-assets-tables').main()],
  ['test-assets-build', () => require('./test-assets-build').main()],
  ['test-no-shipped-content', () => require('./test-no-shipped-content').main()],
  ['test-coop', () => require('./test-coop').main()],
  ['test-update', () => require('./test-update').main()],
  ['test-runs', () => require('./test-runs').main()],
  ['test-history', () => require('./test-history').main()],
];

// Suites that cannot run in this process. test-seams drives the real page in
// a real window, so it needs an Electron runtime rather than plain node, and
// it reports through its own exit code.
const SPAWNED = [
  ['test-seams', path.join(__dirname, '..', '..', 'web', 'test', 'test-seams.js')],
  ['test-coop-consent', path.join(__dirname, '..', '..', 'web', 'test', 'test-coop-consent.js')],
  ['test-tile-cols', path.join(__dirname, '..', '..', 'web', 'test', 'test-tile-cols.js')],
  ['test-hover', path.join(__dirname, '..', '..', 'web', 'test', 'test-hover.js')],
  ['test-tile-done', path.join(__dirname, '..', '..', 'web', 'test', 'test-tile-done.js')],
  ['test-update-bar', path.join(__dirname, '..', '..', 'web', 'test', 'test-update-bar.js')],
  ['test-history-view', path.join(__dirname, '..', '..', 'web', 'test', 'test-history-view.js')],
];

/**
 * Resolve the Electron binary, or null when it isn't installed.
 *
 * `require('electron')` from plain node yields the path to the executable;
 * under Electron itself it yields the module object, which is not what this
 * wants, hence the typeof check.
 */
function electronBinary() {
  try {
    const resolved = require('electron');
    return typeof resolved === 'string' ? resolved : null;
  } catch {
    return null;
  }
}

// How long a spawned suite may run before it is treated as hung and killed.
//
// Without a bound this harness can wait forever. spawnSync blocks until the
// child exits, and a suite that never reaches app.exit() -- a check that never
// resolves, a rejection before whenReady -- leaves node and Electron both
// alive with the run looking like it is still going. Observed live: a stuck
// pair sat for ~50 minutes after a test run, and the blocked node only exited
// once the Electron was killed by hand.
//
// test-seams measured 564/579/604 ms across three consecutive runs, so this is
// roughly a hundredfold margin -- wide enough that a loaded machine never
// trips it, short enough that a hang is noticed in the same sitting.
const SPAWN_TIMEOUT_MS = 60_000;

/**
 * Run one spawned suite and return its failure count.
 *
 * A missing Electron counts as a failure rather than a skip. A skip prints
 * next to a row of PASSes and reads as one, which is how this suite sat
 * unwired and unnoticed in the first place -- nothing was covering the page.
 *
 * A hang counts as a failure too, for the same reason: a harness that blocks
 * forever reports nothing at all, which is worse than reporting a failure.
 * spawnSync's own timeout terminates the direct child; Electron's helper
 * processes are its children and go with it. That is not airtight -- a helper
 * can in principle outlive an abruptly terminated parent -- but the observed
 * leak was the main Electron itself, which this does cover.
 */
function runSpawned(name, entry, electron) {
  if (!electron) {
    console.log(`\n${name}: NOT RUN -- no Electron binary. `
      + 'Run `npm install` in app/, which is where the devDependency lives.');
    return 1;
  }
  console.log(`\n--- ${name} (spawned under Electron) ---`);
  const res = spawnSync(electron, [entry], {
    stdio: 'inherit',
    timeout: SPAWN_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  if (res.error) {
    if (res.error.code === 'ETIMEDOUT') {
      console.log(`${name}: TIMED OUT after ${SPAWN_TIMEOUT_MS / 1000}s and was `
        + 'killed -- the suite never reached app.exit(). Counted as a failure.');
    } else {
      console.log(`${name}: FAILED TO SPAWN ${res.error.message}`);
    }
    return 1;
  }
  // The suite prints its own tally; only its verdict is needed here.
  return res.status === 0 ? 0 : 1;
}

(async () => {
  let total = 0;
  for (const [name, run] of SUITES) {
    let f;
    try { f = await run(); }
    catch (e) { console.log(`\n${name}: THREW ${e.stack}`); f = 1; }
    // Each suite counts its own failures independently, so these add up.
    total += f || 0;
  }

  const electron = electronBinary();
  for (const [name, entry] of SPAWNED) total += runSpawned(name, entry, electron);


  console.log(`\n${total === 0 ? 'ALL SUITES PASSED' : total + ' FAILURE(S)'}`);
  process.exit(total ? 1 : 0);
})();
