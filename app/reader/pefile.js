'use strict';
// A .read(addr, size) source backed by a PE file on disk, presenting the
// image the way the loader would map it: `base + rva` addresses resolve
// through the section table to raw file offsets.
//
// Purpose: run pe.js and rtti.js -- the whole TypeDescriptor -> Complete
// Object Locator -> vtable walk -- against a real MSVC binary with real RTTI
// without attaching to any process. Same code path, different byte supply.
//
// It is NOT a substitute for a live attach: relocations are not applied, and
// nothing here can show that the walk finds the right classes in
// Ravenswatch.exe specifically. It shows the walk is structurally correct.

const fs = require('fs');

class PeFileSource {
  /** @param {string} file  @param {number} base  pretend load address */
  constructor(file, base = 0x0000000180000000) {
    this.buf = fs.readFileSync(file);
    this.base = base;
    this.file = file;
    this.sections = [];
    this.sizeOfHeaders = 0;
    this._parseHeaders();
  }

  _parseHeaders() {
    const b = this.buf;
    if (b.readUInt16LE(0) !== 0x5a4d) throw new Error(`${this.file}: not MZ`);
    const e = b.readUInt32LE(0x3c);
    if (b.readUInt32LE(e) !== 0x00004550) throw new Error(`${this.file}: not PE`);
    const numSections = b.readUInt16LE(e + 6);
    const optSize = b.readUInt16LE(e + 20);
    const opt = e + 0x18;
    const magic = b.readUInt16LE(opt);
    if (magic !== 0x20b) throw new Error(`${this.file}: not PE32+ (magic 0x${magic.toString(16)})`);
    this.sizeOfHeaders = b.readUInt32LE(opt + 60);
    const so = opt + optSize;
    for (let i = 0; i < numSections; i++) {
      const o = so + i * 40;
      let end = 8;
      while (end > 0 && b[o + end - 1] === 0) end--;
      this.sections.push({
        name: b.subarray(o, o + end).toString('ascii'),
        vsize: b.readUInt32LE(o + 8),
        vaddr: b.readUInt32LE(o + 12),
        rawSize: b.readUInt32LE(o + 16),
        rawPtr: b.readUInt32LE(o + 20),
      });
    }
  }

  _fileOffset(rva) {
    if (rva < this.sizeOfHeaders) return rva;
    for (const s of this.sections) {
      if (rva >= s.vaddr && rva < s.vaddr + Math.max(s.vsize, s.rawSize)) {
        const off = rva - s.vaddr;
        if (off >= s.rawSize) return -1;   // .bss-style tail: zero-filled at runtime
        return s.rawPtr + off;
      }
    }
    return -1;
  }

  /** Returns a view into the backing file buffer rather than a copy (or null when unreadable). Callers must not mutate it. */
  read(addr, size) {
    const rva = addr - this.base;
    if (rva < 0) return null;
    const off = this._fileOffset(rva);
    if (off < 0) return null;
    const end = Math.min(off + size, this.buf.length);
    if (end <= off) return null;
    return this.buf.subarray(off, end);
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

module.exports = { PeFileSource };
