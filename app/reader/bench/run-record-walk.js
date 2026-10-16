'use strict';
// Walks the game's current-run record and everything it points at, so the
// summary fields that live behind pointers can be named.
//
//   node app/reader/bench/run-record-walk.js [outfile]
//
// Start it before or during a run; stop with Ctrl+C after hero select.
//
// WHAT IT READS. oCDtCurrentRunProfileData is embedded in oCDtGameProfile;
// HeroScoreData is embedded in it at RUN_TO_SCORE. bench/run-end-watch.js
// found both by vtable and matched their scalar fields against the summary
// screen. This probe finds the record the same way, then walks:
//
//   - every vector header (pointer, count, capacity) in the record, element
//     by element, naming each element by RTTI class or text;
//   - every object pointer one level further, printing any text it points at
//     (resource paths name definitions such as heroes and magical objects).
//   - each object element of a vector, ELEM_SIZE raw bytes, so per-element
//     fields can be read later (talents are candidates in the +0x10 vector);
//   - on the summary only, the score page controllers (SCORE_UI), the same
//     way, because the total score and the score-detail lines are not in the
//     record.
//
// WHEN. Every WALK_MS during a run, to show whether the score record is live
// or written once at the end; on every rising edge of a run-end flag and
// FOLLOW_UPS_MS after it; and when the record clears. The controls are the
// scalar fields already matched to the screen (playtime, level reached,
// total damage), printed on every walk: if they read zero, nothing else in
// that walk is trusted.

const fs = require('fs');
const { openProcess, findPid, moduleBase } = require('../win32');
const { PROCESS_NAME, CURRENT_MAP_ID } = require('../state');
const values = require('../values');
const rtti = require('../rtti');
const { scanPointers } = require('../scan');

const POLL_MS = 500;
const WALK_MS = 30000;
const FIND_MS = 10000;                  // re-look for the record while none is held
const FOLLOW_UPS_MS = [1000, 5000, 15000];
const RECORD_RTTI = '.?AVoCDtCurrentRunProfileData@@\0';
const RECORD_SIZE = 0x1E0;              // the record plus its embedded score data
const RUN_TO_SCORE = 0xD8;
const MAX_ELEMS = 64;
const ELEM_SIZE = 0x100;                // bytes dumped per object element
const UI_SIZE = 0x800;
// Score page controllers: the total score and the score-detail lines are not
// in the run record, so they are looked for here.
const SCORE_UI = [
  'EntityCpntBookScoreUiController@dt@oe@@',
  'EntityCpntPlayerEndScoreUiController@dt@oe@@',
  'EntityCpntPlayerResultStatBookPage@dt@oe@@',
];
const FLAGS = ['Is in defeat sequence', 'Is in victory sequence', 'Is in end credits'];

// Scalars already matched to the summary screen, as record offsets.
const CONTROLS = [
  ['playtime s', 0x9C],
  ['level reached', 0xA0],
  ['damage total', RUN_TO_SCORE + 0xA8],
  ['damage taken', RUN_TO_SCORE + 0xE8],
];

const out = process.argv[2] || null;
const t0 = Date.now();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const hex = (n) => (n === null || n === undefined) ? 'null' : '0x' + n.toString(16).toUpperCase();
const isPtr = (p) => p >= 0x10000 && p <= 0x7FFFFFFFFFFF;

// findPid throws when the game is not running; a watcher waits instead.
function gamePid() {
  try { return findPid(PROCESS_NAME); } catch { return null; }
}

function say(line) {
  const s = `[${((Date.now() - t0) / 1000).toFixed(2).padStart(8)}s] ${line}`;
  console.log(s);
  if (out) fs.appendFileSync(out, s + '\n');
}

function readText(proc, p) {
  const b = proc.read(p, 160);
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

function f32(proc, addr) {
  const b = proc.read(addr, 4);
  return b ? +b.readFloatLE(0).toFixed(3) : null;
}

async function main() {
  // The process appears before its module list does; retry until both read.
  let pid = null, mod = null, proc = null;
  for (;;) {
    pid = gamePid();
    if (pid) {
      try { mod = moduleBase(pid); proc = openProcess(pid); break; } catch { /* still starting */ }
    }
    await sleep(2000);
  }
  const cls = (p) => rtti.classOfVtable(proc, mod.base, mod.size, proc.readPtr(p));

  // One object: its class, and any text reachable from its first 0x100 bytes.
  function name(p) {
    const c = cls(p);
    const t = readText(proc, p);
    if (!c) return t ?? null;
    const b = proc.read(p, 0x100);
    const texts = [];
    if (b) {
      for (let off = 8; off + 8 <= b.length; off += 8) {
        const q = Number(b.readBigUInt64LE(off));
        if (!isPtr(q)) continue;
        const s = readText(proc, q);
        if (s) texts.push(`+${hex(off)}=${s}`);
      }
    }
    return `${c}${texts.length ? ' {' + texts.slice(0, 6).join(' ') + '}' : ''}`;
  }

  // One object: raw bytes, then every vector header and object pointer in it.
  // Vector elements that are objects get their own first ELEM_SIZE bytes, so
  // per-element fields (a talent's identity and state, a score line's value)
  // can be read off the log after the fact.
  function walkObject(addr, size, label) {
    const b = proc.read(addr, size);
    if (!b) { say(`  ${label} ${hex(addr)} unreadable`); return null; }
    say(`  ${label} ${hex(addr)} raw ${b.toString('hex')}`);
    for (let off = 8; off + 24 <= b.length; off += 8) {
      const p = Number(b.readBigUInt64LE(off));
      if (!isPtr(p)) continue;
      const cnt = b.readInt32LE(off + 8), cap = b.readInt32LE(off + 12);
      if (cnt > 0 && cap >= cnt && cap <= 4096) {
        const n = Math.min(cnt, MAX_ELEMS);
        const buf = proc.read(p, n * 8);
        say(`    +${hex(off)} vector count=${cnt} cap=${cap} -> ${hex(p)}`);
        if (buf) {
          for (let i = 0; i < n; i++) {
            const q = Number(buf.readBigUInt64LE(i * 8));
            if (!isPtr(q)) { say(`      [${i}] ${buf.readInt32LE(i * 8)},${buf.readInt32LE(i * 8 + 4)}`); continue; }
            const nm = name(q);
            say(`      [${i}] ${nm ?? hex(q)}`);
            if (nm && cls(q)) {
              const e = proc.read(q, ELEM_SIZE);
              if (e) say(`          raw ${e.toString('hex')}`);
            }
          }
        }
        // Inline-struct case: the raw buffer, so a stride can be read off it.
        const raw = proc.read(p, Math.min(cnt * 0x40, 0x400));
        if (raw) say(`      buf ${raw.toString('hex')}`);
        off += 8;
        continue;
      }
      const nm = name(p);
      if (nm) say(`    +${hex(off)} -> ${nm}`);
    }
    return b;
  }

  function walk(record, reason) {
    const b = proc.read(record, RECORD_SIZE);
    if (!b) { say(`walk (${reason}): record unreadable`); return; }
    say(`walk (${reason}) map=${idx ? idx.resolve(CURRENT_MAP_ID).value : '?'} `
      + CONTROLS.map(([n, off]) => `${n}=${b.readFloatLE(off).toFixed(2)}`).join(' '));
    walkObject(record, RECORD_SIZE, 'record');
  }

  // The score page controllers exist only while the summary is up, so they
  // are found by a fresh scan on each summary walk.
  const uiVt = new Map();
  for (const n of SCORE_UI) {
    for (const r of rtti.resolveAllVtableRvas(proc, mod.base, `.?AV${n}\0`)) uiVt.set(mod.base + r, n);
  }
  function walkScoreUi() {
    const hits = scanPointers(proc, [...uiVt.keys()]);
    for (const [vt, addrs] of hits) {
      for (const a of addrs.slice(0, 4)) walkObject(a, UI_SIZE, uiVt.get(vt) ?? '?');
    }
  }

  const vts = rtti.resolveAllVtableRvas(proc, mod.base, RECORD_RTTI).map(r => mod.base + r);
  const findRecord = () => {
    const hits = scanPointers(proc, vts);
    const all = [...hits.values()].flat();
    if (all.length !== 1) say(`record instances: ${all.length}`);
    return all.length ? all[0] : null;
  };

  let idx = values.buildIndex(proc, mod.base);
  let record = findRecord();
  say(`pid ${pid} record ${hex(record)} index ${idx ? idx.names.size : 0} names`);
  if (record) walk(record, 'startup');

  let lastFlags = '', lastWalk = Date.now(), lastFind = Date.now(), lastPlaytime = null;
  const pending = [];
  for (;;) {
    if (gamePid() !== pid) { say('game exited'); break; }
    const read = (n) => { const r = idx ? idx.resolve(n) : null; return r && r.status === 'ok' ? r.value : null; };
    let flags = FLAGS.map(read);
    if (flags.some(v => v === null)) {
      idx = values.buildIndex(proc, mod.base);
      flags = FLAGS.map(read);
    }
    const key = flags.join(',');
    if (key !== lastFlags) {
      say(`flags ${FLAGS.map((n, i) => `${n}=${flags[i]}`).join(' ')}`);
      if (flags.some(v => v === 1)) {
        record = findRecord() ?? record;
        if (record) walk(record, 'flag rising');
        walkScoreUi();
        for (const ms of FOLLOW_UPS_MS) pending.push({ at: Date.now() + ms, label: `+${ms / 1000}s` });
      }
      lastFlags = key;
    }
    // The record does not exist at the main menu, so a probe started with the
    // game finds nothing at startup; keep looking until a run creates it.
    if (!record && Date.now() - lastFind >= FIND_MS) {
      lastFind = Date.now();
      record = findRecord();
      if (record) say(`record found ${hex(record)}`);
    }
    const playtime = record ? f32(proc, record + 0x9C) : null;
    if (lastPlaytime && lastPlaytime > 0 && playtime === 0 && record) walk(record, 'record cleared');
    lastPlaytime = playtime;
    while (pending.length && Date.now() >= pending[0].at) {
      const next = pending.shift();
      if (next && record) walk(record, `follow-up ${next.label}`);
      if (next) walkScoreUi();
    }
    if (record && Date.now() - lastWalk >= WALK_MS && read(CURRENT_MAP_ID) !== -1) {
      walk(record, 'in run');
      lastWalk = Date.now();
    }
    await sleep(POLL_MS);
  }
  proc.close();
}

process.on('SIGINT', () => { say('stopped'); process.exit(0); });
main().catch(e => { say(`error: ${e.stack || e}`); process.exit(1); });
