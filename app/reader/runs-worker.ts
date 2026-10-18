'use strict';
// The run-end channel, on its own worker thread. See runs.ts for what is read
// and why the score waits.
//
// A worker of its own because the edge needs two heap scans (the skill
// definitions for talent names, the score page) and the score then needs
// polling for up to a minute. The discovery sweep's thread has neither the
// time nor the cadence, and the Sandman thread polls at 100 ms for a reason.
//
// The record is found ahead of the edge, at the menu or during a run, and
// held: a scan costs 270-400 ms at the menu and up to 1.5 s on the busy
// summary screen. Validating the held address is one pointer read per tick.

import { parentPort, workerData, isMainThread } from 'worker_threads';
import * as runs from './runs';
import type { ClassOf, RunResult, RunSummary } from './runs';
import { pollBinding } from './values';
import type { ByteSource } from './pe';
import type { ScanSource } from './scan';
import type { MelodySlotView } from './melodies';
import * as rtti from './rtti';
import { scanPointers } from './scan';
import { CURRENT_MAP_ID } from './state';

// win32.js is still JavaScript; require it directly.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { openProcess } = require('./win32');

export const RUNS_POLL_MS = 250;
export const RECORD_FIND_MS = 10000;
export const SCORE_READ_MS = 500;
export const SCORE_RESCAN_MS = 2000;
export const VTABLE_RETRY_MS = 5000;

interface WorkerProcess extends ByteSource, ScanSource {
  readI32(addr: number): number | null;
  isAlive(): boolean;
  close(): void;
}

export interface ValueBinding { addr: number; variant: string | null; is_float: boolean }

/** What Reader posts to this worker: the bindings of the values it polls. */
type RunsWorkerMessage = { type: 'values'; bindings: Record<string, ValueBinding> }
  | { type: 'melodies'; melodies: MelodySlotView[] | null; mapId: number | null; reset?: boolean };

function post(m: unknown): void {
  if (parentPort) parentPort.postMessage(m);
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Vtable -> class name for every class the channel checks, or null if the record class is missing. */
function resolveClasses(proc: WorkerProcess, base: number): Map<number, string> | null {
  const byVt = new Map<number, string>();
  for (const name of Object.values(runs.RUN_CLASSES)) {
    for (const rva of rtti.resolveAllVtableRvas(proc, base, name + '\0')) byVt.set(base + rva, name);
  }
  return [...byVt.values()].includes(runs.RUN_CLASSES.record) ? byVt : null;
}

/** The capture in progress between the edge and either a ready score or End. */
interface Pending {
  summary: RunSummary;
  baseline: Set<number>;
  controllers: number[];
  lastRead: number;
  lastScan: number;
}

export async function runWorker(pid: number, base: number): Promise<void> {
  let proc: WorkerProcess;
  try {
    proc = openProcess(pid) as WorkerProcess;
  } catch (e) {
    return post({ type: 'fatal', message: message(e) });
  }

  let bindings: Record<string, ValueBinding> = {};
  let melodySnapshot: runs.RunMelodySnapshot = { melodies: null, outsideRun: true };
  let heroFields: runs.HeroStatFields | null = null;
  let lastHeroStats: runs.HeroStats | null = null;
  let lastHeroStatsAt: string | null = null;
  let lastHeroFind = 0;
  let talentEntity = 0;
  let talentRuntimes: number[] = [];
  let lastTalents: runs.Talent[] | null = null;
  let lastTalentRead = 0;
  let lastTalentFind = 0;
  if (parentPort) {
    parentPort.on('message', (m: RunsWorkerMessage) => {
      if (m && m.type === 'values') bindings = m.bindings;
      if (m && m.type === 'melodies') {
        const startsRun = m.mapId !== null && m.mapId >= 0 && (m.reset || melodySnapshot.outsideRun);
        if (startsRun) { heroFields = null; lastHeroStats = null; lastHeroStatsAt = null; lastHeroFind = 0; talentEntity = 0; talentRuntimes = []; lastTalents = null; lastTalentRead = 0; lastTalentFind = 0; }
        melodySnapshot = runs.nextRunMelodySnapshot(melodySnapshot, m.mapId, !!m.reset, m.melodies);
      }
    });
    parentPort.unref();
  }

  const value = (name: string): number | null => {
    const b = bindings[name];
    if (!b) return null;
    try { return pollBinding(proc, b.addr, b.variant, b.is_float); } catch { return null; }
  };

  let byVt: Map<number, string> | null = null;
  let lastVtAttempt = 0;
  const classOf: ClassOf = (addr) => {
    if (!addr || !byVt) return null;
    const vt = proc.readPtr(addr);
    return vt === null ? null : (byVt.get(vt) ?? null);
  };
  const vtablesOf = (...names: string[]): number[] =>
    byVt ? [...byVt].filter(([, n]) => names.includes(n)).map(([vt]) => vt) : [];
  const scan = (...names: string[]): number[] => {
    const targets = vtablesOf(...names);
    if (!targets.length) return [];
    return [...scanPointers(proc, targets, { writableOnly: true }).values()].flat() as number[];
  };

  let records: number[] = [];
  let lastFind = 0;
  const findRecords = () => {
    lastFind = Date.now();
    records = scan(runs.RUN_CLASSES.record).filter(a => classOf(a) === runs.RUN_CLASSES.record);
  };

  // Last in-run readings. Map id reads -1 on the summary, so the map is the
  // last value before it; difficulty and chapter hold through the summary and
  // are read on the edge, falling back to these.
  let lastMap: number | null = null;
  let lastDifficulty: number | null = null;
  let lastChapter: number | null = null;
  let prevFlags: { defeat: number | null; victory: number | null } | null = null;
  let pending: Pending | null = null;

  const readCapture = (result: RunResult): RunSummary | null => {
    const attempt = (): RunSummary | string => {
      const problems: string[] = [];
      for (const record of records) {
        try {
          const r = runs.readRecord(proc, record, classOf);
          const problem = runs.recordProblem(r);
          if (problem) { problems.push(problem); continue; }
          let talents: runs.Talent[] | null = null;
          try {
            talents = runs.retainTalentDescriptions(runs.readTalents(proc, record, classOf,
              scan(runs.RUN_CLASSES.settings), scan(runs.RUN_CLASSES.runtime)), lastTalents);
          } catch (e) {
            talents = lastTalents === null ? null : lastTalents.map(t => ({ ...t }));
            post({ type: 'diagnostic', message: 'run-end talent read failed' + (talents === null ? ': ' : '; using last in-run snapshot: ') + message(e) });
          }
          const difficulty = value(runs.GAME_DIFFICULTY);
          const chapter = value(runs.CURRENT_CHAPTER);
          return runs.buildSummary({
            id: Date.now(), result,
            difficulty: difficulty ?? lastDifficulty,
            map: lastMap,
            chapter: chapter ?? lastChapter,
          }, r, talents, melodySnapshot.melodies, lastHeroStats, lastHeroStatsAt);
        } catch (e) {
          problems.push(message(e));
        }
      }
      return problems.join('; ') || 'no run record found';
    };
    let got = attempt();
    // A zero playtime means the read raced the clear or hit a stale address:
    // find the record again and read once more.
    if (typeof got === 'string') { findRecords(); got = attempt(); }
    if (typeof got === 'string') {
      post({ type: 'diagnostic', message: 'run not recorded: ' + got });
      return null;
    }
    return got;
  };

  const startScore = (summary: RunSummary): Pending => {
    const controllers = scan(runs.RUN_CLASSES.score);
    const baseline = new Set<number>();
    for (const c of controllers) {
      const buf = runs.detailBuffer(proc, c);
      if (buf) baseline.add(buf);
    }
    const now = Date.now();
    return { summary, baseline, controllers, lastRead: 0, lastScan: now };
  };

  /** A current-run score, or null while the page still shows the old one. */
  const tryScore = (p: Pending): { total: number; details: string[] } | null => {
    const now = Date.now();
    if (now - p.lastRead < SCORE_READ_MS) return null;
    p.lastRead = now;
    const fresh: runs.ScoreRead[] = [];
    for (const c of p.controllers) {
      try {
        const s = runs.readScore(proc, c, classOf);
        if (runs.scoreReady(p.baseline, s)) fresh.push(s);
      } catch { /* not this controller, or caught mid-update */ }
    }
    const only = fresh.length === 1 ? fresh[0] : undefined;
    if (only) return { total: only.total, details: only.details };
    if (now - p.lastScan >= SCORE_RESCAN_MS) {
      p.lastScan = now;
      p.controllers = scan(runs.RUN_CLASSES.score);
    }
    return null;
  };

  try {
    for (;;) {
      if (!proc.isAlive()) {
        post({ type: 'gone', message: 'target process exited' });
        break;
      }

      if (!byVt) {
        const now = Date.now();
        if (now - lastVtAttempt >= VTABLE_RETRY_MS) {
          lastVtAttempt = now;
          try { byVt = resolveClasses(proc, base); } catch { byVt = null; }
          if (!byVt) post({ type: 'diagnostic', message: 'could not resolve run record RTTI; run history is off' });
        }
        if (!byVt) { await sleep(RUNS_POLL_MS); continue; }
      }

      const flags = { defeat: value(runs.DEFEAT_FLAG), victory: value(runs.VICTORY_FLAG) };
      const inSummary = flags.defeat === 1 || flags.victory === 1;

      if (!inSummary && !pending) {
        const map = value(CURRENT_MAP_ID);
        if (map !== null && map !== -1) {
          if (lastMap === null) { lastHeroStats = null; lastHeroStatsAt = null; lastTalents = null; }
          if (lastMap !== map) { heroFields = null; lastHeroFind = 0; lastHeroStats = null; lastHeroStatsAt = null; talentEntity = 0; talentRuntimes = []; lastTalents = null; lastTalentFind = 0; }
          lastMap = map;
          lastDifficulty = value(runs.GAME_DIFFICULTY) ?? lastDifficulty;
          lastChapter = value(runs.CURRENT_CHAPTER) ?? lastChapter;
        }
        // Hold the record. Re-find only when no held address validates.
        records = records.filter(a => classOf(a) === runs.RUN_CLASSES.record);
        if (!records.length && Date.now() - lastFind >= RECORD_FIND_MS) findRecords();
        if (map !== null && map >= 0) {
          try {
            if (!heroFields && Date.now() - lastHeroFind >= RECORD_FIND_MS) {
              lastHeroFind = Date.now();
              const record = records.length === 1 ? records[0] : undefined;
              if (record !== undefined) {
                const settings = proc.readPtr(record + 0x20);
                const hero = settings ? runs.stringAt(proc, settings + 8, 256) : '';
                heroFields = runs.findHeroStatFields(proc, hero, classOf, scan(runs.RUN_CLASSES.controller));
              }
            }
            if (heroFields) {
              lastHeroStats = runs.readHeroStats(proc, heroFields, classOf);
              lastHeroStatsAt = new Date().toISOString();
              // All talent runtimes already exist on the hero. Cache that roster;
              // sample only selected talents every 500 ms on this worker.
              if (Date.now() - lastTalentRead >= 500) {
                lastTalentRead = Date.now();
                try {
                  if (talentEntity !== heroFields.entity && Date.now() - lastTalentFind >= RECORD_FIND_MS) {
                    lastTalentFind = Date.now();
                    talentRuntimes = runs.findTalentRuntimes(proc, heroFields.entity, classOf);
                    talentEntity = heroFields.entity;
                  }
                  const record = records.length === 1 ? records[0] : undefined;
                  if (record !== undefined && talentEntity === heroFields.entity) {
                    const settings = [...new Set(talentRuntimes.map(rt => proc.readPtr(rt + 0x10)).filter((a): a is number => a !== null && a !== 0))];
                    const current = runs.readTalents(proc, record, classOf, settings, talentRuntimes);
                    lastTalents = current.map(t => {
                      const old = lastTalents?.find(p => p.key === t.key && p.rarity_code === t.rarity_code);
                      return { ...t, description: t.description || old?.description || null,
                        description_sampled_at: t.description ? new Date().toISOString() : old?.description_sampled_at ?? null };
                    });
                  }
                } catch { talentEntity = 0; }
              }
            }
          } catch { heroFields = null; }
        }
      }

      const edge = runs.endEdge(prevFlags, flags);
      if (flags.defeat !== null && flags.victory !== null) prevFlags = flags;

      if (edge && !pending) {
        const summary = readCapture(edge);
        if (summary) pending = startScore(summary);
      }

      if (pending) {
        const score = inSummary ? tryScore(pending) : null;
        // End came first: keep the run, without a score, rather than lose it.
        if (score || !inSummary) {
          pending.summary.score = score;
          post({ type: 'run', summary: pending.summary });
          pending = null;
          lastMap = null;
        }
      }

      await sleep(RUNS_POLL_MS);
    }
  } finally {
    proc.close();
  }
}

if (!isMainThread && workerData) {
  const { pid, base } = workerData as { pid: number; base: number };
  runWorker(pid, base).catch(e => post({ type: 'fatal', message: message(e) }));
}
