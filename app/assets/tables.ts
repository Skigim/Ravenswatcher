'use strict';
// Item text and icon tables from the game's own data, read from the
// player's install at runtime. Port of tools/build_item_text.py, which
// writes the same tables into app/web/ for reference; test-item-tables
// holds the two equal row for row against the local install.
//
// Both tables start from the entity definitions, not from the text table. An
// object's definition names the text key it displays as its name, the text
// key it displays as its description, and the texture it draws. The three do
// not share a stem, so pairing by stem silently picks an older version of an
// item; 17 descriptions and 19 icons were wrong that way on 2026-09-18.
//
// Which definitions are live is read from the version definition, which
// lists every object the build ships. A listed definition's text is its own
// when it has any, and otherwise the text of the one definition it references
// that has some (a tier variant such as Power_Up_Grimoire_Vitality_Low
// references its _Model).
//
// The key and language files are the same shape: a 16-byte header, a u32 row
// count, then that many u32-length-prefixed UTF-8 strings. Row i of the key
// file names row i of the language file.
//
// Descriptions carry the game's markup, which the tooltip does not render:
// a leading bullet, #...@ for a highlighted term, &...~ for a positive
// number, $...* for a negative one. Numbers are placeholders ({}, {0}) the
// game fills at runtime; the tooltip is a reminder of what an item does, so
// the placeholder and its percent sign go and the direction stays:
// "+{}% ARMOR" becomes "+ARMOR".
//
// Keys are the token a live offer name reduces to through itemKey(), which
// is app/web/app.js's function character for character. Change both or
// neither.

import * as fs from 'fs';
import * as path from 'path';
import { decodeName, encodeName } from './cipher';
import type { HistoryArtTables } from './history-art';

export interface Tables extends HistoryArtTables {
  ITEM_TEXT: Record<string, string>;
  SHOP_ICONS: Record<string, string>;
  ITEM_NAMES: Record<string, string>;
  /** Run-record GUID bytes in memory order -> the same name key the shop uses. */
  OBJECT_KEYS: Record<string, string>;
  OBJECT_RARITIES: Record<string, string>;
}

const TEXT_FILE = 'Text/Magical_Objects~GAM.xls.LocalText.gen';
const DEFINITIONS_DIR = 'EntitySettings/Objects';
const VERSIONS_DIR = 'Definitions/Versions';

// A definition that draws more than one icon, and which one the shop shows.
// Anything else with two candidates stops the build; add a row here with the
// reason rather than picking silently.
const ICON_CHOICE: Record<string, string> = {
  // Sold full; the empty art is the in-run state after it pays out.
  Curse_Stack_Shard_Quest: 'Icon_Devil_Pocket_Full.png',
};

const DROP = new Set(['of', 'the', 'and', 'a']);
const TEXT_KEY = /(?<![A-Za-z0-9_])[A-Za-z0-9_ ]+?_(Name|Description)(?![A-Za-z0-9_])/g;
const ICON = /(?:Icon|UI)_[A-Za-z0-9_]+\.png/g;
const ENTITY_REF = /([A-Za-z0-9_]+)\.entity\.ot/g;
const LISTED = /Objects\\Magical_Objects\\[A-Za-z0-9_\\]+?\\([A-Za-z0-9_]+)\.entity\.ot/g;

/** The cooked path of a decoded path relative to the _Cooking directory. */
export function cookedPath(cookingDir: string, decodedRel: string): string {
  return path.join(cookingDir, ...decodedRel.split('/').map(encodeName));
}

export function readCooked(cookingDir: string, decodedRel: string): Buffer {
  const p = cookedPath(cookingDir, decodedRel);
  try {
    return fs.readFileSync(p);
  } catch (e) {
    throw new Error(`${decodedRel}: cannot read ${p} (${(e as Error).message})`);
  }
}

/** Decoded names of the entries in a cooked directory. */
export function listCooked(cookingDir: string, decodedRelDir: string): string[] {
  const p = cookedPath(cookingDir, decodedRelDir);
  let names: string[];
  try {
    names = fs.readdirSync(p);
  } catch (e) {
    throw new Error(`${decodedRelDir}: cannot list ${p} (${(e as Error).message})`);
  }
  return names.map(decodeName);
}

/** Mirror of itemKey() in app/web/app.js. Change both or neither. */
export function itemKey(name: string): string {
  return String(name).replace(/’/g, "'").toLowerCase()
    .replace(/'s\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim().split(' ')
    .filter((w) => w && !DROP.has(w))
    .join('');
}

export function clean(desc: string): string {
  desc = desc.replace(/•/g, '').replace(/ /g, ' ');
  desc = desc.replace(/\{\d*\}%?/g, '');
  desc = desc.replace(/[#@&~$*]/g, '');
  desc = desc.replace(/[ \t]+/g, ' ');
  // The sign survives glued to what it modifies ("+ARMOR", "-Crit Chance");
  // one left dangling at the end of a line goes. \p{L}\p{N}_ is Python's
  // Unicode \w, which the original uses.
  desc = desc.replace(/([+-]) (?=[\p{L}\p{N}_])/gu, '$1');
  desc = desc.replace(/ ?[+-](?=$|\n|[,.)])/g, '');
  desc = desc.replace(/ ([,.)])/g, '$1').replace(/\( /g, '(');
  return desc.split('\n').map((l) => l.trim()).join('\n').trim();
}

export function parseTextTable(blob: Buffer, name: string): string[] {
  const count = blob.readUInt32LE(16);
  let offset = 20;
  const rows: string[] = [];
  for (let i = 0; i < count; i++) {
    const length = blob.readUInt32LE(offset);
    offset += 4;
    rows.push(blob.toString('utf8', offset, offset + length));
    offset += length;
  }
  if (offset !== blob.length) {
    throw new Error(`${name}: ${blob.length - offset} trailing bytes; layout changed`);
  }
  return rows;
}

type Row = [name: string, desc: string | null, icon: string | null];

/** An entry the caller has already proven present. Throws if it is not. */
function must<K, V>(m: ReadonlyMap<K, V>, k: K): V {
  const v = m.get(k);
  if (v === undefined) throw new Error(`no entry for ${JSON.stringify(k)}`);
  return v;
}

/** Capture group `n` of a match whose pattern always sets it. */
function group(m: RegExpMatchArray, n: number): string {
  const g = m[n];
  if (g === undefined) throw new Error(`match ${JSON.stringify(m[0])} has no group ${n}`);
  return g;
}

function matches(re: RegExp, text: string): string[] {
  return Array.from(text.matchAll(re), (m) => m[0]);
}

/** (display name, description or null, icon or null) for one definition, or null when it has no name key. */
function describe(short: string, blob: Buffer, text: Map<string, string>): Row | null {
  const latin = blob.toString('latin1');
  const keys = new Set(matches(TEXT_KEY, latin));
  const names = [...keys].filter((k) => k.endsWith('_Name') && text.has(k)).sort();
  const descs = [...keys].filter((k) => k.endsWith('_Description') && text.has(k)).sort();
  const [nameKey] = names;
  if (nameKey === undefined) return null;
  if (names.length > 1 || descs.length > 1) {
    throw new Error(`${short}: more than one text key -- names ${JSON.stringify(names)}, descriptions ${JSON.stringify(descs)}`);
  }
  let icons = [...new Set(matches(ICON, latin).filter((i) => !i.endsWith('_Disabled.png')))].sort();
  if (icons.length > 1) {
    const chosen = ICON_CHOICE[short];
    if (chosen === undefined || !icons.includes(chosen)) {
      throw new Error(`${short}: ${icons.length} icons ${JSON.stringify(icons)}; add it to ICON_CHOICE`);
    }
    icons = [chosen];
  }
  const [descKey] = descs;
  const d = descKey === undefined ? null : clean(must(text, descKey));
  return [must(text, nameKey), d, icons[0] ?? null];
}

/** describe() for a listed definition, following a textless one to its model. */
function resolve(short: string, defs: Map<string, Buffer>, text: Map<string, string>): [string, Row | null] {
  const blob = must(defs, short);
  const own = describe(short, blob, text);
  if (own !== null) return [short, own];
  const found: [string, Row][] = [];
  for (const m of blob.toString('latin1').matchAll(ENTITY_REF)) {
    const ref = group(m, 1);
    const refBlob = defs.get(ref);
    if (refBlob !== undefined && ref !== short) {
      const r = describe(ref, refBlob, text);
      if (r !== null) found.push([ref, r]);
    }
  }
  if (found.length > 1) {
    throw new Error(`${short}: no text of its own and ${found.length} referenced definitions with text: ${JSON.stringify(found.map((f) => f[0]))}`);
  }
  return found[0] ?? [short, null];
}

function definitions(cookingDir: string, rarities: Map<string, string>): Map<string, Buffer> {
  const defs = new Map<string, Buffer>();
  for (const name of listCooked(cookingDir, DEFINITIONS_DIR)) {
    if (!name.startsWith('Magical_Objects!') || !name.endsWith('.gen')) continue;
    // `Magical_Objects!<short>.<rest>.gen`; both separators are present.
    const tail = name.slice(name.lastIndexOf('!') + 1);
    const short = tail.slice(0, tail.indexOf('.'));
    defs.set(short, readCooked(cookingDir, `${DEFINITIONS_DIR}/${name}`));
    const rarity = name.split('!')[1];
    if (rarity) rarities.set(short, rarity);
  }
  if (defs.size === 0) throw new Error(`no Magical_Objects definitions under ${DEFINITIONS_DIR}`);
  return defs;
}

function liveNames(cookingDir: string, defs: Map<string, Buffer>): Set<string> {
  const files = listCooked(cookingDir, VERSIONS_DIR).filter((n) => /\.versiondef\.ot\..*\.gen$/.test(n)).sort();
  if (files.length !== 1) {
    throw new Error(`expected one version definition under ${VERSIONS_DIR}, found ${JSON.stringify(files)}`);
  }
  const blob = readCooked(cookingDir, `${VERSIONS_DIR}/${files[0]}`).toString('latin1');
  const listed = new Set(Array.from(blob.matchAll(LISTED), (m) => group(m, 1)));
  const missing = [...listed].filter((n) => !defs.has(n)).sort();
  if (missing.length) throw new Error(`${files[0]} lists definitions with no file: ${JSON.stringify(missing)}`);
  return listed;
}

/** Component identity immediately before the serialized Magical Object data name. */
function objectGuid(blob: Buffer, short: string): string | null {
  const marker = /\x22\x22\xbb\xaa([\s\S]{16})\x16\x00\x00\x00Dt Magical Object Data/g;
  const found = [...blob.toString('latin1').matchAll(marker)];
  if (found.length > 1) throw new Error(`${short}: ambiguous Magical Object GUID`);
  const guid = found[0]?.[1];
  return guid === undefined ? null : Buffer.from(guid, 'latin1').toString('hex');
}

/**
 * The item tables and GUID join from a cooked tree. `iconAssets` maps a Ui_png path
 * ("Objects/Icon_Read_Dream.png") to the asset name the page draws it as.
 */
export function buildTables(cookingDir: string, iconAssets: Map<string, string>, lang = 'EN'): Tables {
  const keys = parseTextTable(readCooked(cookingDir, TEXT_FILE), TEXT_FILE);
  const langFile = `${TEXT_FILE}.Lang${lang}`;
  const texts = parseTextTable(readCooked(cookingDir, langFile), langFile);
  if (keys.length !== texts.length) {
    throw new Error(`row count differs: ${keys.length} keys, ${texts.length} texts`);
  }
  // Row i of one table is row i of the other; the lengths match, checked above.
  const text = new Map<string, string>();
  keys.forEach((k, i) => {
    const t = texts[i];
    if (t === undefined) throw new Error(`${langFile}: no row ${i}`);
    text.set(k, t);
  });

  const rarities = new Map<string, string>();
  const defs = definitions(cookingDir, rarities);
  const live = liveNames(cookingDir, defs);

  // key -> [definition, display name, description, icon]. Three tier
  // variants resolve to one model and land here three times; two distinct
  // definitions under one name must agree or the build stops.
  const rows = new Map<string, [string, string, string | null, string | null]>();
  const OBJECT_KEYS: Record<string, string> = {};
  const OBJECT_RARITIES: Record<string, string> = {};
  for (const listed of [...live].sort()) {
    const [short, row] = resolve(listed, defs, text);
    if (row === null) continue;
    const [name, desc, icon] = row;
    const k = itemKey(name);
    // Read identity from the listed variant, even when text/art are inherited.
    const guid = objectGuid(must(defs, listed), listed);
    if (guid !== null) {
      if (OBJECT_KEYS[guid] !== undefined && OBJECT_KEYS[guid] !== k) {
        throw new Error(`${listed}: duplicate Magical Object GUID ${guid}`);
      }
      OBJECT_KEYS[guid] = k;
      const rarity = rarities.get(listed);
      if (rarity) OBJECT_RARITIES[guid] = rarity;
    }
    const have = rows.get(k);
    if (have && have[0] !== short && (have[2] !== desc || have[3] !== icon)) {
      throw new Error(`${JSON.stringify(name)}: ${have[0]} and ${short} are both live and disagree on description or icon`);
    }
    if (!have) rows.set(k, [short, name, desc, icon]);
  }

  const ITEM_NAMES: Record<string, string> = {};
  const ITEM_TEXT: Record<string, string> = {};
  const SHOP_ICONS: Record<string, string> = {};
  const unimported: string[] = [];
  for (const [k, [short, name, desc, icon]] of [...rows].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    ITEM_NAMES[k] = name;
    if (desc) ITEM_TEXT[k] = desc;
    if (!icon) continue;
    const uiPath = `Objects/${icon}`;
    const asset = iconAssets.get(uiPath);
    if (asset) SHOP_ICONS[k] = asset;
    else unimported.push(`  ${JSON.stringify(name)} (${short}): ${uiPath}`);
  }
  if (unimported.length) {
    throw new Error(`${unimported.length} live objects draw a texture with no manifest row; add each to SOURCES.tsv:\n${unimported.join('\n')}`);
  }
  return { ITEM_TEXT, SHOP_ICONS, ITEM_NAMES, OBJECT_KEYS, OBJECT_RARITIES, HERO_ICONS: {}, DIFFICULTY_ICONS: {}, TALENT_ICONS: {} };
}
