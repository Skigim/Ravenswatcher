// A run-history database written by Ravenswatcher 0.1.6 opens in the current
// code with every run intact. The fixture was produced by the 0.1.6 build
// itself; see fixtures/history-016/make-fixture.js. Work happens on a copy.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { HISTORY_FILE, loadHistory, appendRun } = require('../../history');
const { validateStoredRow } = require('../../history-record');

const FIXTURE = path.join(__dirname, 'fixtures', 'history-016', 'run-history.sqlite');
const IDS = [1760000000000, 1760000100000, 1760000200000, 1760000300000];

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenswatcher-history-016-'));
  try {
    const file = path.join(dir, HISTORY_FILE);
    fs.copyFileSync(FIXTURE, file);

    // What 0.1.6 stored, read without going through the code under test.
    const raw = new DatabaseSync(file, { readOnly: true });
    let stored;
    try {
      assert.strictEqual(raw.prepare('PRAGMA user_version').get().user_version, 1);
      stored = raw.prepare('SELECT summary_json FROM runs ORDER BY id').all().map((r) => JSON.parse(r.summary_json));
    } finally { raw.close(); }
    assert.deepStrictEqual(stored.map((r) => r.id), IDS, 'the fixture holds the four runs it was built with');

    const h = loadHistory(file);
    assert.strictEqual(h.skipped, 0, 'no 0.1.6 row is skipped');
    assert.deepStrictEqual(h.runs, stored, 'every run comes back with the same fields and values');
    assert.deepStrictEqual(h.runs.map((r) => r.result), ['victory', 'defeat', 'defeat', 'victory']);
    assert.deepStrictEqual(h.runs.map((r) => r.difficulty), [2, 0, 1, 5], 'a real zero difficulty stays zero');
    assert.strictEqual(h.runs[0].talents.length, 2);
    assert.strictEqual(h.runs[0].talents[0].description, 'Dash deals <b>25%</b> more damage');
    assert.strictEqual(h.runs[1].talents, null);
    assert.strictEqual(h.runs[1].object_counts, null);
    assert.deepStrictEqual(h.runs[3].object_counts, [1, 2, 65535]);

    for (const run of h.runs) {
      const v = validateStoredRow(run);
      assert.strictEqual(v.ok, true, `run ${run.id} passes the stored-row validator`);
      assert.deepStrictEqual(v.run.issues, [], `run ${run.id} has no malformed fields`);
    }

    const added = { v: 1, id: 1760000400000, ended: '2026-10-17T22:00:00.000Z', result: 'victory', hero: 'Hero_Fixture', difficulty: 1 };
    assert.strictEqual(appendRun(file, h, added), true);
    const reloaded = loadHistory(file);
    assert.strictEqual(reloaded.skipped, 0);
    assert.deepStrictEqual(reloaded.runs, [...stored, added], 'old runs and the new one are all present');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  console.log('test-history-016: ok (0.1.6 database)');
  return 0;
}
module.exports = { main };
if (require.main === module) process.exit(main());
