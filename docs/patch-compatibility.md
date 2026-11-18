# Recovering after a Ravenswatch patch

## Recognize this failure pattern

A patch can move module-relative addresses without changing the object layouts.
The app still opens, but Live stays on its loading curtain because `ready` never
becomes true. On 2026-11-17 the reader attached successfully and resolved the
RTTI classes and melody roster, but found **0/13 tracked values**. Its binding
vtable constant was stale, and both static scene/game roots contained invalid
pointers. Updating three measured RVAs restored the readout; no field offsets
needed changing.

Do not remove the ready gate to conceal the failure, guess offsets, or apply a
single numeric delta to every address. RTTI discovery surviving a patch does
not prove that instance layouts or fixed roots still work. `binding_vt_ready`
is currently set after adding the stored RVA to the module base; it is not
proof that live bindings were found.

## Capture the failing reader

Only collect live game data when explicitly authorized for the current task.
Build from `app/` with `npm run build`, then run this from the repository root:

```powershell
node app/reader/bench/launch-watch.js --diagnostics
```

The logger waits for `Ravenswatch.exe` and writes a fresh
`build/compatibility-<timestamp>.jsonl`. Load a run and, when checking shop
offers, open the Sandman shop. Look at `attached`, `anchors`, worker diagnostics,
`found`, `resolved`, `map_id`, `ready`, and the individual channel statuses.
An attachment-time root can legitimately be null before the scene exists;
validate it again inside a loaded run before diagnosing a stale address.

If the logger waits while the game is visibly running, verify process visibility
before changing discovery code. A sandbox can see only its own processes.
Inspect the host process list and, if needed, attach explicitly:

```powershell
Get-Process | Where-Object ProcessName -eq 'Ravenswatch' | Select-Object Id, Path
node app/reader/bench/launch-watch.js --diagnostics --pid=<confirmed-pid>
```

Run both commands with host-process access; a PID does not bypass sandbox
isolation. The logger itself can run without a window. Launch the interactive
Ravenswatcher app with the desktop launcher, not a sandboxed or hidden shell
launch. Confirm an actual desktop window. A hidden app instance can hold the
single-instance lock and prevent later launches from displaying anything.

## Measure replacement anchors

Use the existing read-only process backend, `rtti.ts`, `scan.ts`, `values.ts`,
and `tiles.ts`. Record the executable SHA-256 along with every candidate RVA.
Keep raw captures in ignored `build/`; commit only the measured conclusions.

1. Resolve the settings and union vtables by RTTI with
   `rtti.resolveAllVtableRvas`. Use all candidates rather than assuming the
   first table is the right inheritance subobject.
2. Use one `scanPointers` pass over writable memory for settings and union
   instances. Decode settings names with `values.readSettingsName`.
3. For each union hit, subtract `UNION_OFFSET_BINDING` to get a candidate
   binding. Its pointer at `BINDING_SETTINGS_OFFSET` must refer to a decoded
   settings instance. Read its vtable at `BINDING_VTABLE_OFFSET`; subtract the
   module base to obtain the candidate binding RVA. Check that many named
   settings agree and that `values.readBinding` reports a valid union vtable
   and plausible values, including genuine zeros. This recovered 445 pairs
   in the November patch. Inverse RTTI identified the binding class below.
4. Resolve all game scene and game vtables by RTTI, find their instances, and
   inspect aligned pointer slots in the module's `.data` section for references
   to those instances. These slots are candidate static roots. Pass each to
   `tiles.findSpawnerByChain` using `staticRva` and `useDirectScene`; the scene
   and game routes should reach the same spawner. Compare it with the independent
   `tiles.findInstances` scan. Multiple slots may point to the same instance:
   one working snapshot alone does not establish a stable root.
5. Update `BINDING_VTABLE_RVA` in `app/reader/struct_offsets.json` and
   `GAME_SCENE_STATIC_RVA` / `GAME_STATIC_RVA` in `app/reader/tiles.ts` only when
   supported by the measurements. If the chain or field layout changed too,
   investigate that change rather than copying the old offsets forward.

The old `tools/discover_values.py` references in source comments describe
historical tooling; that script is not part of this repository. The modules
above provide the read and scan primitives needed for the measurement.

## Validate and deliver

* Rebuild and start a **new reader process**: a running worker retains the old
  constants. Confirm the tracked values resolve, `ready=true`, the questline
  and map roster decode, and the Live curtain clears.
* Verify Sandman offers with the shop open, and check melody progress and run
  history separately. A resolved melody roster alone does not validate progress.
* Recheck roots after a chapter/map transition and a fresh game process. Record
  any untested cases instead of treating a single-map measurement as proof.
* Run `npm run typecheck`, `npm test`, and `npm run dist` from `app/`. Electron
  tests require an interactive host environment locally; sandbox launch failures
  must not be confused with reader regressions. CI covers Windows and Linux.
* Close the installed app and use `app/install.ps1 -InstallDir <directory>`
  (`-SkipBuild` for the existing build). Building alone does not update the
  installed copy. The helper keeps a rollback copy. Reopen with the desktop
  launcher and verify the window and Live output.
* For a release, update both package versions and the dated changelog, merge the
  reviewed fix, tag that merged commit, and dispatch `.github/workflows/release.yml`
  with the pushed tag. A tag alone does not publish a release. Confirm both the
  Windows ZIP and Linux tarball were attached.

## 2026-11-17 measurements (0.1.8)

Measured on Windows on 2026-11-17 against `Ravenswatch.exe`, SHA-256
`2a88a3bd564781935a3158154cf5f8f697b56d85d9c2b79ba5ef92cf960d68ef`.
Addresses below are module-relative RVAs, independent of ASLR.

| Anchor | Previous RVA | Patched RVA | Evidence |
| --- | --- | --- | --- |
| Value binding vtable | `0xF0D968` | `0xF126D8` | 445 settings/binding pairs recovered through RTTI-resolved union instances; all share this vtable |
| Game scene root | `0x1438E90` | `0x14401D0` | Points to an RTTI-confirmed game scene; existing chain reaches the tile spawner |
| Game root | `0x146F8F8` | `0x1476C38` | Points to an RTTI-confirmed game; existing chain reaches the same scene and tile spawner |

The binding class is
`.?AV?$EntityCpntValueSignal@AEBVoCEntityValueUnion@@@oe@@`.
The settings, union, and binding field offsets still decode Hero Level,
Current map id, combat, Sandman gate, and dream shards with valid union vtables.
The old roots contain invalid pointers in the patched build.

With these replacements, the shipped Reader resolved all 13 tracked values,
reported `ready=true`, identified the pigs questline, and decoded 151 tile
entries on Dark Hills. Sandman offers were still pending with the shop closed.
The full Windows test suite passed; the Linux backend suite was skipped on
Windows.

Root measurements were taken in one Dark Hills run. Stability across chapter
transitions and a fresh game process still needs live verification. The local
measurement report is `build/patch-measurements.json` (not shipped).
