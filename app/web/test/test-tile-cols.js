'use strict';
// Tiles across slider test in Electron runtime.
//
// Verifies:
// 1. With nothing stored the slider and grid read 5, and the cell width
//    matches (content width - 4 gaps) / 5.
// 2. Moving the slider to 3 and to 8 reflows the grid and the cell width
//    tracks the formula.
// 3. A chosen value survives a page reload.
// 4. Garbage stored values fall back to 5 on load.
// 5. A later render() keeps the chosen column count.

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
const KEY = 'ravenswatch:tile-columns';
const GAP = 10;

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

const ICONS = [
  ['map_boss_den.png', null, 3], ['map_chest.png', 'map_chest_outline.png', 1],
  ['map_chest_super.png', 'map_chest_super_outline.png', 3], ['map_crystal.png', 'map_crystal_outline.png', 1],
  ['map_thieves_stash.png', 'map_thieves_stash_outline.png', 2], ['map_altar.png', null, null],
  ['map_wishing_well.png', 'map_wishing_well_outline.png', null], ['map_astrolab.png', 'map_astrolab_outline.png', 1],
  ['map_cauldron.png', 'map_cauldron_outline.png', 3], ['map_grimoire.png', 'map_grimoire_outline.png', 2],
];

function roster(n) {
  const tiles = [];
  for (let i = 0; i < n; i++) {
    const [icon, outline, tier] = ICONS[i % ICONS.length];
    tiles.push({ icon, outline, tier, count: (i % 4 === 1) ? 2 : 1, label: icon });
  }
  return tiles;
}

const baseFrame = {
  level: 7, in_combat: 0, map_id: 0, map_name: 'Dark Hills', map_sub: 'Chapter 1',
  chapter_icon: 'icon_chapter_1.png', quest_key: 'pigs', quest_name: 'The Three Little Pigs',
  quest_icon: 'house_wood.png', tracked: 28, found: 28, sweeps: 4,
  pid: 1234, base: 0x140000000, process: 'Ravenswatch.exe', binding_vtable: 0x12345,
  melodies: [], melody_status: 'ok', dream_shards: 180,
  sandman: null, sandman_status: 'pending',
  tiles: roster(20), no_run: false, ready: true, coop: false,
};

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
  const render = () => js(`render(${JSON.stringify(baseFrame)})`);

  // Slider value, output text, resolved column count, and the geometry the
  // formula needs: the list's content width and the first cell's width.
  const measure = () => js(`(() => {
    const list = document.getElementById('tiles-list');
    const cs = getComputedStyle(list);
    const content = list.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const cols = cs.gridTemplateColumns.split(' ').length;
    const cell = document.querySelector('.tile-cell');
    return {
      slider: document.getElementById('tile-cols').value,
      output: document.getElementById('tile-cols-value').textContent,
      cols,
      content,
      cell: cell ? cell.getBoundingClientRect().width : null,
    };
  })()`);
  const expectedEdge = (m, n) => (m.content - (n - 1) * GAP) / n;
  const near = (a, b) => Math.abs(a - b) <= 0.5;

  await load();
  await js(`localStorage.removeItem(${JSON.stringify(KEY)})`);
  await reload();

  console.log('\ntest-tile-cols: tiles across slider');

  // --- 1. Default ---
  await render();
  let m = await measure();
  check('slider reads 5 with nothing stored', m.slider === '5', m.slider);
  check('output shows 5', m.output === '5', m.output);
  check('grid has 5 columns', m.cols === 5, String(m.cols));
  check('cell width matches (content - 4 gaps) / 5',
    m.cell !== null && near(m.cell, expectedEdge(m, 5)),
    `${m.cell} vs ${expectedEdge(m, 5)}`);

  // --- 2. Slider moves reflow the grid ---
  const setSlider = (n) => js(`(() => {
    const s = document.getElementById('tile-cols');
    s.value = ${n};
    s.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);

  for (const n of [3, 8]) {
    await setSlider(n);
    m = await measure();
    check(`slider at ${n}: grid has ${n} columns`, m.cols === n, String(m.cols));
    check(`slider at ${n}: output shows ${n}`, m.output === String(n), m.output);
    check(`slider at ${n}: cell width matches formula`,
      near(m.cell, expectedEdge(m, n)), `${m.cell} vs ${expectedEdge(m, n)}`);
  }

  // --- 5. A later render keeps the count (checked here while at 8) ---
  await render();
  m = await measure();
  check('render() after a slider change keeps 8 columns', m.cols === 8, String(m.cols));

  // --- 3. Persistence ---
  await setSlider(7);
  check('value is stored', (await js(`localStorage.getItem(${JSON.stringify(KEY)})`)) === '7');
  await reload();
  await render();
  m = await measure();
  check('after reload the slider reads 7', m.slider === '7', m.slider);
  check('after reload the grid has 7 columns', m.cols === 7, String(m.cols));

  // --- 4. Garbage falls back ---
  for (const bad of ['abc', '12', '0', '2.5']) {
    await js(`localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(bad)})`);
    await reload();
    await render();
    m = await measure();
    check(`stored ${JSON.stringify(bad)} falls back to 5`,
      m.slider === '5' && m.cols === 5, `slider ${m.slider}, cols ${m.cols}`);
  }

  await js(`localStorage.removeItem(${JSON.stringify(KEY)})`);
  return failures;
}

app.whenReady().then(main).then((f) => {
  console.log(`\n${f === 0 ? 'ALL CHECKS PASSED' : f + ' FAILURE(S)'}`);
  app.exit(f ? 1 : 0);
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
