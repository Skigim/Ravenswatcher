'use strict';
// Sandman shop offer availability channel.
//
// Reads what the Sandman currently offers (items and prices in Dream Shards,
// plus purchased/sold-out state) by reading the singular menu controller
// oCDtEntityCpntSandmanMenuUiController and its fixed 6-slot navigation array
// at +0x178 (stride 0x20).
//
// Each slot directly references its MagicalObjectUiViewerEntityCpnt UI cell
// and oCUINavigable focus node. The cells hold pointers to the bound magical
// objects and listeners for display name and price. The purchased flag at cell
// +0x5e0 is the only confirmed signal, and it is a BYTE: buying sets +0x5e1 to
// 1, leaving the cell's other bytes alone. The dword is not 0x100 when sold --
// a cell carrying metadata reads e.g. 0x1B000100 -- so it is masked, never
// compared whole. nav+0x10 is NOT a sold indicator (measured live
// on 2026-09-04: slot 0 read nav+0x10 == 0 while unbought because it is the
// chain head, and slots 1 and 3 kept their non-zero nav+0x10 after being sold).

import type { ByteSource } from './pe';
import type { ScanSource } from './scan';
import * as rtti from './rtti';
import { scanPointers } from './scan';

// ---- RTTI mangled names (confirmed live) -----------------------------------
export const CONTROLLER_RTTI = '.?AVoCDtEntityCpntSandmanMenuUiController@@\0';
export const MAGICAL_OBJECT_RTTI = '.?AVoCDtEntityCpntMagicalObject@@\0';

// ---- Struct offsets (confirmed live) ---------------------------------------
// Controller layout:
export const CONTROLLER_SLOTS_OFFSET = 0x178;        // 6-element slot array
export const CONTROLLER_SLOT_STRIDE = 0x20;          // 32 bytes per slot
export const SLOT_COUNT = 6;

// Per-slot layout (controller + 0x178 + i*0x20):
export const SLOT_NAV_OFFSET = 0x00;                 // oCUINavigable*
export const SLOT_VIEWER_OFFSET = 0x08;              // MagicalObjectUiViewerEntityCpnt*
export const SLOT_DROP_OFFSET = 0x10;                // oCDtEntityCpntMagicalObjectsDrop*

// UI Cell Viewer layout (MagicalObjectUiViewerEntityCpnt):
export const VIEWER_MAGICAL_OBJECT_OFFSET = 0x0f0;   // pointer to oCDtEntityCpntMagicalObject
export const VIEWER_PURCHASED_OFFSET = 0x5e0;        // sold flag in byte +0x5e1; see readOffers

// UI Navigable layout (oCUINavigable):
export const NAV_NEXT_OFFSET = 0x10;                 // neighbor link (not a sold indicator)

// Catalog item layout (oCDtEntityCpntMagicalObject):
export const MAGICAL_OBJECT_NAME_OFFSET = 0x168;          // listener pointer -> name char*
export const MAGICAL_OBJECT_NAME_FALLBACK_OFFSET = 0x148; // fallback listener pointer -> name char*
export const MAGICAL_OBJECT_PRICE_OFFSET = 0x1e8;         // listener pointer -> price int32
export const LISTENER_PAYLOAD_OFFSET = 0x08;              // payload offset inside listener object

// Minimum address for valid user-space pointers
const MIN_VALID_ADDR = 0x10000;

export interface SandmanSource extends ByteSource, ScanSource {
  readPtr(addr: number): number | null;
  readI32(addr: number): number | null;
}

export interface SandmanOffer {
  readonly name: string | null;
  readonly price: number | null;
  readonly purchased: boolean;
}

// 'pending' -> no shop has been read yet this run. 'ok' -> offers are held,
// whether or not the shop is open right now. 'unresolved' -> the shop is open
// but the grid will not read. There is deliberately no 'closed': the player can
// only act on the shop while it is open, so a held read and a live one are the
// same thing on screen and the panel does not distinguish them.
export type SandmanStatus = 'pending' | 'ok' | 'unresolved';

export interface SandmanVtables {
  controllerVt?: number;
  magicalObjectVt?: number;
}

export interface ResolvedVtables {
  readonly controllerVt: number;
  readonly magicalObjectVt: number;
}

/**
 * Resolve the RTTI vtables needed for Sandman controller and object identification.
 *
 * Mutates the caller-owned `vtables` cache and returns the resolved values,
 * or null if either vtable cannot be found.
 */
export function resolveVtables(
  proc: ByteSource,
  base: number,
  vtables: SandmanVtables = {},
): ResolvedVtables | null {
  let controllerVt = vtables.controllerVt;
  if (!controllerVt) {
    const rva = rtti.resolveAllVtableRvas(proc, base, CONTROLLER_RTTI)[0];
    if (rva !== undefined) controllerVt = base + rva;
  }

  let magicalObjectVt = vtables.magicalObjectVt;
  if (!magicalObjectVt) {
    const rva = rtti.resolveVtableRvas(proc, base, { magicalObject: MAGICAL_OBJECT_RTTI }).magicalObject;
    if (rva != null) magicalObjectVt = base + rva;
  }

  if (!controllerVt || !magicalObjectVt) return null;
  vtables.controllerVt = controllerVt;
  vtables.magicalObjectVt = magicalObjectVt;
  return { controllerVt, magicalObjectVt };
}

/**
 * Find the single live oCDtEntityCpntSandmanMenuUiController instance.
 */
export function findController(
  proc: ScanSource,
  controllerVt: number,
): number | null {
  const hits = scanPointers(proc, [controllerVt], { writableOnly: true });
  const list = ((hits.get(controllerVt) ?? []) as (number | [number, number])[])
    .map(h => (Array.isArray(h) ? h[0] : h));
  return list[0] ?? null;
}

/**
 * Read a NUL-terminated UTF-8 string up to max bytes. The game stores item
 * names as UTF-8: Bloody Mary's Mirror carries a three-byte curly apostrophe.
 */
export function readUtf8String(
  proc: ByteSource,
  addr: number,
  max = 128,
): string | null {
  if (!addr || addr < MIN_VALID_ADDR) return null;
  const buf = proc.read(addr, max);
  if (!buf || buf.length === 0) return null;
  const nulIdx = buf.indexOf(0);
  const slice = nulIdx >= 0 ? buf.subarray(0, nulIdx) : buf;
  if (slice.length === 0) return null;
  return slice.toString('utf8');
}

/**
 * Read item name from oCDtEntityCpntMagicalObject.
 *
 * Listener at item +0x168 holds a char* payload at listener +0x08.
 * Falls back to listener at item +0x148 if +0x168 yields nothing.
 */
export function readItemName(
  proc: SandmanSource,
  itemAddr: number,
): string | null {
  const tryRead = (off: number): string | null => {
    const listener = proc.readPtr(itemAddr + off);
    if (!listener || listener < MIN_VALID_ADDR) return null;
    const strPtr = proc.readPtr(listener + LISTENER_PAYLOAD_OFFSET);
    if (!strPtr || strPtr < MIN_VALID_ADDR) return null;
    return readUtf8String(proc, strPtr);
  };

  return tryRead(MAGICAL_OBJECT_NAME_OFFSET)
    ?? tryRead(MAGICAL_OBJECT_NAME_FALLBACK_OFFSET);
}

/**
 * Read item price in Dream Shards from oCDtEntityCpntMagicalObject.
 *
 * Listener at item +0x1e8 holds the int32 directly at listener +0x08.
 * Zero is a valid price, distinct from null (failed read / unresolved).
 */
export function readItemPrice(
  proc: SandmanSource,
  itemAddr: number,
): number | null {
  const listener = proc.readPtr(itemAddr + MAGICAL_OBJECT_PRICE_OFFSET);
  if (!listener || listener < MIN_VALID_ADDR) return null;
  return proc.readI32(listener + LISTENER_PAYLOAD_OFFSET);
}

/**
 * Read the Sandman shop offers currently displayed.
 *
 * Reads the 6 physical slots from the controller's slot array in on-screen
 * order (0 = top-left to 5 = bottom-right).
 *
 * Returns an array of 6 SandmanOffer, or null if vtables/controller are unresolved
 * or if no shop slots are currently bound to items.
 */
export function readOffers(
  proc: SandmanSource,
  vtables: SandmanVtables | null,
  controllerAddr: number | null = null,
): SandmanOffer[] | null {
  if (!vtables || !vtables.controllerVt || !vtables.magicalObjectVt) return null;

  const ctrl = controllerAddr ?? findController(proc, vtables.controllerVt);
  if (!ctrl || ctrl < MIN_VALID_ADDR) return null;

  const offers: SandmanOffer[] = [];
  let boundCount = 0;

  for (let i = 0; i < SLOT_COUNT; i++) {
    const slotBase = ctrl + CONTROLLER_SLOTS_OFFSET + i * CONTROLLER_SLOT_STRIDE;
    const viewer = proc.readPtr(slotBase + SLOT_VIEWER_OFFSET);

    if (!viewer || viewer < MIN_VALID_ADDR) {
      offers.push({ name: null, price: null, purchased: false });
      continue;
    }

    const itemCandidate = proc.readPtr(viewer + VIEWER_MAGICAL_OBJECT_OFFSET);
    let item: number | null = null;
    if (itemCandidate && itemCandidate >= MIN_VALID_ADDR) {
      const vt = proc.readPtr(itemCandidate);
      if (vt === vtables.magicalObjectVt) {
        item = itemCandidate;
      }
    }

    const name = item ? readItemName(proc, item) : null;
    const price = item ? readItemPrice(proc, item) : null;

    // Purchased signal: buying sets BYTE +0x5e1 to 1. Test that byte, never the
    // whole dword -- the cell's high bytes carry unrelated metadata and are not
    // zero on every cell.
    //
    // Measured live 2026-09-04 with bench/sandman-purchase-flag.js, timestamped
    // from outside by the dream-shard drop:
    //
    //   Dragon Hide,   slot 3, shards 226 -> 76:  0x1B000000 -> 0x1B000100
    //   Star Fragment, slot 0, shards 156 -> 106: 0x00000000 -> 0x00000100
    //
    // `flag === 0x100` passes the second and fails the first, which is exactly
    // how this presented: some items went SOLD on screen and others never did,
    // depending only on which cell the game happened to bind them to.
    const flag = proc.readI32(viewer + VIEWER_PURCHASED_OFFSET);
    const purchased = flag !== null && (flag & 0xff00) === 0x100;

    if (name !== null) boundCount++;
    offers.push({ name, price, purchased });
  }

  // If none of the slots are bound to a named item, the shop is not open or not
  // populated yet. Return null so the worker retains the previous read.
  if (boundCount === 0) return null;

  return offers;
}

// The cells take a moment to build when the shop opens, so early empty reads
// are not a fault. 15 s of an open shop that will not read is a fault, not a race.
export const SANDMAN_FAIL_MS = 15000;

/**
 * Derived from what is held rather than latched, so the run-end clear
 * cannot leave a stale 'ok' behind. A shut shop is not a miss: counting it
 * would have the panel calling itself broken for the whole walk between
 * visits. 'unresolved' means the gate says open but the grid will not read,
 * which is the one state that must not look like an empty shop.
 */
export function nextSandmanStatus(
  held: readonly SandmanOffer[] | null,
  shopOpen: boolean,
  elapsedFailMs: number,
): SandmanStatus {
  if (shopOpen && elapsedFailMs >= SANDMAN_FAIL_MS) return 'unresolved';
  return held === null ? 'pending' : 'ok';
}

/** Check whether two Sandman offer arrays (or nulls) differ in any slot. */
export function offersChanged(
  a: readonly SandmanOffer[] | null,
  b: readonly SandmanOffer[] | null,
): boolean {
  if (a === b) return false;
  if (!a || !b) return a !== b;
  if (a.length !== b.length) return true;
  return a.some((oA, i) => {
    const oB = b[i];
    return oB === undefined
      || oA.name !== oB.name || oA.price !== oB.price || oA.purchased !== oB.purchased;
  });
}
