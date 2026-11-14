'use strict';
// Pure procfs helpers: maps parsing, image lookup, process matching, stat
// parsing, and pid discovery against a temp directory laid out like /proc.
// Portable: no live process is read, so it runs on every platform.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseMaps, moduleFromMaps, matchesExe, findPids, procStartTime, procState, readMaps,
  imageCandidates, resolveModule,
} = require('../procfs');

const EXE = '/home/u/.steam/steam apps/common/Ravenswatch/Ravenswatch.exe';
const MAPS = [
  `140000000-140001000 r--p 00000000 08:02 1234 ${EXE}`,
  `140001000-140800000 r-xp 00001000 08:02 1234 ${EXE}`,
  `140800000-140a00000 r--p 00800000 08:02 1234 ${EXE}`,
  `140a00000-140a80000 rw-p 00a00000 08:02 1234 ${EXE}`,
  '140a80000-140b00000 rw-p 00000000 00:00 0 ',
  '7f0000000000-7f0000200000 rw-p 00000000 00:00 0',
  '55d0c0000000-55d0c0100000 rw-p 00000000 00:00 0                          [heap]',
  '7ffd1c000000-7ffd1c021000 rw-p 00000000 00:00 0                          [stack]',
  '7ffd1c0f0000-7ffd1c0f4000 r--p 00000000 00:00 0                          [vvar]',
  'ffffffffff600000-ffffffffff601000 --xp 00000000 00:00 0                  [vsyscall]',
].join('\n') + '\n';

function main() {
  // parseMaps: every line but [vsyscall]; numbers exact; spaces in path kept.
  const maps = parseMaps(MAPS);
  assert.strictEqual(maps.length, 9, '[vsyscall] is skipped');
  assert.ok(!maps.some((m) => m.path === '[vsyscall]'));
  assert.deepStrictEqual(maps[0], { start: 0x140000000, end: 0x140001000, perms: 'r--p', offset: 0, path: EXE });
  assert.strictEqual(maps[3].offset, 0xa00000);
  assert.strictEqual(maps[4].path, '');
  assert.strictEqual(maps[5].path, '');
  assert.strictEqual(maps[6].path, '[heap]');
  assert.strictEqual(maps[7].path, '[stack]');
  assert.strictEqual(maps[8].path, '[vvar]');
  assert.strictEqual(maps[5].start, 0x7f0000000000);
  assert.deepStrictEqual(parseMaps('garbage\n\n'), []);

  // moduleFromMaps
  const mod = moduleFromMaps(maps, 'ravenswatch.EXE');
  assert.deepStrictEqual(mod, { base: 0x140000000, size: 0xa80000, exePath: EXE });
  assert.throws(() => moduleFromMaps(maps, 'other.exe'), /other\.exe/);

  // matchesExe
  assert.ok(matchesExe('Ravenswatch.exe\n', '', 'Ravenswatch.exe'), 'comm match');
  assert.ok(matchesExe('LongGameName.exe'.slice(0, 15), '', 'LongGameName.exe'), 'truncated 15-char comm');
  assert.ok(!matchesExe('Ravens', '', 'Ravenswatch.exe'), 'short prefix is not a match');
  assert.ok(matchesExe('wine64-preloader', 'Z:\\home\\u\\game\\Ravenswatch.exe\0arg\0', 'Ravenswatch.exe'));
  assert.ok(matchesExe('x', 'C:\\Games\\Ravenswatch\\Ravenswatch.exe\0', 'Ravenswatch.exe'));
  assert.ok(matchesExe('x', '/opt/game/ravenswatch.EXE\0', 'Ravenswatch.exe'), 'case differences');
  assert.ok(!matchesExe('bash', '/bin/bash\0-c\0Ravenswatch.exe\0', 'Ravenswatch.exe'), 'only argv[0] counts');
  assert.ok(!matchesExe('', '', 'Ravenswatch.exe'));

  // findPids against a fake /proc
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'procfs-'));
  try {
    const mk = (name, comm, cmdline) => {
      fs.mkdirSync(path.join(root, name));
      if (comm !== null) fs.writeFileSync(path.join(root, name, 'comm'), comm);
      if (cmdline !== null) fs.writeFileSync(path.join(root, name, 'cmdline'), cmdline);
    };
    mk('100', 'bash\n', '/bin/bash\0');
    mk('200', 'Ravenswatch.exe\n', 'Z:\\g\\Ravenswatch.exe\0');
    mk('300', 'wine64-preloader\n', 'C:\\g\\ravenswatch.exe\0');
    mk('self', 'Ravenswatch.exe\n', '');
    mk('400', null, null);                // vanished: nothing readable
    mk('500', 'Ravenswatch.exe\n', null); // cmdline unreadable, comm still matches
    fs.mkdirSync(path.join(root, 'sys'));
    fs.writeFileSync(path.join(root, 'uptime'), '1 1');
    assert.deepStrictEqual(findPids('Ravenswatch.exe', root), [200, 300, 500]);
    assert.deepStrictEqual(findPids('Ravenswatch.exe', path.join(root, 'missing')), []);

    // readMaps decodes UTF-8: a non-ASCII parent directory survives intact,
    // where latin1 would hand back /home/AndrÃ©/... and a dead install dir.
    const utf8Exe = '/home/André/Steam/Ravenswatch/Ravenswatch.exe';
    fs.mkdirSync(path.join(root, '600'));
    fs.writeFileSync(path.join(root, '600', 'maps'),
      Buffer.from(`140000000-140001000 r--p 00000000 08:02 1234 ${utf8Exe}\n`, 'utf8'));
    assert.strictEqual(moduleFromMaps(parseMaps(readMaps(600, root)), 'Ravenswatch.exe').exePath, utf8Exe);
    assert.throws(() => readMaps(601, root), { code: 'ENOENT' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  // imageCandidates / resolveModule: once argv[0] or comm names a Windows
  // image, Wine's loader (the exe link) is never a fallback.
  const wineNames = imageCandidates('Z:\\games\\Ravenswatch.exe\0', 'Ravenswatch.exe\n', '/usr/bin/wine64-preloader');
  assert.deepStrictEqual(wineNames, ['Ravenswatch.exe']);
  assert.deepStrictEqual(
    imageCandidates('C:\\g\\Ravenswatch.exe\0', 'wine64-preloader\n', '/usr/bin/wine64-preloader'),
    ['Ravenswatch.exe'], 'a loader comm is dropped too');
  const loaderOnly = parseMaps([
    '7f1000000000-7f1000001000 r--p 00000000 08:02 77 /usr/bin/wine64-preloader',
    '7f1000001000-7f1000010000 r-xp 00001000 08:02 77 /usr/bin/wine64-preloader',
  ].join('\n'));
  assert.throws(() => resolveModule(loaderOnly, wineNames), /Ravenswatch\.exe/,
    'a missing game image fails instead of resolving to the loader');
  assert.strictEqual(resolveModule(maps, wineNames).base, 0x140000000);
  // A native process keeps every name, exe link last.
  assert.deepStrictEqual(imageCandidates('/usr/bin/sleep\0' + '30\0', 'sleep\n', '/usr/bin/sleep'), ['sleep']);
  assert.deepStrictEqual(imageCandidates('', '', '/usr/bin/coreutils'), ['coreutils']);
  assert.deepStrictEqual(imageCandidates('', '', ''), []);
  assert.throws(() => resolveModule(maps, []), /could not determine/);

  // procStartTime / procState: comm may hold spaces and parens.
  const rest = ['S', ...Array.from({ length: 18 }, (_, i) => String(i + 4)), '987654'];
  const stat = `4242 (we ) ( ird) ${rest.join(' ')} 0 0\n`;
  assert.strictEqual(procStartTime(stat), '987654');
  assert.strictEqual(procState(stat), 'S');
  assert.throws(() => procStartTime('no parens'));

  console.log('test-procfs: ok');
  return 0;
}

module.exports = { main };
if (require.main === module) process.exit(main());
