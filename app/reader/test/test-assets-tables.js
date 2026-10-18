'use strict';
// tables.ts against the synthetic cooked tree from fixtures/assets.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeFixture } = require('./fixtures/assets/make-fixture');
const { buildTables, clean, itemKey, parseTextTable } = require('../../assets/tables');
const { encodeName } = require('../../assets/cipher');

const ICONS = new Map([
  ['Objects/Icon_Object_A.png', 'item_a.png'],
  ['Objects/Icon_Object_B.png', 'item_b.png'],
  ['Objects/Icon_Devil_Pocket_Full.png', 'item_devil_pocket_full.png'],
  ['Objects/UI_Object_D.png', 'item_d.png'],
]);

function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-tables-'));
  try {
    makeFixture(root);
    const t = buildTables(root, ICONS);

    assert.deepStrictEqual(t.ITEM_NAMES, {
      adamant: 'Adamant', goldenegg: 'Golden Egg', devilpocket: "Devil's Pocket",
      grimoirevitality: 'Grimoire of Vitality', madhat: 'Mad Hat',
    });
    assert.deepStrictEqual(t.SHOP_ICONS, {
      adamant: 'item_a.png', goldenegg: 'item_b.png', devilpocket: 'item_devil_pocket_full.png',
      grimoirevitality: 'item_d.png',
    });
    assert.strictEqual(t.ITEM_TEXT.adamant, '+ARMOR');
    assert.strictEqual(t.ITEM_TEXT.goldenegg, 'Lay an egg');
    assert.strictEqual(t.ITEM_TEXT.grimoirevitality, '+Max Health');
    assert.strictEqual(t.ITEM_TEXT.madhat, 'Gain Crit Chance,\nlose -Armor (per hit)');
    assert.ok(!('devilpocket' in t.ITEM_TEXT));
    assert.strictEqual(t.OBJECT_KEYS['00112233445566778899aabbccddeeff'], 'adamant', 'raw GUID order');
    assert.strictEqual(t.OBJECT_RARITIES['00112233445566778899aabbccddeeff'], 'Legendary');
    assert.strictEqual(t.OBJECT_KEYS['22'.repeat(16)], 'goldenegg', 'variant identity joins inherited art');
    assert.strictEqual(t.OBJECT_KEYS['55'.repeat(16)], 'grimoirevitality');
    assert.ok(!t.OBJECT_KEYS['99'.repeat(16)], 'unlisted definitions cannot leak into the GUID map');

    // Two live definitions under one name that disagree stop the build.
    const D = path.join(root, encodeName('EntitySettings'), encodeName('Objects'));
    fs.writeFileSync(path.join(D, encodeName('Magical_Objects!Legendary!Item_D_Low.entity.ot.EntitySettingsResource.gen')),
      Buffer.from('\0Item_D_Name\0Item_A_Description\0UI_Object_D.png\0', 'latin1'));
    assert.throws(() => buildTables(root, ICONS), /Grimoire of Vitality.*disagree/);

    // An icon with no manifest row names the row to add.
    makeFixture(root);
    const fewer = new Map(ICONS); fewer.delete('Objects/UI_Object_D.png');
    assert.throws(() => buildTables(root, fewer), /Objects\/UI_Object_D\.png/);

    // Text table: trailing bytes are a layout change, not slack.
    assert.throws(() => parseTextTable(Buffer.concat([Buffer.alloc(20), Buffer.from([1])]), 'x.gen'), /x\.gen.*1 trailing/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  assert.strictEqual(itemKey('Ring of Dispel'), 'ringdispel');
  assert.strictEqual(itemKey('Bloody Mary’s Mirror'), 'bloodymarymirror');
  assert.strictEqual(clean('• +{}% #ARMOR@'), '+ARMOR');
  assert.strictEqual(clean('Deals {0} DMG -'), 'Deals DMG');
  console.log('test-assets-tables: ok');
}

module.exports = { main };
if (require.main === module) main();
