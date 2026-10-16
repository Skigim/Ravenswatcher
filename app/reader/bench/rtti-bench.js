'use strict';
// Cost of the RTTI resolve step, which the reader pays once per launch (not
// per sweep). Measured over a large PE image on disk, since Ravenswatch.exe
// cannot be attached to. Indicative of the .data/.rdata scan throughput, not
// of the game's actual section sizes.

const fs = require('fs');
const { PeFileSource } = require('../pefile');
const rtti = require('../rtti');

const files = process.argv.slice(2).length ? process.argv.slice(2) : [
  'C:/Windows/System32/msvcp140.dll',
  'E:/Documents/Projects/Datamining/Ravenswatch/build/release/win-unpacked/Ravenswatcher.exe',
];

for (const f of files) {
  if (!fs.existsSync(f)) { console.log(`skip ${f}`); continue; }
  let src;
  try { src = new PeFileSource(f); } catch (e) { console.log(`skip ${f}: ${e.message}`); continue; }
  const { data, rdata, search } = rtti.sectionsOf(src, src.base);
  if (!search) { console.log(`skip ${f}: no .data/.rdata`); continue; }
  const scanned = (data.vsize + rdata.vsize) / 1e6;
  // A name that is not present forces the full .data scan and then stops --
  // the floor cost of one resolve attempt.
  const t0 = process.hrtime.bigint();
  rtti.resolveOneVtable(src, src.base, data, search, '.?AVoCNotPresentAnywhere@@\0');
  const t1 = process.hrtime.bigint();
  // A name that IS present pays the .data scan plus the RVA and COL-pointer
  // scans over both sections.
  let found = null, tFound = 0;
  const names = ['.?AVexception@std@@\0', '.?AVtype_info@@\0'];
  for (const n of names) {
    const a = process.hrtime.bigint();
    const r = rtti.resolveOneVtable(src, src.base, data, search, n);
    const b = process.hrtime.bigint();
    if (r !== null) { found = n; tFound = Number(b - a) / 1e6; break; }
  }
  console.log(`${f}`);
  console.log(`  .data ${(data.vsize / 1e6).toFixed(1)} MB  .rdata ${(rdata.vsize / 1e6).toFixed(1)} MB  (${scanned.toFixed(1)} MB scannable)`);
  console.log(`  absent class (full .data scan): ${(Number(t1 - t0) / 1e6).toFixed(1)} ms`);
  console.log(`  present class ${found || '(none found)'}: ${tFound.toFixed(1)} ms`);
}
