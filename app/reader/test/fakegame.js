'use strict';
// A stand-in heap with the record layouts live_memory_reading.md documents:
// 192-byte oCGlobalEntityValueSettings instances, 96-byte binding objects,
// both union variants, a .rdata-style name pool, and decoys that look like
// the master-instance-array neighbours the real bootstrap has to reject.
//
// Ravenswatch.exe is not involved. This exercises the chain logic and the
// index join against bytes whose correct answers are known by construction.
// It says nothing about whether the real game's objects look like this --
// that is what live_memory_reading.md asserts and what stays UNVERIFIED here.

const koffi = require('koffi');

const SETTINGS_VT = 0x00007ff700123456;
const UNION_VT = 0x00007ff700222222;
const BINDING_VT = 0x00007ff700f10f48;   // matches BINDING_VTABLE_RVA's shape
const OTHER_VT = 0x00007ff700999999;

// name -> [variant, value]. Types come from the real tools/value_types.json,
// so the Float reinterpretation path is exercised with a real Float name.
const PLAN = [
  ['Hero Level', 'boxed-int', 14],
  ['Is In Combat', 'inline', 1],
  ['Current map id', 'boxed-int', 0],                      // id 0 is Dark Hills, a real reading
  ['Current dream shards count', 'boxed-int', 180],        // the Sandman panel's balance
  ['Current_House_Type', 'boxed-int', 0],                  // 0 == Jack run, not "unresolved"
  ['Current_House_State', 'boxed-int', 0],
  ['Pig_House_Resources_To_Collect_Count', 'boxed-int', 0],
  ['Jack_Quest_Current_Step', 'boxed-int', 4],
  ['Game Session Size', 'boxed-int', 1],                  // 1 == solo run; 2+ is co-op
  // The Sandman worker's shop gate. Inline and 0 == shut, matching the live
  // reading; tracked so the sweep resolves an address for reader.js to relay.
  ['Is in sandman shop', 'inline', 0],
  // The run-end worker's values: mid-run, so neither end flag is up.
  ['Is in defeat sequence', 'inline', 0],
  ['Is in victory sequence', 'inline', 0],
  ['Game Difficulty', 'boxed-int', 2],
  ['Current chapter', 'boxed-int', 0],                     // 0 is chapter I, a real reading
  ['Mordred_Quest_Current_Step', 'boxed-int', 0],
  ['Tree_Quest_Current_Step', 'boxed-int', 0],
  ['Roc_Quest_Current_Step', 'boxed-int', 0],
  ['Cyclop_Quest_Cave_Current_Step', 'boxed-int', 0],
  ['Giant_Tree_HP_Ratio', 'inline', 0.64],                 // Float: inline slot, tag 4
  ['Tree_Quest_Boss_Is_Dead_Bool', 'inline', 1],
  ['Dark Hills map id', 'boxed-int', 0],
  ['Storm Island map id', 'boxed-int', 1],
  ['Avalon map id', 'boxed-int', 2],
  ['Baba Yaga Map map id', 'boxed-int', 3],
  // Resolvable settings instance with NO binding object -- must come back
  // "binding object not found", not as a value.
  ['Orphan_Value_No_Binding', 'none', null],
];

const SIZE = 8 * 1024 * 1024;
const ptr = koffi.alloc('uint8', SIZE);
const ab = koffi.view(ptr, SIZE);
const dv = new DataView(ab);
const u8 = new Uint8Array(ab);
const BASE = Number(koffi.address(ptr));

function w64(off, v) {
  dv.setUint32(off, v >>> 0, true);
  dv.setUint32(off + 4, Math.floor(v / 4294967296) >>> 0, true);
}
function w32(off, v) { dv.setUint32(off, v >>> 0, true); }
function wf32(off, v) { dv.setFloat32(off, v, true); }

// Fill with pointer-ish noise so the sweep has to actually discriminate.
{
  let s = 0x1234567 >>> 0;
  for (let i = 0; i < SIZE; i += 8) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    w32(i, s); w32(i + 4, (s & 1) ? 0x000001c0 : 0);
  }
}

let cursor = 0x1000;
function alloc(n, align = 16) {
  cursor = (cursor + align - 1) & ~(align - 1);
  const at = cursor;
  cursor += n;
  return at;
}

// ---- name pool (stands in for the module's .rdata string pool) ------------
const nameOff = {};
for (const [name] of PLAN) {
  const at = alloc(name.length + 1, 1);
  for (let i = 0; i < name.length; i++) u8[at + i] = name.charCodeAt(i);
  u8[at + name.length] = 0;
  nameOff[name] = at;
}

// ---- settings instances + binding objects ---------------------------------
const expected = {};
const settingsOffs = [];
for (const [name, variant, value] of PLAN) {
  const s = alloc(192);
  settingsOffs.push(s);
  w64(s + 0x00, SETTINGS_VT);
  w64(s + 0x68, BASE + nameOff[name]);
  // length carries the 0x80000000 static-literal flag, as in the real record
  w32(s + 0x70, (name.length | 0x80000000) >>> 0);
  w32(s + 0x74, 0);
  w64(s + 0x88, UNION_VT);
  w32(s + 0x98, 7777);              // the DEFINITION default, never the live value

  if (variant === 'none') {
    expected[name] = { status: 'binding object not found' };
    continue;
  }

  const b = alloc(96);
  w64(b + 0x18, BASE + s);          // binding -> its settings instance
  w64(b + 0x20, BINDING_VT);        // binding's own vtable
  w64(b + 0x48, UNION_VT);          // embedded oCEntityValueUnion
  if (variant === 'inline') {
    w64(b + 0x50, 4);               // small tag -> inline variant
    if (Number.isInteger(value)) w32(b + 0x58, value);
    else wf32(b + 0x58, value);
  } else {
    const box = alloc(16);
    w32(box, value);
    w64(b + 0x50, BASE + box);      // pointer -> boxed variant
    w64(b + 0x58, 0x0000000800000010); // {size:16, align:8}, not the value
  }
  expected[name] = {
    status: 'ok', variant, value,
    settings_addr: BASE + s, binding_addr: BASE + b,
  };
}

// ---- decoys ---------------------------------------------------------------
// The master instance array: every settings record's +0x18/+0x20 point at its
// neighbours. Those are the hits the bootstrap walk must NOT mistake for
// binding objects (their would-be vtable slot lands in heap space, and they
// are themselves settings records).
for (let i = 0; i < settingsOffs.length; i++) {
  const s = settingsOffs[i];
  w64(s + 0x18, BASE + settingsOffs[(i + settingsOffs.length - 1) % settingsOffs.length]);
  w64(s + 0x20, BASE + settingsOffs[(i + 1) % settingsOffs.length]);
}
// An unrelated object carrying the union vtable but not the binding vtable.
{
  const d = alloc(96);
  w64(d + 0x00, OTHER_VT);
  w64(d + 0x48, UNION_VT);
}

// ---- placement chain -------------------------------------------------------
// oCEntity+0x38 -> EntitySettingsResource, whose {char*, len, flags} triple
// holds the .entity.ot path. PLACED_PATH gets an entity; LOADED_PATH gets a
// resource object and no entity, which is the "loaded but not placed" case
// that resource-path presence alone cannot tell apart.
const ENTITY_VT = 0x00007ff700abcdef;
const PLACED_PATH = 'Avalon\\Objects_Tree_Quest\\Tree_Quest_Main_Manager.entity.ot';
const LOADED_PATH = 'Avalon\\Mordred\\Mordred_Quest_Manager.entity.ot';
const DEEP_PATH = 'DarkHills\\Jack\\Jack_Quest_Manager.entity.ot';

function plantString(s) {
  const at = alloc(s.length + 1, 1);
  for (let i = 0; i < s.length; i++) u8[at + i] = s.charCodeAt(i);
  u8[at + s.length] = 0;
  return at;
}

/** A resource object carrying its path triple at `tripleOff` bytes in. */
function plantResource(pathStr, tripleOff) {
  const strAt = plantString(pathStr);
  const obj = alloc(0x200);
  w64(obj + tripleOff, BASE + strAt);
  w32(obj + tripleOff + 8, pathStr.length);   // no 0x80000000 flag on these
  w32(obj + tripleOff + 12, 0);
  return obj;
}

const placedRes = plantResource(PLACED_PATH, 0x18);
const loadedRes = plantResource(LOADED_PATH, 0x18);
const deepRes = plantResource(DEEP_PATH, 0x138);   // near the window's far edge

const placedEnt = alloc(0x80);
w64(placedEnt + 0x00, ENTITY_VT);
w64(placedEnt + 0x38, BASE + placedRes);

const deepEnt = alloc(0x80);
w64(deepEnt + 0x00, ENTITY_VT);
w64(deepEnt + 0x38, BASE + deepRes);

// A second entity on the same resource: the count is distinct entities, so
// this must read 2 for PLACED_PATH and not 1.
const placedEnt2 = alloc(0x80);
w64(placedEnt2 + 0x00, ENTITY_VT);
w64(placedEnt2 + 0x38, BASE + placedRes);

// Decoy: something that points at the unplaced resource object but is NOT an
// entity -- its vtable slot holds OTHER_VT. Pointer presence is not placement.
const notAnEntity = alloc(0x80);
w64(notAnEntity + 0x00, OTHER_VT);
w64(notAnEntity + 0x38, BASE + loadedRes);

process.stdout.write(JSON.stringify({
  pid: process.pid,
  base: BASE,
  settingsVt: SETTINGS_VT,
  unionVt: UNION_VT,
  bindingVt: BINDING_VT,
  entityVt: ENTITY_VT,
  placement: {
    placedPath: PLACED_PATH,
    loadedPath: LOADED_PATH,
    deepPath: DEEP_PATH,
    placedRes: BASE + placedRes,
    loadedRes: BASE + loadedRes,
    placedEnts: [BASE + placedEnt, BASE + placedEnt2],
    deepEnt: BASE + deepEnt,
  },
  expected,
}) + '\n');

setInterval(() => {}, 1 << 30);
