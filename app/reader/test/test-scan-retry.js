'use strict';
// A failed chunk read must not silently cost the whole chunk.
//
// `regions()` enumerates while the game runs, so a page can be freed before
// the read reaches it. ReadProcessMemory then fails for the entire request and
// readInto reports 0. iterChunks used to just skip the yield and advance, so
// one unreachable page removed up to a whole chunk from the pass with no
// signal to the caller.
//
// Nothing here reads process memory. The Process is a stub whose readInto
// fails on demand, which is the only way to reach the path -- the live
// measurement in open_findings.md counted 4336 real chunk reads and found zero
// failures, so a live run does not exercise it.

const { iterChunks, CHUNK_SIZE } = require('../scan');

const RETRY_SIZE = 64 * 1024;

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

/**
 * One writable region of `size` bytes at `base`. `deadAt` is an address whose
 * containing read always fails; every other read succeeds. That is how
 * ReadProcessMemory behaves -- all or nothing for the whole request.
 */
function stubProc(base, size, deadAt = null) {
  const reads = [];
  return {
    reads,
    *regions() { yield [base, size]; },
    readInto(addr, _ptr, n) {
      reads.push([addr, n]);
      if (deadAt !== null && deadAt >= addr && deadAt < addr + n) return 0;
      return n;
    },
  };
}

function covered(proc) {
  const out = [];
  for (const [chunkBase, nq] of iterChunks(proc, true)) out.push([chunkBase, nq * 8]);
  return out;
}

function totalBytes(ranges) {
  return ranges.reduce((a, [, n]) => a + n, 0);
}

function main() {
  console.log('\ntest-scan-retry: a failed chunk read is retried, not dropped');

  const BASE = 0x10000000;
  const SIZE = 4 * RETRY_SIZE;

  // Control: with nothing failing, the region is one chunk and every byte of
  // it is covered. If this does not hold, the numbers below mean nothing.
  const clean = covered(stubProc(BASE, SIZE));
  check('control: a readable region yields one chunk covering all of it',
    clean.length === 1 && clean[0][0] === BASE && totalBytes(clean) === SIZE,
    `${clean.length} chunk(s), ${totalBytes(clean)} of ${SIZE} bytes`);

  // One dead page in the third 64 KB block.
  const deadAt = BASE + 2 * RETRY_SIZE + 0x800;
  const proc = stubProc(BASE, SIZE, deadAt);
  const got = covered(proc);

  check('the whole-chunk read is attempted first',
    proc.reads.length > 0 && proc.reads[0][0] === BASE && proc.reads[0][1] === SIZE,
    `first read ${proc.reads[0][1]} bytes at 0x${proc.reads[0][0].toString(16)}`);

  check('and its failure triggers a retry at 64 KB granularity',
    proc.reads.length === 1 + SIZE / RETRY_SIZE
    && proc.reads.slice(1).every(([, n]) => n === RETRY_SIZE),
    `${proc.reads.length - 1} retry reads of ${RETRY_SIZE} bytes`);

  check('every block except the one holding the dead page is recovered',
    totalBytes(got) === SIZE - RETRY_SIZE,
    `${totalBytes(got)} of ${SIZE} bytes, lost ${SIZE - totalBytes(got)}`);

  const lost = [BASE + 2 * RETRY_SIZE, RETRY_SIZE];
  check('and the block that is lost is exactly the one containing it',
    !got.some(([b]) => b === lost[0])
    && got.map(([b]) => b).join(',')
       === [BASE, BASE + RETRY_SIZE, BASE + 3 * RETRY_SIZE].join(','),
    `yielded at ${got.map(([b]) => '0x' + b.toString(16)).join(' ')}`);

  // For scale: without the retry this same region yielded nothing at all, so
  // the checks above account for 192 KB that used to be dropped. Left as a
  // note rather than a check -- asserting it would only assert arithmetic on
  // two constants defined in this file, and could never fail.

  // A region no larger than one retry block has nothing to subdivide into, so
  // it must not spin: one failed read, one give-up, no retry pass.
  const small = stubProc(BASE, RETRY_SIZE, BASE);
  const smallGot = covered(small);
  check('a region at or under the retry size is not subdivided',
    smallGot.length === 0 && small.reads.length === 1,
    `${small.reads.length} read(s), ${smallGot.length} chunk(s)`);

  // A region larger than CHUNK_SIZE still splits on CHUNK_SIZE first, and a
  // failure in one chunk must not touch the other.
  const big = stubProc(BASE, CHUNK_SIZE + RETRY_SIZE, BASE + 0x1000);
  const bigGot = covered(big);
  check('a failure in one chunk leaves the next chunk untouched',
    bigGot.some(([b, n]) => b === BASE + CHUNK_SIZE && n === RETRY_SIZE),
    `yielded ${bigGot.length} range(s), ${totalBytes(bigGot)} bytes`);

  return failures;
}

module.exports = { main };

if (require.main === module) process.exit(main() ? 1 : 0);
