// Pure procfs helpers for the Linux backend. Nothing here touches a live
// process except through an injectable proc root (default '/proc'), so the
// parsers and discovery are unit-testable on any platform against a fixture
// directory.
//
// Addresses are plain JS Numbers. A user-mode mapping is far below 2^53; the
// kernel-side [vsyscall] page (ffffffffff600000) is not, and is skipped rather
// than allowed to lose precision.

import * as fs from 'fs';
import * as path from 'path';
import type { ModuleInfo } from './process';

export const DEFAULT_PROC_ROOT = '/proc';

export interface MapEntry {
  start: number;
  end: number;
  /** e.g. 'rw-p' */
  perms: string;
  offset: number;
  /** Pathname column, '' for anonymous mappings. May contain spaces. */
  path: string;
}

// 2^53 is 0x20000000000000: 14 hex digits. Anything longer than 14 digits
// (after leading zeros) is out of range; a 14-digit value is checked by value.
function safeHex(hex: string): number | null {
  const trimmed = hex.replace(/^0+(?=.)/, '');
  if (trimmed.length > 14) return null;
  const n = parseInt(trimmed, 16);
  return Number.isSafeInteger(n) ? n : null;
}

const MAPS_LINE = /^([0-9a-fA-F]+)-([0-9a-fA-F]+)\s+(\S{4})\s+([0-9a-fA-F]+)\s+\S+\s+\d+\s*(.*)$/;

/** Parse the text of /proc/<pid>/maps. Lines with an unsafe address are skipped. */
export function parseMaps(text: string): MapEntry[] {
  const out: MapEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const m = MAPS_LINE.exec(line);
    if (!m) continue;
    const start = safeHex(m[1] ?? '');
    const end = safeHex(m[2] ?? '');
    const offset = safeHex(m[4] ?? '');
    if (start === null || end === null || offset === null) continue;
    out.push({ start, end, perms: m[3] ?? '', offset, path: (m[5] ?? '').trim() });
  }
  return out;
}

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i < 0 ? p : p.slice(i + 1);
}

/**
 * Does this process look like `exeName`? Matches /proc/<pid>/comm (trimmed;
 * the kernel truncates it to 15 characters, so a truncated prefix of the name
 * also matches) or the basename of argv[0] from cmdline, which under Wine may
 * be a Windows path.
 */
export function matchesExe(comm: string, cmdline: string, exeName: string): boolean {
  const target = exeName.toLowerCase();
  const c = comm.trim().toLowerCase();
  if (c) {
    if (c === target) return true;
    if (c.length >= 15 && target.startsWith(c)) return true;
  }
  const argv0 = cmdline.split('\0')[0] ?? '';
  return !!argv0 && baseName(argv0).toLowerCase() === target;
}

// Pathnames in procfs are the filesystem's raw bytes, which on Linux are
// UTF-8: latin1 would turn /home/André into /home/AndrÃ© and send asset
// loading to a directory that does not exist.
function readText(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/** The text of /proc/<pid>/maps, decoded as UTF-8. Throws the fs error. */
export function readMaps(pid: number, root: string = DEFAULT_PROC_ROOT): string {
  return fs.readFileSync(path.join(root, String(pid), 'maps'), 'utf8');
}

/** Every numeric pid under `root` whose comm/cmdline matches `exeName`. */
export function findPids(exeName: string, root: string = DEFAULT_PROC_ROOT): number[] {
  let names: string[];
  try { names = fs.readdirSync(root); } catch { return []; }
  const pids: number[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const comm = readText(path.join(root, name, 'comm')) ?? '';
    const cmdline = readText(path.join(root, name, 'cmdline')) ?? '';
    if (matchesExe(comm, cmdline, exeName)) pids.push(Number(name));
  }
  return pids.sort((a, b) => a - b);
}

/**
 * The main image: file-backed mappings whose path basename matches `exeName`.
 * base is the lowest offset-0 mapping, size runs to the highest end of any of
 * that file's mappings.
 */
export function moduleFromMaps(maps: MapEntry[], exeName: string): ModuleInfo {
  const target = exeName.toLowerCase();
  const mine = maps.filter(m => m.path.startsWith('/') && baseName(m.path).toLowerCase() === target);
  const zero = mine.filter(m => m.offset === 0).sort((a, b) => a.start - b.start)[0];
  if (!zero) throw new Error(`no mapping of ${exeName} found in the process's memory map`);
  const same = mine.filter(m => m.path === zero.path);
  const end = Math.max(...same.map(m => m.end));
  return { base: zero.start, size: end - zero.start, exePath: zero.path };
}

/**
 * Image names to look up in the maps, in order: argv[0]'s basename, comm,
 * then the exe link's basename. Under Wine the first two name the Windows
 * game while the exe link names Wine's own loader, so once a Windows image
 * (.exe) is named only those names are returned: a game image missing from
 * the maps must fail, not resolve to the loader's ELF base and directory.
 */
export function imageCandidates(cmdline: string, comm: string, exeLink: string): string[] {
  const names: string[] = [];
  const add = (n: string): void => { if (n && !names.includes(n)) names.push(n); };
  add(baseName(cmdline.split('\0')[0] ?? ''));
  add(comm.trim());
  const windows = names.filter(n => /\.exe$/i.test(n));
  if (windows.length) return windows;
  add(baseName(exeLink));
  return names;
}

/** The first of `names` that moduleFromMaps resolves; throws the last failure. */
export function resolveModule(maps: MapEntry[], names: string[]): ModuleInfo {
  let last: unknown = new Error('could not determine the image name');
  for (const name of names) {
    try { return moduleFromMaps(maps, name); } catch (e) { last = e; }
  }
  throw last;
}

/** Field 22 (starttime, clock ticks since boot) of /proc/<pid>/stat. */
export function procStartTime(statText: string): string {
  const close = statText.lastIndexOf(')');
  if (close < 0) throw new Error('malformed /proc stat: no comm terminator');
  // After ')': field 3 (state) onwards, so starttime is index 22 - 3 = 19.
  const fields = statText.slice(close + 1).trim().split(/\s+/);
  const v = fields[19];
  if (v === undefined) throw new Error('malformed /proc stat: too few fields');
  return v;
}

/** Field 3 (state) of /proc/<pid>/stat. */
export function procState(statText: string): string {
  const close = statText.lastIndexOf(')');
  return close < 0 ? '' : (statText.slice(close + 1).trim().split(/\s+/)[0] ?? '');
}
