'use strict';
// Melody channel only, across a map transition. No classification, no value
// index, no scan in the poll loop.
//
//   node app/reader/bench/melody-transition-watch.js [outfile]
//
// WHY THIS EXISTS SEPARATELY FROM transition-watch.js. That watcher answers
// what the new map placed, and pays for it with marker scans that block its
// poll for seconds at a time. Any melody outage overlapping one of those is
// inflated by however long the scan took, which is why the 2026-08-29 reading
// bracketed the outage at ~14 s without being able to claim it.
//
// This one never scans while the payload is up. The registry is static, the
// hero addresses are cached from one scan at startup, and every poll is
// pointer reads. A drop therefore times the drop and nothing else.
//
// It answers two questions the earlier log could not separate:
//
//  1. HOW LONG the payload is actually gone, at 250 ms resolution.
//  2. WHICH READ fails. Pool and lifecycle come from different places and
//     fail independently, so each poll records the hop that stopped:
//     the hero controllers going away, the scene context going away, the
//     three GUIDs no longer resolving, or the lifecycle array being unreadable
//     while the pool is fine.
//
// When the payload is down it re-scans for heroes at most every RESCAN_MS, to
// tell "the same controllers came back" apart from "the controllers were
// rebuilt". Those polls are logged with their own duration so they can be
// excluded from the outage bracket rather than silently widening it.

const fs = require('fs');
const { openProcess, findPid, moduleBase } = require('../win32');
const { PROCESS_NAME } = require('../state');
const melodies = require('../melodies');
const rtti = require('../rtti');

const POLL_MS = 250;
const RESCAN_MS = 2000;

const out = process.argv[2] || null;
const t0 = Date.now();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function say(line) {
  const t = ((Date.now() - t0) / 1000).toFixed(2).padStart(8);
  const s = `[${t}s] ${line}`;
  console.log(s);
  if (out) { try { fs.appendFileSync(out, s + '\n'); } catch {} }
}

/**
 * Where the read stopped, as a short tag. Pure pointer reads, no scan.
 *
 * Order matters: it reports the FIRST hop that failed, so the tag names a
 * cause rather than a symptom. A hero with no scene context and a hero that
 * does not exist are different failures with different fixes.
 */
function diagnose(proc, heroVt, heroAddrs) {
  let vtOk = 0, entityOk = 0, contextOk = 0, arrayOk = 0;
  for (const a of heroAddrs) {
    if (proc.readPtr(a) !== heroVt) continue;
    vtOk++;
    const entity = proc.readPtr(a + melodies.HERO_ENTITY_OFFSET);
    if (!entity) continue;
    entityOk++;
    if (!proc.readPtr(entity + melodies.ENTITY_CONTEXT_OFFSET)) continue;
    contextOk++;
    const buf = proc.readPtr(a + melodies.HERO_LINKED_MELODIES_OFFSET);
    const cnt = proc.read(a + melodies.HERO_LINKED_COUNT_OFFSET, 4);
    if (buf && cnt && cnt.readUInt32LE(0) > 0) arrayOk++;
  }
  return { vtOk, entityOk, contextOk, arrayOk, total: heroAddrs.length };
}

function summarize(combined) {
  if (!combined) return null;
  return combined.map(m => `${m.slot}:${m.name}/${m.state || 'null'}`).join('  ');
}

(async () => {
  let pid;
  try {
    pid = findPid(PROCESS_NAME);
  } catch (err) {
    console.log(`Could not find ${PROCESS_NAME}: ${err.message}`);
    process.exit(0);
  }
  if (!pid) { console.log(`${PROCESS_NAME} not running.`); process.exit(0); }

  const mod = moduleBase(pid);
  const proc = openProcess(pid);

  const heroRvas = rtti.resolveAllVtableRvas(proc, mod.base, melodies.HERO_CONTROLLER_RTTI);
  const melodyRvas = rtti.resolveAllVtableRvas(proc, mod.base, melodies.MELODY_CPNT_RTTI);
  if (!heroRvas.length || !melodyRvas.length) {
    console.log('RTTI resolution failed; nothing to watch.');
    proc.close();
    process.exit(1);
  }
  const vtables = {
    heroControllerVt: mod.base + heroRvas[0],
    melodyCpntVt: mod.base + melodyRvas[0],
  };
  const registry = melodies.getStaticRegistry();

  const tScan = Date.now();
  let heroes = melodies.findHeroes(proc, vtables, null);
  say(`ATTACH pid=${pid} heroes=${heroes.length} (seed scan ${Date.now() - tScan} ms) poll=${POLL_MS}ms`);
  say('watching melody channel only -- no scans while the payload is up');

  let lastLine = null;
  let downSince = null;
  let lastRescan = 0;

  // Operator marks, on the watcher's own clock.
  //
  // The loading-screen question needs one fact the process cannot supply:
  // whether the screen is up while the payload is down. Comparing a human's
  // wall clock against this log afterwards loses more precision than the
  // 250 ms poll it is being compared to. Pressing Enter instead stamps the
  // mark with the same t0 as every other line, so the two edges can be read
  // straight off one log with nothing to reconcile.
  //
  // Marks alternate: odd presses are the screen appearing, even ones its
  // clearing. A miscount is recoverable -- the label is cosmetic and the
  // timestamp is the reading.
  let marks = 0;
  if (process.stdin.isTTY) {
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.on('data', () => {
      marks += 1;
      say(`MARK ${marks} -- loading screen ${marks % 2 === 1 ? 'APPEARED' : 'CLEARED'}`);
    });
    say('press Enter when the loading screen appears, and again when it clears');
  }

  process.on('SIGINT', () => {
    say('STOP');
    try { proc.close(); } catch {}
    process.exit(0);
  });

  for (;;) {
    let line;
    try {
      const pool = melodies.readPool(proc, vtables, registry, heroes);
      const states = pool
        ? melodies.readStates(proc, vtables, pool, registry, heroes)
        : null;
      const combined = melodies.combineMelodies(pool, states);
      const summary = summarize(combined);

      if (summary) {
        if (downSince !== null) {
          say(`UP after ${((Date.now() - downSince) / 1000).toFixed(2)}s down`);
          downSince = null;
        }
        line = `MELODIES ${summary}`;
      } else {
        if (downSince === null) downSince = Date.now();
        const d = diagnose(proc, vtables.heroControllerVt, heroes);
        const hop = d.vtOk === 0 ? 'no hero controller'
          : d.contextOk === 0 ? 'no scene context'
          : !pool ? 'context up, pool unresolved'
          : 'pool up, lifecycle unreadable';
        line = `DOWN ${hop} [vt ${d.vtOk}/${d.total} entity ${d.entityOk} ctx ${d.contextOk} array ${d.arrayOk}]`
          + (pool ? ' pool=ok' : ' pool=null');
      }
    } catch (err) {
      if (downSince === null) downSince = Date.now();
      line = `DOWN threw ${err.message}`;
    }

    if (line !== lastLine) { say(line); lastLine = line; }

    // Only while down, and never more than once per RESCAN_MS. Logged with its
    // own cost so the outage bracket above stays clean.
    if (downSince !== null && Date.now() - lastRescan > RESCAN_MS) {
      lastRescan = Date.now();
      const before = heroes.join(',');
      const t = Date.now();
      const fresh = melodies.findHeroes(proc, vtables, null);
      const ms = Date.now() - t;
      if (fresh.length) {
        const changed = fresh.join(',') !== before;
        say(`  RESCAN ${ms}ms -> ${fresh.length} heroes, ${changed ? 'DIFFERENT set' : 'same set'}`);
        heroes = fresh;
        lastLine = null;
      } else {
        say(`  RESCAN ${ms}ms -> none found`);
      }
    }

    await sleep(POLL_MS);
  }
})();
