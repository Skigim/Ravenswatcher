'use strict';
// The Linux backend against real procfs: our own process, a child, and a
// process that is not our descendant (the ptrace_scope case).
// Linux-only -- run-all.js must not run it elsewhere.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn, spawnSync } = require('child_process');
const { linuxBackend } = require('../linux');
const { EXIT_NO_PERMISSION } = require('../stdio');

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

  // A process that is NOT our descendant, which is how the game relates to
  // this app. Yama's ptrace_scope decides whether we may read it: 0 allows it,
  // 1 (Ubuntu's default) and above refuse. sh backgrounds sleep and exits, so
  // sleep is reparented away from us.
  let scope = 0;
  try { scope = Number(fs.readFileSync('/proc/sys/kernel/yama/ptrace_scope', 'utf8').trim()); } catch { /* no Yama */ }
  console.log(`  ptrace_scope: ${scope}`);
  const orphan = Number(execFileSync('sh', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).trim());
  try {
    await sleep(200);
    const ppid = Number(fs.readFileSync(`/proc/${orphan}/stat`, 'utf8').split(') ')[1].split(' ')[1]);
    assert.notStrictEqual(ppid, process.pid, 'the orphan is not our child');
    // Reading the memory map is not an attach, so Yama allows it at any scope.
    const mod = linuxBackend.moduleInfo(orphan);
    if (scope === 0) {
      const h = linuxBackend.open(orphan);
      assert.strictEqual(h.readI32(mod.base), 0x464c457f, 'reads the ELF header');
      h.close();
    } else {
      assert.throws(() => linuxBackend.open(orphan), (e) => e.code === 'EPERMISSION' && /ptrace_scope/.test(e.message),
        'a refused attach is EPERMISSION and names ptrace_scope');
      // The reader turns that into its own exit status, which the sidecar
      // retries slowly instead of hammering.
      const res = spawnSync(process.execPath, [path.join(__dirname, '..', 'stdio.js'), String(orphan)],
        { encoding: 'utf8', timeout: 15000 });
      assert.strictEqual(res.status, EXIT_NO_PERMISSION, `reader exit status (stderr: ${res.stderr.trim()})`);
      assert.match(res.stderr, /permission denied/);
    }
  } finally {
    try { process.kill(orphan, 'SIGKILL'); } catch { /* already gone */ }
  }

  console.log('test-linux-backend: ok');
  return 0;
}

module.exports = { main };
if (require.main === module) main().then(process.exit, (e) => { console.error(e); process.exit(1); });
