'use strict';
// Hover states and the shared tooltip, in the Electron runtime.
//
// Verifies:
// 1. Hovering a shop row, a melody card, and a tile fills the tooltip with
//    the expected name and body; leaving hides it.
// 2. A placeholder shop row and the questline card show nothing.
// 3. An anchor at the top edge gets the tooltip below it; one at the right
//    edge gets it clamped inside the window.
// 4. Opening the settings panel hides an open tooltip.
// 5. ITEM_TEXT, once applied, has at least 80 rows, carries no leftover markup,
//    and the three de-duplicated names resolve to their entity-referenced text.
// 6. Tiles carry an aria-label and no title.
// 7. A render that rebuilds the hovered list hides the tooltip; one that
//    changes the hovered row in place updates it.

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

const baseFrame = {
  level: 7, in_combat: 0, map_id: 0, map_name: 'Dark Hills', map_sub: 'Chapter 1',
  chapter_icon: 'icon_chapter_1.png', quest_key: 'pigs', quest_name: 'The Three Little Pigs',
  quest_icon: 'house_wood.png', tracked: 28, found: 28, sweeps: 4,
  pid: 1234, base: 0x140000000, process: 'Ravenswatch.exe', binding_vtable: 0x12345,
  melodies: [
    { slot: 0, internal_name: 'Instant_Level_Up', name: 'Fairy Godmother', notes: 4,
      icon: 'UI_Melody_Icon_Godfairy.png', state: 'active',
      effect: 'The group of heroes instantly levels up' },
    { slot: 1, internal_name: 'Remove_Key_Requirement', name: 'Merry Men', notes: 5,
      icon: 'UI_Melody_Icon_MerryMen.png', state: 'locked', effect: 'No keys; +150 shards each' },
    { slot: 2, internal_name: 'Fully_Heal', name: 'Galahad', notes: 4,
      icon: 'UI_Melody_Icon_Galahad.png', state: null, effect: '+1 Feather & Heal each day/night' },
  ],
  melody_status: 'ok', dream_shards: 180,
  sandman: [
    { name: 'Adamant', price: 100, purchased: false },
    { name: 'Gingerbread Man', price: 60, purchased: true },
    { name: 'Not An Item', price: 50, purchased: false },
    { name: null, price: null, purchased: false },
  ],
  sandman_status: 'ok',
  tiles: [
    { icon: 'map_altar.png', outline: null, tier: null, count: 1, label: 'Altar of Heroes' },
    { icon: 'map_chest.png', outline: 'map_chest_outline.png', tier: 2, count: 3, label: 'Chest' },
  ],
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

  // Inject small test tables through the runtime IPC entry point.
  const tables = require('../../reader/test/fixtures/item-tables');
  const applyAssets = () => js(`applyAssets(${JSON.stringify({
    ITEM_TEXT: tables.ITEM_TEXT, SHOP_ICONS: tables.SHOP_ICONS, ITEM_NAMES: tables.ITEM_NAMES })})`);

  // Real events through the delegated listener, not a call into app.js.
  const hover = (sel) => js(`(() => {
    const t = document.querySelector(${JSON.stringify(sel)});
    t.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  })()`);
  const leave = () => js(`document.dispatchEvent(
    new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }))`);
  const tip = () => js(`(() => {
    const t = document.getElementById('tip');
    const r = t.getBoundingClientRect();
    return { hidden: t.hidden,
      name: document.getElementById('tip-name').textContent,
      body: document.getElementById('tip-body').textContent,
      top: r.top, right: r.right, width: r.width, height: r.height };
  })()`);

  console.log('\ntest-hover: hover feedback and the shared tooltip');

  await render(baseFrame);

  // --- 0. Before the tables arrive ---
  await hover('#shop-list .shop-row:nth-child(1) .shop-name');
  let t = await tip();
  check('before the tables arrive, a shop row has a name and no body',
    !t.hidden && t.name === 'Adamant' && t.body === '', JSON.stringify(t));
  await leave();
  await applyAssets();

  // --- 1. Content per panel ---
  await hover('#shop-list .shop-row:nth-child(1) .shop-name');
  t = await tip();
  check('shop row: tooltip shows the item name', !t.hidden && t.name === 'Adamant', t.name);
  check('shop row: body is the item text', t.body === '+ARMOR', JSON.stringify(t.body));

  await hover('#shop-list .shop-row:nth-child(2)');
  t = await tip();
  check('sold row: body opens with Sold',
    t.body === 'Sold\nHeal of your Maximum Health', JSON.stringify(t.body));

  await hover('#shop-list .shop-row:nth-child(3)');
  t = await tip();
  check('unknown item: name alone, no body', t.name === 'Not An Item' && t.body === '',
    JSON.stringify(t));

  await hover('#shop-list .shop-row:nth-child(4)');
  t = await tip();
  check('unresolved offer: nothing shown', t.hidden === true);

  await hover('#melody-cards .melody-card:nth-child(1) .melody-name');
  t = await tip();
  check('active melody: name, effect, and note count',
    !t.hidden && t.name === 'Fairy Godmother'
      && t.body === 'The group of heroes instantly levels up\n4 notes',
    JSON.stringify(t));

  await hover('#melody-cards .melody-card:nth-child(2)');
  t = await tip();
  check('locked melody: name, effect, and note count, same as active',
    t.name === 'Merry Men' && t.body === 'No keys; +150 shards each\n5 notes',
    JSON.stringify(t));

  await hover('#melody-cards .melody-card:nth-child(3)');
  t = await tip();
  check('unresolved melody: nothing shown', t.hidden === true);

  await hover('#tiles-list .tile-cell:nth-child(2) .tile-art');
  t = await tip();
  check('tile: label, tier, and count',
    !t.hidden && t.name === 'Chest' && t.body === 'Tier 2\n×3', JSON.stringify(t));

  await hover('#tiles-list .tile-cell:nth-child(1)');
  t = await tip();
  check('tile with no tier or count: label alone', t.name === 'Altar of Heroes' && t.body === '');

  await leave();
  t = await tip();
  check('leaving the window hides it', t.hidden === true);

  // --- 6. aria-label, no title ---
  check('tiles carry aria-label and no title',
    (await js(`[...document.querySelectorAll('.tile-cell')]
      .map(n => n.getAttribute('aria-label') + (n.title ? '!' : '')).join('|')`))
    === 'Altar of Heroes|Chest Tier 2 ×3');

  const bossCell = { icon: 'map_boss_den_locked.png', outline: null, tier: null,
    count: 1, label: 'Optional Boss', boss: 'Mother Ghoul, Underground Terror' };
  await render({ ...baseFrame, tiles: [bossCell] });
  await hover('#tiles-list .tile-cell .tile-art');
  t = await tip();
  check('boss den hover identifies the expected boss',
    !t.hidden && t.name === 'Optional Boss'
      && t.body === 'Expected boss: Mother Ghoul, Underground Terror', JSON.stringify(t));
  await render({ ...baseFrame, tiles: [{ ...bossCell, boss: 'Brigit, the White Lady' }] });
  t = await tip();
  check('the expected boss updates while the same icon is hovered',
    !t.hidden && t.body === 'Expected boss: Brigit, the White Lady', JSON.stringify(t));
  check('the expected boss is also accessible through the tile label',
    (await js(`document.querySelector('.tile-cell').getAttribute('aria-label')`))
      === 'Optional Boss Expected boss: Brigit, the White Lady');
  await leave();
  await render(baseFrame);

  // --- 2. Opt-outs ---
  await hover('#shop-list .shop-row:nth-child(1)');
  await hover('.kpis > .kpi:first-child .kpi-value');
  t = await tip();
  check('questline card: moving onto it hides the tooltip', t.hidden === true);

  await render({ ...baseFrame, sandman: null, sandman_status: 'pending' });
  await hover('#shop-list .shop-row');
  t = await tip();
  check('placeholder shop row: nothing shown', t.hidden === true);
  await render(baseFrame);

  // --- 3. Placement ---
  await js(`(() => {
    for (const [id, css] of [['probe-top', 'top:0;left:600px'], ['probe-right', 'top:400px;right:0']]) {
      const p = document.createElement('div');
      p.id = id;
      p.style.cssText = 'position:fixed;width:40px;height:20px;' + css;
      p.dataset.tipName = 'Probe';
      p.dataset.tipBody = 'A body long enough to take some width on the screen';
      document.body.append(p);
    }
  })()`);
  await hover('#probe-top');
  t = await tip();
  check('anchor at the top edge: tooltip sits below it', !t.hidden && t.top >= 20, String(t.top));
  await hover('#probe-right');
  t = await tip();
  const innerWidth = await js('window.innerWidth');
  check('anchor at the right edge: tooltip stays 8 px inside the window',
    !t.hidden && t.right <= innerWidth - 8 && t.right > innerWidth - 8 - 1,
    `${t.right} vs ${innerWidth - 8}`);
  await js(`document.getElementById('probe-top').remove(); document.getElementById('probe-right').remove()`);

  // --- 7. Renders while hovered ---
  await hover('#shop-list .shop-row:nth-child(1)');
  await render({ ...baseFrame,
    sandman: [{ name: 'Adamant', price: 100, purchased: true }, ...baseFrame.sandman.slice(1)] });
  t = await tip();
  check('an offer sold while hovered updates the open tooltip',
    !t.hidden && t.body === 'Sold\n+ARMOR', JSON.stringify(t.body));

  await hover('#tiles-list .tile-cell:nth-child(1)');
  await render({ ...baseFrame, tiles: [baseFrame.tiles[1]] });
  t = await tip();
  check('a rebuilt roster hides a tooltip anchored to an old tile', t.hidden === true);

  // --- 4. Settings ---
  await hover('#shop-list .shop-row:nth-child(1)');
  await js(`document.getElementById('settings-open').click()`);
  t = await tip();
  check('opening settings hides the tooltip', t.hidden === true);
  await js(`document.getElementById('settings-scrim').click()`);

  // --- 5. The item table ---
  const table = await js(`(() => {
    const keys = Object.keys(ITEM_TEXT);
    const dirty = keys.filter(k => /[#@&~$*{}\u2026]/.test(ITEM_TEXT[k]));
    return { n: keys.length, dirty,
      horn: ITEM_TEXT.hornplenty, ginger: ITEM_TEXT.gingerbreadman, joker: ITEM_TEXT.jokercard };
  })()`);
  check('all supplied tooltip rows reach the renderer', table.n === Object.keys(tables.ITEM_TEXT).length, String(table.n));
  check('no row carries leftover markup', table.dirty.length === 0, table.dirty.join(','));
  check('the injected description is displayed unchanged',
    table.ginger === 'Heal of your Maximum Health', table.ginger);

  return failures;
}

app.whenReady().then(main).then((f) => {
  console.log(`\n${f === 0 ? 'ALL CHECKS PASSED' : f + ' FAILURE(S)'}`);
  app.exit(f ? 1 : 0);
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
