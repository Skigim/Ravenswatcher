'use strict';
const assert = require('assert');
const { Worker, MessageChannel } = require('worker_threads');
const { Reader } = require('../reader');
const { readState } = require('../state');
const { RUN_CLASSES, nextRunMelodySnapshot } = require('../runs');
const { discoverRunEnd } = require('../runs-worker');
const { nextMelodies } = require('../sweeper');
const { WorkerControl } = require('../worker-control');
const { createLifecycle } = require('../../lifecycle');

function transitions() {
  const reader = Object.create(Reader.prototype);
  const values = { 'Hero Level': 8, 'Current map id': 0 };
  let clears = 0;
  Object.assign(reader, {
    _lastHeroLevel: 8,
    _lastObservedMapId: 0,
    resolved: Object.fromEntries(Object.keys(values).map((key) => [key, { binding_addr: key }])),
    pollValue: (key) => values[key],
    mapNames: { 0: 'Dark Hills' },
    sandmanWorker: { postMessage: () => clears++ },
    tilesWorker: { postMessage() {} },
    placed: { mapId: 0, placed: [] },
    melodiesData: [],
    sandmanData: [],
    tilesRoster: [],
    runSummaries: [{ id: 42 }],
  });
  values['Hero Level'] = 1;
  values['Current map id'] = -1;
  reader.get('Current map id');
  reader.get('Hero Level');
  assert.strictEqual(clears, 0, 'getters cannot clear state');
  const frame = readState(reader);
  assert.strictEqual(clears, 1, 'simultaneous transitions clear once');
  assert.strictEqual(frame.melodies, null, 'snapshot follows the clear');
  assert.strictEqual(frame.run_summary.id, 42, 'Live clear preserves queued History');
  readState(reader);
  assert.strictEqual(clears, 1, 'remaining outside a run does not clear repeatedly');
  reader.updateTransitions(null, null);
  reader.updateTransitions(1, 0);
  reader.melodiesData = [{ name: 'Fixture' }];
  reader.updateTransitions(2, 1);
  assert.strictEqual(clears, 1, 'ordinary chapter changes preserve Live melodies');
  const melody = { internal_name: 'Fixture', state: 'active', notes: 4, notes_earned: 2 };
  assert.deepStrictEqual(nextMelodies([melody], 1, null), [melody]);
  let history = nextRunMelodySnapshot({ melodies: [melody], outsideRun: false }, -1, false, null);
  assert.deepStrictEqual(history.melodies, [melody]);
  history = nextRunMelodySnapshot(history, 0, true, null);
  assert.strictEqual(history.melodies, null, 'new run cannot inherit previous History melody');
}

function discovery() {
  let passes = 0;
  const classes = new Map([
    [10, RUN_CLASSES.settings],
    [11, RUN_CLASSES.settings],
    [20, RUN_CLASSES.runtime],
    [30, RUN_CLASSES.score],
    [40, RUN_CLASSES.record],
  ]);
  const found = discoverRunEnd({}, classes, (_proc, targets) => {
    passes++;
    assert.deepStrictEqual(targets, [10, 11, 20, 30]);
    return new Map([
      [10, [101]],
      [11, [111]],
      [20, [201]],
      [30, [301]],
    ]);
  });
  assert.strictEqual(passes, 1);
  assert.deepStrictEqual(found, { settings: [101, 111], runtime: [201], score: [301] });
  discoverRunEnd({}, new Map(), () => {
    throw Error('empty targets must not scan');
  });
}

async function lifecycle() {
  for (const forced of [false, true]) {
    const events = [];
    let finish;
    const state = createLifecycle({
      stop: () =>
        new Promise((resolve) => {
          finish = () => {
            events.push(forced ? 'killed' : 'closed');
            resolve();
          };
        }),
      quit: () => events.push('quit'),
      relaunch: () => events.push('relaunch'),
      focus: () => events.push('focus'),
    });
    state.secondInstance();
    const event = { preventDefault: () => events.push('prevent') };
    const done = state.beforeQuit(event);
    await Promise.resolve();
    state.secondInstance();
    state.secondInstance();
    assert.strictEqual(state.beforeQuit(event), done);
    assert.ok(!events.includes('relaunch'));
    finish();
    await done;
    assert.deepStrictEqual(events.slice(-3), [forced ? 'killed' : 'closed', 'relaunch', 'quit']);
    assert.strictEqual(events.filter((e) => e === 'relaunch').length, 1);
    state.beforeQuit({
      preventDefault: () => {
        throw Error('final quit must proceed');
      },
    });
  }
}

async function workers() {
  const channel = new MessageChannel();
  const control = new WorkerControl(channel.port1);
  const waiting = control.wait(60000);
  channel.port2.postMessage({ type: 'stop' });
  await waiting;
  assert.strictEqual(control.stopped, true);
  control.dispose();
  channel.port1.close();
  channel.port2.close();
  // A real worker finishes a synchronous blocking operation before processing stop.
  const worker = new Worker(
    `
    const { parentPort, workerData } = require('worker_threads');
    const { WorkerControl } = require(workerData);
    const control = new WorkerControl(parentPort);
    parentPort.unref();
    (async () => {
      parentPort.postMessage('busy');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      await control.wait(60000);
      control.dispose();
      parentPort.postMessage('closed');
    })();`,
    { eval: true, workerData: require.resolve('../worker-control') },
  );
  const messages = [];
  worker.on('message', (message) => {
    messages.push(message);
    if (message === 'busy') worker.postMessage({ type: 'stop' });
  });
  const code = await new Promise((resolve, reject) => {
    worker.once('exit', resolve);
    worker.once('error', reject);
  });
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(messages, ['busy', 'closed']);
}

async function main() {
  transitions();
  discovery();
  await lifecycle();
  await workers();
  console.log('test-review-fixes: ok (transitions, batched discovery, shutdown and relaunch)');
}

module.exports = { main };
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

