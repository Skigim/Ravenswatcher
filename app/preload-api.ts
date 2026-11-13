// The API app/preload.js exposes to the page as window.ravenswatch. Types only:
// preload.ts implements it and the renderer consumes it.
// Channel names stay inlined in preload.js and main.js (a sandboxed preload
// cannot require a shared module), so they are deliberately not exported here.
import type { StoredRun } from './history';
import type { SidecarFrame } from './sidecar-frame';

/** Returned by every subscription; call it to stop listening. */
export type Unsubscribe = () => void;
export type Subscribe<T> = (callback: (payload: T) => void) => Unsubscribe;

/** Sent when the reader process exits on its own, before the retry. */
export interface SidecarDownNotice {
  /** The reader's own stderr text when it has one. */
  message: string;
  retryDelayMs: number;
  attempt: number;
}

/** Decoded game tables, sent on startup when a cache exists and after each rebuild. */
export interface AssetTables {
  ITEM_TEXT?: unknown;
  SHOP_ICONS?: unknown;
  ITEM_NAMES?: unknown;
  OBJECT_KEYS?: unknown;
  HERO_ICONS?: unknown;
  DIFFICULTY_ICONS?: unknown;
  TALENT_ICONS?: unknown;
}

/** The once-per-launch release check. latest and url are null when nothing is newer. */
export interface UpdateInfo {
  current: string;
  /** False when the check itself failed. */
  ok: boolean;
  latest: string | null;
  url: string | null;
  /** Why the check failed; null otherwise. */
  reason: string | null;
}

/** Every stored run, oldest first, plus the count of rows that could not be loaded. */
export interface HistoryPayload {
  runs: StoredRun[];
  skipped: number;
}

export interface ShareRunRequest { runId: number; stylizedFonts: boolean }

/** main.js wraps history requests: a rejected or failed one is { ok: false, error }. */
export type IpcFailure = { ok: false; error: string };

export type ShareRunResult = { ok: true } | IpcFailure;

export type HistoryDeletionScope = 'single' | 'selected' | 'all';

/** ids is required for 'single' and 'selected' and refused for 'all'. */
export interface HistoryDeletionRequest { scope: HistoryDeletionScope; ids?: number[] }

export type PrepareHistoryDeletionResult =
  | { ok: true; token: string; scope: HistoryDeletionScope; ids: number[]; step: number; steps: number }
  | IpcFailure;

export interface ConfirmHistoryDeletionRequest { token: string; typed?: string }

export type ConfirmHistoryDeletionResult =
  | { ok: true; done: boolean; step?: number; steps?: number }
  | IpcFailure;

export type CancelHistoryDeletionResult = { ok: true } | IpcFailure;

/** What the page may ask the main window to do. Anything else is refused. */
export type WindowAction = 'minimize' | 'toggle-maximize' | 'close';

/** The window state the custom title bar styles itself from. */
export interface WindowState {
  readonly maximized: boolean;
  readonly focused: boolean;
  readonly fullScreen: boolean;
}

export type WindowActionResult = { ok: true } | IpcFailure;

export type WindowStateResult = { ok: true; state: WindowState } | IpcFailure;

export interface RavenswatchApi {
  /** process.platform of the shell, e.g. 'win32'. */
  platform: string;
  /** Once per frame the reader wrote to stdout. */
  onState: Subscribe<SidecarFrame>;
  onSidecarDown: Subscribe<SidecarDownNotice>;
  onAssets: Subscribe<AssetTables>;
  onUpdate: Subscribe<UpdateInfo>;
  /** On every page load and after each finished run is saved. */
  onHistory: Subscribe<HistoryPayload>;
  shareRun(input: ShareRunRequest): Promise<ShareRunResult>;
  prepareHistoryDeletion(input: HistoryDeletionRequest): Promise<PrepareHistoryDeletionResult>;
  confirmHistoryDeletion(input: ConfirmHistoryDeletionRequest): Promise<ConfirmHistoryDeletionResult>;
  cancelHistoryDeletion(token: string): Promise<CancelHistoryDeletionResult>;
  /** Rejected with { ok: false } for an unknown action or a sender that is not the main window. */
  windowAction(action: WindowAction): Promise<WindowActionResult>;
  getWindowState(): Promise<WindowStateResult>;
  /** Fires on maximize, unmaximize, focus, blur and entering or leaving full screen. */
  onWindowState: Subscribe<WindowState>;
}
