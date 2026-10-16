'use strict';
// The placement channel, against test/fakegame.js: a planted resource object
// with an entity pointing at it, a second with none, and a decoy pointer whose
// owner is not an entity.
//
// Ravenswatch.exe is not attached to. What this covers: the NUL-terminated
// string sweep, the walk from path string to resource object to owning entity,
// entity counting, and the loaded-but-not-placed case that resource-path
// presence alone cannot tell apart.

const { spawn } = require('child_process');
const path = require('path');
const { openProcess } = require('../win32');
const { scanStrings } = require('../scan');
const { placedAmong } = require('../placement');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

function run(info) {
  console.log(`\ntest-placement: fake heap in pid ${info.pid}`);
  const proc = openProcess(info.pid);
  const p = info.placement;

  const found = scanStrings(proc, [p.placedPath, p.loadedPath, 'Nothing\\Like\\This.entity.ot']);
  check('placed path string found', (found.get(p.placedPath) || []).length >= 1,
    `${(found.get(p.placedPath) || []).length} hit(s)`);
  check('loaded path string found too -- residency proves nothing',
    (found.get(p.loadedPath) || []).length >= 1);
  check('absent needle returns empty',
    (found.get('Nothing\\Like\\This.entity.ot') || []).length === 0);

  // The vtable memo is normally filled from RTTI. fakegame has no PE, so seed
  // it with the planted entity vtable as an RVA -- the same shape
  // resolveAllVtableRvas returns.
  const cache = { entity: [info.entityVt - info.base] };
  const placed = placedAmong(proc, info.base,
    [p.placedPath, p.loadedPath, p.deepPath], cache);

  check('placedAmong returned a map', placed instanceof Map);
  check('placed path is present with both its entities',
    placed.get(p.placedPath) === 2, `got ${placed.get(p.placedPath)}`);
  check('loaded-but-unplaced path is absent -- a non-entity pointer is not placement',
    placed.get(p.loadedPath) === undefined);
  check('triple near the far edge of the window still resolves',
    placed.get(p.deepPath) === 1, `got ${placed.get(p.deepPath)}`);

  const none = placedAmong(proc, info.base, ['Nothing\\Like\\This.entity.ot'], cache);
  check('absent path yields an empty map', none instanceof Map && none.size === 0);

  proc.close();
  return failures;
}

function main() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'fakegame.js')],
      { stdio: ['ignore', 'pipe', 'inherit'] });
    let acc = '';
    child.stdout.on('data', (d) => {
      acc += d;
      if (!acc.includes('\n')) return;
      const info = JSON.parse(acc.split('\n')[0]);
      let f;
      try { f = run(info); } finally { child.kill(); }
      resolve(f);
    });
  });
}

if (require.main === module) main().then(f => process.exit(f ? 1 : 0));
module.exports = { main };
