'use strict';
// Win32 bindings for the reader, via koffi (pure-JS FFI over prebuilt
// Node-API binaries -- no node-gyp, no per-Electron-ABI rebuild).
//
// READ-ONLY BY CONSTRUCTION. The only process access mask this module can
// produce is PROCESS_QUERY_INFORMATION | PROCESS_VM_READ. There is no
// WriteProcessMemory binding, no VirtualAllocEx, no CreateRemoteThread, and
// openProcess() takes no access argument, so no caller can widen it.
//
// Addresses are plain JS Numbers. Windows x64 user-mode addresses top out
// below 2^47, well inside Number.MAX_SAFE_INTEGER (2^53), so nothing here
// needs BigInt -- which matters, because BigInt in the scan loop costs ~4x
// (see bench/scan-bench.js).

const koffi = require('koffi');

const k32 = koffi.load('kernel32.dll');

const PROCESS_QUERY_INFORMATION = 0x0400;
const PROCESS_VM_READ = 0x0010;
const READ_ONLY_ACCESS = PROCESS_QUERY_INFORMATION | PROCESS_VM_READ;

const MEM_COMMIT = 0x1000;
const PAGE_NOACCESS = 0x01;
const PAGE_GUARD = 0x100;
// Same set discover_values.iter_regions() calls writable.
const WRITABLE = new Set([0x04, 0x08, 0x40, 0x80]);

// GetExitCodeProcess reports a still-running process as this pseudo-code.
// It is only readable through PROCESS_QUERY_INFORMATION, which the read-only
// mask above already carries -- no wider access is needed to ask whether the
// target is alive.
const STILL_ACTIVE = 259;

const TH32CS_SNAPPROCESS = 0x00000002;
const TH32CS_SNAPMODULE = 0x00000008;
const TH32CS_SNAPMODULE32 = 0x00000010;
const INVALID_HANDLE_VALUE = 0xFFFFFFFFFFFFFFFFn;

const OpenProcess = k32.func('__stdcall', 'OpenProcess', 'void *', ['uint32', 'bool', 'uint32']);
const CloseHandle = k32.func('__stdcall', 'CloseHandle', 'bool', ['void *']);
const GetLastError = k32.func('__stdcall', 'GetLastError', 'uint32', []);
const ReadProcessMemory = k32.func('__stdcall', 'ReadProcessMemory', 'bool',
  ['void *', 'size_t', 'void *', 'size_t', koffi.out(koffi.pointer('size_t'))]);
const GetExitCodeProcess = k32.func('__stdcall', 'GetExitCodeProcess', 'bool',
  ['void *', koffi.out(koffi.pointer('uint32'))]);
const VirtualQueryEx = k32.func('__stdcall', 'VirtualQueryEx', 'size_t',
  ['void *', 'size_t', 'void *', 'size_t']);
const CreateToolhelp32Snapshot = k32.func('__stdcall', 'CreateToolhelp32Snapshot', 'void *',
  ['uint32', 'uint32']);
const Process32FirstW = k32.func('__stdcall', 'Process32FirstW', 'bool', ['void *', 'void *']);
const Process32NextW = k32.func('__stdcall', 'Process32NextW', 'bool', ['void *', 'void *']);
const Module32FirstW = k32.func('__stdcall', 'Module32FirstW', 'bool', ['void *', 'void *']);

/** CreateToolhelp32Snapshot signals failure with INVALID_HANDLE_VALUE (-1),
 *  not NULL, and koffi hands that back as a non-null external pointer. */
function isRealHandle(h) {
  return !!h && koffi.address(h) !== INVALID_HANDLE_VALUE;
}

// --- scratch buffers -------------------------------------------------------
// A plain Node Buffer, NOT koffi.alloc + koffi.view.
//
// koffi.view() wraps external memory in an ArrayBuffer via
// napi_create_external_arraybuffer. Node allows that; Electron does not --
// its V8 sandbox rejects external backing stores, and the failure is not an
// exception you can catch but a hard `FATAL ERROR: Error::New
// napi_get_last_error_info` that kills the process. It reproduces on the
// first view() call under both the dev electron binary and the packaged app,
// on koffi 2.16.3 and 3.1.6 alike, while plain `node` runs the same code
// fine. Since this reader exists to run inside Electron, view() is
// unavailable here regardless of what it does elsewhere.
//
// A Buffer costs nothing to substitute: koffi passes a Buffer or TypedArray
// to a `void *` parameter as its data pointer, so ReadProcessMemory still
// writes straight into the memory the scan loop reads, with no marshalling
// copy. Measured after the swap, throughput was unchanged.
//
// allocUnsafeSlow, not allocUnsafe: pooled Buffers share one ArrayBuffer at a
// non-zero byteOffset, and every view below would silently address the wrong
// slice of the pool.
function scratch(size) {
  const buf = Buffer.allocUnsafeSlow(size);
  const ab = buf.buffer;
  return {
    ptr: buf, ab, size,
    u8: new Uint8Array(ab, buf.byteOffset, size),
    dv: new DataView(ab, buf.byteOffset, size),
  };
}

// MEMORY_BASIC_INFORMATION (x64): BaseAddress 0x00, AllocationBase 0x08,
// AllocationProtect 0x10, PartitionId 0x14, RegionSize 0x18, State 0x20,
// Protect 0x24, Type 0x28. sizeof == 0x30.
const MBI_SIZE = 0x30;
const _mbi = scratch(MBI_SIZE);
const _read = [0];

class Process {
  constructor(handle, pid) {
    this.handle = handle;
    this.pid = pid;
    this._closed = false;
  }

  close() {
    if (!this._closed) { CloseHandle(this.handle); this._closed = true; }
  }

  /**
   * Is the process this handle names still running?
   *
   * A handle does not go stale when its process exits -- that is the whole
   * point of a handle -- so nothing about the read path notices the game
   * closing. ReadProcessMemory simply starts failing, and every read here
   * turns failure into `null`, which is indistinguishable from "the sweep
   * has not resolved this address yet". Hence an explicit question rather
   * than inferring death from a run of nulls.
   *
   * STILL_ACTIVE is 259, so a process that genuinely exits with code 259
   * reads as alive. That is the documented ambiguity of this API and it is
   * accepted here: the fallback is exactly today's behaviour (poll a dead
   * handle and report nothing), and the game does not exit with 259.
   */
  isAlive() {
    if (this._closed) return false;
    const code = [0];
    // A failed call means the handle can no longer answer for the process --
    // treat that as gone rather than guessing it is still there.
    if (!GetExitCodeProcess(this.handle, code)) return false;
    return code[0] === STILL_ACTIVE;
  }

  /** Raw read into caller-provided external memory. Returns bytes read. */
  readInto(addr, dstPtr, size) {
    _read[0] = 0;
    const ok = ReadProcessMemory(this.handle, addr, dstPtr, size, _read);
    return ok ? _read[0] : 0;
  }

  /**
   * Read `size` bytes as a Buffer, or null. Mirrors discover_values.read_mem.
   *
   * Goes through a shared scratch buffer rather than allocating per call: a
   * single index build does two of these per settings instance (the name
   * field, then the string it points at), which is ~900 reads a sweep at the
   * ~434 instances the game is documented to have. The result is always
   * copied out, so reusing the scratch across calls cannot alias.
   */
  read(addr, size) {
    if (size > _readScratch.size) {
      const s = scratch(size);
      const n = this.readInto(addr, s.ptr, size);
      return n ? Buffer.from(s.u8.subarray(0, n)) : null;
    }
    const n = this.readInto(addr, _readScratch.ptr, size);
    if (!n) return null;
    return Buffer.from(_readScratch.u8.subarray(0, n));
  }

  /** uint64 at addr as a Number, or null. Mirrors read_ptr. */
  readPtr(addr) {
    const n = this.readInto(addr, _ptr8.ptr, 8);
    if (n < 8) return null;
    const lo = _ptr8.dv.getUint32(0, true);
    const hi = _ptr8.dv.getUint32(4, true);
    return hi * 4294967296 + lo;
  }

  /** int32 at addr, or null. Mirrors read_i32. */
  readI32(addr) {
    const n = this.readInto(addr, _ptr8.ptr, 4);
    if (n < 4) return null;
    return _ptr8.dv.getInt32(0, true);
  }

  /**
   * Committed, readable regions. `writableOnly` restricts to the writable
   * protection set -- heap objects only live there,
   * and including image-backed pages faults them in from disk for zero
   * additional hits.
   */
  *regions(writableOnly = false) {
    let address = 0;
    const LIMIT = 0x7FFFFFFFFFFF;
    while (address < LIMIT) {
      const ret = VirtualQueryEx(this.handle, address, _mbi.ptr, MBI_SIZE);
      if (ret === 0) break;
      const baseLo = _mbi.dv.getUint32(0x00, true);
      const baseHi = _mbi.dv.getUint32(0x04, true);
      const base = baseHi * 4294967296 + baseLo;
      const sizeLo = _mbi.dv.getUint32(0x18, true);
      const sizeHi = _mbi.dv.getUint32(0x1c, true);
      const size = sizeHi * 4294967296 + sizeLo;
      if (size === 0) break;
      const state = _mbi.dv.getUint32(0x20, true);
      const protect = _mbi.dv.getUint32(0x24, true);
      const okState = state === MEM_COMMIT
        && !(protect & PAGE_NOACCESS) && !(protect & PAGE_GUARD);
      const okWrite = writableOnly ? WRITABLE.has(protect) : true;
      if (okState && okWrite) yield [base, size];
      address = base + size;
    }
  }
}

const _ptr8 = scratch(16);
// Big enough for rtti.js's 4 MB section chunks, so even the RTTI resolve
// never allocates per read.
const _readScratch = scratch(8 * 1024 * 1024);

/** Read-only open. There is deliberately no access-mask parameter. */
function openProcess(pid) {
  const h = OpenProcess(READ_ONLY_ACCESS, false, pid);
  if (!h) throw new Error(`OpenProcess(${pid}) failed, GetLastError=${GetLastError()}`);
  return new Process(h, pid);
}

// PROCESSENTRY32W (x64): dwSize 0x00, th32ProcessID 0x08, szExeFile 0x2C.
const PE32_SIZE = 568;
const PE32_EXE_OFF = 0x2c;

/** Every PID whose image name matches, case-insensitively. */
function findPids(exeName) {
  const snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (!isRealHandle(snap)) throw new Error('CreateToolhelp32Snapshot failed');
  const s = scratch(PE32_SIZE);
  s.dv.setUint32(0, PE32_SIZE, true);
  const target = exeName.toLowerCase();
  const pids = [];
  try {
    let ok = Process32FirstW(snap, s.ptr);
    while (ok) {
      let end = PE32_EXE_OFF;
      while (end < PE32_SIZE - 1 && s.dv.getUint16(end, true) !== 0) end += 2;
      const name = Buffer.from(s.u8.subarray(PE32_EXE_OFF, end)).toString('utf16le');
      if (name.toLowerCase() === target) pids.push(s.dv.getUint32(0x08, true));
      s.dv.setUint32(0, PE32_SIZE, true);
      ok = Process32NextW(snap, s.ptr);
    }
  } finally {
    CloseHandle(snap);
  }
  return pids;
}

/**
 * The one running copy's PID. Refuses rather than guessing when zero or
 * several are running -- same contract as discover_values.find_pid().
 */
function findPid(exeName) {
  const pids = findPids(exeName);
  if (!pids.length) {
    const err = new Error(`${exeName} is not running -- start the game first, or pass a PID explicitly`);
    // Tagged, not matched on by message: stdio.js exits with a distinct
    // status for this case so the supervisor can retry at a steady cadence
    // instead of backing off as it would for a genuine fault. Note that the
    // several-copies-running error below is deliberately NOT tagged -- that
    // one needs a human, and retrying it every couple of seconds forever
    // would just be noise.
    err.code = 'ENOGAME';
    throw err;
  }
  if (pids.length > 1) {
    throw new Error(`more than one ${exeName} is running (${pids.join(', ')}) -- pass the PID you want explicitly`);
  }
  return pids[0];
}

// MODULEENTRY32W (x64): dwSize 0x00, modBaseAddr 0x18, modBaseSize 0x20,
// szExePath 0x230 (WCHAR[MAX_PATH], null-terminated).
const ME32_SIZE = 1080;
const ME32_EXE_PATH_OFF = 0x230;

/**
 * {base, size, exePath} of the process's main module.
 *
 * The toolhelp snapshot gives both base and size with no subprocess -- the
 * first module a MODULE snapshot enumerates is always the executable itself. The same entry
 * carries the executable's full path, which is how the app finds the game's
 * install directory without a second API call.
 */
function moduleBase(pid) {
  const snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
  if (!isRealHandle(snap)) {
    throw new Error(`could not read the module base for PID ${pid} -- check the PID, `
      + 'or omit it to find the game automatically');
  }
  const s = scratch(ME32_SIZE);
  s.dv.setUint32(0, ME32_SIZE, true);
  try {
    if (!Module32FirstW(snap, s.ptr)) {
      throw new Error(`could not read the module base for PID ${pid} -- `
        + 'the process may have exited while we looked');
    }
    const lo = s.dv.getUint32(0x18, true);
    const hi = s.dv.getUint32(0x1c, true);
    let end = ME32_EXE_PATH_OFF;
    while (end + 1 < ME32_SIZE && (s.u8[end] || s.u8[end + 1])) end += 2;
    const exePath = Buffer.from(s.u8.subarray(ME32_EXE_PATH_OFF, end)).toString('utf16le');
    return { base: hi * 4294967296 + lo, size: s.dv.getUint32(0x20, true), exePath };
  } finally {
    CloseHandle(snap);
  }
}

module.exports = {
  koffi,
  scratch,
  openProcess,
  findPid,
  findPids,
  moduleBase,
  READ_ONLY_ACCESS,
  PROCESS_QUERY_INFORMATION,
  PROCESS_VM_READ,
  STILL_ACTIVE,
  MBI_SIZE,
  PE32_SIZE,
  ME32_SIZE,
};
