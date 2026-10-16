'use strict';
// oCTexture containers built by hand, one per format, decoded to known
// pixels. The container builder mirrors the layout in texture.ts's header:
// a decoy first marker with a length that cannot match, then the real one.
const assert = require('assert');
const { parseTexture, RGBA8, BC1, BC3 } = require('../../assets/texture');

function container(width, height, format, payload, { breakLength = false } = {}) {
  const head = Buffer.alloc(0x40);
  head.writeUInt32LE(16, 0x00);
  head.writeUInt32LE(0xaabb1111, 0x08);
  head.writeUInt32LE(3, 0x0c);
  // Decoy marker at 0x20 whose fields are garbage.
  head.writeUInt32LE(0xaabb2222, 0x20);
  head.writeUInt32LE(0xdeadbeef, 0x30);
  const rec = Buffer.alloc(0x28);
  rec.writeUInt32LE(0xaabb2222, 0x00);
  rec.writeUInt32LE(width, 0x10);
  rec.writeUInt32LE(height, 0x14);
  rec.writeUInt32LE(format, 0x1c);
  const len = breakLength ? payload.length + 1 : payload.length;
  rec.writeUInt32LE(len, 0x20);
  rec.writeUInt32LE(len, 0x24);
  return Buffer.concat([head, rec, payload]);
}

// One BC1 block: c0 = pure red (0xF800), c1 = pure blue (0x001F), c0 > c1 so
// four-colour mode. Indices: row 0 all 0 (red), row 1 all 1 (blue), row 2
// all 2 (2/3 red + 1/3 blue), row 3 all 3 (1/3 red + 2/3 blue).
function bc1Block() {
  const b = Buffer.alloc(8);
  b.writeUInt16LE(0xf800, 0);
  b.writeUInt16LE(0x001f, 2);
  b[4] = 0b00000000; b[5] = 0b01010101; b[6] = 0b10101010; b[7] = 0b11111111;
  return b;
}

// BC3 alpha block: a0 = 255, a1 = 0 (eight-value mode). Indices: all 0 for
// row 0 (255), all 1 for row 1 (0), all 2 for row 2 (218 = 6*255/7
// truncated), all 7 for row 3 (36 = 255/7 truncated). 3-bit indices packed
// little-endian into 6 bytes.
function bc3Block() {
  const alpha = Buffer.alloc(8);
  alpha[0] = 255; alpha[1] = 0;
  const idx = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 7, 7, 7, 7];
  let bits = 0n;
  idx.forEach((v, i) => { bits |= BigInt(v) << BigInt(3 * i); });
  for (let i = 0; i < 6; i++) alpha[2 + i] = Number((bits >> BigInt(8 * i)) & 0xffn);
  return Buffer.concat([alpha, bc1Block()]);
}

function px(t, x, y) {
  const o = (y * t.width + x) * 4;
  return [t.rgba[o], t.rgba[o + 1], t.rgba[o + 2], t.rgba[o + 3]];
}

function main() {
  // RGBA8: red in the low byte.
  const raw = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const t0 = parseTexture(container(2, 1, RGBA8, raw), 'raw');
  assert.deepStrictEqual([t0.width, t0.height, t0.format], [2, 1, RGBA8]);
  assert.deepStrictEqual(px(t0, 1, 0), [5, 6, 7, 8]);

  // BC1 4x4.
  const t1 = parseTexture(container(4, 4, BC1, bc1Block()), 'bc1');
  assert.deepStrictEqual(px(t1, 0, 0), [255, 0, 0, 255]);
  assert.deepStrictEqual(px(t1, 3, 1), [0, 0, 255, 255]);
  assert.deepStrictEqual(px(t1, 0, 2), [170, 0, 85, 255]);
  assert.deepStrictEqual(px(t1, 0, 3), [85, 0, 170, 255]);

  // BC1 6x6: four blocks, cropped. Pixel (5,5) is block (1,1) local (1,1) = row 1 = blue.
  const t2 = parseTexture(container(6, 6, BC1, Buffer.concat([bc1Block(), bc1Block(), bc1Block(), bc1Block()])), 'bc1-6');
  assert.strictEqual(t2.rgba.length, 6 * 6 * 4);
  assert.deepStrictEqual(px(t2, 5, 5), [0, 0, 255, 255]);
  assert.deepStrictEqual(px(t2, 4, 4), [255, 0, 0, 255]);

  // BC3 4x4: colour as BC1, alpha per row.
  const t3 = parseTexture(container(4, 4, BC3, bc3Block()), 'bc3');
  assert.deepStrictEqual(px(t3, 0, 0), [255, 0, 0, 255]);
  assert.deepStrictEqual(px(t3, 0, 1), [0, 0, 255, 0]);
  assert.deepStrictEqual(px(t3, 0, 2), [170, 0, 85, 218]);
  assert.deepStrictEqual(px(t3, 0, 3), [85, 0, 170, 36]);

  // Unknown format names the number and the file.
  assert.throws(() => parseTexture(container(4, 4, 7, Buffer.alloc(8)), 'odd.dxt'), /odd\.dxt.*format 7/);
  // A length that matches neither marker is not a texture.
  assert.throws(() => parseTexture(container(4, 4, BC1, bc1Block(), { breakLength: true }), 'short.dxt'), /short\.dxt.*no texture record/);

  console.log('test-assets-texture: ok');
}

module.exports = { main };
if (require.main === module) main();
