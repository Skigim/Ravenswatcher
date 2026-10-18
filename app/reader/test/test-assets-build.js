'use strict';
// buildAssets against the tables fixture plus hand-built textures: writes
// icons/ and tables.json, replaces the cache atomically, and leaves an
// existing cache untouched when a row fails.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeFixture } = require('./fixtures/assets/make-fixture');
const { buildAssets, readManifest, texturePath } = require('../../assets/build');
const { encodeName } = require('../../assets/cipher');

function rgba8Container(width, height, pixels) {
  const head = Buffer.alloc(0x40);
  head.writeUInt32LE(0xaabb1111, 0x08);
  head.writeUInt32LE(0xaabb2222, 0x20); // decoy
  const rec = Buffer.alloc(0x28);
  rec.writeUInt32LE(0xaabb2222, 0x00);
  rec.writeUInt32LE(width, 0x10); rec.writeUInt32LE(height, 0x14);
  rec.writeUInt32LE(0, 0x1c);
  rec.writeUInt32LE(pixels.length, 0x20); rec.writeUInt32LE(pixels.length, 0x24);
  return Buffer.concat([head, rec, pixels]);
}

function writeCooked(cooking, decodedRel, bytes) {
  const p = path.join(cooking, ...decodedRel.split('/').map(encodeName));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, bytes);
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-build-'));
  const install = path.join(tmp, 'install');
  const cooking = path.join(install, 'DarkTalesResources', '_Cooking');
  const cacheDir = path.join(tmp, 'cache');
  const manifest = path.join(tmp, 'SOURCES.tsv');
  try {
    makeFixture(cooking);
    writeCooked(cooking, 'Ui/Objects/Icon_Object_A.png.Texture.dxt', rgba8Container(1, 1, Buffer.from([10, 20, 30, 255])));
    writeCooked(cooking, 'Ui/MiniMap/Icons!High!Minimap_IconHigh_Chest.png.Texture.dxt', rgba8Container(2, 1, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])));
    fs.writeFileSync(manifest, [
      '# comment', 'asset\tui_png_path\tsha1\tbytes',
      'item_a.png\tObjects/Icon_Object_A.png\tdeadbeef\t1',
      'map_chest.png\tMiniMap/Icons/High/Minimap_IconHigh_Chest.png\tdeadbeef\t1',
      'item_b.png\tObjects/Icon_Object_B.png\tdeadbeef\t1',
      'item_devil_pocket_full.png\tObjects/Icon_Devil_Pocket_Full.png\tdeadbeef\t1',
      'item_d.png\tObjects/UI_Object_D.png\tdeadbeef\t1',
    ].join('\n') + '\n');
    for (const uiPath of ['Objects/Icon_Object_B.png', 'Objects/Icon_Devil_Pocket_Full.png', 'Objects/UI_Object_D.png']) {
      writeCooked(cooking, texturePath(uiPath), rgba8Container(1, 1, Buffer.from([0, 0, 0, 0])));
    }

    assert.strictEqual(texturePath('MiniMap/Icons/High/Minimap_IconHigh_Chest.png'), 'Ui/MiniMap/Icons!High!Minimap_IconHigh_Chest.png.Texture.dxt');
    assert.deepStrictEqual(readManifest(manifest)[0], { asset: 'item_a.png', uiPath: 'Objects/Icon_Object_A.png' });

    writeCooked(cooking, 'Definitions/Heroes/Fixture.herodef.ot.DtHeroDefinition.gen', Buffer.from('Heroes\\Fixture\\Portrait_Fixture.png'));
    writeCooked(cooking, 'Ui/Heroes/Fixture!Portrait_Fixture.png.Texture.dxt', rgba8Container(1, 1, Buffer.from([1, 2, 3, 255])));
    const tables = buildAssets({ installDir: install, cacheDir, manifestPath: manifest });
    assert.strictEqual(tables.ITEM_NAMES.adamant, 'Adamant');
    const icons = fs.readdirSync(path.join(cacheDir, 'icons')).sort();
    assert.deepStrictEqual(icons, [tables.HERO_ICONS.Fixture, 'item_a.png', 'item_b.png', 'item_d.png', 'item_devil_pocket_full.png', 'map_chest.png'].sort());
    assert.ok(tables.HERO_ICONS.Fixture.startsWith('history_'), 'portrait goes through the shared icon cache');
    const png = fs.readFileSync(path.join(cacheDir, 'icons', 'item_a.png'));
    assert.deepStrictEqual([...png.subarray(1, 4)], [80, 78, 71]);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(cacheDir, 'tables.json'), 'utf8')), tables);
    assert.ok(!fs.existsSync(cacheDir + '.tmp'), 'temp directory left behind');

    // A failing row leaves the previous cache in place.
    fs.appendFileSync(manifest, 'missing.png\tObjects/Nope.png\tx\t1\n');
    assert.throws(() => buildAssets({ installDir: install, cacheDir, manifestPath: manifest }), /Objects\/Nope\.png/);
    assert.deepStrictEqual(fs.readdirSync(path.join(cacheDir, 'icons')).sort(), icons);
    assert.ok(!fs.existsSync(cacheDir + '.tmp'), 'temp directory left behind after a failure');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log('test-assets-build: ok');
}

module.exports = { main };
if (require.main === module) main();
