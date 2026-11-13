// Types of run-presentation, free of DOM types so the Node side (assets/tables.ts,
// compiled without the DOM lib) can import them. setName touches the DOM and is
// added in globals.d.ts for the renderer.
export interface RunPresentationCore {
  /** Normalized item-name key shared by the asset tables and the page. */
  itemKey(name: unknown): string;
  stageName(name: unknown): string;
  heroCode(run: { hero_definition?: unknown; hero?: unknown }): string;
  heroName(run: { hero_definition?: unknown; hero?: unknown }): string;
  /** Floored, en-US grouped; an em dash when not a finite number. */
  formatStat(value: unknown): string;
  formatPlaytime(value: unknown): string;
}
