'use strict';
// The settings -> binding -> live value chain, and readState() on top of it,
// against test/fakegame.js: a child process whose heap holds records in the
// layout live_memory_reading.md documents, with the answers known by
// construction.
//
// Ravenswatch.exe is not attached to. What this covers: the aligned sweep on
// a real process, the name decode off the {char*, len|0x80000000, flags}
// triple, the settings<->binding join through with_prev, both union variants,
// the Float reinterpretation, "binding object not found" for an orphan, and
// readState() driven by a real index rather than a fixture dict.

const { spawn } = require('child_process');
const path = require('path');
const { openProcess } = require('../win32');
const values = require('../values');
const { readState, TRACKED_NAMES, CURRENT_MAP_ID, MAP_ID_SUFFIX } = require('../state');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

function run(info) {
  console.log(`\ntest-chain: fake heap in pid ${info.pid}`);
  const proc = openProcess(info.pid);
  const t0 = process.hrtime.bigint();
  const index = values.buildIndex(proc, info.base, info.settingsVt, info.unionVt, info.bindingVt);
  const t1 = process.hrtime.bigint();
  check('buildIndex returned an index', index !== null,
    index ? `${index.names.size} names, ${index.bindings.size} bindings in ${(Number(t1 - t0) / 1e6).toFixed(0)} ms` : '');
  if (!index) { proc.close(); return failures; }

  const planned = Object.keys(info.expected);
  check('every planted settings instance was named',
    planned.every(n => index.names.has(n)),
    `${planned.filter(n => index.names.has(n)).length}/${planned.length}`);

  let okCount = 0, bad = [];
  for (const [name, want] of Object.entries(info.expected)) {
    const got = index.resolve(name);
    if (want.status !== 'ok') {
      if (got.status === want.status) okCount++;
      else bad.push(`${name}: status ${got.status} != ${want.status}`);
      continue;
    }
    const valOk = want.variant === 'inline' && !Number.isInteger(want.value)
      ? Math.abs(got.value - want.value) < 1e-6
      : got.value === want.value;
    const ok = got.status === 'ok'
      && got.variant === want.variant
      && valOk
      && got.union_vtable_ok === true
      && got.settings_addr === '0x' + want.settings_addr.toString(16)
      && got.binding_addr === '0x' + want.binding_addr.toString(16)
      && got.default_guess === 7777;
    if (ok) okCount++;
    else bad.push(`${name}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`);
  }
  check('every planted value resolved to exactly what was planted',
    bad.length === 0, `${okCount}/${planned.length}`);
  for (const b of bad.slice(0, 6)) console.log(`        ${b}`);

  // Float: the inline slot holds a raw bit pattern; the .gen type is what says
  // to reinterpret it. raw_i32 must survive alongside the float.
  const tree = index.resolve('Giant_Tree_HP_Ratio');
  check('Float-typed inline value came back as a float with raw_i32 kept',
    tree.type === 'Float' && Math.abs(tree.value - 0.64) < 1e-6 && tree.raw_i32 === 0x3F23D70A,
    `value=${tree.value} raw_i32=0x${(tree.raw_i32 >>> 0).toString(16)}`);

  // Bool and Int must be typed off value_types.json, not off the runtime tag.
  check('Bool and Int typed from the .gen/JSON map, not the runtime tag',
    index.resolve('Is In Combat').type === 'Bool'
    && index.resolve('Hero Level').type === 'Int'
    && index.resolve('Is In Combat').variant === 'inline'
    && index.resolve('Hero Level').variant === 'boxed-int');

  // A zero must arrive as 0, distinct from an unresolved name arriving as a
  // non-"ok" status. This is the trap the whole readout hangs on.
  const zero = index.resolve('Current_House_Type');
  const missing = index.resolve('No_Such_Value_At_All');
  check('zero is a value, unresolved is a status',
    zero.status === 'ok' && zero.value === 0
    && missing.status === 'settings instance not found' && missing.value === undefined);

  // Map ids read out of the process, not hardcoded -- and they start at 0.
  const maps = {};
  for (const name of index.names.keys()) {
    if (name.endsWith(MAP_ID_SUFFIX) && name !== CURRENT_MAP_ID) {
      const r = index.resolve(name);
      if (r.status === 'ok' && r.value !== null) maps[r.value] = name.slice(0, -MAP_ID_SUFFIX.length);
    }
  }
  check('map id table read from the process, Dark Hills at 0',
    maps[0] === 'Dark Hills' && maps[1] === 'Storm Island'
    && maps[2] === 'Avalon' && maps[3] === 'Baba Yaga Map',
    JSON.stringify(maps));

  // readState() driven by the live index.
  const resolvedNames = {};
  for (const n of TRACKED_NAMES) {
    const r = index.resolve(n);
    resolvedNames[n] = r.status === 'ok' ? r.value : null;
  }
  const src = {
    get: (n) => (resolvedNames[n] === undefined ? null : resolvedNames[n]),
    maps: () => maps,
    found: () => Object.values(resolvedNames).filter(v => v !== null).length,
    placement: () => ({ mapId: 0, placed: ['DarkHills\\Jack\\Jack_Quest_Manager.entity.ot'] }),
  };
  const state = readState(src, { runtime: { sweeps: 1, pid: info.pid, base: info.base } });
  check('readState off the live index picks Jack (step 4) on Dark Hills',
    state.quest_key === 'jack'
    && state.map_id === 0 && state.map_name === 'Dark Hills'
    && state.map_sub === 'Chapter I · map id 0',
    `quest_key=${state.quest_key} map_sub="${state.map_sub}"`);
  check('found counts resolved names, tracked counts the set',
    state.found === TRACKED_NAMES.length && state.tracked === TRACKED_NAMES.length,
    `${state.found}/${state.tracked}`);

  // Sweeps must not cache: a second buildIndex is a fresh resolve, and the
  // ValueIndex holds no memoised value anywhere.
  const index2 = values.buildIndex(proc, info.base, info.settingsVt, info.unionVt, info.bindingVt);
  check('a second sweep re-resolves rather than reusing the first index',
    index2 !== index && index2.names.size === index.names.size
    && index2.resolve('Hero Level').value === 14);

  proc.close();
  return failures;
}

class MockProc {
  constructor() {
    this.memory = new Map();
  }
  writeI32(addr, val) {
    const buf = Buffer.alloc(4);
    buf.writeInt32LE(val, 0);
    for (let i = 0; i < 4; i++) this.memory.set(addr + i, buf[i]);
  }
  writeU64(addr, val) {
    const buf = Buffer.alloc(8);
    const low = val % 0x100000000;
    const high = Math.floor(val / 0x100000000);
    buf.writeUInt32LE(low >>> 0, 0);
    buf.writeUInt32LE(high >>> 0, 4);
    for (let i = 0; i < 8; i++) this.memory.set(addr + i, buf[i]);
  }
  read(addr, size) {
    const buf = Buffer.alloc(size);
    for (let i = 0; i < size; i++) {
      const b = this.memory.get(addr + i);
      if (b === undefined) return null;
      buf[i] = b;
    }
    return buf;
  }
  readPtr(addr) {
    const buf = this.read(addr, 8);
    if (!buf) return null;
    return buf.readUInt32LE(4) * 0x100000000 + buf.readUInt32LE(0);
  }
  readI32(addr) {
    const buf = this.read(addr, 4);
    if (!buf) return null;
    return buf.readInt32LE(0);
  }
  close() {}
}

function testReadBindingGuards() {
  console.log('\n--- test-chain: readBinding regression tests (Fix 5 & Fix 6) ---');
  const proc = new MockProc();
  const settingsAddr = 0x10000;
  const bindingAddr = 0x50000;
  const UNION_VT = 0x222222;

  // --- Fix 5: tagSlot === 0 (null box pointer) must not be read as inline value
  // Setup binding object where tagSlot is 0 (null pointer at binding+0x50)
  // and inline slot (binding+0x58) holds junk int32 0x7FFF
  proc.writeU64(bindingAddr + values.UNION_OFFSET_BINDING, UNION_VT);
  proc.writeU64(bindingAddr + values.UNION_OFFSET_BINDING + 0x08, 0); // tagSlot = 0 (null box pointer)
  proc.writeI32(bindingAddr + values.UNION_OFFSET_BINDING + 0x10, 0x7FFF); // junk at tagSlotAddr + 0x08

  const nullBox = values.readBinding(proc, 'Hero Level', settingsAddr, bindingAddr, UNION_VT, 0);
  check('null box pointer (tagSlot 0) yields boxed-int with value null, not inline junk',
    nullBox.status === 'ok' && nullBox.variant === 'boxed-int' && nullBox.value === null);

  // Control case: tagSlot === 4 (inline value)
  proc.writeU64(bindingAddr + values.UNION_OFFSET_BINDING + 0x08, 4);
  proc.writeI32(bindingAddr + values.UNION_OFFSET_BINDING + 0x10, 1);
  const inlineVal = values.readBinding(proc, 'Is In Combat', settingsAddr, bindingAddr, UNION_VT, 0);
  check('tagSlot 4 yields inline variant with decoded value',
    inlineVal.status === 'ok' && inlineVal.variant === 'inline' && inlineVal.value === 1);

  // Control case: tagSlot === 0x60000 (valid boxed pointer)
  proc.writeU64(bindingAddr + values.UNION_OFFSET_BINDING + 0x08, 0x60000);
  proc.writeI32(0x60000, 42);
  const boxedVal = values.readBinding(proc, 'Hero Level', settingsAddr, bindingAddr, UNION_VT, 0);
  check('valid box pointer yields boxed-int with read value',
    boxedVal.status === 'ok' && boxedVal.variant === 'boxed-int' && boxedVal.value === 42);

  // --- Fix 6: Union vtable mismatch sets status: 'stale-binding'
  // Case 1: Mismatched union vtable
  proc.writeU64(bindingAddr + values.UNION_OFFSET_BINDING, 0x999999);
  const stale = values.readBinding(proc, 'Hero Level', settingsAddr, bindingAddr, UNION_VT, 0);
  check('mismatched union vtable sets status to stale-binding',
    stale.status === 'stale-binding' && stale.union_vtable_ok === false);

  // ValueIndex.resolve propagation of stale-binding
  const names = new Map([['Hero Level', settingsAddr]]);
  const bindings = new Map([[settingsAddr, bindingAddr]]);
  proc.writeI32(settingsAddr + values.DEFAULT_VAL_OFFSET, 1);
  const idx = new values.ValueIndex(proc, 0x140000000, null, UNION_VT, null, names, bindings);
  const idxResolved = idx.resolve('Hero Level');
  check('ValueIndex.resolve propagates stale-binding status',
    idxResolved.status === 'stale-binding' && idxResolved.union_vtable_ok === false);

  // Case 2: Matching union vtable
  proc.writeU64(bindingAddr + values.UNION_OFFSET_BINDING, UNION_VT);
  const okBinding = values.readBinding(proc, 'Hero Level', settingsAddr, bindingAddr, UNION_VT, 0);
  check('matching union vtable sets status ok and union_vtable_ok true',
    okBinding.status === 'ok' && okBinding.union_vtable_ok === true);

  // Case 3: unionVtableAbs is null/falsy -> union_vtable_ok is null, status is ok
  proc.writeU64(bindingAddr + values.UNION_OFFSET_BINDING, 0x999999);
  const uncheckedBinding = values.readBinding(proc, 'Hero Level', settingsAddr, bindingAddr, null, 0);
  check('falsy unionVtableAbs leaves status ok and union_vtable_ok null',
    uncheckedBinding.status === 'ok' && uncheckedBinding.union_vtable_ok === null);
}

function main() {
  testReadBindingGuards();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'fakegame.js')],
      { stdio: ['ignore', 'pipe', 'inherit'] });
    let acc = '';
    child.stdout.on('data', (d) => {
      acc += d;
      if (!acc.includes('\n')) return;
      const info = JSON.parse(acc.split('\n')[0]);
      let f;
      try { f = run(info); } finally { child.kill(); }
      resolve(f);
    });
  });
}

if (require.main === module) main().then(f => process.exit(f ? 1 : 0));
module.exports = { main };
