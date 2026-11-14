'use strict';
// The Linux backend against real procfs: our own process, and a child.
// Linux-only -- run-all.js must not run it elsewhere.

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { linuxBackend } = require('../linux');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  assert.strictEqual(linuxBackend.platform, 'linux');

  // Own process: find a marker through regions() + readInto().
  const marker = crypto.randomBytes(32);
  marker.writeInt32LE(-12345, 4);
  const self = linuxBackend.open(process.pid);
  assert.strictEqual(self.isAlive(), true);
  let found = null;
  const chunk = Buffer.alloc(1 << 20);
  let prev = -1;
  for (const [base, size] of self.regions(true)) {
    assert.ok(base > prev, 'regions ascend');
    prev = base;
    for (let off = 0; off < size && found === null; off += chunk.length - 32) {
      const n = self.readInto(base + off, chunk, Math.min(chunk.length, size - off));
      const at = n ? chunk.subarray(0, n).indexOf(marker) : -1;
      // The scan buffer may hold a copy too; only accept a hit that reads back.
      if (at >= 0 && self.read(base + off + at, 32).equals(marker)) found = base + off + at;
    }
    if (found !== null) break;
  }
  assert.notStrictEqual(found, null, 'marker located');
  assert.ok(self.read(found, 32).equals(marker));
  assert.strictEqual(self.readI32(found + 4), -12345);
  assert.strictEqual(self.readPtr(found), marker.readUInt32LE(0) + marker.readUInt32LE(4) * 4294967296);
  assert.strictEqual(self.readInto(0x1000, Buffer.alloc(8), 8), 0);
  assert.strictEqual(self.read(0x1000, 8), null);
  assert.strictEqual(self.readI32(0x1000), null);
  assert.strictEqual(self.readPtr(0x1000), null);
  self.close();
  self.close();
  assert.strictEqual(self.isAlive(), false, 'a closed handle is not alive');

  // A child process: discovery, module info, death.
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    await sleep(200);
    assert.ok(linuxBackend.findProcesses('sleep').some((c) => c.pid === child.pid));
    const mod = linuxBackend.moduleInfo(child.pid);
    assert.strictEqual(path.basename(mod.exePath), 'sleep');
    assert.ok(mod.base > 0 && mod.size > 0);
    const h = linuxBackend.open(child.pid);
    assert.strictEqual(h.isAlive(), true);
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    await sleep(100);
    assert.strictEqual(h.isAlive(), false, 'a dead child is not alive');
    h.close();
    h.close();
  } finally {
    child.kill('SIGKILL');
  }

  console.log('test-linux-backend: ok');
  return 0;
}

module.exports = { main };
if (require.main === module) main().then(process.exit, (e) => { console.error(e); process.exit(1); });
