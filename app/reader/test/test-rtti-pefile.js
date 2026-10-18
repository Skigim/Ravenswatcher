'use strict';
// Exercise pe.js + rtti.js against a REAL MSVC-compiled PE with real RTTI,
// read from disk. Ravenswatch.exe is not touched.
//
// What this proves: the PE section-header parse, the TypeDescriptor scan, the
// Complete Object Locator validation (signature + self-RVA), and the
// vtable-that-references-the-locator lookup all agree with the C++ compiler's
// actual output, and the inverse walk (vtable -> class name) round-trips.
//
// What it cannot prove: that any of it finds oCGlobalEntityValueSettings in
// Ravenswatch.exe. That stays UNVERIFIED.

const fs = require('fs');
const path = require('path');
const { PeFileSource } = require('../pefile');
const rtti = require('../rtti');
const { parseSections } = require('../pe');

const CANDIDATES = [
  'C:/Windows/System32/msvcp140.dll',
  'C:/Windows/System32/mfc140u.dll',
  'C:/Windows/System32/d3d11.dll',
  'C:/Windows/System32/dxgi.dll',
  'C:/Windows/System32/dcomp.dll',
  'C:/Windows/System32/Windows.UI.Xaml.dll',
  path.join(__dirname, '..', 'node_modules', 'koffi', 'build', 'koffi', 'win32_x64', 'koffi.node'),
  process.execPath,
];

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

function typeDescriptorNames(src, base, dataSec, limit = 40) {
  // Harvest a few real ".?AV...@@\0" strings straight out of the section so
  // the test uses names the compiler actually emitted, not names we guessed.
  const names = [];
  const start = base + dataSec.vaddr;
  const chunk = src.read(start, Math.min(dataSec.vsize, 8 * 1024 * 1024));
  if (!chunk) return names;
  const needle = Buffer.from('.?AV', 'latin1');
  let pos = 0;
  while (names.length < limit) {
    const i = chunk.indexOf(needle, pos);
    if (i === -1) break;
    const z = chunk.indexOf(0, i);
    if (z !== -1 && z - i < 200) {
      const s = chunk.subarray(i, z).toString('latin1');
      if (/^[\x20-\x7e]+$/.test(s)) names.push(s + '\0');
    }
    pos = i + 4;
  }
  return names;
}


function buildSyntheticPeBuffer(base) {
  const buf = Buffer.alloc(0x5000);

  // DOS header
  buf.writeUInt16LE(0x5a4d, 0x00); // MZ
  buf.writeUInt32LE(0x80, 0x3c);   // e_lfanew = 0x80

  // PE header at 0x80
  buf.writeUInt32LE(0x00004550, 0x80); // PE\0\0
  buf.writeUInt16LE(0x8664, 0x84);     // x64 machine
  buf.writeUInt16LE(2, 0x86);          // numSections = 2
  buf.writeUInt16LE(0xe0, 0x94);       // optSize = 0xe0

  // Optional header at 0x98
  buf.writeUInt16LE(0x20b, 0x98);      // PE32+ magic

  // Section headers at 0x80 + 0x18 + 0xe0 = 0x178
  // 0: .rdata
  buf.write('.rdata\0\0', 0x178, 'ascii');
  buf.writeUInt32LE(0x1000, 0x178 + 8);  // vsize
  buf.writeUInt32LE(0x1000, 0x178 + 12); // vaddr
  buf.writeUInt32LE(0x1000, 0x178 + 16); // rawSize
  buf.writeUInt32LE(0x1000, 0x178 + 20); // rawPtr

  // 1: .data
  buf.write('.data\0\0\0', 0x1a0, 'ascii');
  buf.writeUInt32LE(0x2000, 0x1a0 + 8);  // vsize
  buf.writeUInt32LE(0x2000, 0x1a0 + 12); // vaddr
  buf.writeUInt32LE(0x2000, 0x1a0 + 16); // rawSize
  buf.writeUInt32LE(0x2000, 0x1a0 + 20); // rawPtr

  const multiName = '.?AVMultiHitTestClass@@\0';
  const singleName = '.?AVSingleHitClass@@\0';

  // .data section (RVA 0x2000..0x4000)
  // Hit 0 (Decoy string at RVA 0x2100, not referenced by any COL)
  buf.write(multiName, 0x2100, 'latin1');

  // Hit 1 (Real TypeDescriptor 1 at RVA 0x22f0; name at 0x2300)
  buf.write(multiName, 0x2300, 'latin1');

  // Hit 2 (Real TypeDescriptor 2 at RVA 0x24f0; name at 0x2500)
  buf.write(multiName, 0x2500, 'latin1');

  // Single hit class at RVA 0x26f0; name at 0x2700
  buf.write(singleName, 0x2700, 'latin1');

  function writeU64LE(val, offset) {
    buf.writeUInt32LE(val % 4294967296, offset);
    buf.writeUInt32LE(Math.floor(val / 4294967296), offset + 4);
  }

  // .rdata section (RVA 0x1000..0x2000)
  // COL 1 at RVA 0x1100 -> references TD 1 (0x22f0)
  buf.writeUInt32LE(1, 0x1100);
  buf.writeUInt32LE(0, 0x1104);
  buf.writeUInt32LE(0, 0x1108);
  buf.writeUInt32LE(0x22f0, 0x110c);
  buf.writeUInt32LE(0, 0x1110);
  buf.writeUInt32LE(0x1100, 0x1114);

  // Vtable 1 at RVA 0x1200 (COL ptr at 0x11f8)
  writeU64LE(base + 0x1100, 0x11f8);
  writeU64LE(base + 0x9000, 0x1200);

  // COL 2 at RVA 0x1300 -> references TD 2 (0x24f0)
  buf.writeUInt32LE(1, 0x1300);
  buf.writeUInt32LE(8, 0x1304);
  buf.writeUInt32LE(0, 0x1308);
  buf.writeUInt32LE(0x24f0, 0x130c);
  buf.writeUInt32LE(0, 0x1310);
  buf.writeUInt32LE(0x1300, 0x1314);

  // Vtable 2 at RVA 0x1400 (COL ptr at 0x13f8)
  writeU64LE(base + 0x1300, 0x13f8);
  writeU64LE(base + 0x9008, 0x1400);

  // COL 3 at RVA 0x1500 -> references SingleHitClass TD (0x26f0)
  buf.writeUInt32LE(1, 0x1500);
  buf.writeUInt32LE(0, 0x1504);
  buf.writeUInt32LE(0, 0x1508);
  buf.writeUInt32LE(0x26f0, 0x150c);
  buf.writeUInt32LE(0, 0x1510);
  buf.writeUInt32LE(0x1500, 0x1514);

  // Vtable 3 at RVA 0x1600 (COL ptr at 0x15f8)
  writeU64LE(base + 0x1500, 0x15f8);
  writeU64LE(base + 0x9010, 0x1600);

  return buf;
}

class MockPeSource {
  constructor(buf, base = 0x0000000180000000) {
    this.buf = buf;
    this.base = base;
  }
  read(addr, size) {
    const rva = addr - this.base;
    if (rva < 0 || rva >= this.buf.length) return null;
    const end = Math.min(rva + size, this.buf.length);
    if (end <= rva) return null;
    return this.buf.subarray(rva, end);
  }
  readPtr(addr) {
    const d = this.read(addr, 8);
    if (!d || d.length < 8) return null;
    return d.readUInt32LE(4) * 4294967296 + d.readUInt32LE(0);
  }
  readI32(addr) {
    const d = this.read(addr, 4);
    if (!d || d.length < 4) return null;
    return d.readInt32LE(0);
  }
}

function testMultipleNameHits() {
  console.log('\ntest-rtti-pefile: multiple TypeDescriptor name hits regression (Fix B)');
  const base = 0x0000000180000000;
  const buf = buildSyntheticPeBuffer(base);
  const src = new MockPeSource(buf, base);

  const { data, search } = rtti.sectionsOf(src, base);
  check('synthetic image .data and .rdata found', !!search);
  if (!search) return;

  const multiName = '.?AVMultiHitTestClass@@\0';
  const singleName = '.?AVSingleHitClass@@\0';
  const absentName = '.?AVAbsentClass@@\0';

  // Control cases
  const singleOne = rtti.resolveOneVtable(src, base, data, search, singleName);
  check('control: single-hit class resolves with resolveOneVtable', singleOne === 0x1600,
    `got 0x${singleOne ? singleOne.toString(16) : 'null'} want 0x1600`);

  const singleAll = rtti.resolveAllVtableRvas(src, base, singleName);
  check('control: single-hit class resolves with resolveAllVtableRvas',
    JSON.stringify(singleAll) === JSON.stringify([0x1600]),
    `got [${singleAll.map(a => '0x' + a.toString(16)).join(', ')}]`);

  const absentOne = rtti.resolveOneVtable(src, base, data, search, absentName);
  check('control: absent class returns null for resolveOneVtable', absentOne === null);

  const absentAll = rtti.resolveAllVtableRvas(src, base, absentName);
  check('control: absent class returns [] for resolveAllVtableRvas', absentAll.length === 0);

  // Multi-hit regression: hit 0 is a decoy, hit 1 & hit 2 are valid
  const hits = rtti.scanSection(src, base, data, Buffer.from(multiName, 'latin1'));
  check('found 3 name occurrences in .data section', hits.length === 3, `count=${hits.length}`);

  const multiOne = rtti.resolveOneVtable(src, base, data, search, multiName);
  check('resolveOneVtable continues past non-resolving hit 0 to find resolving hit',
    multiOne === 0x1200,
    `got 0x${multiOne ? multiOne.toString(16) : 'null'} want 0x1200`);

  const multiAll = rtti.resolveAllVtableRvas(src, base, multiName);
  check('resolveAllVtableRvas accumulates valid vtables across all name hits',
    JSON.stringify(multiAll) === JSON.stringify([0x1200, 0x1400]),
    `got [${multiAll.map(a => '0x' + a.toString(16)).join(', ')}] want [0x1200, 0x1400]`);

  // Inverse RTTI
  const inv1 = rtti.classOfVtable(src, base, 0x10000, base + 0x1200);
  const inv2 = rtti.classOfVtable(src, base, 0x10000, base + 0x1400);
  check('inverse RTTI round-trips vtable 1', inv1 === '.?AVMultiHitTestClass@@', `got ${inv1}`);
  check('inverse RTTI round-trips vtable 2', inv2 === '.?AVMultiHitTestClass@@', `got ${inv2}`);
}

function main() {
  testMultipleNameHits();

  const file = CANDIDATES.find(f => {
    try { fs.accessSync(f); } catch { return false; }
    try {
      const src = new PeFileSource(f);
      const { data } = rtti.sectionsOf(src, src.base);
      return !!data && typeDescriptorNames(src, src.base, data, 3).length >= 3;
    } catch { return false; }
  });
  if (!file) {
    console.log('  SKIP  no RTTI-bearing PE found among candidates');
    return failures;
  }
  console.log(`\ntest-rtti-pefile: ${file}`);
  const src = new PeFileSource(file);
  const base = src.base;

  const secs = parseSections(src, base);
  check('pe.parseSections finds sections', secs.length > 0, `${secs.length} sections`);
  check('pe.parseSections agrees with the raw header parse',
    JSON.stringify(secs.map(s => [s.name, s.vaddr, s.vsize]))
      === JSON.stringify(src.sections.map(s => [s.name, s.vaddr, s.vsize])));

  const { data, rdata, search } = rtti.sectionsOf(src, base);
  check('.data and .rdata present', !!search,
    search ? `.data@0x${data.vaddr.toString(16)} .rdata@0x${rdata.vaddr.toString(16)}` : '');
  if (!search) return failures;

  const names = typeDescriptorNames(src, base, data);
  check('found TypeDescriptor name strings', names.length > 0, `${names.length} sampled`);

  let resolved = 0, roundTripped = 0;
  const shown = [];
  for (const n of names) {
    const rva = rtti.resolveOneVtable(src, base, data, search, n);
    if (rva === null) continue;
    resolved++;
    // Inverse walk: the vtable we just found must name the class we started from.
    const back = rtti.classOfVtable(src, base, 0x10000000, base + rva);
    const want = n.slice(0, -1);
    if (back === want) roundTripped++;
    if (shown.length < 5) shown.push(`${want} -> vtable RVA 0x${rva.toString(16)}${back === want ? '' : ` (inverse gave ${back})`}`);
  }
  for (const s of shown) console.log(`        ${s}`);
  check('resolveOneVtable resolved at least 5 classes', resolved >= 5, `${resolved}/${names.length}`);
  check('inverse RTTI round-trips every resolved vtable',
    resolved > 0 && roundTripped === resolved, `${roundTripped}/${resolved}`);

  // A name that does not exist must resolve to null, not to something.
  const bogus = rtti.resolveOneVtable(src, base, data, search,
    '.?AVoCThisClassDoesNotExistAnywhere@@\0');
  check('an absent class resolves to null', bogus === null, String(bogus));

  // resolveAllVtableRvas (the multiple-inheritance form) must be a superset
  // of the single answer.
  if (names.length) {
    const one = rtti.resolveOneVtable(src, base, data, search, names[0]);
    const all = rtti.resolveAllVtableRvas(src, base, names[0]);
    check('resolveAllVtableRvas contains resolveOneVtable\'s answer',
      one === null || all.includes(one), `all=[${all.map(a => '0x' + a.toString(16)).join(', ')}]`);
  }
  return failures;
}

if (require.main === module) process.exit(main() ? 1 : 0);
module.exports = { main };
