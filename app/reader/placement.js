'use strict';
// Which entities the map generator actually placed.
//
// A spawned entity points at its source EntitySettingsResource from
// oCEntity+0x38. That reference is the only signal. Residency is not it, and
// residency is not scoped to the running map: measured with no run loaded at
// all -- map id -1, hero level 0 -- all twelve marker paths across Dark Hills,
// Storm Island and Avalon are resident, 4-5 copies each, every copy carrying a
// resource-object pointer triple and zero entities. The path catalog is there
// from process start. Only the placed resource has entities pointing at it.
//
// That splits two failures a single "is the path there?" test would blur. A
// path that reads ABSENT is misspelled, and is checkable with no run loaded --
// bench/spell-control.js discriminates a real path from a one-character typo.
// A path that reads LOADED but is never PLACED needs a live run on that
// questline to catch; that is the Roc failure, where the manager entity is
// never placed at all and no spelling of its path could have matched.
//
// THE TRAP THIS MODULE EXISTS TO AVOID. A component's *Settings at +0x10 reads
// the LOADED RESOURCE, not a placement. On a confirmed Tree/Morgan run that
// channel reports fifteen oCEntityCpntStateMachine instances belonging to
// Mordred_Quest_Boss_Manager -- pooled template objects in one contiguous
// block. Stable, plausible, and wrong, exactly the way the ingredient
// listener's own int signal at +0x98 is. Only +0x38 tells loaded from placed.
//
// Resource-path strings are no better, for the same reason: both managers'
// paths sit in the process on any run, six and eight copies respectively on a
// run that placed one of them.

const rtti = require('./rtti');
const { scanPointers, scanPointerRanges, scanStrings } = require('./scan');
/**
 * Every {const char *, uint32 len, uint32 flags} triple in an object.
 *
 * Moved here from ingredients.js when the carried-ingredient chain was cut.
 * It never had anything to do with ingredients -- it is a generic reader for
 * the string triple this engine stores everywhere -- and placement is its
 * only real consumer. Exported for bench/placement-profile.js.
 */
function objectStrings(proc, obj, size = 0x400) {
  const blob = proc.read(obj, size);
  if (!blob) return [];
  const out = [];
  for (let off = 0; off + 16 <= blob.length; off += 8) {
    const ptr = blob.readUInt32LE(off + 4) * 4294967296 + blob.readUInt32LE(off);
    const length = blob.readUInt32LE(off + 8) & 0x7FFFFFFF;
    if (!(ptr > 0x10000 && ptr < 0x00007fffffffffff && length >= 2 && length <= 200)) continue;
    const str = proc.read(ptr, length);
    if (!str || str.length < length) continue;
    let printable = true;
    for (let i = 0; i < length; i++) if (str[i] < 0x20 || str[i] > 0x7e) { printable = false; break; }
    if (printable) out.push(str.toString('latin1'));
  }
  return out;
}

const ENTITY_RTTI = '.?AVoCEntity@@\0';
const ENTITY_RESOURCE_OFFSET = 0x38;
// How far back from a path triple the resource object's own base can sit.
// Probing a window rather than a fixed offset keeps this working across a
// layout shift; the exact attribution is done afterwards by re-reading the
// object's strings, since two paths' triples can fall inside one another's
// window.
//
// The window is asked as a RANGE, not as its 41 individual addresses. Spelling
// it out as targets for an equality scan was 94% of this function's runtime --
// see scanPointerRanges in scan.js for the measurement and the mechanism.
const RESOURCE_OBJECT_WINDOW = 0x140;

/**
 * @param {Process} proc
 * @param {number}  base    module base
 * @param {string[]} paths  .entity.ot resource paths to ask about
 * @param {object}  cache   mutable memo; cache.entity holds vtable RVAs
 * @returns {Map<string, number>|null} path -> distinct live entity count, for
 *          the subset that has any. null when oCEntity could not be resolved.
 */
function placedAmong(proc, base, paths, cache) {
  const out = new Map();
  if (!paths || !paths.length) return out;

  if (!cache.entity) {
    const rvas = rtti.resolveAllVtableRvas(proc, base, ENTITY_RTTI);
    if (!rvas.length) return null;
    cache.entity = rvas;
  }
  const entityVts = new Set(cache.entity.map(r => base + r));

  // 1. Where each path string lives. Residency proves nothing on its own.
  const strings = scanStrings(proc, paths);
  const pathOfString = new Map();
  for (const p of paths) {
    for (const a of strings.get(p) || []) pathOfString.set(a, p);
  }
  if (!pathOfString.size) return out;

  // 2. Pointers to those strings are the {char*, len, flags} triples sitting
  //    inside the resource objects.
  const triples = scanPointers(proc, [...pathOfString.keys()]);

  // 3. References to a candidate resource-object base: any qword pointing into
  //    the window that ends at a path triple. Overlapping windows need no
  //    dedupe -- the result is keyed by the value actually found, so a base
  //    reachable from two triples lands in one entry either way.
  const ranges = [];
  for (const sites of triples.values()) {
    for (const t of sites) ranges.push([t - RESOURCE_OBJECT_WINDOW, t]);
  }
  if (!ranges.length) return out;
  const refs = scanPointerRanges(proc, ranges);

  // 4. Keep references landing at oCEntity+0x38, and attribute each to the
  //    path the object really carries rather than to every path whose triple
  //    fell inside the probe window.
  const wanted = new Set(paths);
  const ents = new Map();
  for (const [obj, sites] of refs) {
    if (!sites.length) continue;
    let carried = null;
    for (const r of sites) {
      const ent = r - ENTITY_RESOURCE_OFFSET;
      if (!entityVts.has(proc.readPtr(ent))) continue;
      if (carried === null) {
        carried = objectStrings(proc, obj, RESOURCE_OBJECT_WINDOW + 0x20)
          .filter(s => wanted.has(s));
        if (!carried.length) break;
      }
      for (const p of carried) {
        if (!ents.has(p)) ents.set(p, new Set());
        ents.get(p).add(ent);
      }
    }
  }
  for (const [p, set] of ents) out.set(p, set.size);
  return out;
}

module.exports = {
  objectStrings,
  ENTITY_RTTI, ENTITY_RESOURCE_OFFSET, RESOURCE_OBJECT_WINDOW,
  placedAmong,
};
