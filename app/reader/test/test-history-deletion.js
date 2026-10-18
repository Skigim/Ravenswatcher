// Destructive operations use only synthetic databases in a new temp directory.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { HISTORY_FILE, loadHistory, appendRun, deleteRuns, clearHistory, HistoryDeletion } = require('../../history');

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenswatcher-delete-'));
  try {
    const file = path.join(dir, HISTORY_FILE);
    const h = loadHistory(file);
    for (const id of [1, 2, 3]) appendRun(file, h, { v: 1, id, hero: 'Fixture' });

    let clock = 1000;
    let commits = 0;
    const manager = new HistoryDeletion(
      () => h,
      (scope, ids) => {
        commits++;
        if (scope === 'all') clearHistory(file, h);
        else deleteRuns(file, h, ids);
      },
      () => clock,
    );

    for (const invalid of [
      null,
      {},
      { scope: 'wrong' },
      { scope: 'single', ids: [1, 2] },
      { scope: 'selected', ids: [] },
      { scope: 'selected', ids: [1, 1] },
      { scope: 'single', ids: [999] },
      { scope: 'all', ids: [1] },
    ]) {
      assert.throws(() => manager.prepare(invalid));
    }
    assert.throws(() => manager.confirm('missing'));

    // Cancel at every single/bulk confirmation. Preparation never deletes.
    for (const scope of ['single', 'selected', 'all']) {
      const steps = scope === 'single' ? 2 : 3;
      for (let stop = 1; stop <= steps; stop++) {
        const request = manager.prepare(
          scope === 'all' ? { scope } : { scope, ids: scope === 'single' ? [1] : [1, 2] },
        );
        for (let i = 1; i < stop; i++) {
          manager.confirm(request.token, `DELETE ${request.ids.length}`);
        }
        manager.cancel(request.token);
        assert.throws(() => manager.confirm(request.token, 'DELETE 2'));
        assert.strictEqual(h.runs.length, 3);
        assert.strictEqual(commits, 0);
      }
    }

    let request = manager.prepare({ scope: 'single', ids: [1] });
    assert.deepStrictEqual(manager.confirm(request.token), { done: false, step: 2, steps: 2 });
    assert.strictEqual(commits, 0, 'first confirmation is not deletion');
    assert.deepStrictEqual(manager.confirm(request.token), { done: true });
    assert.throws(() => manager.confirm(request.token), 'tokens cannot be replayed');
    assert.deepStrictEqual(loadHistory(file).runs.map((r) => r.id), [2, 3], 'deleted rows stay deleted after reopening');

    request = manager.prepare({ scope: 'selected', ids: [2] });
    assert.strictEqual(request.steps, 3, 'bulk mode still has three confirmations for one selected record');
    manager.confirm(request.token);
    assert.throws(() => manager.confirm(request.token, 'DELETE 2'));
    assert.strictEqual(commits, 1);
    assert.strictEqual(manager.confirm(request.token, 'DELETE 1').step, 3);
    assert.strictEqual(commits, 1, 'typing the count is not final deletion');
    manager.confirm(request.token);
    assert.deepStrictEqual(loadHistory(file).runs.map((r) => r.id), [3]);

    // Expiration, new runs during delete-all, and disappearing selected records.
    request = manager.prepare({ scope: 'single', ids: [3] });
    clock += 300001;
    assert.throws(() => manager.confirm(request.token), /expired/);

    request = manager.prepare({ scope: 'all' });
    manager.confirm(request.token);
    manager.confirm(request.token, 'DELETE 1');
    appendRun(file, h, { v: 1, id: 4 });
    assert.throws(() => manager.confirm(request.token), /History changed/);
    assert.deepStrictEqual(h.runs.map((r) => r.id), [3, 4]);

    request = manager.prepare({ scope: 'selected', ids: [3, 4] });
    manager.confirm(request.token);
    manager.confirm(request.token, 'DELETE 2');
    deleteRuns(file, h, [4]);
    assert.throws(() => manager.confirm(request.token), /History changed/);

    // Roll back a partial record deletion if any requested ID is absent on disk.
    assert.throws(() => deleteRuns(file, h, [3, 999]), /History changed/);
    assert.deepStrictEqual(loadHistory(file).runs.map((r) => r.id), [3]);

    appendRun(file, h, { v: 1, id: 6 });
    appendRun(file, h, { v: 1, id: 7 });
    request = manager.prepare({ scope: 'selected', ids: [6, 7] });
    manager.confirm(request.token);
    manager.confirm(request.token, 'DELETE 2');
    manager.confirm(request.token);
    assert.deepStrictEqual(loadHistory(file).runs.map((r) => r.id), [3], 'bulk deletes exactly the selected records');

    // A failed delete-all rolls back earlier row deletions and preserves memory.
    appendRun(file, h, { v: 1, id: 7 });
    let db = new DatabaseSync(file);
    db.exec(`INSERT INTO runs (id, version, summary_json) VALUES (8, 1, '{"v":1,"id":999}');
      CREATE TRIGGER reject_clear BEFORE DELETE ON runs WHEN OLD.id = 7
      BEGIN SELECT RAISE(ABORT, 'fixture delete failure'); END;`);
    db.close();
    h.skipped = loadHistory(file).skipped;
    assert.strictEqual(h.skipped, 1);
    const beforeClear = JSON.stringify(h);
    assert.throws(() => clearHistory(file, h), /fixture delete failure/);
    assert.strictEqual(JSON.stringify(h), beforeClear);
    assert.deepStrictEqual(loadHistory(file), h, 'disk and memory both survive rollback');
    db = new DatabaseSync(file);
    db.exec('DROP TRIGGER reject_clear');
    db.close();
    deleteRuns(file, h, [7]);

    // Delete-all retains the database; unrelated files survive.
    fs.writeFileSync(path.join(dir, 'settings.json'), 'keep');
    request = manager.prepare({ scope: 'all' });
    manager.confirm(request.token);
    manager.confirm(request.token, 'DELETE 1');
    assert.ok(fs.existsSync(file));
    manager.confirm(request.token);
    assert.ok(fs.existsSync(file));
    assert.strictEqual(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), 'keep');
    assert.deepStrictEqual(h, { runs: [], skipped: 0 });
    assert.deepStrictEqual(loadHistory(file), h, 'restart begins with empty history');
    assert.ok(appendRun(file, h, { v: 1, id: 5 }));
    assert.deepStrictEqual(loadHistory(file).runs.map((r) => r.id), [5], 'new runs still save after delete-all');

    // Storage failures consume the final token, so retry needs a fresh review.
    const failing = new HistoryDeletion(
      () => h,
      () => {
        throw new Error('fixture failure');
      },
    );
    request = failing.prepare({ scope: 'single', ids: [5] });
    failing.confirm(request.token);
    assert.throws(() => failing.confirm(request.token), /fixture failure/);
    assert.throws(() => failing.confirm(request.token), /expired/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('test-history-deletion: ok (confirmation counts, cancellation, stale reviews, persistence and transactional clearing)');
  return 0;
}

module.exports = { main };
if (require.main === module) process.exit(main());

