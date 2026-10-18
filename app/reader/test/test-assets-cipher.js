'use strict';
// The resource-name cipher, against the sixteen top-level cooked folders the
// spec's appendix lists, and against the install when it is present.
const assert = require('assert');
const fs = require('fs');
const { decodeName, encodeName } = require('../../assets/cipher');
const { findInstall, cookingDir } = require('./install-path');

const TOP = {
  '3N': '3D', Ddtqr: 'Video', Gdyniv: 'Lights', Hgiqudglv: 'Materials', Jd: 'Ui',
  KlraglDglwqv: 'GlobalValues', MzidisFqiidzyv: 'EntitySettings', Nqhdzdidrzv: 'Definitions',
  Oi: 'Ot', Qqpi: 'Text', TrviVp: 'PostFx', VZ: 'FX', Vrziv: 'Fonts', Wwtdr: 'Audio',
  vgxjlqv: 'samples', vngtquv: 'shaders',
};

function main() {
  for (const [cooked, decoded] of Object.entries(TOP)) {
    assert.strictEqual(decodeName(cooked), decoded);
    assert.strictEqual(encodeName(decoded), cooked);
  }
  assert.strictEqual(encodeName('Text/Magical_Objects~GAM.xls.LocalText.gen.LangEN'),
    'Qqpi/Hgydbgl_Oacqbiv~KWH.plv.GrbglQqpi.yqz.GgzyMU');
  assert.strictEqual(decodeName('Oacqbiv!Hgt_Agi_Vqqtagbm_Xbrz.jzy.Qqpiwuq.tpi'),
    'Objects!Mad_Hat_Feedback_Icon.png.Texture.dxt');

  const install = findInstall();
  if (install) {
    // TOP is a folder census. Extra files at the cooking root are not
    // resource folders and must not be compared against those sixteen names.
    const names = fs.readdirSync(cookingDir(install), { withFileTypes: true })
      .filter(entry => entry.isDirectory()).map(entry => decodeName(entry.name)).sort();
    assert.deepStrictEqual(names, Object.values(TOP).sort());
    console.log('test-assets-cipher: ok (install checked)');
  } else {
    console.log('test-assets-cipher: ok (no install found; skipped the on-disk check)');
  }
}

module.exports = { main };
if (require.main === module) main();
