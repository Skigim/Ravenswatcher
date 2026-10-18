'use strict';
// oCTexture containers to RGBA.
//
// Cooked resource entries are named `<source path>.<asset class>.<cooked ext>`,
// e.g. `Ui/Objects/Icon_Read_Dream.png.Texture.dxt`. The `.png` in the name is
// the file the artist authored; what is on disk is an engine container
// holding BC-compressed or raw pixel data.
//
// Container layout (little-endian uint32 throughout):
//
//     0x00  header size (16)
//     0x08  aabb1111 as bytes 11 11 bb aa   container magic
//     0x0C  version           3 for every UI texture but Ui/UI.png, which is 4
//     0x10  length-prefixed RTTI class chain
//
// The pixel record hangs off the *second* `22 22 bb aa` marker in the first
// 0x200 bytes, at fixed offsets from it:
//
//     +0x10 width   +0x14 height   +0x1C format   +0x20 length   +0x24 length
//     +0x28 payload
//
// Two markers occur and only the second yields valid fields, so parse tries
// each candidate and keeps the first whose declared length matches the length
// computed from width, height and format. That arithmetic makes a wrong
// anchor impossible to accept. Version 4 appends a mip chain after the top
// mip; taking payload[0:length] handles both versions.
//
// Formats: 0 is uncompressed R8G8B8A8 (red in the low byte, established
// empirically in tools/decode_textures.py); 4 is BC1, 5 is BC3. The UI set
// this app draws uses only those three. tools/decode_textures.py is the
// datamining twin of this file; it dumps whole trees through Pillow.

export const RGBA8 = 0;
export const BC1 = 4;
export const BC3 = 5;

const MARKER = Buffer.from([0x22, 0x22, 0xbb, 0xaa]);
const ANCHOR_SEARCH_LIMIT = 0x200;
const MAX_DIMENSION = 8192;
const BLOCK_BYTES: Record<number, number> = { [BC1]: 8, [BC3]: 16 };

export interface Texture {
  width: number;
  height: number;
  format: number;
  rgba: Buffer;
}

/** Payload bytes a texture of this shape occupies, or null for a format this file does not decode. */
export function payloadSize(width: number, height: number, format: number): number | null {
  if (format === RGBA8) return width * height * 4;
  const block = BLOCK_BYTES[format];
  if (block === undefined) return null;
  return Math.ceil(width / 4) * Math.ceil(height / 4) * block;
}

export function parseTexture(bytes: Buffer, name = 'texture'): Texture {
  const size = bytes.length;
  let start = 0;
  for (;;) {
    const i = bytes.indexOf(MARKER, start);
    if (i < 0 || i >= ANCHOR_SEARCH_LIMIT) throw new Error(`${name}: no texture record found`);
    start = i + 1;
    if (i + 0x28 > size) continue;
    const width = bytes.readUInt32LE(i + 0x10);
    const height = bytes.readUInt32LE(i + 0x14);
    const format = bytes.readUInt32LE(i + 0x1c);
    const declared = bytes.readUInt32LE(i + 0x20);
    const repeated = bytes.readUInt32LE(i + 0x24);
    if (declared !== repeated) continue;
    if (!(width > 0 && width <= MAX_DIMENSION && height > 0 && height <= MAX_DIMENSION)) continue;
    const expected = payloadSize(width, height, format);
    if (expected === null) throw new Error(`${name}: format ${format} is not RGBA8, BC1 or BC3`);
    if (expected !== declared) continue;
    const body = i + 0x28;
    if (body + declared > size) continue;
    const payload = bytes.subarray(body, body + declared);
    return { width, height, format, rgba: decode(width, height, format, payload) };
  }
}

function decode(width: number, height: number, format: number, payload: Buffer): Buffer {
  if (format === RGBA8) return Buffer.from(payload);
  const block = BLOCK_BYTES[format];
  if (block === undefined) throw new Error(`format ${format} is not BC1 or BC3`);
  const out = Buffer.alloc(width * height * 4);
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  const texel = Buffer.alloc(64); // 16 RGBA texels of one block, row-major
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const off = (by * blocksX + bx) * block;
      if (format === BC1) {
        decodeColorBlock(payload, off, texel, false);
      } else {
        decodeColorBlock(payload, off + 8, texel, true);
        decodeAlphaBlock(payload, off, texel);
      }
      // One texel row of the block at a time, clipped at the right and
      // bottom edges of an image whose size is not a multiple of 4.
      const cols = Math.min(4, width - bx * 4);
      for (let py = 0; py < 4 && by * 4 + py < height; py++) {
        texel.copy(out, ((by * 4 + py) * width + bx * 4) * 4, py * 16, py * 16 + cols * 4);
      }
    }
  }
  return out;
}

// Scratch palettes, rebuilt for every block. Decoding is synchronous, so one
// of each serves every call.
const COLOR_PAL = Buffer.alloc(16);
const ALPHA_PAL = Buffer.alloc(8);

function rgb565(v: number): [number, number, number] {
  const r = (v >> 11) & 31, g = (v >> 5) & 63, b = v & 31;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}

/**
 * One 8-byte colour block into `texel` (16 RGBA texels, row-major).
 * `fourColour` is true for the colour half of a BC3 block: there the
 * endpoints are always read in four-colour mode, whatever their order.
 */
function decodeColorBlock(src: Buffer, off: number, texel: Buffer, fourColour: boolean): void {
  const c0 = src.readUInt16LE(off), c1 = src.readUInt16LE(off + 2);
  const [r0, g0, b0] = rgb565(c0), [r1, g1, b1] = rgb565(c1);
  // Four RGBA entries, packed: the two endpoints, then two derived from them.
  const pal = COLOR_PAL;
  pal[0] = r0; pal[1] = g0; pal[2] = b0; pal[3] = 255;
  pal[4] = r1; pal[5] = g1; pal[6] = b1; pal[7] = 255;
  if (fourColour || c0 > c1) {
    pal[8] = ((2 * r0 + r1) / 3) | 0; pal[9] = ((2 * g0 + g1) / 3) | 0; pal[10] = ((2 * b0 + b1) / 3) | 0; pal[11] = 255;
    pal[12] = ((r0 + 2 * r1) / 3) | 0; pal[13] = ((g0 + 2 * g1) / 3) | 0; pal[14] = ((b0 + 2 * b1) / 3) | 0; pal[15] = 255;
  } else {
    pal[8] = (r0 + r1) >> 1; pal[9] = (g0 + g1) >> 1; pal[10] = (b0 + b1) >> 1; pal[11] = 255;
    pal.fill(0, 12, 16);
  }
  for (let row = 0; row < 4; row++) {
    const bits = src.readUInt8(off + 4 + row);
    for (let col = 0; col < 4; col++) {
      texel.writeUInt32LE(pal.readUInt32LE(((bits >> (2 * col)) & 3) * 4), (row * 4 + col) * 4);
    }
  }
}

/** The 8-byte alpha half of a BC3 block: two endpoints and 16 three-bit indices. */
function decodeAlphaBlock(src: Buffer, off: number, texel: Buffer): void {
  const a0 = src.readUInt8(off), a1 = src.readUInt8(off + 1);
  const pal = ALPHA_PAL;
  pal[0] = a0;
  pal[1] = a1;
  if (a0 > a1) {
    for (let i = 2; i < 8; i++) pal[i] = (((8 - i) * a0 + (i - 1) * a1) / 7) | 0;
  } else {
    for (let i = 2; i < 6; i++) pal[i] = (((6 - i) * a0 + (i - 1) * a1) / 5) | 0;
    pal[6] = 0;
    pal[7] = 255;
  }
  // 48 bits of indices, little-endian, three bits per texel. Read as two
  // 24-bit halves of eight texels each, so the shifts stay in int32 range.
  for (let half = 0; half < 2; half++) {
    const bits = src.readUIntLE(off + 2 + half * 3, 3);
    for (let i = 0; i < 8; i++) {
      texel[(half * 8 + i) * 4 + 3] = pal.readUInt8((bits >> (3 * i)) & 7);
    }
  }
}
