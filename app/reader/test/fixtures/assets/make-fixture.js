'use strict';
// Writes a small cooked tree that exercises every rule in tables.ts:
//   Item_A     listed, own text, one icon
//   Item_B     listed, no text, references Item_B_Model which has text + icon
//   Item_C     listed, two icons, resolved by ICON_CHOICE (Curse_Stack_Shard_Quest)
//   Item_D     listed, two live definitions under one name that agree (Item_D_Low -> Item_D)
//   Item_Old   NOT listed: same name as Item_A with different text; must be ignored
//   Item_E     listed, description with every markup form clean() handles
// Also the text pair and one version definition.
const fs = require('fs');
const path = require('path');
const { encodeName } = require('../../../../assets/cipher');

function write(root, decodedRel, bytes) {
  const cooked = path.join(root, ...decodedRel.split('/').map(encodeName));
  fs.mkdirSync(path.dirname(cooked), { recursive: true });
  const ids = { Item_A: '00112233445566778899aabbccddeeff', Item_B: '22'.repeat(16),
    Curse_Stack_Shard_Quest: '33'.repeat(16), Item_D: '44'.repeat(16), Item_D_Low: '55'.repeat(16),
    Item_E: '66'.repeat(16), Item_Old: '99'.repeat(16) };
  const short = decodedRel.split('!').pop().split('.')[0];
  if (decodedRel.startsWith('EntitySettings/Objects/') && ids[short]) {
    bytes = Buffer.concat([Buffer.from('2222bbaa', 'hex'), Buffer.from(ids[short], 'hex'),
      Buffer.from([22, 0, 0, 0]), Buffer.from('Dt Magical Object Data'), bytes]);
  }
  fs.writeFileSync(cooked, bytes);
}

function textTable(rows) {
  const parts = [Buffer.alloc(16)];
  const count = Buffer.alloc(4); count.writeUInt32LE(rows.length, 0); parts.push(count);
  for (const r of rows) {
    const s = Buffer.from(r, 'utf8');
    const len = Buffer.alloc(4); len.writeUInt32LE(s.length, 0);
    parts.push(len, s);
  }
  return Buffer.concat(parts);
}

function def(...tokens) {
  // A definition file is opaque binary with the referenced names visible in
  // it; padding bytes around each token stand in for the real structure.
  return Buffer.concat(tokens.flatMap((t) => [Buffer.from([0, 1, 2]), Buffer.from(t, 'latin1'), Buffer.from([0])]));
}

function makeFixture(root) {
  fs.rmSync(root, { recursive: true, force: true });
  const keys = ['Item_A_Name', 'Item_A_Description', 'Item_B_Model_Name', 'Item_B_Model_Description',
    'Curse_Stack_Shard_Quest_Name', 'Item_D_Name', 'Item_D_Description', 'Item_Old_Name', 'Item_E_Name', 'Item_E_Description'];
  const en = ['Adamant', '• +{}% #ARMOR@', 'Golden Egg', 'Lay an &egg~',
    "Devil's Pocket", 'Grimoire of Vitality', '+{0}% $Max Health*', 'Adamant', 'Mad Hat',
    '• Gain {}% &Crit Chance~ ,\nlose - {} $Armor*  ( per hit ) -'];
  write(root, 'Text/Magical_Objects~GAM.xls.LocalText.gen', textTable(keys));
  write(root, 'Text/Magical_Objects~GAM.xls.LocalText.gen.LangEN', textTable(en));

  const D = 'EntitySettings/Objects/Magical_Objects!Legendary!';
  write(root, D + 'Item_A.entity.ot.EntitySettingsResource.gen', def('Item_A_Name', 'Item_A_Description', 'Icon_Object_A.png'));
  write(root, D + 'Item_B.entity.ot.EntitySettingsResource.gen', def('Item_B_Model.entity.ot'));
  write(root, D + 'Item_B_Model.entity.ot.EntitySettingsResource.gen', def('Item_B_Model_Name', 'Item_B_Model_Description', 'Icon_Object_B.png', 'Icon_Object_B_Disabled.png'));
  write(root, D + 'Curse_Stack_Shard_Quest.entity.ot.EntitySettingsResource.gen', def('Curse_Stack_Shard_Quest_Name', 'Icon_Devil_Pocket_Full.png', 'Icon_Devil_Pocket_Empty.png'));
  write(root, D + 'Item_D.entity.ot.EntitySettingsResource.gen', def('Item_D_Name', 'Item_D_Description', 'UI_Object_D.png'));
  write(root, D + 'Item_D_Low.entity.ot.EntitySettingsResource.gen', def('Item_D.entity.ot'));
  write(root, D + 'Item_Old.entity.ot.EntitySettingsResource.gen', def('Item_Old_Name', 'Icon_Object_Old.png'));
  write(root, D + 'Item_E.entity.ot.EntitySettingsResource.gen', def('Item_E_Name', 'Item_E_Description'));

  const listed = ['Item_A', 'Item_B', 'Curse_Stack_Shard_Quest', 'Item_D', 'Item_D_Low', 'Item_E']
    .map((n) => `Objects\\Magical_Objects\\Legendary\\${n}.entity.ot`);
  write(root, 'Definitions/Versions/Fixture1.versiondef.ot.VersionDefinition.gen', def(...listed));
}

module.exports = { makeFixture };
if (require.main === module) makeFixture(process.argv[2]);
