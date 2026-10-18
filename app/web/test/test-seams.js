'use strict';
// The panel-lines toggle, checked in a real renderer.
//
// The one claim this feature makes that is easy to get wrong and impossible
// to eyeball reliably: turning the lines off must not move ANYTHING. Every
// seam keeps its 2px and only its paint changes, so the test is a rect
// snapshot of every element in the shell before and after the toggle, diffed
// exactly. gap: 0 or display: none would sail through a screenshot review and
// fail here immediately.
//
// Runs the page the app actually loads, in the Electron the app actually
// ships, off a file:// URL -- because that origin is also what the setting's
// persistence depends on. Nothing here touches the game or the reader.
//
//   app/node_modules/.bin/electron tools/web/test/test-seams.js
//
// It is not part of app/reader/test/run-all.js: that suite is plain `node`
// over the reader modules, and this one needs an Electron runtime and a
// window.

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

// Every element in the shell, keyed by a stable path, with its rect rounded
// to 0.01px -- subpixel noise from layout rounding is not a moved box.
const SNAPSHOT = `(() => {
  const out = {};
  const nodes = document.querySelectorAll('.shell, .shell *');
  nodes.forEach((n, i) => {
    const r = n.getBoundingClientRect();
    const key = i + ':' + n.tagName.toLowerCase() + (n.id ? '#' + n.id : '')
      + (typeof n.className === 'string' && n.className ? '.' + n.className.trim().replace(/\\s+/g, '.') : '');
    out[key] = [Math.round(r.x * 100) / 100, Math.round(r.y * 100) / 100,
                Math.round(r.width * 100) / 100, Math.round(r.height * 100) / 100];
  });
  return out;
})()`;

const SEAM_COLOURS = `(() => {
  const bg = (sel) => getComputedStyle(document.querySelector(sel)).backgroundColor;
  return {
    band: bg('.rule-band'),
    seamRule: bg('.rule-seam'),
    kpis: bg('.kpis'),
    body: bg('.body'),
    tiles: bg('.tiles'),
    surface: getComputedStyle(document.querySelector('.kpi')).backgroundColor,
    ground: getComputedStyle(document.querySelector('.shell')).backgroundColor,
    switchTrack: bg('.switch'),
  };
})()`;

function diffRects(a, b) {
  const moved = [];
  for (const key of Object.keys(a)) {
    const x = a[key], y = b[key];
    if (!y) { moved.push(`${key} disappeared`); continue; }
    if (x[0] !== y[0] || x[1] !== y[1] || x[2] !== y[2] || x[3] !== y[3]) {
      moved.push(`${key} ${JSON.stringify(x)} -> ${JSON.stringify(y)}`);
    }
  }
  for (const key of Object.keys(b)) if (!a[key]) moved.push(`${key} appeared`);
  return moved;
}

async function main() {
  const win = new BrowserWindow({
    width: 1280, height: 800, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  // Avoid the native Windows menu arriving after the first layout snapshot.
  win.setMenu(null);
  const js = (src) => win.webContents.executeJavaScript(src);

  await win.loadURL(pathToFileURL(INDEX).href);
  // A known starting point regardless of what a previous run stored.
  await js(`localStorage.removeItem('ravenswatch:panel-lines'); localStorage.removeItem('ravenswatch:diagnostics'); location.reload();`);
  await new Promise(r => win.webContents.once('did-finish-load', r));

  await js(`setView('live'); document.fonts.ready.then(() => true)`);

  console.log('\ntest-seams: the panel-lines toggle');

  check('lines are on by default',
    (await js(`document.body.classList.contains('seamless')`)) === false);

  const before = await js(SNAPSHOT);
  const litColours = await js(SEAM_COLOURS);
  check('every seam is painted the divider colour while lines are on',
    litColours.band === litColours.seamRule
    && litColours.kpis === litColours.band
    && litColours.body === litColours.band
    && litColours.tiles === litColours.band
    && litColours.band !== litColours.surface,
    litColours.band);

  // --- the toggle ---------------------------------------------------------
  await js(`document.getElementById('settings-open').click()`);
  check('the gear opens the panel',
    (await js(`!document.getElementById('settings').hidden`)) === true);
  check('and marks itself expanded for assistive tech',
    (await js(`document.getElementById('settings-open').getAttribute('aria-expanded')`)) === 'true');

  await js(`document.getElementById('panel-lines').click()`);
  check('the switch turns the lines off',
    (await js(`document.body.classList.contains('seamless')`)) === true);
  check('and reports its new state',
    (await js(`document.getElementById('panel-lines').getAttribute('aria-checked')`)) === 'false');

  // --- the claim ----------------------------------------------------------
  const after = await js(SNAPSHOT);
  const moved = diffRects(before, after);
  check('not one box in the shell moved or resized',
    moved.length === 0,
    moved.length ? `${moved.length} changed: ${moved.slice(0, 3).join(' | ')}` : `${Object.keys(before).length} elements identical`);

  const darkColours = await js(SEAM_COLOURS);
  check('gaps inside a box group now match the boxes',
    darkColours.kpis === darkColours.surface
    && darkColours.body === darkColours.surface
    && darkColours.tiles === darkColours.surface
    && darkColours.seamRule === darkColours.surface,
    darkColours.kpis);
  check('the head and foot rules now match the ground they sit against',
    darkColours.band === darkColours.ground, darkColours.band);
  check('no seam is left painted its old colour',
    darkColours.band !== litColours.band && darkColours.kpis !== litColours.kpis);
  check('the switch keeps its own edge when the seams go',
    darkColours.switchTrack === litColours.switchTrack, darkColours.switchTrack);

  // --- persistence --------------------------------------------------------
  check('the choice is written to storage',
    (await js(`localStorage.getItem('ravenswatch:panel-lines')`)) === 'off');

  await win.webContents.reload();
  await new Promise(r => win.webContents.once('did-finish-load', r));
  await js(`setView('live'); document.fonts.ready.then(() => true)`);
  check('and is applied again on the next load',
    (await js(`document.body.classList.contains('seamless')`)) === true);
  check('the switch comes back showing off, not its markup default',
    (await js(`document.getElementById('panel-lines').getAttribute('aria-checked')`)) === 'false');

  const reloaded = await js(SNAPSHOT);
  const movedOnReload = diffRects(before, reloaded);
  check('a page loaded seamless from the start has the same layout too',
    movedOnReload.length === 0,
    movedOnReload.length ? `${movedOnReload.length} changed: ${movedOnReload.slice(0, 3).join(' | ')}` : '');

  // --- diagnostics toggle --------------------------------------------------
  check('diagnostics are off by default',
    (await js(`document.body.classList.contains('no-diag')`)) === true
    && (await js(`document.getElementById('diag-bar').getAttribute('aria-checked')`)) === 'false');

  await js(`document.getElementById('diag-bar').click()`);
  check('clicking diagnostics switch turns diagnostics on',
    (await js(`document.body.classList.contains('no-diag')`)) === false
    && (await js(`document.getElementById('diag-bar').getAttribute('aria-checked')`)) === 'true'
    && (await js(`localStorage.getItem('ravenswatch:diagnostics')`)) === 'on');

  await js(`document.getElementById('diag-bar').click()`);
  check('clicking again turns diagnostics off',
    (await js(`document.body.classList.contains('no-diag')`)) === true
    && (await js(`document.getElementById('diag-bar').getAttribute('aria-checked')`)) === 'false'
    && (await js(`localStorage.getItem('ravenswatch:diagnostics')`)) === 'off');

  // --- closing ------------------------------------------------------------
  await js(`document.getElementById('settings-scrim').click()`);
  check('clicking outside closes the panel',
    (await js(`document.getElementById('settings').hidden`)) === true);

  await js(`document.getElementById('settings-open').click()`);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  check('Escape closes it and returns focus to the gear',
    (await js(`document.getElementById('settings').hidden
      && document.activeElement === document.getElementById('settings-open')`)) === true);

  // --- what the gear itself cost ------------------------------------------
  const shift = await js(`(() => {
    const pill = document.getElementById('head-right');
    const withGear = pill.getBoundingClientRect().x;
    const gear = document.getElementById('settings-open');
    gear.style.display = 'none';
    const without = pill.getBoundingClientRect().x;
    gear.style.display = '';
    return Math.round(without - withGear);
  })()`);
  console.log(`        note: the gear shifts the status pill ${shift}px left; nothing else in the header moves.`);

  // --- between-runs screen ------------------------------------------------
  console.log('\ntest-seams: between-runs whole-page state');
  const betweenRunsFrame = {
    level: 0,
    in_combat: 0,
    map_id: -1,
    map_name: null,
    map_sub: 'unresolved',
    chapter_icon: 'icon_question.png',
    quest_key: null,
    quest_name: 'Undetermined',
    quest_icon: 'icon_question.png',

    tracked: 26,
    found: 15,
    sweeps: 1,
    pid: 1234,
    base: 0x140000000,
    process: 'Ravenswatch.exe',
    binding_vtable: 0x12345,
    melodies: null,
    melody_status: 'pending',
    dream_shards: null,
    sandman: null,
    sandman_status: 'pending',
    no_run: true,
    ready: false,
  };

  await js(`render(${JSON.stringify(betweenRunsFrame)})`);

  check('between-runs state adds .between-runs-active class to body',
    (await js(`document.body.classList.contains('between-runs-active')`)) === true);
  check('between-runs element is visible with centered message',
    (await js(`(() => {
      const br = document.getElementById('between-runs');
      if (!br) return false;
      const cs = getComputedStyle(br);
      const msg = br.querySelector('.between-runs-message');
      return cs.display === 'flex' && msg && msg.textContent === 'Waiting for a run to start';
    })()`)) === true);
  check('KPIs, seam rule, and body are hidden during between-runs state',
    (await js(`(() => {
      const kpis = getComputedStyle(document.querySelector('.kpis')).display;
      const seam = getComputedStyle(document.querySelector('.rule-seam')).display;
      const body = getComputedStyle(document.querySelector('.body')).display;
      return kpis === 'none' && seam === 'none' && body === 'none';
    })()`)) === true);
  check('connection dot stays connected during between-runs',
    (await js(`(() => {
      const pill = document.querySelector('#head-right .status');
      return pill && pill.classList.contains('status-live') && pill.textContent.trim() === '' && pill.dataset.tipName === 'Connected to Ravenswatch';
    })()`)) === true);
  check('connection indicator is compact and accessible', await js(`(() => { const n=document.querySelector('#head-right .status'); return n.getBoundingClientRect().width <= 28 && n.tabIndex === 0 && n.getAttribute('aria-label') === 'Connected to Ravenswatch'; })()`));
  await js(`document.querySelector('#head-right .status').dispatchEvent(new FocusEvent('focusin', {bubbles:true}))`);
  check('connection details appear on focus', await js(`!document.getElementById('tip').hidden && document.getElementById('tip-name').textContent === 'Connected to Ravenswatch'`));
  check('footer diagnostics remain active during between-runs',
    (await js(`document.getElementById('diag').textContent.includes('Ravenswatch.exe')`)) === true);

  await js(`markStale()`);
  check('stale connection changes its hover details', await js(`document.querySelector('#head-right .status').dataset.connection === 'stale' && document.querySelector('#head-right .status').dataset.tipName.includes('not responding')`));
  // Transition back to a live run
  const liveRunFrame = {
    level: 3,
    in_combat: 1,
    map_id: 0,
    map_name: 'Dark Hills',
    map_sub: 'Chapter 1',
    chapter_icon: 'icon_chapter_1.png',
    quest_key: 'pigs',
    quest_name: 'The Three Little Pigs',
    quest_icon: 'house_wood.png',

    tracked: 26,
    found: 18,
    sweeps: 2,
    pid: 1234,
    base: 0x140000000,
    process: 'Ravenswatch.exe',
    binding_vtable: 0x12345,
    melodies: [
      { name: 'Galahad', state: 'active', notes: 3, effect: '', icon: 'UI_Melody_Icon_Galahad.png' },
      { name: 'Goose', state: 'completed', notes: 2, effect: '', icon: 'UI_Melody_Icon_Goose.png' },
      { name: 'Locked', state: 'locked', notes: 0, effect: '', icon: 'UI_Melody_Icon_Locked.png' },
    ],
    melody_status: 'ok',
    dream_shards: 180,
    sandman: null,
    sandman_status: 'pending',
    tiles: [
      { icon: 'map_altar.png', outline: null, tier: null, count: 1, label: 'Altar of Heroes' },
      { icon: 'map_chest.png', outline: 'map_chest_outline.png', tier: 2, count: 3, label: 'Chest' },
      { icon: 'map_baba_yaga_eye.png', outline: 'map_baba_yaga_eye_outline.png', tier: null, count: 2, label: 'Vision Tower' },
    ],
    no_run: false,
    ready: true,
  };

  await js(`render(${JSON.stringify(liveRunFrame)})`);

  check('live run state removes .between-runs-active class from body',
    (await js(`document.body.classList.contains('between-runs-active')`)) === false);
  check('between-runs container is hidden during live run',
    (await js(`getComputedStyle(document.getElementById('between-runs')).display`)) === 'none');
  check('KPIs and body are visible again',
    (await js(`(() => {
      const kpis = getComputedStyle(document.querySelector('.kpis')).display;
      const body = getComputedStyle(document.querySelector('.body')).display;
      return kpis !== 'none' && body !== 'none';
    })()`)) === true);
  check('the questline cell is rendered on live run start',
    (await js(`document.getElementById('quest-name').textContent`)) === 'The Three Little Pigs');

  // Hero level and the map name are no longer cells. Asserted as absence
  // rather than left untested: a stale build still shipping them would
  // otherwise pass this suite unchanged.
  check('hero level and current map are no longer KPI cells',
    (await js(`!document.getElementById('hero-level') && !document.getElementById('map-name')`)) === true);

  // --- the band ------------------------------------------------------------
  // Four cells in one row: the questline and the three melodies. Two rows of
  // three would not fit the band, which is why the melody strip lost its
  // note count, effect line and icon on the way up here.
  console.log('\ntest-seams: the KPI band');

  check('the band is one row of four',
    (await js(`(() => {
      const cells = [...document.querySelectorAll('.kpis > .kpi, .kpis #melody-cards > .kpi')];
      if (cells.length !== 4) return 'count ' + cells.length;
      const tops = new Set(cells.map(c => Math.round(c.getBoundingClientRect().top)));
      return tops.size === 1 ? true : 'rows ' + tops.size;
    })()`)) === true);

  check('the only kicker left in the band is the questline',
    (await js(`[...document.querySelectorAll('.kpis .kicker')].map(k => k.textContent).join('|')`)) === 'Questline');

  check('a melody card carries its name, state and icon',
    (await js(`(() => {
      const card = document.querySelector('#melody-cards .kpi');
      const art = card.querySelector('.melody-icon');
      return card.querySelector('.melody-name').textContent === 'Galahad'
        && card.querySelector('.melody-state').textContent === 'active'
        && /UI_Melody_Icon_Galahad\.png/.test(art.style.backgroundImage)
        && !card.querySelector('.melody-sub');
    })()`)) === true);

  // A locked slot draws the padlock, not its own art -- the same texture the
  // game uses, and the reason that file ships.
  check('a locked slot draws the padlock art instead',
    (await js(`(() => {
      const art = document.querySelectorAll('#melody-cards .melody-icon')[2];
      return /UI_Melody_Icon_Locked\.png/.test(art.style.backgroundImage)
        && art.classList.contains('dim');
    })()`)) === true);

  // --- placed tiles --------------------------------------------------------
  // The panel took the body column the melodies vacated.
  console.log('\ntest-seams: the placed tiles panel');

  check('every cell is an icon, and no words',
    (await js(`(() => {
      const list = document.getElementById('tiles-list');
      if (list.querySelectorAll('.tile-cell').length !== 3) return 'cells';
      // Everything visible in the panel is a picture or a count. Any other
      // text means a label leaked back in.
      const words = list.textContent.replace(/[\\u00d7\\d\\s]/g, '');
      return words === '' ? true : 'text in the panel: ' + words;
    })()`)) === true);

  check('each cell draws the icon the frame named',
    (await js(`[...document.querySelectorAll('#tiles-list .tile-art')]
      .map(n => (n.style.backgroundImage.match(/map_[a-z_]+\\.png/) || ['?'])[0]).join('|')`))
    === 'map_altar.png|map_chest.png|map_baba_yaga_eye.png');

  // A count of one would sit on almost every icon and bury the few that are
  // really doubled.
  check('only a count above one is drawn',
    (await js(`[...document.querySelectorAll('#tiles-list .tile-count')].map(n => n.textContent).join('|')`))
    === '|×3|×2');

  // The tier ring. The game encodes tier by colouring the icon's outline
  // green/yellow/red, and the shipped outline is one white silhouette, so the
  // colour comes from the page: mask the silhouette, fill with the tier.
  check('a tiered cell masks its ring and takes the tier colour',
    (await js(`(() => {
      const cell = document.querySelectorAll('#tiles-list .tile-cell')[1];
      const ring = cell.querySelector('.tile-ring');
      const cs = getComputedStyle(ring);
      const mask = cs.maskImage || cs.webkitMaskImage || '';
      if (!/map_chest_outline\\.png/.test(mask)) return 'mask: ' + mask;
      if (!cell.classList.contains('tile-tier-2')) return 'class: ' + cell.className;
      if (ring.hidden) return 'ring hidden';
      // Painted, and not the page ground -- the whole point is that it reads
      // as a colour.
      const bg = cs.backgroundColor;
      return /rgba?\\((?!0, 0, 0, 0)/.test(bg) ? true : 'ring colour: ' + bg;
    })()`)) === true);

  // Having an outline and having a tier are different questions. The stash,
  // the mirror, crystals and the Baba Yaga eye all ship an outline and carry
  // no tier in their name -- their ring must still be painted. It was not:
  // the colour fell back to `transparent` and the ring drew invisibly.
  check('an outlined cell with no tier still paints its ring',
    (await js(`(() => {
      const cell = document.querySelectorAll('#tiles-list .tile-cell')[2];
      const ring = cell.querySelector('.tile-ring');
      if (ring.hidden) return 'ring hidden';
      if (/tile-tier-/.test(cell.className)) return 'unexpected tier class';
      const cs = getComputedStyle(ring);
      const mask = cs.maskImage || cs.webkitMaskImage || '';
      if (!/map_baba_yaga_eye_outline\\.png/.test(mask)) return 'mask: ' + mask;
      const bg = cs.backgroundColor;
      return /rgba?\\((?!0, 0, 0, 0)/.test(bg) ? true : 'ring is invisible: ' + bg;
    })()`)) === true);

  // Things the game gives no ring must not get one invented for them.
  check('an untiered cell draws no ring at all',
    (await js(`(() => {
      const cell = document.querySelectorAll('#tiles-list .tile-cell')[0];
      return cell.querySelector('.tile-ring').hidden === true
        && !/tile-tier-/.test(cell.className);
    })()`)) === true);

  // The three tiers must be three different colours, or the ring says nothing.
  check('the three tiers are three distinct colours',
    (await js(`(() => {
      const probe = document.createElement('div');
      document.querySelector('.shell').append(probe);
      const seen = [1, 2, 3].map(t => {
        probe.className = 'tile-cell tile-tier-' + t;
        probe.innerHTML = '<div class="tile-ring"></div>';
        return getComputedStyle(probe.firstElementChild).backgroundColor;
      });
      probe.remove();
      return new Set(seen).size === 3 ? true : seen.join(' ');
    })()`)) === true);

  // The label is never painted, but a bare picture still has to say what it
  // is to a screen reader. Hover is the shared tooltip's job (test-hover.js),
  // so there must be no title for the native one to draw.
  check('the label survives as an aria-label rather than as text',
    (await js(`[...document.querySelectorAll('#tiles-list .tile-cell')]
      .map(n => n.getAttribute('aria-label') + (n.title ? '!' : '')).join('|')`))
    === 'Altar of Heroes|Chest Tier 2 ×3|Vision Tower ×2');

  // null and [] are different answers: not read yet, versus read and empty.
  await js(`render(${JSON.stringify({ ...liveRunFrame, tiles: null })})`);
  check('an unread roster says it is loading',
    (await js(`document.querySelector('#tiles-list .kicker').textContent`)) === 'Loading…');
  await js(`render(${JSON.stringify({ ...liveRunFrame, tiles: [] })})`);
  check('a map with nothing worth marking says so instead',
    (await js(`document.querySelector('#tiles-list .kicker').textContent`)) === 'Nothing placed');

  // A busy map. The grid wraps and, if it overruns, scrolls inside its own
  // column -- the shell is overflow:hidden, so getting this wrong does not
  // look like an error, the last icons are simply not there.
  const bigGrid = Array.from({ length: 24 }, (_, i) => ({
    icon: 'map_chest.png', outline: 'map_chest_outline.png',
    tier: (i % 3) + 1, count: 1, label: 'Chest',
  }));
  await js(`render(${JSON.stringify({ ...liveRunFrame, tiles: bigGrid })})`);
  check('a busy map stays inside the column',
    (await js(`(() => {
      const list = document.getElementById('tiles-list');
      const shell = document.querySelector('.shell').getBoundingClientRect();
      if (list.querySelectorAll('.tile-cell').length !== 24) return 'cells';
      const r = list.getBoundingClientRect();
      if (r.bottom > shell.bottom + 1) return 'overflows shell by ' + Math.round(r.bottom - shell.bottom);
      return list.scrollHeight <= list.clientHeight || list.scrollHeight > 0;
    })()`)) === true);

  // Coming back from a placeholder to the grid the panel had before. The grid
  // is only rebuilt when its set of icons changes, and a placeholder that kept
  // the old shape key threw here rather than rebuilding.
  await js(`render(${JSON.stringify(liveRunFrame)})`);
  check('the grid comes back after a placeholder',
    (await js(`document.querySelectorAll('#tiles-list .tile-cell').length`)) === 3);

  // --- combat edge ---------------------------------------------------------
  // The edge replaced the combat KPI. It reports one event -- aggro dropping
  // -- by going away, so every state that cannot vouch for the combat flag
  // has to clear it rather than leave a pulse running.
  console.log('\ntest-seams: combat edge');

  await js(`render(${JSON.stringify(liveRunFrame)})`);
  check('in combat on a live run puts .in-combat on body',
    (await js(`document.body.classList.contains('in-combat')`)) === true);
  check('the edge overlay takes no layout space',
    (await js(`(() => {
      const e = getComputedStyle(document.getElementById('combat-edge'));
      return e.position === 'fixed' && e.pointerEvents === 'none';
    })()`)) === true);

  await js(`render(${JSON.stringify({ ...liveRunFrame, in_combat: 0 })})`);
  check('leaving combat clears .in-combat',
    (await js(`document.body.classList.contains('in-combat')`)) === false);

  await js(`render(${JSON.stringify({ ...liveRunFrame, in_combat: null })})`);
  check('an unresolved combat flag does not light the edge',
    (await js(`document.body.classList.contains('in-combat')`)) === false);

  await js(`render(${JSON.stringify({ ...liveRunFrame, ready: false })})`);
  check('the edge stays dark behind the loading curtain',
    (await js(`document.body.classList.contains('in-combat')`)) === false);

  await js(`render(${JSON.stringify({ ...liveRunFrame, no_run: true })})`);
  check('the edge stays dark between runs',
    (await js(`document.body.classList.contains('in-combat')`)) === false);

  // A frame we cannot hear cannot report the drop, so the pulse must not
  // outlive the connection -- this is the one place the renderer does not
  // keep the last good frame.
  await js(`render(${JSON.stringify(liveRunFrame)})`);
  await js(`markStale()`);
  check('losing the sidecar clears the edge rather than leaving it pulsing',
    (await js(`document.body.classList.contains('in-combat')`)) === false);

  // --- sidecar-down and no-transport full-screen curtain -------------------
  console.log('\ntest-seams: sidecar-down and no-transport full-screen curtain');

  // Step 1: a live frame whose melody channel has not answered. The cards
  // stay in the band and say they are loading -- the band is a fixed four
  // columns, so three cells cannot simply be absent while it waits.
  await js(`render(${JSON.stringify({ ...liveRunFrame, melodies: null })})`);
  check('live frame with melodies: null puts the cards in waiting mode',
    (await js(`document.getElementById('melody-cards').dataset.mode`)) === 'waiting');
  check('the band still holds three melody cards while waiting',
    (await js(`document.querySelectorAll('#melody-cards .melody-card-waiting').length`)) === 3);

  // Step 2: Sidecar goes down -> renderSidecarDown shows full-screen curtain
  await js(`renderSidecarDown("Ravenswatch.exe has exited", 5000, 1)`);
  check('renderSidecarDown shows the curtain',
    (await js(`(() => {
      const c = document.querySelector('.curtain') || document.getElementById('between-runs');
      return c && getComputedStyle(c).display === 'flex';
    })()`)) === true);
  check('renderSidecarDown cleans exit message into curtain headline',
    (await js(`(() => {
      const c = document.querySelector('.curtain') || document.getElementById('between-runs');
      const h = c && c.querySelector('.curtain-headline, .between-runs-message');
      return h && h.textContent;
    })()`)) === 'Ravenswatch has closed — waiting for the game to restart');

  await js(`renderSidecarDown("Ravenswatch.exe is not running -- start the game first, or pass a PID explicitly", 5000, 1)`);
  check('renderSidecarDown cleans PID and exe jargon from not-running message into headline',
    (await js(`(() => {
      const c = document.querySelector('.curtain') || document.getElementById('between-runs');
      const h = c && c.querySelector('.curtain-headline, .between-runs-message');
      return h && h.textContent;
    })()`)) === 'Ravenswatch is not running — start the game to connect');
  check('renderSidecarDown curtain has no second line',
    (await js(`(() => {
      const c = document.querySelector('.curtain') || document.getElementById('between-runs');
      const sub = c && c.querySelector('.curtain-sub');
      return sub && sub.hidden;
    })()`)) === true);

  // Step 3: Recovery to live frame hides the curtain
  await js(`render(${JSON.stringify(liveRunFrame)})`);
  check('recovery to live frame hides the curtain',
    (await js(`(() => {
      const c = document.querySelector('.curtain') || document.getElementById('between-runs');
      return c && getComputedStyle(c).display === 'none';
    })()`)) === true);
  check('recovery to live frame repaints the melody cards',
    (await js(`[...document.querySelectorAll('#melody-cards .melody-name')].map(n => n.textContent).join('|')`))
    === 'Galahad|Goose|Locked');

  // Step 4: renderNoTransport sets dataset.transport and shows the curtain
  await js(`renderNoTransport()`);
  check('renderNoTransport sets document.body.dataset.transport to none',
    (await js(`document.body.dataset.transport`)) === 'none');
  check('renderNoTransport shows the curtain',
    (await js(`(() => {
      const c = document.querySelector('.curtain') || document.getElementById('between-runs');
      return c && getComputedStyle(c).display === 'flex';
    })()`)) === true);
  check('renderNoTransport headline and second line use clean player copy',
    (await js(`(() => {
      const c = document.querySelector('.curtain') || document.getElementById('between-runs');
      const h = c && c.querySelector('.curtain-headline, .between-runs-message');
      const sub = c && c.querySelector('.curtain-sub');
      return h && h.textContent === "The overlay can't start"
        && sub && sub.textContent === "Restart the app. If this keeps happening, reinstall it.";
    })()`)) === true);

  await js(`render(${JSON.stringify(liveRunFrame)})`);
  check('recovery from no-transport repaints the melody cards',
    (await js(`[...document.querySelectorAll('#melody-cards .melody-name')].map(n => n.textContent).join('|')`))
    === 'Galahad|Goose|Locked');

  // --- the readiness gate ---------------------------------------------------
  console.log('\ntest-seams: panels are held until every channel has answered');

  const melodyTestItems = [
    {
      slot: 0,
      internal_name: 'Increase_Move_Speed_At_Day',
      name: 'Tortoise',
      icon: 'UI_Melody_Icon_Turtle.png',
      notes: 4,
      state: 'locked',
      effect: 'Move speed bonus during day',
    },
    {
      slot: 1,
      internal_name: 'Instant_Level_Up',
      name: 'Fairy Godmother',
      icon: 'UI_Melody_Icon_Godfairy.png',
      notes: 4,
      state: 'active',
      effect: 'Instant level up on collection',
    },
    {
      slot: 2,
      internal_name: 'Power_Up_Level_Max',
      name: 'Little Tailor',
      icon: 'UI_Melody_Icon_Tailor.png',
      notes: 5,
      state: 'completed',
      effect: 'Consumables at level thresholds',
    },
  ];

  const liveMelodyFrame = {
    ...liveRunFrame,
    map_id: 0,
    melodies: melodyTestItems,
  };

  const gatedFrame = { ...liveRunFrame, ready: false, melodies: null,
    melody_status: 'pending' };

  await js(`render(${JSON.stringify(gatedFrame)})`);

  check('a frame that is not ready holds the page behind the overlay',
    (await js(`document.body.classList.contains('between-runs-active')`)) === true);
  check('and names the map it is loading, not a generic message',
    (await js(`document.querySelector('#between-runs .between-runs-message').textContent`))
      === 'Loading Dark Hills');

  const gatedNoMapFrame = { ...liveRunFrame, ready: false, map_name: null,
    melodies: null, melody_status: 'pending' };
  await js(`render(${JSON.stringify(gatedNoMapFrame)})`);
  check('falls back to the generic message when the map is not resolved yet',
    (await js(`document.querySelector('#between-runs .between-runs-message').textContent`))
      === 'Loading run');

  await js(`render(${JSON.stringify(gatedFrame)})`);
  check('the tiles panel is painted underneath while the gate is shut, so the '
    + 'reveal is a class removal and nothing pops in',
    (await js(`document.querySelectorAll('#tiles-list .tile-cell').length`)) === 3);
  check('the quest panel is painted underneath too',
    (await js(`document.getElementById('quest-name').textContent`))
      === 'The Three Little Pigs');

  await js(`render(${JSON.stringify({ ...liveRunFrame, melodies: melodyTestItems })})`);
  check('a ready frame opens the gate',
    (await js(`document.body.classList.contains('between-runs-active')`)) === false);

  await js(`render(${JSON.stringify(betweenRunsFrame)})`);
  check('between runs still says it is waiting for a run to start',
    (await js(`document.querySelector('#between-runs .between-runs-message').textContent`))
      === 'Waiting for a run to start');

  // The renderer no longer holds melodies -- the sweeper does, and the frame
  // arrives already held. A null payload here is a null payload, full stop.
  await js(`render(${JSON.stringify({ ...liveRunFrame, melodies: melodyTestItems })})`);
  await js(`render(${JSON.stringify({ ...liveRunFrame, melodies: null, melody_status: 'failed' })})`);
  check('a null melody payload on a ready frame draws the placeholder, because '
    + 'the hold lives in the reader now',
    (await js(`document.getElementById('melody-cards').dataset.mode`)) === 'waiting');

  // --- the sandman panel ---------------------------------------------------
  //
  // The panel has three states and no fourth. Closing the shop clears every
  // cell's pointer to its item (measured live 2026-09-03), so "shop closed" is
  // unreadable rather than empty -- the reader holds the last read and the page
  // paints it either way. There is no closed state to draw.
  console.log('\ntest-seams: the sandman panel');

  const DASH = '—';
  // Names and resource paths are supplied as a test IPC payload.
  {
    const { SHOP_ICONS } = require('../../reader/test/fixtures/item-tables');
    await js(`applyAssets(${JSON.stringify({ SHOP_ICONS })})`);
  }

  const shopFrame = { ...liveRunFrame, melodies: melodyTestItems };
  const rowClasses = `Array.from(document.querySelectorAll('#shop-list .shop-row')).map(r => r.className)`;

  await js(`render(${JSON.stringify({ ...shopFrame, sandman: null, sandman_status: 'pending' })})`);
  check('before any shop has been opened the panel asks for one',
    (await js(`document.getElementById('shop-list').dataset.mode`)) === 'pending'
    && (await js(`document.querySelector('#shop-list .kicker').textContent`))
      === 'Open the Sandman shop to load offers');
  check('and the balance paints anyway, because shards are a plain value that '
    + 'does not need the shop',
    (await js(`document.getElementById('shop-balance').textContent`)) === '180');

  // 180 shards against prices under, exactly at, over, and unresolved.
  const offers = [
    { name: 'Dream of Power', price: 60 },
    { name: 'Sand of Knowledge', price: 180 },
    { name: 'Grandiose Shaping', price: 400 },
    { name: 'Bag Of Marbles', price: null },
  ];
  await js(`render(${JSON.stringify({ ...shopFrame, sandman: offers, sandman_status: 'ok' })})`);

  check('offers replace the placeholder with one row each',
    (await js(`document.getElementById('shop-list').dataset.mode`)) === 'offers'
    && (await js(`document.getElementById('shop-list').childElementCount`)) === 4);
  check('affordability splits on the balance and is inclusive at exactly the price',
    (await js(rowClasses)).join(' | ')
      === 'shop-row shop-row-afford | shop-row shop-row-afford '
        + '| shop-row shop-row-short | shop-row shop-row-unknown',
    (await js(rowClasses)).join(' | '));
  check('an unpriced offer draws no comparison either way',
    (await js(`document.querySelectorAll('#shop-list .shop-price-value')[3].textContent`))
      === DASH);
  check('each item wears its own art, including one whose texture is named '
    + 'without the display name\'s "of"',
    (await js(`document.querySelectorAll('#shop-list .shop-icon')[0].style.backgroundImage`))
      .includes('item_dream_of_power.png')
    && (await js(`document.querySelectorAll('#shop-list .shop-icon')[1].style.backgroundImage`))
      .includes('item_sand_knowledge.png'));
  check('a name with no texture at all falls back to the question mark',
    (await js(`document.querySelectorAll('#shop-list .shop-icon')[3].style.backgroundImage`))
      .includes('icon_question.png'));
  check('a possessive in the display name still finds its texture',
    (await js(`shopIconFor("Mermaid's Tears")`)) === 'item_mermaid_tears.png'
    && (await js(`shopIconFor('Ring of Dispel')`)) === 'item_ring_of_dispel.png');
  check('the one texture the game misspelled is reachable by the correct name',
    (await js(`shopIconFor('Dream of Invulnerability')`))
      === 'item_dream_of_invulneraiblity.png');
  check('sand of enlightenment resolves to enlightenment texture',
    (await js(`shopIconFor('Sand of Enlightenment')`)) === 'item_enlightenment.png');
  check('card suit and chapter display names resolve to their textures',
    (await js(`shopIconFor('Ace of Spades Card')`)) === 'item_ace_card.png'
    && (await js(`shopIconFor('Chapter on Anatomy')`)) === 'item_anatomy.png');

  await js(`render(${JSON.stringify({ ...shopFrame, sandman: null, sandman_status: 'unresolved' })})`);
  check('a shop that is open but will not read names the fault instead of '
    + 'showing an empty shelf',
    (await js(`document.getElementById('shop-list').dataset.mode`)) === 'unresolved'
    && (await js(`document.querySelector('#shop-list .kicker').textContent`))
      === 'Shop could not be read');
  check('and marks it a fault rather than a wait',
    (await js(`document.querySelector('#shop-list .shop-waiting-mark').classList.contains('fault')`)) === true
    && (await js(`(() => {
      const b = document.getElementById('shop-badge');
      return !b.hidden && b.textContent;
    })()`)) === 'Unavailable');

  // A placeholder that leaves its badge behind would brand a working shop as
  // broken for the rest of the run.
  await js(`render(${JSON.stringify({ ...shopFrame, sandman: offers, sandman_status: 'ok' })})`);
  check('offers coming back clear the fault badge',
    (await js(`document.getElementById('shop-badge').hidden`)) === true
    && (await js(rowClasses)).length === 4);

  // Purchased offer renders as SOLD with hidden shard icon and shop-row-sold class
  const offersWithSold = [
    { name: 'Star Fragment', price: 50, purchased: true },
    { name: 'Gingerbread Man', price: 50, purchased: false },
  ];
  await js(`render(${JSON.stringify({ ...shopFrame, sandman: offersWithSold, sandman_status: 'ok', dream_shards: 100 })})`);
  check('purchased item renders as shop-row-sold with SOLD text and hidden shards',
    (await js(`document.querySelector('#shop-list .shop-row').className`)) === 'shop-row shop-row-sold'
    && (await js(`document.querySelector('#shop-list .shop-price-value').textContent`)) === 'SOLD'
    && (await js(`document.querySelector('#shop-list .shards').hidden`)) === true);

  // The reader clears the hold at run end, so the next run's first frame is
  // what has to wipe the previous run's stock. A no_run frame does not: render()
  // returns before the panels, deliberately, and the overlay covers them.
  await js(`render(${JSON.stringify(betweenRunsFrame)})`);
  await js(`render(${JSON.stringify({ ...shopFrame, sandman: null, sandman_status: 'pending', dream_shards: null })})`);
  check('the next run starts the panel over rather than showing the last run\'s stock',
    (await js(`document.getElementById('shop-list').dataset.mode`)) === 'pending'
    && (await js(`document.getElementById('shop-balance').textContent`)) === DASH);

  return failures;
}

app.whenReady().then(main).then((f) => {
  console.log(`\n${f === 0 ? 'ALL CHECKS PASSED' : f + ' FAILURE(S)'}`);
  app.exit(f ? 1 : 0);
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
