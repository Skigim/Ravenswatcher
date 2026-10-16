'use strict';
// Positive control for the residency half of the marker check.
//
// The probe and the app share a code path, so neither can be the other's
// second opinion. What CAN be established without leaving that path is
// whether the check discriminates at all: feed it a path known to be wrong
// and a path known to be right, and see whether it says different things.
//
// A check that returns the same verdict for both is measuring nothing.

const { openProcess, findPid, moduleBase } = require('../win32');
const { scanStrings, scanPointers } = require('../scan');
const { MARKER_PATHS, PROCESS_NAME } = require('../state');

// Known-bad: the Roc path as it stood before the fix, one directory level
// short. The game never loads this string.
const OLD_ROC = 'Storm_Island\\Quest_Roc\\Roc_Quest_Manager.entity.ot';
// Known-real but never placed: the manager the fix stopped keying Roc on.
const ROC_MANAGER = 'Storm_Island\\Quest_Sinbad\\Quest_Roc\\Roc_Quest_Manager.entity.ot';
// Invented. Correct shape, correct prefix, no such entity.
const FAKE = 'Storm_Island\\Quest_Sinbad\\Quest_Roc\\Roc_Nonexistent_Entity.entity.ot';
// Real path with one character changed, to test how tight the match is.
const TYPO = 'DarkHills\\Jack\\Jack_Quest_Managor.entity.ot';

const CONTROLS = [
  ['known-bad  (pre-fix Roc path)', OLD_ROC, 'ABSENT'],
  ['known-real (Roc manager)     ', ROC_MANAGER, 'LOADED'],
  ['invented                     ', FAKE, 'ABSENT'],
  ['one-char typo                ', TYPO, 'ABSENT'],
  ['known-real (Jack manager)    ', 'DarkHills\\Jack\\Jack_Quest_Manager.entity.ot', 'LOADED'],
];

const pid = findPid(PROCESS_NAME);
const mod = moduleBase(pid);
const proc = openProcess(pid);

const targets = CONTROLS.map(c => c[1]);
const strings = scanStrings(proc, targets);
const all = [];
for (const t of targets) all.push(...(strings.get(t) || []));
const triples = all.length ? scanPointers(proc, all) : new Map();

console.log('  expect  actual  copies  triples  what');
let pass = true;
for (const [name, path, expect] of CONTROLS) {
  const addrs = strings.get(path) || [];
  let trip = 0;
  for (const a of addrs) trip += (triples.get(a) || []).length;
  const actual = addrs.length === 0 ? 'ABSENT' : (trip === 0 ? 'NO-TRIPLE' : 'LOADED');
  const ok = actual === expect;
  if (!ok) pass = false;
  console.log(`  ${expect.padEnd(7)} ${actual.padEnd(7)} ${String(addrs.length).padStart(6)} ${String(trip).padStart(8)}  ${name}${ok ? '' : '   <-- MISMATCH'}`);
}

// Every shipped marker path, spelling only. This half needs no run loaded.
console.log('\n  shipped marker paths, residency only:');
const shipped = scanStrings(proc, MARKER_PATHS);
let absent = 0;
for (const p of MARKER_PATHS) {
  const n = (shipped.get(p) || []).length;
  if (n === 0) { absent++; console.log(`    ABSENT  ${p}`); }
}
console.log(`    ${MARKER_PATHS.length - absent}/${MARKER_PATHS.length} resident, ${absent} absent`);

console.log(`\n  control ${pass ? 'PASSED -- the check discriminates' : 'FAILED -- the check is not measuring what it claims'}`);
proc.close();
