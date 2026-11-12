// A stored history row as analytics may trust it. loadHistory() only proves a
// row is an object with integer v and id; everything else in the JSON is
// whatever an older build, a damaged file or a hand edit left there.
//
// Policy, field by field:
//   - Only a row that is not an object, or has no integer v or id, is rejected.
//   - Every other field is optional. A missing or malformed value comes out as
//     null (or 'unknown' for the result), never 0 and never a guess. A real 0
//     stays 0. A malformed (present but wrong) value is also reported in
//     `issues`; a merely absent one is not.
// Nothing here reads or writes the database or changes what is stored.
import type { RunStats } from './reader/runs';

export type RunOutcome = 'victory' | 'defeat' | 'unknown';

/** RunStats with every statistic nullable. */
export type StatBlock = {
  [G in keyof RunStats]: { [K in keyof RunStats[G]]: number | null };
};

export interface RecordIssue { field: string; reason: string }

export interface ValidatedRun {
  v: number;
  id: number;
  /** The stored ISO string, when it parsed as a date. */
  ended: string | null;
  /** Epoch milliseconds of `ended`. */
  endedAt: number | null;
  result: RunOutcome;
  hero: string | null;
  difficulty: number | null;
  /** Playtime in seconds. */
  durationS: number | null;
  chapter: number | null;
  /** score.total; null when the score was never read. */
  gameScore: number | null;
  damage: StatBlock['damage'];
  support: StatBlock['support'];
  sufferings: StatBlock['sufferings'];
  resources: StatBlock['resources'];
  /** Present-but-malformed fields that were nulled. Empty for a clean row. */
  issues: RecordIssue[];
}

export type RecordValidation =
  | { ok: true; run: ValidatedRun }
  | { ok: false; field: string; reason: string };

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function present(x: unknown): boolean {
  return x !== undefined && x !== null;
}

export function validateStoredRow(row: unknown): RecordValidation {
  if (!isObject(row)) return { ok: false, field: 'row', reason: 'not an object' };
  const { v, id } = row;
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) return { ok: false, field: 'v', reason: 'not a safe integer' };
  if (typeof id !== 'number' || !Number.isSafeInteger(id)) return { ok: false, field: 'id', reason: 'not a safe integer' };

  const issues: RecordIssue[] = [];
  const bad = (field: string, reason: string): null => {
    issues.push({ field, reason });
    return null;
  };

  const text = (field: string, x: unknown): string | null => {
    if (!present(x)) return null;
    return typeof x === 'string' && x.trim() !== '' ? x : bad(field, 'not a non-empty string');
  };
  const count = (field: string, x: unknown): number | null => {
    if (!present(x)) return null;
    return typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : bad(field, 'not a non-negative integer');
  };
  const amount = (field: string, x: unknown): number | null => {
    if (!present(x)) return null;
    return typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : bad(field, 'not a non-negative number');
  };
  /** The named group's object, or an empty one when absent (every stat then reads null). */
  const group = (name: string): Record<string, unknown> => {
    const raw = row[name];
    if (present(raw) && !isObject(raw)) bad(name, 'not an object');
    return isObject(raw) ? raw : {};
  };

  let ended: string | null = null;
  let endedAt: number | null = null;
  if (present(row.ended)) {
    const ms = typeof row.ended === 'string' ? Date.parse(row.ended) : NaN;
    if (typeof row.ended === 'string' && Number.isFinite(ms)) { ended = row.ended; endedAt = ms; }
    else bad('ended', 'not a parseable date string');
  }

  let result: RunOutcome = 'unknown';
  if (present(row.result)) {
    if (row.result === 'victory' || row.result === 'defeat') result = row.result;
    else bad('result', 'not victory or defeat');
  }

  let gameScore: number | null = null;
  if (present(row.score)) {
    if (isObject(row.score)) gameScore = amount('score.total', row.score.total);
    else bad('score', 'not an object');
  }

  const hero = text('hero', row.hero);
  const difficulty = count('difficulty', row.difficulty);
  const durationS = amount('playtime_s', row.playtime_s);
  const chapter = count('chapter', row.chapter);

  const d = group('damage');
  const damage: StatBlock['damage'] = {
    total: amount('damage.total', d.total),
    dash: amount('damage.dash', d.dash),
    trait: amount('damage.trait', d.trait),
    attack: amount('damage.attack', d.attack),
    power: amount('damage.power', d.power),
    special: amount('damage.special', d.special),
    defense: amount('damage.defense', d.defense),
    ultimate: amount('damage.ultimate', d.ultimate),
    other: amount('damage.other', d.other),
    highest: amount('damage.highest', d.highest),
  };
  const s = group('support');
  const support: StatBlock['support'] = {
    self_heal: amount('support.self_heal', s.self_heal),
    ally_heal: amount('support.ally_heal', s.ally_heal),
    self_shield: amount('support.self_shield', s.self_shield),
    ally_shield: amount('support.ally_shield', s.ally_shield),
    blocked: amount('support.blocked', s.blocked),
    revive_assists: amount('support.revive_assists', s.revive_assists),
  };
  const f = group('sufferings');
  const sufferings: StatBlock['sufferings'] = {
    taken: amount('sufferings.taken', f.taken),
    deaths_doors: amount('sufferings.deaths_doors', f.deaths_doors),
    feathers: amount('sufferings.feathers', f.feathers),
  };
  const r = group('resources');
  const resources: StatBlock['resources'] = {
    shards_amassed: amount('resources.shards_amassed', r.shards_amassed),
    shards_spent: amount('resources.shards_spent', r.shards_spent),
    stars_of_fate: amount('resources.stars_of_fate', r.stars_of_fate),
    objects_collected: amount('resources.objects_collected', r.objects_collected),
  };

  return {
    ok: true,
    run: {
      v, id, ended, endedAt, result, hero, difficulty, durationS, chapter, gameScore,
      damage, support, sufferings, resources, issues,
    },
  };
}
