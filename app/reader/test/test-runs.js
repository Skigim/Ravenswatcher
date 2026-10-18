'use strict';
// The run-end channel's readers, against synthetic memory: the run record,
// the selected talents, the score page and its readiness rule, the edge
// detector, and the summary on the frame. Nothing attaches to the game.

const assert = require('assert');
const runs = require('../runs');
const { readState } = require('../state');

const C = runs.RUN_CLASSES;

/** A flat buffer at `base`, with helpers to lay out fields and strings. */
function memory(size) {
  const base = 0x10000;
  const buf = Buffer.alloc(size);
  const classes = new Map();
  let strings = base + size - 0x8000;
  const m = {
    base,
    classes,
    proc: {
      read(at, n) {
        return at >= base && at + n <= base + buf.length ? Buffer.from(buf.subarray(at - base, at - base + n)) : null;
      },
    },
    classOf: (p) => classes.get(p) || null,
    ptr: (at, v) => buf.writeBigUInt64LE(BigInt(v), at - base),
    i32: (at, v) => buf.writeInt32LE(v, at - base),
    f32: (at, v) => buf.writeFloatLE(v, at - base),
    guid: (at, v) => Buffer.alloc(16, v).copy(buf, at - base),
    str(at, text) {
      const b = Buffer.from(text, 'utf8');
      b.copy(buf, strings - base);
      m.ptr(at, strings); m.i32(at + 8, b.length); m.i32(at + 12, b.length);
      strings += b.length + 16;
    },
    vec(at, p, count) { m.ptr(at, p); m.i32(at + 8, count); m.i32(at + 12, count); },
  };
  return m;
}

// ---------------------------------------------------------------- record --

function runFixture() {
  const m = memory(0x80000);
  const record = 0x11000, heroSettings = 0x12000, components = 0x13000, heroPersistent = 0x14000;
  const chosen = 0x15000, objects = 0x16000;
  m.classes.set(record, C.record);
  m.classes.set(heroPersistent, C.hero);
  m.ptr(record + 0x20, heroSettings); m.str(heroSettings + 8, 'Hero_Fixture_Skin');
  m.str(record + 0x70, 'Heroes\\Fixture_Update6.herodef.ot');
  m.f32(record + 0x9C, 716.97229);
  m.f32(record + 0xA0, 4.158);
  m.f32(record + 0x180, 21344.0078);
  m.f32(record + 0x1A4, 0);           // highest single damage: a real zero
  m.f32(record + 0x1C4, 3);           // death's doors
  m.f32(record + 0x1D8, 2);           // magical objects collected
  m.vec(record + 0xE0, objects, 2); m.guid(objects, 0xAB); m.guid(objects + 16, 0xCD);
  m.vec(record + 0xF0, objects + 0x100, 2);
  m.i32(objects + 0x100, 4 | (301 << 16)); // packed uint16, not byte or int32 stride

  m.vec(record + 0x10, components, 5); m.ptr(components, heroPersistent);
  m.vec(heroPersistent + 0xE8, chosen, 3);
  m.guid(chosen, 2); m.guid(chosen + 16, 1); m.guid(chosen + 32, 3);

  const table = 0x17000, keys = 0x18000, texts = 0x19000;
  m.classes.set(table, C.localText);
  m.vec(table + 0x80, keys, 4); m.vec(table + 0xA0, texts, 4);
  const settings = [], entries = [], payloads = [];
  for (let n = 1; n <= 4; n++) {
    const entry = 0x20000 + n * 0x1000, def = 0x30000 + n * 0x1000, owner = 0x40000 + n * 0x1000, payload = 0x50000 + n * 0x1000;
    entries.push(entry); settings.push(def); payloads.push(payload);
    m.ptr(components + n * 8, entry); m.classes.set(entry, C.skill);
    m.guid(entry + 0x20, n); m.i32(entry + 0x50, [0, 0, 2, 4, 0][n]);
    m.classes.set(def, C.settings); m.ptr(def + 0x18, def); m.guid(def + 0x88, n);
    m.ptr(def + 0x48, owner); m.str(owner + 8, 'Hero_Fixture');
    m.str(def + 0xE8, 'Skill_Fixture_' + n); m.ptr(def + 0x1E8, payload);
    if (n !== 3) {
      m.ptr(payload + 0x40, table); m.str(payload + 0x58, 'Key_' + n); m.i32(payload + 0x50, n - 1);
      m.str(keys + (n - 1) * 16, 'Key_' + n); m.str(texts + (n - 1) * 16, n === 2 ? 'Talent Épic' : 'Talent ' + n);
    }
  }
  // Talent 3 has no localized payload; its name comes from the runtime controller.
  const runtime = 0x65000, listener = 0x66000;
  m.classes.set(runtime, C.runtime); m.ptr(runtime + 0x10, settings[2]); m.ptr(runtime + 0xA8, listener);
  m.classes.set(listener, C.text); m.str(listener + 8, 'Delegated Ultimate');
  return { ...m, record, heroPersistent, chosen, entries, payloads, settings, runtimes: [runtime] };
}

const talentsOf = (f, runtimes = f.runtimes) => runs.readTalents(f.proc, f.record, f.classOf, f.settings, runtimes);

function testRecord() {
  const f = runFixture();
  const r = runs.readRecord(f.proc, f.record, f.classOf);
  assert.strictEqual(r.hero, 'Hero_Fixture_Skin');
  assert.strictEqual(r.hero_definition, 'Heroes\\Fixture_Update6.herodef.ot');
  assert.ok(Math.abs(r.playtime_s - 716.97229) < 1e-3);
  assert.ok(Math.abs(r.level - 4.158) < 1e-5);
  assert.ok(Math.abs(r.stats.damage.total - 21344.0078) < 1e-2);
  assert.strictEqual(r.stats.damage.highest, 0, 'a zero row stays zero');
  assert.strictEqual(r.stats.sufferings.deaths_doors, 3);
  assert.strictEqual(r.stats.resources.objects_collected, 2);
  assert.deepStrictEqual(Object.keys(r.stats), ['damage', 'support', 'sufferings', 'resources']);
  assert.strictEqual(Object.keys(r.stats.damage).length, 10);
  assert.deepStrictEqual(r.objects, ['ab'.repeat(16), 'cd'.repeat(16)]);
  assert.deepStrictEqual(r.object_counts, [4, 301]);
  assert.strictEqual(runs.recordProblem(r), null);
  assert.strictEqual(runs.heroCode(r.hero_definition), 'Fixture');

  assert.match(runs.recordProblem({ ...r, playtime_s: 0 }), /zero playtime/);
  assert.match(runs.recordProblem({ ...r, playtime_s: 20000 }), /out of range/);
  assert.match(runs.recordProblem({ ...r, level: 0 }), /level/);

  f.i32(0x16100, 0 | (65535 << 16));
  assert.deepStrictEqual(runs.readRecord(f.proc, f.record, f.classOf).object_counts, [0, 65535]);
  f.vec(f.record + 0xF0, 0x16100, 1);
  assert.strictEqual(runs.readRecord(f.proc, f.record, f.classOf).object_counts, null, 'mismatched vectors do not invent counts');
  f.vec(f.record + 0xF0, 0x90000, 2);
  assert.strictEqual(runs.readRecord(f.proc, f.record, f.classOf).object_counts, null, 'unreadable counts preserve the run');
  f.vec(f.record + 0xE0, 0, 0); f.vec(f.record + 0xF0, 0, 0);
  assert.deepStrictEqual(runs.readRecord(f.proc, f.record, f.classOf).object_counts, [], 'a known empty inventory');

  f.classes.delete(f.record);
  assert.throws(() => runs.readRecord(f.proc, f.record, f.classOf), /wrong run record class/);
}

function testTalents() {
  let f = runFixture();
  assert.deepStrictEqual(talentsOf(f).map(t => [t.name, t.rarity, t.rarity_code, t.key]), [
    ['Talent Épic', 'Epic', 2, 'Skill_Fixture_2'],
    ['Talent 1', 'Common', 0, 'Skill_Fixture_1'],
    ['Delegated Ultimate', 'Ultimate', 4, 'Skill_Fixture_3'],
  ], 'selected order, not persistent order; the unchosen Common is left out');

  f = runFixture(); f.i32(f.heroPersistent + 0xF0, 0);
  assert.deepStrictEqual(talentsOf(f), [], 'an empty build');

  for (const [code, label] of [[1, 'Rare'], [3, 'Legendary'], [7, null]]) {
    f = runFixture(); f.i32(f.entries[0] + 0x50, code);
    const t = talentsOf(f)[1];
    assert.strictEqual(t.rarity, label, `rarity ${code}`);
    assert.strictEqual(t.rarity_code, code);
  }

  f = runFixture(); f.i32(f.payloads[1] + 0x50, 0);
  assert.strictEqual(talentsOf(f)[0].name, 'Talent Épic', 'a stale key index re-finds the unique key');

  f = runFixture(); f.guid(f.chosen + 16, 2);
  assert.throws(() => talentsOf(f), /duplicate chosen/);

  f = runFixture();
  assert.throws(() => talentsOf(f, []), /talent name unavailable/);

  f = runFixture(); f.i32(f.heroPersistent + 0xF0, 129); f.i32(f.heroPersistent + 0xF4, 129);
  assert.throws(() => talentsOf(f), /invalid vector/);

  // A secondary-vtable hit on the settings is not a definition.
  f = runFixture(); f.ptr(f.settings[1] + 0x18, 0);
  assert.throws(() => talentsOf(f), /expected one Hero_Fixture definition/);
}

function testTalentDescriptions() {
  const f = runFixture();
  const runtime = 0x68000, entity = 0x69000, context = 0x6A000, list = 0x6B000;
  f.classes.set(runtime, C.runtime); f.ptr(runtime + 8, entity);
  f.ptr(runtime + 0x10, f.settings[1]); f.ptr(entity + 0x30, context);
  const text = 'Fixture #ATTACK@ &+25%~; $-10* damage';
  f.str(runtime + 0x90, text); f.runtimes.push(runtime);
  f.vec(entity + 0x190, list, 3);
  f.ptr(list, runtime); f.ptr(list + 8, 0x65000); f.ptr(list + 16, 0x66000);
  assert.deepStrictEqual(runs.findTalentRuntimes(f.proc, entity, f.classOf), [runtime], 'roster contains only skill controllers owned by this hero');
  assert.strictEqual(talentsOf(f)[0].description, text, 'formatted inline UTF-8 text preserves resolved numbers and markup');
  assert.strictEqual(talentsOf(f)[1].description, null, 'missing text remains unknown');
  f.ptr(entity + 0x30, 0);
  assert.strictEqual(talentsOf(f)[0].description, null, 'retired context is refused');
  f.ptr(entity + 0x30, context);
  const other = runtime + 0x300;
  f.classes.set(other, C.runtime); f.ptr(other + 8, entity); f.ptr(other + 0x10, f.settings[1]);
  f.str(other + 0x90, 'Disagreeing effect'); f.runtimes.push(other);
  assert.strictEqual(talentsOf(f)[0].description, null, 'disagreeing live descriptions are unknown');
  f.str(other + 0x90, text);
  assert.strictEqual(talentsOf(f)[0].description, text, 'identical live descriptions agree');
  f.ptr(other + 0x10, f.settings[0]);
  assert.strictEqual(talentsOf(f)[0].description, text, 'another talent cannot overwrite the selected one');

  const old = { key: 'fixture', rarity_code: 2, description: 'Current damage: 25', description_sampled_at: 'fixture-time' };
  const reset = { ...old, description: 'Current damage: 0', description_sampled_at: null };
  assert.deepStrictEqual(runs.retainTalentDescriptions([reset], [old]), [old], 'end-screen reset retains in-run effect and sampling time');
  assert.strictEqual(runs.retainTalentDescriptions([{ ...reset, rarity_code: 3 }], [old])[0].description, reset.description, 'an upgraded talent does not inherit the old rarity effect');
  assert.strictEqual(runs.retainTalentDescriptions([reset], null)[0].description, reset.description, 'a real zero remains valid without an earlier sample');
  assert.strictEqual(runs.retainTalentDescriptions([{ ...reset, description: null }], [old])[0].description, old.description, 'missing end-screen effect retains the sample');
}

// ----------------------------------------------------------------- score --

function scoreFixture(total, details = ['Base score: 140', 'Multiplayer: +10 %']) {
  const m = memory(0x40000);
  const controller = 0x11000, entity = 0x12000, entitySettings = 0x13000, components = 0x14000;
  const label = 0x15000, labelSettings = 0x16000, textListener = 0x17000;
  const operation = 0x18000, operationSettings = 0x19000, inputs = 0x1A000, inputListener = 0x1B000;
  m.classes.set(controller, C.score); m.classes.set(entity, C.entity); m.classes.set(label, C.label);
  m.classes.set(textListener, C.text); m.classes.set(operation, C.operations); m.classes.set(inputListener, C.int);
  m.ptr(controller + 8, entity); m.ptr(entity + 0x28, entitySettings); m.str(entitySettings + 8, 'Score_Book_Page');
  m.vec(entity + 0x190, components, 2); m.ptr(components, label); m.ptr(components + 8, operation);
  m.ptr(label + 8, entity); m.ptr(label + 0x10, labelSettings); m.str(labelSettings + 0xE8, 'Score Label');
  m.ptr(label + 0x170, textListener); m.str(textListener + 8, String(total));
  m.ptr(operation + 8, entity); m.ptr(operation + 0x10, operationSettings);
  m.str(operationSettings + 0xE8, 'Score Display Operation');
  m.vec(operation + 0x68, inputs, 3); m.ptr(inputs + 0x18 + 8, inputListener); m.i32(inputListener + 8, total);
  const setDetails = (at, lines) => {
    m.vec(controller + 0x1F8, at, lines.length);
    lines.forEach((line, i) => { m.ptr(at + i * 0x20, 0x29000); m.str(at + i * 0x20 + 8, line); });
  };
  setDetails(0x1C000, details);
  return { ...m, controller, inputListener, textListener, entity, setDetails };
}

function testScore() {
  for (const total of [258, 0, 98765]) {
    const f = scoreFixture(total);
    const s = runs.readScore(f.proc, f.controller, f.classOf);
    assert.strictEqual(s.total, total);
    assert.deepStrictEqual(s.details, ['Base score: 140', 'Multiplayer: +10 %']);
    assert.strictEqual(s.detail_buffer, 0x1C000);
  }

  let f = scoreFixture(258); f.i32(f.inputListener + 8, 259);
  assert.throws(() => runs.readScore(f.proc, f.controller, f.classOf), /disagrees/);
  f = scoreFixture(258); f.str(f.textListener + 8, 'not a score');
  assert.throws(() => runs.readScore(f.proc, f.controller, f.classOf), /non-numeric/);
  f = scoreFixture(258); f.i32(f.entity + 0x198, 513); f.i32(f.entity + 0x19C, 513);
  assert.throws(() => runs.readScore(f.proc, f.controller, f.classOf), /invalid vector/);

  // Readiness: the previous run's page is up on the edge, so its buffer is
  // the baseline. The same total and lines on that buffer are not current;
  // the game rebuilding the vector is.
  f = scoreFixture(258, ['Base score: 140', 'Level: x1.44', 'Multiplayer: +10 %', 'Grimoire : +5%', 'Side Quest : +25%']);
  const baseline = new Set([runs.detailBuffer(f.proc, f.controller)]);
  assert.strictEqual(runs.scoreReady(baseline, runs.readScore(f.proc, f.controller, f.classOf)), false,
    'the previous run\'s agreeing caches are stale');
  f.str(f.textListener + 8, '195'); f.i32(f.inputListener + 8, 195);
  f.setDetails(0x1D000, ['Base score: 140', 'Level: x1.24', 'Multiplayer: +10 %', 'Altar of Heroes : +5%']);
  const fresh = runs.readScore(f.proc, f.controller, f.classOf);
  assert.strictEqual(runs.scoreReady(baseline, fresh), true, 'a moved buffer is the current run');
  assert.strictEqual(fresh.total, 195);
  assert.strictEqual(fresh.details.length, 4);

  // An equal score on a new buffer still counts: runs can score the same.
  f = scoreFixture(258);
  const same = new Set([runs.detailBuffer(f.proc, f.controller)]);
  f.setDetails(0x1E000, ['Base score: 140', 'Multiplayer: +10 %']);
  assert.strictEqual(runs.scoreReady(same, runs.readScore(f.proc, f.controller, f.classOf)), true);

  // First run of a session: no earlier page, empty baseline.
  assert.strictEqual(runs.scoreReady(new Set(), fresh), true);
  assert.strictEqual(runs.scoreReady(new Set(), { ...fresh, detail_buffer: 0 }), false, 'an empty vector is not a score');
}

// ------------------------------------------------------- edge and summary --

function testEdgeAndSummary() {
  const z = { defeat: 0, victory: 0 };
  assert.strictEqual(runs.endEdge(null, { defeat: 1, victory: 0 }), null, 'already up on attach is not an edge');
  assert.strictEqual(runs.endEdge(z, { defeat: 1, victory: 0 }), 'defeat');
  assert.strictEqual(runs.endEdge(z, { defeat: 0, victory: 1 }), 'victory');
  assert.strictEqual(runs.endEdge({ defeat: 1, victory: 0 }, { defeat: 1, victory: 0 }), null, 'held is not an edge');
  assert.strictEqual(runs.endEdge(z, { defeat: null, victory: null }), null);

  const f = runFixture();
  const record = runs.readRecord(f.proc, f.record, f.classOf);
  const id = Date.UTC(2026, 9, 17, 4, 21, 24);
  const s = runs.buildSummary({ id, result: 'defeat', difficulty: 2, map: 0, chapter: 0 }, record, talentsOf(f));
  assert.strictEqual(s.v, 1);
  assert.strictEqual(s.ended, '2026-10-17T04:21:24.000Z');
  assert.strictEqual(s.map, 0, 'Dark Hills is map 0, not absent');
  assert.strictEqual(s.chapter, 0);
  assert.strictEqual(s.score, null, 'score is filled later, by the worker');
  assert.strictEqual(s.talents.length, 3);
  assert.strictEqual(s.damage.total, record.stats.damage.total);
  assert.deepStrictEqual(s.objects, record.objects);
  assert.deepStrictEqual(s.object_counts, [4, 301]);
  assert.strictEqual(s.melodies, null, 'unread melodies stay unavailable');
  const melody = { slot: 0, internal_name: 'fixture', name: 'Fixture Melody', icon: 'fixture.png', notes: 4, state: 'active', effect: 'Fixture' };
  const withMelody = runs.buildSummary({ id, result: 'victory', difficulty: 1, map: 3, chapter: 3 }, record, [], [melody]);
  melody.state = 'locked';
  assert.strictEqual(withMelody.melodies[0].state, 'active', 'the summary owns its melody snapshot');
  const stats = { vitality: 92, damage: 247, armor: 311, crit_chance: 5, crit_damage: 50 };
  const withStats = runs.buildSummary({ id, result: 'victory', difficulty: 1, map: 3, chapter: 3 }, record, [], null, stats, '2026-10-17T19:30:00.000Z');
  stats.armor = 0;
  assert.strictEqual(withStats.hero_stats.armor, 311, 'the summary owns its hero attribute snapshot');
  assert.strictEqual(withStats.hero_stats_sampled_at, '2026-10-17T19:30:00.000Z');
  assert.strictEqual(s.hero_stats, null, 'unread hero attributes stay unavailable');
  JSON.parse(JSON.stringify(s));

  // The frame carries it on one frame and null otherwise.
  assert.strictEqual(readState(null, { values: {} }).run_summary, null);
  assert.strictEqual(readState(null, { values: {}, run_summary: s }).run_summary, s);
  let queued = [s];
  const live = { get: () => null, maps: () => ({}), take_run_summary: () => queued.shift() || null };
  assert.strictEqual(readState(live).run_summary, s);
  assert.strictEqual(readState(live).run_summary, null);

  assert.deepStrictEqual(runs.RARITY, { 0: 'Common', 1: 'Rare', 2: 'Epic', 3: 'Legendary', 4: 'Ultimate' });
  assert.ok(runs.RUN_VALUE_NAMES.includes('Current map id'));
}

function testHeroStats() {
  const m = memory(0x40000);
  const controller = 0x11000, entity = 0x12000, settings = 0x13000, context = 0x14000, list = 0x15000;
  m.classes.set(controller, C.controller); m.ptr(controller + 8, entity);
  m.ptr(entity + 0x28, settings); m.str(settings + 8, 'Hero_Fixture_Skin');
  m.ptr(entity + 0x30, context);
  const values = { vitality: 0, damage: 247, armor: -10, crit_chance: 5, crit_damage: 50 };
  m.vec(entity + 0x190, list, 5);
  Object.entries(runs.HERO_STAT_NAMES).forEach(([key, name], i) => {
    const c = 0x17000 + i * 0x300, settings = 0x25000 + i * 0x300;
    m.ptr(list + i * 8, c); m.classes.set(c, C.smooth);
    m.ptr(c + 8, entity); m.ptr(c + 0x10, settings); m.str(settings + 0xE8, name);
    m.f32(c + 0x130, values[key]);
  });
  const fields = runs.findHeroStatFields(m.proc, 'Hero_Fixture_Skin', m.classOf, [controller]);
  assert.ok(fields);
  assert.deepStrictEqual(runs.readHeroStats(m.proc, fields, m.classOf), values, 'display floats, including real zero and negative armor');
  assert.strictEqual(runs.findHeroStatFields(m.proc, 'Hero_Other', m.classOf, [controller]), null);
  assert.strictEqual(runs.findHeroStatFields(m.proc, 'Hero_Fixture_Skin', m.classOf, [controller, controller]), null, 'ambiguous owners are refused');
  m.ptr(entity + 0x30, 0);
  assert.strictEqual(runs.findHeroStatFields(m.proc, 'Hero_Fixture_Skin', m.classOf, [controller]), null, 'orphaned scene owners are refused');
  assert.throws(() => runs.readHeroStats(m.proc, fields, m.classOf), /stale/);
  m.ptr(entity + 0x30, context);
  m.f32(fields.fields.vitality, NaN);
  assert.throws(() => runs.readHeroStats(m.proc, fields, m.classOf), /invalid/);
  m.classes.delete(0x17000);
  assert.strictEqual(runs.findHeroStatFields(m.proc, 'Hero_Fixture_Skin', m.classOf, [controller]), null, 'partial stats stay unavailable');
}

function testRunMelodyRetention() {
  const { Reader } = require('../reader');
  const melody = { slot: 0, internal_name: 'fixture', name: 'Fixture', icon: 'fixture.png', notes: 4, effect: 'Fixture', state: 'locked' };
  let snapshot = { melodies: null, outsideRun: true };
  snapshot = runs.nextRunMelodySnapshot(snapshot, 0, true, [melody]);
  melody.state = 'active';
  assert.strictEqual(snapshot.melodies[0].state, 'locked', 'live update is copied');
  snapshot = runs.nextRunMelodySnapshot(snapshot, 0, false, [melody]);
  assert.strictEqual(snapshot.melodies[0].state, 'active');
  snapshot = runs.nextRunMelodySnapshot(snapshot, 1, false, null);
  assert.strictEqual(snapshot.melodies[0].state, 'active', 'chapter transition/read outage keeps this run');
  melody.state = 'completed';
  snapshot = runs.nextRunMelodySnapshot(snapshot, 3, false, [melody]);
  snapshot = runs.nextRunMelodySnapshot(snapshot, -1, true, null);
  snapshot = runs.nextRunMelodySnapshot(snapshot, -1, false, null);
  snapshot = runs.nextRunMelodySnapshot(snapshot, null, false, null);
  assert.strictEqual(snapshot.melodies[0].state, 'completed', 'end-screen reset and unknown map keep the final snapshot');
  const recorded = snapshot.melodies.map(m => ({ ...m }));
  snapshot = runs.nextRunMelodySnapshot(snapshot, 0, false, null);
  assert.strictEqual(snapshot.melodies, null, 'new run clears previous melodies even without a level-reset signal');
  snapshot = runs.nextRunMelodySnapshot(snapshot, 0, false, [melody]);
  snapshot = runs.nextRunMelodySnapshot(snapshot, 0, true, null);
  assert.strictEqual(snapshot.melodies, null, 'same-map restart clears previous melodies');
  assert.strictEqual(recorded[0].state, 'completed', 'recorded snapshot survives a new run');

  const active = { ...melody, state: 'active', notes_earned: 2 };
  let counted = runs.nextRunMelodySnapshot({ melodies: null, outsideRun: true }, 0, false, [active]);
  counted = runs.nextRunMelodySnapshot(counted, 0, false, [{ ...active, notes_earned: null }]);
  assert.strictEqual(counted.melodies[0].notes_earned, 2, 'brief unreadable counter retains this melody progress');
  counted = runs.nextRunMelodySnapshot(counted, 0, false, [{ ...active, notes_earned: 0 }]);
  assert.strictEqual(counted.melodies[0].notes_earned, 0, 'known zero replaces previous progress');
  counted = runs.nextRunMelodySnapshot(counted, 0, false, [{ ...active, internal_name: 'another', notes_earned: null }]);
  assert.strictEqual(counted.melodies[0].notes_earned, null, 'another melody cannot inherit progress');
  counted = runs.nextRunMelodySnapshot(counted, 0, true, [{ ...active, notes_earned: null }]);
  assert.strictEqual(counted.melodies[0].notes_earned, null, 'next run cannot inherit a count');

  const posted = [];
  const reader = Object.create(Reader.prototype);
  reader.runsWorker = { postMessage: m => posted.push(m) };
  reader.sandmanWorker = reader.tilesWorker = { postMessage() {} };
  reader.clearRun();
  assert.deepStrictEqual(posted, [], 'clearing Live at map -1 cannot clear the History worker');
  reader._lastRelayedRunValues = '{}';
  reader._handleSweepMessage({ type: 'sweep', found: {}, mapId: -1, melodies: null, runReset: true });
  assert.deepStrictEqual(posted, [{ type: 'melodies', melodies: null, mapId: -1, reset: true }], 'sweep relays the map context needed to distinguish end from next run');
}

function main() {
  testRunMelodyRetention();
  testRecord();
  testHeroStats();
  testTalents();
  testTalentDescriptions();
  testScore();
  testEdgeAndSummary();
  console.log('test-runs: ok');
  return 0;
}

module.exports = { main };
if (require.main === module) process.exit(main());
