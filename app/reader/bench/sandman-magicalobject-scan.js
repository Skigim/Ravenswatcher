#!/usr/bin/env node
'use strict';

/**
 * app/reader/bench/sandman-magicalobject-scan.js
 *
 * Implements the "inverted search" prescribed in sandman_readout.md:
 * Resolves the RTTI class oCDtEntityCpntMagicalObject vtable, discovers all live
 * instances on the heap, and inspects per-instance fields:
 *   - Display Name (Name Value at +0x168 / Debug Name at +0x148)
 *   - Flag Value (filter string at +0x1a8)
 *   - Can Buy Condition (eval condition at +0x1f8)
 *   - Powerup Price (price at +0x1e8)
 *
 * Distinguishes candidate items on offer from the baseline settings pool.
 */

const { openProcess, findPid, moduleBase } = require('../win32');
const { scanPointers } = require('../scan');
const { PROCESS_NAME } = require('../state');
const values = require('../values');
const rtti = require('../rtti');

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const strict = argv.includes('--strict') || argv.includes('--strict-gate');

const hex = n => (n === null || n === undefined) ? 'null' : `0x${n.toString(16).toUpperCase()}`;

// ------------------------------------------------------------------ connect

const pid = findPid(PROCESS_NAME);
if (!pid) {
  console.error(`[ERROR] ${PROCESS_NAME} is not running.`);
  process.exit(1);
}

const mod = moduleBase(pid);
const proc = openProcess(pid);
console.log(`Attached to ${PROCESS_NAME} (PID: ${pid}, Base: ${hex(mod.base)})`);

// ---------------------------------------------------------------- shop gate

const t0 = process.hrtime.bigint();
let shopOpen = null;

const idx = values.buildIndex(proc, mod.base);
if (idx) {
  for (const name of ['Is in sandman shop', 'Reroll count', 'Current dream shards count']) {
    const r = idx.resolve(name);
    console.log(`  ${name.padEnd(30)} ${r.status === 'ok' ? r.value : `<${r.status}>`}`);
  }
  const shop = idx.resolve('Is in sandman shop');
  if (shop.status === 'ok') {
    shopOpen = Boolean(shop.value);
  }
}

if (shopOpen === false) {
  console.log('\n[NOTICE] "Is in sandman shop" is 0: the Sandman shop menu is currently closed.');
  if (strict) {
    console.log('Exiting because --strict was specified.');
    proc.close();
    process.exit(0);
  }
  if (force) {
    console.log('--force flag specified: proceeding with instance scan regardless of shop state.\n');
  } else {
    console.log('Proceeding with instance scan for census and candidate verification (pass --strict to exit when closed).\n');
  }
} else if (shopOpen === true) {
  console.log('\n[INFO] "Is in sandman shop" is 1: Sandman shop menu is OPEN.\n');
}

// ---------------------------------------------------------- RTTI resolution

console.log('Resolving RTTI vtables...');
const rvas = rtti.resolveVtableRvas(proc, mod.base,
  { oCDtEntityCpntMagicalObject: '.?AVoCDtEntityCpntMagicalObject@@\0' });
const rva = rvas.oCDtEntityCpntMagicalObject;

if (!rva) {
  console.error('[ERROR] Could not resolve RTTI vtable RVA for oCDtEntityCpntMagicalObject.');
  proc.close();
  process.exit(1);
}

const vtableAddr = mod.base + rva;
console.log(`oCDtEntityCpntMagicalObject vtable: ${hex(vtableAddr)} (RVA: ${hex(rva)})`);

// ------------------------------------------------------- instance enumeration

console.log('Scanning heap for oCDtEntityCpntMagicalObject instances...');
const tScan0 = process.hrtime.bigint();
const hits = scanPointers(proc, [vtableAddr]);
const scanMs = Number(process.hrtime.bigint() - tScan0) / 1e6;

const instances = hits.get(vtableAddr) || [];
instances.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

console.log(`Discovered ${instances.length} instances of oCDtEntityCpntMagicalObject in ${scanMs.toFixed(1)} ms.`);
console.log(`Sanity control check: Census control is ~168 instances (active world instances typically 125-170).`);
if (instances.length < 50 || instances.length > 300) {
  console.log(`[WARN] Instance count ${instances.length} deviates significantly from expected ~168 control.`);
} else {
  console.log(`Instance count ${instances.length} is within expected control range.`);
}
console.log();

// -------------------------------------------------- helpers for field reading

function readBoundedString(addr, maxLen = 128) {
  if (!addr || addr < 0x10000 || addr > 0x7fffffffffff) return null;
  const buf = proc.read(addr, maxLen);
  if (!buf) return null;
  const z = buf.indexOf(0);
  const slice = z >= 0 ? buf.subarray(0, z) : buf;
  const str = slice.toString('latin1');
  if (/^[\x20-\x7e]*$/.test(str)) return str;
  return null;
}

function readListenerString(instAddr, offset) {
  const listener = proc.readPtr(instAddr + offset);
  if (!listener || listener < 0x10000) return null;
  const strPtr = proc.readPtr(listener + 8);
  return readBoundedString(strPtr);
}

function readListenerI32(instAddr, offset) {
  const listener = proc.readPtr(instAddr + offset);
  if (!listener || listener < 0x10000) return null;
  return proc.readI32(listener + 8);
}

// ---------------------------------------------------- per-instance inspection

console.log('=== INSTANCE ENUMERATION & READOUT ===');
console.log(
  'Idx'.padStart(4) + ' | ' +
  'Instance'.padEnd(14) + ' | ' +
  'Settings'.padEnd(14) + ' | ' +
  'Name Value [Display]'.padEnd(30) + ' | ' +
  'Debug Name'.padEnd(28) + ' | ' +
  'Flag Value'.padEnd(38) + ' | ' +
  'CanBuy'.padEnd(7) + ' | ' +
  'Price'.padEnd(6) + ' | ' +
  'Status'
);
console.log('-'.repeat(165));

const records = [];
let okCount = 0;
let failCount = 0;

for (let i = 0; i < instances.length; i++) {
  const inst = instances[i];
  const settingsPtr = proc.readPtr(inst + 0x10);

  // Field offsets discovered:
  // +0x148: Debug Name (oCTStr<char> listener)
  // +0x168: Name Value [Display Name] (oCTStr<char> listener)
  // +0x1a8: Flag Value (oCTStr<char> listener)
  // +0x1e8: Powerup Price (int32 listener)
  // +0x1f8: Can Buy Condition (bool listener, matching hash [0x893bd3d7, 0x499c44f8])
  // +0x1c8: Secondary condition bool listener
  const debugName = readListenerString(inst, 0x148);
  const nameValue = readListenerString(inst, 0x168);
  const flagValue = readListenerString(inst, 0x1a8);
  const canBuy = readListenerI32(inst, 0x1f8);
  const canBuySecondary = readListenerI32(inst, 0x1c8);
  const price = readListenerI32(inst, 0x1e8);

  const displayName = nameValue || debugName || '<unresolved>';
  const isOk = Boolean(displayName !== '<unresolved>' && settingsPtr && canBuy !== null);

  if (isOk) okCount++; else failCount++;

  const rec = {
    index: i,
    instAddr: inst,
    settingsAddr: settingsPtr,
    displayName,
    debugName: debugName || '<unresolved>',
    flagValue: flagValue !== null ? flagValue : '<unresolved>',
    canBuy,
    canBuySecondary,
    price,
    status: isOk ? 'OK' : 'FAILED',
  };
  records.push(rec);

  console.log(
    `#${i.toString().padStart(3)} | ` +
    `${hex(inst).padEnd(14)} | ` +
    `${hex(settingsPtr).padEnd(14)} | ` +
    `${displayName.slice(0, 29).padEnd(30)} | ` +
    `${(debugName || '').slice(0, 27).padEnd(28)} | ` +
    `${(flagValue !== null ? `"${flagValue}"` : '<err>').slice(0, 37).padEnd(38)} | ` +
    `${(canBuy !== null ? String(canBuy) : '<err>').padEnd(7)} | ` +
    `${(price !== null ? String(price) : '<err>').padEnd(6)} | ` +
    `${rec.status}`
  );
}

console.log('-'.repeat(165));
console.log(`Resolution summary: ${okCount} resolved successfully, ${failCount} failed.\n`);

// ----------------------------------------------------------- candidate summary

// Compute baseline / distributions
const canBuyDist = new Map();
const flagDist = new Map();
for (const r of records) {
  canBuyDist.set(r.canBuy, (canBuyDist.get(r.canBuy) || 0) + 1);
  flagDist.set(r.flagValue, (flagDist.get(r.flagValue) || 0) + 1);
}

// Identify baseline Can Buy Condition (majority value)
let baselineCanBuy = null;
let maxCanBuyCount = -1;
for (const [val, count] of canBuyDist.entries()) {
  if (count > maxCanBuyCount) {
    maxCanBuyCount = count;
    baselineCanBuy = val;
  }
}

// Candidates: instances whose Can Buy Condition or Flag Value differs from baseline/majority
const candidates = records.filter(r => r.canBuy !== baselineCanBuy || r.flagValue.includes('Sandman'));

console.log('=== CANDIDATE OFFERS / DIVERGENCE FROM BASELINE ===');
console.log(`Baseline Can Buy Condition value: ${baselineCanBuy} (${maxCanBuyCount} / ${records.length} instances)`);
console.log('Can Buy Condition distribution:');
for (const [val, count] of canBuyDist.entries()) {
  console.log(`  Can Buy = ${val}: ${count} instances (${((count / records.length) * 100).toFixed(1)}%)`);
}

console.log('\nCandidate items differing from Can Buy baseline (Can Buy != ' + baselineCanBuy + '):');
const differingCanBuy = records.filter(r => r.canBuy !== baselineCanBuy);
if (differingCanBuy.length === 0) {
  console.log('  None. All instances match baseline Can Buy Condition.');
} else {
  for (const c of differingCanBuy) {
    console.log(`  [#${c.index.toString().padStart(3)}] ${hex(c.instAddr)} | ${c.displayName.padEnd(25)} | Flag: ${JSON.stringify(c.flagValue).padEnd(30)} | CanBuy: ${c.canBuy} | Price: ${c.price}`);
  }
}

console.log('\nUnique Sandman candidate items identified in shop pool:');
const uniqueSandman = new Map();
for (const c of candidates) {
  if (c.flagValue.includes('Sandman')) {
    if (!uniqueSandman.has(c.displayName)) {
      uniqueSandman.set(c.displayName, []);
    }
    uniqueSandman.get(c.displayName).push(c);
  }
}

for (const [name, instList] of uniqueSandman.entries()) {
  const sample = instList[0];
  const canBuys = instList.map(x => x.canBuy).join(', ');
  const addrs = instList.map(x => hex(x.instAddr)).join(', ');
  console.log(`  - ${name.padEnd(25)} | Flag: ${sample.flagValue.padEnd(28)} | Price: ${String(sample.price).padEnd(4)} | Instances (${instList.length}): [${addrs}] | CanBuy: [${canBuys}]`);
}

const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`\nScan & readout completed in ${totalMs.toFixed(1)} ms.`);

proc.close();
