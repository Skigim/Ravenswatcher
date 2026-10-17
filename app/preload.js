// Preload script, running in the isolated context contextIsolation creates.
//
// Exposes five one-way (main -> renderer) subscriptions: state frames from
// the reader/stdio.js sidecar, a notice for when that sidecar process has
// exited, the item tables main.js decodes from the game install, the
// result of the launch update check, and the run history. Nothing else crosses the bridge -- not
// ipcRenderer itself, not a general-purpose send -- so the renderer can only
// ever listen, never talk back to the sidecar or the main process.
//
// Channel names are inlined below, NOT required from a shared ./channels.js
// module: BrowserWindow's webPreferences omits `sandbox`, and per current
// Electron docs (docs/latest/api/browser-window.md webPreferences.sandbox:
// "Default is `true` since Electron 20") that means this preload runs in
// the sandboxed preload realm. Per docs/latest/tutorial/sandbox.md, a
// sandboxed preload's `require` "can only import a subset of Electron and
// Node's built-in modules" (electron, events, timers, url -- not arbitrary
// local files), and "you will not be able to use CommonJS modules to
// separate your preload script into multiple files" without a bundler.
// `require('./channels')` throws in that realm and the whole script is
// abandoned before contextBridge.exposeInMainWorld ever runs -- verified
// against the shipped app/node_modules/electron/dist/electron.exe, whose
// sandboxed-preload `preloadRequire` resolves only from a fixed
// `loadableModules` map and throws `module not found` for anything else.
// KEEP THESE LITERALS IN SYNC WITH app/main.js's copy -- there is no
// shared module to fall out of sync silently against; grep both files for
// 'readout:' if you change any.
const STATE_CHANNEL = 'readout:state';
const SIDECAR_DOWN_CHANNEL = 'readout:sidecar-down';
const ASSETS_CHANNEL = 'readout:assets';
const UPDATE_CHANNEL = 'readout:update';
const HISTORY_CHANNEL = 'readout:history';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel) {
  return (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('ravenswatch', {
  // callback(frame) fires once per parsed JSON object the sidecar wrote to
  // stdout. Returns an unsubscribe function; app/web/app.js doesn't need
  // it today (one subscription for the page's lifetime) but a leak-free
  // teardown path costs nothing to provide.
  onState: subscribe(STATE_CHANNEL),

  // callback({message, retryDelayMs, attempt}) fires once each time the
  // sidecar process exits on its own. `message` is the reader's own stderr
  // text when it has one (e.g. the "not running" line), not a substitute.
  onSidecarDown: subscribe(SIDECAR_DOWN_CHANNEL),

  // callback({ITEM_TEXT, SHOP_ICONS, ITEM_NAMES}) fires with the cached
  // tables at startup when a cache exists, and after each rebuild.
  onAssets: subscribe(ASSETS_CHANNEL),

  // callback({current, ok, latest, url, reason}) fires with the result of
  // the one release check per launch, and again after each page reload;
  // `latest` and `url` are null when nothing is newer, `ok` is false when
  // the check itself failed, and `reason` says why (null otherwise).
  onUpdate: subscribe(UPDATE_CHANNEL),

  // callback({runs, skipped}) fires with the whole run history, oldest
  // first, on every page load and again after each finished run is saved.
  onHistory: subscribe(HISTORY_CHANNEL),
});
