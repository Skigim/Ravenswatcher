# Sandman shop readout

Showing the player what the Sandman currently has in stock, so they can decide
whether a run back to him is worth the time. The decision needs three things on
screen: the six items on offer, their prices, and the player's Dream Shard
balance.

All three are solved. The six live offers read straight off the shop menu
controller, which carries a fixed array of the six on-screen slots. Each slot
points at the UI cell drawing it, and the cell points at the catalog record.

Status as of 2026-09-03. The offers are not on `oCDtEntityCpntMagicalObject` at
all — that component was exhausted and every per-instance field on it ruled out
against ground truth. The offers live on the UI grid:
`oCDtEntityCpntSandmanMenuUiController + 0x178` is the six-slot array, slot
`+0x08` is the cell's `MagicalObjectUiViewerEntityCpnt`, and viewer `+0x0f0` is
the `oCDtEntityCpntMagicalObject` that cell displays. Per-slot purchase state
reads off the same cell at `+0x5e0`. Verified against six-item ground truths
read off the screen across two shop rolls and one live purchase.

## Vocabulary

The Sandman sells **Dreams**. Some Dreams are magical objects and some are not:
`Major Shaping` duplicates an object the player owns, while `Raven Claw` *is* an
object. Both appear in the same shop grid at the same kind of price, and the
distinction shows up in the icon naming rather than anywhere structural.

## What is readable now

All of this comes off the GlobalValue sweep the reader already runs. It costs
nothing beyond a sweep that happens anyway, and needs no new offsets.

| GlobalValue name | reading | note |
| --- | --- | --- |
| `Current dream shards count` | 74 | the balance the player spends |
| `Is in sandman shop` | 1 | 1 while the shop menu is open |
| `Reroll count` | 0 | |
| `Is_Sandman_Free_Purchase_Available` | 1 | Bool |
| `Is Hero liked by Sandman` | 0 | |
| `Can_Refill_Sandman_Dreams` | 0 | Bool |
| `Dream Shard Costs Modifier` | `0x3F800000` | float `1.0` |
| `GameModifier : One Free Reroll` | 1 | Bool |
| `GameModifier : Dream shards at start` | 0 | Bool |

Spelling is not guessable and not consistent. `Is in sandman shop` is lowercase
mid-name while `Is_Sandman_Free_Purchase_Available` is snake_case. Filter the
live index case-insensitively on a stem; never grep for a guessed spelling.

Four of these read untyped because `tools/value_types.json` has no entry for
them, and `Dream Shard Costs Modifier` therefore surfaces as raw float bits
rather than `1.0`. Adding type entries is a prerequisite for displaying any of
them.

`Reroll count` does not mean rerolls remaining — one session watched it go
6 → 5 → 7 → 3, both directions. Its semantics are still unknown; do not build
a reroll-budget display on it without confirming what changes it.

**Finding these took one call.** `values.buildIndex(proc, base)` returns
`.names`, every live GlobalValue keyed by name, in about 1.5 s. The live index
held 434 names; `value_types.json` holds 201. That file is a type map, not a
census — absence from it means untyped, not absent. Enumerate the live index
before proposing any offset work.

## The static registry

Prices and effects are authored, not rolled, so they can be read off disk once
and never read again at runtime.

Dream definitions live in `Ravenswatch decoded/EntitySettings/Objects/` as
`Magical_Objects!Powerups!Power_Up_Sandman_*.gen`. Each carries `Powerup Price`,
`Flags`, `Debug Name`, `Name Value` and an icon path. Read a field as an i32 at
**the second occurrence of the field name, plus the field name's own byte
length, plus 0x28** — use `rfind` for the occurrence, because the first
occurrence is the `[Value] <Model>\<Field>` label and reads 0. Concretely, for
`Powerup Price` (13 bytes): `rfind("Powerup Price") + 13 + 0x28`. Verified
against Rapid Shaping (150) and Sand of Enlightenment (250).

| Dream | effect | price |
| --- | --- | --- |
| Gingerbread Man | heal a % of max health | 50 |
| Star Fragment | reroll the shop's offers | 50 |
| Dream of Power | strength for N seconds | 75 |
| Dream of Invulnerability | shield worth a % of max health | 75 |
| Minor Shaping | copy a Common object already owned | 100 |
| Rapid Shaping | copy a Common, Rare or Epic object already owned | 150 |
| Major Shaping | copy a Rare object already owned | 200 |
| Sand of Knowledge | upgrade two random talents | 200 |
| Grandiose Shaping | copy an Epic object already owned | 250 |
| Sand of Enlightenment | upgrade a talent to Legendary | 250 |

That is ten Dreams, not nine — Star Fragment (`Power_Up_Sandman_Minor_Reroll`)
was missing from the first pass at this table.

`Name Value` is a localization key (`Text`, or a specific key like
`Sandman_Reroll_Name`), not the display string — resolve it through the text
table below, never print it directly. `Debug Name` is the stable identifier,
but it can diverge from the display spelling: Sand of Enlightenment's debug
name is `Sand_Of_Enlightment` — the game drops the second "en".

Display names and descriptions are in
`Ravenswatch decoded/Text/Magical_Objects~GAM.xls.LocalText.gen.LangEN`, a flat
run of NUL-terminated ASCII alternating name and description. The Dream entries
sit contiguously in that table, and ordinary magical objects (`Raven Claw`,
`Ace of Spades Card`) sit elsewhere in the same file.

Icons are in `Ravenswatch decoded/Ui/Objects/` and their prefixes carry the
object/Dream split directly:

- `Icon_Object_RavenClaw`, `Icon_Object_AceCard` — ordinary objects
- `Icon_PowerUpSandman_MajorShaping`, `_Enlightenment`, `_StarFragment` — Dreams
- `Icon_PowerUp_GingerbreadMan` — powerup

Because the shop mixes both kinds, the static registry alone cannot tell you
what is in stock on a given night.

## Live structure that is established

**The anchor is singular.** `oCDtEntityCpntSandmanMenuUiController` has one
vtable and exactly one live instance. `oCDtEntityCpntHeroController` returned 3
instances in the same run as a control, so a zero here would have been
meaningful rather than a broken scan.

Controller layout:

| offset | contents |
| --- | --- |
| `+0x008` | `oCEntity` |
| `+0x010` | Settings |
| `+0x0c0` | `oCDtGameScene` |
| `+0x128` | `MagicalObjectUiViewerEntityCpnt` |
| `+0x130` | `SkillUiViewerEntityCpnt` |
| `+0x138`–`+0x168` | seven `oCDtEntityCpntMagicalObjectsDrop` pointers |
| `+0x178`–`+0x238` | the six on-screen shop slots, stride `0x20` |

The seven drop pointers are a fixed slot array over one contiguous 0x298-stride
allocation, stored out of allocation order.

**The seven slots are authored generators, not stock.** Each names itself at
`slot +0x10 (MagicalObjectsDropSettings) +0xe8 -> char*`, and carries a
filter flag at `+0x10 +0x58 (ValuePicker) +0xe8 -> holder +0x00 -> char*`
(read live 2026-09-17, `bench/sandman-refill-probe.js`):

| slot | generator | flag |
| --- | --- | --- |
| 0 | `Minor Offer Gen` | `Sandman; Minor` |
| 1 | `Medium Offer Gen` | `Sandman; Medium` |
| 2 | `Medium Offer Gen Duplicate` | `Sandman; MediumDuplicate` |
| 3 | `Medium Offer Gen Object` | empty |
| 4 | `Major Offer Gen` | `Sandman; Major` |
| 5 | `Major Offer Gen Duplicate` | `Sandman; MajorDuplicate` |
| 6 | `Major Offer Gen Object` | empty |

The two `Object` generators have no flag: their holder points at the image's
empty string. The flags say what a generator may roll, not what it rolled.

**Each generator holds two item lists.** `slot +0x230` points at an object
whose fields are the catalog `oCDtEntityCpntMagicalObject` instances for that
tier (long-lived, low addresses). `slot +0x250` points at an object holding
fresh per-run instances, and the six cells bind into those. Both lists are
populated before the shop is first opened and unchanged after it closes, so
the roll happens at map load, not on open. The `+0x250` lists carry more
entries than the cells show (Minor held four with two on screen), and two
cells in the same read were reached through other offsets, so the lists are
a lead on what will be stocked, not a per-cell answer.

**The viewer at `+0x128` is the detail panel**, not a grid cell. It carries
`EntityCpntValueSignal<oCTStr<char>>` name and description signals plus an int
signal, and it tracks whichever item the player is currently hovering or
selecting. `+0x130` is its skill-side counterpart. The grid's own cells are
separate instances of the same viewer class, reached through the slot array 16
bytes further on; see The offers, solved.


**The settings pool is readable and named.** Live `Dt Magical Object Data`
records sit together on the heap with their field names beside them: `Powerup
Price`, `Name Value`, `Icon Value`, `Flag Value`, `Quality Value`, `Can Buy
Condition`, `Debug Name`, `Descripton Format` (the typo is the game's — grep for
it as spelled).

**Per-instance fields on `oCDtEntityCpntMagicalObject` are readable.**
`oCDtEntityCpntMagicalObject` has a real RTTI vtable, registered in
`RTTI_NAMES`. `scanPointers` against it finds every live instance directly —
142 in one run, in the same range as the earlier 168 census. Each instance
holds listener pointers: read `listener = readPtr(instance + offset)`, then
`value = *(listener + 0x08)`.

| offset | field | value shape |
| --- | --- | --- |
| `+0x010` | settings pointer | `oCDtEntityCpntMagicalObjectSettings` |
| `+0x148` | Debug Name | `char*` |
| `+0x168` | Name Value | `char*` |
| `+0x1a8` | Flag Value | `char*` |
| `+0x1e8` | Powerup Price | `int32` |
| `+0x1f8` | Can Buy Condition | `int32`/bool |
| `+0x1c8` | object-rarity gate — not stock, see `ruled_out.md` | `int32`/bool |

Debug Name, Name Value and Powerup Price read correctly for every catalog
Dream seen, matching the static registry above exactly — including the
`Sand_Of_Enlightment` debug-name spelling. Unlike the static `.gen` field, the
live Name Value listener already holds the resolved display string
(`Dream of Power`, not a loc key) — the loc-key caveat above is for the file,
not this listener.

**Powerup Price is the undiscounted price.** Measured on two purchases in one
visit: Gingerbread Man listed 50, charged 45; Dream of Invulnerability listed
75, charged 68. Both are about 10% under the `+0x1e8` field the readout
prints. The discount is not on the shop cell. The lead is the Dreamcatcher
magical item, read off the hero's item list; confirming its copy count is
parked in `deferred_investigations.md`. Nothing else in the shop panel is
wrong.

## Ruled out

The probes that were tried and closed — string walks from the controller,
pointer-proximity clustering, `Can Buy Condition`, `Flag Value`, the `+0x1c8`
listener — are in `ruled_out.md` under "Sandman shop", each with its control
and measurement.

## The offers, solved

The offers are not stored on the item. They are stored on the UI cell that
draws the item, and the cell holds a plain pointer back to the catalog record.
The controller names those six cells directly, so no scan of the cell class is
needed to find them.

**The slot array.** `oCDtEntityCpntSandmanMenuUiController + 0x178` is a fixed
array of the six shop slots, stride `0x20`, running to `+0x238`. Slot index 0
through 5 is the on-screen grid in reading order, `MO_slot_1` top-left through
`MO_slot_6` bottom-right.

| slot offset | contents |
| --- | --- |
| `+0x00` | `oCUINavigable*` — this slot's focus node |
| `+0x08` | `MagicalObjectUiViewerEntityCpnt*` — the grid cell |
| `+0x10` | `oCDtEntityCpntMagicalObjectsDrop*` — the slot's tier bucket |
| `+0x18` | `0` |

The controller is singular, so one `scanPointers` against its vtable finds the
whole grid. Read the six slots and stop; there is no filtering step.

**Where the cells come from.** The Sandman blueprint names six UI cells,
`MO_slot_1` through `MO_slot_6`, inside an `MO_Frame` navigation zone. Each
spawns `GameUis\Items\Magical_Object_Miniature_Price`, a thin wrapper over
`GameUis\Items\Magical_Object_Miniature`. That prefab carries its own
`MagicalObjectUiViewerEntityCpnt`, a separate instance from the detail-panel
viewer at controller `+0x128`.

**The class.** Mangled name `.?AVMagicalObjectUiViewerEntityCpnt@dt@oe@@`,
one vtable. The class is shared with inventory, level-up and hover miniatures,
which is why reaching the grid through the slot array matters: a class-wide
scan returns roughly 17 live instances with the shop open and has to be sorted
out afterwards, while the slot array returns exactly the six that are drawn.

**The link.** `+0x0f0` on the viewer is a direct pointer to a live
`oCDtEntityCpntMagicalObject`, not a listener. Dereference it and the existing
field layout gives name and price with no further work. Check the pointer's
vtable against the catalog class before trusting it; an unbound slot leaves
stale bytes there.

**Purchase state is on the cell, not the item.** Measured across buying
`Star Fragment` for 50 shards. The catalog instance does not change at all —
it is byte-identical before and after — and `viewer +0x0f0` keeps pointing at
the item, so the slot still knows what it sold. Two fields announce the sale:

- `viewer +0x5e0`, int32, reads exactly `256` (`0x100`) once bought — byte
  `+0x5e1` set to 1. Across the cell prefab's full 14,592-byte allocation this
  is the only integer that uniquely marks the purchased slot. **Test for
  `=== 0x100`, never for non-zero.** Unbought cells carry unrelated metadata in
  the high bytes `+0x5e2`–`+0x5e3` (`0x3F000000` was seen), which read as sold
  under a `!== 0` test and put a false SOLD on slots 0, 3 and 4.
- `nav +0x10` on that slot's `oCUINavigable` clears to `0`, dropping the slot
  out of gamepad and keyboard focus. Every unsold slot still holds a valid
  neighbour link.

Either one identifies the sold slot; `+0x5e0` is the cheaper read since the
viewer is already in hand.

**Verified against ground truth, twice, across a reroll.** First roll, screen
showing Dream of Invulnerability, Gingerbread Man, Minor Shaping, Fairy Dust,
Sand of Enlightenment and Grandiose Shaping: the bound cells named exactly
those six at 75, 50, 100, 150, 250 and 250 shards. After a reroll to Dream of
Power, Dream of Invulnerability, Minor Shaping, Sand of Knowledge, Raven Skull
and Grandiose Shaping: exactly those six at 75, 75, 100, 200, 250 and 250.

The reroll is the test that matters. All three dropped items — Gingerbread
Man, Fairy Dust, Sand of Enlightenment — disappeared from the readout
completely, and the three new ones appeared. The cells follow stock rather
than lagging it. In both runs no item outside the offer list appeared at all,
with 168 other catalog records live and none bound to a cell.

**Duplicates need no special handling.** The blueprint has `Medium Offer Gen
Duplicate` and `Major Offer Gen Duplicate` components, so the same Dream may be
able to fill two slots. Reading by slot index is indifferent to that: two slots
pointing at one catalog record read as two offers, which is what the screen
shows. Never deduplicate the six by catalog pointer.

The grid is torn down and rebuilt on each roll, so cell and catalog pointers are
valid only within a single read. The controller outlives the grid: it is
findable with all six cells empty for the whole map (watched 2026-09-17 from
before the shop was opened until the map ended), so it is worth holding for
the map and re-verifying by vtable, with the heap scan only when it is lost.

## Probes kept

These probes are general enough to keep. They are investigation tools; the
shipped read path is `app/reader/sandman.ts`, which goes through the controller
slot array and needs none of them.

- `node app/reader/bench/values-by-keyword.js sandman dream shard` — every live
  GlobalValue matching a keyword, with its reading. Run this first, before any
  offset work.
- `node app/reader/bench/string-presence.js "Raven Claw"` — is this string in
  the process at all. The control that makes a zero-hit walk mean something.
  Matches whole NUL-terminated strings only, so ABSENT means "nothing is
  exactly this", not "this text does not appear" — an icon basename stored
  inside a longer path reads ABSENT.
- `python tools/dump_text_table.py <file.LangEN> --find "Raven Claw"` — the
  display-name table with its ordering intact, which is what separated the
  Dream pool from the ordinary objects.
- `node app/reader/bench/sandman-offers.js --offer <name|alias>... --control
  <name|alias>...` — display name → string → holder (settings record) →
  referrer, with `|`-separated aliases per item for debug-name spelling
  divergence. Refuses to run without at least one control. Hop 1 (strings) and
  hop 2 (holders) are reliable; do not trust its clustering past hop 2 — see
  the pointer-proximity addendum above.
- `node app/reader/bench/sandman-magicalobject-scan.js [--force] [--strict]` —
  enumerates every live `oCDtEntityCpntMagicalObject` instance and prints its
  Debug Name, Name Value, Flag Value, Powerup Price and Can Buy Condition.
  Debug Name / Name Value / Powerup Price are verified-correct. Flag Value and
  Can Buy Condition are not offer signals (see `ruled_out.md`), so ignore the
  script's own "candidate" summary — it just reprints every catalog Dream
  present, not a shortlist. `--strict` exits instead of scanning when the shop
  is closed; the default scans anyway, since instance presence doesn't depend
  on the shop being open.
- `node app/reader/bench/sandman-field-vs-truth.js --offer "<name|alias>"...
  [--field 0x1c8]` — tests one candidate per-instance field against a
  ground-truth offer list typed off the screen. Refuses to run without
  `--offer`, and aborts when `Is in sandman shop` is 0 unless `--force`.
  Prints the three disqualification tests the section above applies: does the
  field vary within one item type, does any value partition the offer list,
  and do offered and not-offered instances of one tier read differently.
  Point it at a new class by editing the vtable name; the tests are generic.
- `node app/reader/bench/rtti-names.js <regex>` — every MSVC RTTI type
  descriptor name in `.data` matching the regex, about 5100 unique names in
  under a tenth of a second. Use it instead of guessing a mangled name before
  calling `rtti.resolveAllVtableRvas`.
- `node app/reader/bench/sandman-cell-scan.js [--class C] [--dump]` — a
  class-wide sweep of the cell viewer, kept for inspecting viewers that are not
  the shop grid. It is no longer how the offers are read; for those, the slot
  array is authoritative and `app/reader/sandman.ts` is the reference
  implementation. Enumerates the cell viewer class, groups instances by owning
  prefab, resolves `+0x0f0` to a named catalog record with its price, and
  diffs the int32 fields across the grid group so a dead pooled cell is
  visible. `--class` points it at any other viewer; `--dump` adds the full
  pointer field table per instance.

## Costs

- Live GlobalValue index, 434 names: ~1.5 s
- RTTI vtable resolve: 16–19 ms per class
- `scanPointers` over 5 vtable targets: ~1.2 s, the same order as the melody
  channel's 1.3 s
- Reading all six offers: one `scanPointers` for the controller vtable, then 6
  slots × 4 pointer reads. No class-wide cell scan, no heap sweep.
- Process-wide string search, 7130 regions / 5.4 GB: one pass, minutes

Stock cannot change without a purchase or a reroll, so whatever resolves the
offers does not need to run every sweep. `Is in sandman shop` and `Reroll count`
are both cheap enough to gate it on.

## Access

Everything above is read-only: `PROCESS_QUERY_INFORMATION | PROCESS_VM_READ`,
no `VM_WRITE`, no injection, no elevation.
