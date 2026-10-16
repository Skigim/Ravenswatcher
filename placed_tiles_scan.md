# Placed tiles readout (the procedural tile graph)

Reading the complete roster of placed map tiles — enemy camps, points of
interest, quest-specific arenas, fast-travel teleporters, and world resources —
out of a running `Ravenswatch.exe` process with exact world coordinates.

Status as of 2026-09-06. The entire procedural tile layout lives in a single
ECS component:

    oCDtEntityCpntTileSpawner (RTTI: .?AVoCDtEntityCpntTileSpawner@@)

With a map loaded there is **exactly 1 live instance** of this component in
memory. It holds contiguous arrays of 88-byte (`0x58`)
`TileSlot` records. Every record provides the tile's authored debug name
(`40x40_Windmill_Farm_Undead_Hogs_Camp`), world position $(X, Y, Z)$, orientation
matrix, tile grid dimensions, and live spawned `oCEntity` instance.

Finding this single instance costs one single-target pointer scan (~840 ms cold,
or 0 ms when cached per map generation), and reading the entire 140+ placed tile
roster costs **~10 ms**.

---

## 1. Scope

The per-run map camp roster, parked in `deferred_investigations.md`: which
specific camps (e.g. `Windmill_Farm_Undead_Hogs_Camp`, `Red_Pits_Neutral_Camp`)
got placed on a run's procedurally generated map. `GlobalValues` carry only step
counters, so the roster needed a target of its own. The tile spawner is that
target.

Questline identification is a separate and finished feature. Nothing here feeds
it, and placed tile names are not a signal for it.

**Coverage.** First measured on Dark Hills (2026-09-04). Confirmed across all
three chapters — Dark Hills, Storm Island, and Avalon — on 2026-09-05/06. Category
counts and slot allocations differ per chapter (detailed in Section 9), but the
underlying `TileSlot` struct layout, pointer arithmetic, and sub-second scan
latency are invariant across the entire game.

---

## 2. RTTI Classes and Live Census

Measured on Dark Hills:

| RTTI Class Name | Vtable RVA | Instances | Role |
|---|---|---|---|
| `.?AVoCDtEntityCpntTileSpawner@@` | `0x00F0CA40` | **1** | Main anchor. Owns all tile slot arrays |
| `.?AVoCDtEntityCpntTileSpawnerSettings@@` | `0x00F0C540` | 1 | Component settings (`"TileSpawner"`, map definition reference) |
| `.?AVoCDtTileSlotSettings@@` | `0x00F10608` | 143 | Spatial slot definitions carrying authored world coordinates |
| `.?AVoCDtTileDefinition@@` | `0x00ED6048` | 237 | Tile resource definitions (matches the 237 `.gen` files counted in `docs/format/tiles.md`) |
| `.?AVoCDtTileSlotSize@@` | `0x00F103A0` | 4 | Size descriptor (`3x3`, `6x6`, `40x40`, `64x64`) |
| `.?AVoCLinkedTile@TileDefInternal@@` | `0x00EFEFB0` | 49 | Adjacency and placement constraints |
| `.?AVoCDtTileKind@@` | `0x00F104C0` | 11 | Tile classification tag. See below — the tag's name offset is not known |

---

## 3. Anchor Object: `oCDtEntityCpntTileSpawner`

### 3.1 Field Layout

Relative to `spawner` base address:

| Offset | Type / Contents | Notes |
|---|---|---|
| `+0x00` | `void*` (vtable) | RVA `0x00F0CA40` |
| `+0x08` | `oCEntity*` | Owning entity |
| `+0x10` | `oCDtEntityCpntTileSpawnerSettings*` | Settings resource |
| `+0x80` | `oCEntitySpawner` | Sub-object referenced by spawned tile entities at `oCEntity + 0x38` |
| `+0x110` | `TileCategorySlice*` | Pointer to outer array of 4 tile categories (`3x3`, `6x6`, `40x40`, `64x64`) |
| `+0x118` | `uint32 count, uint32 cap` | Count `4`, Cap `4` |
| `+0x120` | `TileSlot*` | Direct pointer to vector of sub-level / dungeon / quest arena tile slots |
| `+0x128` | `uint32 count, uint32 cap` | Count `5`, Cap `5` (on Dark Hills) |

### 3.2 Category Vector (`+0x110`)

`spawner + 0x110` holds a pointer. Dereference it first, then index; the slices
live at that address, not at the spawner base. Indexing off `spawner + 0x110`
directly walks into the sub-level vector at `+0x120` on the second category.

    catPtr = readPtr(spawner + 0x110)
    catPtr + (c * 16) -> { TileSlot *data, uint32 count, uint32 cap }

On Dark Hills:
* **Category 0 (`c = 0`)**: `3x3` tiles. 62 slots (all 62 placed).
* **Category 1 (`c = 1`)**: `6x6` tiles. 57 slots (all 57 placed).
* **Category 2 (`c = 2`)**: `40x40` tiles. 14 slots (all 14 placed: camps, wells, cauldrons, grimoires, altar).
* **Category 3 (`c = 3`)**: `64x64` tiles. 5 slots (all 5 placed: major camps, chapter boss arena, quest camp).

Total main-map slots: $62 + 57 + 14 + 5 = 138$.

### 3.3 Sub-Level / Dungeon Vector (`+0x120`)

The pointer at `spawner + 0x120` points directly to an array of 5 `TileSlot` records:
* Total sub-level slots: 5 (2 placed on this run, 3 unplaced).
* Total map slots across all categories: $138 + 5 = 143$, exactly matching the 143 `oCDtTileSlotSettings` instances.

---

## 4. The 88-Byte (`0x58`) `TileSlot` Record

Each element in every category array is an 88-byte (11 qwords) struct:

| Offset | Field | Type | Description |
|---|---|---|---|
| `+0x00` | `spawner` | `oCDtEntityCpntTileSpawner*` | Back-pointer to the parent spawner |
| `+0x08` | `slot_settings` | `oCDtTileSlotSettings*` | Spatial slot settings on the map (carries authored world coordinates) |
| `+0x10` | `resource` | `oCEntitySettingsResource*` | **Placement indicator**. Null (`0x0`) if unplaced |
| `+0x18` | `entity` | `oCEntity*` | Live runtime entity spawned for this tile. Null (`0x0`) if unplaced |
| `+0x20` | `weight` | `float32` | Tier float (`0.15f`, `0.5f`, `1.0f` for T1/T2/T3; `0.0f` un-tiered; `-1.0f` if unplaced) |
| `+0x28` | `meta` | `void*` | Internal metadata pointer or null |
| `+0x30` | `linked_tile` | `oCLinkedTile*` | Adjacency constraint object or null |
| `+0x38` | `list` | `void*` | Internal list pointer or null |
| `+0x40` | `reserved` | `uint64` | `0x0` |
| `+0x48` | `tile_def` | `oCDtTileDefinition*` | Pointer to loaded `oCDtTileDefinition` resource |
| `+0x50` | `tile_kind` | `oCDtTileKind*` | Classification tag (`"Distance"`) or null |

### Determining Placed vs. Unplaced
* **Placed**: `resource` (`+0x10`) and `entity` (`+0x18`) are both non-null.
* **Unplaced / Empty**: `resource` and `entity` are `0x0`, and `weight` at `+0x20` reads `0xBF800000` (`-1.0f`).

---

## 5. Tile Name and Coordinate Extraction

### 5.1 $O(1)$ Name Read (Zero String Scanning)
When `resource` (`slot + 0x10`) is non-null:
* The string triple `{const char *data, uint32 len, uint32 flags}` sits at fixed offset **`resource + 0xA0`**:
  * String pointer: `proc.readPtr(resource + 0xA0)`
  * String length: `proc.readU32(resource + 0xA8) & 0x7FFFFFFF`
* Swept across the full roster, not sampled: 139 of 139 placed slots on one
  Dark Hills run and 140 of 140 on the next both resolved a plausible name,
  100% either time. `app/reader/bench/tiles-census.js` re-runs the sweep and
  prints the coverage.

### 5.2 World Position $(X, Y, Z)$

Memory stores the triple as $(X, \text{altitude}, Y)$ — the altitude component
sits in the middle, in both sources below. The roster tables in section 6 print
$(X, Y, Z)$ with $Z$ as altitude, so they are reordered from what memory holds.

Available from two independent sources:

#### Method A: From `slot_settings` (`slot + 0x08`)
Authored slot coordinates:
* `slot_settings + 0x10`: X (`float32`)
* `slot_settings + 0x14`: Z / Altitude (`float32`)
* `slot_settings + 0x18`: Y (`float32`)

#### Method B: From `entity` (`slot + 0x18`)
Live $4 \times 4$ homogeneous affine transform matrix at **`entity + 0x2B0`**:
* `+0x2B0`: Basis X (`[r00, r01, r02, 0.0]`)
* `+0x2C0`: Basis Z (`[r10, r11, r12, 0.0]`)
* `+0x2D0`: Basis Y (`[r20, r21, r22, 0.0]`)
* `+0x2E0`: Translation vector `[X, Z, Y, 1.0]`

Tile rotation (0°, 90°, 180°, 270°) is directly readable from the basis vectors.

### 5.3 Tile Grid Dimensions
From `slot_settings + 0x08` (`oCDtTileSlotSize*`):
* `sizePtr + 0x14`: Width (`int32`: 3, 6, 40, or 64)
* `sizePtr + 0x18`: Height (`int32`: 3, 6, 40, or 64)

Size is the classifier. The category index is not — see section 9.1.

### 5.4 Tile Kind: The Pointer Is Real, The Name Offset Is Not Known

`slot + 0x50` holds an `oCDtTileKind*`. On a Dark Hills run, 95 of 140 placed
slots carry one and the other 45 are null, and those 95 pointers reach only
**11 distinct objects** — kinds are shared between slots, so a per-slot count
says nothing about how many kinds exist.

Where the tag's name sits inside `oCDtTileKind` is unknown. The `+0xA0` string
triple that names every other object in this reader (5.1) resolves on 1 of the
11, and returns the single character `"F"` — not the `"Distance"` recorded in
section 2. One hit in eleven, returning one letter, is a well-formed triple
found by chance at the wrong offset. A triple at `+0x68`, a `char*` at `+0x08`,
and raw bytes at the object base each resolve on 0 of the 11.

So the reader does not expose a kind: `PlacedTile.kind` is always null, and a
test holds it there. `readTileKind` still probes `+0xA0` and the bench still
calls it, which is what will show the offset being found. A dump of the first
`0x60` bytes of a live kind object is in the bench output; `+0x08` and `+0x28`
are the unexamined heap pointers in it.

This matters beyond the field itself. Tile kind is the only candidate for
classifying tiles structurally — POI against quest tile against blocker.
Until the offset is found, any such split has to match on tile names, which is
what `tiles-census.js` does and why its filter lives in the bench rather than
in the reader.

---

## 6. Live Roster Measured on Dark Hills

Coordinates below are reordered to $(X, Y, Z)$ with $Z$ as altitude; see 5.2.

### Category 3: 64x64 Major Camps & Boss Arena (5 / 5 Placed)
| Tile Name | Classification / Tribe | Coordinates $(X, Y, Z)$ |
|---|---|---|
| `64x64_Windmill_Hill_Neutral_Camp` | Major Camp (Neutral) | `[-121.0, -112.0, 0.0]` |
| `64x64_Chest_Graveyard_WhiteLadies_Camp` | Major Camp (White Ladies, Chest) | `[-12.0, 8.0, 4.0]` |
| `64x64_Chest_Deep_Forest_Treants_Camp` | Major Camp (Treants, Chest) | `[140.0, 26.0, -4.0]` |
| `64x64_Dark_Hills_Map_Boss_Update3` | Chapter Boss Arena | `[-116.0, 167.0, 8.0]` |
| `64x64_JackQuest_JackOldHouseCamp` | Quest Camp (Jack) | `[52.0, 144.0, 0.0]` |

### Category 2: 40x40 Regular Camps & Major POIs (14 / 14 Placed)
| Tile Name | Classification | Coordinates $(X, Y, Z)$ |
|---|---|---|
| `40x40_Windmill_Farm_Undead_Hogs_Camp` | Enemy Camp (Undead Hogs) | `[-124.0, 19.0, 4.0]` |
| `40x40_Chest_SmallPool_Ghouls_Camp` | Enemy Camp (Ghouls, Chest) | `[-72.0, -10.0, 4.0]` |
| `40x40_Cenotaph_Statues_Alley_WhiteLadies_Camp` | Enemy Camp (White Ladies) | `[-61.0, -90.0, 0.0]` |
| `40x40_Coach_Attack_Neutral_Camp` | Enemy Camp (Neutral) | `[58.0, -144.0, 0.0]` |
| `40x40_Stones_Sacrifice_Cultist_Camp` | Enemy Camp (Cultists) | `[132.0, -168.5, 0.0]` |
| `40x40_Dark_Hills_Wishing_Well_T2` | POI: Wishing Well (Tier 2) | `[-56.0, 147.0, 8.0]` |
| `40x40_Dark_Hills_Cauldron_T2` | POI: Leprechaun Cauldron (Tier 2) | `[6.0, -66.5, 0.0]` |
| `40x40_Dark_Hills_Grimoire_T2` | POI: Grimoire of Monsters (Tier 2) | `[-135.0, 92.0, 12.0]` |
| `40x40_Dark_Hills_Altar_Of_Heroes` | POI: Altar of Heroes (Revives) | `[49.0, 80.0, 0.0]` |
| `40x40_DarkHills_Thieves_Stashes_Entrance_Combat_Room_01` | POI: Thieves Stash Entrance | `[101.0, -56.0, 0.0]` |
| `40x40_JackQuest_BeanstalkGrowsPlace` | Quest POI: Beanstalk Planting Spot | `[-50.0, 87.0, 8.0]` |
| `40x40_Dark_Hills_Start_Update3` | POI: Run Start Spawn Point | `[-148.0, -53.0, 0.0]` |
| `40x40_Old_Shipyard_CrystalField` | POI: Dream Shards Deposit | `[10.0, -165.0, 0.0]` |
| `40x40_Nightmare_Tumor_Field` | POI: Nightmare Tumor | `[108.0, -103.0, 0.0]` |

### Sub-Level Category (2 Placed, 3 Unplaced)
* `[0]` PLACED: `64x64_JackQuest_OgreArena` (Jack boss arena)
* `[1]` *(unplaced)*
* `[2]` *(unplaced)*
* `[3]` PLACED: `DarkHill_Thieves_Stashes_Combat_Room_Underground_01`
* `[4]` *(unplaced)*

### Categories 0 & 1 (3x3 and 6x6 Minor Elements)
* **3x3 Tiles** (62 placed): Dream Shard crystals (`3x3_Crystal_01/02`) and blockers (`3x3_Blocker_01`, `_Props_01/02`).
* **6x6 Tiles** (57 placed): Teleporters (`6x6_Teleporter_01`), Healing fountains (`6x6_Healing_01`), Blood sacrifice fountains (`6x6_Bleeding_01`), Refugees (`6x6_Dark_Hills_Refugee_01`), and wandering camps (`Dark_Hills_Basic_Enemy_Camp_Wandering`).

---

## 7. Performance & Latency Benchmark

Measured end-to-end on Dark Hills:

| Step | Action | Latency |
|---|---|---|
| **Stage 1** | RTTI vtable resolve (`.?AVoCDtEntityCpntTileSpawner@@`) | **14.3 ms** |
| **Stage 2** | Pointer scan for single `TileSpawner` instance | **842.4 ms** (cold) / **0 ms** (cached) |
| **Stage 3** | Direct read of all 143 struct slots (140 placed tiles + coords) | **10.2 ms** |
| **Total Cold** | First scan on map load | **866.9 ms** |
| **Total Warm** | Subsequent polls during same map | **~10 ms** |

The reader needs the reward selectors too, so it scans for both vtables at once
rather than scanning twice. Measured on three Dark Hills runs: **894 / 924 ms**
cold for the combined two-target scan, against the 842 ms above for the spawner
alone. The second target costs roughly 50-80 ms, not a second pass — two
targets take the direct-compare branch in `scan.js` rather than the prefilter
table. Reading the roster afterwards is **10.9-12.2 ms**.

A scan that finds no spawner still costs 590-630 ms before it can say so,
because "absent" is only knowable after walking all of writable memory. That is
the cost of a poll taken between maps, and it is why the scan is triggered by
map change rather than run on a timer.

Stage 3 was measured with a generic 256-byte string scan per tile, not the
fixed `resource + 0xA0` read documented in 5.1. The documented read does less
work, so 10.2 ms is an upper bound on it.

---

## 8. The Reader

```
app/reader/tiles.ts               The reader
app/reader/bench/tiles-census.js  Live bench and census
app/reader/test/test-tiles.js     Offline suite, no attach
```

### 8.1 API Contract

```ts
type TileSourceType = 'category' | 'sublevel' | 'selector';

interface PlacedTile {
  readonly name: string;              // "40x40_Windmill_Farm_Undead_Hogs_Camp"
  readonly width: number | null;      // 40
  readonly height: number | null;     // 40
  readonly kind: string | null;       // always null -- see 5.4
  readonly source: TileSourceType;
  readonly categoryIndex: number | null;
  readonly category: number | null;   // -1 for sublevel, null for selector
  readonly tier: number | null;       // the raw memory float, not a tier number
}

function resolveVtables(proc, base, cache): ResolvedTilesVtables;
function findInstances(proc, vtables): DiscoveredInstances;
function readPlacedTiles(proc, base, discovered): PlacedTile[];
function tilesChanged(a, b): boolean;
```

The roster is one flat list spanning all three sources — categories, sublevels
and reward selectors — with `source` saying which. `categoryIndex` is carried
for diagnostics only. **Nothing may branch on it**; section 9.1 is why. Classify
by width and height.

Tier is read directly from memory: `+0x20` (`SLOT_WEIGHT_OFFSET`) on `TileSlot`
for placed tiles, and `+0x68` (`SELECTOR_TIER_OFFSET`) on reward selectors. It
carries the raw float; `bucketTier` turns it into 1, 2 or 3 by nearest of the
`0.15f` / `0.5f` / `1.0f` constants, with `0.0f` meaning no tier. Bucketing
rather than comparing for equality is deliberate: a few placements roll values
that are not one of the constants, and equality would drop their rings.

`groupTiles` counts surface tiles only. A sublevel entry is the interior of a
tile already in the roster -- a thieves stash occupies both, one in each vector
-- so counting both would draw two stashes where the player sees one.

No position, no rotation, no entity address. Names and counts are what this
answers; a coordinate readout is a separate question and would need section
10.3's sign rule.

### 8.2 Why the Filter Is Not In Here

Roughly 140 slots are placed per map and most are scenery — on Dark Hills, 119
of 139 are 3x3 blockers and crystals or 6x6 fountains and teleporters. The
census a player would want is about thirty.

The rule that gets from one to the other matches on tile names, because tile
kind cannot do it yet (5.4). So it lives in `tiles-census.js`, not in the
reader. A wrong name pattern in the bench costs an edit; the same pattern in
the reader silently drops a POI. Two rules there are load-bearing and neither is
guessable from the names alone:

* **Wandering camps are excluded, refugees are not**, though both are 6x6. An
  earlier version readmitted the whole tier by matching `/Camp|Refugee/`, which
  put six `Dark_Hills_Basic_Enemy_Camp_Wandering` roaming spawns into the count.
* **The refugee camp is placed as more than one tile variant, and this varies
  per run rather than per chapter.** Two Dark Hills runs on 2026-09-06: one
  placed three `6x6_Dark_Hills_Refugee_01` tiles and no reward selector, the
  next placed one `40x40_Dark_Hills_Refugee_Camp_01` and three selectors. A
  census reading only one source reports no refugees on one of those two runs.

#### Optional boss variants and hover names (2026-10-12)

`state.ts` classifies the surface entrance or shrine and carries the expected
boss as hover metadata. These are the six named variants:

| Chapter | Shrine | Underground den entrance |
|---|---|---|
| Dark Hills | `40x40_Boss_Shrine_White_Lady` — Brigit, the White Lady | `40x40_Boss_Ghoul_Den_Entrance` — Mother Ghoul, Underground Terror |
| Storm Island | `40x40_Jinn_Boss_Shrine_Arena` — Abu Al Jann, Father of all Jinns | `40x40_Crab_Mini_Boss_Den_Entrance` — Karkinos, Scourge of the Reefs |
| Avalon | `40x40_Witch_Boss_Shrine` — The Coven | `40x40_Avalon_Wolf_Boss_Den_Entrance` — Melion, the Cursed Knight |

The Dark Hills paths were read live; the other chapters' paths are the entity
references in the installed game's `DtTileDefinition.gen` records. Individual
boss names come from `Enemy_Common`'s English table; The Coven is the collective
name for the witch trio. The regression covers all six pairs with their
underground rooms, which do not add a second cell. Unknown boss variants retain
the generic label. Chapter-final bosses stay excluded.

The missing Ghoul den was a classifier defect: `Boss_Ghoul_Den_Entrance`
does not contain the contiguous `Boss_Den` token the old rule required.
`build/latest-poi-check.json` records the live surface tile being dropped and
the matching underground room being correctly excluded from the count.

### 8.3 Sweeper Integration — Wired via Pointer Chain

`findSpawnerByChain` in `app/reader/tiles.ts` reaches the tile spawner from a
static module root in 25-95 ms, where scanning for it took 780-1180 ms.

**That speedup does not carry to the roster, and the honest number is that the
roster costs what it always did.** The chain reaches the spawner and nothing
else. Reward selectors are separate component instances that it does not lead
to, so they still need a scan of their own, and that scan dominates. Measured
end to end on one Dark Hills map:

| Path | Cost | Roster |
|---|---|---|
| `findInstances` (two-target scan) | 832 ms | 151 items, 12 selectors |
| chain + `findSelectors` (one-target scan) | 95 + 732 = 828 ms | 151 items, 12 selectors |

Identical rosters, identical cost. The chain is worth having because it is the
half of the problem that is solved, and because a consumer that does not need
rewards can stop after it for 95 ms. But **reading a full census on map load is
still a second of work, and the reward selectors are the reason.** Removing that
means finding a structural route to the selectors the way one was found for the
spawner; `ruled_out.md` records what has already been ruled out.

#### Pointer Chain Architecture

Two static roots reach the level list:
* **Candidate 1 (Direct Scene Anchor, default):** `MODULE + 0x1438E90` points directly to `oCDtGameScene*` (11 hops).
* **Candidate 2 (Game Singleton):** `MODULE + 0x146F8F8` points to `oCDtGame*`, whose `+0x18` offset points to `oCDtGameScene*` (12 hops).

**Game update, 2026-10-12:** the previous scene root `0x143EF70` reads null,
and the previous game root `0x1475900` fails the game-vtable check. A targeted
RTTI scan found the current scene/game objects, then their references in the
module's `.data` section. Both replacement roots above reached the same
spawner as an independent vtable scan on Dark Hills. The existing roster
decoder returned 151 entries: 138 category, 2 sublevel and 11 selector.
Local evidence is `build/map-anchor-probe.json`. The cross-map measurements
below predate this patch; replacement-root stability across maps and game
relaunches is not yet measured.

From `oCDtGameScene`:
1. `scene + 0x658` dereferences the head of the `oCGameLevel` linked list (`curr = curr + 0x10`, cap 50).
2. Each level inspects its Game Object array at `level + 0x80` (count at `level + 0x88`, cap 64) for instances matching the `oCEntitySpawnerGo` RTTI vtable.
3. Matching GOs dereference their owning entity at `go + 0x128`.
4. The entity component array at `entity + 0x190` (count at `entity + 0x198`) is scanned for the `oCDtEntityCpntTileSpawner` vtable.

Both candidates match ground truth on live runs. Neither array is indexed at 0;
the level is identified strictly by containing an entity that owns the tile
spawner component (avoiding level name brittleness).

#### Tile Worker Lifecycle (`tiles-worker.ts`)

The roster is read on its own worker thread, not inside the discovery sweep.
The selector scan is ~1.3 s live (895-1562 ms) and has to repeat until the
reward count settles, and on the 5 s sweep that meant 25-40 s before icons
landed while the values/placement/melodies sweep sat blocked behind it. The
worker never builds a values index; the sweep worker resolves `Current map
id` and `Reader` relays it as `{ type: 'map', mapId }` on change, with
`reset: true` on the sweep that saw a run reset (Hero Level falling), and
`{ type: 'clear' }` from `Reader.clearRun()`.

* **Discovery Trigger (`tilesDue`):** a scan attempt runs on the map change
  and on every attempt after it while the roster is still null. The map change
  alone is not enough: `Current map id` flips early in the load, before the
  level game objects exist, so the first attempt can walk a level with no
  spawner in it. Retrying while the roster is null costs the chain walk only;
  the selector scan runs once the chain lands.
* **A non-null roster is not a finished one.** The spawner and the reward
  selectors become readable at different points in the load, and the
  selectors spawn one at a time, so the first read to find any of them can
  catch two of five. Usually they land together: across three map
  transitions on 2026-09-09 the roster and every reward selector resolved
  on the same read, cold and warm. A cold game launch just takes longer to
  reach the first successful read at all (74 s against 25 s warm, one
  sample each). A later session did see a camp whose selector arrived
  several reads after the rest, which is why the roster is never treated
  as complete. `bench/tile-reward-timing.js` measures the roster-to-reward
  gap on a live map. `nextTilesStable` marks the map stable only once two
  consecutive reads agree on the `source === 'selector'` count. Agreement is
  not proof: on a cold load (2026-09-17, `bench/selector-plateau-watch.js`)
  the first roster carried 6 selectors while 9 existed, and only the timing
  of the next read kept two reads from agreeing on 6. So stability never
  stops the worker; it sets the cadence.
* **Cadence:** `TILES_POLL_MS` (1500 ms) is the sleep *after* each attempt
  while the count is moving, so attempts land ~2.8 s apart and convergence
  is ~8-14 s. Once the count holds, the sleep becomes
  `TILES_SETTLED_POLL_MS` (15 s); a batch that lands late is seen within one
  settled interval and drops the cadence back to fast until the count holds
  again. The worker scans for as long as a map is current, at one ~1.3 s
  scan per settled interval. A `'map'` message cuts either sleep short.
* **Roster Retention:** the read roster is held in `heldTiles` and posted as
  `{ type: 'tiles', tiles }` only when `tiles.tilesChanged()` says it differs
  from the last post.
* **Reset Lifecycle:** `heldTiles`, the stable flag and the selector count are
  cleared on a `'map'` message for a different id, on `reset: true` even for
  the same id (a restart onto the same map is `0 -> -1 -> 0`, and the -1 leg
  clears the roster on its own), and on `'clear'`.
* **No Fallback / Diagnostic Emitting:** if the pointer chain fails at any hop,
  no scan fallback runs. The worker posts an explicit
  `{ type: 'diagnostic', message }` naming the failing hop.

#### Reader Accessor (`reader.js`)

* `Reader` owns the tile worker alongside the sweep and Sandman workers and
  stores each `'tiles'` post into `this.tilesRoster`.
* Roster is cleared on `clearRun()`, which also posts `'clear'` to the worker.
* Consumers read the current placed tiles roster via `reader.tiles()`.

---

## 9. Cross-Map Verification (All Three Chapters)

Measured live on running process across consecutive runs on 2026-09-05 / 2026-09-06.

### 9.1 Category Vector Shape Across Chapters

The outer vector at `spawner + 0x110` varies in slice count by chapter:

| Chapter | Map ID | Category Count (`+0x118`) | Slice Breakdown |
|---|---|---|---|
| **Dark Hills** | `0` | **4** | Cat 0: `3x3` (62), Cat 1: `6x6` (57), Cat 2: `40x40` (14), Cat 3: `64x64` (5) |
| **Storm Island** | `1` | **4** | Cat 0: `40x40` (14), Cat 1: `64x64` (5), Cat 2: `6x6` (54), Cat 3: `3x3` (65) |
| **Avalon** | `2` | **6** | Cat 0: `3x3` (60), Cat 1: `6x6` (34), Cat 2: `40x40` (12), Cat 3: `64x64` (4), Cat 4: `9x9` (18), Cat 5: `20x20` (7) |

Notice that category index assignment is not a fixed enum across maps: on Dark
Hills, Cat 2/3 hold the large tiles, whereas Storm Island places large tiles in
Cat 0/1. The reader must inspect the tile definition name or size descriptor
rather than hardcoding category index semantics.

---

## 10. Dynamic Camp Rewards & Quotas (`oCDtRewardEntitySelectorToSpawnEntityCpnt`)

While dedicated POIs (wells, cauldrons, grimoires, quest arenas) are static
tiles within the tile spawner, modular enemy camps select their reward
dynamically from the chapter's `.rewarddef` table during map generation ($t = 0$).

### 10.1 The Reward Selector Component

* **RTTI Class**: `.?AVoCDtRewardEntitySelectorToSpawnEntityCpnt@@`
* **Vtable RVA**: `0x00F09EC0`
* **Instance Count**: Measured at **11** on Storm Island, **10** on Avalon, and
  **9** then **12** across two Dark Hills runs. The count is per run, not per
  chapter — the two Dark Hills readings differ because one placed a refugee camp
  carrying three selectors and the other did not.
* **Scope**: Selectors attach to enemy camp reward pedestals, but also to other
  spawner-bearing objectives. On both measured maps, exactly 3 selectors are
  co-located at a single coordinate inside `Refugee_Camp_01`. The three are
  individually named, confirmed on Dark Hills at `(-124.0, 4.0, 19.0)`:
  `Refugee_Old_Man`, `Refugee_Old_Woman` and `Refugee_Woman` — so a census keys
  them apart by name and needs no coordinate to tell one cage from another.
  Additional selectors
  attach to spawner-bearing tiles such as `Straw_Reserve_01/02` and
  `Jack_Quest_Beans_Stash`.

Inside each selector instance:

| Offset | Type / Target | Verification | Notes |
|---|---|---|---|
| `+0x00` | `void*` (vtable) | Measured | RVA `0x00F09EC0` (`.?AVoCDtRewardEntitySelectorToSpawnEntityCpnt@@`) |
| `+0x08` | `oCEntity*` | Read, not confirmed | Presumed owning spawner entity. The pointer was read live; its vtable was never compared against `.?AVoCEntity@@` (RVA `0x00F743B0`) |
| `+0x10` | `oCDtRewardEntitySelectorToSpawnEntityCpntSettings*` | Inferred | Never read. The class resolves live to RVA `0x00F0DFD8`, but nothing has checked that this field points at it |
| `+0x68` | `float` | Measured live | Camp reward tier float (`0.15f`, `0.5f`, `1.0f` for T1/T2/T3; `0.0f` un-tiered) |
| `+0x6C` | `float` | Measured live | World position $X$ |
| `+0x70` | `float` | Measured live | World position $Z$ (elevation) |
| `+0x74` | `float` | Measured live | World position $Y$ |
| `+0x78` | `oCEntitySettingsResource*` | Measured live | RVA `0x00F75BE8` (`.?AVoCEntitySettingsResource@@`). Every reward name in the censuses below was read through this pointer |

The floats sit in a run of them, so a one-slot slip still reads plausible
numbers. Anchor the offsets by dumping six floats from `+0x60` and matching a
selector against its tile: on Storm Island the refugee selector reads
`-68.0, 12.0, -131.0` at `+0x6C`/`+0x70`/`+0x74`, against a refugee camp tile
at $(-68, -131, 12)$.

Inside the `oCEntitySettingsResource` pointed to by `+0x78`:
* `+0xA0`: Pointer to ASCII debug string naming the reward entity (e.g. `Baba_Yaga_Eye_Storm_Island`, `Storm_Island_Basic_Chest_T1`, `DreamCrystal_Big`).
* `+0xA8`: 32-bit string length.

Because the reward definition pointer is populated during world generation,
**camp rewards are resolved at $t = 0$ during map generation**, before the
player moves or engages any enemies.

### 10.2 Empirical Proof of Quota Distribution & Multiple Vision Towers

All six `Camp_Rewards_*_Update5.rewarddef` files declare:
* `Baba_Yaga_Eye`: `min 1, max 2` (across all three chapters)
* `Basic_Chest_*` (including `Stingy_Jack_Reward_*_T3` variant): `min 3, max 4` (Dark Hills & Storm Island), `min 2, max 4` (Avalon)
* `DreamCrystal_Big`: `min 1, max 3`
* `Astrolab`: `min 0, max 1`

In every Update5 `.rewarddef` file, `Stingy_Jack_Reward_*_T3` is not an external
quest drop; it is an item variant rolled inside the chest quota block when
Jack's questline is active.

Empirical live reads confirmed these quotas holding exactly under `.rewarddef`'s
own grouping:

#### Storm Island Live Census (Run 2026-09-05)
* **Vision Towers (Baba Yaga Eyes)**: **2** placed (quota `1–2`: `Tribal Outpost Gnoll Camp` at `(65, 120)` and `Pools Crab Camp` at `(2, -25)`).
* **Chests**: **4** placed (quota `3–4`: 3 standard chests `Tier 1` at Hill Camp, `Tier 2` at Survival Camp, `Locked Tier 2` at Giant Walkway + 1 `Stingy Jack Reward T3` chest variant at `Red Pits Camp`).
* **Big Dream Crystals**: **2** placed (quota `1–3`: `Old Reserve Camp` and `Ruins Nest Roc Camp`).
* **Astrolabes**: **0** placed (quota `0–1`).
* **Refugees**: 3 co-located selectors at `Refugee Camp` (`(-68, -131)`).

#### Avalon Live Census (Run 2026-09-05)
* **Vision Towers (Baba Yaga Eyes)**: **2** placed (quota `1–2`: `Witch Garden Camp` at `(65, 120)` and `Blood Canal Camp` at `(25, 25)`).
* **Chests**: **3** placed (quota `2–4`: 2 standard chests `Tier 1` at Terraces Camp, `Tier 3` at Bridge Ponds Camp + 1 `Stingy Jack Reward T3` chest variant at `Circle Grove Camp`).
* **Big Dream Crystals**: **2** placed (quota `1–3`: `High Monument Camp` and `Gardens Camp`).
* **Astrolabes**: **0** placed (quota `0–1`).
* **Refugees**: 3 co-located selectors at `Refugee Camp` (`(-40, 30)`).

#### Dark Hills Live Censuses (Two Runs, 2026-09-06)

Read by name through `+0x78` with no coordinates, so these are counts rather
than per-camp attributions.

| | Run A (9 selectors) | Run B (12 selectors) | Quota |
|---|---|---|---|
| Vision Towers | 2 | 2 | `1–2` |
| Chests | 4 (T3, T1, T2, T2) | 4 (T1, T3, T1, `Stingy_Jack_Reward_Dark_Hills_T2`) | `3–4` |
| Big Dream Crystals | 2 | 2 | `1–3` |
| Astrolabes | 1 | 1 | `0–1` |
| Refugees | 0 selectors (3 tiles) | 3 selectors | — |

Both runs sit inside every declared quota, which puts the third chapter in
agreement with Storm Island and Avalon. Run A is also the case that shows the
refugee variant is a per-run choice: the camp was there, placed as three 6x6
tiles, with no selector behind it.

**Finding:** Multiple Vision Towers on a single map is not an anomaly or edge
case; it is an active, fully supported quota outcome (`1–2`) proven live on
multiple chapters and verified against in-game map observation.

### 10.3 Map Projection & Orientation

Engine $(X, Y)$ maps onto the in-game map UI axis for axis. Screen right is
$+X$; screen bottom is $+Y$:

    screen_x = X
    screen_y = Y        (+Y points toward the bottom of the map UI)

So the quadrant a coordinate falls in is the pair of its signs:
* Engine $(+X, +Y)$ — bottom-right.
* Engine $(-X, +Y)$ — bottom-left.
* Engine $(+X, -Y)$ — top-right.
* Engine $(-X, -Y)$ — top-left.

Checked against the Storm Island roster read on 2026-09-05, cross-referenced
against the map as displayed in game: 16 of 16 placed rewards and POIs land in
the quadrant their signs predict.

The game draws the world isometrically, so the 3D view sits $45^\circ$ off this
grid. That rotation belongs to the camera and must stay out of the readout:
composing it with an axis inversion scores 0 of those same 16 tiles, because a
$45^\circ$ turn sends engine quadrants onto screen axes rather than onto screen
quadrants.

Per-tile orientation is a separate quantity, and does not have to be inferred:
the $3 \times 3$ rotation matrix at `entity + 0x2B0` (§5.2) carries it
directly in its basis vectors.

### 10.4 Reaching the Selectors Without a Scan

The tile spawner is reachable from a static root in 25-95 ms (§8.3). The reward
selectors are not, and they are what keeps a full census at roughly a second.
The four routes tried live on 2026-09-06 and closed are in `ruled_out.md`
under "Placed tiles"; one of them, `oCSpawnedEntityCollector`, is untested
rather than disproven.

What is now known about the selectors themselves: `selector + 0x08` is the
owning `oCEntity`, confirmed by vtable on all 9 of one run, which settles the
"read, not confirmed" note in §10.1. Those owning entities are not among the
tile-slot entities. Each holds its selector in its own component vector at
`+0x190`. A holder scan on one of them found it referenced from `oCSpawner`
(at `+0x20`, `+0x28` and `+0x58`), from `oCEntitySpawnData +0x38`, and from two
*other* selector-owning entities at `+0x18` and `+0x20` — so the reward entities
reference one another, and a single entry point may reach the rest.
