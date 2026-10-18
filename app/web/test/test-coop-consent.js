'use strict';
// Co-op consent gate test in Electron runtime.
//
// Verifies:
// 1. Dialog present when coop is true and consent is null, curtain reads "You're in a co-op run".
// 2. Clicking scrim or pressing Escape does not dismiss the dialog.
// 3. Clicking "Not this time" (decline) hides dialog and curtain reads "Hidden for this run".
// 4. A coop: false frame resets a DECLINED consent to null; an agreement lasts for the page.
// 5. Clicking "I agree" reveals the live readout when ready: true.

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

async function main() {
  const win = new BrowserWindow({
    width: 1280, height: 800, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const js = (src) => win.webContents.executeJavaScript(src);

  await win.loadURL(pathToFileURL(INDEX).href);

  console.log('\ntest-coop-consent: co-op consent gate');

  const baseFrame = {
    level: 3,
    in_combat: 0,
    map_id: 0,
    map_name: 'Dark Hills',
    map_sub: 'Chapter 1',
    chapter_icon: 'icon_chapter_1.png',
    quest_key: 'pigs',
    quest_name: 'The Three Little Pigs',
    quest_icon: 'house_wood.png',

    tracked: 27,
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
    ],
    no_run: false,
    ready: true,
  };

  // --- 1. Dialog present when coop is true and consent is null ---
  await js(`render(${JSON.stringify({ ...baseFrame, coop: true })})`);

  check('dialog is present and visible when coop is true and consent is null',
    (await js(`(() => {
      const d = document.getElementById('coop-dialog');
      return d && !d.hidden && getComputedStyle(d).display !== 'none';
    })()`)) === true);

  check('scrim is active and visible',
    (await js(`(() => {
      const s = document.getElementById('coop-scrim');
      return s && !s.hidden && getComputedStyle(s).display !== 'none';
    })()`)) === true);

  check('curtain is active',
    (await js(`document.body.classList.contains('curtain-active') && document.body.classList.contains('between-runs-active')`)) === true);

  check('curtain reads "You\'re in a co-op run"',
    (await js(`(() => {
      const msg = document.querySelector('.curtain-headline, .between-runs-message');
      return msg && msg.textContent === "You're in a co-op run";
    })()`)) === true);

  check('dialog copy matches exact spec text',
    (await js(`(() => {
      const d = document.getElementById('coop-dialog');
      if (!d) return false;
      const text = d.textContent;
      return text.includes("You're in a co-op run")
        && text.includes("This tool shows things the other players can't see. If I use it to spoil, grief, or otherwise ruin someone's game, I'm an asshole and deserve to be shamed.")
        && text.includes("I'll only use it for myself, and I'll turn it off if my group doesn't want it.")
        && document.getElementById('coop-agree').textContent.trim() === "I agree"
        && document.getElementById('coop-decline').textContent.trim() === "Not this time";
    })()`)) === true);

  check('panels still paint behind curtain while dialog is open',
    (await js(`document.getElementById('quest-name').textContent`)) === 'The Three Little Pigs');

  // --- 2. Clicking scrim or pressing Escape does nothing ---
  await js(`document.getElementById('coop-scrim').click()`);
  check('clicking scrim does not dismiss the dialog',
    (await js(`!document.getElementById('coop-dialog').hidden`)) === true);

  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  check('pressing Escape does not dismiss the dialog',
    (await js(`!document.getElementById('coop-dialog').hidden`)) === true);

  // --- 3. Decline branch ("Not this time") ---
  await js(`document.getElementById('coop-decline').click()`);

  check('declining hides the dialog',
    (await js(`document.getElementById('coop-dialog').hidden`)) === true);

  check('declining hides the scrim',
    (await js(`document.getElementById('coop-scrim').hidden`)) === true);

  check('curtain remains active after decline',
    (await js(`document.body.classList.contains('curtain-active')`)) === true);

  check('curtain reads "Hidden for this run" after decline',
    (await js(`(() => {
      const msg = document.querySelector('.curtain-headline, .between-runs-message');
      return msg && msg.textContent === "Hidden for this run";
    })()`)) === true);

  // Subsequent co-op frames keep the curtain up with "Hidden for this run"
  await js(`render(${JSON.stringify({ ...baseFrame, coop: true })})`);
  check('subsequent coop frame stays hidden for this run without re-opening dialog',
    (await js(`(() => {
      const d = document.getElementById('coop-dialog');
      const msg = document.querySelector('.curtain-headline, .between-runs-message');
      return d.hidden && msg && msg.textContent === "Hidden for this run";
    })()`)) === true);

  // --- 4. A declined consent resets to null after a coop: false frame ---
  await js(`render(${JSON.stringify({ ...baseFrame, coop: false })})`);
  check('coop: false frame drops curtain when ready: true (solo run)',
    (await js(`!document.body.classList.contains('curtain-active')`)) === true);
  check('dialog remains hidden during solo run',
    (await js(`document.getElementById('coop-dialog').hidden`)) === true);

  // Next co-op frame raises the dialog again because consent reset to null
  await js(`render(${JSON.stringify({ ...baseFrame, coop: true })})`);
  check('new co-op frame after coop: false presents dialog again (consent was reset)',
    (await js(`(() => {
      const d = document.getElementById('coop-dialog');
      const msg = document.querySelector('.curtain-headline, .between-runs-message');
      return !d.hidden && msg && msg.textContent === "You're in a co-op run";
    })()`)) === true);

  // --- 5. Readout visible after agree ---
  await js(`document.getElementById('coop-agree').click()`);

  check('agreeing hides the dialog',
    (await js(`document.getElementById('coop-dialog').hidden`)) === true);

  check('agreeing hides the scrim',
    (await js(`document.getElementById('coop-scrim').hidden`)) === true);

  check('readout is visible after agree',
    (await js(`!document.body.classList.contains('curtain-active')`)) === true);

  check('KPIs and body panels are displayed after agree',
    (await js(`(() => {
      const kpis = getComputedStyle(document.querySelector('.kpis')).display;
      const body = getComputedStyle(document.querySelector('.body')).display;
      return kpis !== 'none' && body !== 'none';
    })()`)) === true);

  // Subsequent frames with coop: true stay visible
  await js(`render(${JSON.stringify({ ...baseFrame, coop: true })})`);
  check('subsequent co-op frame after agreement remains visible without dialog',
    (await js(`!document.body.classList.contains('curtain-active') && document.getElementById('coop-dialog').hidden`)) === true);

  // --- 6. Transition to between-runs resets consent ---
  const betweenRunsFrame = {
    ...baseFrame,
    map_id: -1,
    no_run: true,
    ready: false,
    coop: false,
  };
  await js(`render(${JSON.stringify(betweenRunsFrame)})`);
  check('between-runs shows waiting message and hides dialog',
    (await js(`(() => {
      const d = document.getElementById('coop-dialog');
      const msg = document.querySelector('.curtain-headline, .between-runs-message');
      return d.hidden && msg && msg.textContent === "Waiting for a run to start";
    })()`)) === true);

  // Re-entering a co-op run after between-runs does NOT ask again: an
  // agreement lasts for the life of the page (once per app launch). Only a
  // decline resets across a run boundary, which step 4 covers.
  await js(`render(${JSON.stringify({ ...baseFrame, coop: true })})`);
  check('re-entering co-op run after agreeing shows the readout without asking',
    (await js(`(() => {
      const d = document.getElementById('coop-dialog');
      return d.hidden && !document.body.classList.contains('curtain-active');
    })()`)) === true);

  return failures;
}

app.whenReady().then(main).then((f) => {
  console.log(`\n${f === 0 ? 'ALL CHECKS PASSED' : f + ' FAILURE(S)'}`);
  app.exit(f ? 1 : 0);
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
