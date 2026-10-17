'use strict';
// app/history.ts: the run history file, in a temp directory.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HISTORY_FILE, loadHistory, appendRun } = require('../../history');

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenswatcher-history-'));
  try {
    const file = path.join(dir, 'nested', HISTORY_FILE);

    // No file yet is an empty history, not an error.
    const h = loadHistory(file);
    assert.deepStrictEqual(h, { runs: [], skipped: 0 });

    const a = { v: 1, id: 1000, result: 'defeat', score: { total: 0, details: [] } };
    const b = { v: 1, id: 2000, result: 'victory', score: null };
    assert.strictEqual(appendRun(file, h, a), true, 'first run written, directory created');
    assert.strictEqual(appendRun(file, h, b), true);
    assert.strictEqual(appendRun(file, h, { ...a }), false, 'a repeated id is dropped');
    assert.strictEqual(appendRun(file, h, { id: 3 }), false, 'a line with no version is not a run');
    assert.strictEqual(appendRun(file, h, null), false);
    assert.strictEqual(h.runs.length, 2);

    let text = fs.readFileSync(file, 'utf8');
    assert.strictEqual(text.split('\n').filter(Boolean).length, 2, 'one line per run');
    assert.deepStrictEqual(loadHistory(file).runs, [a, b], 'oldest first, zero score kept');

    // Appending never rewrites: earlier bytes are unchanged after a third run.
    appendRun(file, h, { v: 1, id: 3000, result: 'defeat' });
    assert.ok(fs.readFileSync(file, 'utf8').startsWith(text));

    // A broken line is skipped and counted, and the rest still loads.
    fs.appendFileSync(file, '{not json\n\n{"v":1}\n' + JSON.stringify({ v: 1, id: 1000 }) + '\n');
    const reloaded = loadHistory(file);
    assert.strictEqual(reloaded.runs.length, 3);
    assert.strictEqual(reloaded.skipped, 2, 'bad JSON and a run without an id');
    text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('{not json'), 'the file is never repaired');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('test-history: ok');
  return 0;
}

module.exports = { main };
if (require.main === module) process.exit(main());
