// Shared display rules; raw run records and game identifiers stay unchanged.
//
// ONE SOURCE, TWO CONSUMERS. The browser loads the emitted run-presentation.js
// as a classic script (index.html, share.html) and reads globalThis.RunPresentation;
// the Node side (assets/tables.ts, the tests) require()s the very same file and
// gets module.exports. So this is compiled once, by the renderer config
// (web/tsconfig.json), as a script with no import/export, and the emitted file
// picks the right export at run time. The root config cannot compile it (it is a
// script, and has DOM code), so Node-side types come from the DOM-free
// run-presentation-api.d.ts instead; globals.d.ts adds setName for the page.
//
// Node does not expose `module` on globalThis, so it is declared here and tested
// with typeof, exactly as the hand-written script did.
declare const module: { exports: unknown } | undefined;

(function (root: typeof globalThis) {
  "use strict";

  const DASH = "—";
  const ITEM_DROP = new Set(["of", "the", "and", "a"]);

  function itemKey(name: unknown): string {
    return String(name)
      .replace(/’/g, "'")
      .toLowerCase()
      .replace(/'s\b/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(" ")
      .filter((word) => word && !ITEM_DROP.has(word))
      .join("");
  }

  function stageName(name: unknown): string {
    if (typeof name !== "string") return "";
    return /^baba yaga(?: map)?$/i.test(name.trim()) ? "Epilogue" : name;
  }

  function heroCode(run: { hero_definition?: unknown; hero?: unknown }): string {
    const definition = typeof run.hero_definition === "string" ? run.hero_definition : "";
    let code = (definition.split(/[\\/]/).pop() || "")
      .replace(/\.herodef\.ot$/i, "")
      .replace(/_Update\d+$/i, "");
    if (!code && typeof run.hero === "string") {
      code = run.hero.replace(/^Hero_/, "").split("_")[0] ?? "";
    }
    return code;
  }

  function heroName(run: { hero_definition?: unknown; hero?: unknown }): string {
    const code = heroCode(run);
    const names: Record<string, string> = { Red: "Scarlet", Kintaro: "Kintarō" };
    return names[code] || (code ? code.replace(/_/g, " ") : "Unknown hero");
  }

  function formatStat(value: unknown): string {
    return typeof value === "number" && Number.isFinite(value)
      ? Math.floor(value).toLocaleString("en-US")
      : DASH;
  }

  function formatPlaytime(value: unknown): string {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return DASH;
    const total = Math.floor(value);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  }

  // Unicode text remains selectable and accessible. CSS supplies only the
  // visual Germania o/macron when this node uses a stylized heading face.
  function setName(node: HTMLElement, value: unknown): void {
    const text = String(value || "");
    node.textContent = "";
    node.setAttribute("aria-label", text);
    node.classList.add("germania-name");
    for (const character of text) {
      if (character !== "ō") {
        node.append(document.createTextNode(character));
        continue;
      }
      const glyph = document.createElement("span");
      const source = document.createElement("span");
      glyph.className = "g-macron";
      source.className = "glyph-source";
      source.textContent = character;
      glyph.append(source);
      node.append(glyph);
    }
  }

  const api: RunPresentationApi = {
    itemKey,
    stageName,
    heroCode,
    heroName,
    formatStat,
    formatPlaytime,
    setName,
  };
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.RunPresentation = Object.freeze(api);
  }
})(globalThis);

