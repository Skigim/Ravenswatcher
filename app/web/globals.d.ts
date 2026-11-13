// Globals the renderer's classic scripts share. This file has no top-level
// import/export on purpose: that keeps it a script, so these are global.

/** The page-side API: the shared core plus the one function that needs the DOM. */
type RunPresentationApi = import("./run-presentation-api").RunPresentationCore & {
  setName(node: HTMLElement, text: unknown): void;
};

/** Set by run-presentation.js (frozen) before the page scripts run. */
declare var RunPresentation: Readonly<RunPresentationApi>;

/** Called by the main process through executeJavaScript on the share window. */
declare var renderShare: (input: ShareInput) => Promise<{ width: number; height: number }>;

/** The run record and decoded tables main.js hands to the share window. */
interface ShareMelody { name?: string; state?: string; notes?: number | null; notes_earned?: number | null; icon?: string }
interface ShareTalent { name?: string; key?: string; rarity?: string }
interface ShareRun {
  result?: string;
  hero?: string;
  hero_definition?: string;
  difficulty?: number | null;
  map_name?: string;
  playtime_s?: number | null;
  score?: { total?: number | null };
  melodies?: ShareMelody[];
  talents?: ShareTalent[];
  objects?: string[];
  object_counts?: (number | null)[];
  damage?: Record<string, number | null | undefined>;
}
interface ShareTables {
  DIFFICULTY_ICONS?: Record<string, string>;
  HERO_ICONS?: Record<string, string>;
  TALENT_ICONS?: Record<string, Record<string, string>>;
  OBJECT_KEYS?: Record<string, string>;
  OBJECT_RARITIES?: Record<string, string>;
  SHOP_ICONS?: Record<string, string>;
  ITEM_NAMES?: Record<string, string>;
}
interface ShareInput { run: ShareRun; tables?: ShareTables; stylizedFonts?: boolean }

interface Window {
  /** Defined by preload.js; undefined when the page runs outside Electron. */
  ravenswatch: import("../preload-api").RavenswatchApi | undefined;
}
