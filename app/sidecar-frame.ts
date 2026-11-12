// The frames reader/stdio.js writes to stdout, one JSON object per line, and
// sidecar.js parses in the main process. Types and a runtime guard only; the
// JavaScript on both ends is unchanged until it is ported.
import type { ReadoutState } from './reader/state';

/** A normal poll: the whole readout plus the cadence stdio.js stamps on it. */
export type StateFrame = ReadoutState & { poll_ms: number; sweep_interval: number };

/** A failed poll. The stream continues; the line says why this tick has no state. */
export interface ErrorFrame { error: string }

export type SidecarFrame = StateFrame | ErrorFrame;

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function numberOrNull(x: unknown): boolean {
  return x === null || (typeof x === 'number' && Number.isFinite(x));
}

function arrayOrNull(x: unknown): boolean {
  return x === null || Array.isArray(x);
}

export function isErrorFrame(x: unknown): x is ErrorFrame {
  return isObject(x) && typeof x.error === 'string';
}

/**
 * Shallow on purpose: it checks the scalar fields the shell and page branch on
 * and that each panel is the container kind it should be. It does not walk
 * panel contents; those come from our own reader, and a deep walk per frame at
 * the poll rate would buy nothing the producer does not already guarantee.
 * null and 0 are both accepted where the type allows them and are never merged.
 */
export function isStateFrame(x: unknown): x is StateFrame {
  if (!isObject(x) || 'error' in x) return false;
  return typeof x.no_run === 'boolean'
    && typeof x.ready === 'boolean'
    && typeof x.coop === 'boolean'
    && typeof x.process === 'string'
    && typeof x.sweeps === 'number'
    && typeof x.poll_ms === 'number'
    && typeof x.sweep_interval === 'number'
    && numberOrNull(x.level)
    && numberOrNull(x.in_combat)
    && numberOrNull(x.map_id)
    && numberOrNull(x.pid)
    && numberOrNull(x.dream_shards)
    && arrayOrNull(x.melodies)
    && arrayOrNull(x.sandman)
    && arrayOrNull(x.tiles)
    && (x.run_summary === null || isObject(x.run_summary));
}

/** An already-parsed value as a frame, or null when it is neither kind. */
export function asSidecarFrame(value: unknown): SidecarFrame | null {
  if (isErrorFrame(value)) return value;
  if (isStateFrame(value)) return value;
  return null;
}

/** One stdout line as a frame, or null for unparseable text or an unknown shape. */
export function parseSidecarLine(line: string): SidecarFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  return asSidecarFrame(value);
}
