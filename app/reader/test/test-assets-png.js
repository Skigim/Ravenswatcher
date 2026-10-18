'use strict';
// The PNG the encoder writes is checked structurally: signature, IHDR fields,
// every chunk's CRC, and the inflated IDAT equals the filtered rows.
const assert = require('assert');
const zlib = require('zlib');
const { encodePng } = require('../../assets/png');

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function main() {
  const rgba = Buffer.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 9, 9, 9, 9]);
  const png = encodePng(2, 2, rgba);
  assert.deepStrictEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

  const chunks = [];
  let off = 8;
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('latin1', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    const crc = png.readUInt32BE(off + 8 + len);
    assert.strictEqual(crc, crc32(png.subarray(off + 4, off + 8 + len)), `${type} crc`);
    chunks.push({ type, data });
    off += 12 + len;
  }
  assert.deepStrictEqual(chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
  const ihdr = chunks[0].data;
  assert.strictEqual(ihdr.readUInt32BE(0), 2);
  assert.strictEqual(ihdr.readUInt32BE(4), 2);
  assert.deepStrictEqual([...ihdr.subarray(8)], [8, 6, 0, 0, 0]);
  const rows = zlib.inflateSync(chunks[1].data);
  assert.deepStrictEqual([...rows], [0, 255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 0, 255, 0, 9, 9, 9, 9]);

  assert.throws(() => encodePng(2, 2, Buffer.alloc(15)), /15 bytes.*16/);
  console.log('test-assets-png: ok');
}

module.exports = { main };
if (require.main === module) main();
