'use strict';
// The run history store: one JSON object per line in <userData>/run-history.jsonl.
//
// Appending never rewrites earlier runs. Every line carries a schema version;
// a later version adds fields and never changes what an existing one means.
// A line that does not parse is skipped and counted, not repaired: the file
// is the player's record, and this code does not get to edit it.
//
// No Electron here, so the suite can exercise it against a temp directory.

import * as fs from 'fs';
import * as path from 'path';

export const HISTORY_FILE = 'run-history.jsonl';

/** A stored run, as the reader emitted it. The renderer reads the fields. */
export interface StoredRun {
  v: number;
  id: number;
  [field: string]: unknown;
}

export interface History {
  /** Oldest first, as the file holds them. */
  runs: StoredRun[];
  /** Lines that were not a run and were left alone. */
  skipped: number;
}

function isRun(x: unknown): x is StoredRun {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return typeof r.v === 'number' && typeof r.id === 'number' && Number.isFinite(r.id);
}

/** Every run in the file. A missing file is an empty history. */
export function loadHistory(file: string): History {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { runs: [], skipped: 0 };
    throw e;
  }
  const runs: StoredRun[] = [];
  const seen = new Set<number>();
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { skipped++; continue; }
    if (!isRun(parsed)) { skipped++; continue; }
    if (seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    runs.push(parsed);
  }
  return { runs, skipped };
}

/**
 * Append one run unless the history already holds its id. Returns whether it
 * was written. Mutates `history` to match the file.
 */
export function appendRun(file: string, history: History, run: unknown): boolean {
  if (!isRun(run)) return false;
  if (history.runs.some(r => r.id === run.id)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(run) + '\n', 'utf8');
  history.runs.push(run);
  return true;
}
