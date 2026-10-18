'use strict';
// Watches one melody being completed, through two independent channels.
//
//   node app/reader/bench/melody-completion-watch.js [outfile]
//
// CODE UNDER TEST. The reader's own path: findHeroes -> readPool -> readStates
// -> combineMelodies, plus the raw linked-array pointer and count at
// HERO_LINKED_MELODIES_OFFSET / HERO_LINKED_COUNT_OFFSET and each entry's
// vtable and lifecycle. Printed whenever any of it changes.
//
// CONTROL. Does not touch the hero controller at all. A heap scan for every
// MelodyEntityCpnt instance (vtable match), each keyed by address and GUID,
// with the int32 window CPNT_WINDOW dumped. Any int32 in that window that
// changes is printed with its offset. If the lifecycle field moved, this is
// where the new one shows up; if the component the hero links is a different
// instance than the ones carrying state, the address column says so.
//
// LINK SEARCH. Once per new hero, walk the controller from 0 to HERO_SPAN for
// any pointer to a buffer whose first entry is a MelodyEntityCpnt instance.
// Prints the offsets found, so a moved linked array is named directly.

const fs = require('fs');
const { openProcess, findPid, moduleBase } = require('../win32');
const { PROCESS_NAME } = require('../state');
const melodies = require('../melodies');
const rtti = require('../rtti');
const { scanPointers } = require('../scan');

const POLL_MS = 500;
const SCAN_EVERY = 4;           // control heap scan every 4th poll (2 s)
const CPNT_WINDOW = [0x10, 0x100];
const HERO_SPAN = 0x2000;

const out = process.argv[2] || null;
const t0 = Date.now();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const hex = (n) => (n === null || n === undefined) ? 'null' : '0x' + n.toString(16).toUpperCase();

function say(line) {
  const t = ((Date.now() - t0) / 1000).toFixed(2).padStart(8);
  const s = `[${t}s] ${line}`;
  console.log(s);
  if (out) { try { fs.appendFileSync(out, s + '\n'); } catch {} }
}

function nameOf(registry, guidHex) {
  const d = registry.get(guidHex);
  return d ? d.internal_name : `?${guidHex.slice(0, 8)}`;
}

function cpntGuid(proc, cpnt) {
  const entity = proc.readPtr(cpnt + melodies.BASE_CPNT_ENTITY_OFFSET);
  if (!entity) return null;
  const objB = proc.readPtr(entity + melodies.ENTITY_B_OBJECT_OFFSET);
  if (!objB) return null;
  const g = proc.read(objB + melodies.B_GUID_OFFSET, 16);
  if (!g || melodies.isZeroGuid(g)) return null;
  return melodies.guidToHex(g);
}

// The reader's own read, with the raw hops it went through.
function codePath(proc, vt, registry, heroes) {
  const pool = melodies.readPool(proc, vt, registry, heroes);
  const states = pool ? melodies.readStates(proc, vt, pool, registry, heroes) : null;
  const view = melodies.combineMelodies(pool, states);
  const raw = [];
  for (const h of heroes) {
    const live = melodies.isLiveHero(proc, h);
    const buf = proc.readPtr(h + melodies.HERO_LINKED_MELODIES_OFFSET);
    const cnt = proc.readI32(h + melodies.HERO_LINKED_COUNT_OFFSET);
    const entries = [];
    if (buf && cnt !== null && cnt > 0) {
      for (let i = 0; i < Math.min(cnt, 16); i++) {
        const c = proc.readPtr(buf + i * 8);
        if (!c) { entries.push('null'); continue; }
        const isMel = proc.readPtr(c) === vt.melodyCpntVt;
        const g = isMel ? cpntGuid(proc, c) : null;
        entries.push(`${hex(c)}${isMel ? '' : '(notMelodyVt)'}:${g ? nameOf(registry, g) : '-'}`
          + `@lc=${proc.readI32(c + melodies.MELODY_LIFECYCLE_OFFSET)}`);
      }
    }
    raw.push(`hero ${hex(h)} live=${live} buf=${hex(buf)} count=${cnt} [${entries.join(', ')}]`);
  }
  const summary = view
    ? view.map(m => `${m.internal_name}=${m.state}`).join(', ')
    : 'null';
  return { summary, raw: raw.join(' | ') };
}

function linkSearch(proc, vt, hero, melodySet) {
  const block = proc.read(hero, HERO_SPAN);
  if (!block) return 'unreadable';
  const hits = [];
  for (let off = 0; off + 8 <= block.length; off += 8) {
    const p = Number(block.readBigUInt64LE(off));
    if (p < 0x10000 || p > 0x7FFFFFFFFFFF) continue;
    const first = proc.readPtr(p);
    if (first && melodySet.has(first)) {
      const cnt = proc.readI32(hero + off + 8);
      hits.push(`+${hex(off)} -> ${hex(p)} (first=${hex(first)}, i32@+8=${cnt})`);
    }
  }
  return hits.length ? hits.join('; ') : 'none';
}

async function main() {
  const pid = findPid(PROCESS_NAME);
  if (!pid) { say(`${PROCESS_NAME} not running`); return; }
  const { base } = moduleBase(pid);
  const proc = openProcess(pid);
  const melodyVt = base + rtti.resolveAllVtableRvas(proc, base, melodies.MELODY_CPNT_RTTI)[0];
  const heroVt = base + rtti.resolveAllVtableRvas(proc, base, melodies.HERO_CONTROLLER_RTTI)[0];
  const vt = { melodyCpntVt: melodyVt, heroControllerVt: heroVt };
  const registry = melodies.getStaticRegistry();
  say(`pid ${pid} melodyVt ${hex(melodyVt)} heroVt ${hex(heroVt)}`);

  let heroes = [];
  let lastSummary = null, lastRaw = null;
  const searched = new Set();
  const window = new Map();       // cpnt addr -> Buffer of the int32 window
  let poll = 0;

  for (;;) {
    if (!proc.isAlive()) { say('game exited'); break; }

    if (poll % SCAN_EVERY === 0) {
      heroes = melodies.findHeroes(proc, vt, null).filter(h => melodies.isLiveHero(proc, h));

      // CONTROL: every melody component instance, int32 window diffed.
      const hits = scanPointers(proc, [melodyVt], { writableOnly: true });
      const insts = (hits.get(melodyVt) || []).map(h => (Array.isArray(h) ? h[0] : h));
      const seen = new Set(insts);
      for (const c of insts) {
        const buf = proc.read(c + CPNT_WINDOW[0], CPNT_WINDOW[1] - CPNT_WINDOW[0]);
        if (!buf) continue;
        const g = cpntGuid(proc, c);
        const label = `${hex(c)} ${g ? nameOf(registry, g) : '-'}`;
        const prev = window.get(c);
        if (!prev) {
          const nz = [];
          for (let o = 0; o < buf.length; o += 4) {
            const v = buf.readInt32LE(o);
            if (v >= -1 && v <= 16 && v !== 0) nz.push(`+${hex(o + CPNT_WINDOW[0])}=${v}`);
          }
          say(`CPNT new ${label} small-ints: ${nz.join(' ')}`);
        } else {
          for (let o = 0; o < buf.length; o += 4) {
            const a = prev.readInt32LE(o), b = buf.readInt32LE(o);
            if (a !== b) say(`CPNT change ${label} +${hex(o + CPNT_WINDOW[0])}: ${a} -> ${b}`);
          }
        }
        window.set(c, buf);
      }
      for (const c of [...window.keys()]) {
        if (!seen.has(c)) { say(`CPNT gone ${hex(c)}`); window.delete(c); }
      }

      for (const h of heroes) {
        if (searched.has(h)) continue;
        searched.add(h);
        say(`LINK search hero ${hex(h)}: ${linkSearch(proc, vt, h, seen)}`);
      }
    }

    // CODE UNDER TEST
    if (heroes.length) {
      const { summary, raw } = codePath(proc, vt, registry, heroes);
      if (summary !== lastSummary) { say(`READER ${summary}`); lastSummary = summary; }
      if (raw !== lastRaw) { say(`RAW ${raw}`); lastRaw = raw; }
    } else if (lastSummary !== 'no heroes') {
      say('READER no live hero');
      lastSummary = 'no heroes';
    }

    poll += 1;
    await sleep(POLL_MS);
  }
  proc.close();
}

main().catch(e => { say(`fatal: ${e.stack || e}`); process.exit(1); });
