// One complete run object per ID in SQLite. Game resources remain in the
// separate icon cache; stored GUIDs/keys are resolved when History renders.
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export const HISTORY_FILE = 'run-history.sqlite';

export interface StoredRun {
  v: number;
  id: number;
  [field: string]: unknown;
}

export interface History {
  /** Oldest first. */
  runs: StoredRun[];
  skipped: number;
}

function isRun(x: unknown): x is StoredRun {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return Number.isSafeInteger(r.v) && Number.isSafeInteger(r.id);
}

function open(file: string): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;');
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    if (version !== 0 && version !== 1) {
      throw new Error(`unsupported history database version ${version}`);
    }
    if (version === 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS runs (
          id INTEGER PRIMARY KEY,
          version INTEGER NOT NULL,
          ended TEXT,
          hero TEXT,
          result TEXT,
          difficulty INTEGER,
          summary_json TEXT NOT NULL CHECK(json_valid(summary_json))
        );
        PRAGMA user_version = 1;
      `);
    }
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

function insert(db: DatabaseSync, run: StoredRun): boolean {
  const result = db.prepare(`INSERT INTO runs
    (id, version, ended, hero, result, difficulty, summary_json)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`).run(
    run.id,
    run.v,
    typeof run.ended === 'string' ? run.ended : null,
    typeof run.hero === 'string' ? run.hero : null,
    typeof run.result === 'string' ? run.result : null,
    typeof run.difficulty === 'number' && Number.isSafeInteger(run.difficulty) ? run.difficulty : null,
    JSON.stringify(run),
  );
  return result.changes !== 0;
}

export function loadHistory(file: string): History {
  const db = open(file);
  try {
    const runs: StoredRun[] = [];
    let skipped = 0;
    for (const row of db.prepare('SELECT id, summary_json FROM runs ORDER BY id').all()) {
      let run: unknown;
      try {
        run = JSON.parse(String(row.summary_json));
      } catch {
        skipped++;
        continue;
      }
      if (!isRun(run) || run.id !== row.id) {
        skipped++;
        continue;
      }
      runs.push(run);
    }
    return { runs, skipped };
  } finally {
    db.close();
  }
}

/** The whole object is committed atomically before it is announced to the UI. */
export function appendRun(file: string, history: History, run: unknown): boolean {
  if (!isRun(run)) return false;
  const db = open(file);
  try {
    if (!insert(db, run)) return false;
    history.runs.push(run);
    return true;
  } finally {
    db.close();
  }
}

/** Commit record deletion before updating the in-memory history. */
export function deleteRuns(file: string, history: History, ids: readonly number[]): void {
  const db = open(file);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const remove = db.prepare('DELETE FROM runs WHERE id = ?');
      for (const id of ids) {
        if (remove.run(id).changes !== 1) {
          throw new Error('History changed. Review the records again.');
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } finally {
    db.close();
  }
  const removed = new Set(ids);
  history.runs = history.runs.filter((run) => !removed.has(run.id));
}

/** Clear every row atomically, including rows that could not be loaded. */
export function clearHistory(file: string, history: History): void {
  const db = open(file);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DELETE FROM runs');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
  history.runs = [];
  history.skipped = 0;
}

type DeletionScope = 'single' | 'selected' | 'all';

interface DeletionRequest {
  scope: DeletionScope;
  ids?: number[];
}

interface PendingDeletion {
  token: string;
  scope: DeletionScope;
  ids: number[];
  step: number;
  steps: number;
  expires: number;
}

/** Confirmations are enforced here, independently of renderer buttons. */
export class HistoryDeletion {
  private pending: PendingDeletion | null = null;

  constructor(
    private readonly current: () => History,
    private readonly commit: (scope: DeletionScope, ids: readonly number[]) => void,
    private readonly now: () => number = Date.now,
  ) {}

  prepare(input: unknown): { token: string; scope: DeletionScope; ids: number[]; step: number; steps: number } {
    this.pending = null;
    if (!input || typeof input !== 'object') throw new Error('Invalid deletion request.');
    const { scope, ids } = input as DeletionRequest;
    if (!['single', 'selected', 'all'].includes(scope)) throw new Error('Invalid deletion scope.');
    const available = new Set(this.current().runs.map((run) => run.id));
    let chosen: number[];
    if (scope === 'all') {
      if (ids !== undefined) throw new Error('Delete all does not accept a record selection.');
      chosen = [...available];
    } else {
      if (!Array.isArray(ids) || !ids.length || ids.some((id) => !Number.isSafeInteger(id) || !available.has(id))) {
        throw new Error('Select existing records to delete.');
      }
      chosen = [...new Set(ids)];
      if (chosen.length !== ids.length || (scope === 'single' && chosen.length !== 1)) {
        throw new Error('Invalid record selection.');
      }
    }
    if (!chosen.length) throw new Error('There are no records to delete.');
    chosen.sort((a, b) => a - b);
    this.pending = {
      token: randomUUID(),
      scope,
      ids: chosen,
      step: 1,
      steps: scope === 'single' ? 2 : 3,
      expires: this.now() + 5 * 60_000,
    };
    return this.view(this.pending);
  }

  confirm(token: unknown, typed?: unknown): { done: boolean; step?: number; steps?: number } {
    const pending = this.pending;
    if (!pending || token !== pending.token || this.now() >= pending.expires) {
      throw new Error('This deletion request expired. Review the records again.');
    }
    if (pending.steps === 3 && pending.step === 2 && typed !== `DELETE ${pending.ids.length}`) {
      throw new Error(`Type DELETE ${pending.ids.length} exactly to continue.`);
    }
    if (pending.step < pending.steps) {
      pending.step++;
      return { done: false, step: pending.step, steps: pending.steps };
    }
    // A run finishing while the dialog is open must not get deleted unseen.
    const available = new Set(this.current().runs.map((run) => run.id));
    if (
      pending.ids.some((id) => !available.has(id))
      || (pending.scope === 'all' && available.size !== pending.ids.length)
    ) {
      this.pending = null;
      throw new Error('History changed. Cancel and review the records again.');
    }
    this.pending = null; // Single use, including storage failures.
    this.commit(pending.scope, pending.ids);
    return { done: true };
  }

  cancel(token: unknown): void {
    if (this.pending?.token === token) this.pending = null;
  }

  private view(pending: PendingDeletion) {
    const { token, scope, ids, step, steps } = pending;
    return { token, scope, ids: [...ids], step, steps };
  }
}

