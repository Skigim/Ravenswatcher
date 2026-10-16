'use strict';
// The settings-instance -> binding-object -> live-value chain, and the
// one-sweep index over every live GlobalValue.

import * as fs from 'fs';
import * as path from 'path';
import { scanPointers } from './scan';
import type { ScanSource } from './scan';
import * as rtti from './rtti';
import type { ByteSource } from './pe';

// Struct layout, read from the one file that holds it. discover_values.py
// reads the same JSON, so a stale copy is not something either side can have
// -- there is only one copy. BINDING_VTABLE_RVA is an RVA, not an absolute
// address; add a freshly-queried module base.
//
// Loaded with readFileSync rather than imported so the module needs no
// resolveJsonModule and the file stays a plain data file both languages read.
const STRUCT_OFFSETS_PATH = path.join(__dirname, 'struct_offsets.json');

const STRUCT_OFFSETS: Record<string, number> = (() => {
  const raw = JSON.parse(
    fs.readFileSync(STRUCT_OFFSETS_PATH, 'utf8'),
  ) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_')) continue;
    // Hex STRING, deliberately. parseInt(152, 16) is 338 -- a JSON number
    // would be reinterpreted as hex and yield a plausible wrong offset
    // instead of failing, which is the one error this file cannot afford.
    if (typeof v !== 'string' || !/^0x[0-9a-fA-F]+$/.test(v)) {
      throw new Error(
        `${STRUCT_OFFSETS_PATH}: ${k} must be a hex string like "0x68", got ${JSON.stringify(v)}`);
    }
    out[k] = parseInt(v, 16);
  }
  return out;
})();

// Every name this module needs out of that file is read through here, so a
// rename on the Python side, or a key lost in an edit, is a startup error
// naming the key rather than an address silently built from NaN.
function requiredOffset(name: string): number {
  const v = STRUCT_OFFSETS[name];
  if (v === undefined) throw new Error(`${STRUCT_OFFSETS_PATH}: missing required offset ${name}`);
  return v;
}

const BINDING_VTABLE_RVA = requiredOffset('BINDING_VTABLE_RVA');
const NAME_PTR_OFFSET = requiredOffset('NAME_PTR_OFFSET');
const DEFAULT_VAL_OFFSET = requiredOffset('DEFAULT_VAL_OFFSET');
const BINDING_VTABLE_OFFSET = requiredOffset('BINDING_VTABLE_OFFSET');
const UNION_OFFSET_BINDING = requiredOffset('UNION_OFFSET_BINDING');

const TYPE_FLOAT = 0, TYPE_INT = 1, TYPE_BOOL = 2;
const TYPE_NAMES: Record<number, string> = { 0: 'Float', 1: 'Int', 2: 'Bool' };

const GEN_MARKER = Buffer.from([0x11, 0x11, 0xbb, 0xaa]);

// The type map lives beside main.js in source and packaged builds alike.
// Developers can explicitly override it or supply an extracted GlobalValues
// directory; a normal checkout needs neither the game dump nor Python.
const VALUE_TYPES_JSON = process.env.RAVENSWATCH_VALUE_TYPES
  || path.join(__dirname, '..', 'value_types.json');
const GLOBALVALUES_DIR = process.env.RAVENSWATCH_GEN_ROOT || '';

/**
 * What this module needs from a live process.
 *
 * Extends ScanSource, not just ByteSource: buildIndex calls scanPointers,
 * which enumerates regions and reads into external memory. A file-backed
 * source like PeFileSource has no .regions and cannot do what buildIndex
 * needs, so it must not satisfy this type.
 *
 * Structural on purpose: win32.js is still JavaScript and this file must not
 * depend on its shape beyond what it uses. When win32 is converted, its
 * Process should be checked against this rather than this being loosened to
 * match it.
 *
 * Every read returns `null` for an unreadable address. That is the reader's
 * central rule and it is why these are not plain `number`.
 */
export interface ValueSource extends ByteSource, ScanSource {
  readPtr(addr: number): number | null;
  readI32(addr: number): number | null;
}

/**
 * The outcome of resolving one GlobalValue by name.
 *
 * A discriminated union, and the point is not tidiness. The reading is
 * unreachable without narrowing: there is no `.value` to touch until
 * `status === 'ok'` has been checked, so the "is it zero or is it absent"
 * confusion this file's callers are warned about cannot be written by
 * accident. `strictNullChecks` alone does NOT get you that -- it is happy with
 * `if (!value)` on a `number | null`, which is exactly the bug shape.
 */
export type Resolution =
  | ResolvedValue
  | { readonly status: 'settings instance not found'; readonly name: string;
      readonly instances_scanned: number }
  | { readonly status: 'binding object not found'; readonly name: string;
      readonly settings_addr: string; readonly default_guess: number | null };

/**
 * A binding that was found and read. `status` separates a trustworthy read
 * from one whose union vtable did not match -- the value is still reported
 * for both, because a stale binding still holds the last plausible number and
 * the caller decides whether to believe it.
 *
 * `value` is `number | null` and the null is real: a boxed-int whose box
 * pointer is null has no value to read. Zero is a value.
 */
export interface ResolvedValue {
  readonly status: 'ok' | 'stale-binding';
  readonly name: string;
  readonly settings_addr: string;
  readonly binding_addr: string;
  readonly union_vtable_ok: boolean | null;
  readonly variant: 'inline' | 'boxed-int';
  readonly type: string | null;
  readonly value: number | null;
  readonly default_guess: number | null;
  /**
   * Present only for an inline Float: the undecoded int32 it was read as.
   * `null` when that read failed -- the key is emitted either way.
   */
  readonly raw_i32?: number | null;
}

const f32 = new Float32Array(1);
const i32 = new Int32Array(f32.buffer);

/** Reinterpret an inline int32 read as the float it actually holds. */
export function asFloat(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  i32[0] = value;
  return f32[0] ?? null;
}

/** (display name, type tag) out of one .gen file's trailing type record. */
export function parseGenType(data: Buffer): [string | null, number | null] {
  const i = data.lastIndexOf(GEN_MARKER);
  if (i < 0 || i + 12 > data.length) return [null, null];

  const stringEndingAt = (end: number): [string | null, number | null] => {
    // length 0 is a real case -- unscoped values store an empty scope string.
    for (let length = 0; length < 128; length++) {
      const start = end - length;
      if (start - 4 < 0) break;
      if (data.readUInt32LE(start - 4) !== length) continue;
      if (data.subarray(start, end).every(c => c >= 32 && c < 127)) return [data.subarray(start, end).toString('latin1'), start - 4];
    }
    return [null, null];
  };

  const [, nameEnd] = stringEndingAt(i);
  if (nameEnd === null) return [null, null];
  const [name] = stringEndingAt(nameEnd);
  return [name, data.readUInt32LE(i + 8)];
}

export function typesFromGen(dir: string = GLOBALVALUES_DIR): Record<string, number> {
  const out: Record<string, number> = {};
  if (!dir) return out;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true, recursive: true }); }
  catch { return out; }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.gen')) continue;
    let data: Buffer;
    try { data = fs.readFileSync(path.join(e.parentPath, e.name)); }
    catch { continue; }
    const [name, tag] = parseGenType(data);
    if (name && tag !== null && TYPE_NAMES[tag] !== undefined && !(name in out)) out[name] = tag;
  }
  return out;
}

let _valueTypes: Record<string, number> | null = null;
/**
 * display name -> type tag.
 *
 * Merged, not chosen. Picking the .gen
 * tree whenever it yields anything would let a PARTIAL extraction beat the
 * complete JSON, and a name missing from a half-extracted tree would read as
 * untyped, silently mistyping a Float as an Int rather than failing visibly.
 * The tree still wins per name, so a re-extraction after a patch overrides a
 * stale bundled entry; the JSON only fills gaps.
 */
export function valueTypes(): Record<string, number> {
  if (_valueTypes === null) {
    const built: Record<string, number> = {};
    try {
      const j = JSON.parse(fs.readFileSync(VALUE_TYPES_JSON, 'utf8')) as Record<string, unknown>;
      for (const [k, v] of Object.entries(j)) {
        if (typeof v === 'number' && TYPE_NAMES[v] !== undefined) built[k] = v;
      }
    } catch { /* absent or unreadable: the live chain still works untyped */ }
    Object.assign(built, typesFromGen());
    _valueTypes = built;
  }
  return _valueTypes;
}

/**
 * Decode a settings instance's display name.
 *
 * Not a std::string -- a {const char *data; uint32 len; uint32 flags} triple,
 * with the length at +0x70 carrying 0x80000000 for the static-literal case.
 */
export function readSettingsName(proc: ValueSource, settingsAddr: number): string | null {
  const field = proc.read(settingsAddr + NAME_PTR_OFFSET, 0x10);
  if (!field || field.length < 0x10) return null;
  const ptr = field.readUInt32LE(4) * 4294967296 + field.readUInt32LE(0);
  const length = field.readUInt32LE(8) & 0x7FFFFFFF;
  if (ptr > 0x10000 && length > 0 && length <= 256) {
    const raw = proc.read(ptr, length);
    if (!raw || raw.length < length) return null;
    if (raw.subarray(0, length).some(c => c > 0x7f)) return null;
    return raw.toString('latin1');
  }
  return null;
}

function hex(n: number): string { return '0x' + n.toString(16); }

/** The two reads a held binding needs, and nothing else. */
export interface BindingSource {
  readPtr(addr: number): number | null;
  readI32(addr: number): number | null;
}

/**
 * The raw int32 in a binding's union slot, for a variant already decided.
 *
 * The one copy of the union layout. readBinding decides the variant from the
 * tag slot once per sweep; the 250 ms poll and the Sandman gate reuse that
 * decision through pollBinding.
 */
function readUnionSlot(proc: BindingSource, bindingAddr: number,
                       variant: 'inline' | 'boxed-int'): number | null {
  const tagSlotAddr = bindingAddr + UNION_OFFSET_BINDING + 0x08;
  if (variant === 'inline') return proc.readI32(tagSlotAddr + 0x08);
  const boxPtr = proc.readPtr(tagSlotAddr);
  return boxPtr ? proc.readI32(boxPtr) : null;
}

/**
 * The live value at a binding the sweep has already read once.
 *
 * `variant` and `isFloat` are what that read decided: Bool and Float share
 * the inline slot and its runtime tag, and only the .gen type says which.
 */
export function pollBinding(proc: BindingSource, bindingAddr: number,
                            variant: string | null, isFloat: boolean): number | null {
  const inline = variant === 'inline';
  const raw = readUnionSlot(proc, bindingAddr, inline ? 'inline' : 'boxed-int');
  return inline && isFloat ? asFloat(raw) : raw;
}

/** Read the live value out of an already-located binding object. */
export function readBinding(
  proc: ValueSource,
  name: string,
  settingsAddr: number,
  bindingAddr: number,
  unionVtableAbs: number | null,
  defaultVal: number | null = null,
): ResolvedValue {
  const unionVt = proc.readPtr(bindingAddr + UNION_OFFSET_BINDING);
  const tagSlot = proc.readPtr(bindingAddr + UNION_OFFSET_BINDING + 0x08);

  const valueType = valueTypes()[name];

  // Inline: bool and float both live here, both tagged 4. tagSlot > 0 keeps
  // an uninitialised null box pointer (0) from being read as an inline value.
  const variant = (tagSlot !== null && tagSlot > 0 && tagSlot <= 32) ? 'inline' : 'boxed-int';
  const value = readUnionSlot(proc, bindingAddr, variant);

  const unionVtableOk = unionVtableAbs ? unionVt === unionVtableAbs : null;
  const status = (unionVtableAbs && unionVt !== unionVtableAbs) ? 'stale-binding' : 'ok';

  const base = {
    name,
    status,
    settings_addr: hex(settingsAddr),
    binding_addr: hex(bindingAddr),
    union_vtable_ok: unionVtableOk,
    variant,
    type: valueType === undefined ? null : (TYPE_NAMES[valueType] ?? null),
    default_guess: defaultVal,
  } as const;

  if (variant === 'inline' && valueType === TYPE_FLOAT) {
    return { ...base, value: asFloat(value), raw_i32: value };
  }
  return { ...base, value };
}

export class ValueIndex {
  constructor(
    readonly proc: ValueSource,
    readonly base: number,
    readonly settingsVt: number,
    readonly unionVt: number | null,
    readonly bindingVt: number | null,
    readonly names: Map<string, number>,
    readonly bindings: Map<number, number>,
  ) {}

  resolve(name: string): Resolution {
    const settingsAddr = this.names.get(name);
    if (settingsAddr === undefined) {
      return { status: 'settings instance not found', name, instances_scanned: this.names.size };
    }
    const defaultVal = this.proc.readI32(settingsAddr + DEFAULT_VAL_OFFSET);
    const bindingAddr = this.bindings.get(settingsAddr);
    if (bindingAddr === undefined) {
      return { status: 'binding object not found', name,
        settings_addr: hex(settingsAddr), default_guess: defaultVal };
    }
    return readBinding(this.proc, name, settingsAddr, bindingAddr, this.unionVt, defaultVal);
  }
}

/**
 * One scan -> every settings instance keyed by name, plus its binding object.
 *
 * Nothing here caches; the caller holds the returned ValueIndex and decides
 * when to pay for another scan. sweeper.js keeps one across sweeps and
 * rebuilds on the signals named at its indexRebuildDue -- measured
 * 2026-09-15, every tracked binding held its address across a full run's
 * level-ups and value churn, so a scan per sweep was a 1.7 GB heap pass
 * answering a question that no longer changes. resolve() on a held index is
 * still three reads, and readBinding's union-vtable check is what tells a
 * held address that has gone stale from one that is live.
 */
export function buildIndex(
  proc: ValueSource,
  base: number,
  settingsVt: number | null = null,
  unionVt: number | null = null,
  bindingVt: number | null = null,
): ValueIndex | null {
  if (settingsVt === null || unionVt === null) {
    const rvas = rtti.resolveVtableRvas(proc, base);
    if (settingsVt === null && rvas.oCGlobalEntityValueSettings != null) {
      settingsVt = base + rvas.oCGlobalEntityValueSettings;
    }
    if (unionVt === null && rvas.oCEntityValueUnion != null) {
      unionVt = base + rvas.oCEntityValueUnion;
    }
  }
  if (bindingVt === null) bindingVt = base + BINDING_VTABLE_RVA;
  if (settingsVt === null) return null;

  const targets = bindingVt ? [settingsVt, bindingVt] : [settingsVt];
  const found = scanPointers(proc, targets,
    { writableOnly: true, withPrev: bindingVt ? [bindingVt] : [] }) as Map<number, unknown[]>;

  const names = new Map<string, number>();
  const settingsAddrs = new Set<number>();
  for (const inst of (found.get(settingsVt) ?? []) as number[]) {
    settingsAddrs.add(inst);
    const n = readSettingsName(proc, inst);
    if (n && !names.has(n)) names.set(n, inst);
  }

  const bindings = new Map<number, number>();
  if (bindingVt) {
    // A binding-vtable hit sits at binding+0x20; the settings pointer the
    // binding owns is the qword right before it at binding+0x18, already
    // harvested from the same buffer by withPrev.
    for (const [vtAddr, settingsPtr] of (found.get(bindingVt) ?? []) as [number, number][]) {
      if (settingsAddrs.has(settingsPtr) && !bindings.has(settingsPtr)) {
        bindings.set(settingsPtr, vtAddr - BINDING_VTABLE_OFFSET);
      }
    }
  }

  return new ValueIndex(proc, base, settingsVt, unionVt, bindingVt, names, bindings);
}

export {
  STRUCT_OFFSETS,
  BINDING_VTABLE_RVA, TYPE_FLOAT, TYPE_INT, TYPE_BOOL, TYPE_NAMES,
  NAME_PTR_OFFSET, DEFAULT_VAL_OFFSET, BINDING_VTABLE_OFFSET, UNION_OFFSET_BINDING,
  VALUE_TYPES_JSON, GLOBALVALUES_DIR,
};
