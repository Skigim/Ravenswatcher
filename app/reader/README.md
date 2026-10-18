# The memory reader, in Node

This is the reader the Electron app runs, and the only one. It replaced a
PyInstaller-frozen Python sidecar: Electron already ships a Node runtime, so
the ~49 MB second interpreter had no reason to be in the bundle, and freezing
it was half the build.

## What it produces

A fixed-size JSON object, one line per poll on stdout — the contract
`app/sidecar.js` parses. `test-stdio` asserts the key count, so a field
added to `readState` without updating that assertion fails the suite.

Raw *lines* differ even when the objects match — Python's `json.dumps`
emits `", "` separators and `\uXXXX` escapes, `JSON.stringify` emits
neither. Anything comparing bytes rather than parsed objects needs to know
that.

## Layout

The tree is a file-by-file TypeScript port. A `.ts` file compiles in place
to a gitignored `.js` beside it; edit the `.ts`. Files listed as `.js` are
tracked JavaScript.

```
win32.js       koffi bindings. Read-only by construction: no write or inject
               primitive is bound, and openProcess() takes no access-mask
               argument a caller could widen.
pe.ts          PE section headers out of a mapped image
pefile.js      a .read() source backed by a PE file on disk, so the RTTI walk
               can be exercised without attaching to anything
rtti.js        TypeDescriptor -> Complete Object Locator -> vtable, and the
               inverse (vtable -> class name)
scan.js        the sweep primitive: every 8-byte-aligned occurrence of a
               target set, one pass for all targets
values.ts      discover_values.py: name index, binding join, both union
               variants, .gen/JSON type map
struct_offsets.json
               the struct layout values.ts and discover_values.py share
placement.js   which entities the map generator actually placed
melodies.ts    4th channel: 3-melody pool resolution and per-slot lifecycle
sandman.ts     the shop channel: six offers, prices and sold state, read off
               the menu controller's fixed slot array at +0x178
sandman-worker.ts
               the shop read on its own worker thread
tiles.ts       the placed-tile roster and its reward selectors
tiles-worker.ts
               the roster read on its own worker thread
runs.ts        the run-end channel: run record, selected talents, score page
               and the score readiness rule
runs-worker.ts the end-of-run capture on its own worker thread
state.ts       the output contract
sweeper.js     the discovery sweep (values, placement, melodies), on a
               worker thread
worker-control.ts stop messages and interruptible waits
reader.js      attach + poll + asynchronous cooperative close
stdio.js       one JSON object per line on stdout
```

```
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

`test/`, `bench/` and this file are excluded from `build.files` and do not
ship.

## Constraints that bite a future edit

Three measured constraints govern the scan and the FFI layer: `koffi.view()`
is fatal under Electron, the sweep must stay on a worker thread, and the scan
loop must not touch BigInt. The tests cover these constraints. The fourth is
specific to this reader:

**The placement scan is the expensive thing, and it is triggered by an
observed transition, not a timer.** `placedAmong()` sweeps writable memory
several times over. It measured 3.7 s against a 1.5 GB working set, and 4.6 to
10.3 s across a live three-map run with a second reader attached. Expect the
range, not the 3.7 s — the cost moves with working-set size, session age, and
what else is reading. Measure it before making anything depend on a number.
It runs only while the current map generation has no conclusive answer, and stops
entirely once it does — a settled run performs none. The generation is the
map id, tracked by the sweeper independently of the map id stored on the
placement answer. That separation is the whole mechanism: while
`Current map id` reads `-1` no scan runs, so the answer is not updated, so
comparing the live id against the answer's id cannot see a restart onto the
same map. Do not reintroduce a cadence, a retry budget, or a level-based
edge here; each was tried, and each was compensating for that missed
transition rather than fixing it.

## Shutdown and transitions

`Reader.get()` only reads values. `readState()` reads hero level and map id once,
applies `updateTransitions()`, then snapshots the channel data. Both reset triggers
retain the same Live clear behavior; chapter changes preserve melodies and History
retains its separate last-in-run snapshot.

`Reader.close()` returns an idempotent promise. Workers finish synchronous work,
process a stop message, close their own read-only handle, and exit. The stdio process
awaits that promise before exiting. Normal supervisor shutdown closes stdin and waits;
a 30-second fallback kills the whole reader process rather than terminating individual
workers in the middle of native calls.

## Reader inputs

`struct_offsets.json` holds the measured layout constants. It is loaded
relative to this module and validated as hex strings, so an omitted key or
a JSON number where a hex string is required produces a startup error.

`../value_types.json` supplies the default name-to-type map in source and
packaged layouts. It is metadata, not a census of live values. Names absent
from it still resolve but have no declared type.

`RAVENSWATCH_VALUE_TYPES` explicitly overrides that JSON path.
`RAVENSWATCH_GEN_ROOT` optionally supplies an extracted GlobalValues tree.
The tree overrides the JSON per name; a partial tree leaves other JSON
entries intact. Neither input is discovered in another repository. The
synthetic tests exercise parsing, malformed records, and partial-tree merge.

## Traps checked against the port

The regression tests cover these reader-specific constraints:

- **Map ids start at 0.** Nothing hardcodes an id; `sweeper.js` reads the
  `"<Map name> map id"` constants out of the index the way
  `discovery_worker` does. Every test in `state.js` is `!== null`, never
  truthiness, so Dark Hills' `0` is never mistaken for absent. Covered by
  `test-chain`'s map-table assertion.
- **A zero is a real reading, distinct from unresolved.** `null` is
  unresolved, `0` is a value, and every test in `state.js` is `!== null`
  rather than truthy. Covered by `test-chain` and by the `storm` fixture's
  envelope parity.
- **The values index is held, and rebuilt on four signals.** `sweeper.js`
  builds the index once and keeps it; `indexRebuildDue` pays for another
  build when there is no index, when any tracked name does not resolve `ok`
  (the union-vtable check on a held binding, or the main menu), on a map
  change, or on a run reset. Measured with `bench/binding-stability.js`:
  every tracked binding held its address across two run restarts and six
  level-ups over 230 independent rebuilds. A map change within a run is the
  one event not yet observed — the rebuild on map change covers it either
  way. `reader.js` still replaces the resolved table wholesale on every
  sweep rather than merging, so a name that stops resolving disappears
  instead of lingering. Covered by `test-binding-cache` and `test-chain`.

  The hero-controller set is the other cache, which `melodies.findHeroes` keeps
  because a cold scan costs ~650 ms. That cache short-circuits on any single
  live address, which would hide a controller allocated *alongside* a live one
  — a second player joining mid-run. `sweeper.js` therefore forces it cold
  every `HERO_RESCAN_SWEEPS` (4) sweeps. The fallback that runs when a pool
  will not resolve must try the source the first attempt did **not** use;
  repeating a cold scan costs a second full heap pass for a result that cannot
  differ. `heroRescanDue` and `fallbackHeroSource` are exported for exactly
  that reason, and `test-questline` pins both.
- **The only argument is an optional PID.** `stdio.js` rejects anything that
  does not parse as one, rather than handing `NaN` to `OpenProcess`, which
  reports `GetLastError=87` instead of the game-not-running message.
- **`handle` is reserved on a request handler.** Not applicable — no HTTP
  front end is ported.
