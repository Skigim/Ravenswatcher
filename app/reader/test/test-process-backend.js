'use strict';
// The reader layer against a fake ProcessBackend: in-memory memory, readable
// regions, a partial read, a dead process. Portable: nothing here touches an
// OS process, kernel32 or koffi, so it runs on every platform.
//
// Reader takes the backend as an option and can skip its worker threads
// (spawnWorkers: false); workers open the process through getProcessBackend()
// on their own thread and are covered by the Windows-only suites.

const assert = require('assert');
const { Reader, resolvePid } = require('../reader');
const { getProcessBackend } = require('../backend');

const BASE = 0x10000;
const SIZE = 0x100;
const GAME = 'Ravenswatch.exe';

/** A backend over one in-memory image. Records every call that matters. */
function fakeBackend({ candidates = [{ pid: 4242 }], image, moduleError = null } = {}) {
  const memory = image ?? Buffer.alloc(SIZE);
  const log = { opened: [], closed: 0 };
  const state = { alive: true };
  const handle = {
    pid: candidates[0] ? candidates[0].pid : 0,
    isAlive: () => state.alive,
    *regions() { yield [BASE, SIZE]; },
    readInto(addr, dst, size) {
      const off = addr - BASE;
      if (off < 0 || off >= SIZE) return 0;
      const n = Math.min(size, SIZE - off);
      memory.copy(dst, 0, off, off + n);
      return n;
    },
    read(addr, size) {
      const off = addr - BASE;
      if (off < 0 || off >= SIZE) return null;
      return Buffer.from(memory.subarray(off, Math.min(off + size, SIZE)));
    },
    readPtr(addr) {
      const b = handle.read(addr, 8);
      return b && b.length === 8 ? Number(b.readBigUInt64LE(0)) : null;
    },
    readI32(addr) {
      const b = handle.read(addr, 4);
      return b && b.length === 4 ? b.readInt32LE(0) : null;
    },
    close() { log.closed++; },
  };
  const backend = {
    platform: 'win32',
    findProcesses: (name) => (name === GAME ? candidates : []),
    moduleInfo(pid) {
      if (moduleError) throw moduleError;
      return { base: BASE, size: SIZE, exePath: '/games/ravenswatch/' + GAME };
    },
    open(pid) { log.opened.push(pid); return handle; },
  };
  return { backend, handle, state, log, memory };
}

async function main() {
  // Discovery: none is tagged, several is not, one is the answer.
  assert.throws(() => resolvePid(fakeBackend({ candidates: [] }).backend, GAME),
    (e) => e.code === 'ENOGAME' && /not running/.test(e.message));
  assert.throws(() => resolvePid(fakeBackend({ candidates: [{ pid: 1 }, { pid: 2 }] }).backend, GAME),
    (e) => e.code === undefined && /more than one/.test(e.message) && /1, 2/.test(e.message));
  assert.strictEqual(resolvePid(fakeBackend({ candidates: [{ pid: 77 }] }).backend, GAME), 77);

  // An unsupported platform has no backend, tagged so callers can tell.
  assert.throws(() => getProcessBackend('darwin'), (e) => e.code === 'EUNSUPPORTED');
  assert.strictEqual(getProcessBackend('linux').platform, 'linux');

  // Attach: identity comes from moduleInfo, the handle from open().
  const f = fakeBackend({ candidates: [{ pid: 4242 }] });
  const reader = new Reader(null, { backend: f.backend, spawnWorkers: false });
  assert.strictEqual(reader.pid, 4242);
  assert.strictEqual(reader.base, BASE);
  assert.ok(reader.exePath.endsWith(GAME));
  assert.deepStrictEqual(f.log.opened, [4242]);
  assert.strictEqual(reader.worker, null, 'no workers when told not to spawn them');

  // Reads through the reader: a real value, a real zero, and unreadable -> null.
  f.memory.fill(0);
  for (let i = 0; i < SIZE; i += 4) f.memory.writeInt32LE(7, i);
  reader.resolved = { 'Hero Level': { binding_addr: BASE, variant: 'inline', is_float: false } };
  assert.strictEqual(reader.get('Hero Level'), 7);
  f.memory.fill(0);
  assert.strictEqual(reader.get('Hero Level'), 0, 'a real zero stays 0');
  assert.strictEqual(reader.get('Never Resolved'), null, 'unresolved is null, not 0');
  reader.resolved = { 'Off Image': { binding_addr: BASE + 0x10000, variant: 'inline', is_float: false } };
  assert.strictEqual(reader.get('Off Image'), null, 'an unreadable address is null, not 0');

  // A partial read is shorter than asked for; fixed-width reads refuse it.
  f.memory.fill(0xff);
  const tail = f.handle.read(BASE + SIZE - 2, 8);
  assert.strictEqual(tail.length, 2);
  assert.strictEqual(f.handle.readI32(BASE + SIZE - 2), null);
  assert.strictEqual(f.handle.readPtr(BASE + SIZE - 4), null);
  const into = Buffer.alloc(16);
  assert.strictEqual(f.handle.readInto(BASE + SIZE - 3, into, 16), 3);
  assert.strictEqual(f.handle.readInto(BASE - 8, into, 8), 0);
  assert.deepStrictEqual([...f.handle.regions()], [[BASE, SIZE]]);

  // A dead process: the handle stays usable, only alive() says so.
  assert.strictEqual(reader.alive(), true);
  f.state.alive = false;
  assert.strictEqual(reader.alive(), false);

  // close() releases the handle once, however often it is asked.
  const first = reader.close();
  assert.strictEqual(reader.close(), first, 'a second close returns the same promise');
  await first;
  assert.strictEqual(f.log.closed, 1);

  // Attach failures surface from the constructor untouched.
  const boom = new Error('could not read the module base for PID 5');
  assert.throws(() => new Reader(5, { backend: fakeBackend({ moduleError: boom }).backend, spawnWorkers: false }),
    (e) => e === boom);
  assert.throws(() => new Reader(null, { backend: fakeBackend({ candidates: [] }).backend, spawnWorkers: false }),
    (e) => e.code === 'ENOGAME');

  console.log('test-process-backend: ok');
  return 0;
}

module.exports = { main };
if (require.main === module) main().then(process.exit, (e) => { console.error(e); process.exit(1); });
