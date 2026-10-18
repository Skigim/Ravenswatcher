// Shared display rules; raw run records and game identifiers stay unchanged.
(function (root) {
  "use strict";

  const DASH = "—";
  const ITEM_DROP = new Set(["of", "the", "and", "a"]);

  function itemKey(name) {
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

  function stageName(name) {
    if (typeof name !== "string") return "";
    return /^baba yaga(?: map)?$/i.test(name.trim()) ? "Epilogue" : name;
  }

  function heroCode(run) {
    const definition = typeof run.hero_definition === "string" ? run.hero_definition : "";
    let code = (definition.split(/[\\/]/).pop() || "")
      .replace(/\.herodef\.ot$/i, "")
      .replace(/_Update\d+$/i, "");
    if (!code && typeof run.hero === "string") {
      code = run.hero.replace(/^Hero_/, "").split("_")[0];
    }
    return code;
  }

  function heroName(run) {
    const code = heroCode(run);
    const names = { Red: "Scarlet", Kintaro: "Kintarō" };
    return names[code] || (code ? code.replace(/_/g, " ") : "Unknown hero");
  }

  function formatStat(value) {
    return typeof value === "number" && Number.isFinite(value)
      ? Math.floor(value).toLocaleString("en-US")
      : DASH;
  }

  function formatPlaytime(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return DASH;
    const total = Math.floor(value);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  }

  // Unicode text remains selectable and accessible. CSS supplies only the
  // visual Germania o/macron when this node uses a stylized heading face.
  function setName(node, text) {
    text = String(text || "");
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

  const api = {
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

