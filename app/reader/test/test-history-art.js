// Synthetic cooked references; no game install or live process involved.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildHistoryArt } = require('../../assets/history-art');
const { encodeName } = require('../../assets/cipher');
function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-history-art-'));
  const write = (rel, b) => {
    const p = path.join(root, ...rel.split('/').map(encodeName));
    fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, b);
  };
  const component = (name, body) => {
    const length = Buffer.alloc(4); length.writeUInt32LE(Buffer.byteLength(name));
    return Buffer.concat([Buffer.from('2222bbaa', 'hex'), Buffer.alloc(16, 0x5a), length,
      Buffer.from(name), Buffer.from(body)]);
  };
  try {
    assert.deepStrictEqual(buildHistoryArt(root).rows, []);
    for (const hero of ['Fixture', 'Other']) {
      write(`Definitions/Heroes/${hero === 'Other' ? 'Other_Code' : hero}.herodef.ot.DtHeroDefinition.gen`, Buffer.from(`Heroes\\Hero_${hero}\\Hero_${hero}_Default.entity.ot\0Heroes\\${hero}\\Portrait_${hero}.png`));
      write(`EntitySettings/Heroes/Hero_${hero}!Hero_${hero}.entity.ot.EntitySettingsResource.gen`, Buffer.concat([
        component('Skill Controller Fixture', `Heroes\\${hero}\\Skill Fixture.png`),
        component('Other Component', `Heroes\\${hero}\\Decoy.png`),
        component('Skill Controller Unknown', ''),
      ]));
    }
    for (let i = 0; i <= 3; i++) write(`Ui/Common/Difficulty Icons!Icon_NewDifficulty_${i}.png.Texture.dxt`, Buffer.alloc(0));
    const art = buildHistoryArt(root);
    assert.strictEqual(art.rows.length, 8, 'two portraits, two skills, four difficulties; no unrelated component art');
    assert.notStrictEqual(art.tables.TALENT_ICONS.Fixture['Skill Controller Fixture'], art.tables.TALENT_ICONS.Other_Code['Skill Controller Fixture'], 'internal skill keys are scoped to their hero');
    assert.ok(!art.tables.TALENT_ICONS.Fixture['Skill Controller Unknown']);
    const paths = new Map(art.rows.map(r => [r.asset, r.uiPath]));
    assert.strictEqual(paths.get(art.tables.HERO_ICONS.Fixture), 'Heroes/Fixture/Portrait_Fixture.png');
    assert.strictEqual(paths.get(art.tables.TALENT_ICONS.Fixture['Skill Controller Fixture']), 'Heroes/Fixture/Skill Fixture.png');
    for (let i = 0; i <= 3; i++) assert.strictEqual(paths.get(art.tables.DIFFICULTY_ICONS[i]), `Common/Difficulty Icons/Icon_NewDifficulty_${i}.png`);
    assert.deepStrictEqual(buildHistoryArt(root), art, 'cache names are stable');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log('test-history-art: ok');
}
module.exports = { main };
if (require.main === module) main();
