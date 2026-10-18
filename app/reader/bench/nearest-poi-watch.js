'use strict';
// Live "what's near me" probe, for labelling TILE_ICONS entries in state.ts
// against what is actually on screen: stand on an unclaimed objective, read
// the latest line, and the raw engine name is right there.
//
// Deliberately narrow. camp-clearance-watch.js waits for map-settle, scans
// for camp selectors, and cross-matches every objective to a camp entity --
// none of that is needed just to say "you are here, this is the nearest
// thing". This reads the hero's own position once a tick and sorts the
// existing placed-tile/reward roster against it. No camp entities, no
// exclusivity, no settle wait.
//
// Map presence is checked via the pointer-chain spawner lookup (~25ms, no
// scan) rather than tiles.findInstances, which re-scans the heap for both
// vtables every tick. Reward selectors still cost one heap scan, but only
// when the spawner address changes (a new map), not every tick.
//
//   node app/reader/bench/nearest-poi-watch.js [outfile]

const { openProcess, findPid, moduleBase } = require('../win32');
const { PROCESS_NAME } = require('../state');
const tiles = require('../tiles');
const rtti = require('../rtti');
const { scanPointers } = require('../scan');
const fs = require('fs');

const HERO_CONTROLLER_RTTI = '.?AVoCDtEntityCpntHeroController@@\0';
const HERO_ENTITY_OFFSET = 0x08;
const POS_X_OFFSET = 0x2e0;
const POS_Y_OFFSET = 0x2e8;
const NEAREST_N = 3;

const OUT = process.argv[2] || null;

function log(line) {
  console.log(line);
  if (OUT) {
    try {
      fs.appendFileSync(OUT, line + '\n');
    } catch {}
  }
}

function readF32(proc, addr) {
  const b = proc.read(addr, 4);
  return b && b.length === 4 ? b.readFloatLE(0) : null;
}

function entityPos(proc, entity) {
  if (!entity || entity < tiles.MIN_VALID_ADDR) return null;
  const x = readF32(proc, entity + POS_X_OFFSET);
  const y = readF32(proc, entity + POS_Y_OFFSET);
  if (x === null || y === null) return null;
  return { x, y };
}

// A hero-controller vtable scan turns up every instance ever allocated this
// session, not just the one attached to the current run -- measured live,
// 3 hits with only 1 live. "Live" means entity+0x30 (its context pointer,
// same field melodies.ts's isLiveHero checks) is non-null; the other two are
// retired controllers from an earlier death/respawn that still carry a
// resolvable but frozen entity, and read as a permanent (0, 0).
function isLiveHero(proc, heroAddr) {
  const entity = proc.readPtr(heroAddr + HERO_ENTITY_OFFSET);
  if (!entity) return false;
  return Boolean(proc.readPtr(entity + 0x30));
}

function findHeroesLike(proc, heroVt, cached) {
  const valid = (cached || []).filter(a => proc.readPtr(a) === heroVt && isLiveHero(proc, a));
  if (valid.length) return valid;
  const hits = scanPointers(proc, [heroVt], { writableOnly: true });
  const raw = (hits.get(heroVt) || []).map(h => (Array.isArray(h) ? h[0] : h));
  return raw.filter(a => a >= tiles.MIN_VALID_ADDR && isLiveHero(proc, a));
}

function collectPoints(proc, instances) {
  const points = [];

  const catVec = proc.readPtr(instances.spawnerAddr + tiles.SPAWNER_CATEGORY_VECTOR_OFFSET);
  const catCount = tiles.readU32(proc, instances.spawnerAddr + tiles.SPAWNER_CATEGORY_COUNT_OFFSET);
  if (catVec && catCount && catCount <= 32) {
    for (let c = 0; c < catCount; c++) {
      const slice = catVec + c * tiles.CATEGORY_SLICE_STRIDE;
      const slotsPtr = proc.readPtr(slice + tiles.CATEGORY_SLICE_DATA_OFFSET);
      const n = tiles.readU32(proc, slice + tiles.CATEGORY_SLICE_COUNT_OFFSET);
      if (!slotsPtr || !n || n > 1000) continue;
      for (let s = 0; s < n; s++) {
        const slot = slotsPtr + s * tiles.TILE_SLOT_STRIDE;
        const res = proc.readPtr(slot + tiles.SLOT_RESOURCE_OFFSET);
        if (!res || res < tiles.MIN_VALID_ADDR) continue;
        const wBuf = proc.read(slot + tiles.SLOT_WEIGHT_OFFSET, 4);
        if (!wBuf || wBuf.length < 4) continue;
        const weight = wBuf.readFloatLE(0);
        if (weight === -1.0) continue;
        const name = tiles.readStringTriple(proc, res + tiles.RESOURCE_NAME_OFFSET);
        if (!name) continue;
        const entity = proc.readPtr(slot + tiles.SLOT_ENTITY_OFFSET);
        const pos = entityPos(proc, entity);
        if (!pos) continue;
        points.push({ name, x: pos.x, y: pos.y, source: 'tile', tier: tiles.bucketTier(weight) });
      }
    }
  }

  for (const selAddr of instances.selectorAddrs) {
    const fBuf = proc.read(selAddr + 0x60, 24);
    if (!fBuf || fBuf.length < 24) continue;
    const x = fBuf.readFloatLE(12);
    const y = fBuf.readFloatLE(20);
    const res = proc.readPtr(selAddr + tiles.SELECTOR_RESOURCE_OFFSET);
    const name = res ? tiles.readStringTriple(proc, res + tiles.RESOURCE_NAME_OFFSET) : null;
    if (!name) continue;
    const tBuf = proc.read(selAddr + tiles.SELECTOR_TIER_OFFSET, 4);
    const tier = tBuf ? tiles.bucketTier(tBuf.readFloatLE(0)) : null;
    points.push({ name, x, y, source: 'reward', tier });
  }

  return points;
}

function main() {
  const pid = findPid(PROCESS_NAME);
  if (!pid) {
    console.error(`Process ${PROCESS_NAME} not running.`);
    process.exit(1);
  }
  const mod = moduleBase(pid);
  const proc = openProcess(pid);

  const vtables = {};
  const resolved = tiles.resolveVtables(proc, mod.base, vtables);
  if (!resolved) {
    console.error('Failed to resolve tile vtables.');
    process.exit(1);
  }

  const heroRvas = rtti.resolveAllVtableRvas(proc, mod.base, HERO_CONTROLLER_RTTI);
  if (!heroRvas.length) {
    console.error('Failed to resolve hero controller vtable.');
    process.exit(1);
  }
  const heroVt = mod.base + heroRvas[0];

  console.log(`[Nearest POI] Attached to ${PROCESS_NAME} (PID ${pid}).`);

  let instances = null;
  let heroAddrs = [];

  setInterval(() => {
    const chain = tiles.findSpawnerByChain(proc, mod.base, { vtables });
    if (!chain.ok) {
      if (instances) {
        console.log('[Nearest POI] Map unloaded.');
        instances = null;
      }
      return;
    }

    if (!instances || instances.spawnerAddr !== chain.spawnerAddr) {
      const selectorAddrs = tiles.findSelectors(proc, resolved.selectorVt);
      instances = { spawnerAddr: chain.spawnerAddr, selectorAddrs };
      console.log(`[Nearest POI] Map roster loaded: ${selectorAddrs.length} reward selectors.`);
    }

    heroAddrs = findHeroesLike(proc, heroVt, heroAddrs);
    if (!heroAddrs.length) return;
    const heroEntity = proc.readPtr(heroAddrs[0] + HERO_ENTITY_OFFSET);
    const heroPos = entityPos(proc, heroEntity);
    if (!heroPos) return;

    const points = collectPoints(proc, instances);
    if (!points.length) return;

    points.sort(
      (a, b) =>
        Math.hypot(a.x - heroPos.x, a.y - heroPos.y) - Math.hypot(b.x - heroPos.x, b.y - heroPos.y),
    );
    const top = points
      .slice(0, NEAREST_N)
      .map(p => {
        const d = Math.hypot(p.x - heroPos.x, p.y - heroPos.y);
        const t = p.tier ? ` T${p.tier}` : '';
        return `[${p.source}] ${p.name}${t} @${d.toFixed(1)}u`;
      });

    log(
      `[${new Date().toLocaleTimeString()}] you=(${heroPos.x.toFixed(1)}, ${heroPos.y.toFixed(1)})  ${top.join('  |  ')}`,
    );
  }, 1000);
}

main();
