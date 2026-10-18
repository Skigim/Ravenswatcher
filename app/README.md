# Ravenswatcher development

This is the standalone Electron application. No private dump, Python
interpreter, or extracted game files are required to build or test.

## Running from source

On Windows with Node.js 22.15 or newer, from the repository root:

```powershell
cd app
npm ci
npm test
npm start
```

TypeScript compiles in place. Edit `.ts` sources; generated JavaScript,
declarations, and source maps are ignored. Unconverted `.js` files are
source. `npm run typecheck` checks types without emitting files.

The shell runs `reader/stdio.js` using Electron's own Node runtime with
`ELECTRON_RUN_AS_NODE=1` and reads JSON frames over stdout. Nothing listens
on a port. After building, `node app/reader/stdio.js` also runs the reader
from the repository root.

## Building the portable zip

From `app/`, run `npm run dist`. It compiles TypeScript, generates an
original lettermark icon, stages runtime files, and invokes electron-builder.
Output is `build/release/` at the repository root: `win-unpacked/` and a zip.
Tests, probes, TypeScript sources, and source maps do not ship. The MIT
license and third-party notices are included. Koffi's native binary is
unpacked beside the asar because it cannot load from inside the archive.

The Windows build is unsigned, so SmartScreen may warn on first launch.
See the repository README for player installation instructions.

## Installing a rebuild

A build does not update another installed copy. Close that copy, then run
`app/install.ps1 -InstallDir "<your install directory>"` from the repository
root. The helper builds, backs up the existing install, then mirrors the
output. `-SkipBuild` installs an existing build. The destination must be a
dedicated Ravenswatcher installation directory.

## Runtime data

`app/value_types.json` contains name-to-type metadata, not live values. It
lives beside `main.js` in source and packaged builds. Developers may
explicitly override `RAVENSWATCH_VALUE_TYPES` or set `RAVENSWATCH_GEN_ROOT`
to an extracted GlobalValues directory. No dump repository is discovered.

Game art and the full item-description table are not included. On attach,
the app decodes the resources it needs from the installed game into
`game-assets/` under Electron's user-data directory. Until then, the page
can display names without art or descriptions. `web/assets/SOURCES.tsv`
maps cache filenames to game resource paths. The bundled Archivo font
retains its SIL Open Font License.

Staging copies readable runtime code without obfuscation. It excludes tests,
benchmarks, TypeScript sources and maps, and verifies that decoded game assets do
not ship. Native Koffi files and the bundled fonts and license notices remain included.

## Tests

`npm test` builds and runs reader and Electron renderer suites with
synthetic memory and resource fixtures. It never attaches to the game.
Optional checks in the asset cipher suite require an explicit
`RAVENSWATCH_INSTALL`; normal tests do not search Steam libraries.

`reader/bench/` contains opt-in live probes, separate from the test command.
Read each probe before running it; several attach or write diagnostic logs.

## Layout

```text
main.js              Electron lifecycle, IPC, asset:// protocol
sidecar.js           reader supervision and JSON frame transport
preload.js           sandboxed renderer subscriptions
update.js            once-per-launch GitHub release check
reader/              read-only Windows process reader
assets/              runtime resource decoders
web/                 HTML/CSS/JavaScript renderer
scripts/             reproducible icon and distribution staging
value_types.json     bundled type metadata
```

The reader requests only `PROCESS_QUERY_INFORMATION | PROCESS_VM_READ`.
It does not write memory, inject code, or request elevation. The update
check offers a link; it never downloads or installs automatically.
