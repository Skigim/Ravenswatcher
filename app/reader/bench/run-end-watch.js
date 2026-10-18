'use strict';
// Watches a run end, from the last seconds of play through the victory or
// defeat summary and back to hero select, and records what memory holds.
//
//   node app/reader/bench/run-end-watch.js [outdir]
//
// Start it any time before the run ends; it waits for the game if it is not
// running. Stop with Ctrl+C after hero select. Writes three files to outdir
// (default: the current directory):
//
//   run-end-log.txt     human-readable timeline, also printed
//   run-end-values.jsonl  every GlobalValue change, one object per change
//   run-end-dumps.jsonl   raw instance dumps, one object per instance per scan
//
// THREE CHANNELS, so no single read has to be trusted.
//
// 1. PHASE. A held values index read every POLL_MS: the run-end flags
//    (PHASE_NAMES), map id and hero level. The flags are the candidate
//    trigger; map id -1 is the known run boundary and serves as the control.
//    A flag that flips while map id has not moved, or the reverse, shows
//    which one leads.
//
// 2. ALL VALUES. Every SNAPSHOT_EVERY polls, every name in the index is
//    resolved and compared with the previous snapshot. Any GlobalValue the
//    summary depends on shows up here as a change, with its timestamp, without
//    guessing its name first. The first snapshot is written in full.
//
// 3. INSTANCES. A heap scan for every instance of the end-screen and score
//    classes (TARGETS), at startup, on every phase change, and FOLLOW_UPS_MS
//    after entering a summary phase. Each instance is dumped DUMP_SIZE bytes,
//    well past any field a guess would stop at. Every qword that points at a
//    live object is named by its RTTI class; every pointer to readable ASCII
//    or UTF-16 text is printed with the text. Int32 changes against the
//    previous dump of the same address are listed by offset, so a field that
//    fills in late is timed. The raw hex is in the dumps file for analysis
//    after the fact.
//
// None of this runs through code under test: the reader has no run-end path.

const fs = require('fs');
const path = require('path');
const { openProcess, findPid, moduleBase } = require('../win32');
const { PROCESS_NAME, CURRENT_MAP_ID, HERO_LEVEL } = require('../state');
const values = require('../values');
const rtti = require('../rtti');
const { scanPointers } = require('../scan');

const POLL_MS = 500;
const SNAPSHOT_EVERY = 4;               // all-values diff every 2 s
const INDEX_RETRY_MS = 3000;            // minimum gap between index rebuilds
const FOLLOW_UPS_MS = [2000, 6000, 15000, 30000];
const DUMP_SIZE = 0x800;
const MAX_INSTANCES = 12;               // per class per scan

// Candidate run-end flags. Spellings come from the live index or the
// executable's strings; a name that does not resolve is reported, not assumed.
const PHASE_NAMES = [
  'Is in defeat sequence',
  'Is in victory sequence',
  'Is in end credits',
];

// Classes named in the executable's RTTI that plausibly carry the summary.
const TARGETS = [
  'HeroScoreData@dt@oe@@',
  'oCDtNetMsgSyncHeroScoreData@@',
  'EntityCpntPlayerEndScoreUiController@dt@oe@@',
  'EntityCpntPlayerResultStatBookPage@dt@oe@@',
  'EntityCpntRecapBookPage@dt@oe@@',
  'EntityCpntBookScoreUiController@dt@oe@@',
  'RecapUnlockMiniatureEntitySelectorEntityCpnt@dt@oe@@',
  'ActivityScore@dt@oe@@',
  'ActivityScoreEntityCpnt@dt@oe@@',
  'ActivityScoreUiControllerEntityCpnt@dt@oe@@',
  'oCDtCurrentRunProfileData@@',
  'oCDtHeroProfileData@@',
  'oCDtPlayerProfileData@@',
  'oCDtGameProfile@@',
  'oCGameProfileDataManager@@',
  'oCStatisticsCollection@@',
];

const outDir = process.argv[2] || '.';
fs.mkdirSync(outDir, { recursive: true });
const LOG = path.join(outDir, 'run-end-log.txt');
const VALUES = path.join(outDir, 'run-end-values.jsonl');
const DUMPS = path.join(outDir, 'run-end-dumps.jsonl');

const t0 = Date.now();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const hex = (n) => (n === null || n === undefined) ? 'null' : '0x' + n.toString(16).toUpperCase();
const secs = () => (Date.now() - t0) / 1000;

function say(line) {
  const s = `[${secs().toFixed(2).padStart(8)}s] ${line}`;
  console.log(s);
  fs.appendFileSync(LOG, s + '\n');
}
function jsonl(file, obj) {
  fs.appendFileSync(file, JSON.stringify({ t: +secs().toFixed(2), ...obj }) + '\n');
}

// findPid throws when the game is not running; a watcher waits instead.
function gamePid() {
  try { return findPid(PROCESS_NAME); } catch { return null; }
}

const isPtr = (p) => p >= 0x10000 && p <= 0x7FFFFFFFFFFF;

function readText(proc, p) {
  const b = proc.read(p, 96);
  if (!b) return null;
  let n = 0;
  while (n < b.length && b[n] >= 0x20 && b[n] < 0x7F) n++;
  if (n >= 4 && (n === b.length || b[n] === 0)) return JSON.stringify(b.subarray(0, n).toString('latin1'));
  let w = 0;
  while (w + 1 < b.length && b[w] >= 0x20 && b[w] < 0x7F && b[w + 1] === 0) w += 2;
  if (w >= 8 && (w + 1 >= b.length || (b[w] === 0 && b[w + 1] === 0))) {
    return 'u' + JSON.stringify(b.subarray(0, w).toString('utf16le'));
  }
  return null;
}

// One instance: pointer targets named by class or text, and the raw bytes.
function describe(proc, mod, addr, buf) {
  const refs = [];
  for (let off = 8; off + 8 <= buf.length; off += 8) {
    const p = Number(buf.readBigUInt64LE(off));
    if (!isPtr(p)) continue;
    const cls = rtti.classOfVtable(proc, mod.base, mod.size, proc.readPtr(p));
    if (cls) { refs.push(`+${hex(off)}->${cls}`); continue; }
    const txt = readText(proc, p);
    if (txt) refs.push(`+${hex(off)}->${txt}`);
  }
  return refs;
}

function diffI32(prev, cur) {
  const out = [];
  const n = Math.min(prev.length, cur.length) & ~3;
  for (let off = 0; off < n; off += 4) {
    const a = prev.readInt32LE(off), b = cur.readInt32LE(off);
    if (a !== b) out.push(`+${hex(off)}:${a}->${b}`);
  }
  return out;
}

async function attach() {
  for (;;) {
    const pid = gamePid();
    if (pid) {
      try { return { pid, mod: moduleBase(pid), proc: openProcess(pid) }; } catch { /* still starting */ }
    }
    await sleep(2000);
  }
}

async function main() {
  say(`waiting for ${PROCESS_NAME}; output in ${path.resolve(outDir)}`);
  const { pid, mod, proc } = await attach();
  say(`pid ${pid} base ${hex(mod.base)} size ${hex(mod.size)}`);

  // Vtables are static, so resolve them once. A class with no vtable is
  // reported so its absence from every scan is not mistaken for no instance.
  const vtClass = new Map();
  for (const name of TARGETS) {
    const rvas = rtti.resolveAllVtableRvas(proc, mod.base, `.?AV${name}\0`);
    if (!rvas.length) say(`no vtable for ${name}`);
    for (const rva of rvas) vtClass.set(mod.base + rva, name);
  }
  say(`${vtClass.size} vtables across ${TARGETS.length} classes`);

  let idx = null, idxAt = 0;
  let lastPhase = null, lastLevel = null, lastSnap = null, snapIdx = null;
  const lastDump = new Map();           // instance addr -> Buffer
  const pending = [];                   // { at: ms since t0, label }
  let poll = 0;

  function ensureIndex(force) {
    if (idx && !force) return;
    if (Date.now() - idxAt < INDEX_RETRY_MS) return;
    idxAt = Date.now();
    const t = Date.now();
    idx = values.buildIndex(proc, mod.base);
    say(`index rebuilt: ${idx ? idx.names.size : 0} names, ${Date.now() - t} ms`);
    if (idx) {
      for (const n of PHASE_NAMES) if (!idx.names.has(n)) say(`  "${n}" not in the index`);
    }
  }

  function read(name) {
    if (!idx) return null;
    const r = idx.resolve(name);
    return r.status === 'ok' ? r.value : `<${r.status}>`;
  }

  function scan(reason) {
    const t = Date.now();
    const hits = scanPointers(proc, [...vtClass.keys()]);
    say(`instance scan (${reason}), ${Date.now() - t} ms`);
    for (const [vt, addrs] of hits) {
      const cls = vtClass.get(vt);
      if (!addrs.length) continue;
      say(`  ${cls}: ${addrs.length} instance(s)${addrs.length > MAX_INSTANCES ? `, first ${MAX_INSTANCES}` : ''}`);
      for (const addr of addrs.slice(0, MAX_INSTANCES)) {
        const buf = proc.read(addr, DUMP_SIZE);
        if (!buf) { say(`    ${hex(addr)} unreadable`); continue; }
        const prev = lastDump.get(addr);
        lastDump.set(addr, buf);
        jsonl(DUMPS, { reason, cls, addr: hex(addr), hex: buf.toString('hex') });
        if (prev) {
          const d = diffI32(prev, buf);
          say(`    ${hex(addr)} ${d.length ? `changed ${d.length}: ${d.slice(0, 40).join(' ')}` : 'unchanged'}`);
        } else {
          say(`    ${hex(addr)} new; refs ${describe(proc, mod, addr, buf).slice(0, 40).join(' ') || 'none'}`);
        }
      }
    }
  }

  function snapshot() {
    if (!idx) return;
    // A rebuilt index may hold different names, so diff only within one index.
    if (snapIdx !== idx) { lastSnap = null; snapIdx = idx; }
    const cur = new Map();
    for (const name of idx.names.keys()) cur.set(name, read(name));
    if (!lastSnap) {
      jsonl(VALUES, { kind: 'full', values: Object.fromEntries(cur) });
      say(`full snapshot: ${cur.size} values`);
    } else {
      const changed = [];
      for (const [name, v] of cur) {
        const was = lastSnap.get(name);
        if (was !== v) changed.push([name, was, v]);
      }
      for (const [name, was, v] of changed) jsonl(VALUES, { kind: 'change', name, was, now: v });
      if (changed.length) {
        say(`${changed.length} value(s) changed: ${changed.slice(0, 12)
          .map(([n, a, b]) => `${n} ${a}->${b}`).join('; ')}${changed.length > 12 ? '; ...' : ''}`);
      }
    }
    lastSnap = cur;
  }

  ensureIndex(true);
  scan('startup');

  for (;;) {
    if (gamePid() !== pid) { say('game exited'); break; }
    // At game launch the index is built before the run-end flags exist, so
    // rebuild (throttled) until they resolve, not only when no index is held.
    ensureIndex(!idx || PHASE_NAMES.some(n => idx.resolve(n).status !== 'ok'));
    // Level is logged but kept out of the phase key: a level-up is not a
    // phase change and must not cost an instance scan.
    const level = read(HERO_LEVEL);
    if (level !== lastLevel) { say(`level ${lastLevel} -> ${level}`); lastLevel = level; }
    const flags = PHASE_NAMES.map(n => `${n}=${read(n)}`).join(' ');
    const phase = `${flags} | map=${read(CURRENT_MAP_ID)}`;
    if (phase !== lastPhase) {
      say(`PHASE ${phase}`);
      const entering = PHASE_NAMES.some(n => read(n) === 1);
      if (lastPhase !== null) {
        scan('phase change');
        if (entering) {
          for (const ms of FOLLOW_UPS_MS) pending.push({ at: Date.now() - t0 + ms, label: `+${ms / 1000}s` });
          pending.sort((a, b) => a.at - b.at);
        }
      }
      lastPhase = phase;
    }
    while (pending.length && Date.now() - t0 >= pending[0].at) {
      const next = pending.shift();
      if (next) scan(`follow-up ${next.label}`);
    }
    if (poll++ % SNAPSHOT_EVERY === 0) snapshot();
    await sleep(POLL_MS);
  }
  proc.close();
}

process.on('SIGINT', () => { say('stopped'); process.exit(0); });
main().catch(e => { say(`error: ${e.stack || e}`); process.exit(1); });
