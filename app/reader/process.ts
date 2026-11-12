// Platform-neutral process backend: the contract a per-OS implementation
// (win32.js today, a Linux backend later) must satisfy. Types only; nothing
// requires this module yet. It is modelled on what win32.js and its callers
// (reader.js, scan.js, sweeper.js, placement.js, rtti.js, pefile.js and the
// *-worker files) do now, so a Windows backend can implement it unchanged.
//
// Addresses are plain JS Numbers (user-mode addresses stay below 2^53), never
// BigInt -- BigInt in the scan loop costs ~4x.
//
// NULL VS ZERO. Every read here reports failure as `null` (or a short byte
// count), never as 0, so "unreadable / not resolved yet" stays distinct from
// "the memory genuinely holds zero".

export type ProcessPlatform = 'win32' | 'linux';

/** A candidate game process found by discovery. */
export interface ProcessCandidate {
  pid: number;
}

/**
 * The process's main executable image. Returned by ProcessBackend.moduleInfo,
 * called by reader.js at attach (base and exePath are kept on the Reader; the
 * install directory is derived from exePath).
 */
export interface ModuleInfo {
  /** Load address of the main image. A real address, never 0 on success. */
  base: number;
  /** Size of the mapped image in bytes. */
  size: number;
  /** Full path of the executable on the host filesystem. */
  exePath: string;
}

/** A readable region: [base, size], as yielded by win32 Process.regions(). */
export type MemoryRegion = readonly [base: number, size: number];

/**
 * A live attachment to one process. Read-only by construction: there is no
 * write, allocate or inject member, and none may be added.
 */
export interface ProcessHandle {
  readonly pid: number;

  /**
   * Is the process still running? Called by every worker each poll and by
   * Reader.alive(). A handle does not go stale on exit, so reads alone cannot
   * tell. Returns false once closed or if the OS can no longer answer; never
   * throws.
   */
  isAlive(): boolean;

  /**
   * Committed, readable regions in ascending address order (called by scan.js
   * and the sweeper). `writableOnly` restricts to writable pages, where heap
   * objects live. Unreadable (no-access / guard) regions are skipped. Ends
   * quietly when the address space is exhausted; does not throw.
   */
  regions(writableOnly?: boolean): Iterable<MemoryRegion>;

  /**
   * Raw read of `size` bytes at `addr` into caller-provided scratch memory
   * (scan.js hot loop). Returns the number of bytes actually read: 0 for a
   * failed read, fewer than `size` for a partial one. Must not throw for
   * ordinary unreadable memory. Win32 ReadProcessMemory reports a failed
   * request as 0 bytes even if part was readable, and callers rely on that.
   */
  readInto(addr: number, dst: Buffer, size: number): number;

  /**
   * Read `size` bytes as a freshly copied Buffer (placement.js, rtti.js,
   * values). null when nothing could be read. A partial read yields a Buffer
   * shorter than `size`; callers that need all of it check the length. The
   * result never aliases backend scratch memory.
   */
  read(addr: number, size: number): Buffer | null;

  /** uint64 little-endian at addr as a Number, or null if unreadable. */
  readPtr(addr: number): number | null;

  /** int32 little-endian at addr, or null if unreadable. */
  readI32(addr: number): number | null;

  /**
   * Release the OS handle. Idempotent. Reader.close() calls it only after
   * every worker has exited.
   */
  close(): void;
}

/**
 * Discovery failures are tagged on Error.code. 'ENOGAME' (no candidate) is
 * the one stdio.js branches on: it exits with a distinct status so the
 * supervisor retries at a steady cadence. The several-candidates failure is
 * deliberately untagged, as in win32.js: it needs a human.
 */
export type ProcessErrorCode = 'ENOGAME';

/** The backend: one implementation per platform. */
export interface ProcessBackend {
  readonly platform: ProcessPlatform;

  /**
   * Every running process whose image name matches `exeName` (case rules are
   * the platform's; Windows is case-insensitive). Zero, one or several
   * candidates is normal; returns [] rather than throwing for none.
   */
  findProcesses(exeName: string): ProcessCandidate[];

  // Callers (findPid) refuse when this returns none or several; that policy
  // lives with the caller, not the backend.

  /**
   * Main-module identity for `pid` (reader.js at attach). Throws if the
   * process is gone or unreadable.
   */
  moduleInfo(pid: number): ModuleInfo;

  /**
   * Read-only attach (every worker and the Reader). Throws if it cannot
   * attach. There is deliberately no access-mode parameter.
   */
  open(pid: number): ProcessHandle;
}
