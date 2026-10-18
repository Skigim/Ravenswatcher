'use strict';
// Synthetic progress PODs and linked components; never attaches to the game.
const assert = require('assert');
const melodies = require('../melodies');
function fixture() {
  const bytes = Buffer.alloc(0x20000);
  const proc = {
    read(at, n) { return at >= 0 && at + n <= bytes.length ? Buffer.from(bytes.subarray(at, at + n)) : null; },
    readPtr(at) { const b = this.read(at, 8); return b ? Number(b.readBigUInt64LE()) : null; },
    readI32(at) { const b = this.read(at, 4); return b ? b.readInt32LE() : null; },
  };
  const ptr = (at, value) => bytes.writeBigUInt64LE(BigInt(value), at);
  const u32 = (at, value) => bytes.writeUInt32LE(value, at);
  const pool = ['first', 'second', 'third'].map(internal_name => ({internal_name, name: internal_name, notes: 8, icon: 'fixture.png', effect: 'Fixture'}));
  const registry = new Map(pool.map((def, i) => [Buffer.alloc(16, i + 1).toString('hex'), def]));
  const vtables = { heroControllerVt: 0xAA, melodyCpntVt: 0xBB };
  function hero(at, slot, earned) {
    const entity = at + 0x2000, array = at + 0x2200, cpnt = at + 0x2400;
    const melodyEntity = at + 0x2800, object = at + 0x2A00, definition = at + 0x3000;
    const data = at + 0x3400, entries = at + 0x3500;
    ptr(at, vtables.heroControllerVt); ptr(at + 8, entity); ptr(entity + 0x30, 0xF00);
    ptr(at + 0x13B8, array); u32(at + 0x13C0, 1); ptr(array, cpnt);
    ptr(cpnt, vtables.melodyCpntVt); ptr(cpnt + 8, melodyEntity); u32(cpnt + 0x68, 1);
    ptr(melodyEntity + 0x28, object); bytes.fill(slot + 1, object + 0x1C8, object + 0x1D8);
    ptr(cpnt + 0x168, definition); u32(definition + 0x320, 4);
    ptr(at + 0x1DA8, data); ptr(data + 0x48, entries); u32(data + 0x50, 1); u32(data + 0x54, 2);
    u32(entries + 8, 0xC978D974); bytes.writeUInt16LE(earned, entries + 12);
    bytes.writeUInt16LE(0xFFFF, entries + 14); // adjacent flags must not become part of the count
    return {at, entity, array, cpnt, definition, data, entries};
  }
  const one = hero(0x1000, 1, 3);
  const read = (heroes = [one.at], states = [0, 1, 0]) => melodies.readProgress(proc, vtables, pool, states, registry, heroes);
  return {bytes, proc, ptr, u32, pool, registry, vtables, hero, one, read};
}
function main() {
  let f = fixture();
  assert.strictEqual(melodies.readHeroNoteCount(f.proc, f.one.at), 3, 'uint16 count excludes adjacent flags');
  assert.deepStrictEqual(f.read(), [null, {required: 4, earned: 3}, null], 'GUID attribution follows pool identity, not linked-array position');
  let payload = melodies.combineMelodies(f.pool, [0, 1, 2], f.read());
  assert.strictEqual(payload[1].notes, 4, 'runtime requirement overrides the baseline');
  assert.strictEqual(payload[1].notes_earned, 3);
  assert.strictEqual(payload[0].notes_earned, null);
  assert.strictEqual(payload[2].notes_earned, null);
  f.u32(f.one.entries + 8, 0x12345678);
  assert.strictEqual(melodies.readHeroNoteCount(f.proc, f.one.at), 0, 'missing event means known zero');
  f.u32(f.one.data + 0x50, 0);
  assert.strictEqual(melodies.readHeroNoteCount(f.proc, f.one.at), 0, 'empty readable vector is zero');
  f.ptr(f.one.at + 0x1DA8, 0);
  assert.strictEqual(melodies.readHeroNoteCount(f.proc, f.one.at), null, 'missing POD is unknown');
  f.ptr(f.one.at + 0x1DA8, 0x30000);
  assert.strictEqual(melodies.readHeroNoteCount(f.proc, f.one.at), null, 'unreadable POD is unknown');

  f = fixture();
  f.u32(f.one.data + 0x50, 3);
  assert.strictEqual(melodies.readHeroNoteCount(f.proc, f.one.at), null, 'count cannot exceed capacity');
  f.u32(f.one.data + 0x50, 2); f.u32(f.one.entries + 24 + 8, 0xC978D974);
  assert.strictEqual(melodies.readHeroNoteCount(f.proc, f.one.at), null, 'duplicate matching IDs are ambiguous');
  f = fixture(); f.bytes.writeUInt16LE(5, f.one.entries + 12);
  assert.deepStrictEqual(f.read()[1], {required: 4, earned: null}, 'out-of-range count is refused');
  f.u32(f.one.cpnt + 0x68, 2);
  assert.deepStrictEqual(f.read(), [null, null, null], 'completed component does not donate its counter');
  f = fixture(); f.ptr(f.one.entity + 0x30, 0);
  assert.deepStrictEqual(f.read(), [null, null, null], 'retired hero is ignored');

  f = fixture(); const second = f.hero(0x9000, 1, 2);
  assert.deepStrictEqual(f.read([f.one.at, second.at])[1], {required: 4, earned: 3}, 'co-op merges compatible counters with max');
  f.u32(second.definition + 0x320, 5);
  assert.strictEqual(f.read([f.one.at, second.at])[1], null, 'disagreeing requirements are unknown');
  f = fixture(); const other = f.hero(0x9000, 0, 1);
  f.u32(f.one.at + 0x13C0, 2); f.ptr(f.one.array + 8, other.cpnt);
  assert.deepStrictEqual(f.read([f.one.at], [1, 1, 0]), [null, null, null], 'multiple active melodies never share one count');
  console.log('test-melody-progress: ok');
  return 0;
}
module.exports = { main };
if (require.main === module) process.exit(main());
