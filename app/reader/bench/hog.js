'use strict';
// A stand-in for the game process: commits a multi-GB writable heap, plants
// known needles in it, prints what it planted as JSON on stdout, then idles
// until killed. Ravenswatch.exe cannot be started in this environment, so
// this is what the live-attach path is exercised against instead.
const koffi = require('koffi');

const GB = Number(process.argv[2] || 1.5);
const BLOCK = 64 * 1024 * 1024;
const blocks = Math.round((GB * 1024 * 1024 * 1024) / BLOCK);

// Needle qwords the reader will be asked to find, planted at known addresses.
const NEEDLE_A = 0x00007ff6a1b2c000;
const NEEDLE_B = 0x00007ff6a1b2d000;

const kept = [];
const planted = { a: [], b: [] };
for (let i = 0; i < blocks; i++) {
  // Buffer, not koffi.alloc + koffi.view: view() is fatal under Electron and
  // koffi 3 refuses a 64 MiB alloc outright. See the scratch() comment in
  // win32.js.
  const buf = Buffer.allocUnsafeSlow(BLOCK);
  const ab = buf.buffer;
  const u32 = new Uint32Array(ab, buf.byteOffset, BLOCK / 4);
  // Touch every page so it is really committed, with pointer-ish noise.
  let s = (0x9e3779b9 ^ i) >>> 0;
  for (let j = 0; j < u32.length; j += 2) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    if (s & 1) { u32[j] = s; u32[j + 1] = 0x000001c0 | (s & 0xff); }
    else { u32[j] = s & 0xffff; u32[j + 1] = 0; }
  }
  const base = Number(koffi.address(buf));
  // Two needles per block, at aligned offsets, with a recognisable preceding
  // qword so the with_prev harvesting can be checked too.
  const offA = 0x1000, offB = BLOCK - 0x2000;
  new DataView(ab).setUint32(offA, NEEDLE_A & 0xffffffff, true);
  new DataView(ab).setUint32(offA + 4, Math.floor(NEEDLE_A / 4294967296), true);
  new DataView(ab).setUint32(offA - 8, 0xdeadbeef, true);
  new DataView(ab).setUint32(offA - 4, 0x0000cafe, true);
  new DataView(ab).setUint32(offB, NEEDLE_B & 0xffffffff, true);
  new DataView(ab).setUint32(offB + 4, Math.floor(NEEDLE_B / 4294967296), true);
  planted.a.push(base + offA);
  planted.b.push(base + offB);
  kept.push({ ptr: buf, ab });
}

process.stdout.write(JSON.stringify({
  pid: process.pid,
  bytes: blocks * BLOCK,
  needleA: NEEDLE_A,
  needleB: NEEDLE_B,
  prevA: 0x0000cafedeadbeef,
  planted,
}) + '\n');

setInterval(() => {}, 1 << 30);
