#!/usr/bin/env node
'use strict';

/**
 * app/reader/bench/sandman-field-vs-truth.js
 *
 * Tests one candidate per-instance field on oCDtEntityCpntMagicalObject against
 * a ground-truth list of what the Sandman is actually offering on screen.
 *
 * Default candidate is the listener at +0x1c8, the field
 * sandman-magicalobject-scan.js reads but does not interpret.
 *
 * Usage:
 *   node app/reader/bench/sandman-field-vs-truth.js \
 *     --offer "Dream of Invulnerability" --offer "Gingerbread Man" ... \
 *     [--field 0x1c8] [--force]
 *
 * Aliases per item are '|'-separated, matching sandman-offers.js, because debug
 * names diverge from display names (Sand_Of_Enlightment).
 *
 * Disqualification tests, applied in the order sandman_readout.md prescribes:
 *   A. Does the field vary across instances of the SAME Dream? If it never
 *      does, it is an authored per-type table, not a per-visit stock marker.
 *   B. Is there any value that partitions exactly the offered names from the
 *      rest? If no value separates them, the field does not encode stock.
 *   C. Do offered and not-offered instances within one tier read differently?
 */

const { openProcess, findPid, moduleBase } = require('../win32');
const { scanPointers } = require('../scan');
const { PROCESS_NAME } = require('../state');
const values = require('../values');
const rtti = require('../rtti');

const argv = process.argv.slice(2);
const force = argv.includes('--force');

const offers = [];
let fieldOffset = 0x1c8;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--offer' && argv[i + 1]) offers.push(argv[++i]);
  else if (argv[i] === '--field' && argv[i + 1]) fieldOffset = Number(argv[++i]);
}

if (offers.length === 0) {
  console.error('[ERROR] Refusing to run without ground truth. Pass --offer "<name>" per on-screen item.');
  process.exit(1);
}

const hex = n => (n === null || n === undefined) ? 'null' : `0x${n.toString(16).toUpperCase()}`;
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// offer entry -> array of normalised aliases
const offerAliases = offers.map(o => ({
  label: o.split('|')[0].trim(),
  keys: o.split('|').map(a => norm(a)).filter(Boolean),
}));

function matchOffer(displayName, debugName) {
  const dn = norm(displayName);
  const db = norm(debugName);
  for (const o of offerAliases) {
    for (const k of o.keys) {
      if (k && (k === dn || k === db)) return o.label;
    }
  }
  return null;
}

// ------------------------------------------------------------------ connect

const pid = findPid(PROCESS_NAME);
if (!pid) {
  console.error(`[ERROR] ${PROCESS_NAME} is not running.`);
  process.exit(1);
}
const mod = moduleBase(pid);
const proc = openProcess(pid);
console.log(`Attached to ${PROCESS_NAME} (PID ${pid}, base ${hex(mod.base)})`);
console.log(`Candidate field: instance + ${hex(fieldOffset)} -> listener + 0x08`);
console.log(`Ground truth (${offerAliases.length} on-screen offers): ${offerAliases.map(o => o.label).join(', ')}\n`);

// ---------------------------------------------------------------- shop gate

const t0 = process.hrtime.bigint();
const idx = values.buildIndex(proc, mod.base);
let shopOpen = null;
if (idx) {
  for (const name of ['Is in sandman shop', 'Reroll count', 'Current dream shards count']) {
    const r = idx.resolve(name);
    console.log(`  ${name.padEnd(30)} ${r.status === 'ok' ? r.value : `<${r.status}>`}`);
  }
  const shop = idx.resolve('Is in sandman shop');
  if (shop.status === 'ok') shopOpen = Boolean(shop.value);
}
if (shopOpen === false && !force) {
  console.log('\n[ABORT] "Is in sandman shop" is 0. Ground truth was read off an open shop;');
  console.log('        testing against a closed one risks measuring a torn-down state.');
  console.log('        Re-open the shop, or pass --force to scan anyway.');
  proc.close();
  process.exit(2);
}
console.log(`\n[INFO] shop open: ${shopOpen}\n`);

// ---------------------------------------------------------- RTTI + instances

const rvas = rtti.resolveVtableRvas(proc, mod.base,
  { oCDtEntityCpntMagicalObject: '.?AVoCDtEntityCpntMagicalObject@@\0' });
const rva = rvas.oCDtEntityCpntMagicalObject;
if (!rva) {
  console.error('[ERROR] Could not resolve oCDtEntityCpntMagicalObject vtable RVA.');
  proc.close();
  process.exit(1);
}
const vtableAddr = mod.base + rva;
const hits = scanPointers(proc, [vtableAddr]);
const instances = (hits.get(vtableAddr) || []).slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
console.log(`oCDtEntityCpntMagicalObject vtable ${hex(vtableAddr)} -> ${instances.length} live instances\n`);

// -------------------------------------------------------------- field reads

function readBoundedString(addr, maxLen = 128) {
  if (!addr || addr < 0x10000 || addr > 0x7fffffffffff) return null;
  const buf = proc.read(addr, maxLen);
  if (!buf) return null;
  const z = buf.indexOf(0);
  const slice = z >= 0 ? buf.subarray(0, z) : buf;
  const str = slice.toString('latin1');
  return /^[\x20-\x7e]*$/.test(str) ? str : null;
}

function readListenerString(instAddr, offset) {
  const listener = proc.readPtr(instAddr + offset);
  if (!listener || listener < 0x10000) return null;
  return readBoundedString(proc.readPtr(listener + 8));
}

function readCandidate(instAddr, offset) {
  const listener = proc.readPtr(instAddr + offset);
  if (!listener || listener < 0x10000) return { listener: null, i32: null, qword: null, asStr: null };
  const i32 = proc.readI32(listener + 8);
  const qword = proc.readPtr(listener + 8);
  // If the qword looks like a pointer, the field may be a string rather than an int.
  const asStr = (qword && qword > 0x10000 && qword < 0x7fffffffffff) ? readBoundedString(qword, 64) : null;
  return { listener, i32, qword, asStr };
}

const records = [];
for (let i = 0; i < instances.length; i++) {
  const inst = instances[i];
  const debugName = readListenerString(inst, 0x148);
  const nameValue = readListenerString(inst, 0x168);
  const flagValue = readListenerString(inst, 0x1a8);
  const canBuy = (() => {
    const l = proc.readPtr(inst + 0x1f8);
    return (l && l > 0x10000) ? proc.readI32(l + 8) : null;
  })();
  const price = (() => {
    const l = proc.readPtr(inst + 0x1e8);
    return (l && l > 0x10000) ? proc.readI32(l + 8) : null;
  })();
  const cand = readCandidate(inst, fieldOffset);
  const displayName = nameValue || debugName || '<unresolved>';
  records.push({
    index: i,
    inst,
    displayName,
    debugName: debugName || '',
    flagValue: flagValue === null ? '<unresolved>' : flagValue,
    canBuy,
    price,
    cand,
    offered: matchOffer(displayName, debugName || ''),
  });
}

// ------------------------------------------------------------- full readout

console.log('=== PER-INSTANCE READOUT ===');
console.log(
  'Idx'.padStart(4) + ' | ' + 'Instance'.padEnd(14) + ' | ' + 'Display Name'.padEnd(26) + ' | ' +
  'Flag Value'.padEnd(30) + ' | ' + 'Price'.padEnd(5) + ' | ' + 'CanBuy'.padEnd(6) + ' | ' +
  `+${hex(fieldOffset)} listener`.padEnd(18) + ' | ' + 'i32'.padEnd(12) + ' | ' + 'as str'.padEnd(18) + ' | OFFER'
);
console.log('-'.repeat(160));
for (const r of records) {
  console.log(
    `#${String(r.index).padStart(3)} | ${hex(r.inst).padEnd(14)} | ${r.displayName.slice(0, 25).padEnd(26)} | ` +
    `${r.flagValue.slice(0, 29).padEnd(30)} | ${String(r.price ?? '-').padEnd(5)} | ${String(r.canBuy ?? '-').padEnd(6)} | ` +
    `${hex(r.cand.listener).padEnd(18)} | ${String(r.cand.i32 ?? '-').padEnd(12)} | ` +
    `${(r.cand.asStr === null ? '-' : JSON.stringify(r.cand.asStr)).slice(0, 17).padEnd(18)} | ${r.offered ? 'YES <<<' : ''}`
  );
}
console.log('-'.repeat(160));

// ---------------------------------------------------------- ground truth map

const offered = records.filter(r => r.offered);
const notOffered = records.filter(r => !r.offered);
const foundLabels = new Set(offered.map(r => r.offered));
const missing = offerAliases.filter(o => !foundLabels.has(o.label));

console.log(`\n=== GROUND TRUTH COVERAGE ===`);
console.log(`Offered instances found: ${offered.length} (covering ${foundLabels.size}/${offerAliases.length} on-screen items)`);
if (missing.length) {
  console.log(`[WARN] No live instance matched: ${missing.map(o => o.label).join(', ')}`);
  console.log('       These may be ordinary objects whose display name differs, or absent from this class.');
}

// ------------------------------------------------------- disqualification A

console.log(`\n=== TEST A: does +${hex(fieldOffset)} vary across instances of the SAME item? ===`);
const byName = new Map();
for (const r of records) {
  if (!byName.has(r.displayName)) byName.set(r.displayName, []);
  byName.get(r.displayName).push(r);
}
let variesWithin = 0;
let multiInstanceNames = 0;
for (const [name, rs] of byName) {
  if (rs.length < 2) continue;
  multiInstanceNames++;
  const vals = new Set(rs.map(r => String(r.cand.i32)));
  if (vals.size > 1) {
    variesWithin++;
    console.log(`  VARIES: ${name.padEnd(28)} x${rs.length} -> {${[...vals].join(', ')}}`);
  }
}
console.log(`  ${variesWithin} of ${multiInstanceNames} multi-instance items vary internally.`);
if (variesWithin === 0) {
  console.log('  => Constant per item type. Behaves like an authored table, not per-visit stock.');
}

// ------------------------------------------------------- disqualification B

console.log(`\n=== TEST B: does any value of +${hex(fieldOffset)} partition the offer list? ===`);
const valueSet = new Map();
for (const r of records) {
  const k = String(r.cand.i32);
  if (!valueSet.has(k)) valueSet.set(k, { offered: [], notOffered: [] });
  (r.offered ? valueSet.get(k).offered : valueSet.get(k).notOffered).push(r);
}
console.log(`  value | #offered | #not-offered | distinct offered items`);
let cleanPartition = null;
for (const [val, g] of [...valueSet.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
  const names = new Set(g.offered.map(r => r.offered));
  console.log(`  ${val.padEnd(6)}| ${String(g.offered.length).padEnd(9)}| ${String(g.notOffered.length).padEnd(13)}| ${[...names].join(', ') || '-'}`);
  if (g.notOffered.length === 0 && names.size === foundLabels.size && foundLabels.size > 0) cleanPartition = val;
}
if (cleanPartition !== null) {
  console.log(`\n  => VALUE ${cleanPartition} SELECTS EXACTLY THE OFFER LIST. Candidate survives.`);
} else {
  console.log('\n  => No value isolates the offer list. Every value that covers offered items');
  console.log('     also covers items that are not on screen.');
}

// ------------------------------------------------------- disqualification C

console.log(`\n=== TEST C: offered vs not-offered WITHIN the same Flag Value tier ===`);
const byFlag = new Map();
for (const r of records) {
  if (!byFlag.has(r.flagValue)) byFlag.set(r.flagValue, []);
  byFlag.get(r.flagValue).push(r);
}
for (const [flag, rs] of byFlag) {
  const on = rs.filter(r => r.offered);
  const off = rs.filter(r => !r.offered);
  if (on.length === 0 || off.length === 0) continue;
  const onVals = new Set(on.map(r => String(r.cand.i32)));
  const offVals = new Set(off.map(r => String(r.cand.i32)));
  const overlap = [...onVals].filter(v => offVals.has(v));
  console.log(`  ${JSON.stringify(flag).slice(0, 34).padEnd(36)} offered{${[...onVals].join(',')}} vs not-offered{${[...offVals].join(',')}}` +
    (overlap.length ? `  OVERLAP -> cannot distinguish` : `  DISJOINT`));
}

const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`\nCompleted in ${totalMs.toFixed(1)} ms.`);
proc.close();
