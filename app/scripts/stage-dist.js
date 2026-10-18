'use strict';
// Assemble the tree electron-builder packages, at build/stage, with every
// JavaScript file minified and stripped of comments.
//
// The checkout compiles in place (see tsconfig.json for why there is no
// outDir), so packaging straight from app/ would ship the source as written:
// comments, names, the lot. This copies only what the app runs, minifies the
// .js on the way, and points electron-builder at the copy. The checkout is
// never modified, so tests keep running against readable code.
//
// Layout is preserved exactly. sidecar.js spawns reader/stdio.js by a path
// relative to itself and main.js requires ./external-links and ./preload by
// name, so files keep their names and directories. Top-level identifiers are
// kept too (terser toplevel: false): the renderer is four <script> tags that
// share globals -- item-text.js defines ITEM_TEXT, item-icons.js defines
// SHOP_ICONS, and app.js reads both -- and mangling those would break the
// page while every test still passed.
//
// Run through `npm run dist`; electron-builder is invoked with --projectDir
// pointing here. Output lands in build/release, where install.ps1 looks.

const fs = require('fs');
const path = require('path');
const { minify } = require('terser');

const APP = path.resolve(__dirname, '..');
const ROOT = path.resolve(APP, '..');
// STAGE_DIR lets a test stage into a temp directory through this same script.
const STAGE = process.env.STAGE_DIR || path.join(ROOT, 'build', 'stage');

// What ships, as an explicit copy rather than a package.json "files" glob,
// so an omission is a missing file at startup rather than a silently
// included one.
const TOP_LEVEL_JS = ['main.js', 'sidecar.js', 'preload.js', 'external-links.js', 'update.js', 'history.js', 'share.js'];
const READER_SKIP = new Set(['test', 'bench', 'README.md']);
const WEB_SKIP = new Set(['test']);
// Reference content the app never reads: the decoded PNGs and the generated
// item tables stay in the repo for UI work and for test-item-tables, and the
// runtime decodes its own from the player's install (assets/build.ts). The
// manifest ships; its first two columns are what the runtime build reads.
const WEB_SKIP_FILE = (rel) => /^assets\/[^/]+\.png$/.test(rel) || rel === 'item-text.js' || rel === 'item-icons.js';
const NATIVE = ['node_modules/koffi', 'node_modules/@koromix/koffi-win32-x64'];
const NATIVE_SKIP = new Set(['doc', 'vendor']);

function rm(p) { fs.rmSync(p, { recursive: true, force: true }); }
function mkdir(p) { fs.mkdirSync(p, { recursive: true }); }

async function minifyFile(src, dst) {
  const code = fs.readFileSync(src, 'utf8');
  const out = await minify(code, {
    compress: true,
    mangle: true,       // locals only; toplevel stays false, see header
    format: { comments: false },
  });
  if (out.code === undefined) throw new Error(`terser produced nothing for ${src}`);
  mkdir(path.dirname(dst));
  fs.writeFileSync(dst, out.code);
}

function copyFile(src, dst) {
  mkdir(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

// The page's own markup and styles carry as much explanation as the code.
// Our files put no comment delimiters inside strings or url(), so a plain
// strip is exact here; blank lines left behind are collapsed.
function stripMarkupComments(src, dst) {
  let text = fs.readFileSync(src, 'utf8');
  text = /\.html$/.test(src)
    ? text.replace(/<!--[\s\S]*?-->/g, '')
    : text.replace(/\/\*[\s\S]*?\*\//g, '');
  text = text.replace(/[ \t]+$/gm, '').replace(/\n{2,}/g, '\n');
  mkdir(path.dirname(dst));
  fs.writeFileSync(dst, text);
}

// Copy a directory, minifying .js, dropping .ts/.d.ts/.map and anything in
// `skip` at the top level of that directory.
async function copyTree(srcDir, dstDir, skip = new Set(), depth = 0, skipFile = () => false, rel = '') {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (depth === 0 && skip.has(entry.name)) continue;
    const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isDirectory()) { await copyTree(src, dst, new Set(), depth + 1, skipFile, entryRel); continue; }
    if (skipFile(entryRel)) continue;
    if (/\.(ts|map)$/.test(entry.name)) continue;
    if (/\.(js|cjs)$/.test(entry.name)) await minifyFile(src, dst);
    else if (/\.(html|css)$/.test(entry.name)) stripMarkupComments(src, dst);
    else copyFile(src, dst);
  }
}

function stagePackageJson() {
  const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
  const electronVersion = require(path.join(APP, 'node_modules/electron/package.json')).version;
  const staged = {
    name: pkg.name,
    version: pkg.version,
    private: true,
    description: pkg.description,
    license: pkg.license,
    repository: pkg.repository,
    main: pkg.main,
    dependencies: pkg.dependencies,
    build: {
      ...pkg.build,
      electronVersion,
      // Relative to the stage, which sits one level down from build/.
      directories: { output: '../release' },
      // Everything staged is meant to ship; the selection happened above.
      files: ['**/*'],
      // koffi is prebuilt and already in place; nothing to rebuild or fetch.
      npmRebuild: false,
      nodeGypRebuild: false,
      buildDependenciesFromSource: false,
    },
  };
  fs.writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify(staged, null, 2) + '\n');
}

async function main() {
  rm(STAGE);
  mkdir(STAGE);

  for (const f of TOP_LEVEL_JS) await minifyFile(path.join(APP, f), path.join(STAGE, f));
  await copyTree(path.join(APP, 'reader'), path.join(STAGE, 'reader'), READER_SKIP);
  await copyTree(path.join(APP, 'web'), path.join(STAGE, 'web'), WEB_SKIP, 0, WEB_SKIP_FILE);
  await copyTree(path.join(APP, 'assets'), path.join(STAGE, 'assets'));
  copyFile(path.join(APP, 'THIRD_PARTY_NOTICES.md'), path.join(STAGE, 'THIRD_PARTY_NOTICES.md'));
  copyFile(path.join(APP, 'value_types.json'), path.join(STAGE, 'value_types.json'));
  copyFile(path.join(ROOT, 'LICENSE'), path.join(STAGE, 'LICENSE'));
  copyFile(path.join(APP, 'build', 'icon.ico'), path.join(STAGE, 'build', 'icon.ico'));

  // Native module and its platform package, as-is apart from docs. These are
  // third-party files and are not minified; the .node binary is unpacked
  // from the asar by the asarUnpack rule carried over from package.json.
  for (const rel of NATIVE) {
    const src = path.join(APP, rel);
    const dst = path.join(STAGE, rel);
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (NATIVE_SKIP.has(entry.name)) continue;
      fs.cpSync(path.join(src, entry.name), path.join(dst, entry.name), { recursive: true });
    }
  }

  stagePackageJson();

  // Nothing readable left behind: no comment survives terser, and no source.
  const leaks = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(p); continue; }
      if (/\.(ts|map)$/.test(entry.name)) leaks.push(p);
      const text = /\.(js|html|css)$/.test(entry.name) ? fs.readFileSync(p, 'utf8') : '';
      if (/\.js$/.test(entry.name) && /(^|\n)\s*\/\//.test(text)) leaks.push(p);
      if (/\.html$/.test(entry.name) && /<!--/.test(text)) leaks.push(p);
      if (/\.css$/.test(entry.name) && /\/\*/.test(text)) leaks.push(p);
    }
  })(STAGE);
  if (leaks.length) throw new Error('unminified or source files in stage:\n  ' + leaks.join('\n  '));

  // No decoded game content. The manifest and the font are the whole of
  // web/assets in the zip; anything else there is a PNG somebody added.
  const shippedAssets = fs.readdirSync(path.join(STAGE, 'web', 'assets')).sort();
  if (shippedAssets.join(',') !== 'SOURCES.tsv,fonts') {
    throw new Error(`web/assets in stage must hold only SOURCES.tsv and fonts/, has: ${shippedAssets.join(', ')}`);
  }

  console.log(`staged ${path.relative(ROOT, STAGE)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
