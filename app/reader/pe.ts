'use strict';
// PE section headers read out of a mapped image.
//
// `source` is anything with .read(addr, size) -> Buffer|null. That is the
// live Process from win32.js, or the file-backed PeFileSource in pefile.js
// -- the RTTI walk above this runs identically on either, which is how the
// structural half gets exercised without attaching to anything.

/**
 * Anything this module can read bytes out of.
 *
 * Deliberately structural rather than importing Process or PeFileSource: the
 * point of this seam is that neither knows about the other, and both satisfy
 * it by shape. `null` is the unreadable case and is not an error -- see the
 * reader's null-vs-zero rule.
 */
export interface ByteSource {
  read(addr: number, size: number): Buffer | null;
}

export interface PeSection {
  name: string;
  vaddr: number;
  vsize: number;
  rawSize: number;
  rawPtr: number;
}

export function parseSections(source: ByteSource, base: number): PeSection[] {
  const dos = source.read(base, 0x40);
  if (!dos || dos.length < 0x40 || dos[0] !== 0x4d || dos[1] !== 0x5a) return [];
  const eLfanew = dos.readUInt32LE(0x3c);
  const peHdr = source.read(base + eLfanew, 0x18);
  if (!peHdr || peHdr.length < 0x18 || peHdr.readUInt32LE(0) !== 0x00004550) return [];
  const numSections = peHdr.readUInt16LE(6);
  const optSize = peHdr.readUInt16LE(20);
  const so = eLfanew + 0x18 + optSize;
  const secs: PeSection[] = [];
  for (let i = 0; i < numSections; i++) {
    const sd = source.read(base + so + i * 40, 40);
    if (!sd || sd.length < 40) continue;
    let end = 8;
    while (end > 0 && sd[end - 1] === 0) end--;
    secs.push({
      name: sd.subarray(0, end).toString('ascii'),
      vsize: sd.readUInt32LE(8),
      vaddr: sd.readUInt32LE(12),
      rawSize: sd.readUInt32LE(16),
      rawPtr: sd.readUInt32LE(20),
    });
  }
  return secs;
}
