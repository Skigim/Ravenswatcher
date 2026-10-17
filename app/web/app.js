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

function applyAssets(tables) {
  ITEM_TEXT = (tables && tables.ITEM_TEXT) || {};
  SHOP_ICONS = (tables && tables.SHOP_ICONS) || {};
  if (lastRenderedFrame) render(lastRenderedFrame);
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
  tipEl.style.top = top + "px";
}

function showTip(target) {
  tipAnchor = target;
  el("tip-name").textContent = target.dataset.tipName;
  el("tip-body").textContent = target.dataset.tipBody || "";
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

function renderHead(s) {
  const host = el("head-right");
  if (host.dataset.mode !== "live") {
    host.dataset.mode = "live";
    host.innerHTML = '<div class="status"><span class="status-dot"></span><span></span></div>';
  }
  const pill = host.firstElementChild;
  // "Live" means the sweep has resolved something this run, not merely that
  // the process opened -- an attached handle with nothing resolved is still
  // the first sweep landing.
  const live = s.found > 0;
  pill.classList.toggle("status-live", live);
  pill.lastElementChild.textContent = live ? "live" : "loading";
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
    ensureCurtain(s.map_name ? `Loading ${s.map_name}` : "Loading run");
    document.body.classList.add("between-runs-active", "curtain-active");
  }
}

// Keep the last good frame up; only the status pill changes. A page that
// blanked here would read as the run ending rather than the source going
// quiet. An `{"error": ...}` frame pushed over IPC lands here.
function markStale() {
  setCombatEdge(false);
  const host = el("head-right");
  if (host.dataset.mode === "live") {
    const pill = host.firstElementChild;
    pill.classList.remove("status-live");
    pill.lastElementChild.textContent = "no response";
  }
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
  const host = el("head-right");
  if (host.dataset.mode !== "live") {
    host.dataset.mode = "live";
    host.innerHTML = '<div class="status"><span class="status-dot"></span><span></span></div>';
  }
  const pill = host.firstElementChild;
  pill.className = "status";
  pill.lastElementChild.textContent = "not running";

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

  const host = el("head-right");
  if (host.dataset.mode !== "live") {
    host.dataset.mode = "live";
    host.innerHTML = '<div class="status"><span class="status-dot"></span><span></span></div>';
  }
  const pill = host.firstElementChild;
  pill.className = "status";
  pill.lastElementChild.textContent = "not running";

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
let historySkipped = 0;
let view = "live";
const expandedRuns = new Set();

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

/** Heroes\Juliet_Update6.herodef.ot -> "Juliet"; falls back to the skin name. */
function heroName(run) {
  const def = typeof run.hero_definition === "string" ? run.hero_definition : "";
  let code = (def.split(/[\\/]/).pop() || "").replace(/\.herodef\.ot$/i, "").replace(/_Update\d+$/i, "");
  if (!code && typeof run.hero === "string") code = run.hero.replace(/^Hero_/, "").split("_")[0];
  return code ? code.replace(/_/g, " ") : "Unknown hero";
}

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
  if (run.map_name) bits.push(run.map_name);
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

function talentChip(t) {
  const chip = make("span", `talent ${rarityClass(t)}`, t.name);
  setTip(chip, t.name, t.rarity || "");
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

  const result = make("div", "run-result");
  result.append(
    make("div", "run-outcome", victory ? "Victory" : "Defeat"),
    make("div", "run-difficulty", difficultyName(run.difficulty)),
    make("div", "run-when", formatWhen(run.ended)),
    make("div", "run-time", formatPlaytime(run.playtime_s)),
  );

  const hero = make("div", "run-hero");
  const name = heroName(run);
  const portrait = make("div", "run-portrait", name.charAt(0));
  portrait.setAttribute("aria-hidden", "true");
  const heroText = make("div", "run-hero-text");
  const level = typeof run.level === "number" ? `Level ${Math.floor(run.level)}` : "";
  heroText.append(
    make("div", "run-hero-name", name),
    make("div", "run-sub", [level, where(run)].filter(Boolean).join(" · ")),
  );
  hero.append(portrait, heroText);

  const score = make("div", "run-score");
  score.append(
    make("div", "run-score-value", run.score && typeof run.score.total === "number"
      ? run.score.total.toLocaleString("en-US") : DASH),
    make("div", "kicker", "Score"),
  );

  const talents = make("div", "run-talents");
  if (Array.isArray(run.talents) && run.talents.length) {
    for (const t of run.talents) talents.append(talentChip(t));
  } else {
    talents.append(make("span", "run-none", Array.isArray(run.talents) ? "No talents" : "Talents unavailable"));
  }

  const chevron = make("div", "run-chevron");
  chevron.setAttribute("aria-hidden", "true");
  chevron.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"'
    + ' stroke-linecap="square"><path d="M6 9l6 6 6-6"></path></svg>';

  card.append(result, hero, score, talents, chevron);
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
  block.append(make("div", "kicker", title));
  const list = make("dl", "run-rows");
  for (const [label, value] of rows) {
    const row = make("div", "run-row");
    row.append(make("dt", "", label), make("dd", "", value));
    list.append(row);
  }
  block.append(list);
  return block;
}

function runDetail(run) {
  const detail = make("div", "run-detail");

  const scoreBlock = make("div", "run-block");
  scoreBlock.append(make("div", "kicker", "Score"));
  if (run.score && Array.isArray(run.score.details)) {
    const list = make("ul", "run-lines");
    for (const line of run.score.details) list.append(make("li", "", line));
    list.append(make("li", "run-line-total", `Total ${run.score.total.toLocaleString("en-US")}`));
    scoreBlock.append(list);
  } else {
    scoreBlock.append(make("div", "run-none", "The score wasn't recorded for this run."));
  }

  const buildBlock = make("div", "run-block");
  buildBlock.append(make("div", "kicker", "Talents"));
  if (Array.isArray(run.talents) && run.talents.length) {
    const list = make("ul", "run-lines");
    for (const t of run.talents) {
      const li = make("li", `talent-line ${rarityClass(t)}`);
      li.append(make("span", "talent-line-name", t.name), make("span", "talent-line-rarity", t.rarity || DASH));
      list.append(li);
    }
    buildBlock.append(list);
  } else {
    buildBlock.append(make("div", "run-none",
      Array.isArray(run.talents) ? "No talents taken." : "Talents weren't recorded for this run."));
  }

  const runRows = [
    ["Hero", heroName(run)],
    ["Difficulty", difficultyName(run.difficulty)],
    ["Reached", where(run) || DASH],
    ["Time", formatPlaytime(run.playtime_s)],
    ["Level reached", typeof run.level === "number" ? run.level.toFixed(2) : DASH],
  ];

  const columns = make("div", "run-columns");
  columns.append(scoreBlock, buildBlock, statBlock("Run", runRows));
  for (const [title, key, rows] of RUN_STAT_GROUPS) {
    const group = run[key] && typeof run[key] === "object" ? run[key] : {};
    columns.append(statBlock(title, rows.map(([field, label]) => [label, formatStat(group[field])])));
  }
  detail.append(columns);
  return detail;
}

function renderHistory() {
  const host = el("history-list");
  if (!host) return;
  host.textContent = "";
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

function initHistory() {
  el("tab-live").addEventListener("click", () => setView("live"));
  el("tab-history").addEventListener("click", () => setView("history"));
  renderHistory();
}

// State is pushed over IPC from the sidecar; the page never touches the
// network. Without the bridge there is no other source -- that is only
// ever a fault, and it gets its own screen; see renderNoTransport().
initTip();
initTileDone();
initSettings();
initCoopConsent();
initUpdateBar();
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
