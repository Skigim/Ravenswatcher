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

function readText(file: string): string | null {
  try { return fs.readFileSync(file, 'latin1'); } catch { return null; }
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
