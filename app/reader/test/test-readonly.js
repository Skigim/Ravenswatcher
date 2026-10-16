'use strict';
// The read-only constraint, checked three ways.
//
// 1. Source audit: no write/inject primitive is bound in any reader module.
// 2. The access mask openProcess() actually passes is exactly
//    PROCESS_QUERY_INFORMATION | PROCESS_VM_READ (0x0410).
// 3. Negative test: with a handle from openProcess(), WriteProcessMemory
//    must FAIL with ERROR_ACCESS_DENIED. The target is this test's own
//    process and its own buffer, and the assertion is that the buffer is
//    unchanged afterwards. Nothing else is attached to.

const fs = require('fs');
const path = require('path');
const koffi = require('koffi');
const win32 = require('../win32');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

const FORBIDDEN = [
  'WriteProcessMemory', 'VirtualAllocEx', 'VirtualProtectEx', 'VirtualFreeEx',
  'CreateRemoteThread', 'NtWriteVirtualMemory', 'SetThreadContext',
  'PROCESS_VM_WRITE', 'PROCESS_VM_OPERATION', 'PROCESS_ALL_ACCESS',
  'PROCESS_CREATE_THREAD', 'DebugActiveProcess', 'AdjustTokenPrivileges',
  'SeDebugPrivilege',
];

function main() {
  console.log('\ntest-readonly: read-only memory access');

  // The modules sit in app/reader/ itself; test/ and bench/ are siblings
  // and are deliberately not audited -- they are not shipped.
  const srcDir = path.join(__dirname, '..');
  const hits = [];
  for (const f of fs.readdirSync(srcDir)) {
    if (!f.endsWith('.js')) continue;
    if (!f.endsWith('.js')) continue;
    // Comments are stripped first: win32.js's own header says in prose that
    // there is no WriteProcessMemory binding, and a naive substring scan
    // would flag that sentence as the thing it is denying.
    const code = fs.readFileSync(path.join(srcDir, f), 'utf8')
      // CRLF first, and not cosmetically: a carriage return is a line
      // terminator in a JS regex, so `.` cannot match one and the `//.*$`
      // below stops dead before it -- leaving every line comment in a CRLF
      // file intact. The audit then reads this module's own header prose
      // ("no WriteProcessMemory binding, no VirtualAllocEx...") as bindings
      // and fails a file that is clean. The repo checks out with
      // core.autocrlf=true, so any git operation that rewrites a working
      // file (a checkout, a stash pop) can leave it in that state.
      .replace(/\r\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
    for (const bad of FORBIDDEN) {
      if (code.includes(bad)) hits.push(`${f}: ${bad}`);
    }
  }
  check('reader modules bind no write, inject, or privilege-escalation primitive (comments stripped)',
    hits.length === 0, hits.join('; '));

  check('the only access mask is PROCESS_QUERY_INFORMATION | PROCESS_VM_READ',
    win32.READ_ONLY_ACCESS === 0x0410
    && win32.PROCESS_QUERY_INFORMATION === 0x0400
    && win32.PROCESS_VM_READ === 0x0010,
    `0x${win32.READ_ONLY_ACCESS.toString(16)}`);

  check('openProcess() takes no access-mask parameter a caller could widen',
    win32.openProcess.length === 1, `arity ${win32.openProcess.length}`);

  // --- negative test ------------------------------------------------------
  const k32 = koffi.load('kernel32.dll');
  const WriteProcessMemory = k32.func('__stdcall', 'WriteProcessMemory', 'bool',
    ['void *', 'size_t', 'void *', 'size_t', koffi.out(koffi.pointer('size_t'))]);
  const GetLastError = k32.func('__stdcall', 'GetLastError', 'uint32', []);

  const victim = win32.scratch(64);
  victim.dv.setUint32(0, 0x11223344, true);
  const payload = win32.scratch(4);
  payload.dv.setUint32(0, 0xdeadbeef, true);

  const proc = win32.openProcess(process.pid);
  const wrote = [0];
  const ok = WriteProcessMemory(proc.handle, Number(koffi.address(victim.ptr)),
    payload.ptr, 4, wrote);
  const err = ok ? 0 : GetLastError();
  const after = victim.dv.getUint32(0, true);
  proc.close();

  check('WriteProcessMemory through our handle is refused',
    ok === false && err === 5 /* ERROR_ACCESS_DENIED */,
    `returned ${ok}, GetLastError=${err}`);
  check('the target bytes are unchanged', after === 0x11223344,
    `0x${after.toString(16)}`);

  // And the read path still works through the same handle.
  const proc2 = win32.openProcess(process.pid);
  const readBack = proc2.readI32(Number(koffi.address(victim.ptr)));
  proc2.close();
  check('the same read-only handle can still read', readBack === 0x11223344,
    `0x${(readBack >>> 0).toString(16)}`);

  // moduleBase reads szExePath out of the same MODULEENTRY32W buffer it
  // already fills. Our own process is the control: Node knows its exe path.
  const mod = win32.moduleBase(process.pid);
  check('moduleBase returns the exe path',
    typeof mod.exePath === 'string' && mod.exePath.toLowerCase() === process.execPath.toLowerCase(),
    `${mod.exePath} vs ${process.execPath}`);

  return failures;
}

if (require.main === module) process.exit(main() ? 1 : 0);
module.exports = { main };
