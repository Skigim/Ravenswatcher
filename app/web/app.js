/* Paint the readout.
 *
 * Every field comes from one readState() frame pushed over IPC; nothing here
 * decides what a value means. A sidecar that stops sending leaves the last
 * frame up and marks the status stale rather than blanking the page --
 * the game being alt-tabbed shouldn't look like the run ending. */

"use strict";

const DASH = "—";
const el = (id) => document.getElementById(id);

// True only under the Electron IPC transport (window.ravenswatch present).
// Computed once: the preload bridge either exists for the page's whole
// lifetime or never does.
const ELECTRON_TRANSPORT = !!(window.ravenswatch && typeof window.ravenswatch.onState === "function");

let coopConsent = null; // null | 'agreed' | 'declined'
let lastRenderedFrame = null;

// Every icon is a name in the app's own vocabulary (map_chest.png,
// item_dream.png). main.js serves them on asset://icons/ out of a cache it
// decodes from the player's own game install; the repo's assets/ folder
// holds reference copies the page never loads.
const ICON_BASE = "asset://icons/";

function icon(node, name, dim) {
  node.style.backgroundImage = name ? `url("${ICON_BASE}${name}")` : "none";
  node.classList.toggle("dim", !!dim);
}

// Item art and text arrive over readout:assets once main.js has decoded
// them from the game's own object definitions, and again after each
// rebuild: each definition names the texture it draws and the text keys it
// displays. The reader returns a display name ("Sand of Knowledge");
// itemKey() reduces it to the token both tables are keyed by. Until the
// tables arrive an offer shows its name alone.
//
// Dropped before joining, so "Ring of Dispel" keys as "ringdispel". itemKey()
// in app/assets/tables.ts is this function; change both or neither --
// test-item-tables holds them equal over every shipped name.
const ICON_DROP = new Set(["of", "the", "and", "a"]);
let ITEM_TEXT = {};
let SHOP_ICONS = {};
let ITEM_NAMES = {};
let OBJECT_KEYS = {};
let OBJECT_RARITIES = {};
let HERO_ICONS = {};
let DIFFICULTY_ICONS = {};
let TALENT_ICONS = {};

function applyAssets(tables) {
  ITEM_TEXT = (tables && tables.ITEM_TEXT) || {};
  SHOP_ICONS = (tables && tables.SHOP_ICONS) || {};
  ITEM_NAMES = (tables && tables.ITEM_NAMES) || {};
  OBJECT_KEYS = (tables && tables.OBJECT_KEYS) || {};
  OBJECT_RARITIES = (tables && tables.OBJECT_RARITIES) || {};
  HERO_ICONS = (tables && tables.HERO_ICONS) || {};
  DIFFICULTY_ICONS = (tables && tables.DIFFICULTY_ICONS) || {};
  TALENT_ICONS = (tables && tables.TALENT_ICONS) || {};
  if (lastRenderedFrame) render(lastRenderedFrame);
  renderHistory();
  refreshTip();
}

/** The token a display name reduces to; the key of ITEM_TEXT and SHOP_ICONS. */
function itemKey(name) {
  // The game spells one possessive with U+2019 ("Bloody Mary’s Mirror").
  return String(name).replace(/\u2019/g, "'").toLowerCase()
    .replace(/'s\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim().split(" ")
    .filter((w) => w && !ICON_DROP.has(w))
    .join("");
}

// --- tooltip --------------------------------------------------------------
// One element for every panel. The render functions leave data-tip-name and
// data-tip-body on the things that know more than they paint; this reads
// those and nothing else, so it never has to understand a frame. Delegated
// from document because every list here is rebuilt by innerHTML and a
// listener per row would be lost on the next map.
const tipEl = el("tip");
let tipAnchor = null;

function placeTip(target) {
  const r = target.getBoundingClientRect();
  const w = tipEl.offsetWidth;
  const h = tipEl.offsetHeight;
  const edge = 8;
  const lift = 6;
  // Above by default, below when the top would leave the window. Centered,
  // then pushed inside the side edges.
  let top = r.top - h - lift;
  if (top < edge) top = r.bottom + lift;
  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(edge, Math.min(left, window.innerWidth - w - edge));
  tipEl.style.left = left + "px";
  top = Math.max(edge, Math.min(top, window.innerHeight - h - edge));
  tipEl.style.top = top + "px";
}

function showTip(target) {
  tipAnchor = target;
  RunPresentation.setName(el("tip-name"), target.dataset.tipName);
  el("tip-body").textContent = target.dataset.tipBody || "";
  const art = el("tip-icon"), meta = el("tip-meta");
  art.hidden = !target.dataset.tipIcon;
  if (target.dataset.tipIcon) icon(art, target.dataset.tipIcon);
  else art.style.backgroundImage = "";
  meta.textContent = target.dataset.tipMeta || "";
  meta.hidden = !meta.textContent;
  tipEl.classList.toggle("tip-talent", target.dataset.tipKind === "talent");
  tipEl.dataset.rarity = target.dataset.tipRarity || "";
  tipEl.hidden = false;
  placeTip(target);
}

function hideTip() {
  tipAnchor = null;
  tipEl.hidden = true;
}

// Called at the end of every render. The anchor may have been rebuilt out
// from under the pointer (a new map replaces every tile), or its text may
// have changed in place (an offer sold while hovered). Re-reading it is
// cheaper than deciding which happened.
function refreshTip() {
  if (!tipAnchor) return;
  if (tipAnchor.isConnected && tipAnchor.dataset.tipName) showTip(tipAnchor);
  else hideTip();
}

function initTip() {
  document.addEventListener("focusin", e => {
    const target = e.target.closest ? e.target.closest("[data-tip-name]") : null;
    if (target) showTip(target);
  });
  document.addEventListener("focusout", () => hideTip());
  document.addEventListener("mouseover", (e) => {
    const target = e.target.closest ? e.target.closest("[data-tip-name]") : null;
    if (!target) { if (tipAnchor) hideTip(); return; }
    if (target !== tipAnchor) showTip(target);
  });
  // mouseover covers movement inside the window; this covers the pointer
  // leaving it, where relatedTarget is null and no mouseover follows.
  document.addEventListener("mouseout", (e) => {
    if (tipAnchor && !e.relatedTarget) hideTip();
  });
}

// Sets or clears the pair in one call. A node with no name shows nothing,
// which is how a placeholder or an unresolved row opts out.
function setTip(node, name, body) {
  if (!name) {
    delete node.dataset.tipName;
    delete node.dataset.tipBody;
    return;
  }
  node.dataset.tipName = name;
  if (body) node.dataset.tipBody = body;
  else delete node.dataset.tipBody;
}

// --- settings -------------------------------------------------------------
// One setting, stored in the renderer. localStorage is viable here despite
// the page being file://: verified against the Electron this ships with that
// a value written from the loaded page survives both a reload and a full
// restart of the app. It is still every-access-guarded -- the same file
// opened another way (a browser with site data disabled, a private context)
// can throw on the property rather than return null, and a look preference
// is never worth taking the page down for.
const PANEL_LINES_KEY = "ravenswatch:panel-lines";
const STYLIZED_FONTS_KEY = "ravenswatch:stylized-fonts";
const DIAG_BAR_KEY = "ravenswatch:diagnostics";
const TILE_COLS_KEY = "ravenswatch:tile-columns";
const TILE_COLS_MIN = 3;
const TILE_COLS_MAX = 8;
const TILE_COLS_DEFAULT = 5;

function readPanelLines() {
  try { return localStorage.getItem(PANEL_LINES_KEY) !== "off"; }
  catch { return true; }
}

function writePanelLines(on) {
  try { localStorage.setItem(PANEL_LINES_KEY, on ? "on" : "off"); }
  catch { /* unavailable: the setting still applies, it just won't persist */ }
}

function readStylizedFonts() {
  try { return localStorage.getItem(STYLIZED_FONTS_KEY) !== "off"; }
  catch { return true; }
}
function applyStylizedFonts(on) {
  document.body.classList.toggle("stylized-fonts", on);
}
function writeStylizedFonts(on) {
  try { localStorage.setItem(STYLIZED_FONTS_KEY, on ? "on" : "off"); }
  catch { /* unavailable: the current choice still applies */ }
}

function readDiagBar() {
  try { return localStorage.getItem(DIAG_BAR_KEY) === "on"; }
  catch { return false; }
}

function writeDiagBar(on) {
  try { localStorage.setItem(DIAG_BAR_KEY, on ? "on" : "off"); }
  catch { /* unavailable */ }
}

// Anything that is not an integer in range reads as the default -- a stale
// key from an older build must never produce a zero-column grid.
function readTileCols() {
  try {
    const n = Number(localStorage.getItem(TILE_COLS_KEY));
    return Number.isInteger(n) && n >= TILE_COLS_MIN && n <= TILE_COLS_MAX
      ? n : TILE_COLS_DEFAULT;
  } catch { return TILE_COLS_DEFAULT; }
}

function writeTileCols(n) {
  try { localStorage.setItem(TILE_COLS_KEY, String(n)); }
  catch { /* unavailable */ }
}

// The release the player chose to skip. Stored by version so a later
// release shows the bar again; nothing else touches it.
const SKIP_VERSION_KEY = "ravenswatch:skip-version";
function readSkipVersion() {
  try { return localStorage.getItem(SKIP_VERSION_KEY); }
  catch { return null; }
}
function writeSkipVersion(v) {
  try { localStorage.setItem(SKIP_VERSION_KEY, v); }
  catch { /* private mode or blocked storage: the skip lasts this session */ }
}

// The launch check's one message, and whether "Remind me later" was clicked
// this session. Both start empty so a page with no transport shows nothing.
let updateInfo = null;
let updateDismissed = false;

function showUpdateBar() {
  const bar = el("update-bar");
  const latest = updateInfo && updateInfo.latest;
  bar.hidden = !latest || updateDismissed || latest === readSkipVersion();
}

// Renders the bar and the version row from {current, ok, latest, url}.
// The row ignores skip and dismiss so the download stays reachable.
function applyUpdate(info) {
  updateInfo = info || null;
  const current = info && info.current ? String(info.current) : "";
  const latest = info && info.latest ? String(info.latest) : null;
  const url = info && info.url ? String(info.url) : null;

  el("version-label").textContent = current ? "Version " + current : "Version";
  const note = el("version-note");
  const rowLink = el("version-download");
  if (latest && url) {
    note.textContent = latest + " available";
    rowLink.href = url;
    rowLink.hidden = false;
  } else {
    // A failed check says nothing unless Diagnostics is on; then the reason
    // main.js attached is the one place it can be read in a packaged build.
    // The body class, not storage: it is what the toggle set even when the
    // write to storage failed.
    const diagOn = !document.body.classList.contains("no-diag");
    const reason = info && !info.ok && info.reason && diagOn
      ? "Check failed: " + info.reason : "";
    note.textContent = info && info.ok ? "Up to date" : reason;
    rowLink.removeAttribute("href");
    rowLink.hidden = true;
  }

  el("update-text").textContent = latest ? "Ravenswatcher " + latest + " is available." : "";
  const barLink = el("update-download");
  if (latest && url) barLink.href = url; else barLink.removeAttribute("href");
  showUpdateBar();
}

function initUpdateBar() {
  el("update-skip").addEventListener("click", () => {
    if (updateInfo && updateInfo.latest) writeSkipVersion(updateInfo.latest);
    showUpdateBar();
  });
  el("update-later").addEventListener("click", () => {
    updateDismissed = true;
    showUpdateBar();
  });
}

// The class carries the whole effect -- see .seamless in styles.css, which
// repaints each seam to match its neighbours without moving anything.
function applyPanelLines(on) {
  document.body.classList.toggle("seamless", !on);
}

function applyDiagBar(on) {
  document.body.classList.toggle("no-diag", !on);
}

// One custom property carries the column count; .tiles-list[data-mode="grid"]
// derives the track list and the cell edge from it, so a change reflows
// without a re-render.
function applyTileCols(n) {
  el("tiles-list").style.setProperty("--tile-cols", String(n));
}

// Called at the bottom of this file, which runs from a <script> at the end of
// <body> -- so the stored setting is on the class list before the first paint
// and there is no flash of a lined page resolving into an unlined one.
function initSettings() {
  const gear = el("settings-open");
  const panel = el("settings");
  const scrim = el("settings-scrim");
  const toggle = el("panel-lines");
  const diagToggle = el("diag-bar");

  const fontToggle = el("stylized-fonts");
  let stylized = readStylizedFonts();
  applyStylizedFonts(stylized);
  fontToggle.setAttribute("aria-checked", String(stylized));
  fontToggle.addEventListener("click", () => {
    stylized = !stylized;
    applyStylizedFonts(stylized);
    writeStylizedFonts(stylized);
    fontToggle.setAttribute("aria-checked", String(stylized));
  });

  let on = readPanelLines();
  applyPanelLines(on);
  toggle.setAttribute("aria-checked", String(on));

  let diagOn = readDiagBar();
  applyDiagBar(diagOn);
  if (diagToggle) diagToggle.setAttribute("aria-checked", String(diagOn));

  const colsInput = el("tile-cols");
  const colsValue = el("tile-cols-value");
  let cols = readTileCols();
  applyTileCols(cols);
  colsInput.value = String(cols);
  colsValue.textContent = String(cols);

  function setOpen(open) {
    panel.hidden = !open;
    scrim.hidden = !open;
    gear.setAttribute("aria-expanded", String(open));
    if (open) { hideTip(); toggle.focus(); }
  }

  gear.addEventListener("click", () => setOpen(panel.hidden));
  scrim.addEventListener("click", () => setOpen(false));

  toggle.addEventListener("click", () => {
    on = !on;
    applyPanelLines(on);
    writePanelLines(on);
    toggle.setAttribute("aria-checked", String(on));
  });

  if (diagToggle) {
    diagToggle.addEventListener("click", () => {
      diagOn = !diagOn;
      applyDiagBar(diagOn);
      writeDiagBar(diagOn);
      diagToggle.setAttribute("aria-checked", String(diagOn));
      if (updateInfo) applyUpdate(updateInfo);   // the version note follows the toggle
    });
  }

  colsInput.addEventListener("input", () => {
    cols = Number(colsInput.value);
    applyTileCols(cols);
    writeTileCols(cols);
    colsValue.textContent = String(cols);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) {
      setOpen(false);
      gear.focus();   // Escape shouldn't strand focus on a hidden control
    }
  });
}

function renderConnection(state, detail = "") {
  const names = { connected: "Connected to Ravenswatch", loading: "Connecting to Ravenswatch",
    waiting: "Waiting for Ravenswatch", stale: "Connection is not responding", error: "Connection unavailable" };
  const host = el("head-right");
  host.dataset.mode = "live";
  if (!host.firstElementChild) host.innerHTML = '<div class="status"><span class="status-dot" aria-hidden="true"></span></div>';
  const status = host.firstElementChild;
  status.className = state === "connected" ? "status status-live" : "status";
  status.dataset.connection = state;
  status.tabIndex = 0;
  status.setAttribute("role", "img");
  status.setAttribute("aria-label", [names[state], detail].filter(Boolean).join(". "));
  setTip(status, names[state], detail);
  if (tipAnchor === status) refreshTip();
}

function renderHead(s) {
  // Resolved values distinguish a connected reader from one still loading.
  renderConnection(s.found > 0 ? "connected" : "loading");
}

// The whole-app red edge that marks combat. One class on <body>; styles.css
// does the rest.
//
// Off whenever the readout is not live -- no run, curtain up, sidecar gone,
// no transport. The edge reports one event, aggro dropping, and the only way
// to report it is to stop being on. A feed we cannot hear can't tell us the
// drop happened, so a pulse left running would have the player waiting on a
// teleport that already came back. Silence is the honest failure here, which
// is why this does not follow markStale()'s keep-the-last-frame rule.
function setCombatEdge(on) {
  document.body.classList.toggle("in-combat", !!on);
}

function renderKpis(s) {
  // Hero level and the map name are not drawn: the game already shows both.
  // The reader still sends map_name, which the loading curtain uses.
  //
  // The questline is a single name, which the reader either has or dashes.
  // The waiting state is the dash every other unresolved KPI uses, not a `?`
  // placard: this tile is one line tall and there is nothing to fill. For
  // Three Pigs the reader makes the house the name.
  icon(el("quest-icon"), s.quest_key ? s.quest_icon : "icon_question.png", !s.quest_key);
  const questName = (s.quest_key && s.quest_name !== "Undetermined") ? s.quest_name : DASH;
  el("quest-name").textContent = questName;
  el("quest-name").classList.toggle("unresolved", questName === DASH);
}

/** The name the reader read, or a dash. Never a guess. */
function shopIconFor(name) {
  return (name && SHOP_ICONS[itemKey(name)]) || "icon_question.png";
}

function makeShopRow() {
  const row = document.createElement("div");
  row.className = "shop-row";
  row.innerHTML =
    '<div class="shop-icon"></div>'
    + '<div class="shop-text"><div class="shop-name"></div></div>'
    + '<div class="shop-price"><span class="shop-price-value"></span>'
    + '<span class="shards"></span></div>';
  return row;
}

// One list-fills-the-column state, used for every case that has no offers to
// draw. `mode` keeps it from being rebuilt on every 250 ms poll.
function shopPlaceholder(mode, mark, label, note, fault) {
  const host = el("shop-list");
  if (host.dataset.mode === mode) return;
  host.dataset.mode = mode;
  host.className = "shop-list shop-list-empty";
  const row = document.createElement("div");
  row.className = "shop-row";
  const box = document.createElement("div");
  box.className = "shop-waiting";
  const markNode = document.createElement("div");
  markNode.className = "shop-waiting-mark" + (fault ? " fault" : "");
  markNode.textContent = mark;
  const kicker = document.createElement("div");
  kicker.className = "kicker";
  kicker.textContent = label;
  box.append(markNode, kicker);
  if (note) {
    const noteNode = document.createElement("div");
    noteNode.className = "shop-waiting-note";
    noteNode.textContent = note;
    box.append(noteNode);
  }
  row.append(box);
  host.innerHTML = "";
  host.append(row);
}

function renderShop(s) {
  // The balance is a plain GlobalValue and does not need the shop, so it is
  // painted in every state including the ones with no offers.
  const shards = s.dream_shards;
  el("shop-balance").textContent = shards === null ? DASH : String(shards);
  el("shop-balance").classList.toggle("unresolved", shards === null);

  const badge = el("shop-badge");
  const offers = Array.isArray(s.sandman) ? s.sandman : null;

  if (s.sandman_status === "unresolved" && !offers) {
    // The gate says the shop is open but the grid would not read. This is the
    // one state that must not look like an empty shop, so it names what is
    // stale and what fixes it rather than showing nothing.
    badge.hidden = false;
    badge.textContent = "Unavailable";
    shopPlaceholder("unresolved", "!", "Shop could not be read",
      "Shop data format unrecognized. An update may be required.", true);
    return;
  }

  if (!offers) {
    // Nothing has been read this run. Closing the shop clears every cell's
    // pointer to its item (measured live 2026-09-03), so there is no read to
    // derive without the player opening one -- which is what this asks for.
    badge.hidden = true;
    shopPlaceholder("pending", DASH, "Open the Sandman shop to load offers");
    return;
  }

  badge.hidden = true;

  const host = el("shop-list");
  if (host.dataset.mode !== "offers" || host.childElementCount !== offers.length) {
    host.dataset.mode = "offers";
    host.className = "shop-list";
    host.innerHTML = "";
    for (let i = 0; i < offers.length; i++) host.append(makeShopRow());
  }

  offers.forEach((offer, i) => {
    const row = host.children[i];
    icon(row.querySelector(".shop-icon"), shopIconFor(offer.name));

    const name = row.querySelector(".shop-name");
    name.textContent = offer.name || DASH;
    name.classList.toggle("unresolved", !offer.name);

    // ITEM_TEXT is keyed by the display name, the same token the reader
    // returns, so unlike the icon lookup it needs no aliases. A name the
    // table does not know shows alone rather than with a guess.
    const text = offer.name ? ITEM_TEXT[itemKey(offer.name)] : null;
    setTip(row, offer.name,
      offer.purchased ? ["Sold", text].filter(Boolean).join("\n") : text);

    const price = row.querySelector(".shop-price-value");
    const shard = row.querySelector(".shards");

    if (offer.purchased) {
      price.textContent = "SOLD";
      shard.hidden = true;
      row.className = "shop-row shop-row-sold";
    } else {
      shard.hidden = false;
      price.textContent = offer.price === null || offer.price === undefined
        ? DASH : String(offer.price);

      // Affordability needs both numbers. Without the balance there is no
      // comparison to draw, and a row must not imply one either way -- hence a
      // third class rather than defaulting to "short". Price 0 is a real price.
      const known = shards !== null && offer.price !== null && offer.price !== undefined;
      const afford = known && shards >= offer.price;
      row.className = "shop-row "
        + (!known ? "shop-row-unknown" : afford ? "shop-row-afford" : "shop-row-short");
    }
  });
}

// A melody card, at the size of a KPI cell. The effect text and note count
// live in the tooltip; at this width they would crowd the name. The icon sits
// where every other KPI cell puts one, so it costs no height, and it is how a
// melody is recognised at a glance.
function makeMelodyCard() {
  const card = document.createElement("div");
  card.className = "kpi melody-card";
  card.innerHTML =
    '<div class="kpi-top"><div class="badge melody-state"></div>'
    + '<div class="kpi-icon melody-icon"></div></div>'
    + '<div class="kpi-value melody-name"></div>';
  return card;
}

function renderMelodies(s) {
  const host = el("melody-cards");
  // Already held: sweeper.js keeps the last resolved payload across a sweep
  // that read nothing and clears it when the run ends, so a null here means
  // the channel genuinely has nothing to show.
  const slots = (s.melodies && Array.isArray(s.melodies)) ? s.melodies : null;

  if (!slots) {
    // Empty cards rather than a placard. These cells are part of a four-across
    // band, and a band with three holes in it reads worse than a band of
    // placeholders.
    if (host.dataset.mode !== "waiting") {
      host.dataset.mode = "waiting";
      host.innerHTML = "";
      for (let i = 0; i < 3; i++) {
        const card = makeMelodyCard();
        card.classList.add("melody-card-waiting");
        card.querySelector(".melody-state").textContent = "";
        icon(card.querySelector(".melody-icon"), "UI_Melody_Icon_Locked.png", true);
        const name = card.querySelector(".melody-name");
        name.textContent = "Loading…";
        name.classList.add("unresolved");
        host.append(card);
      }
    }
    return;
  }

  if (host.dataset.mode !== "melodies" || host.childElementCount !== slots.length) {
    host.dataset.mode = "melodies";
    host.innerHTML = "";
    for (let i = 0; i < slots.length; i++) host.append(makeMelodyCard());
  }

  slots.forEach((m, i) => {
    const card = host.children[i];
    const isLocked = m.state === "locked";
    const isUnresolved = m.state === null || m.state === undefined;

    const badge = card.querySelector(".melody-state");
    badge.textContent = isUnresolved ? DASH : m.state;
    badge.className = "badge melody-state"
      + (isUnresolved ? " dim unresolved melody-state-unresolved" : ` melody-state-${m.state}`);

    const name = card.querySelector(".melody-name");
    name.textContent = m.name;
    name.classList.toggle("unresolved", isLocked || isUnresolved);

    // A locked slot draws the padlock art rather than the melody's own, which
    // is the same thing the game does and is why that texture ships.
    icon(card.querySelector(".melody-icon"),
      (isLocked || isUnresolved) ? "UI_Melody_Icon_Locked.png" : m.icon,
      isLocked || isUnresolved);

    card.className = "kpi melody-card"
      + (isUnresolved ? " melody-row-unresolved" : ` melody-row-${m.state}`);

    // A locked melody gets the same summary as an active one: the badge
    // already says it is locked, and what the player wants from the hover is
    // what it would do.
    setTip(card, isUnresolved ? null : m.name,
      [m.effect, m.notes ? `${m.notes} notes` : null].filter(Boolean).join("\n"));
  });
}

function makeTileCell() {
  const cell = document.createElement("div");
  cell.className = "tile-cell";
  // The ring first, so it sits behind. It is an alpha silhouette used as a
  // CSS mask over a tier colour -- see .tile-ring in styles.css -- because
  // the shipped art is a single white shape and tinting a PNG in the page
  // is not something CSS does exactly.
  cell.innerHTML = '<div class="tile-ring"></div><div class="tile-art"></div>'
    + '<div class="tile-count"></div><div class="tile-check"></div>';
  return cell;
}

// Done marks, kept by hand. The reader cannot yet tell which placements the
// player has finished, so until it can, a left-click takes one off a tile's
// count and a right-click puts it back; at zero the cell shows the game's
// check over a dimmed icon. See docs/superpowers/specs/2026-09-19-tile-done-
// marks-design.md.
//
// The tally lives on the cell as data-done and nowhere else. The cell list is
// rebuilt when the map changes (see renderTiles), which discards it, and that
// is the whole reset rule: a new map starts clean, and a restart of the app
// forgets. It is clamped to the live count at paint time, so a placement
// that appears mid-map brings the tile back with the difference showing.
function initTileDone() {
  const host = el("tiles-list");
  const adjust = (e, delta) => {
    const cell = e.target.closest ? e.target.closest(".tile-cell") : null;
    if (!cell) return;
    const count = Number(cell.dataset.count) || 0;
    const done = Math.min(Number(cell.dataset.done) || 0, count);
    cell.dataset.done = String(Math.max(0, Math.min(count, done + delta)));
    if (lastRenderedFrame) render(lastRenderedFrame);
  };
  host.addEventListener("click", (e) => adjust(e, +1));
  host.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    adjust(e, -1);
  });
}
// What the generator placed that is worth walking to, as the game's own
// minimap icons and nothing else. No names, no section headers: the icon is
// the label.
//
// state.ts decides which tiles survive and which icon each gets; this walks
// a display-ready list. The count draws only above one, so the common case is
// a bare icon.
function renderTiles(s) {
  const host = el("tiles-list");
  const cells = (s.tiles && Array.isArray(s.tiles)) ? s.tiles : null;

  // null and [] are different answers and must not look alike. null is the
  // roster not read yet -- it costs most of a second on map load, so this is
  // a state the player really sees. [] is a map that was read and had nothing
  // on it worth marking, which is a finding, not a wait.
  if (!cells) {
    if (host.dataset.mode !== "waiting") {
      host.dataset.mode = "waiting";
      delete host.dataset.shape;
      host.innerHTML = '<div class="tiles-waiting"><div class="tiles-waiting-mark">?</div>'
        + '<div class="kicker">Loading…</div></div>';
    }
    return;
  }
  if (cells.length === 0) {
    if (host.dataset.mode !== "empty") {
      host.dataset.mode = "empty";
      delete host.dataset.shape;
      host.innerHTML = '<div class="tiles-waiting"><div class="kicker">Nothing placed</div></div>';
    }
    return;
  }

  // Rebuilt only when the set of icons changes, which in practice is once per
  // map: the roster is read on map load and held. The count is written every
  // frame either way, so a reward opening mid-run updates without a rebuild.
  // The map id is part of the key so that two maps with the same roster in
  // the same order do not share their done marks.
  const shape = s.map_id + "|" + cells.map(c => c.icon).join("|");
  if (host.dataset.shape !== shape) {
    host.dataset.mode = "grid";
    host.dataset.shape = shape;
    host.innerHTML = "";
    for (let i = 0; i < cells.length; i++) host.append(makeTileCell());
  }

  cells.forEach((c, i) => {
    const cell = host.children[i];
    icon(cell.querySelector(".tile-art"), c.icon);

    // Tier is the game's own encoding: the ring behind the icon, green,
    // yellow or red for 1, 2 and 3. Things with no tier ship no ring, and
    // drawing one anyway would invent a distinction the game does not make.
    const ring = cell.querySelector(".tile-ring");
    ring.hidden = !c.outline;
    if (c.outline) {
      const url = `url("${ICON_BASE}${c.outline}")`;
      ring.style.webkitMaskImage = url;
      ring.style.maskImage = url;
    }
    // What is left is the live count less the player's own tally; see
    // initTileDone. data-count is what the click handlers clamp against.
    cell.dataset.count = String(c.count);
    const done = Math.min(Number(cell.dataset.done) || 0, c.count);
    const left = c.count - done;
    cell.className = "tile-cell" + (c.tier ? " tile-tier-" + c.tier : "")
      + (left === 0 ? " tile-done" : "");

    // A count of one would sit on almost every icon and bury the few that
    // are really doubled.
    cell.querySelector(".tile-count").textContent = left > 1 ? "×" + left : "";

    // Not painted -- the panel is icons only. The tooltip says it on hover;
    // the aria-label is what a screen reader gets instead of an unlabelled
    // image. Not `title`: the native tooltip would draw on top of ours.
    const body = [c.boss ? "Expected boss: " + c.boss : null,
      c.tier ? "Tier " + c.tier : null,
      left > 1 ? "×" + left : (left === 0 ? "Done" : null)]
      .filter(Boolean).join("\n");
    setTip(cell, c.label, body);
    cell.setAttribute("aria-label", c.label + (body ? " " + body.replace("\n", " ") : ""));
  });
}

function renderDiag(s) {
  const bits = [s.process];
  if (s.pid) bits.push(`pid ${s.pid}`);
  if (s.base) bits.push(`base 0x${s.base.toString(16).toUpperCase().padStart(16, "0")}`);
  if (s.binding_vtable) bits.push(`binding vtable +0x${s.binding_vtable.toString(16).toUpperCase()}`);
  bits.push(`sweep #${s.sweeps}`);
  bits.push(`${s.found}/${s.tracked} values resolved`);
  bits.push(`re-sweep every ${s.sweep_interval}s`);
  bits.push(`poll ${s.poll_ms} ms`);
  if (historySkipped) bits.push(`${historySkipped} unreadable history line${historySkipped === 1 ? "" : "s"}`);
  el("diag").textContent = bits.join(" · ");
}

function ensureCurtain(headline, subline) {
  let br = document.getElementById("between-runs");
  if (!br) {
    br = document.createElement("div");
    br.id = "between-runs";
    br.className = "curtain between-runs";
    br.innerHTML = '<div class="curtain-headline between-runs-message"></div>'
      + '<div class="curtain-sub" hidden></div>';
    document.querySelector(".shell").insertBefore(br, document.querySelector(".body + .rule"));
  }
  br.querySelector(".curtain-headline").textContent = headline || "";
  const sub = br.querySelector(".curtain-sub");
  sub.textContent = subline || "";
  sub.hidden = !subline;
}

function showCoopDialog() {
  const dialog = el("coop-dialog");
  const scrim = el("coop-scrim");
  if (dialog && dialog.hidden) {
    hideTip();
    dialog.hidden = false;
    if (scrim) scrim.hidden = false;
    const agree = el("coop-agree");
    if (agree) agree.focus();
  }
}

function hideCoopDialog() {
  const dialog = el("coop-dialog");
  const scrim = el("coop-scrim");
  if (dialog) dialog.hidden = true;
  if (scrim) scrim.hidden = true;
}

function initCoopConsent() {
  const agree = el("coop-agree");
  const decline = el("coop-decline");
  const scrim = el("coop-scrim");

  if (agree) {
    agree.addEventListener("click", () => {
      coopConsent = "agreed";
      hideCoopDialog();
      if (lastRenderedFrame) render(lastRenderedFrame);
    });
  }

  if (decline) {
    decline.addEventListener("click", () => {
      coopConsent = "declined";
      hideCoopDialog();
      if (lastRenderedFrame) render(lastRenderedFrame);
    });
  }

  if (scrim) {
    scrim.addEventListener("click", (e) => {
      e.stopPropagation();
    });
  }
}

function render(s) {
  // Only a confirmed run boundary changes the view. Missing readings and
  // chapter changes must not interrupt someone browsing History mid-run.
  if (Number.isInteger(s.pid) && s.pid > 0) {
    if (lastRunPid !== null && lastRunPid !== s.pid) activeRunSeen = false;
    lastRunPid = s.pid;
  }
  if (s.no_run === true || s.map_id === -1) activeRunSeen = false;
  else if (Number.isInteger(s.map_id) && s.map_id >= 0) {
    if (!activeRunSeen) setView("live");
    activeRunSeen = true;
  }
  lastRenderedFrame = s;

  // An agreement lasts for the life of the page -- once per app launch. A
  // decline covers one run only, so it clears when the co-op session ends
  // and the next co-op run asks again.
  if (s.coop === false && coopConsent === "declined") {
    coopConsent = null;
  }

  renderHead(s);
  renderDiag(s);

  // No run loaded. The reader decides this, not the renderer -- re-deriving it
  // here would put the rule in two places and let them drift. Nothing below is
  // worth painting: there is no map to name.
  if (s.no_run === true) {
    setCombatEdge(false);
    hideCoopDialog();
    ensureCurtain("Waiting for a run to start");
    document.body.classList.add("between-runs-active", "curtain-active");
    return;
  }

  const coopGated = s.coop && coopConsent !== "agreed";

  if (s.coop && coopConsent === null) {
    setCombatEdge(false);
    ensureCurtain("You're in a co-op run");
    showCoopDialog();
  } else if (s.coop && coopConsent === "declined") {
    setCombatEdge(false);
    ensureCurtain("Hidden for this run");
    hideCoopDialog();
  } else {
    hideCoopDialog();
  }

  // Painted unconditionally, including while the gate below is shut.
  // .between-runs-active only sets display:none on .kpis/.rule-seam/.body, and
  // writes to hidden elements land normally -- so opening the gate is a class
  // removal against panels that are already correct, and nothing pops in.
  renderKpis(s);
  renderShop(s);
  renderMelodies(s);
  renderTiles(s);
  refreshTip();

  // The channels answer at different times: level and combat on the first
  // poll, the questline when placement turns conclusive, melodies on a sweep
  // boundary. `ready` is the reader's single verdict that they all have.
  // map_name is one of those gated channels but usually the fastest of them
  // -- a single id read against a static table, no roster or placement wait
  // -- so it is often already known while the others are still resolving.
  if (coopGated) {
    document.body.classList.add("between-runs-active", "curtain-active");
  } else if (s.ready === true) {
    document.body.classList.remove("between-runs-active", "curtain-active");
    setCombatEdge(s.in_combat === 1);
  } else {
    setCombatEdge(false);
    ensureCurtain(s.map_name ? `Loading ${RunPresentation.stageName(s.map_name)}` : "Loading run");
    document.body.classList.add("between-runs-active", "curtain-active");
  }
}

// Keep the last good frame up; only the status pill changes. A page that
// blanked here would read as the run ending rather than the source going
// quiet. An `{"error": ...}` frame pushed over IPC lands here.
function markStale() {
  setCombatEdge(false);
  renderConnection("stale", "Waiting for the next update.");
}

function formatSidecarMessage(msg) {
  if (!msg || typeof msg !== "string") return "Waiting for Ravenswatch to start";
  let clean = msg.trim().split("\n")[0].replace(/^Error:\s*/i, "");
  if (/is not running/i.test(clean)) {
    return "Ravenswatch is not running — start the game to connect";
  }
  if (/has exited/i.test(clean)) {
    return "Ravenswatch has closed — waiting for the game to restart";
  }
  if (/more than one/i.test(clean)) {
    return "Multiple copies of Ravenswatch are running — please close extra instances";
  }
  clean = clean.replace(/\.exe\b/i, "").replace(/\s*--\s*/g, " — ");
  return clean;
}

// The sidecar process itself exited. Distinct from markStale(): that's "the
// last frame might still be right, we just can't hear it right now." This is
// "the process that would produce a frame isn't running," so the content area
// gives way to the curtain rather than leaving a stale run on screen.
//
// The curtain, not per-tile placeholders: dashing out every KPI and detail
// tile individually reads as a broken dashboard, and the tiles are hidden
// anyway. One headline, with the brand, status pill and gear still visible
// -- so this is a normal page state, not a dialog.
function renderSidecarDown(message) {
  setCombatEdge(false);
  hideCoopDialog();
  renderConnection("waiting", formatSidecarMessage(message));

  el("diag").textContent = "Disconnected — waiting for Ravenswatch";

  ensureCurtain(formatSidecarMessage(message), "");
  document.body.classList.add("between-runs-active", "curtain-active");
}

// No transport exists and none can: the preload bridge that would push frames
// isn't there. Left alone the page would sit displaying index.html's static
// markup, which looks like a healthy app still starting, so the fault would
// read as a slow start and hide.
//
// The visual language is renderSidecarDown()'s (status pill reading "not running",
// diag line), but the fault takes over the content area via the full-screen
// curtain with player-readable copy. The technical diagnosis is preserved
// in the diagnostics-only footer line, console.error, and dataset.transport = "none"
// for DOM probes. Neither the headline nor the subtitle exists in index.html,
// so seeing them on screen is proof that this fault handler ran.
function renderNoTransport() {
  setCombatEdge(false);
  hideCoopDialog();

  renderConnection("error", "Restart the app to reconnect.");

  ensureCurtain("The overlay can't start", "Restart the app. If this keeps happening, reinstall it.");
  document.body.classList.add("between-runs-active", "curtain-active");

  el("diag").textContent =
    "no transport — the preload bridge is absent, so the app cannot receive "
    + "frames. Restart it; if this persists, preload.js failed to load.";

  // Machine-readable twin of the above, so a DOM probe can assert the fault
  // without string-matching rendered copy. Nothing else ever sets it.
  document.body.dataset.transport = "none";
  console.error(
    "ravenswatch: no transport. window.ravenswatch.onState is absent, so no "
    + "frames can arrive."
  );
}

// — run history —
//
// The list arrives whole over readout:history on every page load and after
// each finished run. Stored values are raw (seconds, codes, internal hero
// names); everything below turns them into words at display time, so a
// wording change never needs the file rewritten.

let historyRuns = [];
let selectingHistory = false;
const selectedHistory = new Set();
let historyDelete = null;
let historyDeleteBusy = false;
let historyDeleteFocus = null;
let historySkipped = 0;
let view = "history";
let activeRunSeen = false;
let lastRunPid = null;
const expandedRuns = new Set();
const runDetailTabs = new Map();

const DIFFICULTY_NAMES = { 0: "Adventure", 1: "Twilight", 2: "Darkness", 3: "Nightmare" };
const CHAPTER_ROMAN = ["I", "II", "III"];
const RARITY_CLASS = { 0: "common", 1: "rare", 2: "epic", 3: "legendary", 4: "ultimate" };

// Statistics rows in the game's order and the game's words.
const RUN_STAT_GROUPS = [
  ["Damage", "damage", [
    ["total", "Damage dealt"], ["dash", "From dash"], ["trait", "From trait"],
    ["attack", "From attack"], ["power", "From power"], ["special", "From special"],
    ["defense", "From defense"], ["ultimate", "From ultimate"], ["other", "Other sources"],
    ["highest", "Highest single damage"],
  ]],
  ["Support", "support", [
    ["self_heal", "Self healing"], ["ally_heal", "Healing to allies"],
    ["self_shield", "Self shield"], ["ally_shield", "Shield to allies"],
    ["blocked", "Damage blocked"], ["revive_assists", "Revive assists"],
  ]],
  ["Sufferings", "sufferings", [
    ["taken", "Damage taken"], ["deaths_doors", "Death's doors"],
    ["feathers", "Raven feathers consumed"],
  ]],
  ["Resources", "resources", [
    ["shards_amassed", "Dream shards amassed"], ["shards_spent", "Dream shards spent"],
    ["stars_of_fate", "Stars of fate used"], ["objects_collected", "Magical objects collected"],
  ]],
];

// Hero codes whose display name differs. Scarlet's definition is Red_Update6
// and her skins are Hero_Red_*, seen on a live run; every other code shown so
// far is the hero's name.
const HERO_NAMES = { Red: "Scarlet" };

/** Heroes\Juliet_Update6.herodef.ot -> "Juliet"; falls back to the skin name. */
function heroCodeForRun(run) { return RunPresentation.heroCode(run); }
function heroName(run) { return RunPresentation.heroName(run); }

function difficultyName(d) {
  if (typeof d !== "number") return DASH;
  return DIFFICULTY_NAMES[d] || `Difficulty ${d}`;
}

function formatPlaytime(seconds) {
  if (typeof seconds !== "number" || !(seconds >= 0)) return DASH;
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function formatWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return DASH;
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${date} · ${time}`;
}

// The statistics page rounds down: 61.73 shows as 61.
function formatStat(v) {
  return typeof v === "number" && Number.isFinite(v) ? Math.floor(v).toLocaleString("en-US") : DASH;
}

function where(run) {
  const bits = [];
  if (run.map_name) bits.push(RunPresentation.stageName(run.map_name));
  if (typeof run.chapter === "number" && CHAPTER_ROMAN[run.chapter]) bits.push(`Chapter ${CHAPTER_ROMAN[run.chapter]}`);
  return bits.join(" · ");
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function rarityClass(t) {
  return `talent-${RARITY_CLASS[t.rarity_code] || "unknown"}`;
}

function talentArt(t, run) {
  const asset = (TALENT_ICONS[heroCodeForRun(run)] || {})[t.key];
  if (!asset) return null;
  const art = make("span", "talent-icon");
  art.setAttribute("aria-hidden", "true");
  icon(art, asset);
  return art;
}

// The game has already resolved placeholders, percentages and current damage.
// Remove only paired game markup; textContent keeps stored text inert.
function cleanGameDescription(text) {
  return String(text || "").replace(/#([^@]*)@/g, (_, value) => value.replace(/#/g, "").trim()).replace(/&([^~]*)~/g, "$1").replace(/\$([^*]*)\*/g, "$1").trim();
}

function talentChip(t, run, focusable = false) {
  const chip = make("span", t ? `talent ${rarityClass(t)}` : "talent-slot-empty");
  chip.classList.add("talent-slot");
  if (!t) {
    chip.setAttribute("aria-hidden", "true");
    return chip;
  }
  const art = talentArt(t, run) || make("span", "talent-icon");
  if (!art.style.backgroundImage) icon(art, "icon_question.png");
  chip.append(art);
  chip.setAttribute("aria-label", [t.name, t.rarity].filter(Boolean).join(" · "));
  const description = cleanGameDescription(t.description);
  setTip(chip, t.name, description || "Effect description wasn't recorded for this run.");
  chip.dataset.tipKind = "talent";
  chip.dataset.tipIcon = (TALENT_ICONS[heroCodeForRun(run)] || {})[t.key] || "icon_question.png";
  chip.dataset.tipMeta = t.rarity || "";
  chip.dataset.tipRarity = RARITY_CLASS[t.rarity_code] || "unknown";
  if (focusable) chip.tabIndex = 0;
  return chip;
}

function runCard(run) {
  const victory = run.result === "victory";
  const open = expandedRuns.has(run.id);
  const article = make("article", `run ${victory ? "run-victory" : "run-defeat"}`);
  article.dataset.runId = String(run.id);

  const card = make("button", "run-card");
  card.type = "button";
  card.setAttribute("aria-expanded", String(open));

  const name = heroName(run);
  const level = typeof run.level === "number" ? `Level ${Math.floor(run.level)}` : "";
  const portraitAsset = HERO_ICONS[heroCodeForRun(run)];
  const hero = make("div", "run-hero");
  const portrait = make("div", "run-portrait");
  icon(portrait, portraitAsset || "icon_question.png");
  portrait.setAttribute("aria-hidden", "true");
  hero.setAttribute("aria-label", [name, level].filter(Boolean).join(" · "));
  setTip(hero, name, [level, where(run)].filter(Boolean).join("\n"));
  hero.append(portrait);

  const result = make("div", "run-result");
  result.append(
    make("div", "run-outcome", victory ? "Victory" : "Defeat"),
    make("div", "run-map", where(run)),
    make("div", "run-when", formatWhen(run.ended)),
    make("div", "run-time", formatPlaytime(run.playtime_s)),
  );

  const difficulty = make("div", "run-difficulty");
  const difficultyArt = make("span", "run-difficulty-icon");
  difficultyArt.setAttribute("aria-hidden", "true");
  icon(difficultyArt, DIFFICULTY_ICONS[run.difficulty] || "icon_question.png");
  difficulty.append(difficultyArt);
  difficulty.setAttribute("aria-label", difficultyName(run.difficulty));
  setTip(difficulty, difficultyName(run.difficulty), "Difficulty");

  const score = make("div", "run-score");
  const scoreValue = run.score && typeof run.score.total === "number"
    ? run.score.total.toLocaleString("en-US") : DASH;
  score.append(make("div", "run-score-value", scoreValue));
  setTip(score, "Score", scoreValue === DASH ? "Score wasn't recorded for this run." : scoreValue);

  const talents = make("div", "run-talents");
  const selected = Array.isArray(run.talents) ? run.talents : [];
  talents.setAttribute("aria-label", "Talents");
  for (let i = 0; i < 10; i++) talents.append(talentChip(selected[i], run));
  if (!selected.length) setTip(talents, "Talents",
    Array.isArray(run.talents) ? "No talents taken." : "Talents weren't recorded for this run.");
  card.setAttribute("aria-label", [victory ? "Victory" : "Defeat", name,
    difficultyName(run.difficulty), level, `Score ${scoreValue}`, formatPlaytime(run.playtime_s)].filter(Boolean).join(" · "));

  const chevron = make("div", "run-chevron");
  chevron.setAttribute("aria-hidden", "true");
  chevron.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"'
    + ' stroke-linecap="square"><path d="M6 9l6 6 6-6"></path></svg>';

  card.append(hero, result, difficulty, score, talents, chevron);
  if (selectingHistory) {
    const label = make("label", "run-selection");
    const checkbox = make("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedHistory.has(run.id);
    checkbox.setAttribute("aria-label", `Select ${heroName(run)} · ${formatWhen(run.ended)}`);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedHistory.add(run.id); else selectedHistory.delete(run.id);
      renderHistoryToolbar();
    });
    label.append(checkbox);
    article.append(label);
  }
  article.append(card);

  const detail = runDetail(run);
  detail.hidden = !open;
  article.append(detail);
  article.classList.toggle("run-open", open);

  card.addEventListener("click", () => {
    const nowOpen = !expandedRuns.has(run.id);
    if (nowOpen) expandedRuns.add(run.id); else expandedRuns.delete(run.id);
    card.setAttribute("aria-expanded", String(nowOpen));
    detail.hidden = !nowOpen;
    article.classList.toggle("run-open", nowOpen);
  });
  return article;
}

function statBlock(title, rows) {
  const block = make("div", "run-block");
  if (title) block.append(make("div", "kicker", title));
  const list = make("dl", "run-rows");
  for (const [label, value] of rows) {
    const row = make("div", "run-row");
    row.append(make("dt", "", label), make("dd", "", value));
    list.append(row);
  }
  block.append(list);
  return block;
}

function runObjects(run) {
  const block = make("div", "run-block run-objects-block");
  block.append(make("div", "kicker", "Magical objects"));
  if (!Array.isArray(run.objects) || !run.objects.length) {
    block.append(make("div", "run-none", Array.isArray(run.objects)
      ? "No magical objects." : "Objects weren't recorded for this run."));
    return block;
  }
  const counts = Array.isArray(run.object_counts) && run.object_counts.length === run.objects.length
    ? run.object_counts : null;
  const rarityClasses = { Common: "common", Rare: "rare", Epic: "epic", Legendary: "legendary", Cursed: "cursed" };
  const list = make("ul", "run-objects");
  run.objects.forEach((guid, i) => {
    const key = typeof guid === "string" ? OBJECT_KEYS[guid] : null;
    const name = key && ITEM_NAMES[key];
    const rarity = OBJECT_RARITIES[guid];
    const count = counts && Number.isInteger(counts[i]) && counts[i] >= 0 && counts[i] <= 65535 ? counts[i] : null;
    const row = make("li", `run-object object-${rarityClasses[rarity] || "unknown"}`);
    row.tabIndex = 0;
    row.setAttribute("aria-label", `${name || "Unknown object"}, ${count === null ? "quantity unavailable" : `quantity ${count}`}`);
    const frame = make("div", "run-object-frame");
    const art = make("div", "run-object-icon");
    art.setAttribute("aria-hidden", "true");
    icon(art, shopIconFor(name));
    frame.append(art);
    row.append(frame);
    if (count !== 1) {
      const quantity = make("span", "run-object-count", count === null ? "?" : String(count));
      quantity.setAttribute("aria-label", count === null ? "Quantity unavailable" : `Quantity ${count}`);
      row.append(quantity);
    }
    setTip(row, name || "Unknown object", [rarity, key && ITEM_TEXT[key],
      count === null ? "Quantity wasn't recorded for this run." : `Quantity: ${count}`,
    ].filter(Boolean).join("\n"));
    list.append(row);
  });
  block.append(list);
  if (!counts) block.append(make("div", "run-none", "Quantities weren't recorded for this run."));
  return block;
}

function runMelodies(run) {
  const block = make("div", "run-block run-melodies-block");
  block.append(make("div", "kicker", "Melodies"));
  if (!Array.isArray(run.melodies)) {
    block.append(make("div", "run-none", "Melodies weren't recorded for this run."));
    return block;
  }
  if (!run.melodies.length) {
    block.append(make("div", "run-none", "No melodies."));
    return block;
  }
  const list = make("ul", "run-melodies");
  for (const m of run.melodies) {
    const state = ["locked", "active", "completed"].includes(m.state) ? m.state : null;
    const row = make("li", `run-melody melody-${state || "unknown"}`);
    row.tabIndex = 0;
    const required = Number.isInteger(m.notes) && m.notes > 0 ? m.notes : null;
    const earned = Number.isInteger(m.notes_earned) && m.notes_earned >= 0 && required !== null && m.notes_earned <= required ? m.notes_earned : null;
    const progress = state === "active" ? `${earned === null ? DASH : earned}/${required === null ? DASH : required} notes` : state === "completed" ? "Completed" : null;
    row.setAttribute("aria-label", `${m.name}, ${progress || state || "state unavailable"}`);
    const art = make("div", "run-object-icon");
    art.setAttribute("aria-hidden", "true");
    const unavailable = state === "locked" || !state;
    icon(art, unavailable ? "UI_Melody_Icon_Locked.png" : m.icon, unavailable);
    row.append(art);
    if (progress) row.append(make("span", "run-melody-progress", progress));
    setTip(row, m.name, [progress || state || "State wasn't recorded.", m.effect].filter(Boolean).join("\n"));
    list.append(row);
  }
  block.append(list);
  return block;
}

function runHeroDetails(run) {
  const pane = make("div", "run-hero-details");
  const overview = make("div", "run-hero-overview");
  const portrait = make("div", "run-detail-portrait");
  icon(portrait, HERO_ICONS[heroCodeForRun(run)] || "icon_question.png");
  portrait.setAttribute("aria-label", heroName(run));
  setTip(portrait, heroName(run), where(run));
  overview.append(portrait, statBlock("Run", [
    ["Difficulty", difficultyName(run.difficulty)], ["Reached", where(run) || DASH],
    ["Time", formatPlaytime(run.playtime_s)],
    ["Level reached", typeof run.level === "number" ? run.level.toFixed(2) : DASH],
  ]));
  const attributes = make("div", "run-block run-attributes");
  attributes.append(make("div", "kicker", "Hero attributes"));
  if (run.hero_stats && typeof run.hero_stats === "object") {
    const stats = make("ul", "run-attribute-stats");
    for (const [label, key] of [["Vitality", "vitality"], ["Damage", "damage"], ["Armor", "armor"],
      ["Critical chance", "crit_chance"], ["Critical damage", "crit_damage"]]) {
      const value = formatStat(run.hero_stats[key]);
      const stat = make("li", "run-attribute");
      stat.tabIndex = 0;
      stat.setAttribute("aria-label", `${label}: ${value}`);
      const art = make("span", `run-attribute-icon attribute-${key}`);
      art.setAttribute("aria-hidden", "true");
      icon(art, `stat_${key}.png`);
      stat.append(art, make("span", "run-attribute-value", value));
      setTip(stat, label, value);
      stats.append(stat);
    }
    attributes.append(stats);
  } else attributes.append(make("div", "run-none", "Hero attributes weren't recorded for this run."));
  const talents = make("div", "run-block run-detail-talents");
  talents.append(make("div", "kicker", "Talents"));
  const list = make("div", "run-talent-build");
  const selected = Array.isArray(run.talents) ? run.talents : [];
  for (let i = 0; i < 10; i++) list.append(talentChip(selected[i], run, true));
  talents.append(list);
  if (!selected.length) talents.append(make("div", "run-none", Array.isArray(run.talents) ? "No talents taken." : "Talents weren't recorded for this run."));
  pane.append(overview, attributes, talents);
  return pane;
}

// These entries match the game's score page art. The Blood Ritual icon is
// still named KeyKeeper in the resources (crossed swords in the score page).
const SCORE_ACTIVITY_ICONS = {
  "victory": "score_victory.png", "multiplayer": "score_multiplayer.png",
  "grimoire": "score_grimoire.png", "side quest": "score_mission.png",
  "cursed room": "score_cursed_room.png", "leprechaun's cauldron": "score_cauldron.png",
  "altar of heroes": "map_altar.png", "blood ritual": "score_keykeeper.png",
  "wishing well": "map_wishing_well.png", "stingy jack": "score_stingy_jack.png",
  "optional boss": "score_boss.png", "early awakening of the boss": "score_early_boss.png",
};
function scoreIconForLine(line, run) {
  const label = line.split(":", 1)[0].trim().toLowerCase().replace(/’/g, "'").replace(/\s+/g, " ");
  if (label === "base score") return DIFFICULTY_ICONS[run.difficulty] || "icon_question.png";
  if (label === "level") return "score_level.png";
  return SCORE_ACTIVITY_ICONS[label] || "icon_question.png";
}

function runScoreDetails(run) {
  const block = make("div", "run-block run-score-details");
  const total = run.score && typeof run.score.total === "number" ? run.score.total.toLocaleString("en-US") : DASH;
  block.append(make("div", "kicker", "Score"), make("div", "run-detail-total", total));
  if (run.score && Array.isArray(run.score.details)) {
    const list = make("ul", "run-score-icons");
    for (const saved of run.score.details) {
      const line = String(saved);
      const entry = make("li", "run-score-entry");
      entry.tabIndex = 0;
      entry.setAttribute("aria-label", line);
      const art = make("span", "run-score-icon");
      art.setAttribute("aria-hidden", "true");
      icon(art, scoreIconForLine(line, run));
      entry.append(art);
      setTip(entry, line);
      list.append(entry);
    }
    block.append(list);
  } else block.append(make("div", "run-none", "The score wasn't recorded for this run."));
  return block;
}

function runDamageDetails(run) {
  const damage = run.damage || {};
  const known = n => typeof n === "number" && Number.isFinite(n) && n >= 0;
  const total = damage.total;
  const block = make("div", "run-block run-damage-details");
  block.append(make("div", "kicker", "Damage dealt"), make("div", "run-detail-total", formatStat(total)));
  const list = make("dl", "run-damage-rows");
  for (const [field, label] of RUN_STAT_GROUPS[0][2].slice(1, -1)) {
    const amount = damage[field];
    const ratio = known(amount) && known(total) ? (total > 0 ? amount / total : amount === 0 ? 0 : null) : null;
    const row = make("div", "run-damage-row");
    const track = make("div", "run-damage-track");
    track.setAttribute("aria-hidden", "true");
    const fill = make("div", "run-damage-fill");
    fill.style.width = `${ratio === null ? 0 : Math.min(100, Math.max(0, ratio * 100))}%`;
    track.append(fill);
    const value = make("dd", "run-damage-value");
    value.append(make("span", "", formatStat(amount)), make("span", "run-damage-percent", ratio === null ? DASH : `${Math.floor(ratio * 100)}%`));
    row.append(make("dt", "", label), track, value);
    list.append(row);
  }
  block.append(list, statBlock("", [["Highest single damage", formatStat(damage.highest)]]));
  return block;
}

function runDetail(run) {
  const detail = make("div", "run-detail");
  const inventory = make("div", "run-inventory");
  inventory.append(runMelodies(run), runObjects(run));
  const entries = [
    ["hero", "Hero Details", runHeroDetails(run)],
    ["score", "Score Details", runScoreDetails(run)],
    ["inventory", "Melodies and Magical Objects", inventory],
    ["damage", "Damage Dealt", runDamageDetails(run)],
    ...RUN_STAT_GROUPS.slice(1).map(([title, key, rows]) => {
      const group = run[key] && typeof run[key] === "object" ? run[key] : {};
      return [key, title, statBlock(title, rows.map(([field, label]) => [label, formatStat(group[field])]))];
    }),
  ];
  const tabs = make("div", "run-detail-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Run details");
  const panels = make("div", "run-detail-panels");
  const buttons = [], pages = [];
  const prefix = `run-${String(run.id).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  entries.forEach(([key, label, content]) => {
    const tab = make("button", "run-detail-tab", key === "hero" ? undefined : label);
    tab.type = "button";
    tab.id = `${prefix}-tab-${key}`;
    tab.dataset.tab = key;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-label", label);
    tab.setAttribute("aria-controls", `${prefix}-panel-${key}`);
    if (key === "hero") {
      const art = make("span", "run-tab-portrait");
      icon(art, HERO_ICONS[heroCodeForRun(run)] || "icon_question.png");
      art.setAttribute("aria-hidden", "true");
      tab.append(art);
      setTip(tab, label, heroName(run));
    }
    const panel = make("section", `run-detail-panel run-panel-${key}`);
    panel.id = `${prefix}-panel-${key}`;
    panel.dataset.panel = key;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tab.id);
    panel.tabIndex = 0;
    panel.append(content);
    buttons.push(tab); pages.push(panel);
    tabs.append(tab); panels.append(panel);
  });
  const select = (index, focus = false) => {
    buttons.forEach((button, i) => {
      const selected = i === index;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      pages[i].hidden = !selected;
    });
    runDetailTabs.set(run.id, entries[index][0]);
    hideTip();
    if (focus) buttons[index].focus();
  };
  buttons.forEach((button, i) => {
    button.addEventListener("click", () => select(i));
    button.addEventListener("keydown", event => {
      let next;
      if (event.key === "ArrowRight") next = (i + 1) % buttons.length;
      else if (event.key === "ArrowLeft") next = (i + buttons.length - 1) % buttons.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = buttons.length - 1;
      else return;
      event.preventDefault(); select(next, true);
    });
  });
  const active = entries.findIndex(([key]) => key === runDetailTabs.get(run.id));
  select(active < 0 ? 0 : active);
  const actions = make("div", "run-detail-actions");
  const share = make("button", "history-action run-share", "Share Run");
  share.type = "button";
  share.dataset.runId = String(run.id);
  share.disabled = shareBusy || typeof window.ravenswatch?.shareRun !== "function";
  share.addEventListener("click", () => shareRun(run.id));
  const status = make("span", "run-share-status");
  status.setAttribute("role", "status");
  status.textContent = shareStatuses.get(run.id) || "";
  actions.append(status, share);
  detail.append(tabs, panels, actions);
  return detail;
}

function renderHistory() {
  const host = el("history-list");
  if (!host) return;
  host.textContent = "";
  renderHistoryToolbar();
  const runs = historyRuns.slice().sort((a, b) => b.id - a.id);
  if (!runs.length) {
    const empty = make("div", "history-empty");
    empty.append(make("div", "history-empty-headline", "No runs yet"),
      make("div", "history-empty-sub", "Finish a run and it shows up here."));
    host.append(empty);
    return;
  }
  for (const run of runs) host.append(runCard(run));
}

function applyHistory(h) {
  historyRuns = h && Array.isArray(h.runs) ? h.runs : [];
  historySkipped = h && typeof h.skipped === "number" ? h.skipped : 0;
  const ids = new Set(historyRuns.map(run => run.id));
  for (const id of selectedHistory) if (!ids.has(id)) selectedHistory.delete(id);
  for (const id of expandedRuns) if (!ids.has(id)) expandedRuns.delete(id);
  for (const id of runDetailTabs.keys()) if (!ids.has(id)) runDetailTabs.delete(id);
  renderHistory();
  if (lastRenderedFrame) renderDiag(lastRenderedFrame);
}

function setView(next) {
  view = next === "history" ? "history" : "live";
  const history = view === "history";
  document.body.classList.toggle("view-history", history);
  el("history").hidden = !history;
  el("tab-live").setAttribute("aria-selected", String(!history));
  el("tab-history").setAttribute("aria-selected", String(history));
  hideTip();
}

let shareBusy = false;
const shareStatuses = new Map();
function refreshShareButtons() {
  for (const button of document.querySelectorAll(".run-share")) {
    button.disabled = shareBusy || typeof window.ravenswatch?.shareRun !== "function";
    button.textContent = shareBusy && Number(button.dataset.runId) === sharingRunId ? "Copying…" : "Share Run";
    button.previousElementSibling.textContent = shareStatuses.get(Number(button.dataset.runId)) || "";
  }
}
let sharingRunId = null;
async function shareRun(id) {
  if (shareBusy || typeof window.ravenswatch?.shareRun !== "function") return;
  shareBusy = true; sharingRunId = id; shareStatuses.set(id, ""); refreshShareButtons();
  try {
    const result = await window.ravenswatch.shareRun({runId:id,stylizedFonts:document.body.classList.contains("stylized-fonts")});
    if (!result.ok) throw new Error(result.error || "Could not copy this run.");
    shareStatuses.set(id, "Copied to clipboard");
  } catch (error) { shareStatuses.set(id, error.message || "Could not copy this run."); }
  finally { shareBusy = false; sharingRunId = null; refreshShareButtons(); }
}

function canDeleteHistory() {
  const bridge = window.ravenswatch;
  return !!bridge && ["prepareHistoryDeletion", "confirmHistoryDeletion", "cancelHistoryDeletion"].every(key => typeof bridge[key] === "function");
}

function renderHistoryToolbar() {
  el("history").classList.toggle("history-selecting", selectingHistory);
  const available = canDeleteHistory() && historyRuns.length > 0;
  el("history-select").hidden = selectingHistory;
  el("history-select").disabled = !available;
  el("history-delete-all").disabled = !available;
  el("history-select-all-label").hidden = !selectingHistory;
  el("history-selection-cancel").hidden = !selectingHistory;
  const remove = el("history-delete-selected");
  remove.hidden = !selectingHistory;
  remove.disabled = !available || !selectedHistory.size;
  remove.textContent = `Delete selected (${selectedHistory.size})`;
  const all = el("history-select-all");
  all.disabled = !available;
  all.checked = historyRuns.length > 0 && selectedHistory.size === historyRuns.length;
  all.indeterminate = selectedHistory.size > 0 && !all.checked;
}

function renderHistoryDeletion() {
  const state = historyDelete;
  if (!state) return;
  const count = state.ids.length;
  const wholeFile = state.scope === "all";
  const final = state.step === state.steps;
  const phrase = state.steps === 3 && state.step === 2;
  el("history-delete-step").textContent = `Confirmation ${state.step} of ${state.steps}`;
  el("history-delete-title").textContent = wholeFile ? "Delete all history?" : `Delete ${count === 1 ? "this run" : `${count} runs`}?`;
  el("history-delete-description").textContent = final
    ? "This is the final confirmation. Deletion is permanent and cannot be undone."
    : wholeFile
      ? "Review all saved runs below. This removes the SQLite history file. New runs will start a fresh history."
      : "Review the selected runs below. Their saved statistics, talents, objects and melodies will be permanently removed.";
  const review = el("history-delete-review");
  review.textContent = "";
  for (const id of state.ids) {
    const run = historyRuns.find(run => run.id === id);
    review.append(make("li", "", run ? `${heroName(run)} · ${formatWhen(run.ended)} · ${run.result === "victory" ? "Victory" : "Defeat"} · ID ${id}` : `Run ID ${id}`));
  }
  el("history-delete-phrase").hidden = !phrase;
  el("history-delete-prompt").textContent = `Type DELETE ${count} to confirm the number of records.`;
  const confirm = el("history-delete-confirm");
  confirm.textContent = historyDeleteBusy ? "Please wait…" : final ? "Permanently delete" : phrase ? "Confirm record count" : "Confirm selection";
  confirm.disabled = historyDeleteBusy || (phrase && el("history-delete-input").value !== `DELETE ${count}`);
  el("history-delete-cancel").disabled = historyDeleteBusy;
  el("history-delete-input").disabled = historyDeleteBusy;
}

async function beginHistoryDeletion(scope, ids) {
  if (!canDeleteHistory() || historyDeleteBusy || el("history-delete-dialog").open) return;
  historyDeleteFocus = document.activeElement;
  historyDeleteBusy = true;
  historyDelete = { scope, ids: ids || historyRuns.map(run => run.id), step: 1, steps: scope === "single" ? 2 : 3 };
  el("history-delete-error").textContent = "";
  el("history-delete-input").value = "";
  hideTip();
  renderHistoryDeletion();
  el("history-delete-dialog").showModal();
  try {
    const result = await window.ravenswatch.prepareHistoryDeletion(scope === "all" ? { scope } : { scope, ids });
    if (!result.ok) throw new Error(result.error);
    historyDelete = result;
  } catch (error) {
    historyDelete = null;
    el("history-delete-error").textContent = error.message || "Could not prepare deletion.";
  } finally {
    historyDeleteBusy = false;
    renderHistoryDeletion();
    el("history-delete-cancel").disabled = false;
    if (!historyDelete) el("history-delete-confirm").disabled = true;
    el("history-delete-cancel").focus();
  }
}

async function confirmHistoryDeletion() {
  if (!historyDelete?.token || historyDeleteBusy) return;
  historyDeleteBusy = true;
  el("history-delete-error").textContent = "";
  renderHistoryDeletion();
  try {
    const result = await window.ravenswatch.confirmHistoryDeletion({ token: historyDelete.token, typed: el("history-delete-input").value });
    if (!result.ok) throw new Error(result.error);
    if (result.done) {
      historyDelete = null;
      selectingHistory = false;
      selectedHistory.clear();
      renderHistory();
      el("history-delete-dialog").close();
      el("history-select").focus();
    } else {
      historyDelete.step = result.step;
      el("history-delete-input").value = "";
    }
  } catch (error) {
    // A failed commit consumes its token; require a new review before retrying.
    const token = historyDelete?.token;
    historyDelete = null;
    if (token) window.ravenswatch.cancelHistoryDeletion(token).catch(() => {});
    el("history-delete-error").textContent = error.message || "History could not be deleted.";
    el("history-delete-confirm").disabled = true;
  } finally {
    historyDeleteBusy = false;
    renderHistoryDeletion();
    el("history-delete-cancel").disabled = false;
    if (el("history-delete-dialog").open) {
      (historyDelete?.steps === 3 && historyDelete.step === 2 ? el("history-delete-input") : el("history-delete-cancel")).focus();
    }
  }
}

function cancelHistoryDeletion() {
  if (historyDeleteBusy) return;
  const token = historyDelete?.token;
  historyDelete = null;
  if (token) window.ravenswatch.cancelHistoryDeletion(token).catch(() => {});
  el("history-delete-dialog").close();
  (historyDeleteFocus?.isConnected ? historyDeleteFocus : el("history-select")).focus();
}

function initHistoryDeletion() {
  el("history-select").addEventListener("click", () => { selectingHistory = true; renderHistory(); });
  el("history-selection-cancel").addEventListener("click", () => { selectingHistory = false; selectedHistory.clear(); renderHistory(); });
  el("history-select-all").addEventListener("change", event => {
    selectedHistory.clear();
    if (event.target.checked) for (const run of historyRuns) selectedHistory.add(run.id);
    renderHistory();
  });
  el("history-delete-selected").addEventListener("click", () => beginHistoryDeletion(selectedHistory.size === 1 ? "single" : "selected", [...selectedHistory]));
  el("history-delete-all").addEventListener("click", () => beginHistoryDeletion("all"));
  el("history-delete-cancel").addEventListener("click", cancelHistoryDeletion);
  el("history-delete-confirm").addEventListener("click", confirmHistoryDeletion);
  el("history-delete-input").addEventListener("input", renderHistoryDeletion);
  el("history-delete-dialog").addEventListener("cancel", event => { event.preventDefault(); cancelHistoryDeletion(); });
  el("history-delete-dialog").addEventListener("click", event => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) cancelHistoryDeletion();
  });
}

function initHistory() {
  el("tab-live").addEventListener("click", () => setView("live"));
  el("tab-history").addEventListener("click", () => setView("history"));
  renderHistory();
  setView("history");
}

// State is pushed over IPC from the sidecar; the page never touches the
// network. Without the bridge there is no other source -- that is only
// ever a fault, and it gets its own screen; see renderNoTransport().
initTip();
initTileDone();
initSettings();
initCoopConsent();
initUpdateBar();
initHistoryDeletion();
initHistory();

if (ELECTRON_TRANSPORT) {
  window.ravenswatch.onState((frame) => {
    if (frame.error) {
      markStale();
      return;
    }
    render(frame);
  });
  if (typeof window.ravenswatch.onSidecarDown === "function") {
    window.ravenswatch.onSidecarDown(({ message }) => {
      renderSidecarDown(message);
    });
  }
  if (typeof window.ravenswatch.onAssets === "function") {
    window.ravenswatch.onAssets(applyAssets);
  }
  if (typeof window.ravenswatch.onUpdate === "function") {
    window.ravenswatch.onUpdate(applyUpdate);
  }
  if (typeof window.ravenswatch.onHistory === "function") {
    window.ravenswatch.onHistory(applyHistory);
  }
} else {
  renderNoTransport();
}
