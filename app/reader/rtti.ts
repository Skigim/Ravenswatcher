// MSVC RTTI vtable discovery: class name -> vtable RVAs, and the inverse
// (vtable -> class name) walk.
//
// Keys off class names, not fixed addresses, so it survives game patches;
// results are module-relative RVAs, so it survives ASLR.
//
// Runs against any {read(addr,size)} source -- the live process or a
// file-backed PE image.

import { parseSections } from './pe';
import type { ByteSource, PeSection } from './pe';

export const SCAN_CHUNK = 4 * 1024 * 1024;

// The GlobalValue pair every sweep needs. Other channels resolve their own
// classes by name, through resolveAllVtableRvas or a names map of their own.
export const RTTI_NAMES: Record<string, string> = {
  oCGlobalEntityValueSettings: '.?AVoCGlobalEntityValueSettings@@\0',
  oCEntityValueUnion: '.?AVoCEntityValueUnion@@\0',
};

/** Every occurrence of `pattern` (Buffer) inside one section, as addresses. */
export function scanSection(
  source: ByteSource, base: number, section: PeSection, pattern: Buffer,
): number[] {
  const start = base + section.vaddr;
  const size = section.vsize;
  const overlap = pattern.length;
  const results: number[] = [];
  let offset = 0;
  while (offset < size) {
    const toRead = Math.min(SCAN_CHUNK, size - offset);
    const data = source.read(start + offset, toRead);
    if (!data) { offset += SCAN_CHUNK - overlap; continue; }
    let pos = 0;
    for (;;) {
      const idx = data.indexOf(pattern, pos);
      if (idx === -1) break;
      const hit = start + offset + idx;
      // Chunks re-read trailing overlap bytes, so skip a hit already found at
      // the end of the previous chunk.
      if (results[results.length - 1] !== hit) results.push(hit);
      pos = idx + 1;
    }
    if (toRead < SCAN_CHUNK) break;
    offset += SCAN_CHUNK - overlap;
  }
  return results;
}

export function sectionsOf(source: ByteSource, base: number): {
  secs: PeSection[];
  data: PeSection | undefined;
  rdata: PeSection | undefined;
  search: PeSection[] | null;
} {
  const secs = parseSections(source, base);
  const data = secs.find(s => s.name === '.data');
  const rdata = secs.find(s => s.name === '.rdata');
  return { secs, data, rdata, search: data && rdata ? [rdata, data] : null };
}

function u32le(v: number): Buffer { const b = Buffer.allocUnsafe(4); b.writeUInt32LE(v >>> 0); return b; }
function u64le(v: number): Buffer {
  const b = Buffer.allocUnsafe(8);
  b.writeUInt32LE(v >>> 0, 0);
  b.writeUInt32LE(Math.floor(v / 4294967296) >>> 0, 4);
  return b;
}

/**
 * The 0x18 bytes of the Complete Object Locator at colAddr, or null when
 * there is not one. The self-RVA check (COL[0x14] + base == COL) is what stops
 * a stray dword that merely equals the TypeDescriptor RVA from being taken
 * for a locator.
 */
function readCol(source: ByteSource, base: number, colAddr: number): Buffer | null {
  const col = source.read(colAddr, 0x18);
  if (!col || col.length < 0x18) return null;
  if (col.readUInt32LE(0) !== 1) return null;
  if (base + col.readUInt32LE(0x14) !== colAddr) return null;
  return col;
}

/**
 * Every vtable RVA for one TypeDescriptor name, in discovery order: name
 * hit, then each locator referencing its TypeDescriptor, then each vtable
 * pointing at that locator. Lazy, so a caller that wants one stops scanning
 * at the first. Walks every name hit, so an accidental duplicate string before
 * the true TypeDescriptor does not end the search.
 */
function* vtableRvas(
  source: ByteSource, base: number, dataSec: PeSection,
  searchSections: readonly PeSection[], rttiName: string,
): Generator<number, void, undefined> {
  for (const nameHit of scanSection(source, base, dataSec, Buffer.from(rttiName, 'latin1'))) {
    const tdRvaBytes = u32le(nameHit - 0x10 - base);
    for (const sec of searchSections) {
      for (const refAddr of scanSection(source, base, sec, tdRvaBytes)) {
        const colAddr = refAddr - 0x0c;
        if (!readCol(source, base, colAddr)) continue;
        const colPtr = u64le(colAddr);
        for (const sec2 of searchSections) {
          for (const vt of scanSection(source, base, sec2, colPtr)) yield (vt + 8) - base;
        }
      }
    }
  }
}

/** TypeDescriptor name -> the first vtable RVA found for it, or null. */
export function resolveOneVtable(
  source: ByteSource, base: number, dataSec: PeSection,
  searchSections: readonly PeSection[], rttiName: string,
): number | null {
  for (const rva of vtableRvas(source, base, dataSec, searchSections, rttiName)) return rva;
  return null;
}

/** key -> vtable RVA (or null) for each entry of `names`, re-scanned per call. */
export function resolveVtableRvas(
  source: ByteSource, base: number, names: Record<string, string> = RTTI_NAMES,
): Record<string, number | null | undefined> {
  const { data, search } = sectionsOf(source, base);
  if (!data || !search) return {};
  const out: Record<string, number | null | undefined> = {};
  for (const [key, name] of Object.entries(names)) {
    out[key] = resolveOneVtable(source, base, data, search, name);
  }
  return out;
}

/**
 * Every candidate vtable RVA for one class, sorted. Multiple-inheritance
 * classes have more than one, and instances store the primary at +0x00, so
 * callers try each.
 */
export function resolveAllVtableRvas(source: ByteSource, base: number, rttiName: string): number[] {
  const { data, search } = sectionsOf(source, base);
  if (!data || !search) return [];
  return [...new Set(vtableRvas(source, base, data, search, rttiName))].sort((a, b) => a - b);
}

/** A byte source that can also read a pointer (a live process or PeFileSource). */
export interface PointerSource extends ByteSource {
  readPtr(addr: number): number | null;
}

/** Inverse RTTI: vtable address -> mangled class name. */
export function classOfVtable(
  source: PointerSource, base: number, size: number, vt: number | null | undefined,
): string | null {
  if (!vt || !(vt >= base && vt < base + size)) return null;
  const colAddr = source.readPtr(vt - 8);
  if (!colAddr || !(colAddr >= base && colAddr < base + size)) return null;
  const col = readCol(source, base, colAddr);
  if (!col) return null;
  const nm = source.read(base + col.readUInt32LE(0x0c) + 0x10, 128);
  if (!nm) return null;
  const z = nm.indexOf(0);
  return nm.subarray(0, z === -1 ? nm.length : z).toString('latin1');
}
