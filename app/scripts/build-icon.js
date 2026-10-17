'use strict';
// Original block-letter R, independent of Ravenswatch artwork. The ICO is a
// reproducible build output; each frame embeds a PNG made by our encoder.
// A local build/icon-local.ico, which Git ignores, replaces the R on the
// machine that has one.
const fs = require('fs');
const path = require('path');
const { encodePng } = require('../assets/png');

const output = path.join(__dirname, '..', 'build', 'icon.ico');
const local = path.join(__dirname, '..', 'build', 'icon-local.ico');
if (fs.existsSync(local)) {
  fs.copyFileSync(local, output);
  return;
}

const glyph = ['11110', '10001', '10001', '11110', '10100', '10010', '10001'];
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map(size => {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = Math.floor((x / size - 0.25) * 10);
      const gy = Math.floor((y / size - 0.15) * 10);
      const ink = gx >= 0 && gx < 5 && gy >= 0 && gy < 7 && glyph[gy][gx] === '1';
      pixels.set(ink ? [213, 180, 111, 255] : [23, 28, 35, 255], (y * size + x) * 4);
    }
  }
  return encodePng(size, size, pixels);
});
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
images.forEach((png, index) => {
  const pos = 6 + index * 16;
  header[pos] = sizes[index] % 256;
  header[pos + 1] = sizes[index] % 256;
  header.writeUInt16LE(1, pos + 4);
  header.writeUInt16LE(32, pos + 6);
  header.writeUInt32LE(png.length, pos + 8);
  header.writeUInt32LE(offset, pos + 12);
  offset += png.length;
});
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, Buffer.concat([header, ...images]));
