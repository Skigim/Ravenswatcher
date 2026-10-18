// Electron shell for Ravenswatcher, the live run readout.
//
// This file is the Electron half only: the window, the single-instance lock,
// the quit/teardown paths, forwarding what the sidecar produces to the
// renderer over IPC, and the asset side: the asset:// scheme that serves the
// page's icons out of a user-profile cache, and the worker that fills that
// cache from the game install the sidecar reports (see assets/build.ts).
// Supervision of the reader process itself -- spawn, stdout line parsing,
// stderr tail, exit/close handling, retry backoff, tree-kill -- lives in
// ./sidecar.js, which knows nothing about Electron or about IPC channel
// names. See that file's header for the seam.
//
// The transport is stdio-over-IPC: sidecar.js spawns `reader/stdio.js` on
// Electron's own Node runtime -- one spawn shape in both layouts -- reads
// its stdout as newline-delimited JSON, and hands each parsed frame back
// here; this file forwards it with `webContents.send` on a single channel.
// The window loads app/web/index.html straight off disk; nothing binds a
// port and nothing is polled to decide when the page is ready to load. The
// sidecar's stderr is diagnostic text (the attach banner, tracebacks), never
// state: it's logged and never parsed as a frame.

const { app, BrowserWindow, shell, protocol, net, ipcMain } = require('electron');
const { isAllowedExternal } = require('./external-links');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { Worker } = require('worker_threads');
const { createSidecar } = require('./sidecar');
const { CACHE_DIR_NAME } = require('./assets/build');
const { checkForUpdate } = require('./update');
const { RunSharer } = require('./share');
const { HISTORY_FILE, loadHistory, appendRun, deleteRuns, deleteHistoryFile, HistoryDeletion } = require('./history');

// Windows groups taskbar buttons by AppUserModelID, and a pinned shortcut
// carries the ID of whatever created it. Electron derives a default ID from
// the running executable, which does not match the pin -- so a pinned icon
// and the running window show up as two separate taskbar buttons. The
// `appId` in package.json does not fix this: electron-builder writes that
// into the NSIS installer's shortcuts, and this app ships as a folder with
// no installer, so nothing ever applies it at runtime. Set it explicitly,
// before any window exists, and keep the string equal to package.json's
// `build.appId`. KEEP IN SYNC WITH app/package.json's appId.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.ravenswatcher.app');
}

// Per-user data (run history, decoded game assets, settings) lives in a
// folder named after the product. Electron would name it from package.json's
// "name", ravenswatch-live-readout, which earlier releases used: move that
// folder over once, then point userData at the new one. Before the
// single-instance lock, which lives in userData.
const USER_DATA = path.join(app.getPath('appData'), 'Ravenswatcher');
const OLD_USER_DATA = path.join(app.getPath('appData'), 'ravenswatch-live-readout');
if (!fs.existsSync(USER_DATA) && fs.existsSync(OLD_USER_DATA)) {
  try {
    fs.renameSync(OLD_USER_DATA, USER_DATA);
  } catch (err) {
    console.error('[main] old user data not moved:', err.message);
  }
}
app.setPath('userData', USER_DATA);

const REPO_ROOT = path.resolve(__dirname, '..');

// Two layouts, ONE path. web/ is a sibling of this file both from source and
// inside the asar, exactly as reader/ is for sidecar.js, so __dirname resolves
// it either way. A branch here would be one more place where
// dev-works/packaged-fails could hide.
//
// Resolve from app-relative anchors, never from the source tree, which does
// not exist beside a packaged build. The sidecar's own anchor
// (process.resourcesPath) is handed to createSidecar below for the same reason.
const PACKAGED = app.isPackaged;
const INDEX_HTML = path.join(__dirname, 'web', 'index.html');

// Icons and item text are decoded from the player's own install into
// <userData>/game-assets on the first frame after each sidecar start, and
// served to the page from there on asset://icons/. See assets/build.ts. The
// manifest is the same file that documents the repo's reference PNGs; only
// its first two columns are read. CACHE_DIR is assigned in whenReady:
// app.getPath needs a ready app, and nothing reads it earlier.
let CACHE_DIR = null;
const MANIFEST = path.join(__dirname, 'web', 'assets', 'SOURCES.tsv');
const BUILD_WORKER = path.join(__dirname, 'assets', 'build-worker.js');
const ICON_NAME = /^[A-Za-z0-9_.-]+\.png$/;

// Registered before ready, as the API requires. `standard` gives the URL a
// host and a path (asset://icons/NAME); the host is a fixed lowercase word
// so the case-preserving name sits in the path. `corsEnabled` is for the
// tile rings: a CSS mask-image is fetched in CORS mode, and Chromium refuses
// a cross-origin (file:// page, asset:// image) CORS fetch on a scheme not
// on its CORS list -- the ring silently draws nothing. <img> and
// background-image are no-cors fetches and load either way.
protocol.registerSchemesAsPrivileged([{
  scheme: 'asset',
  privileges: { standard: true, secure: true, corsEnabled: true },
}]);

function serveAsset(request) {
  const url = new URL(request.url);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (url.hostname !== 'icons' || !ICON_NAME.test(name)) return new Response('', { status: 404 });
  const file = path.join(CACHE_DIR, 'icons', name);
  if (!fs.existsSync(file)) return new Response('', { status: 404 });
  return net.fetch(pathToFileURL(file).href);
}

// Channel names, inlined rather than shared from a ./channels.js module --
// see the matching comment in preload.js for why: that file runs in
// Electron's sandboxed preload realm (webPreferences omits `sandbox`, which
// defaults to true since Electron 20 per current docs), where `require` of
// a local file throws and abandons the whole preload script before
// contextBridge.exposeInMainWorld runs. main.js itself has no such
// restriction, but the two need the exact same string, so it stays a
// literal here too rather than the preload importing from main or a shared
// module either way. ./sidecar.js deliberately does not carry these either:
// centralising them anywhere is what the preload would then be tempted to
// import from, and that is precisely the failure this comment exists for.
// KEEP IN SYNC WITH app/preload.js's copy.
const STATE_CHANNEL = 'readout:state';
const SIDECAR_DOWN_CHANNEL = 'readout:sidecar-down';
const ASSETS_CHANNEL = 'readout:assets';
const UPDATE_CHANNEL = 'readout:update';
const HISTORY_CHANNEL = 'readout:history';

let mainWindow = null;
let rendererReady = false;

// The launch check's result, kept rather than queued. Frames repaint a
// reloaded page within a second, but the check runs once, so a result sent
// through pendingSends would be gone after a reload (Ctrl+R stays bound by
// the default menu). Sent when the check lands and on every page load.
let updateInfo = null;

// SQLite run history, loaded at startup; each
// complete capture is committed under its ID as a run finishes.
// Sent whole on every page load and after each append: it is small, and a
// whole list cannot be applied out of order the way a delta could.
let HISTORY_PATH = null;
let history = { runs: [], skipped: 0 };

function sendHistory() {
  sendToRenderer(HISTORY_CHANNEL, history);
}

const historyDeletion = new HistoryDeletion(() => history, (scope, ids) => {
  if (HISTORY_PATH === null) throw new Error('History is unavailable.');
  try {
    if (scope === 'all') deleteHistoryFile(HISTORY_PATH, history);
    else deleteRuns(HISTORY_PATH, history, ids);
  } finally { sendHistory(); }
});
function historyRequest(event, action) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents
    || event.senderFrame !== mainWindow.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(INDEX_HTML).href) {
    return { ok: false, error: 'History request denied.' };
  }
  try { return { ok: true, ...action() }; }
  catch (error) { return { ok: false, error: error.message }; }
}
const runSharer = new RunSharer({findRun:id=>history.runs.find(run=>run.id===id),cacheDir:()=>CACHE_DIR});
ipcMain.handle('readout:share-run', async (event,input) => {
  const allowed = historyRequest(event,()=>({allowed:true}));
  if(!allowed.ok)return allowed;
  return runSharer.share(input);
});

ipcMain.handle('readout:history-delete-prepare', (event, input) => historyRequest(event, () => historyDeletion.prepare(input)));
ipcMain.handle('readout:history-delete-confirm', (event, input) => historyRequest(event, () => historyDeletion.confirm(input?.token, input?.typed)));
ipcMain.handle('readout:history-delete-cancel', (event, token) => historyRequest(event, () => { historyDeletion.cancel(token); return {}; }));

function recordRun(frame) {
  if (!frame.run_summary || HISTORY_PATH === null) return;
  try {
    if (appendRun(HISTORY_PATH, history, frame.run_summary)) sendHistory();
  } catch (err) {
    console.error('[main] run not saved to history:', err.message);
  }
}

function sendUpdate() {
  if (updateInfo && mainWindow && !mainWindow.isDestroyed() && rendererReady) {
    mainWindow.webContents.send(UPDATE_CHANNEL, updateInfo);
  }
}

// Frames that arrived before the renderer could receive them. The sidecar is
// started ahead of the window on purpose -- the reader's first sweep takes
// ~3.5s and there is no reason to spend that serially -- so the first frame
// or two land while there is either no window or no subscribed listener in
// it, and webContents.send() drops them silently.
//
// Latest-wins per channel, which is right because a frame is a full 25-key
// snapshot rather than a delta: replaying a stale one would paint a state
// the reader has already moved past, while replaying the newest is exactly
// what the page would have received. Re-setting a key deletes it first so
// Map iteration order stays chronological -- if a down-notice follows a
// frame, the flush must apply them in that order or the page ends up live
// when the sidecar is gone.
const pendingSends = new Map();

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed() && rendererReady) {
    mainWindow.webContents.send(channel, payload);
    return;
  }
  pendingSends.delete(channel);
  pendingSends.set(channel, payload);
}

function flushPendingSends() {
  if (!mainWindow || mainWindow.isDestroyed() || !rendererReady) return;
  for (const [channel, payload] of pendingSends) {
    mainWindow.webContents.send(channel, payload);
  }
  pendingSends.clear();
}

// One build per sidecar start: the reader restarts each time the game
// exits, so a game update is picked up on the game's next launch. The build
// is about a second of CPU (BC3 decoding and PNG deflate for 155 icons), so
// it runs on a worker thread rather than stalling this one.
let assetsBuilt = false;

function maybeBuildAssets(frame) {
  if (assetsBuilt || !frame.install_dir) return;
  assetsBuilt = true;
  const worker = new Worker(BUILD_WORKER, {
    workerData: { installDir: frame.install_dir, cacheDir: CACHE_DIR, manifestPath: MANIFEST },
  });
  worker.on('message', (msg) => {
    if (msg.error) {
      console.error('[main] icons and item text not decoded:', msg.error);
      return;
    }
    sendToRenderer(ASSETS_CHANNEL, msg.tables);
    console.log(`[main] icons and item text decoded from ${frame.install_dir}`);
  });
  worker.on('error', (err) => {
    console.error('[main] asset build worker failed:', err);
  });
}

function sendCachedTables() {
  const file = path.join(CACHE_DIR, 'tables.json');
  if (!fs.existsSync(file)) return;
  try {
    sendToRenderer(ASSETS_CHANNEL, JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    console.error('[main] cached item tables unreadable:', err.message);
  }
}

// The supervisor. It calls back with parsed frames and down-notices; this
// file decides they become IPC sends. Constructed at module load rather than
// on whenReady() so `sidecar.stop()` is always a valid call from every
// teardown handler below, including ones that can fire before the app is
// ready.
const sidecar = createSidecar({
  packaged: PACKAGED,
  resourcesPath: process.resourcesPath,
  repoRoot: REPO_ROOT,
  onFrame: (frame) => { recordRun(frame); sendToRenderer(STATE_CHANNEL, frame); maybeBuildAssets(frame); },
  onDown: (notice) => { assetsBuilt = false; sendToRenderer(SIDECAR_DOWN_CHANNEL, notice); },
});

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    // A single readout window with no documents and nothing editable: the
    // stock File/Edit/View/Window menu does nothing here. autoHideMenuBar
    // rather than Menu.setApplicationMenu(null), because the default menu is
    // the *only* thing that binds Ctrl+Shift+I to Toggle Developer Tools --
    // nothing in this app registers a globalShortcut or a before-input-event
    // handler for it. Nulling the menu would take DevTools with it; hiding
    // the bar keeps the accelerator (and leaves the menu one Alt press away)
    // while the window ships with no visible menu.
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    rendererReady = false;
  });

  // Every window.open / target=_blank is refused; the few hosts in
  // external-links.js go to the system browser instead. Without this a
  // target=_blank link opens a second Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternal(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // did-finish-load, not the loadURL() promise: the promise resolves when
  // the document is loaded, but the listener the frames are aimed at is
  // registered by app.js while it runs. Waiting for the load to finish is
  // what makes a flushed frame land on a subscribed page rather than
  // vanishing the same way the dropped ones did. Fires again on a reload,
  // which is why the flag is set here rather than once at startup.
  mainWindow.webContents.on('did-start-loading', () => {
    rendererReady = false;
  });
  mainWindow.webContents.on('did-finish-load', () => {
    rendererReady = true;
    flushPendingSends();
    sendUpdate();
    sendHistory();
  });

  // loadFile() resolves relative paths against the app root (app/), and
  // app/web/index.html may sit outside the cwd -- pathToFileURL().href sidesteps
  // that ambiguity with a plain, unambiguous file:// URL for loadURL().
  await mainWindow.loadURL(pathToFileURL(INDEX_HTML).href);
}

// Single-instance lock: called as early as possible, before anything else
// touches `app`. A second launch that loses the race quits immediately;
// the primary instance's 'second-instance' handler brings its window
// forward instead of a second window ever being created.
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    console.log('[main] second-instance: focusing existing window');
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    CACHE_DIR = path.join(app.getPath('userData'), CACHE_DIR_NAME);
    HISTORY_PATH = path.join(app.getPath('userData'), HISTORY_FILE);
    try {
      history = loadHistory(HISTORY_PATH);
    } catch (err) {
      console.error('[main] run history unreadable:', err.message);
    }
    protocol.handle('asset', serveAsset);
    sendCachedTables();
    sidecar.start();
    createWindow().catch((err) => {
      console.error('[main] failed to create window:', err);
    });
    // One check per launch. A failed check is one log line here and a blank
    // note on the page, never an error.
    checkForUpdate(net.fetch, app.getVersion()).then((info) => {
      if (!info.ok) console.log(`[main] update check failed: ${info.reason}`);
      updateInfo = info;
      sendUpdate();
    });
  });

  app.on('window-all-closed', () => {
    sidecar.stop();
    app.quit();
  });

  app.on('before-quit', () => {
    sidecar.stop();
  });

  // Belt-and-suspenders for exit paths that don't route through the normal
  // Electron quit sequence at all: app.exit() explicitly skips
  // before-quit/will-quit, so a crash in main-process code (an uncaught
  // exception) or a terminal Ctrl+C during `npm start` would otherwise have
  // no chance to kill the sidecar before the process itself disappears.
  // None of these four handlers can run at all against a hard external kill
  // (Task Manager "End Task", `taskkill /F`) -- no code inside a
  // TerminateProcess'd process gets a chance to execute, on any platform.
  // That case is covered instead by the stdin-pipe dead-man's switch set up
  // in sidecar.js's start(): the OS itself closes the pipe when this process
  // is torn down, with no JS involved. See the report for what was verified.
  process.on('uncaughtException', (err) => {
    console.error('[main] uncaught exception:', err);
    sidecar.stop();
    app.exit(1);
  });

  process.on('SIGINT', () => {
    sidecar.stop();
    app.exit(0);
  });

  process.on('SIGTERM', () => {
    sidecar.stop();
    app.exit(0);
  });
}
