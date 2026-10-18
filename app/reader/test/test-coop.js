'use strict';
// Unit tests for readState() coop calculation based on Game Session Size.
//
// Acceptance criteria:
// - size unresolved -> coop: false
// - size 0 -> coop: false
// - size 1 -> coop: false
// - size 2 -> coop: true
// - size > 2 -> coop: true

const { readState, GAME_SESSION_SIZE, TRACKED_NAMES } = require('../state');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

function main() {
  console.log('\ntest-coop: Game Session Size and coop flag');

  check('GAME_SESSION_SIZE is defined and in TRACKED_NAMES',
    GAME_SESSION_SIZE === 'Game Session Size' && TRACKED_NAMES.includes(GAME_SESSION_SIZE));

  // 1. Unresolved: missing key in values
  const unresMissing = readState(null, { values: {} });
  check('unresolved (missing key) yields coop: false',
    unresMissing.coop === false);

  // 2. Unresolved: null value
  const unresNull = readState(null, { values: { [GAME_SESSION_SIZE]: null } });
  check('unresolved (null) yields coop: false',
    unresNull.coop === false);

  // 3. Unresolved: undefined value
  const unresUndefined = readState(null, { values: { [GAME_SESSION_SIZE]: undefined } });
  check('unresolved (undefined) yields coop: false',
    unresUndefined.coop === false);

  // 4. Live source with null reading
  const liveUnresolved = {
    get: (n) => (n === GAME_SESSION_SIZE ? null : 0),
    maps: () => ({}),
  };
  const liveUnresState = readState(liveUnresolved);
  check('live source unresolved yields coop: false',
    liveUnresState.coop === false);

  // 5. Size 0 (menu / solo lobby before start)
  const size0 = readState(null, { values: { [GAME_SESSION_SIZE]: 0 } });
  check('size 0 yields coop: false',
    size0.coop === false);

  const liveSize0 = {
    get: (n) => (n === GAME_SESSION_SIZE ? 0 : null),
    maps: () => ({}),
  };
  check('live source size 0 yields coop: false',
    readState(liveSize0).coop === false);

  // 6. Size 1 (solo run)
  const size1 = readState(null, { values: { [GAME_SESSION_SIZE]: 1 } });
  check('size 1 yields coop: false',
    size1.coop === false);

  const liveSize1 = {
    get: (n) => (n === GAME_SESSION_SIZE ? 1 : null),
    maps: () => ({}),
  };
  check('live source size 1 yields coop: false',
    readState(liveSize1).coop === false);

  // 7. Size 2 (two-player co-op)
  const size2 = readState(null, { values: { [GAME_SESSION_SIZE]: 2 } });
  check('size 2 yields coop: true',
    size2.coop === true);

  const liveSize2 = {
    get: (n) => (n === GAME_SESSION_SIZE ? 2 : null),
    maps: () => ({}),
  };
  check('live source size 2 yields coop: true',
    readState(liveSize2).coop === true);

  // 8. Size 3 and 4 (three and four player co-op)
  const size3 = readState(null, { values: { [GAME_SESSION_SIZE]: 3 } });
  check('size 3 yields coop: true',
    size3.coop === true);

  const size4 = readState(null, { values: { [GAME_SESSION_SIZE]: 4 } });
  check('size 4 yields coop: true',
    size4.coop === true);

  // 9. coop field is present and enumerable in output JSON
  const serialized = JSON.parse(JSON.stringify(size2));
  check('coop survives serialization to JSON wire frame',
    serialized.coop === true && typeof serialized.coop === 'boolean');

  return failures;
}

if (require.main === module) {
  const f = main();
  process.exit(f ? 1 : 0);
}

module.exports = { main };
