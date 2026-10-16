'use strict';
// The update bar and the version row in settings, driven through applyUpdate()
// in the Electron runtime with no transport. After each reload the test
// applies the message again, standing in for main.js, which resends the
// kept result on every did-finish-load.
//
// Verifies:
// 1. A newer release shows the bar with the version in its text, the download
//    link pointing at the release page, and the settings row offering it too.
// 2. Skip this release hides the bar, stores the version, keeps it hidden
//    across a reload with the same message, and the settings row still offers
//    the download. A later version shows the bar again.
// 3. Remind me later hides the bar for the session; a reload shows it again.
// 4. ok:true with nothing newer reads "Up to date" with the bar hidden;
//    ok:false reads a blank note with the bar hidden. Both show the version.
//    With the Diagnostics toggle on, a failed check's reason shows in the note,
//    and the note follows the toggle even when storage refuses the write.
// 5. Before any message the label reads "Version" alone and the bar is hidden.
// 6. Hidden means not drawn: the [hidden] attribute must beat the display
//    rules on .update-bar and .coffee (computed display, not the property).

const path = require('path');
const { pathToFileURL } = require('url');
const electron = require('electron');

if (typeof electron === 'string') {
  const { spawnSync } = require('child_process');
  const res = spawnSync(electron, [__filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  process.exit(res.status !== null ? res.status : 1);
}

const { app, BrowserWindow } = electron;
const INDEX = path.join(__dirname, '..', 'index.html');
const KEY = 'ravenswatch:skip-version';
const URL_014 = 'https://github.com/Skigim/Ravenswatcher/releases/tag/v0.1.4';
const NEWER = { current: '0.1.3', ok: true, latest: '0.1.4', url: URL_014 };

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

async function main() {
  const win = new BrowserWindow({
    width: 1280, height: 800, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const js = (src) => win.webContents.executeJavaScript(src);
  const load = () => new Promise((resolve) => {
    win.webContents.once('did-finish-load', resolve);
    win.loadURL(pathToFileURL(INDEX).href);
  });
  const reload = () => new Promise((resolve) => {
    win.webContents.once('did-finish-load', resolve);
    win.webContents.reload();
  });
  const apply = (info) => js(`applyUpdate(${JSON.stringify(info)})`);
  const click = (id) => js(`document.getElementById(${JSON.stringify(id)}).click()`);
  const state = () => js(`(() => {
    const g = (id) => document.getElementById(id);
    return {
      barHidden: g('update-bar').hidden,
      barDrawn: getComputedStyle(g('update-bar')).display !== 'none',
      rowDrawn: getComputedStyle(g('version-download')).display !== 'none',
      text: g('update-text').textContent,
      barHref: g('update-download').getAttribute('href'),
      label: g('version-label').textContent,
      note: g('version-note').textContent,
      rowHidden: g('version-download').hidden,
      rowHref: g('version-download').getAttribute('href'),
      stored: localStorage.getItem(${JSON.stringify(KEY)}),
    };
  })()`);

  await load();
  // Both keys, so a run that died mid-way cannot leave Diagnostics on.
  await js(`localStorage.removeItem(${JSON.stringify(KEY)}); localStorage.removeItem('ravenswatch:diagnostics')`);
  await reload();

  console.log('\ntest-update-bar: update bar and version row');

  // --- 5. Before any message ---
  let s = await state();
  check('bar hidden before any message', s.barHidden);
  check('bar not drawn before any message', !s.barDrawn);
  check('row link not drawn before any message', !s.rowDrawn);
  check('label reads "Version" alone', s.label === 'Version', s.label);
  check('row link hidden before any message', s.rowHidden);

  // --- 1. Newer release ---
  await apply(NEWER);
  s = await state();
  check('bar shown for a newer release', !s.barHidden);
  check('bar drawn for a newer release', s.barDrawn);
  check('row link drawn for a newer release', s.rowDrawn);
  check('bar text names the version', s.text === 'Ravenswatcher 0.1.4 is available.', s.text);
  check('bar download points at the release', s.barHref === URL_014, s.barHref);
  check('label shows the running version', s.label === 'Version 0.1.3', s.label);
  check('note offers the new version', s.note === '0.1.4 available', s.note);
  check('row link shown', !s.rowHidden);
  check('row link points at the release', s.rowHref === URL_014, s.rowHref);

  // --- 3. Remind me later ---
  await click('update-later');
  s = await state();
  check('remind hides the bar', s.barHidden);
  check('remind stores nothing', s.stored === null, String(s.stored));
  check('remind keeps the row link', !s.rowHidden);
  await apply(NEWER);
  s = await state();
  check('a repeat message in the same session keeps the bar hidden', s.barHidden);
  await reload();
  await apply(NEWER);
  s = await state();
  check('after a reload the bar is back', !s.barHidden);

  // --- 2. Skip this release ---
  await click('update-skip');
  s = await state();
  check('skip hides the bar', s.barHidden);
  check('skip stores the version', s.stored === '0.1.4', String(s.stored));
  check('skip keeps the row link', !s.rowHidden && s.rowHref === URL_014);
  await reload();
  await apply(NEWER);
  s = await state();
  check('skipped version stays hidden across a reload', s.barHidden);
  check('row still offers the skipped version', !s.rowHidden && s.note === '0.1.4 available', s.note);
  await apply({ ...NEWER, latest: '0.1.5', url: URL_014.replace('0.1.4', '0.1.5') });
  s = await state();
  check('a later version shows the bar again', !s.barHidden);
  check('bar text names the later version', s.text === 'Ravenswatcher 0.1.5 is available.', s.text);

  // --- 4. Up to date, and a failed check ---
  await js(`localStorage.removeItem(${JSON.stringify(KEY)})`);
  await reload();
  await apply({ current: '0.1.3', ok: true, latest: null, url: null });
  s = await state();
  check('up to date: bar hidden', s.barHidden);
  check('up to date: note', s.note === 'Up to date', s.note);
  check('up to date: label', s.label === 'Version 0.1.3', s.label);
  check('up to date: row link hidden', s.rowHidden);
  check('up to date: bar not drawn', !s.barDrawn);
  check('up to date: row link not drawn', !s.rowDrawn);

  await reload();
  await apply({ current: '0.1.3', ok: false, latest: null, url: null });
  s = await state();
  check('failed check: bar hidden', s.barHidden);
  check('failed check: blank note', s.note === '', JSON.stringify(s.note));
  check('failed check: label still shows the version', s.label === 'Version 0.1.3', s.label);
  check('failed check: row link hidden', s.rowHidden);

  // --- 4b. The reason shows only with Diagnostics on ---
  const FAILED = { current: '0.1.3', ok: false, latest: null, url: null, reason: 'status 403' };
  await apply(FAILED);
  s = await state();
  check('failed check, diagnostics off: note stays blank', s.note === '', JSON.stringify(s.note));
  await js(`localStorage.setItem('ravenswatch:diagnostics', 'on')`);
  await reload();
  await apply(FAILED);
  s = await state();
  check('failed check, diagnostics on: note carries the reason', s.note === 'Check failed: status 403', s.note);
  await click('diag-bar');
  s = await state();
  check('turning diagnostics off clears the reason', s.note === '', JSON.stringify(s.note));
  await click('diag-bar');
  s = await state();
  check('turning diagnostics on brings it back', s.note === 'Check failed: status 403', s.note);
  // Storage refuses the write: the note follows the toggle, not the stale
  // stored "on". The override lasts until the next load.
  await js(`Storage.prototype.setItem = () => { throw new Error('blocked'); }; null`);
  await click('diag-bar');
  s = await state();
  check('storage blocked: turning diagnostics off still clears the reason', s.note === '', JSON.stringify(s.note));
  await js(`localStorage.removeItem('ravenswatch:diagnostics')`);
  await reload();

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' FAILURE(S)'}`);
  app.exit(failures === 0 ? 0 : 1);
}

app.whenReady().then(main).catch((err) => {
  console.error(err);
  app.exit(1);
});
