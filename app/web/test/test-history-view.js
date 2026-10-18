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
    { name: 'Devourer', key: 'k1', rarity: 'Legendary', rarity_code: 3, description: 'Fixture #ATTACK@ &+25%~; $-10* damage' },
    { name: 'Explosive Rush', key: 'k2', rarity: 'Common', rarity_code: 0 },
    { name: 'Energy', key: 'k3', rarity: 'Rare', rarity_code: 1 },
  ],
  hero_stats: { vitality: 0, damage: 247, armor: -10, crit_chance: 5, crit_damage: 50 },
  ...STATS, objects: ['ab'.repeat(16), 'cd'.repeat(16)], object_counts: [4, 301],
  melodies: [{ name: 'Fixture Melody', icon: 'fixture_melody.png', notes: 4, notes_earned: 2, state: 'active', effect: 'Fixture effect' }],
};
const KINTARO = {
  ...SCARLET, id: SCARLET.id - 3600000, ended: '2026-10-17T03:21:24.000Z', result: 'victory',
  hero: 'Hero_Kintaro_Jungle', hero_definition: 'Heroes\\Kintaro.herodef.ot', difficulty: 3,
  score: null, talents: null, object_counts: undefined, melodies: undefined, hero_stats: undefined,
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
  check('History is the startup view', await drawn('#history'));
  check('Live curtain stays behind History on load', !(await drawn('.curtain')));
  await click('#tab-history');
  check('History tab selected', await js(`document.getElementById('tab-history').getAttribute('aria-selected')`) === 'true');
  check('history drawn', await drawn('#history'));
  check('curtain not drawn over history', !(await drawn('.curtain')));
  check('live body not drawn', !(await drawn('#live-view')));
  const empty = await js(`document.querySelector('.history-empty') && document.querySelector('.history-empty').textContent`);
  check('empty state says how runs arrive', /Finish a run and it shows up here\./.test(empty || ''), empty);

  // Typography uses bundled files, persists, and affects both views.
  await js(`localStorage.removeItem('ravenswatch:stylized-fonts'); location.reload()`);
  await new Promise(r => win.webContents.once('did-finish-load', r));
  await js(`document.fonts.ready.then(() => true)`);
  check('stylized fonts are on by default', await js(`document.getElementById('stylized-fonts').getAttribute('aria-checked')`) === 'true');
  check('stylized fonts load offline', await js(`document.fonts.load('16px "Germania One"').then(() => document.fonts.load('16px "Alegreya Sans"')).then(() => document.fonts.check('16px "Germania One"') && document.fonts.check('16px "Alegreya Sans"'))`));
  check('body and headings use their stylized fonts', await js(`getComputedStyle(document.body).fontFamily.includes('Alegreya Sans') && getComputedStyle(document.querySelector('.brand')).fontFamily.includes('Germania One')`));
  await click('#stylized-fonts');
  check('standard fonts restore Archivo', await js(`!document.body.classList.contains('stylized-fonts') && getComputedStyle(document.body).fontFamily.startsWith('Archivo')`));
  await js(`location.reload()`);
  await new Promise(r => win.webContents.once('did-finish-load', r));
  check('standard font choice survives restart', await js(`document.getElementById('stylized-fonts').getAttribute('aria-checked')`) === 'false');
  await click('#stylized-fonts');
  await js(`document.fonts.ready.then(() => true)`);

  // A run edge switches once. Manual History browsing survives subsequent
  // frames, unknown readings, and chapter transitions in the same run.
  const frame = {map_id: 0, no_run: false, ready: false, melodies: null, tiles: null, sandman: null, coop: false, level: 1};
  const renderFrame = f => js(`render(${JSON.stringify(f)})`);
  await renderFrame({...frame, map_id: null});
  check('unknown map does not leave startup History', await drawn('#history'));
  await renderFrame(frame);
  check('first active run switches to Live', !(await drawn('#history')));
  await click('#tab-history');
  await renderFrame(frame);
  await renderFrame({...frame, map_id: 1});
  await renderFrame({...frame, map_id: null});
  await renderFrame({...frame, map_id: 1});
  check('manual History stays selected through polls and chapter loads', await drawn('#history'));
  await renderFrame({...frame, map_id: -1, no_run: true});
  check('end screen leaves the chosen view alone', await drawn('#history'));
  await renderFrame(frame);
  check('next run switches to Live again', !(await drawn('#history')));
  await click('#tab-history');
  await renderFrame({...frame, pid: 111});
  await renderFrame({...frame, pid: 222});
  check('a new game process re-arms automatic Live selection', !(await drawn('#history')));
  await click('#tab-history');

  // --- 2. Cards ---
  await apply([ZERO, KINTARO, SCARLET]);
  const cards = await js(`[...document.querySelectorAll('.run')].map((r) => ({
    id: Number(r.dataset.runId),
    victory: r.classList.contains('run-victory'),
    outcome: r.querySelector('.run-outcome').textContent,
    difficulty: r.querySelector('.run-difficulty').dataset.tipName,
    hero: r.querySelector('.run-hero').dataset.tipName,
    sub: r.querySelector('.run-hero').dataset.tipBody,
    score: r.querySelector('.run-score-value').textContent,
    talents: [...r.querySelectorAll('.run-talents .talent')].map((t) => [t.dataset.tipName, t.className]),
    slots: r.querySelectorAll('.run-talents .talent-slot').length,
    emptySlots: r.querySelectorAll('.run-talents .talent-slot-empty').length,
    inlineTalents: r.querySelector('.run-talents').textContent,
    none: r.querySelector('.run-talents').dataset.tipBody,
  }))`);
  check('three cards', cards.length === 3, String(cards.length));
  check('newest first', cards.map(c => c.id).join() === [SCARLET.id, KINTARO.id, ZERO.id].join());
  const [s, k, z] = cards;
  check('defeat card', s.outcome === 'Defeat' && !s.victory);
  check('victory card', k.outcome === 'Victory' && k.victory);
  check('difficulty named', s.difficulty === 'Darkness' && k.difficulty === 'Nightmare', `${s.difficulty} / ${k.difficulty}`);
  check('hero from the definition', s.hero === 'Scarlet' && k.hero === 'Kintarō', `${s.hero} / ${k.hero}`);
  check('level, map and chapter line', s.sub === 'Level 4\nDark Hills · Chapter I', s.sub);
  check('score drawn', s.score === '195', s.score);
  check('talent chips in order', s.talents.map(t => t[0]).join() === 'Devourer,Explosive Rush,Energy');
  check('chips carry rarity', s.talents[0][1].includes('talent-legendary') && s.talents[2][1].includes('talent-rare'));
  check('exactly ten fixed talent slots on every card', cards.every(c => c.slots === 10));
  check('unused slots stay blank in place', s.emptySlots === 7 && k.emptySlots === 10 && z.emptySlots === 10);
  check('talent labels appear only on hover', cards.every(c => c.inlineTalents === ''));
  const portrait = await js(`(() => { const p = document.querySelector('.run-portrait'); const css = getComputedStyle(p);
    return { width: p.getBoundingClientRect().width, border: css.borderWidth }; })()`);
  check('portrait enlarged without a border', portrait.width >= 88 && portrait.border === '0px');
  const hover = async (selector) => js(`(() => { const n = document.querySelector(${JSON.stringify(selector)});
    n.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    return [document.getElementById('tip-name').textContent, document.getElementById('tip-body').textContent]; })()`);
  check('hero name lives in hover tooltip', (await hover('.run .run-hero'))[0] === 'Scarlet');
  check('difficulty name lives in hover tooltip', (await hover('.run .run-difficulty'))[0] === 'Darkness');
  const talentTip = await hover('.run .talent');
  check('talent hover shows resolved effect without game markup', talentTip[0] === 'Devourer' && talentTip[1] === 'Fixture ATTACK +25%; -10 damage');
  check('talent hover includes rarity and icon', await js(`document.getElementById('tip-meta').textContent === 'Legendary' && !document.getElementById('tip-icon').hidden && document.getElementById('tip').dataset.rarity === 'legendary'`));
  check('nested game highlight markers do not leave a stray hash', await js(`cleanGameDescription('Fixture # #ARMOR@ &+45~') === 'Fixture ARMOR +45'`));
  await hover('.run .run-difficulty');
  check('ordinary hover clears talent metadata', await js(`document.getElementById('tip-icon').hidden && document.getElementById('tip-meta').hidden && !document.getElementById('tip').classList.contains('tip-talent')`));
  await hover('.run .talent:nth-child(2)');
  check('missing talent effect is explicit', await js(`document.getElementById('tip-body').textContent.includes("wasn't recorded")`));
  check('stored effect text cannot create HTML', await js(`(() => { const n=talentChip({name:'Fixture', rarity_code:0,description:'<img src=x onerror=alert(1)> &+0%~'}, {}); document.body.append(n); showTip(n); const ok=document.getElementById('tip-body').textContent === '<img src=x onerror=alert(1)> +0%' && !document.getElementById('tip-body').querySelector('img'); n.remove(); hideTip(); return ok; })()`));
  const full = { ...SCARLET, talents: Array.from({ length: 10 }, (_, i) => ({ name: 'Talent ' + i, key: 'k' + i, rarity: 'Rare', rarity_code: 1 })) };
  await apply([full]);
  check('a full build fills all ten slots', await js(`document.querySelectorAll('.run-talents .talent').length`) === 10);
  for (const width of [1280, 980, 800, 600]) {
    win.setSize(width, 800);
    const fits = await js(`(() => { const c = document.querySelector('.run-card');
      const last = c.querySelector('.run-talents').lastElementChild.getBoundingClientRect();
      return c.scrollWidth <= c.clientWidth + 1 && last.right <= c.getBoundingClientRect().right; })()`);
    check('ten slots fit the card at width ' + width, fits);
  }
  win.setSize(1280, 800);
  await apply([ZERO, KINTARO, SCARLET]);

  const chipColour = await js(`getComputedStyle(document.querySelector('.run .talent-legendary')).borderLeftColor`);
  check('legendary chip is coloured', chipColour !== 'rgba(0, 0, 0, 0)' && chipColour !== '', chipColour);

  // --- 3. Missing versus zero ---
  check('missing score is a dash, not zero', k.score === '—', k.score);
  check('missing talents explained on hover', k.none === "Talents weren't recorded for this run.", k.none);
  check('zero score draws 0', z.score === '0', z.score);
  check('empty build explained on hover', z.none === 'No talents taken.', z.none);

  // --- 4. Expand and collapse ---
  const sel = `.run[data-run-id="${SCARLET.id}"]`;
  check('detail collapsed at first', !(await drawn(`${sel} .run-detail`)));
  await click(`${sel} .run-card`);
  check('click expands', await drawn(`${sel} .run-detail`));
  check('aria-expanded follows', await js(`document.querySelector('${sel} .run-card').getAttribute('aria-expanded')`) === 'true');
  const selectTab = key => click(`${sel} .run-detail-tab[data-tab="${key}"]`);
  const activeTab = () => js(`document.querySelector('${sel} .run-detail-tab[aria-selected="true"]').dataset.tab`);
  const tabs = await js(`[...document.querySelectorAll('${sel} .run-detail-tab')].map(n => n.getAttribute('aria-label'))`);
  check('seven game-category tabs in order', tabs.join('|') === 'Hero Details|Score Details|Melodies and Magical Objects|Damage Dealt|Support|Sufferings|Resources');
  check('hero is the default', await activeTab() === 'hero');
  check('expanded footer offers Share Run instead of deletion', await js(`document.querySelector('${sel} .run-detail-actions button').textContent === 'Share Run' && !document.querySelector('${sel} .run-detail-actions').textContent.includes('Delete')`));
  check('saved and current final-stage aliases display Epilogue', await js(`where({map_name:'Baba Yaga Map'}) === 'Epilogue' && where({map_name:'Baba Yaga'}) === 'Epilogue'`));

  check('expanded talents accept keyboard focus', await js(`document.querySelector('${sel} .run-talent-build .talent').tabIndex === 0`));
  await js(`document.querySelector('${sel} .run-talent-build .talent').dispatchEvent(new FocusEvent('focusin', {bubbles:true}))`);
  check('keyboard focus opens the full talent effect', await js(`!document.getElementById('tip').hidden && document.getElementById('tip-body').textContent.includes('+25%')`));
  check('hero tab uses its portrait instead of a text label', await js(`document.querySelector('${sel} [data-tab="hero"]').textContent`) === '');
  check('only one detail panel is visible', await js(`document.querySelectorAll('${sel} .run-detail-panel:not([hidden])').length`) === 1);
  const heroDetails = await js(`document.querySelector('${sel} .run-panel-hero').textContent`);
  const attributes = await js(`[...document.querySelectorAll('${sel} .run-attribute')].map(n => ({label:n.getAttribute('aria-label'), value:n.textContent, icon:n.querySelector('.run-attribute-icon').style.backgroundImage, tip:n.dataset.tipName}))`);
  check('hero attributes use five icons and hover labels', attributes.length === 5 && attributes.every(n => n.icon.includes('asset://icons/stat_') && n.tip && !n.value.includes(n.tip)));
  check('hero attributes preserve zero and negative values', attributes[0].label === 'Vitality: 0' && attributes[2].label === 'Armor: -10');
  check('talents moved to hero details with ten slots', await js(`document.querySelectorAll('${sel} .run-panel-hero .talent-slot').length`) === 10);
  await selectTab('score');
  check('score tab draws its panel', await drawn(`${sel} .run-panel-score`) && !(await drawn(`${sel} .run-panel-hero`)));
  const scoreEntries = await js(`[...document.querySelectorAll('${sel} .run-score-entry')].map(n => ({tip:n.dataset.tipName, label:n.getAttribute('aria-label'), text:n.textContent, icon:n.firstElementChild.style.backgroundImage}))`);
  check('score entries keep saved order and full hover text', JSON.stringify(scoreEntries.map(n => n.tip)) === JSON.stringify(SCARLET.score.details));
  check('score labels are hover-only and keyboard accessible', scoreEntries.every(n => n.text === '' && n.label === n.tip) && await js(`[...document.querySelectorAll('${sel} .run-score-entry')].every(n => n.tabIndex === 0)`));
  check('score entries use level, multiplayer and altar art', scoreEntries[1].icon.includes('score_level.png') && scoreEntries[2].icon.includes('score_multiplayer.png') && scoreEntries[3].icon.includes('map_altar.png'));
  const specialScore = await js(`(() => { const p=runScoreDetails({score:{total:0,details:['Grimoire : +5%','Grimoire : +5%','Unknown activity: +0%','Blood Ritual : +10%']}}); return [...p.querySelectorAll('.run-score-entry')].map(n=>({tip:n.dataset.tipName,icon:n.firstElementChild.style.backgroundImage})); })()`);
  check('duplicate score activities stay separate', specialScore.length === 4 && specialScore[0].tip === specialScore[1].tip && specialScore[0].icon.includes('score_grimoire.png'));
  check('unrecognized score activity keeps its hover with a fallback icon', specialScore[2].tip === 'Unknown activity: +0%' && specialScore[2].icon.includes('icon_question.png'));
  check('Blood Ritual uses the screen-matched crossed swords', specialScore[3].icon.includes('score_keykeeper.png'));
  check('Wishing Well and Stingy Jack score labels resolve existing art', await js(`scoreIconForLine('Wishing Well : +5%', {}) === 'map_wishing_well.png' && scoreIconForLine('Stingy Jack : +5%', {}) === 'score_stingy_jack.png'`));
  await js(`document.querySelector('${sel} .run-score-entry').dispatchEvent(new FocusEvent('focusin', {bubbles:true}))`);
  check('score tooltip appears on keyboard focus', await js(`!document.getElementById('tip').hidden && document.getElementById('tip-name').textContent === 'Base score: 140'`));
  await selectTab('damage');
  check('damage tab includes all eight source rows', await js(`document.querySelectorAll('${sel} .run-damage-row').length`) === 8);
  const damageText = await js(`document.querySelector('${sel} .run-panel-damage').textContent`);
  check('damage and shares rounded down', damageText.includes('21,344') && damageText.includes('9,00042%') && damageText.includes('Highest single damage173'));
  await selectTab('support');
  check('support values preserved', await js(`document.querySelector('${sel} .run-panel-support').textContent.includes('Damage blocked61')`));
  await selectTab('sufferings');
  check('sufferings has its own panel', await drawn(`${sel} .run-panel-sufferings`));
  await selectTab('resources');
  check('resources has its own panel', await drawn(`${sel} .run-panel-resources`));
  await selectTab('inventory');
  check('inventory excludes talents', await js(`document.querySelectorAll('${sel} .run-panel-inventory .talent-slot').length`) === 0);
  check('saved quantities render before metadata', await js(`[...document.querySelectorAll('${sel} .run-objects .run-object-count')].map(n=>n.textContent).join()` ) === '4,301');
  await js(`applyAssets({ ITEM_NAMES: { fixtureobject: 'Fixture Object' }, SHOP_ICONS: { fixtureobject: 'fixture_object.png' },
    ITEM_TEXT: { fixtureobject: 'Fixture tooltip' }, OBJECT_KEYS: { ['ab'.repeat(16)]: 'fixtureobject' }, OBJECT_RARITIES: { ['ab'.repeat(16)]: 'Rare' },
    HERO_ICONS: { Red: 'fixture_hero.png' }, DIFFICULTY_ICONS: { 2: 'fixture_difficulty.png' },
    TALENT_ICONS: { Red: { k1: 'fixture_talent.png' } } })`);
  check('asset arrival keeps card and tab open', await drawn(`${sel} .run-detail`) && await activeTab() === 'inventory');
  const art = await js(`(() => { const r = document.querySelector('${sel}'); return {
    objects: [...r.querySelectorAll('.run-objects .run-object')].map(n => [n.dataset.tipName, n.getAttribute('aria-label'), n.className]),
    inline: r.querySelector('.run-objects').textContent,
    portrait: r.querySelector('.run-portrait').style.backgroundImage,
    difficulty: r.querySelector('.run-difficulty-icon').style.backgroundImage,
    talent: r.querySelector('.talent-icon').style.backgroundImage,
    object: r.querySelector('.run-objects .run-object-icon').style.backgroundImage,
    tip: r.querySelector('.run-object').dataset.tipBody,
    melody: r.querySelector('.run-melodies-block .run-object-icon').style.backgroundImage,
    melodyTip: r.querySelector('.run-melody').dataset.tipBody }; })()`);
  check('inventory names are hover-only and counts stay paired', art.objects[0][0] === 'Fixture Object' && art.objects[0][1].includes('quantity 4') && art.objects[1][1].includes('quantity 301') && !art.inline.includes('Fixture Object'));
  check('object rarity frame comes from its definition', art.objects[0][2].includes('object-rare'));
  check('object uses shop art and tooltip', art.object.includes('asset://icons/fixture_object.png') && art.tip.includes('Fixture tooltip') && art.tip.includes('Quantity: 4'));
  check('hero portrait uses shared cache', art.portrait.includes('asset://icons/fixture_hero.png'));
  check('difficulty icon uses shared cache', art.difficulty.includes('asset://icons/fixture_difficulty.png'));
  check('base score reuses the saved difficulty icon', await js(`document.querySelector('${sel} .run-score-icon').style.backgroundImage.includes('fixture_difficulty.png')`));
  check('talent icon uses hero-specific key', art.talent.includes('asset://icons/fixture_talent.png'));
  check('melody portrait and saved state', art.melody.includes('asset://icons/fixture_melody.png') && art.melodyTip.includes('2/4 notes'));
  const melodyCases = await js(`(() => { const rows = [
    {state:'active', notes_earned:0}, {state:'active', notes_earned:null},
    {state:'completed', notes_earned:4}, {state:'active', notes_earned:5}, {state:'locked', notes_earned:3}
  ]; return rows.map(m => { const n=runMelodies({melodies:[{name:'Fixture',icon:'fixture.png',notes:4,...m}]}).querySelector('.run-melody'); return {label:n.textContent,tip:n.dataset.tipBody,aria:n.getAttribute('aria-label')}; }); })()`);
  check('active melodies preserve zero and unknown separately', melodyCases[0].label === '0/4 notes' && melodyCases[1].label === '—/4 notes');
  check('completed melodies say Completed only', melodyCases[2].label === 'Completed' && melodyCases[2].tip === 'Completed');
  check('invalid counts are unknown and locked counts stay hidden', melodyCases[3].label === '—/4 notes' && melodyCases[4].label === '');
  await js(`document.querySelector('${sel} [data-tab="inventory"]').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight',bubbles:true}))`);
  check('arrow keys move between tabs', await activeTab() === 'damage');
  await js(`document.querySelector('${sel} [data-tab="damage"]').dispatchEvent(new KeyboardEvent('keydown', {key:'Home',bubbles:true}))`);
  check('Home returns to hero details', await activeTab() === 'hero');
  await selectTab('inventory');
  await apply([ZERO, KINTARO, SCARLET]);
  check('open card and selected tab survive history refresh', await drawn(`${sel} .run-detail`) && await activeTab() === 'inventory');
  await click(`${sel} .run-card`);
  check('second click collapses', !(await drawn(`${sel} .run-detail`)));
  await click(`${sel} .run-card`);
  check('reopening keeps the selected category', await activeTab() === 'inventory');
  const other = `.run[data-run-id="${KINTARO.id}"]`;
  await click(`${other} .run-card`);
  check('tabs are independent per run', await js(`document.querySelector('${other} [aria-selected="true"]').dataset.tab`) === 'hero');
  const missing = await js(`document.querySelector('${other} .run-detail').textContent`);
  check('missing score explained', missing.includes("The score wasn't recorded for this run."));
  check('legacy quantities stay unavailable', missing.includes("Quantities weren't recorded for this run."));
  check('legacy melodies stay unavailable', missing.includes("Melodies weren't recorded for this run."));
  check('legacy hero attributes stay unavailable', missing.includes("Hero attributes weren't recorded for this run."));

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
