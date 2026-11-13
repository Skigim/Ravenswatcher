// The sweep primitive: every 8-byte-aligned occurrence of a set of target
// qwords across a process's committed memory, in one pass.
//
// Four things keep it fast enough for a 5 s sweep over ~1.5 GB:
//
//   1. Writable regions only. Heap objects live nowhere else, and image-backed
//      pages fault in from disk.
//   2. One reusable scratch Buffer (see scratch.ts). ReadProcessMemory
//      writes straight into the memory the scan loop reads; nothing is copied
//      or reallocated per region.
//   3. Aligned qword comparison, not a byte search. The buffer is walked as a
//      Uint32Array two words at a time.
//   4. ONE pass for ALL targets. A low-word prefilter table makes the loop
//      flat in the number of targets. Measured: 2.99 GB/s at 6 targets vs
//      0.99 GB/s without it. See bench/scan-bench.js.
//
// No BigInt anywhere in the loop -- BigUint64Array compares measured ~4x
// slower than the split-word Uint32Array form.
//
// `?? 0` on a Uint32Array read inside the loops exists only because
// noUncheckedIndexedAccess types every index as possibly undefined; the
// indices are in range by construction, so the fallback never fires.

import { scratch } from './scratch';
import type { Scratch } from './scratch';

/**
 * What a heap scan needs from its source. Strictly more than ByteSource:
 * scanning enumerates regions and reads into external memory, neither of
 * which a file-backed source can do. scanPointers never calls .read(), so
 * PeFileSource (which has only .read()) must not typecheck as a ScanSource.
 * ProcessHandle satisfies it.
 */
export interface ScanSource {
  /**
   * Committed, readable regions as [base, size]. `writableOnly` restricts to
   * the protection set heap objects actually live in.
   */
  regions(writableOnly?: boolean): Iterable<readonly [number, number]>;
  /** Raw read into caller-provided scratch memory. Returns bytes read, 0 on failure. */
  readInto(addr: number, dst: Buffer, size: number): number;
  readPtr(addr: number): number | null;
}

/** A hit: the address, or [address, preceding qword] for a withPrev target. */
export type PointerHit = number | [number, number];

export interface ScanPointersOptions {
  /** Restrict to the writable protection set -- heap objects only live there. */
  writableOnly?: boolean;
  /**
   * Targets for which the qword PRECEDING each hit is harvested from the same
   * buffer. Those targets' entries come back as [hitAddr, prevQword] pairs
   * instead of bare addresses.
   */
  withPrev?: readonly number[];
}

export interface ScanOptions {
  writableOnly?: boolean;
}

export const CHUNK_SIZE = 64 * 1024 * 1024;
// Granularity of the re-read after a chunk read fails. 64 KB is the
// allocation granularity VirtualQuery reports regions on, so it is the
// smallest unit worth retrying at: it bounds the loss at 64 KB while keeping
// the retry cheap -- a page-sized retry would cost 16x the reads for 16x less
// loss than is worth buying.
//
// Scale, measured against a live game process 2026-08-31: 4358 writable
// regions totalling 1492 MB, largest 26.3 MB, none at or above CHUNK_SIZE.
// So a real failed chunk is a region, not a full 64 MB, and the worst case is
// ~410 retry reads rather than the 1024 a full chunk would take.
const RETRY_SIZE = 64 * 1024;

const PREFILTER_BITS = 13;

interface ScanBuffers extends Scratch {
  u32: Uint32Array;
}

let _buf: ScanBuffers | null = null;
function buffers(): ScanBuffers {
  if (_buf === null) {
    const s = scratch(CHUNK_SIZE);
    _buf = { ...s, u32: new Uint32Array(s.ab) };
  }
  return _buf;
}

/**
 * Yields [chunkBase, qwordCount] with the bytes sitting in the shared buffer.
 * Region bases are page-aligned and both chunk sizes are multiples of 8, so
 * qword alignment survives a chunk split.
 *
 * A failed read is retried at RETRY_SIZE granularity. `regions()` enumerates
 * while the game runs, so a page can be freed between enumeration and read;
 * `ReadProcessMemory` then fails for the whole request and `readInto` reports
 * 0. Without the retry, one unreachable page costs every byte of the chunk it
 * sits in -- silently, since the caller sees a short iteration and not an
 * error. The retry narrows that loss to the RETRY_SIZE block the bad page is
 * in, and costs nothing on the overwhelmingly common path where the first
 * read succeeds.
 */
export function* iterChunks(
  proc: ScanSource, writableOnly = true,
): Generator<[number, number], void, undefined> {
  const b = buffers();
  for (const [base, size] of proc.regions(writableOnly)) {
    let off = 0;
    while (off < size) {
      const n = Math.min(size - off, CHUNK_SIZE);
      const got = proc.readInto(base + off, b.ptr, n);
      if (got >= 8) yield [base + off, Math.floor(got / 8)];
      else if (n > RETRY_SIZE) yield* retryInPieces(proc, b, base + off, n);
      off += n;
    }
  }
}

/**
 * Re-read one failed chunk in RETRY_SIZE pieces, yielding the pieces that
 * come back. Pieces land in the same shared buffer, so a consumer sees each
 * one exactly as it sees a whole chunk.
 */
function* retryInPieces(
  proc: ScanSource, b: ScanBuffers, base: number, size: number,
): Generator<[number, number], void, undefined> {
  let off = 0;
  while (off < size) {
    const n = Math.min(size - off, RETRY_SIZE);
    const got = proc.readInto(base + off, b.ptr, n);
    if (got >= 8) yield [base + off, Math.floor(got / 8)];
    off += n;
  }
}

/**
 * @param targets  qword values to find (plain Numbers)
 * @returns target -> [addr, ...], or [[addr, prevQword], ...] for targets
 *          listed in withPrev. Every requested target is present.
 */
export function scanPointers(
  proc: ScanSource,
  targets: readonly number[],
  opts: ScanPointersOptions = {},
): Map<number, PointerHit[]> {
  const { writableOnly = true, withPrev = [] } = opts;
  const uniq = [...new Set(targets)];
  const out = new Map<number, PointerHit[]>();
  const lists: PointerHit[][] = [];
  for (const t of uniq) {
    const l: PointerHit[] = [];
    lists.push(l);
    out.set(t, l);
  }
  if (!uniq.length) return out;

  const prevSet = new Set(withPrev);
  const T = uniq.length;
  const lo = new Uint32Array(T);
  const hi = new Uint32Array(T);
  const wantPrev = new Uint8Array(T);
  const MASK = (1 << PREFILTER_BITS) - 1;
  const tbl = new Uint8Array(MASK + 1);
  for (const [i, t] of uniq.entries()) {
    const low = t >>> 0;
    lo[i] = low;
    hi[i] = Math.floor(t / 4294967296) >>> 0;
    wantPrev[i] = prevSet.has(t) ? 1 : 0;
    tbl[low & MASK] = 1;
  }

  const b = buffers();
  const u32 = b.u32;

  const record = (t: number, i: number, chunkBase: number): void => {
    const addr = chunkBase + i * 4;
    const list = lists[t];
    if (list === undefined) return;
    if (wantPrev[t]) {
      // The qword right before the hit, harvested from the same buffer
      // rather than costing a ReadProcessMemory per candidate.
      const prev = i >= 2 ? (u32[i - 1] ?? 0) * 4294967296 + (u32[i - 2] ?? 0) : 0;
      list.push([addr, prev]);
    } else {
      list.push(addr);
    }
  };

  for (const [chunkBase, nq] of iterChunks(proc, writableOnly)) {
    const n = nq * 2;
    if (T === 1) {
      const lo0 = lo[0] ?? 0, hi0 = hi[0] ?? 0;
      for (let i = 0; i < n; i += 2) {
        if (u32[i] === lo0 && u32[i + 1] === hi0) record(0, i, chunkBase);
      }
    } else if (T === 2) {
      // buildIndex's own case: settings vtable + binding vtable. Two
      // direct compares beat the prefilter table when there are only two.
      const lo0 = lo[0] ?? 0, hi0 = hi[0] ?? 0, lo1 = lo[1] ?? 0, hi1 = hi[1] ?? 0;
      for (let i = 0; i < n; i += 2) {
        const v = u32[i] ?? 0;
        if (v === lo0) { if (u32[i + 1] === hi0) record(0, i, chunkBase); }
        else if (v === lo1) { if (u32[i + 1] === hi1) record(1, i, chunkBase); }
      }
    } else {
      for (let i = 0; i < n; i += 2) {
        const v = u32[i] ?? 0;
        if (tbl[v & MASK] === 0) continue;
        const h = u32[i + 1] ?? 0;
        for (let t = 0; t < T; t++) {
          if (v !== lo[t] || h !== hi[t]) continue;
          record(t, i, chunkBase);
          break;
        }
      }
    }
  }

  // A hit at chunk offset 0 has no preceding qword in this buffer. Rare
  // enough to fix up with a real read rather than stitching chunks together.
  for (let t = 0; t < T; t++) {
    if (!wantPrev[t]) continue;
    const list = lists[t];
    if (list === undefined) continue;
    for (const hit of list) {
      if (Array.isArray(hit) && hit[1] === 0) hit[1] = proc.readPtr(hit[0] - 8) ?? 0;
    }
  }
  return out;
}

/**
 * Every 8-byte-aligned qword whose VALUE falls inside one of a set of address
 * ranges. Returns value -> [addr, ...] for the values that actually occur.
 *
 * WHY THIS EXISTS RATHER THAN scanPointers OVER THE SAME ADDRESSES. Asking
 * "does anything point into the 0x140 bytes before this triple?" as an equality
 * scan means enumerating every address in every window as its own target. At
 * 41 per window and 30 windows that is 1110 targets, and scanPointers' 8192-slot
 * prefilter is sized for a handful: 1110 targets fill 12.7% of it, the
 * `tbl[...] === 0` early-out stops firing, and ~24M surviving qwords per pass
 * each walk the whole target list. Measured live: 37.4 s for that one stage,
 * 94% of placedAmong's total, against 0.99 s for the equality scan over the
 * same memory one stage earlier.
 *
 * A range test needs no enumeration. The prefilter keys on 512-byte granularity
 * (a 0x140 window touches at most two keys), so 30 windows set ~60 slots out of
 * a million and the early-out rejects essentially everything again.
 *
 * @param ranges  [lo, hi] inclusive, plain Numbers
 * @returns found value -> addresses holding it
 */
const RANGE_SHIFT = 9;                        // 512-byte prefilter granularity
const RANGE_BITS = 20;
export function scanPointerRanges(
  proc: ScanSource,
  ranges: readonly (readonly [number, number])[] | null | undefined,
  opts: ScanOptions = {},
): Map<number, number[]> {
  const { writableOnly = true } = opts;
  const out = new Map<number, number[]>();
  if (!ranges || !ranges.length) return out;

  const R = ranges.length;
  const rlo = new Float64Array(R);
  const rhi = new Float64Array(R);

  // Key off the low word only. `a >>> 0` is ToUint32, i.e. exactly the low 32
  // bits, so an address above 4 GB keys correctly and a range that happens to
  // straddle the 4 GB line simply sets two unrelated slots -- still correct,
  // since the slot is a filter and never the answer.
  const MASK = (1 << RANGE_BITS) - 1;
  const tbl = new Uint8Array(MASK + 1);
  const STEP = 1 << RANGE_SHIFT;
  for (const [i, [rangeLo, rangeHi]] of ranges.entries()) {
    rlo[i] = rangeLo;
    rhi[i] = rangeHi;
    for (let a = rangeLo; a <= rangeHi; a += STEP) tbl[((a >>> 0) >>> RANGE_SHIFT) & MASK] = 1;
    tbl[((rangeHi >>> 0) >>> RANGE_SHIFT) & MASK] = 1;
  }

  const b = buffers();
  const u32 = b.u32;
  for (const [chunkBase, nq] of iterChunks(proc, writableOnly)) {
    const n = nq * 2;
    for (let i = 0; i < n; i += 2) {
      const v = u32[i] ?? 0;
      if (tbl[(v >>> RANGE_SHIFT) & MASK] === 0) continue;
      const val = (u32[i + 1] ?? 0) * 4294967296 + v;
      for (let r = 0; r < R; r++) {
        if (val < (rlo[r] ?? Infinity) || val > (rhi[r] ?? -Infinity)) continue;
        const addr = chunkBase + i * 4;
        const list = out.get(val);
        if (list === undefined) out.set(val, [addr]); else list.push(addr);
        break;
      }
    }
  }
  return out;
}

/**
 * Every NUL-terminated occurrence of each needle in committed memory.
 *
 * The NUL check is not cosmetic: it stops a path from matching another that
 * merely has it as a prefix. Cost scales with the number of needles -- one
 * Buffer.indexOf pass each per chunk -- unlike scanPointers, which is flat in
 * its target count. A table of hundreds of needles wants a different shape.
 *
 * A needle straddling a chunk boundary is missed; iterChunks does not
 * overlap. Boundaries are 64 MB apart normally, but 64 KB apart inside a
 * region whose first read failed and went to the retry path -- so the miss
 * window is wider there. Still strictly better than dropping the whole
 * region. Harmless either way because
 * every path observed live is resident in several copies, and a miss costs
 * one inconclusive read rather than a wrong one.
 */
export function scanStrings(
  proc: ScanSource,
  needles: readonly string[],
  opts: ScanOptions = {},
): Map<string, number[]> {
  const { writableOnly = true } = opts;
  const uniq = [...new Set(needles)];
  const targets = uniq.map(n => ({
    needle: n, pat: Buffer.from(n + '\0', 'latin1'), hits: [] as number[],
  }));
  const out = new Map<string, number[]>(targets.map(t => [t.needle, t.hits]));
  if (!uniq.length) return out;
  const b = buffers();
  for (const [chunkBase, nq] of iterChunks(proc, writableOnly)) {
    const view = b.ptr.subarray(0, nq * 8);
    for (const { pat, hits } of targets) {
      let pos = 0;
      for (;;) {
        const idx = view.indexOf(pat, pos);
        if (idx === -1) break;
        hits.push(chunkBase + idx);
        pos = idx + 1;
      }
    }
  }
  return out;
}
