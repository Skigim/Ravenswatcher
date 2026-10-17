'use strict';
// The History tab, driven through applyHistory() in the Electron runtime with
// no transport, standing in for main.js's readout:history send.
//
// Verifies:
// 1. Before any history the tab shows the empty state, and switching tabs
//    swaps the views: the live panels and the curtain are not drawn while
//    History is selected, and come back on Live.
// 2. Runs render newest first, one card each, with outcome, difficulty, hero,
//    score and talent chips in rarity colours.
// 3. A missing score and missing talents say so instead of drawing zeros, and
//    a zero score draws 0.
// 4. Clicking a card expands its summary and clicking again collapses it; the
//    open card stays open when the history is re-sent.

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

const STATS = {
  damage: { total: 21344.0078, dash: 0, trait: 120.5, attack: 9000.9, power: 5000, special: 3000, defense: 0, ultimate: 4222.6, other: 0, highest: 173.15 },
  support: { self_heal: 63.58, ally_heal: 0, self_shield: 0, ally_shield: 0, blocked: 61.73, revive_assists: 3 },
  sufferings: { taken: 708.5, deaths_doors: 1, feathers: 0 },
  resources: { shards_amassed: 228, shards_spent: 270, stars_of_fate: 2, objects_collected: 4 },
};
const SCARLET = {
  v: 1, id: Date.UTC(2026, 9, 17, 4, 21, 24), ended: '2026-10-17T04:21:24.000Z', result: 'defeat',
  hero: 'Hero_Red_Cinder', hero_definition: 'Heroes\\Red_Update6.herodef.ot',
  difficulty: 2, map: 0, map_name: 'Dark Hills', chapter: 0, playtime_s: 716.97, level: 4.158,
  score: { total: 195, details: ['Base score: 140', 'Level: x1.24', 'Multiplayer: +10 %', 'Altar of Heroes : +5%'] },
  talents: [
    { name: 'Devourer', key: 'k1', rarity: 'Legendary', rarity_code: 3 },
    { name: 'Explosive Rush', key: 'k2', rarity: 'Common', rarity_code: 0 },
    { name: 'Energy', key: 'k3', rarity: 'Rare', rarity_code: 1 },
  ],
  ...STATS, objects: [],
};
const KINTARO = {
  ...SCARLET, id: SCARLET.id - 3600000, ended: '2026-10-17T03:21:24.000Z', result: 'victory',
  hero: 'Hero_Kintaro_Jungle', hero_definition: 'Heroes\\Kintaro.herodef.ot', difficulty: 3,
  score: null, talents: null,
};
const ZERO = { ...SCARLET, id: SCARLET.id - 7200000, score: { total: 0, details: [] }, talents: [] };

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
  await win.loadURL(pathToFileURL(INDEX).href);

  const drawn = (sel) => js(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); return !!n && getComputedStyle(n).display !== 'none'; })()`);
  const click = (sel) => js(`document.querySelector(${JSON.stringify(sel)}).click()`);
  const apply = (runs) => js(`applyHistory(${JSON.stringify({ runs, skipped: 0 })})`);

  console.log('\ntest-history-view: History tab');

  // --- 1. Tabs and empty state ---
  check('history hidden on load', !(await drawn('#history')));
  check('live panels drawn behind the curtain on load', !(await drawn('#history')) && await drawn('.curtain'));
  await click('#tab-history');
  check('History tab selected', await js(`document.getElementById('tab-history').getAttribute('aria-selected')`) === 'true');
  check('history drawn', await drawn('#history'));
  check('curtain not drawn over history', !(await drawn('.curtain')));
  check('live body not drawn', !(await drawn('#live-view')));
  const empty = await js(`document.querySelector('.history-empty') && document.querySelector('.history-empty').textContent`);
  check('empty state says how runs arrive', /Finish a run and it shows up here\./.test(empty || ''), empty);

  // --- 2. Cards ---
  await apply([ZERO, KINTARO, SCARLET]);
  const cards = await js(`[...document.querySelectorAll('.run')].map((r) => ({
    id: Number(r.dataset.runId),
    victory: r.classList.contains('run-victory'),
    outcome: r.querySelector('.run-outcome').textContent,
    difficulty: r.querySelector('.run-difficulty').textContent,
    hero: r.querySelector('.run-hero-name').textContent,
    sub: r.querySelector('.run-sub').textContent,
    score: r.querySelector('.run-score-value').textContent,
    talents: [...r.querySelectorAll('.run-talents .talent')].map((t) => [t.textContent, t.className]),
    none: r.querySelector('.run-talents .run-none') && r.querySelector('.run-talents .run-none').textContent,
  }))`);
  check('three cards', cards.length === 3, String(cards.length));
  check('newest first', cards.map(c => c.id).join() === [SCARLET.id, KINTARO.id, ZERO.id].join());
  const [s, k, z] = cards;
  check('defeat card', s.outcome === 'Defeat' && !s.victory);
  check('victory card', k.outcome === 'Victory' && k.victory);
  check('difficulty named', s.difficulty === 'Darkness' && k.difficulty === 'Nightmare', `${s.difficulty} / ${k.difficulty}`);
  check('hero from the definition', s.hero === 'Scarlet' && k.hero === 'Kintaro', `${s.hero} / ${k.hero}`);
  check('level, map and chapter line', s.sub === 'Level 4 · Dark Hills · Chapter I', s.sub);
  check('score drawn', s.score === '195', s.score);
  check('talent chips in order', s.talents.map(t => t[0]).join() === 'Devourer,Explosive Rush,Energy');
  check('chips carry rarity', s.talents[0][1].includes('talent-legendary') && s.talents[2][1].includes('talent-rare'));
  const chipColour = await js(`getComputedStyle(document.querySelector('.run .talent-legendary')).borderLeftColor`);
  check('legendary chip is coloured', chipColour !== 'rgba(0, 0, 0, 0)' && chipColour !== '', chipColour);

  // --- 3. Missing versus zero ---
  check('missing score is a dash, not zero', k.score === '—', k.score);
  check('missing talents say so', k.none === 'Talents unavailable', k.none);
  check('zero score draws 0', z.score === '0', z.score);
  check('empty build says so', z.none === 'No talents', z.none);

  // --- 4. Expand and collapse ---
  const sel = `.run[data-run-id="${SCARLET.id}"]`;
  check('detail collapsed at first', !(await drawn(`${sel} .run-detail`)));
  await click(`${sel} .run-card`);
  check('click expands', await drawn(`${sel} .run-detail`));
  check('aria-expanded follows', await js(`document.querySelector('${sel} .run-card').getAttribute('aria-expanded')`) === 'true');
  const detail = await js(`document.querySelector('${sel} .run-detail').textContent`);
  check('score lines in detail', detail.includes('Altar of Heroes : +5%') && detail.includes('Total 195'));
  check('statistics rounded down', detail.includes('Damage dealt21,344') && detail.includes('Damage blocked61'));
  check('talent rarities in detail', detail.includes('DevourerLegendary') && detail.includes('EnergyRare'));
  await apply([ZERO, KINTARO, SCARLET]);
  check('open card stays open when history is re-sent', await drawn(`${sel} .run-detail`));
  await click(`${sel} .run-card`);
  check('second click collapses', !(await drawn(`${sel} .run-detail`)));
  const missing = await js(`(() => { document.querySelector('.run[data-run-id="${KINTARO.id}"] .run-card').click();
    return document.querySelector('.run[data-run-id="${KINTARO.id}"] .run-detail').textContent; })()`);
  check('missing score explained in detail', missing.includes("The score wasn't recorded for this run."));

  await click('#tab-live');
  check('Live tab hides history', !(await drawn('#history')));
  check('curtain back on Live', await drawn('.curtain'));

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' FAILURE(S)'}`);
  app.exit(failures === 0 ? 0 : 1);
}

app.whenReady().then(main).catch((err) => {
  console.error(err);
  app.exit(1);
});
