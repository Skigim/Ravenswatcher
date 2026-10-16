'use strict';
// Pattern-scan throughput for the sweep primitive, measured on synthesised
// buffers of the size the real reader actually uses (CHUNK_SIZE = 64 MB in
// discover_values.py).
//
// The operation being measured is exactly what scan_pointers() does: find
// every 8-byte-ALIGNED occurrence of each of N target qwords in a buffer,
// and for one of them also harvest the preceding qword (with_prev).
//
// Benchmarks compared:
//   u32      -- Uint32Array, compare low word then high word, one pass for
//               all targets. No BigInt anywhere.
//   bigint   -- BigUint64Array with BigInt compares (the naive port).
//   indexOf  -- Buffer.indexOf(needle) in a loop, alignment-filtered
//               (one pass per target, memmem in C++).
//
// Python/numpy costs one full pass per target (`a == np.uint64(t)`), so the
// fair comparison for "same work as numpy" is the per-target column.

const TARGETS_DEFAULT = 2;          // settings_vt + binding_vt, the real sweep
const CHUNK = 64 * 1024 * 1024;     // discover_values.CHUNK_SIZE
const REPS = Number(process.env.REPS || 5);

function makeChunk(targets, hitsPerTarget) {
  const buf = Buffer.allocUnsafe(CHUNK);
  // Plausible heap-pointer noise: mostly small ints and near-pointer values,
  // so the low-word prefilter is not trivially always-false the way pure
  // random 64-bit noise would make it.
  const u32 = new Uint32Array(buf.buffer, buf.byteOffset, CHUNK / 4);
  let s = 0x12345678 >>> 0;
  for (let i = 0; i < u32.length; i += 2) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    // half the qwords look like heap pointers (0x000001xx_xxxxxxxx),
    // half look like small ints / zero
    if (s & 1) { u32[i] = s; u32[i + 1] = 0x000001c0 | (s & 0xff); }
    else { u32[i] = s & 0xffff; u32[i + 1] = 0; }
  }
  // Plant the needles at aligned positions, spread evenly.
  const stride = Math.floor(u32.length / (targets.length * hitsPerTarget + 1)) & ~1;
  let at = stride;
  for (const t of targets) {
    for (let k = 0; k < hitsPerTarget; k++) {
      u32[at] = Number(t & 0xffffffffn);
      u32[at + 1] = Number(t >> 32n);
      at += stride;
    }
  }
  return { buf, u32 };
}

// --- candidate 1: split-word Uint32Array scan, all targets in one pass -----
function scanU32(u32, targetsLo, targetsHi, withPrev, out) {
  const n = u32.length;
  const T = targetsLo.length;
  if (T === 1) {
    const lo = targetsLo[0], hi = targetsHi[0];
    for (let i = 0; i < n; i += 2) {
      if (u32[i] === lo && u32[i + 1] === hi) out.push(i * 4);
    }
    return;
  }
  if (T === 2) {
    const lo0 = targetsLo[0], hi0 = targetsHi[0];
    const lo1 = targetsLo[1], hi1 = targetsHi[1];
    for (let i = 0; i < n; i += 2) {
      const v = u32[i];
      if (v === lo0) { if (u32[i + 1] === hi0) out.push(i * 4); }
      else if (v === lo1) { if (u32[i + 1] === hi1) out.push(i * 4); }
    }
    return;
  }
  for (let i = 0; i < n; i += 2) {
    const v = u32[i];
    for (let t = 0; t < T; t++) {
      if (v === targetsLo[t] && u32[i + 1] === targetsHi[t]) { out.push(i * 4); break; }
    }
  }
}

// --- candidate 1b: low-word prefilter table, any number of targets, 1 pass -
// One Uint8Array lookup rejects almost every qword regardless of how many
// targets are live, so cost stops scaling with target count.
function makePrefilter(targetsLo) {
  const BITS = 13, SIZE = 1 << BITS;
  const tbl = new Uint8Array(SIZE);
  for (const lo of targetsLo) tbl[lo & (SIZE - 1)] = 1;
  return tbl;
}
function scanPrefilter(u32, tbl, targetsLo, targetsHi, out) {
  const n = u32.length, MASK = tbl.length - 1, T = targetsLo.length;
  for (let i = 0; i < n; i += 2) {
    const v = u32[i];
    if (tbl[v & MASK] === 0) continue;
    const h = u32[i + 1];
    for (let t = 0; t < T; t++) {
      if (v === targetsLo[t] && h === targetsHi[t]) { out.push(i * 4); break; }
    }
  }
}

// --- candidate 2: BigUint64Array with BigInt compares ----------------------
function scanBigInt(buf, targets, out) {
  const b64 = new BigUint64Array(buf.buffer, buf.byteOffset, buf.length / 8);
  const n = b64.length;
  for (let i = 0; i < n; i++) {
    const v = b64[i];
    for (let t = 0; t < targets.length; t++) {
      if (v === targets[t]) { out.push(i * 8); break; }
    }
  }
}

// --- candidate 3: Buffer.indexOf, one pass per target ----------------------
function scanIndexOf(buf, targets, out) {
  for (const t of targets) {
    const needle = Buffer.allocUnsafe(8);
    needle.writeBigUInt64LE(t);
    let from = 0;
    for (;;) {
      const i = buf.indexOf(needle, from);
      if (i === -1) break;
      if ((i & 7) === 0) out.push(i);
      from = i + 1;
    }
  }
}

function timeIt(label, fn, reps) {
  const times = [];
  for (let r = 0; r < reps; r++) {
    const t0 = process.hrtime.bigint();
    const hits = fn();
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
    if (r === 0) label += ` (hits=${hits})`;
  }
  times.sort((a, b) => a - b);
  const med = times[times.length >> 1];
  const gbps = (CHUNK / 1e9) / (med / 1000);
  return { label, med, gbps };
}

function run(nTargets) {
  const targets = [];
  for (let i = 0; i < nTargets; i++) targets.push(0x00007ff6a1b2c000n + BigInt(i) * 0x1000n);
  const lo = Uint32Array.from(targets, t => Number(t & 0xffffffffn));
  const hi = Uint32Array.from(targets, t => Number(t >> 32n));
  const { buf, u32 } = makeChunk(targets, 300);

  const rows = [];
  rows.push(timeIt('u32 split-word, one pass all targets', () => {
    const out = []; scanU32(u32, lo, hi, null, out); return out.length;
  }, REPS));
  const tbl = makePrefilter(lo);
  rows.push(timeIt('u32 + low-word prefilter, one pass  ', () => {
    const out = []; scanPrefilter(u32, tbl, lo, hi, out); return out.length;
  }, REPS));
  rows.push(timeIt('Buffer.indexOf, one pass per target ', () => {
    const out = []; scanIndexOf(buf, targets, out); return out.length;
  }, REPS));
  rows.push(timeIt('BigUint64Array + BigInt compares    ', () => {
    const out = []; scanBigInt(buf, targets, out); return out.length;
  }, REPS));

  console.log(`\n=== ${nTargets} target(s), ${(CHUNK / 1048576) | 0} MB buffer, ${REPS} reps, median ===`);
  for (const r of rows) {
    const perWritableSet = (1.8 / (CHUNK / 1e9)) * (r.med / 1000);
    console.log(
      `${r.label.padEnd(48)} ${r.med.toFixed(1).padStart(8)} ms  ` +
      `${r.gbps.toFixed(2).padStart(6)} GB/s   ` +
      `-> ${perWritableSet.toFixed(2)} s for a 1.8 GB writable set`);
  }
}

console.log(`node ${process.version}  ${process.arch}`);
run(TARGETS_DEFAULT);
run(1);
run(6);   // a resolver that sweeps several vtable RVAs at once
