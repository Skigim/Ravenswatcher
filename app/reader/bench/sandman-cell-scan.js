#!/usr/bin/env node
'use strict';

/**
 * app/reader/bench/sandman-cell-scan.js
 *
 * Goes after the shop GRID rather than the item catalog.
 *
 * SUPERSEDED FOR READING THE OFFERS. The six offers are read off
 * oCDtEntityCpntSandmanMenuUiController + 0x178, a fixed 6-slot array holding
 * each cell viewer directly -- see the header of app/reader/sandman.ts.
 * This class-wide sweep is kept for inspecting viewers outside the shop grid.
 *
 * The Sandman blueprint (EntitySettings/Allies/NPC_Sandman!NPC_Sandman...gen)
 * names six UI cells, MO_slot_1..MO_slot_6, inside an MO_Frame navigation
 * zone. Each cell spawns GameUis\Items\Magical_Object_Miniature_Price, which
 * wraps Magical_Object_Miniature, and that prefab carries its OWN
 * MagicalObjectUiViewerEntityCpnt -- distinct from the two viewers on
 * oCDtEntityCpntSandmanMenuUiController, which are the hover detail panel.
 *
 * Decisive first question: how many live instances of the cell viewer are
 * there with the shop open? Six-ish means the grid. Catalog-sized means this
 * is another pool and the lead is dead.
 *
 * If the count is small the probe dumps each instance's pointer field table
 * and resolves any pointer that lands on a live oCDtEntityCpntMagicalObject,
 * which is what would tie a cell to the item it is drawing.
 *
 * Usage:
 *   node app/reader/bench/sandman-cell-scan.js
 *   node app/reader/bench/sandman-cell-scan.js --class SkillUiViewerEntityCpnt
 *   node app/reader/bench/sandman-cell-scan.js --dump-max 40
 */

const { openProcess, findPid, moduleBase } = require('../win32');
const { scanPointers } = require('../scan');
const { PROCESS_NAME } = require('../state');
const values = require('../values');
const rtti = require('../rtti');

const argv = process.argv.slice(2);
function argOf(flag, dflt) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}
const className = argOf('--class', 'MagicalObjectUiViewerEntityCpnt');
const dumpMax = Number(argOf('--dump-max', '32'));
const span = Number(argOf('--span', '0x300'));

const hex = n => (n === null || n === undefined) ? 'null' : `0x${n.toString(16).toUpperCase()}`;

const pid = findPid(PROCESS_NAME);
if (!pid) {
  console.error(`[ERROR] ${PROCESS_NAME} is not running.`);
  process.exit(1);
}
const mod = moduleBase(pid);
const proc = openProcess(pid);
console.log(`Attached to ${PROCESS_NAME} (PID ${pid}, base ${hex(mod.base)})`);

// ---------------------------------------------------------------- shop gate

const idx = values.buildIndex(proc, mod.base);
let shopOpen = null;
if (idx) {
  for (const n of ['Is in sandman shop', 'Reroll count', 'Current dream shards count']) {
    const r = idx.resolve(n);
    console.log(`  ${n.padEnd(30)} ${r.status === 'ok' ? r.value : `<${r.status}>`}`);
  }
  const s = idx.resolve('Is in sandman shop');
  if (s.status === 'ok') shopOpen = Boolean(s.value);
}
console.log(`\n[INFO] shop open: ${shopOpen}\n`);

// ------------------------------------------------------------ resolve class

const mangled = `.?AV${className}@dt@oe@@\0`;
const rvas = rtti.resolveAllVtableRvas(proc, mod.base, mangled);
if (!rvas.length) {
  console.error(`[ERROR] No vtable resolved for ${className} (${JSON.stringify(mangled)}).`);
  console.error('        Run rtti-names.js to confirm the exact descriptor name.');
  proc.close();
  process.exit(1);
}
console.log(`${className}: ${rvas.length} vtable(s) -> ${rvas.map(r => hex(mod.base + r)).join(', ')}`);

// ------------------------------------------------------- instance discovery

const targets = rvas.map(r => mod.base + r);
const t0 = process.hrtime.bigint();
const hits = scanPointers(proc, targets);
const scanMs = Number(process.hrtime.bigint() - t0) / 1e6;

let all = [];
for (const t of targets) {
  const list = hits.get(t) || [];
  console.log(`  vtable ${hex(t)}: ${list.length} instances`);
  all = all.concat(list);
}
all.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
console.log(`\nTotal ${className} instances: ${all.length}  (scan ${scanMs.toFixed(0)} ms)`);

// Control: the catalog class, so a suspicious count has something to sit next to.
const catRvas = rtti.resolveVtableRvas(proc, mod.base,
  { oCDtEntityCpntMagicalObject: '.?AVoCDtEntityCpntMagicalObject@@\0' });
if (catRvas.oCDtEntityCpntMagicalObject) {
  const catVt = mod.base + catRvas.oCDtEntityCpntMagicalObject;
  const catHits = scanPointers(proc, [catVt]).get(catVt) || [];
  console.log(`Control -- oCDtEntityCpntMagicalObject instances: ${catHits.length}`);
  console.log(`\nVERDICT: ${all.length} cell viewers vs ${catHits.length} catalog items.`);
  if (all.length >= 4 && all.length <= 16) {
    console.log('  => Grid-sized. This is the shop grid, not another pool.');
  } else if (all.length > 60) {
    console.log('  => Catalog-sized. Another pool; the lead is dead as stated.');
  } else {
    console.log('  => Neither clearly. Interpret against what is on screen.');
  }

  // Build an address -> name map of catalog instances so cell pointers resolve.
  const catByAddr = new Map();
  const readStr = (addr, max = 128) => {
    if (!addr || addr < 0x10000 || addr > 0x7fffffffffff) return null;
    const b = proc.read(addr, max);
    if (!b) return null;
    const z = b.indexOf(0);
    const s = (z >= 0 ? b.subarray(0, z) : b).toString('latin1');
    return /^[\x20-\x7e]*$/.test(s) && s.length ? s : null;
  };
  const readListenerStr = (inst, off) => {
    const l = proc.readPtr(inst + off);
    if (!l || l < 0x10000) return null;
    return readStr(proc.readPtr(l + 8));
  };
  for (const c of catHits) {
    const name = readListenerStr(c, 0x168) || readListenerStr(c, 0x148);
    if (name) catByAddr.set(String(c), name);
  }
  console.log(`Catalog name map: ${catByAddr.size} of ${catHits.length} instances named.\n`);

  // --------------------------------------------------------- offer readout
  // The cell viewer's +0x0f0 is a direct pointer to the catalog instance the
  // cell is drawing. Distinct targets across all cells == the current stock.
  const ITEM_PTR = 0x0f0;
  const byItem = new Map();
  let bound = 0;
  for (const inst of all) {
    const item = proc.readPtr(inst + ITEM_PTR);
    if (!item || !catByAddr.has(String(item))) continue;
    bound++;
    if (!byItem.has(String(item))) {
      byItem.set(String(item), { addr: item, name: catByAddr.get(String(item)), cells: [] });
    }
    byItem.get(String(item)).cells.push(inst);
  }

  console.log(`=== OFFER READOUT (cell viewer +${hex(ITEM_PTR)} -> catalog instance) ===`);
  console.log(`${bound} of ${all.length} cells bound to an item; ${byItem.size} distinct items.\n`);
  const priceOf = inst => {
    const l = proc.readPtr(inst + 0x1e8);
    return (l && l > 0x10000) ? proc.readI32(l + 8) : null;
  };
  for (const e of byItem.values()) {
    console.log(`  ${e.name.padEnd(28)} ${String(priceOf(e.addr) ?? '?').padStart(4)} shards   ` +
      `item ${hex(e.addr)}  cells x${e.cells.length} [${e.cells.map(hex).join(', ')}]`);
  }
  console.log();

  // ------------------------------------------------- which prefab each cell is
  // The viewer's owning oCEntity sits at +0x008, and oCEntity+0x38 is the
  // entity-resource reference -- i.e. which prefab the cell was spawned from.
  // Cells from the Sandman grid prefab should share one resource; strays from
  // other UI (inventory, level-up, hover panel) should sit under others.
  console.log('=== CELL PROVENANCE (owning entity resource at oCEntity+0x38) ===');
  const byRes = new Map();
  for (const inst of all) {
    const ent = proc.readPtr(inst + 0x008);
    const res = ent ? proc.readPtr(ent + 0x38) : null;
    const item = proc.readPtr(inst + ITEM_PTR);
    const key = String(res);
    if (!byRes.has(key)) byRes.set(key, { res, rows: [] });
    byRes.get(key).rows.push({
      inst, ent,
      item: (item && catByAddr.has(String(item))) ? catByAddr.get(String(item)) : null,
    });
  }
  for (const g of byRes.values()) {
    const named = g.rows.filter(r => r.item);
    console.log(`  resource ${hex(g.res)}  ${g.rows.length} cell(s), ${named.length} bound`);
    for (const r of g.rows) {
      console.log(`      cell ${hex(r.inst)}  entity ${hex(r.ent)}  ${r.item || '(unbound)'}`);
    }
  }
  console.log();

  // ------------------------------------------------ diff within the grid group
  // The largest bound group is the shop grid. If one offset reads a distinct
  // small integer per cell it is the slot index, which would order the grid
  // and identify a duplicated item as two real slots rather than one stray.
  let grid = null;
  for (const g of byRes.values()) {
    const named = g.rows.filter(r => r.item).length;
    if (!grid || named > grid.rows.filter(r => r.item).length) grid = g;
  }
  if (grid && grid.rows.length > 1) {
    console.log(`=== INT32 DIFF ACROSS THE ${grid.rows.length} GRID CELLS (resource ${hex(grid.res)}) ===`);
    console.log('Offsets where the cells disagree and every value is a small int.\n');
    const bufs = grid.rows.map(r => proc.read(r.inst, span));
    console.log('  offset  ' + grid.rows.map(r => (r.item || '(unbound)').slice(0, 13).padStart(14)).join(''));
    for (let off = 0; off + 4 <= span; off += 4) {
      const vals = bufs.map(b => (b ? b.readInt32LE(off) : null));
      if (vals.some(v => v === null)) continue;
      if (vals.every(v => v === vals[0])) continue;          // constant: not it
      if (vals.some(v => v < -8 || v > 64)) continue;        // pointer half / float
      console.log(`  +${off.toString(16).padStart(3, '0')}   ` +
        vals.map(v => String(v).padStart(14)).join(''));
    }
    console.log();
  }

  // ------------------------------------------------------------ field dump
  if (argv.includes('--dump') && all.length && all.length <= dumpMax) {
    console.log(`=== POINTER FIELD DUMP (first ${hex(span)} bytes of each instance) ===`);
    console.log('Any field pointing at a named catalog instance is the cell->item link.\n');
    for (let i = 0; i < all.length; i++) {
      const inst = all[i];
      console.log(`--- instance #${i}  ${hex(inst)} ---`);
      const buf = proc.read(inst, span);
      if (!buf) { console.log('  <unreadable>'); continue; }
      for (let off = 0; off + 8 <= buf.length; off += 8) {
        const p = Number(buf.readBigUInt64LE(off));
        if (!p || p < 0x10000 || p > 0x7fffffffffff) continue;
        const direct = catByAddr.get(String(p));
        // A listener holds its payload at +0x08, same shape as the catalog.
        const viaListener = (() => {
          const inner = proc.readPtr(p + 8);
          if (!inner) return null;
          const nm = catByAddr.get(String(inner));
          if (nm) return `listener -> catalog ${nm}`;
          const s = readStr(inner, 64);
          return s ? `listener -> "${s}"` : null;
        })();
        const asStr = readStr(p, 64);
        const notes = [];
        if (direct) notes.push(`*** CATALOG ${direct} ***`);
        if (viaListener) notes.push(viaListener);
        if (asStr) notes.push(`"${asStr}"`);
        const cls = rtti.classOfVtable(proc, mod.base, 0x8000000, proc.readPtr(p));
        if (cls) notes.push(`obj of ${cls}`);
        if (notes.length) console.log(`  +${off.toString(16).padStart(3, '0')}  ${hex(p)}  ${notes.join('  |  ')}`);
      }
      console.log();
    }
  } else if (all.length > dumpMax) {
    console.log(`(${all.length} instances exceeds --dump-max ${dumpMax}; skipping field dump.)`);
  }
}

proc.close();
