// Real preload/IPC and renderer, backed exclusively by a synthetic temp database.
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const electron = require('electron');

if (typeof electron === 'string') {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-delete-ui-'));
  const res = require('child_process').spawnSync(electron, [__filename], {
    stdio: 'inherit',
    timeout: 45000,
    env: { ...process.env, RW_DELETE_TEST_DIR: temp },
  });
  fs.rmSync(temp, { recursive: true, force: true });
  process.exit(res.status === null ? 1 : res.status);
}

const { app, BrowserWindow, ipcMain } = electron;
const { HISTORY_FILE, loadHistory, appendRun, deleteRuns, clearHistory, HistoryDeletion } = require('../../history');
const dir = process.env.RW_DELETE_TEST_DIR;
if (!dir || path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('rw-delete-ui-')) {
  throw new Error('Missing isolated test directory');
}
app.setPath('userData', path.join(dir, 'profile'));

const file = path.join(dir, HISTORY_FILE);
const history = loadHistory(file);
const fixture = (id) => ({
  v: 1,
  id,
  hero: 'Hero_Kintaro',
  ended: '2026-10-17T12:00:00Z',
  result: 'defeat',
  talents: [],
});
for (const id of [100, 200, 300]) appendRun(file, history, fixture(id));

let win;
let calls = 0;
const manager = new HistoryDeletion(
  () => history,
  (scope, ids) => {
    calls++;
    if (scope === 'all') clearHistory(file, history);
    else deleteRuns(file, history, ids);
    win.webContents.send('readout:history', history);
  },
);

function handle(channel, fn) {
  ipcMain.handle(channel, (event, input) => {
    assert.strictEqual(event.sender, win.webContents);
    try {
      return { ok: true, ...fn(input) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
}

handle('readout:history-delete-prepare', (input) => manager.prepare(input));
handle('readout:history-delete-confirm', (input) => manager.confirm(input.token, input.typed));
handle('readout:history-delete-cancel', (token) => {
  manager.cancel(token);
  return {};
});

async function main() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, '../../preload.js'),
    },
  });
  const js = (src) => win.webContents.executeJavaScript(src);
  const click = (sel) => js(`document.querySelector(${JSON.stringify(sel)}).click()`);
  const state = () =>
    js(`({
      open: el('history-delete-dialog').open,
      step: historyDelete?.step,
      busy: historyDeleteBusy,
      error: el('history-delete-error').textContent,
      disabled: el('history-delete-confirm').disabled,
    })`);
  const idle = async () => {
    for (let i = 0; i < 100; i++) {
      if (!(await state()).busy) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Deletion dialog did not settle');
  };
  const confirm = async () => {
    await click('#history-delete-confirm');
    await idle();
  };
  const phrase = async (text) =>
    js(`el('history-delete-input').value = ${JSON.stringify(text)};
      el('history-delete-input').dispatchEvent(new Event('input', { bubbles: true }));`);

  await win.loadFile(path.join(__dirname, '../index.html'));
  win.webContents.send('readout:history', history);
  await js('document.fonts.ready');
  await js(`applyHistory(${JSON.stringify(history)})`);
  await click('#history-select');
  await click('.run[data-run-id="300"] .run-selection input');
  await click('#history-delete-selected');
  await idle();
  assert.strictEqual((await state()).step, 1);
  await confirm();
  assert.strictEqual((await state()).step, 2);
  assert.strictEqual(calls, 0);
  await click('#history-delete-cancel');
  assert.strictEqual((await state()).open, false);
  assert.strictEqual(history.runs.length, 3);

  // Finish a single deletion only after both explicit confirmations.
  await click('#history-delete-selected');
  await idle();
  await confirm();
  await confirm();
  assert.strictEqual(calls, 1);
  assert.strictEqual((await state()).open, false);
  assert.deepStrictEqual(loadHistory(file).runs.map((run) => run.id), [100, 200]);

  // Selection controls and count entry for bulk actions.
  await click('#history-select');
  for (const width of [1280, 980, 800, 600]) {
    win.setSize(width, 800);
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.ok(
      await js(`Array.from(document.querySelectorAll('.run')).every(run => run.scrollWidth <= run.clientWidth + 1)`),
      `selection layout fits ${width}px`,
    );
  }
  win.setSize(1280, 800);
  await click('.run[data-run-id="100"] .run-selection input');
  await click('.run[data-run-id="200"] .run-selection input');
  assert.strictEqual(await js(`el('history-delete-selected').textContent`), 'Delete selected (2)');
  await click('#history-delete-selected');
  await idle();
  await confirm();
  assert.strictEqual((await state()).step, 2);
  assert.strictEqual((await state()).disabled, true);
  await phrase('DELETE 1');
  assert.strictEqual((await state()).disabled, true);
  await phrase('DELETE 2');
  assert.strictEqual((await state()).disabled, false);
  await confirm();
  assert.strictEqual((await state()).step, 3);
  assert.strictEqual(calls, 1);
  await click('#history-delete-cancel');
  assert.strictEqual(history.runs.length, 2);

  await click('#history-delete-selected');
  await idle();
  await confirm();
  await phrase('DELETE 2');
  await confirm();
  await confirm();
  assert.deepStrictEqual(loadHistory(file).runs.map((run) => run.id), []);

  appendRun(file, history, fixture(200));
  win.webContents.send('readout:history', history);

  // Delete-all guards its reviewed snapshot against newly completed runs.
  await click('#history-delete-all');
  await idle();
  await confirm();
  await phrase('DELETE 1');
  await confirm();
  appendRun(file, history, fixture(400));
  win.webContents.send('readout:history', history);
  await confirm();
  assert.match((await state()).error, /History changed/);
  assert.strictEqual((await state()).disabled, true);
  assert.strictEqual(history.runs.length, 2);
  await click('#history-delete-cancel');

  await click('#history-delete-all');
  await idle();
  await confirm();
  await phrase('DELETE 2');
  await confirm();
  assert.ok(fs.existsSync(file));
  await confirm();
  assert.ok(fs.existsSync(file));
  assert.deepStrictEqual(loadHistory(file).runs, [], 'delete-all empties the retained database');
  assert.strictEqual(await js(`document.querySelectorAll('.run').length`), 0);
  assert.strictEqual(await js(`el('history-delete-all').disabled`), true);

  // The next completed run uses the cleared DB and re-enables management.
  appendRun(file, history, fixture(500));
  win.webContents.send('readout:history', history);
  await js('Promise.resolve()');
  assert.strictEqual(await js(`el('history-delete-all').disabled`), false);
  await click('#history-delete-all');
  await idle();
  await js(`el('history-delete-dialog').dispatchEvent(new Event('cancel', { cancelable: true }))`);
  assert.strictEqual((await state()).open, false);
  assert.deepStrictEqual(loadHistory(file).runs.map((run) => run.id), [500]);

  console.log('test-history-delete: ok (real preload, selection, 2/3 confirmations, cancel, stale review and empty state)');
  win.destroy();
}

app.whenReady()
  .then(main)
  .then(() => {
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(1);
  });

