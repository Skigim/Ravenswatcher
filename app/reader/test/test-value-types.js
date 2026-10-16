'use strict';
// Bundled metadata, synthetic .gen parsing, and partial-tree merging.
// No private files, Python, or game process are involved.
const fs = require('fs');
const path = require('path');
const values = require('../values');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

function main() {
  console.log('\ntest-value-types: .gen type parsing and the merge policy');

  const json = JSON.parse(fs.readFileSync(values.VALUE_TYPES_JSON, 'utf8'));
  check('bundled value_types.json loads', Object.keys(json).length > 100,
    `${Object.keys(json).length} mappings`);

  const assert = require('assert');
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-gen-test-'));
  const record = (name, scope, tag) => {
    const str = text => {
      const b = Buffer.from(text, 'latin1');
      const len = Buffer.alloc(4); len.writeUInt32LE(b.length);
      return Buffer.concat([len, b]);
    };
    const tail = Buffer.alloc(12); tail.writeUInt32LE(0xaabb1111); tail.writeUInt32LE(tag, 8);
    return Buffer.concat([str(name), str(scope), tail]);
  };
  try {
    for (const [name, tag] of [['Synthetic Float', 0], ['Hero Level', 2], ['Synthetic Bool', 2]]) {
      const data = record(name, '', tag);
      assert.deepStrictEqual(values.parseGenType(data), [name, tag]);
      fs.writeFileSync(path.join(tmp, `${tag}-${name}.gen`), data);
    }
    assert.deepStrictEqual(values.parseGenType(Buffer.alloc(4)), [null, null]);
    const parsed = values.typesFromGen(tmp);
    assert.deepStrictEqual(parsed, { 'Synthetic Float': 0, 'Hero Level': 2, 'Synthetic Bool': 2 });
    // Exercise the actual merge in a fresh process (valueTypes caches).
    const { execFileSync } = require('child_process');
    const merged = JSON.parse(execFileSync(process.execPath, ['-e',
      `console.log(JSON.stringify(require(${JSON.stringify(require.resolve('../values'))}).valueTypes()))`], {
      env: { ...process.env, RAVENSWATCH_GEN_ROOT: tmp, RAVENSWATCH_VALUE_TYPES: values.VALUE_TYPES_JSON },
      encoding: 'utf8',
    }));
    assert.strictEqual(merged['Hero Level'], 2, 'explicit .gen overrides bundled metadata');
    assert.strictEqual(merged['Is In Combat'], json['Is In Combat'], 'partial tree preserves JSON entries');
    assert.strictEqual(merged['Synthetic Float'], 0);
    check('synthetic .gen parsing and partial-tree merge', true);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  // The merge is a merge, not a choice: a partial tree must not shadow the
  // complete JSON, and the tree must still win per name.
  const merged = values.valueTypes();
  const missing = Object.keys(json).filter(k => !(k in merged));
  check('valueTypes() covers every bundled name (merge, not choose)',
    missing.length === 0, missing.slice(0, 5).join(', '));
  check('known types are right',
    merged['Hero Level'] === values.TYPE_INT
    && merged['Is In Combat'] === values.TYPE_BOOL
    && merged.Giant_Tree_HP_Ratio === values.TYPE_FLOAT,
    `Hero Level=${values.TYPE_NAMES[merged['Hero Level']]}, `
    + `Is In Combat=${values.TYPE_NAMES[merged['Is In Combat']]}, `
    + `Giant_Tree_HP_Ratio=${values.TYPE_NAMES[merged.Giant_Tree_HP_Ratio]}`);

  // asFloat must be a bit reinterpretation, not a conversion.
  check('asFloat reinterprets the bit pattern',
    Math.abs(values.asFloat(0x3F23D70A) - 0.64) < 1e-6 && values.asFloat(null) === null,
    String(values.asFloat(0x3F23D70A)));
  return failures;
}

if (require.main === module) process.exit(main() ? 1 : 0);
module.exports = { main };
