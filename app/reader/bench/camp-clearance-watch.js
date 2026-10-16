'use strict';
// Objective clearance watcher: pairs placed POIs/rewards to the enemy camp
// guarding each one and logs the moment that camp's "State All Enemies Dead"
// component flips 1 -> 0.
// - Waits for map generation to fully settle (all reward selectors placed) before building roster.
// - Clean player-facing names with full tier and reward resolution.
// - Dynamic resolution: if a reward rolls late, it resolves dynamically at clearance time.
// - Seamless cross-run tracking without fake dumps on map exit.
//
//   node app/reader/bench/camp-clearance-watch.js [outfile]

const { openProcess, findPid, moduleBase } = require('../win32');
const { PROCESS_NAME } = require('../state');
const tiles = require('../tiles');
const rtti = require('../rtti');
const { scanPointers } = require('../scan');
const fs = require('fs');

const LOG_FILE = process.argv[2] || null;

function cleanName(raw) {
  if (!raw) return 'null';
  let s = raw;
  if (s.startsWith('.?AV')) s = s.slice(4);
  else if (s.startsWith('.?AU')) s = s.slice(4);
  if (s.endsWith('@@')) s = s.slice(0, -2);
  return s;
}

function readStr(proc, p, max = 128) {
  if (!p || p < 0x10000) return null;
  const b = proc.read(p, max);
  if (!b) return null;
  const z = b.indexOf(0);
  return b.subarray(0, z > 0 ? z : max).toString('latin1');
}

function formatDisplayName(rawName, tier) {
  const tStr = tier ? ` (Tier ${tier})` : '';

  // Optional Boss Den (Ghoul vs White Lady)
  if (/Boss_?Ghoul|Ghoul_?Den/i.test(rawName)) {
    return 'Optional Boss: Ghoul (Boss Den)';
  }
  if (/Boss_?Shrine|White_?Lady/i.test(rawName)) {
    return 'Optional Boss: White Lady (Boss Den)';
  }
  if (/Map_Boss|Chapter_Boss/i.test(rawName)) {
    return 'Chapter Boss (Nightmare Arena)';
  }

  // Chests & Locked Chests
  if (/Super_?Chest/i.test(rawName)) {
    return `Greater Chest${tStr}`;
  }
  if (/Locked_?Chest|Chest_?Locked|Locked_T/i.test(rawName)) {
    const m = rawName.match(/Locked_T([123])/i);
    const t = m ? m[1] : (tier || '');
    return `Locked Chest${t ? ` (Tier ${t})` : ''}`;
  }
  if (/Basic_?Chest_T([123])/i.test(rawName)) {
    const m = rawName.match(/Basic_?Chest_T([123])/i);
    return `Chest (Tier ${m[1]})`;
  }
  if (/Chest/i.test(rawName)) {
    return `Chest${tStr || ''}`;
  }

  // Crystals / Resources
  if (/DreamCrystal|CrystalField/i.test(rawName)) {
    return 'Dream Crystal (Big)';
  }
  if (/Baba_?Yaga_?Eye/i.test(rawName)) {
    return 'Vision Tower (Baba Yaga Eye)';
  }
  if (/Astrolab/i.test(rawName)) {
    return `Astrolabe${tStr}`;
  }

  // Points of Interest
  if (/Grimoire/i.test(rawName)) {
    const m = rawName.match(/Grimoire_T([123])/i);
    const t = m ? m[1] : (tier || '');
    return `Grimoire${t ? ` (Tier ${t})` : ''}`;
  }
  if (/Cauldron/i.test(rawName)) {
    return 'Cauldron';
  }
  if (/Wishing_?Well/i.test(rawName)) {
    return `Wishing Well${tStr}`;
  }
  if (/Altar_?Of_?Heroes/i.test(rawName)) {
    return 'Altar of Heroes';
  }
  if (/Thieves_?Stash/i.test(rawName)) {
    return "Thieves' Stash (Dungeon)";
  }
  if (/Refugee/i.test(rawName)) {
    return 'Refugee Camp';
  }
  if (/Key_?Keeper/i.test(rawName)) {
    return 'Key Keeper';
  }
  if (/Tumor/i.test(rawName)) {
    return 'Nightmare Tumor';
  }
  if (/Stingy_?Jack/i.test(rawName)) {
    return 'Stingy Jack (Treasure)';
  }

  // Quests
  if (/JackQuest|Beanstalk/i.test(rawName)) {
    return 'Quest: Jack & Beanstalk';
  }
  if (/PigQuest|Stone_House|Straw_House|Wood_House/i.test(rawName)) {
    return 'Quest: Three Little Pigs';
  }

  // Generic Camp Fallback
  if (/_Camp/i.test(rawName)) {
    return `Guarded Camp${tStr}`;
  }

  let s = rawName.replace(/^40x40_|^64x64_/, '');
  s = s.replace(/_Camp$/, '').replace(/_Neutral_Camp$/, '');
  s = s.replace(/_/g, ' ');
  return s;
}

function buildMapRoster(proc, mod, discovered) {
  // 1. Resolve Enemy Camp Selectors and isolate ARMED camps
  const rvas = rtti.resolveAllVtableRvas(proc, mod.base, '.?AVoCDtEnemyCampEntitySelectorToSpawnEntityCpnt@@\0');
  if (!rvas.length) return null;
  const campSelVt = mod.base + rvas[0];
  const hits = scanPointers(proc, [campSelVt], { writableOnly: true });
  const campSelAddrs = (hits.get(campSelVt) || []).map(h => Array.isArray(h) ? h[0] : h);

  const campEntities = [];
  const seenCamps = new Set();
  for (const sel of campSelAddrs) {
    const entity = proc.readPtr(sel + 0x08);
    if (!entity || seenCamps.has(entity)) continue;
    seenCamps.add(entity);

    const bx = proc.read(entity + 0x2E0, 4);
    const by = proc.read(entity + 0x2E8, 4);
    if (!bx || !by) continue;

    const cpntVec = proc.readPtr(entity + 0x190);
    const cpntCount = proc.readI32(entity + 0x198);
    let allDeadCpnt = null;
    let allDeadVal = null;

    for (let j = 0; j < cpntCount; j++) {
      const cpnt = proc.readPtr(cpntVec + j * 8);
      if (!cpnt) continue;
      if (cleanName(rtti.classOfVtable(proc, mod.base, mod.size, proc.readPtr(cpnt))) !== 'oCEntityCpntState') continue;

      const settings = proc.readPtr(cpnt + 0x10);
      const sname = settings ? readStr(proc, proc.readPtr(settings + 0xe8), 64) : null;
      if (sname === 'State All Enemies Dead') {
        allDeadCpnt = cpnt;
        allDeadVal = proc.readI32(cpnt + 0x48);
        break;
      }
    }

    if (allDeadCpnt) {
      campEntities.push({
        entity,
        x: bx.readFloatLE(0),
        y: by.readFloatLE(0),
        allDeadCpnt,
        allDeadVal
      });
    }
  }

  // 2. Read placed POIs
  const catVec = proc.readPtr(discovered.spawnerAddr + tiles.SPAWNER_CATEGORY_VECTOR_OFFSET);
  const catCount = tiles.readU32(proc, discovered.spawnerAddr + tiles.SPAWNER_CATEGORY_COUNT_OFFSET);
  const poiList = [];

  for (let c = 0; c < catCount; c++) {
    const slice = catVec + c * tiles.CATEGORY_SLICE_STRIDE;
    const slotsPtr = proc.readPtr(slice + tiles.CATEGORY_SLICE_DATA_OFFSET);
    const n = tiles.readU32(proc, slice + tiles.CATEGORY_SLICE_COUNT_OFFSET);
    if (!slotsPtr || !n) continue;
    for (let s = 0; s < n; s++) {
      const slot = slotsPtr + s * tiles.TILE_SLOT_STRIDE;
      const res = proc.readPtr(slot + tiles.SLOT_RESOURCE_OFFSET);
      if (!res || res < tiles.MIN_VALID_ADDR) continue;
      const weightBuf = proc.read(slot + tiles.SLOT_WEIGHT_OFFSET, 4);
      if (weightBuf && weightBuf.readFloatLE(0) === -1.0) continue;

      const name = tiles.readStringTriple(proc, res + tiles.RESOURCE_NAME_OFFSET);
      if (!/40x40|64x64/i.test(name)) continue;
      if (/_Start_|Round_Table|Tree_Quest/i.test(name)) continue;

      const weight = weightBuf ? weightBuf.readFloatLE(0) : null;
      const tier = tiles.bucketTier(weight);

      const entity = proc.readPtr(slot + tiles.SLOT_ENTITY_OFFSET);
      let x = null, y = null;
      if (entity) {
        x = proc.read(entity + 0x2E0, 4) ? proc.read(entity + 0x2E0, 4).readFloatLE(0) : null;
        y = proc.read(entity + 0x2E8, 4) ? proc.read(entity + 0x2E8, 4).readFloatLE(0) : null;
      }
      if (x !== null && y !== null) poiList.push({ name, tier, x, y });
    }
  }

  // 3. Read rewards (selectors)
  const rewardList = [];
  for (const selAddr of discovered.selectorAddrs) {
    const fBuf = proc.read(selAddr + 0x60, 24);
    let x = null, y = null;
    if (fBuf && fBuf.length >= 24) {
      x = fBuf.readFloatLE(12);
      y = fBuf.readFloatLE(20);
    }
    const res = proc.readPtr(selAddr + tiles.SELECTOR_RESOURCE_OFFSET);
    const name = res ? tiles.readStringTriple(proc, res + tiles.RESOURCE_NAME_OFFSET) : null;
    const tBuf = proc.read(selAddr + 0x68, 4);
    const tier = tBuf ? tiles.bucketTier(tBuf.readFloatLE(0)) : null;
    if (name && x !== null && y !== null) {
      rewardList.push({ name, tier, x, y });
    }
  }

  // 4. Merge POIs and Rewards into distinct objectives.
  // Camp assignment is deferred to step 5: matching each objective to its
  // nearest camp independently let two nearby objectives claim the same
  // camp entity, since a match never removed that camp from the pool.
  const mergedObjectives = [];
  const matchedRewards = new Set();

  for (const poi of poiList) {
    let reward = null;
    for (const r of rewardList) {
      const d = Math.hypot(r.x - poi.x, r.y - poi.y);
      if (d < 15 && !matchedRewards.has(r)) {
        reward = r;
        matchedRewards.add(r);
        break;
      }
    }

    const chosenName = reward ? reward.name : poi.name;
    const chosenTier = (reward && reward.tier) ? reward.tier : poi.tier;
    const displayName = formatDisplayName(chosenName, chosenTier);

    mergedObjectives.push({
      displayName,
      rawName: chosenName,
      tier: chosenTier,
      x: poi.x,
      y: poi.y,
      refPoints: reward ? [{ x: poi.x, y: poi.y }, { x: reward.x, y: reward.y }] : [{ x: poi.x, y: poi.y }],
      camp: null,
      campDist: null,
      isCleared: false
    });
  }

  for (const r of rewardList) {
    if (matchedRewards.has(r)) continue;
    if (mergedObjectives.some(m => Math.hypot(m.x - r.x, m.y - r.y) < 5.0)) continue;

    const displayName = formatDisplayName(r.name, r.tier);
    mergedObjectives.push({
      displayName,
      rawName: r.name,
      tier: r.tier,
      x: r.x,
      y: r.y,
      refPoints: [{ x: r.x, y: r.y }],
      camp: null,
      campDist: null,
      isCleared: false
    });
  }

  // 5. Exclusive camp assignment: every (objective, camp) pair under the
  // cutoff, sorted nearest-first, assigned greedily so no camp is claimed
  // by more than one objective and vice versa.
  const CAMP_MATCH_CUTOFF = 45;
  const pairs = [];
  for (let oi = 0; oi < mergedObjectives.length; oi++) {
    const obj = mergedObjectives[oi];
    for (let ci = 0; ci < campEntities.length; ci++) {
      const c = campEntities[ci];
      let d = Infinity;
      for (const p of obj.refPoints) {
        const dd = Math.hypot(c.x - p.x, c.y - p.y);
        if (dd < d) d = dd;
      }
      if (d < CAMP_MATCH_CUTOFF) pairs.push({ oi, ci, d });
    }
  }
  pairs.sort((a, b) => a.d - b.d);

  const usedObjectives = new Set();
  const usedCamps = new Set();
  for (const { oi, ci, d } of pairs) {
    if (usedObjectives.has(oi) || usedCamps.has(ci)) continue;
    usedObjectives.add(oi);
    usedCamps.add(ci);
    const obj = mergedObjectives[oi];
    const camp = campEntities[ci];
    obj.camp = camp;
    obj.campDist = d;
    obj.isCleared = camp.allDeadVal === 0;
  }

  return mergedObjectives;
}

function startLifecycleLoop() {
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
    proc.close();
    process.exit(1);
  }

  console.log(`[Lifecycle Watcher] Attached to ${PROCESS_NAME} (PID ${pid}). Waiting for map...`);
  if (LOG_FILE) { try { fs.writeFileSync(LOG_FILE, `=== Ravenswatch Lifecycle Clearance Watcher Started (PID ${pid}) ===\n\n`); } catch {} }

  let currentSpawner = null;
  let tracked = null;
  let lastClearedSet = new Set();
  let settlingCountdown = 0;
  let lastSelectorCount = 0;

  setInterval(() => {
    const discovered = tiles.findInstances(proc, resolved);
    const spawner = discovered ? discovered.spawnerAddr : null;

    // MAP ENDED / UNLOADED
    if (!spawner) {
      if (currentSpawner) {
        console.log(`\n[Lifecycle Watcher] Run ended / map unloaded. Pausing clearance tracking.`);
        if (LOG_FILE) { try { fs.appendFileSync(LOG_FILE, `[${new Date().toLocaleTimeString()}] Run ended / map unloaded.\n\n`); } catch {} }
        currentSpawner = null;
        tracked = null;
        lastClearedSet.clear();
        settlingCountdown = 0;
      }
      return;
    }

    // NEW MAP DETECTED -> WAIT FOR REWARDS TO SETTLE
    if (spawner !== currentSpawner) {
      const selCount = discovered.selectorAddrs.length;
      // Wait for at least 8 selectors or 3 stable seconds
      if (selCount < 8 && settlingCountdown < 3) {
        settlingCountdown++;
        return;
      }

      console.log(`\n[Lifecycle Watcher] Map settled (${selCount} selectors). Building roster...`);
      const roster = buildMapRoster(proc, mod, discovered);
      if (!roster || roster.length === 0) return;

      currentSpawner = spawner;
      tracked = roster;
      lastClearedSet.clear();

      const clearedCount = tracked.filter(t => t.isCleared).length;
      console.log(`================================================================`);
      console.log(` RUN ROSTER: ${tracked.length} Distinct Objectives (${clearedCount} cleared, ${tracked.length - clearedCount} armed)`);
      console.log(`================================================================`);
      for (let i = 0; i < tracked.length; i++) {
        const t = tracked[i];
        const statusStr = t.isCleared ? '[X] CLEARED' : '[ ] ARMED  ';
        if (t.isCleared) lastClearedSet.add(t.displayName + t.x + t.y);
        const campStr = t.camp ? `camp dist=${t.campDist.toFixed(1)}u` : 'NO CAMP';
        console.log(`[${String(i + 1).padStart(2, '0')} ${statusStr} ${t.displayName.padEnd(35)} at (${t.x.toFixed(1)}, ${t.y.toFixed(1)}) [${campStr}]`);
      }
      console.log(`\nWatching for combat clears...\n`);
      if (LOG_FILE) { try { fs.appendFileSync(LOG_FILE, `=== RUN ROSTER READY: ${tracked.length} Objectives Tracked ===\n`); } catch {} }
      return;
    }

    // ACTIVE RUN POLLING
    if (tracked && currentSpawner) {
      for (const t of tracked) {
        if (!t.isCleared && t.camp && t.camp.allDeadCpnt) {
          const vt = proc.readPtr(t.camp.allDeadCpnt);
          if (!vt || vt < mod.base) continue;

          const deadVal = proc.readI32(t.camp.allDeadCpnt + 0x48);
          if (deadVal === 0) {
            t.isCleared = true;
            const key = t.displayName + t.x + t.y;
            if (!lastClearedSet.has(key)) {
              lastClearedSet.add(key);
              const timeStr = new Date().toLocaleTimeString();
              const rem = tracked.filter(x => !x.isCleared).length;
              const msg = `[${timeStr}] [X] CLEARED: ${t.displayName} at (${t.x.toFixed(1)}, ${t.y.toFixed(1)}) | Remaining: ${rem} / ${tracked.length}`;
              console.log(`[EVENT] ${msg}`);
              if (LOG_FILE) { try { fs.appendFileSync(LOG_FILE, msg + '\n'); } catch {} }
            }
          }
        }
      }
    }
  }, 1000);
}

startLifecycleLoop();
