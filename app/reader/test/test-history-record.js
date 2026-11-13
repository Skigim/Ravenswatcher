// The history-row validator: what is kept, what becomes null, what is rejected.
'use strict';
const assert = require('assert');
const { validateStoredRow } = require('../../history-record');

const STATS = {
  damage: { total: 900, dash: 1, trait: 2, attack: 3, power: 4, special: 5, defense: 6, ultimate: 7, other: 8, highest: 99 },
  support: { self_heal: 1, ally_heal: 2, self_shield: 3, ally_shield: 4, blocked: 5, revive_assists: 6 },
  sufferings: { taken: 7, deaths_doors: 1, feathers: 2 },
  resources: { shards_amassed: 10, shards_spent: 4, stars_of_fate: 1, objects_collected: 3 },
};
const GOOD = { v: 1, id: 1700000000000, ended: '2026-10-01T12:00:00.000Z', result: 'victory',
  hero: 'Juliet', difficulty: 2, chapter: 3, playtime_s: 1234.5, score: { total: 4321, details: [] }, ...STATS };

function accept(row) {
  const r = validateStoredRow(row);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  return r.run;
}

function main() {
  const ok = accept(GOOD);
  assert.deepStrictEqual(ok.issues, []);
  assert.strictEqual(ok.endedAt, Date.parse(GOOD.ended));
  assert.strictEqual(ok.result, 'victory');
  assert.strictEqual(ok.hero, 'Juliet');
  assert.strictEqual(ok.difficulty, 2);
  assert.strictEqual(ok.chapter, 3);
  assert.strictEqual(ok.durationS, 1234.5);
  assert.strictEqual(ok.gameScore, 4321);
  assert.deepStrictEqual({ damage: ok.damage, support: ok.support, sufferings: ok.sufferings, resources: ok.resources }, STATS);

  // Structural rejections name the field.
  for (const [row, field] of [
    [null, 'row'], ['x', 'row'], [[], 'row'], [{ id: 1 }, 'v'], [{ v: 1 }, 'id'],
    [{ v: 1, id: 1.5 }, 'id'], [{ v: 1, id: '7' }, 'id'], [{ v: 'a', id: 7 }, 'v'],
  ]) {
    const r = validateStoredRow(row);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.field, field);
    assert.ok(r.reason);
  }

  // Missing fields are null/unknown, with no issue raised and nothing coerced to 0.
  const bare = accept({ v: 1, id: 5 });
  assert.deepStrictEqual(bare.issues, []);
  assert.strictEqual(bare.ended, null);
  assert.strictEqual(bare.endedAt, null);
  assert.strictEqual(bare.result, 'unknown');
  for (const k of ['hero', 'difficulty', 'durationS', 'chapter', 'gameScore']) assert.strictEqual(bare[k], null, k);
  for (const g of ['damage', 'support', 'sufferings', 'resources']) {
    assert.ok(Object.keys(bare[g]).length > 0);
    for (const [k, value] of Object.entries(bare[g])) assert.strictEqual(value, null, g + '.' + k);
  }
  assert.strictEqual(accept({ v: 1, id: 5, score: null }).gameScore, null);

  // Malformed values become null/unknown and are reported, never defaulted to a loss or a zero.
  const mangled = accept({ v: 1, id: 6, ended: 'last tuesday', result: 'draw', hero: '', difficulty: 1.5,
    chapter: -1, playtime_s: '90', score: { total: NaN }, damage: { total: 'lots', dash: -4, trait: Infinity, attack: 5 },
    support: 'none', sufferings: [], resources: null });
  assert.strictEqual(mangled.ended, null);
  assert.strictEqual(mangled.result, 'unknown');
  assert.strictEqual(mangled.hero, null);
  assert.strictEqual(mangled.difficulty, null);
  assert.strictEqual(mangled.chapter, null);
  assert.strictEqual(mangled.durationS, null);
  assert.strictEqual(mangled.gameScore, null);
  assert.strictEqual(mangled.damage.total, null);
  assert.strictEqual(mangled.damage.dash, null);
  assert.strictEqual(mangled.damage.trait, null);
  assert.strictEqual(mangled.damage.attack, 5, 'a good sibling survives a bad one');
  assert.strictEqual(mangled.support.blocked, null);
  const fields = mangled.issues.map(i => i.field);
  for (const f of ['ended', 'result', 'hero', 'difficulty', 'chapter', 'playtime_s', 'score.total',
    'damage.total', 'damage.dash', 'damage.trait', 'support', 'sufferings']) assert.ok(fields.includes(f), f);
  assert.ok(!fields.includes('resources'), 'null is missing, not malformed');
  assert.ok(!fields.includes('damage.attack'));
  assert.strictEqual(accept({ v: 1, id: 7, result: 5 }).result, 'unknown');
  assert.strictEqual(accept({ v: 1, id: 7, ended: 12 }).endedAt, null);

  // A real zero is kept as zero and is distinct from missing.
  const zero = accept({ v: 1, id: 8, result: 'defeat', difficulty: 0, chapter: 0, playtime_s: 0,
    score: { total: 0, details: [] }, damage: { total: 0 }, resources: { shards_spent: 0 } });
  assert.deepStrictEqual(zero.issues, []);
  assert.strictEqual(zero.result, 'defeat');
  assert.strictEqual(zero.difficulty, 0);
  assert.strictEqual(zero.chapter, 0);
  assert.strictEqual(zero.durationS, 0);
  assert.strictEqual(zero.gameScore, 0);
  assert.strictEqual(zero.damage.total, 0);
  assert.strictEqual(zero.damage.dash, null, 'sibling of a zero stays missing');
  assert.strictEqual(zero.resources.shards_spent, 0);
  assert.strictEqual(zero.resources.shards_amassed, null);

  console.log('test-history-record: ok');
  return 0;
}
module.exports = { main };
if (require.main === module) process.exit(main());
