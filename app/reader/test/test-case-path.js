// The case-insensitive path resolver: disk casing is returned, misses fall through, the listing is cached.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CaseResolver } = require('../../assets/case-path');

const FILE = 'Icons!High!X.png.Texture.dxt';

function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-case-path-'));
  try {
    const cooking = path.join(root, 'DarkTalesResources', '_Cooking');
    const minimap = path.join(cooking, 'Ui', 'MiniMap');
    fs.mkdirSync(minimap, { recursive: true });
    fs.writeFileSync(path.join(minimap, FILE), 'x');

    const onDisk = path.join(root, 'DarkTalesResources', '_Cooking', 'Ui', 'MiniMap', FILE);
    const lower = ['darktalesresources', '_cooking', 'ui', 'minimap', FILE.toLowerCase()];
    const r = new CaseResolver({ platform: 'linux' });

    // Lower-case segments come back in the casing the disk has.
    assert.strictEqual(r.resolve(root, lower), onDisk);
    assert.strictEqual(r.resolve(root, lower.slice(0, 3)), path.join(root, 'DarkTalesResources', '_Cooking', 'Ui'));

    // An exact-case request comes back unchanged.
    assert.strictEqual(r.resolve(root, ['DarkTalesResources', '_Cooking', 'Ui', 'MiniMap', FILE]), onDisk);

    // A missing segment is appended as given, and so is everything after it.
    const missing = r.resolve(root, ['darktalesresources', 'Nope', 'Deeper', 'File.dxt']);
    assert.strictEqual(missing, path.join(root, 'DarkTalesResources', 'Nope', 'Deeper', 'File.dxt'));
    assert.strictEqual(r.resolve(root, ['nothere', 'x']), path.join(root, 'nothere', 'x'));

    // The listing is read once per directory. Rename MiniMap on disk: the old
    // resolver still answers from its cache, a fresh one sees the new name.
    const cachedBefore = r.resolve(root, ['darktalesresources', '_cooking', 'ui', 'minimap']);
    assert.strictEqual(cachedBefore, path.join(root, 'DarkTalesResources', '_Cooking', 'Ui', 'MiniMap'));
    fs.renameSync(minimap, path.join(cooking, 'Ui', 'MiniMapRenamed'));
    assert.strictEqual(r.resolve(root, ['darktalesresources', '_cooking', 'ui', 'minimap']), cachedBefore);
    const fresh = new CaseResolver({ platform: 'linux' });
    assert.strictEqual(
      fresh.resolve(root, ['darktalesresources', '_cooking', 'ui', 'minimaprenamed']),
      path.join(root, 'DarkTalesResources', '_Cooking', 'Ui', 'MiniMapRenamed'),
    );

    // On win32 the segments are joined as given, with no filesystem lookup.
    const win = new CaseResolver({ platform: 'win32' });
    assert.strictEqual(
      win.resolve(root, lower),
      path.join(root, ...lower),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log('test-case-path: ok');
  return 0;
}
module.exports = { main };
if (require.main === module) process.exit(main());
