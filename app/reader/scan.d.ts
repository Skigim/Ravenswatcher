// Hand-written declarations for scan.js, which is still JavaScript.
//
// Temporary by design: delete this file when scan.ts replaces scan.js. It
// exists because tsconfig has no allowJs (see the header there -- with no
// outDir, allowJs would ask tsc to overwrite its own inputs), so a converted
// module importing an unconverted one needs the contract stated somewhere.
//
// Stating it by hand is not pure overhead. Only the exports actually consumed
// from TypeScript are declared, so this doubles as a record of how narrow the
// real coupling is: TypeScript uses one of the functions scan.js exports.
//
// The shapes here were read off the implementation, not guessed. Where the
// runtime is loose the declaration says so rather than inventing precision --
// `scanPointers` returns a Map whose value type depends on `withPrev`, and
// that is left to the caller to narrow rather than modelled with an overload
// that the JavaScript does not actually guarantee.
//
// A wrong declaration here lies silently to every consumer. scanPointers
// never calls .read(); it calls .regions(), .readInto() and .readPtr(), so
// its source is ScanSource, not ByteSource: PeFileSource has only .read() and
// must not typecheck as something buildIndex can scan.

/**
 * What a heap scan needs from its source. Strictly more than ByteSource:
 * scanning enumerates regions and reads into external memory, neither of
 * which a file-backed source can do.
 */
export interface ScanSource {
  /**
   * Committed, readable regions as [base, size]. `writableOnly` restricts to
   * the protection set heap objects actually live in.
   */
  regions(writableOnly?: boolean): Iterable<readonly [number, number]>;
  /** Raw read into caller-provided external memory. Returns bytes read, 0 on failure. */
  readInto(addr: number, dstPtr: unknown, size: number): number;
  readPtr(addr: number): number | null;
}

export const CHUNK_SIZE: number;

export interface ScanPointersOptions {
  /** Restrict to the writable protection set -- heap objects only live there. */
  writableOnly?: boolean;
  /**
   * Targets for which the qword PRECEDING each hit is harvested from the same
   * buffer. Those targets' entries come back as [hitAddr, prevQword] pairs
   * instead of bare addresses.
   */
  withPrev?: readonly number[];
}

/**
 * Every address in committed memory holding a pointer to one of `targets`.
 *
 * Keyed by target, and every requested target is present -- the implementation
 * seeds the map before scanning -- so `.get(t)` for a `t` that was passed in
 * is never undefined.
 *
 * An entry is `number[]` normally, or `[number, number][]` for any target
 * listed in `withPrev`.
 */
export function scanPointers(
  proc: ScanSource,
  targets: readonly number[],
  opts?: ScanPointersOptions,
): Map<number, unknown[]>;

export function scanForPointer(
  proc: ScanSource,
  target: number,
  writableOnly?: boolean,
): number[];
