'use strict';
// What is actually in the Sandman's shop right now -- by pointer, not by string.
//
//   node app/reader/bench/sandman-offers.js \
//     --offer "Raven Claw" "Major Shaping" "Gingerbread Man" ... \
//     --control "Sand of Knowledge" "Ace of Spades Card"
//
// SUPERSEDED FOR READING THE OFFERS. The offers are read directly off
// oCDtEntityCpntSandmanMenuUiController + 0x178, a fixed 6-slot array; see
// the header of app/reader/sandman.ts. This probe is kept as a generic
// string -> holder -> referrer search for the next unknown field. The routes
// it and its predecessors closed -- the string walk below, and the
// pointer-proximity clustering that plateaued at 3 of 6 offers -- are in
// ruled_out.md under "Sandman shop", each with its control and measurement.
//
// WHY THIS SHAPE. Every earlier attempt walked DOWN from the controller and
// matched ASCII. That produced a clean negative -- depth 4 from all seven drop
// slots and both UI viewers, 2399 strings, none of the six items on offer --
// but it only ruled out reachable STRINGS. A slot holding a pointer to a
// settings record, or an index into the settings pool, is invisible to a
// string walk and would have read as exactly the same miss. That is what
// happened: the slots were at +0x178 the whole time, holding pointers.
//
// So this searches UP instead, and assumes nothing about where the offer list
// lives. Three hops:
//
//   1. name string      -> its address            (scanStrings)
//   2. name string addr -> the settings record holding it   (scanPointers)
//   3. settings record  -> everything pointing at that record (scanPointerRanges)
//
// Then it clusters the hop-3 referrers and asks which window of memory holds
// pointers reaching MANY offers and FEW controls.
//
// CONTROLS ARE NOT OPTIONAL. The single documented way to be wrong here is to
// find the settings pool and call it the offer list. Three of six offers once
// turned up within 0x220 bytes of each other, which looked exactly like a live
// offer array; dumping the neighbourhood showed the pool of ALL Dt Magical
// Object Data records, holding Rapid_Shaping, Major_Shaping and Minor_Shaping
// regardless of what was for sale. A cluster that contains the controls too is
// that pool. Pass Dreams and objects you can SEE are not on offer, and read the
// control column before the offer column.
//
// Ground truth comes off the screen. A candidate is only a candidate if it
// resolves different slots to different names matching what is actually
// displayed; one name for every slot is a shared table.
//
// Hop 1 scans all regions because a display name can live in read-only image
// data. Hops 2 and 3 are heap-only: the offer list is live runtime state, and
// widening them to 5.4 GB costs minutes rather than seconds. --all widens them
// if a heap-only pass comes back empty.

const { openProcess, findPid, moduleBase } = require('../win32');
const { scanStrings, scanPointers, scanPointerRanges } = require('../scan');
const { PROCESS_NAME } = require('../state');
const values = require('../values');

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const offers = [];
const controls = [];
let bucket = null;
let allRegions = false;
let recordWindow = 0x100;   // +/- bytes around a name-holder that count as "the record"
let clusterSpan = null;     // one span to test; null sweeps SPAN_LADDER

// The shape of the offer list decides how far apart its pointers sit, and we
// do not know the shape yet. A packed array of six pointers spans 0x30; the
// seven oCDtEntityCpntMagicalObjectsDrop slots are 0x298 apart, so one pointer
// per slot spans 0xF90. Guessing wrong reads as a clean negative, and hop 1
// costs ~35 s, so sweep instead of guessing -- the scans are the expensive
// part and re-clustering their output is free.
const SPAN_LADDER = [0x40, 0x100, 0x400, 0x1000, 0x4000];

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--offer') { bucket = offers; continue; }
  if (a === '--control') { bucket = controls; continue; }
  if (a === '--all') { allRegions = true; continue; }
  if (a === '--window') { recordWindow = Number(argv[++i]); continue; }
  if (a === '--span') { clusterSpan = Number(argv[++i]); continue; }
  if (a.startsWith('--')) { console.error(`unknown flag ${a}`); process.exit(1); }
  if (!bucket) { console.error('names must follow --offer or --control'); process.exit(1); }
  bucket.push(a);
}

// One item, several spellings. A live record may point at the display string
// ("Star Fragment"), at the Debug Name ("Star_Fragment"), or at a loc key
// ("Sandman_Reroll_Name") -- the .gen files use all three, and Name Value is
// the key rather than the text. Searching every form is necessary; counting
// them as separate items is wrong, because a cluster reaching two spellings of
// ONE Dream would score as two offers and outrank a genuine pair. So a bucket
// entry is `Display|Debug|Key`, one item with several needles.
//
// Derivation cannot replace this. "Sand of Enlightenment" is stored as
// Sand_Of_Enlightment -- the game drops the second "en" -- so a rule that
// underscores and title-cases the display name silently misses it.
const parseItem = (s, offer) => {
  const needles = s.split('|').map(x => x.trim()).filter(Boolean);
  return { label: needles[0], needles, offer };
};
const items = [
  ...offers.map(s => parseItem(s, true)),
  ...controls.map(s => parseItem(s, false)),
];

if (!offers.length) {
  console.error('usage: sandman-offers.js --offer <name>... --control <name>...');
  console.error('       A name is the DISPLAY text as shown in the shop, and may');
  console.error('       carry alternate spellings after a pipe -- all are searched,');
  console.error('       all count as one item:');
  console.error('         --offer "Sand of Enlightenment|Sand_Of_Enlightment"');
  process.exit(1);
}
if (!controls.length) {
  console.error('REFUSING TO RUN WITHOUT CONTROLS. Without at least one name you');
  console.error('can see is NOT on offer, a cluster containing all your offers is');
  console.error('indistinguishable from the settings pool, which contains every');
  console.error('Dream whatever is for sale. Pass --control with 2+ absent names.');
  process.exit(1);
}

const hex = n => `0x${n.toString(16).toUpperCase()}`;
const isOffer = new Map(items.map(i => [i.label, i.offer]));
const allNames = items.map(i => i.label);
const needleItem = new Map();          // needle string -> owning item label
for (const i of items) for (const n of i.needles) needleItem.set(n, i.label);
const allNeedles = [...needleItem.keys()];

// ------------------------------------------------------------------ connect

const pid = findPid(PROCESS_NAME);
if (!pid) {
  console.error(`${PROCESS_NAME} is not running.`);
  process.exit(1);
}
const mod = moduleBase(pid);
const proc = openProcess(pid);
console.log(`pid ${pid}  base ${hex(mod.base)}`);
const spans = clusterSpan === null ? SPAN_LADDER : [clusterSpan];
console.log(`${offers.length} offer(s), ${controls.length} control(s), `
  + `window ${hex(recordWindow)}, spans ${spans.map(hex).join(' ')}\n`);

// The shop state is the run's own control: if the game says the shop is shut,
// whatever this finds is last night's stock or nothing at all.
const idx = values.buildIndex(proc, mod.base);
if (idx) {
  for (const name of ['Is in sandman shop', 'Reroll count', 'Current dream shards count']) {
    const r = idx.resolve(name);
    console.log(`  ${name.padEnd(30)} ${r.status === 'ok' ? r.value : `<${r.status}>`}`);
  }
  const shop = idx.resolve('Is in sandman shop');
  if (shop.status === 'ok' && !shop.value) {
    console.log('\n  !! Is in sandman shop is 0. The menu is not open. Anything found');
    console.log('     below is not being displayed, and cannot be checked against');
    console.log('     the screen -- which is the only thing that makes it evidence.');
  }
  console.log();
}

const timed = (label, fn) => {
  const t0 = process.hrtime.bigint();
  const out = fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`${label}  ${ms.toFixed(0)} ms`);
  return out;
};

// -------------------------------------------------- hop 1: name -> string addr

console.log('== hop 1: display name -> string address (all regions) ==');
const strHits = timed('scanStrings', () => scanStrings(proc, allNeedles, { writableOnly: false }));

const stringAddrs = [];   // {name (item label), addr}
for (const item of items) {
  const tag = item.offer ? 'OFFER  ' : 'control';
  let total = 0;
  const parts = [];
  for (const n of item.needles) {
    const hits = strHits.get(n) ?? [];
    total += hits.length;
    parts.push(`${n} ${hits.length}`);
    for (const a of hits) stringAddrs.push({ name: item.label, addr: a });
  }
  console.log(`  ${tag} ${String(total).padStart(3)} hit(s)  ${item.label}`
    + (item.needles.length > 1 ? `   [${parts.join(', ')}]` : ''));
}

// An item is missing only when EVERY spelling of it is absent.
const missing = items.filter(i => !i.needles.some(n => (strHits.get(n) ?? []).length))
  .map(i => i.label);
if (missing.length) {
  console.log(`\n  !! ABSENT: ${missing.join(', ')}`);
  console.log('     scanStrings matches WHOLE NUL-terminated strings. Absent means');
  console.log('     nothing is exactly this text, not that the text is unused --');
  console.log('     check the spelling against Text/*.LangEN via tools/dump_text_table.py.');
}
if (!stringAddrs.length) { proc.close(); process.exit(1); }

// ------------------------------------------ hop 2: string addr -> holder field

console.log('\n== hop 2: who points at those strings (settings records) ==');
const holderHits = timed('scanPointers',
  () => scanPointers(proc, stringAddrs.map(s => s.addr), { writableOnly: !allRegions }));

const holders = [];   // {name, addr}
const byName = new Map(allNames.map(n => [n, 0]));
for (const { name, addr } of stringAddrs) {
  for (const h of holderHits.get(addr) ?? []) {
    holders.push({ name, addr: h });
    byName.set(name, byName.get(name) + 1);
  }
}
for (const n of allNames) {
  const tag = isOffer.get(n) ? 'OFFER  ' : 'control';
  console.log(`  ${tag} ${String(byName.get(n)).padStart(3)} holder(s)  ${n}`);
}
if (!holders.length) {
  console.log('\n  Nothing on the heap points at these strings. Retry with --all;');
  console.log('  if that is also empty the names are stored some other way (an id,');
  console.log('  a hash, or UTF-16) and hop 1 needs a different needle.');
  proc.close();
  process.exit(1);
}

// ----------------------------- hop 3: settings record -> what points at IT

console.log('\n== hop 3: who points into those records ==');
const ranges = holders.map(h => [h.addr - recordWindow, h.addr + recordWindow]);
const refHits = timed('scanPointerRanges',
  () => scanPointerRanges(proc, ranges, { writableOnly: !allRegions }));

// A referrer is an address holding a pointer that lands in some record window.
// Windows can overlap when records are packed tighter than 2*window, so a
// referrer may legitimately reach more than one name -- carry all of them
// rather than picking one, and let the overlap show in the report.
const referrers = [];   // {addr, names:Set}
const seen = new Map();
for (const [value, addrs] of refHits) {
  const reached = holders.filter(h => value >= h.addr - recordWindow && value <= h.addr + recordWindow);
  if (!reached.length) continue;
  for (const at of addrs) {
    let e = seen.get(at);
    if (!e) { e = { addr: at, names: new Set(), values: new Set() }; seen.set(at, e); referrers.push(e); }
    for (const r of reached) e.names.add(r.name);
    e.values.add(value);
  }
}
referrers.sort((a, b) => a.addr - b.addr);
console.log(`  ${referrers.length} referring address(es)`);

const ambiguous = referrers.filter(r => r.names.size > 1).length;
if (ambiguous) {
  console.log(`  ${ambiguous} of them land in OVERLAPPING record windows and reach`);
  console.log(`  more than one name. Records are packed tighter than ${hex(recordWindow * 2)};`);
  console.log('  re-run with a smaller --window to sharpen attribution.');
}

// ------------------------------------------------------------- cluster report

// Best = most offers, then fewest controls, then tightest. A cluster carrying
// every offer AND every control is the settings pool, and sorts itself down.
const rank = (a, b) =>
  b.offers.size - a.offers.size
  || a.controls.size - b.controls.size
  || (a.hi - a.lo) - (b.hi - b.lo);

function clustersAt(span) {
  const out = [];
  for (let i = 0; i < referrers.length; i++) {
    const o = new Set(), c = new Set();
    let j = i;
    for (; j < referrers.length && referrers[j].addr - referrers[i].addr <= span; j++) {
      for (const n of referrers[j].names) (isOffer.get(n) ? o : c).add(n);
    }
    if (o.size < 2) continue;
    out.push({ lo: referrers[i].addr, hi: referrers[j - 1].addr, n: j - i, offers: o, controls: c, span });
  }
  out.sort(rank);
  // Drop clusters wholly contained in an earlier, better one.
  const kept = [];
  for (const c of out) {
    if (kept.some(k => c.lo >= k.lo && c.hi <= k.hi)) continue;
    kept.push(c);
    if (kept.length >= 12) break;
  }
  return kept;
}

const verdictOf = c =>
  c.controls.size === 0 && c.offers.size >= Math.min(3, offers.length)
    ? 'CANDIDATE -- offers only'
    : c.controls.size >= controls.length
      ? 'settings pool (holds the controls too)'
      : `mixed, ${c.controls.size}/${controls.length} controls present`;

console.log('\n== clusters, by how far apart referrers may sit ==');
const perSpan = new Map();
for (const span of spans) {
  const k = clustersAt(span);
  perSpan.set(span, k);
  const top = k[0];
  console.log(`  span ${hex(span).padEnd(8)} ${String(k.length).padStart(3)} cluster(s)  `
    + (top ? `best ${top.offers.size}/${offers.length} offers, ${top.controls.size}/${controls.length} controls` : '--'));
}

// Report against the span that found the most offers with the fewest controls.
// A wider span always finds at least as many offers, so ties break to the
// tightest -- a 0x40 hit is an array, a 0x4000 hit is a neighbourhood.
const kept = [...perSpan.values()].flat().sort(rank).slice(0, 12);
if (kept.length) {
  console.log(`\n== best clusters overall ==`);
  console.log(`  ${'range'.padEnd(34)} span    ptrs  offers  controls  verdict`);
  for (const c of kept) {
    const range = `${hex(c.lo)}..+${hex(c.hi - c.lo)}`;
    console.log(`  ${range.padEnd(34)} ${hex(c.span).padEnd(7)} ${String(c.n).padStart(4)}  `
      + `${String(c.offers.size).padStart(6)}  ${String(c.controls.size).padStart(8)}  ${verdictOf(c)}`);
  }
}

if (!kept.length) {
  console.log('  No window holds pointers reaching 2+ offers. The offers are not');
  console.log('  grouped by pointer anywhere on the heap -- which would mean they');
  console.log('  are stored as indices or ids into the settings pool, not pointers.');
  console.log(`  ${referrers.length} referrer(s) exist, so the strings ARE pointed at --`);
  console.log('  they are simply not pointed at from one place.');
} else {
  const best = kept[0];
  console.log(`\n  top cluster reaches: ${[...best.offers].join(', ')}`);
  if (best.controls.size) console.log(`  ...and controls: ${[...best.controls].join(', ')}`);

  console.log(`\n== qwords around ${hex(best.lo)} ==`);
  const dumpLo = best.lo - 0x40;
  const buf = proc.read(dumpLo, Math.min(0x400, (best.hi - dumpLo) + 0x80));
  if (!buf) {
    console.log('  read failed');
  } else {
    const hot = new Map();
    for (const r of referrers) if (r.addr >= dumpLo && r.addr < dumpLo + buf.length) hot.set(r.addr, r);
    for (let off = 0; off + 8 <= buf.length; off += 8) {
      const at = dumpLo + off;
      const v = buf.readUInt32LE(off + 4) * 4294967296 + buf.readUInt32LE(off);
      const r = hot.get(at);
      const mark = r ? ` <-- ${[...r.names].join(' / ')}` : '';
      console.log(`  ${hex(at)}  +${off.toString(16).padStart(3, '0')}  ${hex(v)}${mark}`);
    }
  }
}

console.log('\nCheck the top cluster against the screen before believing it.');
proc.close();
