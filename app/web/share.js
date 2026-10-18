/* Dedicated image renderer. All saved text enters through textContent. */
"use strict";

const P = RunPresentation;

const RARITY = {
  Common: "#b4b7b4",
  Rare: "#48a9df",
  Epic: "#ba89de",
  Legendary: "#d5ae4d",
  Ultimate: "#ee705a",
  Cursed: "#d35b61",
};

const DIFFICULTIES = {
  0: "Adventure",
  1: "Twilight",
  2: "Darkness",
  3: "Nightmare",
};

const DAMAGE = [
  ["attack", "Attack"],
  ["power", "Power"],
  ["special", "Special"],
  ["ultimate", "Ultimate"],
  ["dash", "Dash"],
  ["trait", "Trait"],
  ["defense", "Defense"],
  ["other", "Other"],
];

function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = String(text);
  return n;
}

function art(name, cls = "") {
  const box = node("span", `art ${cls}`);
  const image = node("img");
  image.alt = "";
  image.addEventListener("error", () => {
    image.hidden = true;
    box.classList.add("missing");
  }, { once: true });
  const file = /^[A-Za-z0-9_.-]+\.png$/.test(name || "") ? name : "icon_question.png";
  image.src = "asset://icons/" + file;
  box.append(image);
  return box;
}

function heading(text) {
  const wrap = node("div", "section-heading");
  wrap.appendChild(node("h2", "", text));
  return wrap;
}

function known(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

async function renderShare({ run, tables = {}, stylizedFonts = true }) {
  document.body.classList.toggle("stylized-fonts", stylizedFonts);
  const root = document.getElementById("share-card");
  root.replaceChildren();
  root.className = "card " + (run.result === "victory" ? "victory" : "defeat");

  const code = P.heroCode(run);
  const header = node("header", "header");
  const identity = node("div", "identity");
  const h1 = node("h1");
  P.setName(h1, P.heroName(run));
  identity.append(node("div", "eyebrow", run.result === "victory" ? "VICTORY" : "DEFEAT"), h1);

  const context = node("div", "context");
  context.append(art(tables.DIFFICULTY_ICONS?.[run.difficulty], "difficulty"));
  const contextLabels = [
    DIFFICULTIES[run.difficulty] || "Difficulty unavailable",
    P.stageName(run.map_name) || "Stage unavailable",
    P.formatPlaytime(run.playtime_s),
  ];
  contextLabels.forEach((value, i) => {
    if (i) context.append(node("span", "dot", "·"));
    context.append(node("span", "", value));
  });
  identity.append(context);

  const score = node("div", "score");
  score.append(
    node("div", "caption", "TOTAL SCORE"),
    node("div", "value", P.formatStat(run.score?.total)),
  );
  header.append(art(tables.HERO_ICONS?.[code], "hero-art"), identity, score);
  root.append(header);

  const strip = node("section", "melody-strip");
  const melodies = node("div", "melodies");
  strip.append(heading("Melodies"), melodies);
  for (const m of run.melodies || []) {
    const row = node("div", "melody");
    const copy = node("div");
    const state = ["active", "completed", "locked"].includes(m.state) ? m.state : "unknown";
    const required = Number.isInteger(m.notes) && m.notes > 0 ? m.notes : null;
    const earned = Number.isInteger(m.notes_earned) && m.notes_earned >= 0
      && required !== null && m.notes_earned <= required
      ? m.notes_earned
      : null;
    const label = state === "completed"
      ? "Completed"
      : state === "active"
        ? `${earned ?? "—"}/${required ?? "—"} notes`
        : state === "locked"
          ? "Locked"
          : "Not recorded";
    copy.append(node("strong", "", m.name || "Unknown melody"), node("span", "state " + state, label));
    const melodyIcon = state === "locked" || state === "unknown" ? "UI_Melody_Icon_Locked.png" : m.icon;
    row.append(art(melodyIcon), copy);
    melodies.append(row);
  }
  if (!run.melodies?.length) {
    melodies.append(node("div", "empty", Array.isArray(run.melodies) ? "No melodies." : "Melodies not recorded."));
  }
  root.append(strip);

  const build = node("div", "build");
  const talentSection = node("section");
  const objectSection = node("section");
  const talents = node("div", "talents");
  const objects = node("div", "objects");
  talentSection.append(heading("Talents"), talents);
  objectSection.append(heading("Magical Objects"), objects);

  for (const t of run.talents || []) {
    const row = node("div", "talent item");
    const image = node("div", "talent-art");
    const copy = node("div", "item-copy");
    row.style.setProperty("--rarity", RARITY[t.rarity] || "#96998c");
    image.append(art(tables.TALENT_ICONS?.[code]?.[t.key]));
    copy.append(
      node("strong", "", t.name || "Unknown talent"),
      node("span", "rarity", t.rarity || "Rarity unavailable"),
    );
    row.append(image, copy);
    talents.append(row);
  }
  if (!run.talents?.length) {
    talents.append(node("div", "empty", Array.isArray(run.talents) ? "No talents taken." : "Talents not recorded."));
  }

  const counts = Array.isArray(run.object_counts) && run.object_counts.length === run.objects?.length
    ? run.object_counts
    : null;
  (run.objects || []).forEach((guid, i) => {
    const key = tables.OBJECT_KEYS?.[guid];
    const rarity = tables.OBJECT_RARITIES?.[guid];
    const row = node("div", "object item");
    const image = node("div", "object-art");
    const copy = node("div", "item-copy");
    row.style.setProperty("--rarity", RARITY[rarity] || "#96998c");
    image.append(art(tables.SHOP_ICONS?.[key]));
    copy.append(
      node("strong", "", tables.ITEM_NAMES?.[key] || "Unknown object"),
      node("span", "rarity", rarity || "Rarity unavailable"),
    );
    const count = counts && Number.isInteger(counts[i]) && counts[i] >= 0 && counts[i] <= 65535
      ? counts[i]
      : null;
    row.append(image, copy, node("b", "quantity", count === null ? "×—" : `×${count}`));
    objects.append(row);
  });
  if (!run.objects?.length) {
    objects.append(node("div", "empty", Array.isArray(run.objects) ? "No magical objects." : "Objects not recorded."));
  }
  build.append(talentSection, objectSection);
  root.append(build);

  const damage = run.damage || {};
  const panel = node("section", "damage");
  const body = node("div", "damage-body");
  const total = node("div", "total");
  const highest = node("div", "highest", "Highest hit ");
  const bars = node("div", "bars");
  highest.append(node("b", "", P.formatStat(damage.highest)));
  total.append(
    node("div", "value", P.formatStat(damage.total)),
    node("div", "label", "TOTAL DAMAGE"),
    highest,
  );
  const fields = DAMAGE
    .map(([key, label], order) => ({ key, label, order, value: damage[key] }))
    .sort((a, b) => (known(b.value) ? b.value : -1) - (known(a.value) ? a.value : -1) || a.order - b.order);
  for (const f of fields) {
    const row = node("div", "damage-row");
    const track = node("div", "track");
    const fill = node("i");
    const ratio = known(f.value) && known(damage.total)
      ? (damage.total > 0 ? f.value / damage.total : f.value === 0 ? 0 : null)
      : null;
    fill.style.width = `${ratio === null ? 0 : Math.min(100, ratio * 100)}%`;
    track.append(fill);
    row.append(
      node("span", "", f.label),
      track,
      node("b", "", P.formatStat(f.value)),
      node("small", "", ratio === null ? "—" : `${Math.floor(ratio * 100)}%`),
    );
    bars.append(row);
  }
  body.append(total, bars);
  panel.append(heading("Damage Dealt"), body);
  root.append(panel);

  const footer = node("footer", "footer");
  footer.append(node("b", "", "github.com/Skigim/Ravenswatcher"), node("span", "", "RUN SUMMARY"));
  root.append(footer);

  await document.fonts.ready;
  let timer;
  await Promise.race([
    Promise.all([...document.images].map((image) => image.decode().catch(() => {}))),
    new Promise((resolve) => {
      timer = setTimeout(resolve, 3000);
    }),
  ]);
  clearTimeout(timer);
  for (const image of document.images) {
    if (!image.complete || !image.naturalWidth) {
      image.hidden = true;
      image.parentElement.classList.add("missing");
    }
  }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return { width: 1600, height: Math.ceil(root.getBoundingClientRect().height) };
}

