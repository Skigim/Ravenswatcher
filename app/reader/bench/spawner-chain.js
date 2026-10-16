'use strict';
// Test fixed pointer chains from static module roots down to oCDtEntityCpntTileSpawner.
//
// WHY. Locating oCDtEntityCpntTileSpawner by scanning writable memory costs
// ~900-1180 ms. The component is reallocated on every map load, but the owning
// game scene, level list, and entity spawner GameObjects are wired through a
// deterministic structural graph rooted at static module addresses. Reading
// the spawner via a fixed pointer chain turns a second-scale memory scan into a
// ~2 ms pointer traversal.
//
// Acceptance requires proving stability across maps: a chain is proven ONLY
// when it is read on two DIFFERENT maps in one process session, yielding each
// map's spawner matching tiles.findInstances.
//
// Usage:
//   node app/reader/bench/spawner-chain.js --label dark-hills --state state.json
//   ... load a different map ...
//   node app/reader/bench/spawner-chain.js --label avalon     --state state.json

const fs = require('fs');
const { openProcess, findPid, moduleBase } = require('../win32');
const { PROCESS_NAME } = require('../state');
const tiles = require('../tiles');
const rtti = require('../rtti');

const hex = n => `0x${n.toString(16).toUpperCase()}`;

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const label = arg('--label', 'run');
const statePath = arg('--state', null);

// ------------------------------------------------------------------ connect
let pid;
try {
  pid = findPid(PROCESS_NAME);
} catch (err) {
  console.error(`Target process ${PROCESS_NAME} not found: ${err.message}`);
  process.exit(1);
}

const mod = moduleBase(pid);
const proc = openProcess(pid);
const modLo = mod.base;
const modHi = mod.base + mod.size;

console.log('================================================================');
console.log(` Tile spawner pointer chain bench -- label "${label}"`);
console.log(` Process: ${PROCESS_NAME} (PID ${pid})`);
console.log(` Module:  ${hex(modLo)} .. ${hex(modHi)}  (${hex(mod.size)} bytes)`);
console.log('================================================================\n');

// --------------------------------------------------- ground truth via scan
const vtables = {};
const resolved = tiles.resolveVtables(proc, mod.base, vtables);
if (!resolved) {
  console.error('ERROR: could not resolve the tile spawner vtable via RTTI.');
  proc.close();
  process.exit(1);
}

const t0 = process.hrtime.bigint();
const discovered = tiles.findInstances(proc, resolved);
const findMs = Number(process.hrtime.bigint() - t0) / 1e6;

if (!discovered || !discovered.spawnerAddr) {
  console.error('ERROR: no oCDtEntityCpntTileSpawner instance in memory.');
  console.error('       Load a map before running this -- the component does not');
  console.error('       exist between maps.');
  proc.close();
  process.exit(1);
}

const expectedSpawner = discovered.spawnerAddr;
const expectedEntity = proc.readPtr(expectedSpawner + 0x08);

console.log('Ground truth (scan):');
console.log(`  Spawner: 0x${expectedSpawner.toString(16)} (found in ${findMs.toFixed(1)} ms)`);
console.log(`  Entity:  0x${expectedEntity ? expectedEntity.toString(16) : '0'}\n`);

// ---------------------------------------------------- Candidate Chains
//
// Chain 1: Direct Module static pointer to oCDtGameScene (GAME_SCENE_STATIC_RVA)
//   MODULE + GAME_SCENE_STATIC_RVA -> oCDtGameScene*
//   scene + 0x658      -> oCGameLevel* head (loaded levels linked list)
//   level + 0x10       -> next level, until one whose +0x80 array holds an
//                         oCEntitySpawnerGo (matched by vtable, not by name)
//   spawnerGo + 0x128  -> oCEntity* (owning entity)
//   entity + 0x190     -> oIEntityCpnt** cpntArray, searched by vtable for
//                         oCDtEntityCpntTileSpawner
//
// Chain 2: Module static pointer to oCDtGame (GAME_STATIC_RVA)
//   MODULE + GAME_STATIC_RVA -> oCDtGame*
//   game + 0x18        -> oCDtGameScene*
//   (subsequent hops identical to Chain 1)

// The level carrying the tile spawner is identified by what it CONTAINS, not by
// what it is called.
//
// The first version of this matched the level name against 'TileGeneration'.
// That name reads DarkHills\Map_Dark_Hills_LiveOps_Update5_TileGeneration, so
// the match depended on a suffix being shared by every chapter -- provable only
// by playing through to another chapter, which is a skill run, not a
// measurement. Asking instead "which level holds an oCEntitySpawnerGo" is a
// vtable comparison that knows nothing about map names, so the question stops
// needing an answer.
//
// Same reasoning for the two arrays below. Both held exactly one element on
// every Dark Hills read, and index 0 was correct every time -- but "correct on
// the map I could load" is what the name match had going for it too. Each array
// is searched for the right vtable rather than indexed at 0.
const spawnerGoVts = tiles.resolveVtableSet(proc, modLo, '.?AVoCEntitySpawnerGo@@\0');
const entityVts = tiles.resolveVtableSet(proc, modLo, '.?AVoCEntity@@\0');
const gameSceneVts = tiles.resolveVtableSet(proc, modLo, '.?AVoCDtGameScene@@\0');
const gameVts = tiles.resolveVtableSet(proc, modLo, '.?AVoCDtGame@@\0');

if (!spawnerGoVts.size) {
  console.error('ERROR: could not resolve .?AVoCEntitySpawnerGo@@ -- the structural');
  console.error('       level search has nothing to match on.');
  proc.close();
  process.exit(1);
}

function evaluateChain(name, staticRva, useDirectScene) {
  console.log(`== Evaluating ${name} ==`);

  const res = tiles.findSpawnerByChain(proc, modLo, {
    staticRva,
    useDirectScene,
    vtables: {
      spawnerVt: resolved.spawnerVt,
      spawnerGoVts,
      entityVts,
      gameSceneVts,
      gameVts,
    },
  });

  if (!res.ok) {
    console.log(`  [FAIL] ${res.diagnostic}`);
    return { ok: false, spawner: null, entity: null, ms: res.ms, hops: res.hops };
  }

  if (useDirectScene) {
    console.log(`  [hop 1] MODULE +0x${staticRva.toString(16)} -> oCDtGameScene at 0x${res.scene.toString(16)}`);
  } else {
    console.log(`  [hop 1] MODULE +0x${staticRva.toString(16)} -> oCDtGame at 0x${res.game.toString(16)}`);
    console.log(`  [hop 2] game + 0x18 -> oCDtGameScene at 0x${res.scene ? res.scene.toString(16) : 'null'}`);
  }

  const levelHop = res.hops - 1;
  console.log(`  [hop ${levelHop}] Level 0x${res.level.toString(16)} after ${res.levelsSeen}`
    + ` level(s), ${res.gosTried} spawner GO(s) tried`);
  console.log(`  [hop ${levelHop}] oCEntitySpawnerGo at 0x${res.go.toString(16)}`
    + ` (GO index ${res.goIndex})`);

  const reachedEntity = res.entity;
  const entityTyped = entityVts.size ? tiles.isA(proc, reachedEntity, entityVts) : null;
  console.log(`  [hop ${levelHop}] Owning oCEntity at 0x${reachedEntity.toString(16)}`
    + (entityTyped === null ? '' : entityTyped ? ' (vtable confirms oCEntity)'
      : ' (WARNING: vtable is not oCEntity)'));

  const reachedSpawner = res.spawner;
  const spawnerOk = reachedSpawner === expectedSpawner;
  const entityOk = reachedEntity === expectedEntity;
  console.log(`  [hop ${res.hops}] oCDtEntityCpntTileSpawner at 0x${reachedSpawner ? reachedSpawner.toString(16) : 'null'}`);
  console.log(`  Latency: ${res.ms.toFixed(3)} ms (total hops: ${res.hops})`);
  console.log(`  Status:  ${spawnerOk && entityOk ? 'MATCHES ground truth' : 'MISMATCH'}\n`);

  return {
    ok: spawnerOk && entityOk,
    spawner: reachedSpawner,
    entity: reachedEntity,
    ms: res.ms,
    hops: res.hops,
    staticRva,
  };
}

// Evaluate Candidates
const results = {
  chain1_direct_scene: evaluateChain(
    `Candidate 1: Direct Scene Anchor (MODULE + ${hex(tiles.GAME_SCENE_STATIC_RVA)})`,
    tiles.GAME_SCENE_STATIC_RVA,
    true
  ),
  chain2_game_singleton: evaluateChain(
    `Candidate 2: Game Singleton (MODULE + ${hex(tiles.GAME_STATIC_RVA)})`,
    tiles.GAME_STATIC_RVA,
    false
  ),
};

// ------------------------------------------------------ persist and compare
const record = {
  label,
  pid,
  expectedSpawner,
  expectedEntity,
  moduleBase: modLo,
  moduleSize: mod.size,
  results,
  timestamp: new Date().toISOString(),
};

if (!statePath) {
  console.log('No --state given, so nothing was saved and nothing can be compared.');
  console.log('Pass the same --state path on a second map to prove stability across maps.');
  proc.close();
  process.exit(0);
}

let prior = [];
try {
  prior = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (!Array.isArray(prior)) prior = [];
} catch {
  prior = [];
}

// A different spawner address is NOT on its own evidence of a map change --
// relaunching the game gives a different address too, and comparing across a
// relaunch would report "stable across maps" for two runs that never saw a map
// change at all. Only same-process runs are comparable, so the PID gates it.
const sameProcess = prior.filter(p => p.pid === pid);
const others = sameProcess.filter(p => p.expectedSpawner !== expectedSpawner);
const otherProcess = prior.length - sameProcess.length;

if (otherProcess) {
  console.log(`Ignoring ${otherProcess} run(s) from an earlier PID: a relaunch is not`);
  console.log('a map change, and proving the chain survives one says nothing about the other.\n');
}

if (!others.length) {
  console.log(`Saved as "${label}". No earlier run in THIS process against a different`);
  console.log('spawner yet. Load a different map without restarting the game, then');
  console.log('re-run with the same --state path.');
} else {
  console.log('================================================================');
  console.log(' Cross-map stability comparison');
  console.log('================================================================');
  for (const p of others) {
    console.log(`\nComparing against run "${p.label}" (spawner 0x${p.expectedSpawner.toString(16)}):`);
    for (const key of Object.keys(results)) {
      const currRes = results[key];
      const priorRes = p.results ? p.results[key] : null;
      if (currRes.ok && priorRes && priorRes.ok) {
        console.log(`  ${key}: PROVEN STABLE ACROSS MAPS!`);
        console.log(`    Prior spawner:   0x${priorRes.spawner.toString(16)} (matched)`);
        console.log(`    Current spawner: 0x${currRes.spawner.toString(16)} (matched)`);
        console.log(`    Lookup time:     ${currRes.ms.toFixed(3)} ms (vs ~${findMs.toFixed(0)} ms scan)`);
      } else {
        console.log(`  ${key}: NOT proven stable (current ok: ${currRes.ok}, prior ok: ${priorRes ? priorRes.ok : false})`);
      }
    }
  }
}

prior.push(record);
fs.writeFileSync(statePath, JSON.stringify(prior, null, 2), 'utf8');
console.log(`\nState written to ${statePath} (${prior.length} run(s) recorded).`);

proc.close();
process.exit(0);
