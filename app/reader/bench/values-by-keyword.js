'use strict';
// Every live GlobalValue whose name matches a keyword, with its reading.
//
//   node app/reader/bench/values-by-keyword.js sandman dream shard
//   node app/reader/bench/values-by-keyword.js            # all of them
//
// RUN THIS BEFORE CHASING POINTERS. buildIndex names every live GlobalValue in
// one sweep, about 1.5 s, so any state the game happens to keep as a value is
// a filter over that list rather than an offset hunt. A Sandman investigation
// spent a long time on RTTI censuses and pointer walks, and concluded twice
// that state was absent, when this dump answered most of it immediately.
//
// Do NOT conclude a value does not exist from tools/value_types.json. That file
// is a type map, not a census -- it carried 201 entries while the live index
// held 434. Absence from it means the reading prints untyped, not that the
// value is missing. An untyped Float shows as raw bits: 1065353216 is 1.0f.
//
// Names follow no single convention. "Is in sandman shop" is lowercase
// mid-name, "Is_Sandman_Free_Purchase_Available" is snake_case, "Hero Level"
// is title case. Match case-insensitively on a stem; never guess a spelling.

const { openProcess, findPid, moduleBase } = require('../win32');
const values = require('../values');
const { PROCESS_NAME } = require('../state');

const needles = process.argv.slice(2).map(s => s.toLowerCase());

const pid = findPid(PROCESS_NAME);
if (!pid) {
  console.error(`${PROCESS_NAME} is not running.`);
  process.exit(1);
}
const mod = moduleBase(pid);
const proc = openProcess(pid);
console.log(`pid ${pid}  base 0x${mod.base.toString(16).toUpperCase()}`);

const t0 = process.hrtime.bigint();
const idx = values.buildIndex(proc, mod.base);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
if (!idx) {
  console.error('buildIndex returned null -- no settings vtable resolved. '
    + 'If the game is running and in a run, BINDING_VTABLE_RVA in '
    + 'reader/struct_offsets.json is probably stale after a patch.');
  process.exit(1);
}

// The index size is the control. A run in progress resolves hundreds; a
// handful means the chain is broken and an empty filter would prove nothing.
console.log(`index: ${idx.names.size} live GlobalValues, `
  + `${idx.bindings.size} bound, ${ms.toFixed(0)} ms\n`);

const hits = [...idx.names.keys()]
  .filter(n => !needles.length || needles.some(w => n.toLowerCase().includes(w)))
  .sort();

console.log(`${hits.length} matching name(s):\n`);
for (const name of hits) {
  const r = idx.resolve(name);
  // resolve() reports the type as a name, not an index, and null when
  // value_types.json has no entry -- which is a reading you can still use,
  // just not one that has been interpreted yet.
  const reading = r.status === 'ok'
    ? `${r.value}  (${r.type ?? 'untyped'})`
    : `<${r.status}>`;
  console.log(`  ${name.padEnd(46)} ${reading}`);
}
proc.close();
