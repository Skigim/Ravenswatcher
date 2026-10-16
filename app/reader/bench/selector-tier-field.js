'use strict';
// Find the reward selector field that carries the tier.
//
// Baba Yaga eyes, thieves stashes and dream crystals are drawn with a ring the
// game tints green/yellow/red for tier, and the tier scales the camp. No asset
// name carries it: Camp_Rewards_*_Update5.rewarddef lists Baba_Yaga_Eye and
// DreamCrystal_Big once each, where it lists chests and astrolabs as separate
// _T1/_T2/_T3 entities. So the tier is a runtime value on the placed instance.
//
// Chests are the control and they are what makes this conclusive without
// anyone reading a ring: their tier IS in the name, so any u32 in the selector
// struct that is a perfect function of the chest name's _T digit is the tier
// field. Nothing here depends on eyeballing a colour -- the eyes and crystals
// are then just read at whatever offset the chests proved.
//
// Read-only. Degrades with a diagnostic if the game is not running.

const { openProcess, findPid, moduleBase } = require('../win32');
const { PROCESS_NAME } = require('../state');
const tiles = require('../tiles');

const DUMP_BYTES = 0x200;   // past +0x78, the last offset section 10.1 maps
const hex = n => `0x${n.toString(16).toUpperCase()}`;
const off = n => `+0x${n.toString(16).padStart(3, '0')}`;

/** The kind a reward name belongs to, or null for names we are not grouping. */
function kindOf(name) {
  if (/Baba_?Yaga_?Eye/i.test(name)) return 'eye';
  if (/DreamCrystal/i.test(name)) return 'crystal';
  if (/Chest/i.test(name)) return 'chest';
  if (/Astrolab/i.test(name)) return 'astrolab';
  return null;
}

/** The tier the NAME declares, or null. Ground truth for the control kinds. */
function nameTier(name) {
  const m = /_T([123])(?:_|$)/i.exec(name);
  return m ? Number(m[1]) : null;
}

let pid;
try {
  pid = findPid(PROCESS_NAME);
} catch (err) {
  console.error(`Target process ${PROCESS_NAME} not found: ${err.message}`);
  process.exit(1);
}

const mod = moduleBase(pid);
const proc = openProcess(pid);

console.log('='.repeat(70));
console.log(' Reward selector tier field probe');
console.log(` ${PROCESS_NAME} (PID ${pid})  module base ${hex(mod.base)}`);
console.log('='.repeat(70));

const vtables = {};
const resolved = tiles.resolveVtables(proc, mod.base, vtables);
if (!resolved || !resolved.selectorVt) {
  console.error('Could not resolve the reward selector vtable via RTTI.');
  proc.close();
  process.exit(1);
}

const addrs = tiles.findSelectors(proc, resolved.selectorVt);
console.log(`\nSelectors found: ${addrs.length}\n`);
if (addrs.length === 0) {
  console.error('No selectors. Is a map loaded?');
  proc.close();
  process.exit(1);
}

// ------------------------------------------------------------ collect
const rows = [];
for (const addr of addrs) {
  const sel = tiles.readRewardSelector(proc, addr);
  if (!sel) continue;
  const buf = proc.read(addr, DUMP_BYTES);
  if (!buf || buf.length < DUMP_BYTES) continue;
  rows.push({ addr, name: sel.name, kind: kindOf(sel.name), tier: nameTier(sel.name), buf });
}

for (const r of rows) {
  console.log(`  ${hex(r.addr).padEnd(14)} ${(r.kind ?? '-').padEnd(9)} tier(name)=${r.tier ?? '-'}  ${r.name}`);
}

// The floats at +0x6C/+0x70/+0x74 are position and differ per instance by
// design; skipping them keeps them out of every candidate list below.
const POSITION = new Set([0x6c, 0x70, 0x74]);
const u32 = (r, o) => r.buf.readUInt32LE(o);

// --------------------------------------------- control: chests and astrolabs
// An offset qualifies only if it separates the tiers AND agrees within each
// tier. One tier present cannot separate anything, so say so rather than
// reporting every constant field as a hit.
const control = rows.filter(r => (r.kind === 'chest' || r.kind === 'astrolab') && r.tier !== null);
const tiersSeen = new Set(control.map(r => r.tier));

console.log(`\n--- control: ${control.length} named-tier selector(s), tiers {${[...tiersSeen].sort().join(',')}} ---`);

let candidates = [];
if (tiersSeen.size < 2) {
  console.log('  Not enough distinct named tiers on this map to separate anything.');
  console.log('  Re-run on a map carrying chests of two different tiers.');
} else {
  for (let o = 0; o + 4 <= DUMP_BYTES; o += 4) {
    if (POSITION.has(o)) continue;
    const byTier = new Map();
    let consistent = true;
    for (const r of control) {
      const v = u32(r, o);
      if (!byTier.has(r.tier)) byTier.set(r.tier, v);
      else if (byTier.get(r.tier) !== v) { consistent = false; break; }
    }
    if (!consistent) continue;
    if (new Set(byTier.values()).size !== byTier.size) continue;  // does not separate
    candidates.push({ o, byTier });
  }

  if (candidates.length === 0) {
    console.log('  No u32 in the first 0x200 bytes tracks the named tier.');
    console.log('  The tier is not a plain u32 on the selector -- try the settings');
    console.log('  resource at +0x78, or the owning entity at +0x08.');
  } else {
    console.log(`  ${candidates.length} offset(s) track the named tier:`);
    for (const c of candidates) {
      const map = [...c.byTier.entries()].sort((a, b) => a[0] - b[0])
        .map(([t, v]) => `T${t}=${v}`).join('  ');
      console.log(`    ${off(c.o)}   ${map}`);
    }
  }
}

// ------------------------------------------- read the untiered kinds there
const subjects = rows.filter(r => r.kind === 'eye' || r.kind === 'crystal');
console.log(`\n--- subjects: ${subjects.length} eye/crystal selector(s) ---`);
if (subjects.length === 0) {
  console.log('  None placed on this map.');
} else if (candidates.length === 0) {
  console.log('  No candidate offset to read them at.');
} else {
  for (const c of candidates) {
    const vals = subjects.map(r => `${r.kind}=${u32(r, c.o)}`).join('  ');
    console.log(`  ${off(c.o)}   ${vals}`);
  }
  console.log('\n  A candidate is the tier field if the eyes read two distinct');
  console.log('  values and the crystals read up to three, matching the rings.');
}

// ------------------------------------------------- fallback: raw difference
// If the control found nothing, the differing offsets between two eyes are
// still worth seeing -- the tier is somewhere in there.
const eyes = rows.filter(r => r.kind === 'eye');
if (candidates.length === 0 && eyes.length >= 2) {
  console.log(`\n--- offsets that differ across the ${eyes.length} eyes ---`);
  const diffs = [];
  for (let o = 0; o + 4 <= DUMP_BYTES; o += 4) {
    if (POSITION.has(o)) continue;
    const vals = eyes.map(r => u32(r, o));
    if (new Set(vals).size > 1) diffs.push({ o, vals });
  }
  if (diffs.length === 0) console.log('  None. The two eyes are byte-identical here.');
  for (const d of diffs) {
    const small = d.vals.every(v => v <= 8);
    console.log(`    ${off(d.o)}   ${d.vals.join('  ')}${small ? '   <-- small ints' : ''}`);
  }
}

proc.close();
