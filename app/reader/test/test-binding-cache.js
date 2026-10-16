'use strict';
// The values index is built once and kept across sweeps; this is the rule
// for when the sweep pays for another buildIndex(). Four signals and no
// others -- see indexRebuildDue in sweeper.js for why each one exists.
//
// Nothing here attaches to a process. The rule is a pure function of what
// the sweep already knows, which is the point: an invalidation that needed
// its own poll would just be a second full-cost operation.

const { indexRebuildDue } = require('../sweeper');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

const ALL_OK = ['ok', 'ok', 'ok'];

function main() {
  failures = 0;
  console.log('\n--- test-binding-cache: indexRebuildDue ---');

  check('no index yet -> rebuild',
    indexRebuildDue(false, [], false, false) === true);
  check('stable, fully resolved, same map, same run -> hold the index',
    indexRebuildDue(true, ALL_OK, false, false) === false);
  check('one binding reads stale -> rebuild',
    indexRebuildDue(true, ['ok', 'stale-binding', 'ok'], false, false) === true);
  check('one binding object not found -> rebuild',
    indexRebuildDue(true, ['ok', 'binding object not found'], false, false) === true);
  check('one settings instance not found -> rebuild',
    indexRebuildDue(true, ['settings instance not found', 'ok'], false, false) === true);
  check('index built but nothing resolved (main menu) -> rebuild',
    indexRebuildDue(true, ['binding object not found', 'binding object not found'], false, false) === true);
  check('map changed -> rebuild',
    indexRebuildDue(true, ALL_OK, true, false) === true);
  check('run reset -> rebuild',
    indexRebuildDue(true, ALL_OK, false, true) === true);

  if (failures > 0) {
    console.error(`\ntest-binding-cache: ${failures} check(s) failed`);
    return 1;
  }
  console.log('\ntest-binding-cache: all passed');
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { main };
