# Ravenswatcher development

This is the standalone Electron application. No private dump, Python
interpreter, or extracted game files are required to build or test.

See [architecture.md](architecture.md) for runtime boundaries, data inputs,
and measured reader constraints, and [CONTRIBUTING.md](../CONTRIBUTING.md)
for code conventions.

## Running from source

On Windows with Node.js 22.15 or newer, from the repository root:

```powershell
cd app
npm ci
npm run typecheck
npm test
npm start
```

TypeScript compiles in place. Edit `.ts` sources; generated JavaScript,
declarations, and source maps are ignored. Unconverted `.js` files are
source. `npm run typecheck` checks types without emitting files.

After building, `node app/reader/stdio.js` also runs the reader from the
repository root. It reads the running game; it is not a synthetic test.

## Building the portable zip

From `app/`, run `npm run dist`. It compiles TypeScript, generates an
original lettermark icon, stages runtime files, and invokes electron-builder.
Output is `build/release/` at the repository root: `win-unpacked/` and a zip.
Tests, probes, TypeScript sources, and source maps do not ship. The MIT
license and third-party notices are included. Koffi's native binary is
unpacked beside the asar because it cannot load from inside the archive.

The Windows build is unsigned, so SmartScreen may warn on first launch.
See the [repository README](../README.md) for player installation instructions.

Staging copies readable runtime code without obfuscation. It excludes tests,
benchmarks, TypeScript sources and maps, and verifies that decoded game assets do
not ship. Native Koffi files and the bundled fonts and license notices remain included.

## Installing a rebuild

A build does not update another installed copy. Close that copy, then run
`app/install.ps1 -InstallDir "<your install directory>"` from the repository
root. The helper builds, backs up the existing install, then mirrors the
output. `-SkipBuild` installs an existing build. The destination must be a
dedicated Ravenswatcher installation directory.

## Tests

`npm test` builds and runs reader and Electron renderer suites with
synthetic memory and resource fixtures. It never attaches to the game.
Optional checks in the asset cipher suite require an explicit
`RAVENSWATCH_INSTALL`; normal tests do not search Steam libraries.

`app/reader/bench/` contains opt-in live probes, separate from the test command.
Read each probe before running it; several attach or write diagnostic logs.

### Reader diagnostics

Run the following from `app/reader/`, after building. These are reference
commands, not part of the normal test suite. Only run live probes or collect
new diagnostic data when explicitly requested for the current task.

```text
node test/run-all.js           reader suites and Electron renderer suites;
                               spawns synthetic target processes
node bench/scan-bench.js       pattern-scan throughput on synthesised buffers
node bench/rpm-bench.js        end-to-end sweep against a spawned ~2 GB process
node bench/placement-bench.js  end-to-end placement sweep against a live process
node bench/placement-profile.js  the same sweep, split into its stages and timed
node bench/melody-bench.js     end-to-end melody registry, pool, and state diagnostics
node bench/launch-watch.js     waits for the game to start, then records the
                               whole frame plus sweep internals from before
                               the process exists, through both menus and a
                               load, into a run -- one JSONL object per change
node bench/launch-watch.js --diagnostics
                               adds worker messages, raw bindings/rosters and
                               an attachment-time RTTI/static-anchor check;
                               writes a fresh build/compatibility-*.jsonl
                               at the repo root. Start before launching the
                               game; stop with Ctrl+C. Does not decode assets.
node bench/transition-watch.js watches map id, melodies and hero level across a
                               map or run boundary
node bench/melody-transition-watch.js  the melody channel alone, 250 ms, with no
                               scan while the payload is up -- times an outage
                               without the classification scans inflating it
node bench/run-start-watch.js  map id against Hero Level as a run starts, plus
                               the scene context address each run lands on
node bench/spell-control.js    tells a real marker path from a misspelled one
                               with no run loaded -- ABSENT means misspelled
node bench/verify-map.js       runs the marker check for the current map
```
