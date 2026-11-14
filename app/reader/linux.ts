// Linux ProcessBackend: reads the Windows game (running under Proton/Wine)
// through procfs with Node's fs alone -- no FFI, no new dependency.
//
// READ-ONLY BY CONSTRUCTION. /proc/<pid>/mem is opened 'r' and nothing here
// opens it for writing.
//
// Addresses are plain JS Numbers; Wine's game address space is far below 2^53.

import * as fs from 'fs';
import {
  DEFAULT_PROC_ROOT, findPids, moduleFromMaps, parseMaps, procStartTime, procState,
} from './procfs';
import type {
  MemoryRegion, ModuleInfo, ProcessBackend, ProcessCandidate, ProcessErrorCode, ProcessHandle,
} from './process';

const SKIP_PATHS = new Set(['[vvar]', '[vvar_vclock]', '[vsyscall]']);

function isDenied(e: unknown): boolean {
  const code = typeof e === 'object' && e !== null && 'code' in e ? e.code : undefined;
  return code === 'EACCES' || code === 'EPERM';
}

function permissionError(what: string, pid: number, cause: unknown): Error {
  return Object.assign(
    new Error(`permission denied ${what} for PID ${pid} -- the kernel's ptrace_scope `
      + '(kernel.yama.ptrace_scope) forbids reading another process; launch this app from '
      + 'the same launch wrapper as the game, or relax ptrace_scope', { cause }),
    { code: 'EPERMISSION' satisfies ProcessErrorCode },
  );
}

function readStat(pid: number): string | null {
  try { return fs.readFileSync(`${DEFAULT_PROC_ROOT}/${pid}/stat`, 'latin1'); } catch { return null; }
}

export class LinuxProcess implements ProcessHandle {
  readonly pid: number;
  private fd: number;
  private readonly startTime: string | null;
  private _closed = false;

  constructor(fd: number, pid: number, startTime: string | null) {
    this.fd = fd;
    this.pid = pid;
    this.startTime = startTime;
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    try { fs.closeSync(this.fd); } catch { /* already gone */ }
  }

  /** Alive unless closed, vanished, zombie/dead, or the pid was reused. */
  isAlive(): boolean {
    try {
      if (this._closed) return false;
      const stat = readStat(this.pid);
      if (stat === null) return false;
      const state = procState(stat);
      if (state === 'Z' || state === 'X') return false;
      return this.startTime === null || procStartTime(stat) === this.startTime;
    } catch {
      return false;
    }
  }

  /** Raw read into caller memory. Any failure (EIO, EFAULT, ...) is 0 bytes. */
  readInto(addr: number, dst: Buffer, size: number): number {
    if (this._closed) return 0;
    try {
      return fs.readSync(this.fd, dst, 0, size, addr);
    } catch {
      return 0;
    }
  }

  /**
   * All or nothing, like ReadProcessMemory: a read that pread cuts short at
   * an unmapped page is null. The struct readers index into the result
   * without checking its length, because on Windows it never comes back short.
   */
  read(addr: number, size: number): Buffer | null {
    const buf = Buffer.allocUnsafe(size);
    const n = this.readInto(addr, buf, size);
    return n === size && n > 0 ? buf : null;
  }

  readPtr(addr: number): number | null {
    const b = this.read(addr, 8);
    if (!b || b.length < 8) return null;
    return b.readUInt32LE(4) * 4294967296 + b.readUInt32LE(0);
  }

  readI32(addr: number): number | null {
    const b = this.read(addr, 4);
    if (!b || b.length < 4) return null;
    return b.readInt32LE(0);
  }

  *regions(writableOnly = false): Generator<MemoryRegion, void, undefined> {
    let text: string;
    try {
      text = fs.readFileSync(`${DEFAULT_PROC_ROOT}/${this.pid}/maps`, 'latin1');
    } catch {
      return;
    }
    const maps = parseMaps(text).sort((a, b) => a.start - b.start);
    for (const m of maps) {
      if (m.perms[0] !== 'r') continue;
      if (writableOnly && m.perms[1] !== 'w') continue;
      if (SKIP_PATHS.has(m.path)) continue;
      const size = m.end - m.start;
      if (size > 0) yield [m.start, size];
    }
  }
}

/** Read-only open. There is deliberately no access-mode parameter. */
export function openProcess(pid: number): LinuxProcess {
  let fd: number;
  try {
    fd = fs.openSync(`${DEFAULT_PROC_ROOT}/${pid}/mem`, 'r');
  } catch (e) {
    if (isDenied(e)) throw permissionError('opening memory', pid, e);
    throw e;
  }
  const stat = readStat(pid);
  let start: string | null = null;
  try { start = stat === null ? null : procStartTime(stat); } catch { /* leave unchecked */ }
  return new LinuxProcess(fd, pid, start);
}

/** Image names this process might be known by: argv[0], comm, the exe link. */
function candidateNames(pid: number): string[] {
  const names: string[] = [];
  const base = (p: string): string => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
  const add = (n: string): void => { if (n && !names.includes(n)) names.push(n); };
  try { add(base(fs.readFileSync(`${DEFAULT_PROC_ROOT}/${pid}/cmdline`, 'latin1').split('\0')[0] ?? '')); } catch { /* gone */ }
  try { add(fs.readFileSync(`${DEFAULT_PROC_ROOT}/${pid}/comm`, 'latin1').trim()); } catch { /* gone */ }
  try { add(base(fs.readlinkSync(`${DEFAULT_PROC_ROOT}/${pid}/exe`))); } catch { /* gone or denied */ }
  return names;
}

/**
 * Main image of `pid`. The contract passes no name, so it is derived from the
 * process itself: under Wine argv[0] is the game's own (Windows) path.
 */
export function moduleInfo(pid: number): ModuleInfo {
  let text: string;
  try {
    text = fs.readFileSync(`${DEFAULT_PROC_ROOT}/${pid}/maps`, 'latin1');
  } catch (e) {
    if (isDenied(e)) throw permissionError('reading the memory map', pid, e);
    throw new Error(`could not read the memory map for PID ${pid} -- `
      + 'check the PID, or omit it to find the game automatically', { cause: e });
  }
  const maps = parseMaps(text);
  let last: unknown = new Error(`could not determine the image name for PID ${pid}`);
  for (const name of candidateNames(pid)) {
    try { return moduleFromMaps(maps, name); } catch (e) { last = e; }
  }
  throw last;
}

export const linuxBackend: ProcessBackend = {
  platform: 'linux',
  findProcesses(exeName: string): ProcessCandidate[] {
    return findPids(exeName, DEFAULT_PROC_ROOT).map(pid => ({ pid }));
  },
  moduleInfo,
  open: openProcess,
};
