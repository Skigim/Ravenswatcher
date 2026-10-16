'use strict';
// Is the Sandman refill (Refill_Sandman_Dreams) pre-rolled before the first
// purchase, and if so, where does it sit?
//
//   node app/reader/bench/sandman-refill-probe.js [outfile]
//
// Watches the shop controller whenever it exists. Each snapshot records:
//   - the seven drop buckets at controller +0x138..+0x168 and each one's
//     flag string (bucket +0x10 -> +0x58 -> +0xe8 -> +0x00 -> string),
//     including bucket 3, which sandman_readout.md never recorded;
//   - the six on-screen cells: item pointer, name, price, purchased flag;
//   - every oCDtEntityCpntMagicalObject instance reachable by a two-hop
//     pointer walk from the controller and from each bucket, and whether a
//     cell currently points at it.
//
// A snapshot prints whenever any of that changes. The test, per the register
// entry: note the reachable-but-unbound items before buying; buy one item;
// if the restocked cell now points at an address that was in the
// pre-purchase reachable set, the refill was pre-rolled and readable. If it
// appears only after the sale, it is rolled at purchase. Run once without
// the melody as the control.

const fs = require('fs');
const { openProcess, findPid, moduleBase } = require('../win32');
const sandman = require('../sandman');
const { PROCESS_NAME } = require('../state');

const TICK_MS = 1000;
const HEARTBEAT_MS = 30000;
const MIN_VALID_ADDR = 0x10000;
const MAX_ADDR = 0x7FFFFFFFFFFF;
const DROPS_OFFSET = 0x138;
const DROP_COUNT = 7;
const CONTROLLER_WALK_BYTES = 0x300;
const DROP_WALK_BYTES = 0x298;
const HOP_WALK_BYTES = 0x300;

const out = process.argv[2] || null;
const t0 = Date.now();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const hex = (n) => (n == null ? '-' : '0x' + n.toString(16).toUpperCase());

function say(line) {
  const s = `[${((Date.now() - t0) / 1000).toFixed(1).padStart(7)}s] ${line}`;
  console.log(s);
  if (out) fs.appendFileSync(out, s + '\n');
}

function validPtr(p) {
  return typeof p === 'number' && p >= MIN_VALID_ADDR && p <= MAX_ADDR;
}

function readFlag(proc, drop) {
  const settings = proc.readPtr(drop + 0x10);
  if (!validPtr(settings)) return null;
  const picker = proc.readPtr(settings + 0x58);
  if (!validPtr(picker)) return null;
  // picker +0xe8 -> flag holder; holder +0x00 -> char*. Measured 2026-09-17:
  // bucket 0 reads "Sandman; Minor" this way.
  const holder = proc.readPtr(picker + 0xe8);
  if (!validPtr(holder)) return null;
  const sp = proc.readPtr(holder);
  const s = validPtr(sp) ? sandman.readUtf8String(proc, sp, 64) : null;
  return s && /^[\x20-\x7e]+$/.test(s) ? s : null;
}

/** The generator component's own name: bucket +0x10 -> settings +0xe8 -> char*. */
function readBucketName(proc, drop) {
  const settings = proc.readPtr(drop + 0x10);
  if (!validPtr(settings)) return null;
  const sp = proc.readPtr(settings + 0xe8);
  const s = validPtr(sp) ? sandman.readUtf8String(proc, sp, 64) : null;
  return s && /^[\x20-\x7e]+$/.test(s) ? s : null;
}

function isItem(proc, addr, itemVt) {
  if (!validPtr(addr)) return false;
  return proc.readPtr(addr) === itemVt;
}

/** Two-hop pointer walk: fields of `root`, then fields of each pointer field. */
function reachableItems(proc, root, rootBytes, itemVt, into) {
  const buf = proc.read(root, rootBytes);
  if (!buf) return;
  const hops = [];
  for (let off = 0; off + 8 <= buf.length; off += 8) {
    const lo = buf.readUInt32LE(off), hi = buf.readUInt32LE(off + 4);
    const p = hi * 4294967296 + lo;
    if (!validPtr(p)) continue;
    if (isItem(proc, p, itemVt)) into.set(p, `${hex(root)}+${hex(off)}`);
    else hops.push([p, off]);
  }
  for (const [p, off] of hops) {
    const b2 = proc.read(p, HOP_WALK_BYTES);
    if (!b2) continue;
    for (let o2 = 0; o2 + 8 <= b2.length; o2 += 8) {
      const lo = b2.readUInt32LE(o2), hi = b2.readUInt32LE(o2 + 4);
      const q = hi * 4294967296 + lo;
      if (isItem(proc, q, itemVt) && !into.has(q)) {
        into.set(q, `${hex(root)}+${hex(off)}->+${hex(o2)}`);
      }
    }
  }
}

function snapshot(proc, ctrl, vt) {
  const drops = [];
  for (let i = 0; i < DROP_COUNT; i++) {
    const d = proc.readPtr(ctrl + DROPS_OFFSET + i * 8);
    drops.push({ i, addr: validPtr(d) ? d : null, name: validPtr(d) ? readBucketName(proc, d) : null, flag: validPtr(d) ? readFlag(proc, d) : null });
  }
  const cells = [];
  for (let i = 0; i < sandman.SLOT_COUNT; i++) {
    const slot = ctrl + sandman.CONTROLLER_SLOTS_OFFSET + i * sandman.CONTROLLER_SLOT_STRIDE;
    const viewer = proc.readPtr(slot + sandman.SLOT_VIEWER_OFFSET);
    let item = null, name = null, price = null, purchased = null;
    if (validPtr(viewer)) {
      const cand = proc.readPtr(viewer + sandman.VIEWER_MAGICAL_OBJECT_OFFSET);
      if (isItem(proc, cand, vt.magicalObjectVt)) {
        item = cand;
        name = sandman.readItemName(proc, item);
        price = sandman.readItemPrice(proc, item);
      }
      const flag = proc.readI32(viewer + sandman.VIEWER_PURCHASED_OFFSET);
      purchased = flag !== null && (flag & 0xff00) === 0x100;
    }
    cells.push({ i, item, name, price, purchased });
  }
  const reach = new Map();
  reachableItems(proc, ctrl, CONTROLLER_WALK_BYTES, vt.magicalObjectVt, reach);
  for (const d of drops) if (d.addr) reachableItems(proc, d.addr, DROP_WALK_BYTES, vt.magicalObjectVt, reach);
  const bound = new Set(cells.map(c => c.item).filter(Boolean));
  const reachable = [...reach.entries()].map(([addr, via]) => ({
    addr, via, name: sandman.readItemName(proc, addr), bound: bound.has(addr),
  }));
  return { ctrl, drops, cells, reachable };
}

function key(s) {
  return JSON.stringify({
    c: s.ctrl,
    d: s.drops.map(d => [d.addr, d.flag]),
    k: s.cells.map(c => [c.item, c.purchased]),
    r: s.reachable.map(r => [r.addr, r.bound]).sort(),
  });
}

function print(s) {
  say(`controller ${hex(s.ctrl)}`);
  for (const d of s.drops) say(`  bucket ${d.i}: ${hex(d.addr)}  ${d.name ?? '-'}  flag ${d.flag === null ? '(empty)' : JSON.stringify(d.flag)}`);
  for (const c of s.cells) {
    say(`  cell ${c.i}: ${hex(c.item)}  ${c.name ?? '-'}  price ${c.price ?? '-'}  ${c.purchased ? 'SOLD' : c.purchased === null ? '(no viewer)' : 'unsold'}`);
  }
  const unbound = s.reachable.filter(r => !r.bound);
  say(`  reachable MagicalObject instances: ${s.reachable.length} (${unbound.length} not bound to a cell)`);
  for (const r of unbound) say(`    UNBOUND ${hex(r.addr)}  ${r.name ?? '-'}  via ${r.via}`);
}

async function main() {
  say(`watching for ${PROCESS_NAME}...`);
  let pid;
  for (;;) {
    try { pid = findPid(PROCESS_NAME); break; } catch { await sleep(2000); }
  }
  const base = moduleBase(pid).base;
  const proc = openProcess(pid);
  say(`attached pid ${pid} base ${hex(base)}`);

  const vtCache = {};
  let vt = null;
  let lastKey = null;
  let lastBeat = Date.now();
  let hadCtrl = false;
  let heldCtrl = null;

  for (;;) {
    if (!proc.isAlive()) { say('game process exited'); return; }
    if (!vt) {
      try { vt = sandman.resolveVtables(proc, base, vtCache); } catch (e) { say(`vtables: ${e.message}`); }
      if (vt) say(`vtables: controller ${hex(vt.controllerVt)} item ${hex(vt.magicalObjectVt)}`);
      else { await sleep(TICK_MS * 5); continue; }
    }
    // Hold the controller while its vtable still reads back; rescan the heap
    // only when it is lost. The scan is ~1.3 s, the vtable check is one read.
    let ctrl = null;
    if (heldCtrl && proc.readPtr(heldCtrl) === vt.controllerVt) ctrl = heldCtrl;
    else {
      try { ctrl = sandman.findController(proc, vt.controllerVt); } catch (e) { say(`findController: ${e.message}`); }
    }
    heldCtrl = ctrl;

    if (!ctrl) {
      if (hadCtrl) { say('controller gone (shop closed)'); hadCtrl = false; lastKey = null; }
    } else {
      if (!hadCtrl) { say('controller present (shop open)'); hadCtrl = true; }
      let s = null;
      try { s = snapshot(proc, ctrl, vt); } catch (e) { say(`snapshot: ${e.message}`); }
      if (s) {
        const k = key(s);
        if (k !== lastKey) { print(s); lastKey = k; }
      }
    }
    if (Date.now() - lastBeat > HEARTBEAT_MS) {
      say(`heartbeat: shop ${hadCtrl ? 'open' : 'closed'}`);
      lastBeat = Date.now();
    }
    await sleep(TICK_MS);
  }
}

main();
