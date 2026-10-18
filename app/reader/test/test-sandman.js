'use strict';
// Test suite for the Sandman offers channel:
// - RTTI vtable gating and caching
// - Name listener dereferencing (+0x168) and fallback (+0x148)
// - Price listener direct int32 reading (+0x1e8) and zero invariant
// - Candidate item validation via vtable check (bench script improvement)
// - Grouping viewers by owning entity resource reference (oCEntity+0x38)
// - Filtering dead pooled cells (+0x2b8=1, +0x2f8=1 vs 3 and 6)
// - Deterministic sorting by viewer address
// - Reader prototype accessors and sweep message consumption
// - Offer retention across shop open/close, and the run-end clear

const sandman = require('../sandman');
const { Reader } = require('../reader');
const {
  nextSandmanStatus, SANDMAN_FAIL_MS, offersChanged,
} = sandman;

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

// ---- In-memory mock process for offline testing ----------------------------
class MockMemoryProc {
  constructor() {
    this.memory = new Map();
    this.closed = false;
  }

  writeU32(addr, val) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(val >>> 0, 0);
    for (let i = 0; i < 4; i++) this.memory.set(addr + i, buf[i]);
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

  writeBytes(addr, buf) {
    for (let i = 0; i < buf.length; i++) this.memory.set(addr + i, buf[i]);
  }

  writeLatin1String(addr, str) {
    const buf = Buffer.from(str + '\0', 'latin1');
    this.writeBytes(addr, buf);
  }

  readI32(addr) {
    if (this.unreadable && this.unreadable.has(addr)) return null;
    const buf = Buffer.alloc(4);
    for (let i = 0; i < 4; i++) buf[i] = this.memory.get(addr + i) || 0;
    return buf.readInt32LE(0);
  }

  readU32(addr) {
    if (this.unreadable && this.unreadable.has(addr)) return null;
    const buf = Buffer.alloc(4);
    for (let i = 0; i < 4; i++) buf[i] = this.memory.get(addr + i) || 0;
    return buf.readUInt32LE(0);
  }

  readU64(addr) {
    const low = this.readU32(addr);
    const high = this.readU32(addr + 4);
    if (low === null || high === null) return null;
    return high * 0x100000000 + low;
  }

  readPtr(addr) {
    return this.readU64(addr);
  }

  read(addr, len) {
    if (this.unreadable && this.unreadable.has(addr)) return null;
    const buf = Buffer.alloc(len);
    for (let i = 0; i < len; i++) buf[i] = this.memory.get(addr + i) || 0;
    return buf;
  }

  *regions() {
    yield [0x10000, 0x100000];
  }

  readInto(addr, dstPtr, size) {
    let count = 0;
    for (let i = 0; i < size; i++) {
      const b = this.memory.get(addr + i);
      if (b === undefined) break;
      if (dstPtr && dstPtr.length !== undefined) dstPtr[i] = b;
      count++;
    }
    return count;
  }

  close() {
    this.closed = true;
  }
}

function testVtableResolution() {
  console.log('\n--- test-sandman: vtable resolution and caching ---');

  const proc = new MockMemoryProc();
  const base = 0x7ff600000000;

  // Case 1: Unresolved when vtables are empty and mock has no PE headers
  const empty = sandman.resolveVtables(proc, base, {});
  check('resolveVtables returns null when vtables cannot be resolved from PE', empty === null);

  // Case 2: Pre-populated / cached vtables pass through without RTTI scan
  const cached = { controllerVt: 0x7ff61000, magicalObjectVt: 0x7ff62000 };
  const res = sandman.resolveVtables(proc, base, cached);
  check('resolveVtables passes through already-cached vtables',
    res !== null && res.controllerVt === 0x7ff61000 && res.magicalObjectVt === 0x7ff62000);

  // Case 3: Mutates caller-owned object
  const toMutate = { controllerVt: 0x7ff63000, magicalObjectVt: 0x7ff64000 };
  sandman.resolveVtables(proc, base, toMutate);
  check('caller-owned vtables object is preserved and mutated',
    toMutate.controllerVt === 0x7ff63000 && toMutate.magicalObjectVt === 0x7ff64000);
}

function testNameAndPriceReading() {
  console.log('\n--- test-sandman: item name and price reader ---');

  const proc = new MockMemoryProc();
  const ITEM_ADDR = 0x100000;

  // Case 1: Primary name listener (+0x168)
  const lNamePrimary = 0x101000;
  const strPrimary = 0x101500;
  proc.writeU64(ITEM_ADDR + sandman.MAGICAL_OBJECT_NAME_OFFSET, lNamePrimary);
  proc.writeU64(lNamePrimary + sandman.LISTENER_PAYLOAD_OFFSET, strPrimary);
  proc.writeLatin1String(strPrimary, 'Dream of Power');

  check('readItemName reads name from primary listener +0x168',
    sandman.readItemName(proc, ITEM_ADDR) === 'Dream of Power');

  // Case 2: Fallback name listener (+0x148) when +0x168 is null
  const ITEM_FALLBACK = 0x110000;
  const lNameFallback = 0x111000;
  const strFallback = 0x111500;
  proc.writeU64(ITEM_FALLBACK + sandman.MAGICAL_OBJECT_NAME_FALLBACK_OFFSET, lNameFallback);
  proc.writeU64(lNameFallback + sandman.LISTENER_PAYLOAD_OFFSET, strFallback);
  proc.writeLatin1String(strFallback, 'Raven Claw');

  check('readItemName falls back to listener +0x148 when +0x168 is missing',
    sandman.readItemName(proc, ITEM_FALLBACK) === 'Raven Claw');

  // Case 3: Both name listeners missing
  const ITEM_EMPTY = 0x120000;
  check('readItemName returns null when neither listener is present',
    sandman.readItemName(proc, ITEM_EMPTY) === null);

  // Case 3b: the game stores names as UTF-8. Bloody Mary's Mirror carries a
  // curly apostrophe (U+2019, three bytes); read as latin1 it rendered as
  // "Maryâ€™s" on screen and matched no table key.
  const ITEM_UTF8 = 0x125000;
  const lNameUtf8 = 0x126000;
  const strUtf8 = 0x126500;
  proc.writeU64(ITEM_UTF8 + sandman.MAGICAL_OBJECT_NAME_OFFSET, lNameUtf8);
  proc.writeU64(lNameUtf8 + sandman.LISTENER_PAYLOAD_OFFSET, strUtf8);
  proc.writeBytes(strUtf8, Buffer.from('Bloody Mary’s Mirror\0', 'utf8'));

  check('readItemName decodes UTF-8 (Bloody Mary’s Mirror)',
    sandman.readItemName(proc, ITEM_UTF8) === 'Bloody Mary’s Mirror',
    JSON.stringify(sandman.readItemName(proc, ITEM_UTF8)));

  // Case 4: Price listener (+0x1e8) with positive price
  const lPrice1 = 0x102000;
  proc.writeU64(ITEM_ADDR + sandman.MAGICAL_OBJECT_PRICE_OFFSET, lPrice1);
  proc.writeI32(lPrice1 + sandman.LISTENER_PAYLOAD_OFFSET, 150);

  check('readItemPrice reads positive int32 price from listener +0x1e8',
    sandman.readItemPrice(proc, ITEM_ADDR) === 150);

  // Case 5: Price of 0 is a real reading, NOT null (central invariant)
  const ITEM_FREE = 0x130000;
  const lPriceFree = 0x131000;
  proc.writeU64(ITEM_FREE + sandman.MAGICAL_OBJECT_PRICE_OFFSET, lPriceFree);
  proc.writeI32(lPriceFree + sandman.LISTENER_PAYLOAD_OFFSET, 0);

  const zeroPrice = sandman.readItemPrice(proc, ITEM_FREE);
  check('price of 0 returns 0, preserving the central invariant (zero is zero)',
    zeroPrice === 0 && zeroPrice !== null);

  // Case 6: Price listener missing -> returns null (null is unresolved)
  check('missing price listener returns null (unresolved)',
    sandman.readItemPrice(proc, ITEM_EMPTY) === null);
}

function testControllerSlotReadoutAndPurchasedState() {
  console.log('\n--- test-sandman: controller slot readout and purchased state ---');

  const proc = new MockMemoryProc();
  const CONTROLLER_VT = 0x7ff611110000;
  const MAGICAL_OBJ_VT = 0x7ff622220000;
  const OTHER_VT = 0x7ff699990000;

  const CTRL_ADDR = 0x200000;
  proc.writeU64(CTRL_ADDR, CONTROLLER_VT);

  const makeItem = (addr, vt, name, price) => {
    proc.writeU64(addr, vt);
    if (name) {
      const lName = addr + 0x500;
      const sName = addr + 0x600;
      proc.writeU64(addr + sandman.MAGICAL_OBJECT_NAME_OFFSET, lName);
      proc.writeU64(lName + sandman.LISTENER_PAYLOAD_OFFSET, sName);
      proc.writeLatin1String(sName, name);
    }
    if (price !== undefined) {
      const lPrice = addr + 0x700;
      proc.writeU64(addr + sandman.MAGICAL_OBJECT_PRICE_OFFSET, lPrice);
      proc.writeI32(lPrice + sandman.LISTENER_PAYLOAD_OFFSET, price);
    }
    return addr;
  };

  const makeViewer = (addr, itemAddr, purchasedFlag = 0) => {
    proc.writeU64(addr + sandman.VIEWER_MAGICAL_OBJECT_OFFSET, itemAddr || 0);
    proc.writeI32(addr + sandman.VIEWER_PURCHASED_OFFSET, purchasedFlag);
    return addr;
  };

  const items = [
    makeItem(0x400000, MAGICAL_OBJ_VT, 'Star Fragment', 50),
    makeItem(0x401000, MAGICAL_OBJ_VT, 'Gingerbread Man', 50),
    makeItem(0x402000, MAGICAL_OBJ_VT, 'Dreamcatcher', 100),
    makeItem(0x403000, MAGICAL_OBJ_VT, 'Sand of Knowledge', 200),
    makeItem(0x404000, MAGICAL_OBJ_VT, 'Joker Card', 250),
    makeItem(0x405000, MAGICAL_OBJ_VT, 'Sand of Enlightenment', 250),
  ];

  // Buying sets BYTE +0x5e1; the cell's other bytes are unrelated metadata and
  // are not zero on every cell. Slots 0 and 3 are sold -- 3 with metadata in its
  // high byte, which is the case that shipped broken: `flag === 0x100` called it
  // unsold, so an item went SOLD on screen or not depending purely on which cell
  // the game bound it to. 0x1B000100 is the live Dragon Hide reading.
  const viewers = [
    makeViewer(0x500000, items[0], 0x00000100), // sold, clean high bytes
    makeViewer(0x501000, items[1], 0x3f000000), // unbought with metadata in high bytes
    makeViewer(0x502000, items[2], 0),
    makeViewer(0x503000, items[3], 0x1b000100), // sold AND carrying metadata
    makeViewer(0x504000, items[4], 0x5f000000), // unbought with metadata in high bytes
    makeViewer(0x505000, items[5], 0),
  ];

  for (let i = 0; i < 6; i++) {
    const slotBase = CTRL_ADDR + sandman.CONTROLLER_SLOTS_OFFSET + i * sandman.CONTROLLER_SLOT_STRIDE;
    proc.writeU64(slotBase + sandman.SLOT_NAV_OFFSET, 0x600000 + i * 0x100);
    proc.writeU64(slotBase + sandman.SLOT_VIEWER_OFFSET, viewers[i]);
  }

  const vtables = { controllerVt: CONTROLLER_VT, magicalObjectVt: MAGICAL_OBJ_VT };

  // Test readOffers with mock controller
  const offers = sandman.readOffers(proc, vtables, CTRL_ADDR);
  check('readOffers returns exactly 6 offers from controller slots',
    offers !== null && offers.length === 6);

  check('slot 0 is Star Fragment and reports purchased: true',
    offers[0].name === 'Star Fragment' && offers[0].price === 50 && offers[0].purchased === true);

  check('a sold cell carrying high-byte metadata still reports purchased',
    offers[3].name === 'Sand of Knowledge' && offers[3].purchased === true,
    `flag 0x1B000100 -> purchased=${offers[3].purchased}`);

  check('unbought cells report false whatever their high bytes hold',
    offers[1].name === 'Gingerbread Man' && offers[1].purchased === false &&
    offers[2].name === 'Dreamcatcher' && offers[2].purchased === false &&
    offers[4].name === 'Joker Card' && offers[4].purchased === false &&
    offers[5].name === 'Sand of Enlightenment' && offers[5].purchased === false);

  check('slots preserve physical 0 to 5 grid ordering',
    offers.map(o => o.name).join(',') === 'Star Fragment,Gingerbread Man,Dreamcatcher,Sand of Knowledge,Joker Card,Sand of Enlightenment');

  // Test decoy: item with wrong vtable is not bound
  const decoyViewer = makeViewer(0x506000, makeItem(0x406000, OTHER_VT, 'Decoy Object', 10), 0);
  proc.writeU64(CTRL_ADDR + sandman.CONTROLLER_SLOTS_OFFSET + 5 * sandman.CONTROLLER_SLOT_STRIDE + sandman.SLOT_VIEWER_OFFSET, decoyViewer);
  const offersWithDecoy = sandman.readOffers(proc, vtables, CTRL_ADDR);
  check('item with wrong vtable yields null name and price',
    offersWithDecoy[5].name === null && offersWithDecoy[5].price === null);

  // Test all slots unbound -> returns null
  const emptyCtrl = 0x250000;
  proc.writeU64(emptyCtrl, CONTROLLER_VT);
  for (let i = 0; i < 6; i++) {
    const slotBase = emptyCtrl + sandman.CONTROLLER_SLOTS_OFFSET + i * sandman.CONTROLLER_SLOT_STRIDE;
    proc.writeU64(slotBase + sandman.SLOT_VIEWER_OFFSET, makeViewer(0x550000 + i * 0x100, 0, 0));
  }
  const emptyOffers = sandman.readOffers(proc, vtables, emptyCtrl);
  check('readOffers returns null when all slots are unbound', emptyOffers === null);
}

function testReaderIntegration() {
  console.log('\n--- test-sandman: Reader accessors and message contracts ---');

  // Verify accessors exist on prototype
  check('Reader.prototype.sandman is a function',
    typeof Reader.prototype.sandman === 'function');
  check('Reader.prototype.sandman_status is a function',
    typeof Reader.prototype.sandman_status === 'function');
  check('Reader.prototype.clearRun is a function',
    typeof Reader.prototype.clearRun === 'function');

  // Verify clearRun behavior on dummy Reader
  // clearRun tells both workers to drop their run state; a stand-in for each
  // takes the message.
  const dummyReader = Object.create(Reader.prototype);
  dummyReader.sandmanWorker = { postMessage() {} };
  dummyReader.tilesWorker = { postMessage() {} };
  dummyReader.runsWorker = { postMessage() {} };
  dummyReader.placed = { mapId: 0, placed: ['A'] };
  dummyReader.melodiesData = ['Melody 1'];
  dummyReader.melodyStatus = 'ok';
  dummyReader.sandmanData = [{ name: 'Item', price: 50, purchased: false }];
  dummyReader.sandmanStatus = 'ok';
  dummyReader.clearRun();
  check('clearRun resets placed, melodies, melodyStatus, sandmanData, sandmanStatus',
    dummyReader.placed === null && dummyReader.melodiesData === null &&
    dummyReader.melodyStatus === 'pending' && dummyReader.sandmanData === null &&
    dummyReader.sandmanStatus === 'pending');

  dummyReader.resolved = { 'Hero Level': { binding_addr: 1, variant: 0, is_float: false } };
  let mockLevel = 3;
  dummyReader.pollValue = () => mockLevel;
  dummyReader._lastHeroLevel = null;
  dummyReader.updateTransitions(dummyReader.get('Hero Level'), 0);
  check('transition update records initial Hero Level', dummyReader._lastHeroLevel === 3);
  dummyReader.sandmanData = [{ name: 'Item', price: 50, purchased: false }];
  mockLevel = 1;
  dummyReader.get('Hero Level');
  check('Hero Level lookup leaves shop data intact', dummyReader.sandmanData !== null);
  dummyReader.updateTransitions(mockLevel, 0);
  check('level drop during transition update clears sandmanData',
    dummyReader.sandmanData === null && dummyReader._lastHeroLevel === 1);

  // Message contract tests on Reader instance
  const reader = Object.create(Reader.prototype);
  // The run-end relay rides on every sweep message; a stand-in takes it.
  reader.runsWorker = { postMessage() {} };
  reader.sandmanData = null;
  reader.sandmanStatus = 'pending';
  reader.resolved = {};
  reader._lastRelayedGateAddr = null;
  let changeFiredWith = null;
  reader.onSandmanChange = (offers, status) => {
    changeFiredWith = { offers, status };
  };

  const mockOffers = [
    { name: 'Dream of Wisdom', price: 50, purchased: false },
    { name: 'Dream of Power', price: 75, purchased: true },
  ];

  // 1. Sandman message updates sandmanData and sandmanStatus
  reader._handleSandmanMessage({ type: 'sandman', offers: mockOffers, status: 'ok' });
  check('sandman message updates reader.sandman()',
    reader.sandman() === mockOffers);
  check('sandman message updates reader.sandman_status()',
    reader.sandman_status() === 'ok');
  check('sandman message invokes onSandmanChange callback',
    changeFiredWith !== null && changeFiredWith.offers === mockOffers && changeFiredWith.status === 'ok');

  // 2. Sweep messages NO LONGER update Sandman state
  const decoyOffers = [{ name: 'Decoy', price: 999, purchased: false }];
  changeFiredWith = null;
  reader._handleSweepMessage({
    type: 'sweep',
    found: {},
    sandman: decoyOffers,
    sandman_status: 'unresolved',
    sweeps: 1,
    took_ms: 10,
  });
  check('sweep message does NOT update reader.sandman()',
    reader.sandman() === mockOffers);
  check('sweep message does NOT update reader.sandman_status()',
    reader.sandman_status() === 'ok');
  check('sweep message does NOT fire onSandmanChange',
    changeFiredWith === null);

  // 3. Gate address relay from sweep message to sandmanWorker
  let relayedMsg = null;
  reader.sandmanWorker = {
    postMessage(msg) { relayedMsg = msg; },
  };
  reader._handleSweepMessage({
    type: 'sweep',
    found: {
      'Is in sandman shop': { binding_addr: 0x1234, variant: 'inline', is_float: true },
    },
    sweeps: 2,
    took_ms: 10,
  });
  check('sweep message relays gate address to sandmanWorker',
    relayedMsg !== null && relayedMsg.type === 'gate' && relayedMsg.addr === 0x1234
    && relayedMsg.variant === 'inline' && relayedMsg.is_float === true);

  // Relay null when gate disappeared
  relayedMsg = null;
  reader._handleSweepMessage({
    type: 'sweep',
    found: {},
    sweeps: 3,
    took_ms: 10,
  });
  check('sweep message relays null gate address when absent',
    relayedMsg !== null && relayedMsg.type === 'gate' && relayedMsg.addr === null);
}

function testRetention() {
  console.log('\n--- test-sandman: offer retention across shop open/close ---');

  const A = [{ name: 'Fairy Dust', price: 150 }];
  const B = [{ name: 'Adder Stone', price: 250 }, { name: 'Star Fragment', price: 50 }];

  // ---- nextSandmanStatus ----
  check('no offers and shop shut is pending',
    nextSandmanStatus(null, false, 0) === 'pending');
  check('held offers with the shop shut is ok, not a separate state',
    nextSandmanStatus(A, false, 0) === 'ok');
  check('held offers with the shop open is the same ok',
    nextSandmanStatus(A, true, 0) === 'ok');

  // The cells take a moment to build, so early empty reads are not a fault.
  check('open shop below fail ms threshold is not yet unresolved',
    nextSandmanStatus(null, true, SANDMAN_FAIL_MS - 1) === 'pending');
  check('open shop at the fail ms threshold is unresolved',
    nextSandmanStatus(null, true, SANDMAN_FAIL_MS) === 'unresolved');
  check('open shop beyond fail ms threshold is unresolved',
    nextSandmanStatus(null, true, SANDMAN_FAIL_MS + 1000) === 'unresolved');
  check('unresolved wins over held offers so staleness is visible',
    nextSandmanStatus(A, true, SANDMAN_FAIL_MS) === 'unresolved');

  // The bug this guards: counting shut sweeps as misses would have the panel
  // call itself broken for the whole walk between shop visits.
  check('a shut shop never reaches unresolved however long it stays shut',
    nextSandmanStatus(A, false, 999999) === 'ok'
    && nextSandmanStatus(null, false, 999999) === 'pending');

  // ---- walked as a run ----
  //
  // This mirrors the tick body of sandman-worker.ts rather than inventing a
  // reduction of its own: hold the last read, never follow a read down to
  // null, and clear only when the parent says the run ended. The worker has
  // no map id -- run detection lives in Reader.clearRun and arrives here as
  // a 'clear' message -- so this walk has none either. A walk that took a
  // map id would be testing a mechanism the worker does not have.
  let held = null;
  let firstOpenWithoutRead = null;
  const poll = (shopOpen, incoming, nowMs) => {
    if (!shopOpen || incoming !== null) {
      firstOpenWithoutRead = null;
    } else if (firstOpenWithoutRead === null) {
      firstOpenWithoutRead = nowMs;
    }
    const elapsed = firstOpenWithoutRead !== null ? (nowMs - firstOpenWithoutRead) : 0;
    if (incoming !== null) held = incoming;
    return nextSandmanStatus(held, shopOpen, elapsed);
  };
  // What the worker's 'clear' handler does.
  const clear = () => { held = null; firstOpenWithoutRead = null; };

  let t = 1000;
  check('run walk: before any shop, pending',
    poll(false, null, t) === 'pending' && held === null);
  t += 100;
  check('run walk: shop opens and reads, ok',
    poll(true, A, t) === 'ok' && held === A);
  t += 100;
  check('run walk: shop shuts, offers survive',
    poll(false, null, t) === 'ok' && held === A);
  t += 10000;
  check('run walk: a long walk between visits stays ok',
    poll(false, null, t) === 'ok' && held === A);
  t += 100;
  check('run walk: a second shop replaces them',
    poll(true, B, t) === 'ok' && held === B);
  t += 100;
  check('run walk: timer reset on read, so one bad read is tolerated',
    poll(true, null, t) === 'ok' && held === B);
  t += SANDMAN_FAIL_MS + 100;
  check('run walk: a persistently unreadable open shop goes unresolved',
    poll(true, null, t) === 'unresolved' && held === B);
  t += 100;
  check('run walk: shutting the shop clears the fault',
    poll(false, null, t) === 'ok' && held === B);

  // An empty array is a reading, not an absence. readOffers returns null for
  // "could not read" and never [], so this pins that [] is held.
  const empty = [];
  t += 100;
  check('run walk: an empty reading is held rather than treated as a miss',
    poll(true, empty, t) === 'ok' && held === empty);

  clear();
  t += 100;
  check('run walk: the run ends and everything resets',
    poll(false, null, t) === 'pending' && held === null);
}

function testOffersChanged() {
  console.log('\n--- test-sandman: offersChanged equality checks ---');

  const baseOffers = [
    { name: 'Dream of Wisdom', price: 50, purchased: false },
    { name: 'Dream of Power', price: 75, purchased: true },
  ];

  // (null, null) -> false
  check('offersChanged(null, null) is false',
    offersChanged(null, null) === false);

  // (null, offers) -> true
  check('offersChanged(null, offers) is true',
    offersChanged(null, baseOffers) === true);

  // (offers, null) -> true
  check('offersChanged(offers, null) is true',
    offersChanged(baseOffers, null) === true);

  // identical references -> false
  check('offersChanged(offers, offers) [identical reference] is false',
    offersChanged(baseOffers, baseOffers) === false);

  // identical contents -> false
  const clonedOffers = [
    { name: 'Dream of Wisdom', price: 50, purchased: false },
    { name: 'Dream of Power', price: 75, purchased: true },
  ];
  check('offersChanged identical contents is false',
    offersChanged(baseOffers, clonedOffers) === false);

  // price changed -> true
  const priceChanged = [
    { name: 'Dream of Wisdom', price: 60, purchased: false },
    { name: 'Dream of Power', price: 75, purchased: true },
  ];
  check('offersChanged price changed is true',
    offersChanged(baseOffers, priceChanged) === true);

  // sold bit changed -> true
  const soldChanged = [
    { name: 'Dream of Wisdom', price: 50, purchased: true },
    { name: 'Dream of Power', price: 75, purchased: true },
  ];
  check('offersChanged sold bit changed is true',
    offersChanged(baseOffers, soldChanged) === true);

  // name changed -> true
  const nameChanged = [
    { name: 'Dream of Courage', price: 50, purchased: false },
    { name: 'Dream of Power', price: 75, purchased: true },
  ];
  check('offersChanged name changed is true',
    offersChanged(baseOffers, nameChanged) === true);

  // length changed -> true
  const lengthChanged = [
    { name: 'Dream of Wisdom', price: 50, purchased: false },
  ];
  check('offersChanged length changed is true',
    offersChanged(baseOffers, lengthChanged) === true);
}

function main() {
  console.log('=== test-sandman: Sandman Offers Channel Test Suite ===');
  testVtableResolution();
  testNameAndPriceReading();
  testControllerSlotReadoutAndPurchasedState();
  testReaderIntegration();
  testRetention();
  testOffersChanged();

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' FAILURE(S)'}`);
  return failures;
}

module.exports = { main };

if (require.main === module) {
  process.exit(main() ? 1 : 0);
}
