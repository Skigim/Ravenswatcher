'use strict';
// The zip carries no decoded game content. Stages into a temp directory
// through the real script and inspects what landed under web/.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

function main() {
  const appDir = path.join(__dirname, '..', '..');
  assert.ok(!fs.readdirSync(path.join(appDir, 'web', 'assets')).some(name => name.endsWith('.png')),
    'decoded game PNG in source tree');
  assert.ok(!fs.existsSync(path.join(appDir, 'web', 'item-text.js')), 'game description table in source tree');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-stage-'));
  try {
    const res = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'stage-dist.js')], {
      env: { ...process.env, STAGE_DIR: stage }, encoding: 'utf8',
    });
    assert.strictEqual(res.status, 0, `stage-dist failed:\n${res.stdout}\n${res.stderr}`);
    const web = walk(path.join(stage, 'web')).map((p) => path.relative(stage, p).replace(/\\/g, '/'));
    const pngs = web.filter((p) => p.endsWith('.png'));
    assert.strictEqual(pngs.length, 0, `PNG in stage: ${pngs.join(', ')}`);
    assert.ok(!web.includes('web/item-text.js') && !web.includes('web/item-icons.js'), 'generated tables in stage');
    assert.ok(web.includes('web/assets/SOURCES.tsv'), 'manifest missing from stage');
    for (const name of ['GermaniaOne-Regular.ttf', 'GermaniaOne-OFL.txt', 'AlegreyaSans-Regular.ttf', 'AlegreyaSans-Bold.ttf', 'AlegreyaSans-OFL.txt']) {
      assert.ok(web.includes('web/assets/fonts/' + name), 'offline font or license missing: ' + name);
    }
    assert.ok(fs.existsSync(path.join(stage, 'assets', 'build.js')), 'assets/build.js missing from stage');
    assert.ok(fs.existsSync(path.join(stage, 'assets', 'build-worker.js')), 'assets/build-worker.js missing from stage');
    assert.ok(fs.existsSync(path.join(stage, 'THIRD_PARTY_NOTICES.md')), 'notices missing from stage');
    assert.strictEqual(fs.readFileSync(path.join(stage, 'LICENSE'), 'utf8'),
      fs.readFileSync(path.join(__dirname, '..', '..', '..', 'LICENSE'), 'utf8'), 'MIT license missing from stage');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(stage, 'value_types.json'), 'utf8')),
      JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'value_types.json'), 'utf8')), 'bundled type metadata differs');
    for (const file of ['share.js','web/share.html','web/share.js','web/share.css','web/typography.css','web/run-presentation.js']) assert.ok(fs.existsSync(path.join(stage,file)), 'share runtime missing: '+file);
    assert.ok(fs.existsSync(path.join(stage, 'update.js')), 'update.js missing from stage');
    for (const file of ['lifecycle.js', 'reader/worker-control.js']) {
      assert.ok(fs.existsSync(path.join(stage, file)), 'lifecycle runtime missing: ' + file);
    }
    assert.strictEqual(fs.readFileSync(path.join(stage, 'web', 'share.js'), 'utf8'),
      fs.readFileSync(path.join(appDir, 'web', 'share.js'), 'utf8'), 'staging preserves readable runtime source');
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  console.log('test-no-shipped-content: ok');
}

module.exports = { main };
if (require.main === module) main();
