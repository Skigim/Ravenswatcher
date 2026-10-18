'use strict';
// Assemble an explicit runtime-only tree at build/stage. Preserve readable
// source and runtime paths; exclude development files and decoded game data.

const fs = require('fs');
const path = require('path');

const APP = path.resolve(__dirname, '..');
const ROOT = path.resolve(APP, '..');
// STAGE_DIR lets a test stage into a temp directory through this same script.
const STAGE = process.env.STAGE_DIR || path.join(ROOT, 'build', 'stage');

// What ships, as an explicit copy rather than a package.json "files" glob,
// so an omission is a missing file at startup rather than a silently
// included one.
const TOP_LEVEL_JS = ['main.js', 'sidecar.js', 'preload.js', 'external-links.js', 'update.js', 'history.js', 'share.js', 'lifecycle.js'];
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

function copyFile(src, dst) {
  mkdir(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

// Copy runtime files, excluding TypeScript, declarations, maps and development directories.
async function copyTree(srcDir, dstDir, skip = new Set(), depth = 0, skipFile = () => false, rel = '') {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (depth === 0 && skip.has(entry.name)) continue;
    const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isDirectory()) { await copyTree(src, dst, new Set(), depth + 1, skipFile, entryRel); continue; }
    if (skipFile(entryRel)) continue;
    if (/\.(ts|map)$/.test(entry.name)) continue;
    copyFile(src, dst);
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

  for (const f of TOP_LEVEL_JS) copyFile(path.join(APP, f), path.join(STAGE, f));
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

  const sources = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(file); }
      else if (/\.(ts|map)$/.test(entry.name)) sources.push(file);
    }
  })(STAGE);
  if (sources.length) throw new Error('development files in stage: ' + sources.join(', '));

  // No decoded game content. The manifest and the font are the whole of
  // web/assets in the zip; anything else there is a PNG somebody added.
  const shippedAssets = fs.readdirSync(path.join(STAGE, 'web', 'assets')).sort();
  if (shippedAssets.join(',') !== 'SOURCES.tsv,fonts') {
    throw new Error(`web/assets in stage must hold only SOURCES.tsv and fonts/, has: ${shippedAssets.join(', ')}`);
  }

  console.log(`staged ${path.relative(ROOT, STAGE)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
