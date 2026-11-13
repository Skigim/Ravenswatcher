// Preload script, running in the isolated context contextIsolation creates.
//
// Exposes subscriptions, three narrowly scoped history-deletion requests and
// the window-chrome requests (minimize, maximize, close). No general-purpose
// IPC or filesystem access crosses the bridge.
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
// The type-only import below is erased at compile time, so it adds no
// require() to the emitted file.
// KEEP THESE LITERALS IN SYNC WITH app/main.ts's copy -- there is no
// shared module to fall out of sync silently against; grep both files for
// 'readout:' if you change any.
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { RavenswatchApi, Subscribe } from './preload-api';

const STATE_CHANNEL = 'readout:state';
const SIDECAR_DOWN_CHANNEL = 'readout:sidecar-down';
const ASSETS_CHANNEL = 'readout:assets';
const UPDATE_CHANNEL = 'readout:update';
const HISTORY_CHANNEL = 'readout:history';
const WINDOW_STATE_CHANNEL = 'readout:window-state';

function subscribe<T>(channel: string): Subscribe<T> {
  return (callback) => {
    const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => { ipcRenderer.removeListener(channel, listener); };
  };
}

const api: RavenswatchApi = {
  // process.platform, so the page can pick its title-bar layout.
  platform: process.platform,

  // callback(frame) fires once per parsed JSON object the sidecar wrote to
  // stdout. Returns an unsubscribe function; app/web/app.js doesn't need
  // it today (one subscription for the page's lifetime) but a leak-free
  // teardown path costs nothing to provide.
  onState: subscribe(STATE_CHANNEL),

  // callback({message, retryDelayMs, attempt}) fires once each time the
  // sidecar process exits on its own. `message` is the reader's own stderr
  // text when it has one (e.g. the "not running" line), not a substitute.
  onSidecarDown: subscribe(SIDECAR_DOWN_CHANNEL),

  // callback({ITEM_TEXT, SHOP_ICONS, ITEM_NAMES, OBJECT_KEYS, HERO_ICONS, DIFFICULTY_ICONS, TALENT_ICONS}) fires with the cached
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
  shareRun: (input) => ipcRenderer.invoke('readout:share-run', input),
  prepareHistoryDeletion: (input) => ipcRenderer.invoke('readout:history-delete-prepare', input),
  confirmHistoryDeletion: (input) => ipcRenderer.invoke('readout:history-delete-confirm', input),
  cancelHistoryDeletion: (token) => ipcRenderer.invoke('readout:history-delete-cancel', token),

  // Window chrome. The main process validates the sender and the action
  // string; the page only names one of three fixed actions.
  windowAction: (action) => ipcRenderer.invoke('readout:window-action', action),
  getWindowState: () => ipcRenderer.invoke('readout:window-get-state'),
  // callback({maximized, focused, fullScreen}) fires on maximize, unmaximize,
  // focus, blur and entering or leaving full screen.
  onWindowState: subscribe(WINDOW_STATE_CHANNEL),
};

contextBridge.exposeInMainWorld('ravenswatch', api);
