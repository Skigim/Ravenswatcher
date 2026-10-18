// SQLite persistence, entirely in temp directories.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { HISTORY_FILE, loadHistory, appendRun } = require('../../history');
function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenswatcher-history-'));
  try {
    const file = path.join(dir, 'nested', HISTORY_FILE);
    const h = loadHistory(file);
    assert.deepStrictEqual(h, { runs: [], skipped: 0 });
    const a = { v: 1, id: 1000, result: 'defeat', score: { total: 0, details: [] } };
    const b = { v: 1, id: 2000, hero: 'Hero_Fixture', difficulty: 1, result: 'victory', score: null,
      objects: ['ab'.repeat(16), 'cd'.repeat(16)], object_counts: [4, 301],
      hero_stats: { vitality: 0, damage: 247, armor: -10, crit_chance: 5, crit_damage: 50 },
      melodies: [{ name: 'Fixture', state: 'active', notes: 4, notes_earned: 0, icon: 'fixture.png' }], talents: [{ name: 'Fixture Talent', key: 'fixture', rarity_code: 3, description: 'Fixture +25% effect', description_sampled_at: '2026-10-17T20:00:00.000Z' }] };
    assert.strictEqual(appendRun(file, h, a), true);
    assert.strictEqual(appendRun(file, h, b), true);
    assert.strictEqual(appendRun(file, h, { ...a, result: 'victory' }), false);
    assert.strictEqual(appendRun(file, h, { id: 3 }), false);
    assert.strictEqual(appendRun(file, h, null), false);
    const originalBytes = fs.readFileSync(file);
    assert.deepStrictEqual(loadHistory(file).runs, [a, b], 'full objects, quantities and melody states survive reopening');
    assert.deepStrictEqual(fs.readFileSync(file), originalBytes, 'loading an initialized database does not rewrite its schema/version');
    const freshMemory = { runs: [], skipped: 0 };
    assert.strictEqual(appendRun(file, freshMemory, a), false, 'the database enforces IDs independently of the memory list');
    const db = new DatabaseSync(file);
    try {
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM runs').get().count, 2);
      assert.strictEqual(db.prepare('SELECT hero FROM runs WHERE difficulty = 1').get().hero, 'Hero_Fixture');
    } finally { db.close(); }
    assert.strictEqual(fs.readFileSync(file).subarray(0, 15).toString(), 'SQLite format 3');

    // A JSONL file from private development is ignored, never imported or changed.
    const unrelated = path.join(dir, 'nested', 'run-history.jsonl');
    fs.writeFileSync(unrelated, JSON.stringify({ v: 1, id: 3000 }));
    assert.deepStrictEqual(loadHistory(file).runs, [a, b]);

    const broken = path.join(dir, 'broken.sqlite');
    fs.writeFileSync(broken, 'not a database');
    assert.throws(() => loadHistory(broken));
    assert.strictEqual(fs.readFileSync(broken, 'utf8'), 'not a database', 'a damaged database is not silently recreated');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  console.log('test-history: ok (SQLite)');
  return 0;
}
module.exports = { main };
if (require.main === module) process.exit(main());
