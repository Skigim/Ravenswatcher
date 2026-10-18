'use strict';
// What the Sandman cell's purchased flag ACTUALLY holds, before and after a buy.
//
//   node app/reader/bench/sandman-purchase-flag.js
//   node app/reader/bench/sandman-purchase-flag.js --interval 250 --seconds 300
//
// WHY. sandman.ts calls a cell purchased when the int32 at viewer +0x5e0 equals
// exactly 0x100. The 2026-09-03 live measurement was narrower than that: byte
// +0x5e1 == 1. The two disagree whenever the cell carries metadata in its high
// bytes -- 0x3F000000 has been seen on unbought cells -- because a bought
// metadata cell would read 0x3F000100 and fail an equality test while passing
// the byte test. Buying zero-indexed slot 0 produced no SOLD, and slot 0 is one
// of the metadata carriers, so the equality test is the first suspect.
//
// This prints the raw dword for all six cells and evaluates both tests side by
// side, so the answer comes off one screen rather than out of an inference.
// Buy anything while it runs: the line for that slot reprints on change.
//
// CONTROLS. Two, and neither depends on the flag under test:
//
//   1. Dream shards, and only a DROP of one. Shards go UP constantly from
//      pickups -- seven increases inside one 100 ms capture on 2026-09-04, and
//      an earlier version of this bench counted any movement and cried wolf on
//      every one of them. A drop is matched against the six offer prices: a
//      spend equal to an offer's price identifies which slot was bought, so
//      the control says "slot 3 was bought" rather than "something happened".
//      A drop matching no offer is reported and explicitly NOT treated as
//      evidence, because shards are spent outside the shop grid too.
//   2. nav +0x10. The navigation link is claimed to sever to 0 when a cell goes
//      unbuyable. It is read here as an independent witness to the same event.
//
// Without them a silent dword is unreadable: it could mean the purchase did not
// register, that this cell is not the one you bought, or that the field is
// unrelated. The shard drop timestamps the purchase from outside.

const { openProcess, findPid, moduleBase } = require('../win32');
const { PROCESS_NAME } = require('../state');
const sandman = require('../sandman');
const values = require('../values');

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
let intervalMs = 250;
let seconds = 300;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--interval') { intervalMs = Number(argv[++i]); continue; }
  if (a === '--seconds') { seconds = Number(argv[++i]); continue; }
  console.error(`unknown flag ${a}`);
  console.error('usage: sandman-purchase-flag.js [--interval <ms>] [--seconds <n>]');
  process.exit(1);
}

const hex = n => (n === null || n === undefined ? '--' : `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}`);
const ptr = n => (!n ? '--' : `0x${n.toString(16).toUpperCase()}`);
const stamp = () => new Date().toISOString().slice(11, 23);

// ------------------------------------------------------------------ connect

const pid = findPid(PROCESS_NAME);
if (!pid) {
  console.error(`${PROCESS_NAME} is not running.`);
  process.exit(1);
}
const mod = moduleBase(pid);
const proc = openProcess(pid);
console.log(`pid ${pid}  base ${ptr(mod.base)}`);

const vtables = {};
const resolved = sandman.resolveVtables(proc, mod.base, vtables);
if (!resolved) {
  console.error('could not resolve the Sandman RTTI vtables -- is a run loaded?');
  proc.close();
  process.exit(1);
}
console.log(`controllerVt ${ptr(resolved.controllerVt)}  magicalObjectVt ${ptr(resolved.magicalObjectVt)}`);

// The controller only exists once a run has built the Sandman menu, so start
// this before walking up to him and let it wait rather than demanding the shop
// already be open.
let controller = sandman.findController(proc, resolved.controllerVt);

const idx = values.buildIndex(proc, mod.base);
const readValue = name => {
  if (!idx) return null;
  const r = idx.resolve(name);
  return r.status === 'ok' ? r.value : null;
};

// -------------------------------------------------------------- one sample

// A cell is described by everything that could plausibly move when it is
// bought, not just the field under test. Anything that changes gets reprinted,
// so a purchase that lands somewhere unexpected still shows up.
function sampleSlot(i) {
  const slotBase = controller + sandman.CONTROLLER_SLOTS_OFFSET + i * sandman.CONTROLLER_SLOT_STRIDE;
  const nav = proc.readPtr(slotBase + sandman.SLOT_NAV_OFFSET);
  const viewer = proc.readPtr(slotBase + sandman.SLOT_VIEWER_OFFSET);
  const drop = proc.readPtr(slotBase + sandman.SLOT_DROP_OFFSET);

  let item = null;
  let name = null;
  let price = null;
  if (viewer && viewer >= 0x10000) {
    const candidate = proc.readPtr(viewer + sandman.VIEWER_MAGICAL_OBJECT_OFFSET);
    if (candidate && candidate >= 0x10000 && proc.readPtr(candidate) === resolved.magicalObjectVt) {
      item = candidate;
      name = sandman.readItemName(proc, item);
      price = sandman.readItemPrice(proc, item);
    }
  }

  const flag = viewer && viewer >= 0x10000
    ? proc.readI32(viewer + sandman.VIEWER_PURCHASED_OFFSET)
    : null;
  const navNext = nav && nav >= 0x10000
    ? proc.readPtr(nav + sandman.NAV_NEXT_OFFSET)
    : null;

  return { i, nav, viewer, drop, item, name, price, flag, navNext };
}

// The two candidate readings of the same dword. Printed together on every line
// because the whole question is where they part company.
const eqTest = s => (s.flag === 0x100 ? 'SOLD' : '.');
const byteTest = s => (s.flag !== null && ((s.flag >>> 8) & 0xff) === 1 ? 'SOLD' : '.');

const line = s =>
  `  ${s.i}  ${hex(s.flag)}  ${eqTest(s).padEnd(4)} ${byteTest(s).padEnd(4)}  `
  + `nav+10 ${(s.navNext ? ptr(s.navNext) : '0').padEnd(16)} `
  + `${String(s.price ?? '--').padStart(4)}  ${s.name ?? '<unbound>'}`;

// Only the fields that a purchase might move take part in change detection.
// Pointer churn from the UI rebinding a cell is a change worth seeing too, so
// viewer and item are in; timestamps and prices alone are not enough to fire.
const key = s => `${s.flag}|${s.navNext}|${s.viewer}|${s.item}|${s.name}`;

function header() {
  console.log('  #  flag@+0x5e0  ==0x100  byte  nav+0x10          price  name');
}

// --------------------------------------------------------------- watch loop

let prev = null;
let prevShards = null;
let waiting = false;
const deadline = Date.now() + seconds * 1000;

function tick() {
  if (Date.now() > deadline) {
    console.log(`\n${stamp()}  done (${seconds}s elapsed)`);
    proc.close();
    process.exit(0);
  }

  if (!controller) {
    controller = sandman.findController(proc, resolved.controllerVt);
    if (!controller) {
      if (!waiting) {
        console.log(`${stamp()}  waiting for the Sandman menu controller to exist...`);
        waiting = true;
      }
      // findController scans the heap; do not do that four times a second.
      setTimeout(tick, Math.max(intervalMs, 1000));
      return;
    }
    console.log(`${stamp()}  controller ${ptr(controller)}`);
    waiting = false;
  }

  const slots = [];
  for (let i = 0; i < sandman.SLOT_COUNT; i++) slots.push(sampleSlot(i));

  // A controller address that stops resolving to anything bound is a stale
  // pointer, not a shop that emptied -- re-find it rather than reporting silence.
  if (slots.every(s => !s.viewer)) {
    const again = sandman.findController(proc, resolved.controllerVt);
    if (again && again !== controller) {
      controller = again;
      console.log(`${stamp()}  controller moved -> ${ptr(controller)}`);
      prev = null;
    }
    setTimeout(tick, intervalMs);
    return;
  }

  const shards = readValue('Current dream shards count');
  const inShop = readValue('Is in sandman shop');

  const changed = slots.filter(s => !prev || key(s) !== prev[s.i]);
  const shardsMoved = shards !== null && prevShards !== null && shards !== prevShards;

  // Only a drop can be a purchase. An increase is a pickup and must never reach
  // the alarm below.
  const spent = (shardsMoved && shards < prevShards) ? prevShards - shards : null;

  // A spend equal to an offer's price says WHICH slot was bought. Two slots can
  // share a price, so every match is named rather than picking one.
  const priced = spent === null ? [] : slots.filter(s => s.price === spent);

  if (!prev) {
    console.log(`${stamp()}  first read   shop=${inShop ?? '?'}  shards=${shards ?? '?'}`);
    header();
    for (const s of slots) console.log(line(s));
    console.log();
  } else if (changed.length || shardsMoved) {
    let what;
    if (!shardsMoved) what = `shards ${shards ?? '?'}`;
    else if (spent !== null) what = `shards ${prevShards} -> ${shards} (spent ${spent})`;
    else what = `shards ${prevShards} -> ${shards} (gained ${shards - prevShards})`;

    const match = priced.length
      ? `  -- ${spent} matches ${priced.map(s => `slot ${s.i} ${s.name ?? '<unbound>'}`).join(', ')}`
      : '';
    console.log(`${stamp()}  ${what}   shop=${inShop ?? '?'}   ${changed.length} slot(s) changed${match}`);

    if (changed.length) {
      header();
      for (const s of changed) console.log(line(s));
    } else if (priced.length) {
      // The control fired, unambiguously, and the field under test did not.
      // That is the single most informative outcome this bench can produce.
      console.log(`  !! ${spent} shards spent, matching an offer's price, and NO cell field`);
      console.log('     changed -- purchased state is not at viewer +0x5e0, and neither');
      console.log('     candidate test can work.');
    } else if (spent !== null) {
      // A spend that matches no offer is not evidence about this field. Shards
      // are spent outside the shop grid, so silence here is expected.
      console.log(`  .. ${spent} shards spent but no offer costs that, and no cell changed --`);
      console.log('     probably not a shop purchase. Not evidence either way.');
    }
    console.log();
  }

  prev = Object.fromEntries(slots.map(s => [s.i, key(s)]));
  prevShards = shards;
  setTimeout(tick, intervalMs);
}

console.log(`watching ${sandman.SLOT_COUNT} cells every ${intervalMs} ms for ${seconds}s -- buy something.`);
console.log('Ctrl-C to stop early.\n');
tick();

process.on('SIGINT', () => {
  console.log('\nstopped');
  proc.close();
  process.exit(0);
});
