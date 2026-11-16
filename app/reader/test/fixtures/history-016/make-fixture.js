'use strict';
// Regenerates run-history.sqlite, a run-history database as Ravenswatcher
// 0.1.6 wrote it. Synthetic runs only; nothing comes from a real profile.
//
//   git archive v0.1.6 app | tar -x -C <tmp>       (outside the repo)
//   cd <tmp>/app && tsc -p .                       (compile in place)
//   node make-fixture.js <tmp>/app run-history.sqlite
//
// The rows go through the 0.1.6 build's own buildSummary and appendRun, so
// the file is what that release produced. The current code must never be
// used here, or the fixture stops being evidence of backward compatibility.
// Committed once; regenerate only if the fixture needs more cases.
const fs = require('fs');
const path = require('path');

const [appDir, out] = process.argv.slice(2);
if (!appDir || !out) throw new Error('usage: node make-fixture.js <v0.1.6 app dir> <output.sqlite>');
const { loadHistory, appendRun } = require(path.join(path.resolve(appDir), 'history'));
const { buildSummary, STAT_ROWS } = require(path.join(path.resolve(appDir), 'reader', 'runs'));

function stats(seed, zero = false) {
  const s = {};
  for (const [group, rows] of Object.entries(STAT_ROWS)) {
    s[group] = {};
    let i = 0;
    for (const name of Object.keys(rows)) s[group][name] = zero ? 0 : seed * (++i) + (i % 3 === 0 ? 0.5 : 0);
  }
  return s;
}
const guid = (b) => b.repeat(16);
const melody = (slot, internal_name, name, state, notes, notes_earned) =>
  ({ slot, internal_name, name, icon: `${internal_name}.png`, notes, notes_earned, state, effect: `${name} effect` });

const runs = [
  // Victory with every optional block present.
  buildSummary(
    { id: 1760000000000, result: 'victory', difficulty: 2, map: 3, chapter: 2 },
    { hero: 'Hero_Kintaro_Jungle', hero_definition: 'Heroes\Kintaro_Update6.herodef.ot', playtime_s: 716.97, level: 14,
      stats: stats(100), objects: [guid('ab'), guid('cd')], object_counts: [4, 301] },
    [{ name: 'Fixture Dash', key: 'Skill_Kintaro_Dash', rarity: 'Rare', rarity_code: 1,
       description: 'Dash deals <b>25%</b> more damage', description_sampled_at: '2026-10-17T20:00:00.000Z' },
     { name: 'Fixture Trait', key: 'Skill_Kintaro_Trait', rarity: 'Legendary', rarity_code: 3 }],
    [melody(0, 'Melody_A', 'Fixture A', 'active', 4, 2), melody(1, 'Melody_B', 'Fixture B', 'inactive', 3, null)],
    { vitality: 0, damage: 247, armor: -10, crit_chance: 5, crit_damage: 50 },
    '2026-10-17T19:59:00.000Z'),
  // Defeat with every optional block absent and real zeros in the statistics.
  buildSummary(
    { id: 1760000100000, result: 'defeat', difficulty: 0, map: null, chapter: null },
    { hero: 'Hero_Juliet_Default', hero_definition: 'Heroes\Juliet_Update6.herodef.ot', playtime_s: 0, level: 1,
      stats: stats(0, true), objects: [], object_counts: null },
    null),
  // Defeat with a hero from another skin and an empty (not absent) talent list.
  buildSummary(
    { id: 1760000200000, result: 'defeat', difficulty: 1, map: 5, chapter: 1 },
    { hero: 'Hero_Scarlet_Gothic', hero_definition: 'Heroes\Scarlet_Update6.herodef.ot', playtime_s: 1203.5, level: 9,
      stats: stats(7), objects: [guid('ef')], object_counts: [12] },
    [], [], null),
  // Victory at the highest difficulty, talents without descriptions.
  buildSummary(
    { id: 1760000300000, result: 'victory', difficulty: 5, map: 8, chapter: 4 },
    { hero: 'Hero_Pied_Piper', hero_definition: 'Heroes\Piper_Update6.herodef.ot', playtime_s: 3599.25, level: 30,
      stats: stats(1000), objects: [guid('01'), guid('02'), guid('03')], object_counts: [1, 2, 65535] },
    [{ name: 'Fixture Power', key: 'Skill_Piper_Power', rarity: null, rarity_code: 0 }],
    [melody(0, 'Melody_C', 'Fixture C', 'active', 5, 5)],
    { vitality: 10, damage: 300, armor: 0, crit_chance: 0, crit_damage: 100 },
    '2026-10-17T21:00:00.000Z'),
];

if (fs.existsSync(out)) throw new Error(`${out} exists; delete it first`);
const history = loadHistory(out);
for (const r of runs) if (!appendRun(out, history, r)) throw new Error(`append failed for ${r.id}`);
console.log(`wrote ${runs.length} runs to ${out}`);
