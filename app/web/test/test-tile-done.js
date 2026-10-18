'use strict';
// Done marks on the placed tiles, in the Electron runtime.
//
// Verifies:
// 1. Left-clicks count a tile down through its badge to done; a click at
//    done changes nothing.
// 2. Right-clicks step it back up to the live count and no further, and the
//    context menu is suppressed.
// 3. A count-one tile goes straight to done on one click.
// 4. The marks survive a re-render of the same frame, and clear when the
//    roster or the map id changes.
// 5. The tally is clamped to the live count: a placement appearing mid-map
//    brings a done tile back with the difference showing.
// 6. The tooltip and aria-label follow what is drawn.

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

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

const chest = { icon: 'map_chest.png', outline: 'map_chest_outline.png', tier: 2, count: 3, label: 'Chest' };
const altar = { icon: 'map_altar.png', outline: null, tier: null, count: 1, label: 'Altar of Heroes' };

const baseFrame = {
  level: 7, in_combat: 0, map_id: 0, map_name: 'Dark Hills', map_sub: 'Chapter 1',
  chapter_icon: 'icon_chapter_1.png', quest_key: 'pigs', quest_name: 'The Three Little Pigs',
  quest_icon: 'house_wood.png', tracked: 28, found: 28, sweeps: 4,
  pid: 1234, base: 0x140000000, process: 'Ravenswatch.exe', binding_vtable: 0x12345,
  melodies: [], melody_status: 'ok', dream_shards: 180,
  sandman: [], sandman_status: 'ok',
  tiles: [chest, altar],
  no_run: false, ready: true, coop: false,
};

async function main() {
  const win = new BrowserWindow({
    width: 1280, height: 800, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const js = (src) => win.webContents.executeJavaScript(src);
  await new Promise((resolve) => {
    win.webContents.once('did-finish-load', resolve);
    win.loadURL(pathToFileURL(INDEX).href);
  });
  const render = (frame) => js(`render(${JSON.stringify(frame)})`);

  // Real events through the delegated listeners, on the art inside the cell
  // rather than the cell itself, as a pointer would land.
  const fire = (n, type) => js(`(() => {
    const t = document.querySelector('#tiles-list .tile-cell:nth-child(${n}) .tile-art');
    const e = new MouseEvent(${JSON.stringify(type)}, { bubbles: true, cancelable: true });
    t.dispatchEvent(e);
    return e.defaultPrevented;
  })()`);
  const click = (n) => fire(n, 'click');
  const rclick = (n) => fire(n, 'contextmenu');
  const cell = (n) => js(`(() => {
    const c = document.querySelector('#tiles-list .tile-cell:nth-child(${n})');
    return { done: c.classList.contains('tile-done'),
      badge: c.querySelector('.tile-count').textContent,
      check: getComputedStyle(c.querySelector('.tile-check')).display,
      art: getComputedStyle(c.querySelector('.tile-art')).opacity,
      tip: c.dataset.tipBody || '',
      aria: c.getAttribute('aria-label') };
  })()`);

  console.log('\ntest-tile-done: hand-kept done marks on the placed tiles');

  await render(baseFrame);
  let c = await cell(1);
  check('fresh: chest shows ×3, not done', !c.done && c.badge === '×3' && c.check === 'none',
    JSON.stringify(c));

  // --- 1. Counting down ---
  await click(1);
  c = await cell(1);
  check('one click: ×2', c.badge === '×2' && !c.done, JSON.stringify(c));
  check('tooltip and aria follow', c.tip === 'Tier 2\n×2' && c.aria === 'Chest Tier 2 ×2',
    JSON.stringify([c.tip, c.aria]));
  await click(1);
  c = await cell(1);
  check('two clicks: no badge, not done', c.badge === '' && !c.done, JSON.stringify(c));
  await click(1);
  c = await cell(1);
  check('three clicks: done, check shown, art dimmed',
    c.done && c.badge === '' && c.check === 'block' && Number(c.art) < 1, JSON.stringify(c));
  check('done tooltip', c.tip === 'Tier 2\nDone' && c.aria === 'Chest Tier 2 Done',
    JSON.stringify([c.tip, c.aria]));
  await click(1);
  c = await cell(1);
  check('a click at done changes nothing', c.done && c.badge === '', JSON.stringify(c));

  // --- 2. Counting back up ---
  const prevented = await rclick(1);
  check('contextmenu is suppressed', prevented === true);
  c = await cell(1);
  check('one right-click: back from done, no badge', !c.done && c.badge === '' && c.check === 'none',
    JSON.stringify(c));
  await rclick(1);
  c = await cell(1);
  check('two right-clicks: ×2', c.badge === '×2', JSON.stringify(c));
  await rclick(1);
  c = await cell(1);
  check('three right-clicks: ×3', c.badge === '×3', JSON.stringify(c));
  await rclick(1);
  c = await cell(1);
  check('a right-click at the live count changes nothing', c.badge === '×3' && !c.done,
    JSON.stringify(c));

  // --- 3. A count-one tile ---
  await click(2);
  c = await cell(2);
  check('count-one tile: one click is done', c.done && c.badge === '' && c.tip === 'Done',
    JSON.stringify(c));

  // --- 4. Persistence and reset ---
  await click(1);
  await render(baseFrame);
  c = await cell(1);
  const a = await cell(2);
  check('a re-render of the same frame keeps the marks', c.badge === '×2' && a.done,
    JSON.stringify([c, a]));

  await render({ ...baseFrame, map_id: 1 });
  c = await cell(1);
  check('a new map id clears the marks', c.badge === '×3' && !(await cell(2)).done,
    JSON.stringify(c));

  await click(1);
  await render({ ...baseFrame, map_id: 1, tiles: [altar, chest] });
  c = await cell(2);
  check('a new roster clears the marks', c.badge === '×3', JSON.stringify(c));

  // --- 5. Clamped to the live count ---
  await render(baseFrame);
  await click(1); await click(1); await click(1);
  c = await cell(1);
  check('setup: chest done', c.done);
  await render({ ...baseFrame, tiles: [{ ...chest, count: 4 }, altar] });
  c = await cell(1);
  check('a placement appearing mid-map brings the tile back with one left',
    !c.done && c.badge === '' && c.check === 'none', JSON.stringify(c));
  await render({ ...baseFrame, tiles: [{ ...chest, count: 2 }, altar] });
  c = await cell(1);
  check('a count falling below the tally reads as done, not negative',
    c.done && c.badge === '', JSON.stringify(c));

  return failures;
}

app.whenReady().then(main).then((f) => {
  console.log(`\n${f === 0 ? 'ALL CHECKS PASSED' : f + ' FAILURE(S)'}`);
  app.exit(f ? 1 : 0);
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
