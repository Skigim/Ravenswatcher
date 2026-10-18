'use strict';
// Probe: does koffi give us what the reader needs?
//  1. numeric (Number, not BigInt) addresses via size_t / uintptr_t
//  2. a zero-copy scratch buffer we can hand to ReadProcessMemory and then
//     scan as a Uint32Array without any marshalling copy
//  3. read-only OpenProcess against our own PID
const koffi = require('koffi');
console.log('koffi', koffi.version, 'node', process.version);
console.log('exports:', Object.keys(koffi).sort().join(' '));

const k32 = koffi.load('kernel32.dll');

const OpenProcess = k32.func('__stdcall', 'OpenProcess', 'void *', ['uint32', 'bool', 'uint32']);
const CloseHandle = k32.func('__stdcall', 'CloseHandle', 'bool', ['void *']);
const GetCurrentProcessId = k32.func('__stdcall', 'GetCurrentProcessId', 'uint32', []);
const ReadProcessMemory = k32.func('__stdcall', 'ReadProcessMemory', 'bool',
  ['void *', 'size_t', 'void *', 'size_t', koffi.out(koffi.pointer('size_t'))]);

const PROCESS_QUERY_INFORMATION = 0x0400;
const PROCESS_VM_READ = 0x0010;

const pid = GetCurrentProcessId();
const h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
console.log('own pid', pid, 'handle', h ? 'ok' : 'NULL');

// A source buffer with a known marker, and its address.
const src = Buffer.alloc(4096);
src.write('RAVENSWATCH-PROBE', 0);
const srcAddr = koffi.address(src);
console.log('koffi.address(Buffer) ->', typeof srcAddr, srcAddr, '(Number.isSafeInteger:',
  typeof srcAddr === 'number' ? Number.isSafeInteger(srcAddr) : Number.isSafeInteger(Number(srcAddr)), ')');

// Zero-copy scratch: koffi.alloc gives external memory, koffi.view exposes it
// as an ArrayBuffer WITHOUT copying.
const SIZE = 64 * 1024 * 1024;
const scratchPtr = koffi.alloc('uint8', SIZE);
const view = koffi.view(scratchPtr, SIZE);
console.log('koffi.view ->', view && view.constructor && view.constructor.name, view && view.byteLength);

const got = [0];
const ok = ReadProcessMemory(h, Number(srcAddr), scratchPtr, 4096, got);
console.log('RPM own memory:', ok, 'bytesRead', got[0]);
const u8 = new Uint8Array(view instanceof ArrayBuffer ? view : view.buffer, 0, 32);
console.log('first bytes:', Buffer.from(u8).toString('latin1').replace(/\0+$/, ''));

CloseHandle(h);
