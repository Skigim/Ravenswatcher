'use strict';
// Melody availability benchmark and live memory diagnostic probe.
//
// Distinguishes failure modes hop-by-hop:
//  - RTTI vtable resolution
//  - Heap scanning for MelodyEntityCpnt instances and distinct internal names
//  - Hero controller discovery, SceneContext extraction, and raw 3-GUID pool matching
//  - Linked melody array inspection, GUID-identity attribution, and max(state) merging
//
// Usage:
//   node app/reader/bench/melody-bench.js [--registry] [--pool] [--state] [pid]

const { openProcess, findPid, moduleBase } = require('../win32');
const { PROCESS_NAME } = require('../state');
const melodies = require('../melodies');
const rtti = require('../rtti');
const { scanPointers } = require('../scan');

// Name recovery: walk from the B object to the melody's entity path string and
// read the internal name back out of it.
//
// This lives here, not in melodies.js. The reader does not need it -- its
// registry is the static 12, and a GUID that registry does not know has a name
// MELODY_DEFINITIONS_BY_NAME does not know either, so recovery there could only
// return null. What it is good for is exactly what this bench does: check
// whether the 12 static GUIDs can still be recovered from a live process, which
// is how STATIC_MELODY_GUIDS was built and how a game patch that moves them
// would be caught.
//
// The chain offsets are verified live as of 2026-08-30: 12/12 names recovered
// at the menu and 14/14 instances mid-run, every one of them off this chain.
// Hop 2 reporting fewer than 12 therefore points at these offsets having
// drifted, which is exactly what it is here to catch.
const B_PATH_POINTER_OFFSET = 0x70;
const C_PATH_POINTER_OFFSET = 0x48;
const D_PATH_POINTER_OFFSET = 0x18;
const PATH_RE = /Objects[\\\/]Melodies[\\\/]([A-Za-z0-9_]+)\.entity\.ot/i;

function readCString(proc, addr, maxLen = 256) {
  const buf = proc.read(addr, maxLen);
  if (!buf) return null;
  const z = buf.indexOf(0);
  return buf.subarray(0, z === -1 ? buf.length : z).toString('latin1');
}

function knownName(str) {
  if (!str) return null;
  const m = str.match(PATH_RE);
  return (m && melodies.MELODY_DEFINITIONS_BY_NAME[m[1]]) ? m[1] : null;
}

// Counted so a hop that stops answering is visible as a number rather than as
// a quietly short name list.
const methodHits = { chain: 0, none: 0 };

/**
 * The internal melody name behind a B object, via the entity path string.
 *
 * There used to be a second strategy here -- scan the B object for the path
 * inline, then chase every pointer field in it. It was measured on 2026-08-30
 * and answered nothing: chain 12 / inline 0 / sweep 0 at the menu, chain 14 /
 * inline 0 / sweep 0 mid-run. The chain wins first every time, so the scan was
 * cost with no reading behind it and is gone.
 */
function extractInternalName(proc, objB) {
  const ptrC = proc.readPtr(objB + B_PATH_POINTER_OFFSET);
  const ptrD = ptrC ? proc.readPtr(ptrC + C_PATH_POINTER_OFFSET) : null;
  const ptrStr = ptrD ? proc.readPtr(ptrD + D_PATH_POINTER_OFFSET) : null;
  if (ptrStr) {
    const hit = knownName(readCString(proc, ptrStr, 256));
    if (hit) { methodHits.chain++; return hit; }
  }
  methodHits.none++;
  return null;
}

const args = process.argv.slice(2);
let flagRegistry = args.includes('--registry');
let flagPool = args.includes('--pool');
let flagState = args.includes('--state');
const positional = args.filter(a => !a.startsWith('--'));

if (!flagRegistry && !flagPool && !flagState) {
  flagRegistry = true;
  flagPool = true;
  flagState = true;
}

let pid = null;
if (positional.length > 0) {
  pid = parseInt(positional[0], 10);
} else {
  try {
    pid = findPid(PROCESS_NAME);
  } catch (err) {
    console.log(`Could not find ${PROCESS_NAME}: ${err.message}`);
    process.exit(0);
  }
}

if (!pid) {
  console.log(`Process ${PROCESS_NAME} not found.`);
  process.exit(0);
}

let mod;
try {
  mod = moduleBase(pid);
} catch (err) {
  console.error(`Could not inspect module base for PID ${pid}: ${err.message}`);
  process.exit(1);
}

const proc = openProcess(pid);

try {
  console.log(`Attached to PID ${pid}, base 0x${mod.base.toString(16).toUpperCase()} (size ${(mod.size / 1e6).toFixed(1)} MB)`);

  // --- Hop 1: RTTI Resolution ---
  console.log('\n[1/4] Resolving RTTI Vtables...');
  const tRtti = process.hrtime.bigint();
  const melodyRvas = rtti.resolveAllVtableRvas(proc, mod.base, melodies.MELODY_CPNT_RTTI);
  const heroRvas = rtti.resolveAllVtableRvas(proc, mod.base, melodies.HERO_CONTROLLER_RTTI);
  const rttiMs = Number(process.hrtime.bigint() - tRtti) / 1e6;

  const melodyCpntVt = melodyRvas.length ? mod.base + melodyRvas[0] : null;
  const heroControllerVt = heroRvas.length ? mod.base + heroRvas[0] : null;

  console.log(`  MelodyEntityCpnt vtable:      ${melodyCpntVt ? '0x' + melodyCpntVt.toString(16).toUpperCase() + ' (RVA +0x' + melodyRvas[0].toString(16).toUpperCase() + ')' : 'FAILED / NOT FOUND'}`);
  console.log(`  HeroController vtable:        ${heroControllerVt ? '0x' + heroControllerVt.toString(16).toUpperCase() + ' (RVA +0x' + heroRvas[0].toString(16).toUpperCase() + ')' : 'FAILED / NOT FOUND'}`);
  console.log(`  RTTI lookup took:             ${rttiMs.toFixed(1)} ms`);

  const vtables = { melodyCpntVt, heroControllerVt };

  // --- Hop 2: Registry Resolution (Heap Scan) ---
  console.log('\n[2/4] Scanning Heap for Melody Registry Instances...');
  const tReg = process.hrtime.bigint();
  let regResult = null;
  let instancesFound = 0;
  const recoveredMap = new Map();

  if (melodyCpntVt) {
    const hits = scanPointers(proc, [melodyCpntVt], { writableOnly: true });
    const instances = hits.get(melodyCpntVt) || [];
    instancesFound = instances.length;

    for (const inst of instances) {
      const cpnt = Array.isArray(inst) ? inst[0] : inst;
      const entity = proc.readPtr(cpnt + melodies.BASE_CPNT_ENTITY_OFFSET);
      if (!entity) continue;
      const objB = proc.readPtr(entity + melodies.ENTITY_B_OBJECT_OFFSET);
      if (!objB) continue;
      const guidBytes = proc.read(objB + melodies.B_GUID_OFFSET, 16);
      if (!guidBytes || melodies.isZeroGuid(guidBytes)) continue;
      const guidHex = melodies.guidToHex(guidBytes);

      const internalName = extractInternalName(proc, objB);
      if (internalName && melodies.MELODY_DEFINITIONS_BY_NAME[internalName]) {
        recoveredMap.set(guidHex, melodies.MELODY_DEFINITIONS_BY_NAME[internalName]);
      }
    }
  }

  const distinctNames = new Set([...recoveredMap.values()].map(d => d.internal_name));
  const regMs = Number(process.hrtime.bigint() - tReg) / 1e6;

  console.log(`  MelodyEntityCpnt heap instances: ${instancesFound}`);
  console.log(`  Distinct internal names:         ${distinctNames.size} / 12 recovered (${regMs.toFixed(1)} ms)`);
  console.log(`  Name chain:                      ${methodHits.chain} resolved, `
    + `${methodHits.none} failed`);

  if (distinctNames.size < 12) {
    const missing = melodies.MELODY_DEFINITIONS
      .filter(d => !distinctNames.has(d.internal_name))
      .map(d => d.internal_name);
    console.log(`  Missing definitions (${missing.length}): ${missing.join(', ')}`);
  }

  if (distinctNames.size === 12) {
    regResult = {
      registry: recoveredMap,
      melodyCpntVt,
      heroControllerVt,
      instanceCount: instancesFound,
      distinctCount: distinctNames.size,
    };
  }

  if (flagRegistry && regResult) {
    console.log(`\n--- Melody Registry (${regResult.registry.size} entries) ---`);
    let idx = 0;
    for (const [guid, def] of regResult.registry.entries()) {
      console.log(`  [${String(idx++).padStart(2)}] GUID: ${guid}`);
      console.log(`       Name:   ${def.name} (${def.internal_name})`);
      console.log(`       Notes:  ${def.notes} | Icon: ${def.icon}`);
      console.log(`       Effect: ${def.effect}`);
    }
  }

  // --- Hop 3: Pool Resolution ---
  let pool = null;
  if (flagPool || flagState) {
    console.log('\n[3/4] Resolving Run Pool from Hero SceneContext...');
    const tPool = process.hrtime.bigint();
    if (!heroControllerVt) {
      console.log('  HeroController vtable not resolved -- skipping pool read.');
    } else {
      const hits = scanPointers(proc, [heroControllerVt], { writableOnly: true });
      const heroes = hits.get(heroControllerVt) || [];
      console.log(`  HeroController instances found: ${heroes.length}`);

      let contextFoundCount = 0;
      heroes.forEach((h, i) => {
        const heroAddr = Array.isArray(h) ? h[0] : h;
        const entity = proc.readPtr(heroAddr + melodies.HERO_ENTITY_OFFSET);
        const sceneContext = entity ? proc.readPtr(entity + melodies.ENTITY_CONTEXT_OFFSET) : null;
        if (sceneContext) {
          contextFoundCount++;
          const guidBytes = proc.read(sceneContext + melodies.CONTEXT_GUIDS_OFFSET, 48);
          if (guidBytes && guidBytes.length >= 48) {
            const g0 = melodies.guidToHex(guidBytes.subarray(0, 16));
            const g1 = melodies.guidToHex(guidBytes.subarray(16, 32));
            const g2 = melodies.guidToHex(guidBytes.subarray(32, 48));
            console.log(`  Hero [${i}] (0x${heroAddr.toString(16)}): SceneContext=0x${sceneContext.toString(16)}`);
            console.log(`    Slot 0 GUID: ${g0} -> ${(regResult && regResult.registry.get(g0)) ? regResult.registry.get(g0).name : '(unresolved)'}`);
            console.log(`    Slot 1 GUID: ${g1} -> ${(regResult && regResult.registry.get(g1)) ? regResult.registry.get(g1).name : '(unresolved)'}`);
            console.log(`    Slot 2 GUID: ${g2} -> ${(regResult && regResult.registry.get(g2)) ? regResult.registry.get(g2).name : '(unresolved)'}`);
          } else {
            console.log(`  Hero [${i}]: SceneContext=0x${sceneContext.toString(16)} (GUID read failed)`);
          }
        } else {
          console.log(`  Hero [${i}] (0x${heroAddr.toString(16)}): No SceneContext`);
        }
      });

      if (regResult) {
        pool = melodies.readPool(proc, vtables, regResult.registry);
      }
      const poolMs = Number(process.hrtime.bigint() - tPool) / 1e6;

      if (pool) {
        console.log(`  Pool resolved in ${poolMs.toFixed(1)} ms:`);
        pool.forEach((item, slot) => {
          console.log(`    Slot ${slot}: ${item.name} (${item.internal_name}) - ${item.notes} notes [${item.icon}]`);
        });
      } else {
        console.log(`  No active pool resolved (${contextFoundCount} contexts inspected).`);
      }
    }
  }

  // --- Hop 4: Lifecycle State Inspection ---
  if (flagState) {
    console.log('\n[4/4] Inspecting Lifecycle States from Linked Arrays...');
    const tState = process.hrtime.bigint();
    if (!heroControllerVt) {
      console.log('  HeroController vtable not resolved -- skipping state read.');
    } else {
      const hits = scanPointers(proc, [heroControllerVt], { writableOnly: true });
      const heroes = hits.get(heroControllerVt) || [];

      heroes.forEach((h, i) => {
        const heroAddr = Array.isArray(h) ? h[0] : h;
        const buf = proc.readPtr(heroAddr + melodies.HERO_LINKED_MELODIES_OFFSET);
        const countBuf = proc.read(heroAddr + melodies.HERO_LINKED_COUNT_OFFSET, 4);
        const count = countBuf ? countBuf.readUInt32LE(0) : 0;
        console.log(`  Hero [${i}] (0x${heroAddr.toString(16)}): linkedArrayPtr=0x${buf ? buf.toString(16) : '0'} count=${count}`);

        if (buf && count > 0) {
          for (let e = 0; e < Math.min(count, 16); e++) {
            const cpnt = proc.readPtr(buf + e * 8);
            if (!cpnt) continue;
            const vt = proc.readPtr(cpnt);
            const vtMatch = melodyCpntVt && (vt === melodyCpntVt);
            const lifecycle = proc.readI32(cpnt + melodies.MELODY_LIFECYCLE_OFFSET);

            const entity = proc.readPtr(cpnt + melodies.BASE_CPNT_ENTITY_OFFSET);
            const objB = entity ? proc.readPtr(entity + melodies.ENTITY_B_OBJECT_OFFSET) : null;
            const guidBytes = objB ? proc.read(objB + melodies.B_GUID_OFFSET, 16) : null;
            const guidHex = guidBytes ? melodies.guidToHex(guidBytes) : '';
            const def = regResult ? regResult.registry.get(guidHex) : null;

            console.log(`    Entry ${e}: cpnt=0x${cpnt.toString(16)} vtMatch=${vtMatch} lifecycle=${lifecycle} guid=${guidHex} def=${def ? def.name : '(unresolved)'}`);
          }
        }
      });

      const states = pool ? melodies.readStates(proc, vtables, pool, regResult ? regResult.registry : null) : null;
      const combined = melodies.combineMelodies(pool, states);
      const stateMs = Number(process.hrtime.bigint() - tState) / 1e6;

      console.log(`\n--- Combined Melody Availability (${stateMs.toFixed(1)} ms) ---`);
      if (!combined) {
        console.log('  No melody availability data (pool null or outside run).');
      } else {
        combined.forEach(m => {
          console.log(`  Slot ${m.slot}: ${m.name} -> State: ${m.state ? m.state.toUpperCase() : 'UNRESOLVED (null)'} (${m.notes} notes)`);
          console.log(`          Effect: ${m.effect}`);
        });
      }
    }
  }
} finally {
  proc.close();
}
