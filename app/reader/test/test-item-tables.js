'use strict';
// Resource-name regression cases keep renderer keys and runtime keys aligned.
// Synthetic cooked-resource decoding is covered by test-assets-tables.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { itemKey } = require('../../web/run-presentation');
const { itemKey: runtimeKey } = require('../../assets/tables');
const { readManifest } = require('../../assets/build');

const WEB = path.join(__dirname, '..', '..', 'web');

function main() {
  const { ITEM_TEXT, SHOP_ICONS, ITEM_NAMES } = require('./fixtures/item-tables');

  // The Python side keyed ITEM_NAMES; the JS side must reach the same key
  // from the same display name, or a live offer misses both tables.
  for (const [key, name] of Object.entries(ITEM_NAMES)) {
    assert.strictEqual(itemKey(name), key, `itemKey(${JSON.stringify(name)})`);
  }
  // The one name the game spells with U+2019, and the ASCII form it must
  // equal. A regression here is invisible in the table diff.
  assert.strictEqual(itemKey('Bloody Mary’s Mirror'), itemKey("Bloody Mary's Mirror"));
  assert.strictEqual(itemKey('Bloody Mary’s Mirror'), 'bloodymarymirror');

  // Every text row has an icon and every icon has a name; every icon names a
  // file that ships.
  for (const key of Object.keys(ITEM_TEXT)) {
    assert.ok(key in SHOP_ICONS, `ITEM_TEXT has ${key} but SHOP_ICONS does not`);
  }
  const manifestPath = path.join(WEB, 'assets', 'SOURCES.tsv');
  const manifest = readManifest(manifestPath);
  const assets = new Set(manifest.map((r) => r.asset));
  for (const [key, file] of Object.entries(SHOP_ICONS)) {
    assert.ok(key in ITEM_NAMES, `SHOP_ICONS has ${key} but ITEM_NAMES does not`);
    assert.ok(assets.has(file), `${key}: ${file} has no manifest row`);
  }
  // The runtime's key function is app.js's, over every shipped name.
  for (const [key, name] of Object.entries(ITEM_NAMES)) {
    assert.strictEqual(runtimeKey(name), key, `tables.ts itemKey(${JSON.stringify(name)})`);
  }

  // The items that were missing or wrong before the tables came from the
  // definitions, pinned so a regenerate against stale data is caught.
  assert.strictEqual(SHOP_ICONS[itemKey("Baba Yaga's Mortar")], 'item_baba_mortar.png');
  assert.strictEqual(SHOP_ICONS[itemKey('Seven-league Boots')], 'item_seven_league_boots.png');
  assert.strictEqual(SHOP_ICONS[itemKey('Fast-walker Boots')], 'item_fast_walker_boots.png');
  assert.strictEqual(SHOP_ICONS[itemKey("Devil's Pocket")], 'item_devil_pocket_full.png');
  assert.ok(!(itemKey('Carnwennan') in SHOP_ICONS), 'a cut item is in the icon table');
  console.log(`test-item-tables: ok (${Object.keys(SHOP_ICONS).length} resource-name cases)`);

}

module.exports = { main };
if (require.main === module) main();
