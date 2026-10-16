'use strict';
// The runtime asset build: manifest in, cache directory out.
//
// The manifest is app/web/assets/SOURCES.tsv. Its first two columns name
// each icon the page draws and the Ui_png path it comes from; the other two
// are provenance for the reference PNGs committed beside it, which this
// build never reads. Every row is decoded from the player's install into
// <cacheDir>/icons/<asset>, and the item tables go to <cacheDir>/tables.json.
//
// The build is all-or-nothing. It writes into a sibling temp directory and
// swaps it over the cache at the end, so a failure part-way leaves the
// previous cache whole and a crash never leaves a half-written one. Any
// unreadable or malformed input stops the build with the file named; there
// is no per-row skip, because a missing icon on screen with nothing in the
// log is the failure this replaces.

import * as fs from 'fs';
import * as path from 'path';
import { parseTexture } from './texture';
import { encodePng } from './png';
import { buildTables, readCooked, Tables } from './tables';

export const CACHE_DIR_NAME = 'game-assets';
const COOKING = ['DarkTalesResources', '_Cooking'];

export interface ManifestRow { asset: string; uiPath: string }

export interface BuildOptions {
  installDir: string;
  cacheDir: string;
  manifestPath: string;
  lang?: string;
}

export function readManifest(manifestPath: string): ManifestRow[] {
  const rows: ManifestRow[] = [];
  for (const line of fs.readFileSync(manifestPath, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || line.startsWith('asset\t')) continue;
    const [asset, uiPath] = line.split('\t');
    if (!asset || !uiPath) throw new Error(`${path.basename(manifestPath)}: malformed row ${JSON.stringify(line)}`);
    rows.push({ asset, uiPath });
  }
  if (rows.length === 0) throw new Error(`${manifestPath}: no rows`);
  return rows;
}

/**
 * The decoded path under _Cooking of a Ui_png path. The cooked tree keeps
 * the first two levels as folders and joins the rest into the file name
 * with '!': MiniMap/Icons/High/X.png lives at Ui/MiniMap/Icons!High!X.png.
 */
export function texturePath(uiPath: string): string {
  const [top, ...rest] = uiPath.split('/');
  return `Ui/${top}/${rest.join('!')}.Texture.dxt`;
}

export function buildAssets(opts: BuildOptions): Tables {
  const cookingDir = path.join(opts.installDir, ...COOKING);
  const rows = readManifest(opts.manifestPath);
  const iconAssets = new Map(rows.map((r) => [r.uiPath, r.asset]));

  const tmp = opts.cacheDir + '.tmp';
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, 'icons'), { recursive: true });
  try {
    for (const { asset, uiPath } of rows) {
      const rel = texturePath(uiPath);
      const tex = parseTexture(readCooked(cookingDir, rel), rel);
      fs.writeFileSync(path.join(tmp, 'icons', asset), encodePng(tex.width, tex.height, tex.rgba));
    }
    const tables = buildTables(cookingDir, iconAssets, opts.lang);
    fs.writeFileSync(path.join(tmp, 'tables.json'), JSON.stringify(tables));

    const old = opts.cacheDir + '.old';
    fs.rmSync(old, { recursive: true, force: true });
    if (fs.existsSync(opts.cacheDir)) fs.renameSync(opts.cacheDir, old);
    fs.renameSync(tmp, opts.cacheDir);
    fs.rmSync(old, { recursive: true, force: true });
    return tables;
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}
