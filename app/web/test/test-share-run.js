// Synthetic run data and icons only. Clipboard writes are injected for tests.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const electron = require('electron');

if (typeof electron === 'string') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-share-ui-'));
  try {
    const r = require('child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)], {
      stdio: 'inherit',
      timeout: 50000,
      env: { ...process.env, RW_SHARE_TEST_DIR: dir },
    });
    process.exitCode = r.status === null ? 1 : r.status;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return;
}

const { app, BrowserWindow, protocol, ipcMain } = electron;
const { RunSharer } = require('../../share');
const dir = process.env.RW_SHARE_TEST_DIR;
assert.ok(dir && path.dirname(dir) === os.tmpdir() && path.basename(dir).startsWith('rw-share-ui-'));
app.setPath('userData', path.join(dir, 'profile'));

// CI may have no usable GPU. Exercise real offscreen exports in that mode too.
if (process.argv.includes('--disable-gpu')) app.disableHardwareAcceleration();
app.commandLine.appendSwitch(
  'force-device-scale-factor',
  process.argv.find((arg) => arg.startsWith('--scale='))?.slice(8) || '1',
);
protocol.registerSchemesAsPrivileged([
  { scheme: 'asset', privileges: { standard: true, secure: true, corsEnabled: true } },
]);

const fixture = {
  v: 1,
  id: 100,
  hero: 'Hero_Kintaro_Raven',
  hero_definition: 'Heroes\\Kintaro.herodef.ot',
  map_name: 'Baba Yaga Map',
  difficulty: 2,
  result: 'victory',
  playtime_s: 4093,
  score: { total: 578, details: ['Secret modifier should never appear'] },
  talents: Array.from({ length: 10 }, (_, i) => ({
    key: 'k' + i,
    name: i === 0 ? 'Fixture with a long talent name that wraps completely' : 'Fixture Talent ' + i,
    rarity: 'Rare',
  })),
  objects: ['a', 'b'],
  object_counts: [0, 301],
  melodies: [
    { name: 'First', state: 'completed', notes: 4 },
    { name: 'Second', state: 'active', notes: 5, notes_earned: 0 },
    { name: 'Third', state: 'locked', notes: 4 },
  ],
  damage: {
    total: 100,
    attack: 75,
    power: 25,
    special: 0,
    ultimate: 0,
    dash: 0,
    trait: 0,
    defense: 0,
    other: 0,
    highest: 30,
  },
};

const tables = {
  OBJECT_KEYS: { a: 'one', b: 'two' },
  ITEM_NAMES: { one: 'Fixture Object', two: 'Second Object' },
  OBJECT_RARITIES: { a: 'Common', b: 'Epic' },
};

// No tables.json exists: export must use the injected snapshot.
let currentTables = tables;
let tableReads = 0;
const cachedTables = () => {
  tableReads++;
  return currentTables;
};

let view;
let ui;
let writes = 0;
let captured;

async function main() {
  // Deliberately missing art proves names still render and decode failure is bounded.
  protocol.handle('asset', () => new Response('', { status: 404 }));
  view = new BrowserWindow({
    width: 1600,
    height: 1000,
    useContentSize: true,
    show: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  view.setMenu(null);
  await view.loadFile(path.join(__dirname, '../share.html'));

  const js = (source) => view.webContents.executeJavaScript(source);
  const render = (run = fixture, stylizedFonts = true) =>
    js(`renderShare(${JSON.stringify({ run, tables, stylizedFonts })})`);

  let bounds = await render();
  assert.strictEqual(bounds.width, 1600);
  assert.strictEqual(bounds.height, 1000, 'ordinary builds use the default canvas');

  let data = await js(`({
    text: document.body.textContent,
    name: document.querySelector('h1').textContent,
    accessible: document.querySelector('h1').getAttribute('aria-label'),
    glyph: getComputedStyle(document.querySelector('.g-macron'), '::before').content,
    missing: document.querySelectorAll('.art.missing').length,
    overflow: [...document.querySelectorAll('.item strong')].some(n => n.scrollWidth > n.clientWidth + 1)
  })`);
  assert.strictEqual(data.name, 'Kintarō');
  assert.strictEqual(data.accessible, 'Kintarō');
  assert.strictEqual(data.glyph, '"o"');
  assert.ok(data.missing > 0);
  assert.ok(!data.overflow);

  for (const text of ['Epilogue', '0/5 notes', 'Completed', 'Locked', '×0', '×301', 'github.com/Skigim/Ravenswatcher']) {
    assert.ok(data.text.includes(text), text);
  }
  assert.ok(!data.text.includes('Secret modifier'));
  assert.ok(!data.text.includes('10 / 10'));
  assert.ok(!data.text.includes('unique'));

  await render(fixture, false);
  assert.ok(
    await js(`getComputedStyle(document.querySelector('h1')).fontFamily.includes('Archivo')
      && getComputedStyle(document.querySelector('.g-macron'), '::before').content === 'none'`),
  );

  const large = {
    ...fixture,
    objects: Array.from({ length: 60 }, (_, i) => 'object' + i),
    object_counts: null,
  };
  bounds = await render(large);
  assert.ok(bounds.height > 1000, 'large inventory grows vertically');
  assert.strictEqual(await js('document.querySelectorAll(".object").length'), 60);

  await render({
    ...fixture,
    score: null,
    talents: null,
    objects: null,
    melodies: [{ name: 'Unknown', state: 'active', notes: 4, notes_earned: null }],
    damage: {},
  });
  data = await js('document.body.textContent');
  assert.ok(
    data.includes('—/4 notes')
      && data.includes('Talents not recorded.')
      && data.includes('Objects not recorded.'),
  );

  const before = JSON.stringify(fixture);
  const sharer = new RunSharer({
    findRun: (id) => (id === 100 ? fixture : undefined),
    tables: cachedTables,
    writeImage: (image) => {
      writes++;
      captured = image;
    },
  });
  assert.strictEqual((await sharer.share({ runId: 99, stylizedFonts: true })).ok, false);
  assert.strictEqual((await sharer.share({ runId: '100', stylizedFonts: true })).ok, false);
  assert.strictEqual(writes, 0);
  assert.strictEqual(tableReads, 0);

  const job = sharer.share({ runId: 100, stylizedFonts: true });
  assert.match((await sharer.share({ runId: 100, stylizedFonts: true })).error, /Another/);
  let result = await job;
  assert.ok(result.ok, result.error);
  assert.strictEqual(writes, 1);
  assert.strictEqual(tableReads, 1);

  const png = captured.toPNG();
  assert.strictEqual(png.readUInt32BE(16), 1600, 'clipboard PNG physical width independent of DPI');
  assert.ok(png.readUInt32BE(20) >= 1000);
  assert.strictEqual(JSON.stringify(fixture), before, 'sharing never changes saved data');

  currentTables = {
    ...tables,
    ITEM_NAMES: { ...tables.ITEM_NAMES, one: 'Refreshed fixture' },
  };
  let largeCapture;
  const largeSharer = new RunSharer({
    findRun: () => large,
    tables: cachedTables,
    writeImage: (image) => {
      largeCapture = image;
    },
  });
  result = await largeSharer.share({ runId: 100, stylizedFonts: true });
  assert.ok(result.ok, result.error);
  assert.strictEqual(largeCapture.toPNG().readUInt32BE(16), 1600);
  assert.ok(largeCapture.toPNG().readUInt32BE(20) > 1000, 'complete tall image reaches the clipboard writer');

  assert.strictEqual(tableReads, 2, 'each export reads the current cache once');
  currentTables = null;
  assert.ok((await sharer.share({ runId: 100, stylizedFonts: false })).ok, 'missing cached tables still export');

  const failing = new RunSharer({
    findRun: () => fixture,
    tables: cachedTables,
    writeImage: () => {
      throw Error('Fixture clipboard failure');
    },
  });
  assert.match((await failing.share({ runId: 100, stylizedFonts: true })).error, /Fixture clipboard failure/);

  const timeout = new RunSharer({
    findRun: () => fixture,
    tables: cachedTables,
    timeoutMs: 1,
    writeImage: () => {
      throw Error('Should never write after timeout');
    },
  });
  assert.match((await timeout.share({ runId: 100, stylizedFonts: true })).error, /timed out/);

  // Real sandboxed preload bridge and button feedback, including in-flight polls.
  let release;
  ipcMain.handle('readout:share-run', (_event, input) =>
    new Promise((resolve) => {
      assert.strictEqual(input.runId, 100);
      release = resolve;
    }),
  );
  ui = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, '../../preload.js'),
    },
  });
  await ui.loadFile(path.join(__dirname, '../index.html'));
  const uj = (s) => ui.webContents.executeJavaScript(s);
  await uj(`applyHistory({ runs: [${JSON.stringify(fixture)}], skipped: 0 });
    document.querySelector('.run-card').click();
    document.querySelector('.run-share').click()`);
  for (let i = 0; i < 50 && !release; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(release);
  assert.ok(await uj(`document.querySelector('.run-share').disabled`));
  await uj(`applyHistory({ runs: [${JSON.stringify(fixture)}], skipped: 0 })`);
  assert.ok(await uj(`document.querySelector('.run-share').disabled`));
  release({ ok: true });
  for (let i = 0; i < 50 && (await uj('shareBusy')); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.strictEqual(await uj(`document.querySelector('.run-share-status').textContent`), 'Copied to clipboard');

  await uj(`document.querySelector('.run-share').click()`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  release({ ok: false, error: 'Fixture failure' });
  for (let i = 0; i < 50 && (await uj('shareBusy')); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.strictEqual(await uj(`document.querySelector('.run-share-status').textContent`), 'Fixture failure');

  const scale = process.argv.find((arg) => arg.startsWith('--scale='))?.slice(8) || '1';
  console.log(`test-share-run: ok (${scale}x DPI)`);
}

app.whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

