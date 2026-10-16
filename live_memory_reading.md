# Reading live GlobalValues out of a running Ravenswatch process

Pulling the live, current-run value of any GlobalValue out of a running
`Ravenswatch.exe` process. The `GlobalValues/*.gen` files on disk are
definitions only (`oCGlobalEntityValueSettings` resources) and carry
compiled-in defaults, not what a run is actually doing. Ravenswatch is
native MSVC C++ with no managed runtime, so there's no IL2CPP/Mono
reflection: everything here is raw `ReadProcessMemory` plus MSVC RTTI.

Scripts referenced below live in [`tools/`](tools/). They are the discovery
and analysis path, not the shipped one — the readout app runs its own reader
in Node at `app/reader/`, which implements this same chain. Read this document
for the method and the struct layouts; read `app/reader/README.md` for what
the app actually executes.

## Credit

The RTTI vtable-resolution trick comes from
[rblaurent/ravenswatch-melody-overlay](https://github.com/rblaurent/ravenswatch-melody-overlay)
(`ravenswatch/rtti.py`), built for melody-unlock tracking. `tools/rtti_gv.py`
retargets the same method at the GlobalValue class chain.

## The chain

1. **Resolve class vtables via RTTI** — `tools/rtti_gv.py <pid>`
   Scan the exe's `.data` section for MSVC RTTI TypeDescriptor strings
   (`.?AV<MangledClassName>@@\x00`), trace through the Complete Object
   Locator to the vtable in `.rdata`. Survives patches since it keys off
   class names, not fixed addresses. Resolves `oCGlobalEntityValueSettings`,
   `oCEntityValueUnion`, `oIResource`, `oISerializable` — only the first two
   are actually load-bearing for this technique.

2. **Find every live settings instance** — `tools/ptr_scan.py <pid> <vtable_abs_addr>`
   Scan writable memory for raw 8-byte hits of the
   `oCGlobalEntityValueSettings` vtable address. Each hit starts a live
   **192-byte** instance. One session returned ~434 instances against 204
   decoded `.gen` files — more instances than files, some values may have
   more than one live copy.

3. **Identify the instance you want.**
   Conceptually: search memory for the value's display name — spelling
   isn't guessable from the filename, some use spaces (`"Is In Combat"`),
   most use underscores (`Current_House_Type`) — always check "Known
   values" below rather than assume. `tools/discover_values.py`'s actual
   algorithm doesn't search for the string first, though — see "Matching
   a settings instance by name" for why and how it really works.

4. **That instance is the definition, not the live value.** Its embedded
   value holds the default and doesn't change during play — confirmed by
   reading it in and out of combat and getting identical bytes both times.
   The live state lives in a separate **96-byte "binding" object**
   elsewhere in memory.

5. **Find the binding object** — `tools/ptr_scan.py <pid> <settings_instance_addr>`
   Pointer-scan for references *to* the settings instance itself, not the
   name string. Most hits are neighboring entries in the master
   index/array of all settings instances — ignore those. One or two hits
   are binding objects: distinct vtable (not one of the four resolved
   above), their own embedded `oCEntityValueUnion` sub-object, and the
   live, currently-active value — layout depends on value type, see
   "Value union variants" below.

## Record layout: 192-byte `oCGlobalEntityValueSettings` instance

Offsets relative to the instance's base address:

| Offset | Contents |
|---|---|
| `0x00` | vtable ptr — `oCGlobalEntityValueSettings` |
| `0x08` | int32/int64, seen as `1` (refcount) |
| `0x10` | vtable ptr — shared "name container" class, constant across instances |
| `0x18` | ptr to previous entry in the master instance array |
| `0x20` | ptr to next entry in the master instance array |
| `0x28`–`0x3F` | small int32 flags, mostly `1` |
| `0x68` | ptr to the value's display-name string, always — this is not a `std::string` and there is no inline short-name form. See "Matching a settings instance by name". |
| `0x70` | `{uint32 len, uint32 flags}` for the name; `len` carries `0x80000000` (static literal), so mask with `0x7FFFFFFF` |
| `0x78` | ptr to the value's scope string (e.g. `"Hero"`), null for values with no scope — 65 of 434 live instances |
| `0x80` | `{uint32 len, uint32 flags}` for the scope string — same masked-length form as `0x70` |
| `0x88` | vtable ptr — `oCEntityValueUnion`, embedded inline, not a separate allocation |
| `0x90` | bool-typed values: int32 type tag (`4`). Int-typed values: a pointer instead — see "Value union variants" |
| `0x98` | bool-typed: the default value (int32) — stayed `0` for `Is_In_Combat` regardless of live state. Int-typed: `{size:int32, align:int32}` for the boxed value, default value follows inline at `0xA0` |

## Record layout: 96-byte runtime "binding" object

Offsets relative to the binding object's base — roughly `0x18` before the
pointer that matched in step 5:

| Offset | Contents |
|---|---|
| `0x00` | `{int16, int16}` header, constant across instances (`2, 1`) |
| `0x08` | 8 bytes, looks like a hash of the value's name — varies per instance |
| `0x10` | 8 more hash-looking bytes |
| `0x18` | ptr back to the `oCGlobalEntityValueSettings` instance this is bound to |
| `0x20` | vtable ptr — unresolved runtime-binding class |
| `0x28` | ptr to another per-instance heap object (listener list, unexplored) |
| `0x30` | two int32s, small numbers — likely table indices |
| `0x48` | vtable ptr — `oCEntityValueUnion`, embedded |
| `0x50` | bool-typed values: int32 type tag, matches the settings object's tag. Int-typed values: a pointer — see "Value union variants" |
| `0x58` | bool-typed: **the live value**, inline. Int-typed: `{size:int32, align:int32}`, not the value — see below |

## Value union variants

The embedded `oCEntityValueUnion` has two confirmed layouts, told apart by
what sits right after the union's vtable pointer (settings `+0x90` /
binding `+0x50`):

- **Bool-like (inline).** That slot is an int32 type tag (`4`). The live
  value is the very next int32, inline in the same record (settings
  `+0x98`, binding `+0x58`). No extra dereference needed. Confirmed on
  `Is_In_Combat`.
- **Int-like (boxed).** That slot is a pointer to a separate small heap
  allocation, followed by a `{size, align}` descriptor (`16, 8` seen) —
  in the *settings* record only, the default value then follows inline
  right after that descriptor. In the *binding* record, there's no
  trailing inline value — dereference the pointer instead; the live
  value is a plain int32 at offset `0x00` of whatever it points to.
  Confirmed on `Hero_Level`.

**Floats use the inline variant, with the same tag.** Confirmed live on
`Giant_Tree_HP_Ratio`: settings `+0x90` and binding `+0x50` both read tag
`4`, identical to a bool, and the inline int32 at binding `+0x58` held
`0x3F23D70A` — `0.64f`, matching a giant tree at 64% HP mid-fight. So the
runtime tag does **not** distinguish Bool from Float; both are a raw
4-byte inline slot and the read path is already correct for either. Only
the interpretation differs, and it has to come from the value's `.gen`
type byte (see "Reading type + default straight from the `.gen` bytes"),
not from memory. `tools/discover_values.py` calls this variant `inline`
(not `inline-bool` — the slot is not bool-specific) and handles the
reinterpretation itself: `value_types()` parses every `.gen` in
`Ravenswatch decoded/GlobalValues` once into a display-name → type map, and
a Float-typed inline read comes back as a Python float with the untouched
bit pattern kept alongside it as `raw_i32`. Every result also carries a
`type` field (`Float` / `Int` / `Bool`, or `None` when the decoded tree
isn't present — the live chain still works without it, it just can't tell
an inline Float from an inline Bool). `as_float()` is exported for
one-off use.

The `.gen` display name is what the map is keyed on, taken from inside the
file rather than from the filename, since the two don't always match. Note
one wrinkle in that parse: unscoped values store an *empty* scope string,
so the length dword right before the marker is zero — `Hero Level` and the
other `Common_Settings` values are all in that shape. A fourth type tag,
`3`, appears on exactly three values (`Altar pos`, `Altar respawn at`,
`Altar respawn pos`) and is left unclassified; those get `type: None` and
no reinterpretation.

Until more types are checked (enum), treat any record whose post-vtable
slot doesn't look like a small tag int (`0`–`~10`) as "probably boxed"
and dereference it.

## Known values

A value is identified by its **display name**, which is the string
resident in memory and is not derivable from the filename — most use
underscores, some use spaces, and the `.gen` file is the authority for
which. `value_types()` in `tools/discover_values.py` reads the real name
(and the type) out of every `.gen`; `tools/discover_values.py` with no
arguments lists every live name with its current value.

Live-confirmed so far:

| Display-name string | `.gen` type | Union variant | Value scope |
|---|---|---|---|
| `Is In Combat` | Bool | inline | `Hero` |
| `Is local hero in Sinbad Cyclop cave` | Bool | inline | `Hero` |
| `Tree_Quest_Boss_Is_Dead_Bool` | Bool | inline | `Tree_Quest` |
| `Giant_Tree_HP_Ratio` | Float | inline | `Tree_Quest` |
| `Hero Level` | Int | boxed-int | (none) |
| `Current map id` | Int | boxed-int | (none) |
| `Current_House_Type` | Int | boxed-int | (none) |
| `Current_House_State` | Int | boxed-int | (none) |
| `Pig_House_Resources_To_Collect_Count` | Int | boxed-int | `3Pigs Resources` |
| `Jack_Quest_Current_Step` | Int | boxed-int | `Jack_Ogre_Quest` |
| `Cyclop_Quest_Cave_Current_Step` | Int | boxed-int | `Sinbad_Cyclop_Quest` |
| `Tree_Quest_Current_Step` | Int | boxed-int | `Tree_Quest` |

Scope strings don't reliably match the folder either — `Jack_Quest_*`
values are scoped `Jack_Ogre_Quest`, and the `Common_Settings` values are
unscoped (empty string, not a missing field).

**`Is In Combat` follows the spectate target, not the local hero.** Seen
live on 2026-09-15 in a two-player run: after the local hero died and the
camera was spectating the other player, the combat border tracked *her*
combat state. So the value is not bound to the local hero controller for
the whole run; when the local hero is dead it reads whichever hero the
client is spectating, the same way the camera does. Not a defect: a
spectator's border reacting to what they watch is arguably right. It
matters if anything ever keys per-hero state (melodies, level, stats) off
"the active hero" — that binding may move with the spectate target too.
Only this one value has been seen doing it.

Addresses themselves (settings instance, binding instance, boxed value) are
**not** stable across game launches — re-run the chain each session. The
vtable RVAs from step 1 and the two variant layouts above are what's
actually reusable.

## Worked examples

**`Is_In_Combat`** — settings (definition) instance found via name-string
cross-reference, 192-byte record, default `0` at `+0x98`. Binding (live)
instance found by pointer-scanning for references to the settings
instance's address, live value at `binding_addr + 0x58`. Verified by
toggling combat state three times live — `+0x58` tracked actual combat
state exactly, no false positives.

**`Hero_Level`** — same chain through the binding object. Union variant is
int-like/boxed: binding `+0x50` is a pointer, not a tag; the live value is
`*(binding+0x50)` at offset `0x00` of that target, a plain int32. Verified
across two level-ups live (`3 → 4`), exact match both times.

## The 3-Pigs map quest (`Current_House_Type` / `Current_House_State`)

Dark Hills is the only map with this objective, and it's tracked by a
generic house-state pair in the shared `GlobalValues_Common` folder —
both int-like/boxed, same chain as `Hero_Level` — rather than by a
per-quest `*_Quest_Current_Step` chain like Jack, Mordred, Roc, or
Sinbad's Cyclop.

Dark Hills also has a second, independent questline on the same map —
Jack and the Beanstalk (ogre fight included) — tracked the per-quest way,
under `GlobalValues/Dark_Hills/Jack_Quest!*`. That per-map `Dark_Hills`
folder holds only the `Jack_Quest` chain; the 3-Pigs values below live in
`GlobalValues_Common` instead, not under `Dark_Hills`. Worth remembering
when hunting for a value on this map — check both locations.

- **`Current_House_Type`** — which pig house is this run's target. Enum
  members defined in `GlobalValues/GlobalValues_Common/`:
  `Current_House_Type_Straw` / `_Wood` / `_Stone`. Confirmed ordering:
  `0 None → 1 Straw → 2 Wood → 3 Stone`. Confirmed set from the start of
  the run (map generation), not on quest acceptance — readable as soon as
  the process and instances resolve, before the player has interacted
  with the house. `0` occurs on a run with no pig house at all (a Jack
  run, see below).
- **`Current_House_State`** — build/defend lifecycle. Confirmed ordering,
  observed across a full quest (accept → complete):
  `0 Inactive → 1 Building → 2 Defending → 3 Saved → 4 Destroyed`.
- **`Pig_House_Resources_To_Collect_Count`** — build-resource counter, the
  *house's* remaining deficit. Read at `4` (`Destroyed`, i.e. after quest
  completion) as `15`, and again at `3` (`Saved`) as `15` — so it does not
  reset on completion. Not confirmed whether it counts down during
  `Building`. This is not what the hero is carrying; for that see
  "Carried ingredients" below.

All three are wired into the reader (`app/reader/`).

### Detecting Pig vs. Jack at run start

Dark Hills' two side-questlines (3-Pigs, Jack and the Beanstalk) are
mutually exclusive per run. Confirmed live: on a run with no pig house,
`Current_House_Type` reads `0`, `Current_House_State` reads `0`
(`Inactive`), and `Pig_House_Resources_To_Collect_Count` reads `0` —
all three flat, versus non-zero/`Building`+ on a Pig run from the start.
`Current_House_Type == 0` at run start is a usable signal for "this is a
Jack run, not a Pigs run" (or vice versa) without needing to actually see
the map.

## Jack and the Beanstalk quest (`Jack_Quest_Current_Step`)

Dark Hills' other side questline, mutually exclusive with the 3-Pigs
house per run (see detection heuristic above). Tracked under
`GlobalValues/Dark_Hills/Jack_Quest!*`, scope string `Jack_Ogre_Quest`.
Unlike the house type/state pair, the step values aren't a hand-picked
enum guess — each `*_ID` file's default int, read directly from the
static `.gen` bytes (no live memory needed), gives the full sequence
outright:

| Value | Step |
|---|---|
| 0 | default, not yet started |
| 1 | `Waiting_For_Bean` |
| 2 | `Plant_Bean` |
| 3 | `Idle_Wait_Grow` |
| 4 | `Bean_Grow` |
| 5 | `Idle_Wait_Fight` |
| 6 | `Ogre_Intro_Cine` |
| 7 | `Fight` |
| 8 | `Ogre_Outro_Cine` |
| 9 | `Finished` |

`Jack_Quest_Debug_Flag`, `Jack_Is_Dead`, `Ogre_Is_Dead`, and
`Stamina_Ratio` are separate flags/ratios, not part of this step enum.

Live chain confirmed int-like/boxed, same pattern as `Hero_Level`. Step
triggers confirmed live end to end, `1 → 9`:

- `1` (`Waiting_For_Bean`) — quest accepted through picking up the bean;
  no separate step for pickup.
- `2` (`Plant_Bean`) — fires on handing the bean to Jack.
- `3` (`Idle_Wait_Grow`) — Jack's thank-you beat, immediately after `2`.
- `4` (`Bean_Grow`) — the beanstalk actively growing; brief, easy to skip
  past between polls.
- `5` (`Idle_Wait_Fight`) — fires once the beanstalk finishes growing.
- `6` (`Ogre_Intro_Cine`) — confirmed live.
- `7` (`Fight`) — confirmed live.
- `8` (`Ogre_Outro_Cine`) — brief, same as `4`; skipped past between polls
  rather than directly observed, but implied by `7 → 9`.
- `9` (`Finished`) — confirmed live, quest complete.

## The other maps' main questlines

Avalon (Mordred, Tree/Morgan) and Storm Island (Roc, Sinbad's Cyclop cave)
each have their own `*_Quest_Current_Step` chains, same shape as Jack's —
decoded from the static `.gen` bytes the same way, no live memory needed.
Every map's questline values resolve live with binding objects
regardless of which map the run is on — `Jack_Quest_*`, `Tree_Quest_*`
and `Mordred_Quest_*` all resolve from a Storm Island run — so instance
presence identifies nothing. Storm Island's step orders are the only ones
touched live so far; Avalon's are static-only. Treat the mapping below as
"these are the legal values," not necessarily "this is the chronological
order," except where noted.

**`Mordred_Quest_Current_Step`** (Avalon, scope `Mordred_Quest`) — reads
as a clean linear sequence, same pattern as Jack's:
`0 (not started) → 1 Waiting_For_Hero → 2 Crossing_Underground →
3 Boss_Intro_Cine → 4 Boss_Fight → 5 Boss_Outro_Cine → 6 Finished`.
Side flags: `Mordred_Quest_Boss_Is_Dead`, `_Is_Crown_Destroyed`,
`_Debug_Flag` (bool), `_Morgan_Stamina_Ratio` (type tag `00`, the Float
family — see `Giant_Tree_HP_Ratio` under "Value union variants").

**`Roc_Quest_Current_Step`** (Storm Island, scope `Roc_Quest`) — also
reads as a clean linear sequence: `0 → 1 Waiting_For_Hero →
2 Following_Sinbad → 3 Boss_Intro_Cine → 4 Boss_Fight →
5 Boss_Outro_Cine → 6 Finished`. `Roc_Quest_Camp_Cleared_Index`,
`_Sinbad_Destination_Index`, and `_Sinbad_Destinations_Count` are
separate counters, not step-enum members — they only coincidentally
share small int defaults with `Current_Step`, filtered out by requiring
the `_ID` suffix convention. Side flags: `_Boss_Is_Tamed`,
`_Sinbad_Arrived`, `_Sinbad_Is_Ejected`, `_Sinbad_Stamina_Is_Critical`,
`_Debug_Flag` (bool), `_Sinbad_Stamina_Ratio` (Float tag).

**`Cyclop_Quest_Cave_Current_Step`** (Storm Island, scope
`Sinbad_Cyclop_Quest`) — clean linear sequence: `0 →
1 Cave_Step_0 → 2 Cave_Step_01 → 3 Cyclop_Fight_Intro_Cine →
4 Cave_Kill_Cyclop → 5 Cyclop_Fight_Outro_Cine`. No `Finished_ID` sibling
this time — completion is presumably read off `Cyclop_Quest_Cyclop_Is_Dead`
(bool) instead. Other bools: `Cyclop_Cave_Fight_01/02_Finished`,
`Cyclop_Prisoner_01/02_Eaten`, `Cyclop_Quest_Sinbad_Is_Dead`,
`Is_Local_Hero_In_Sinbad_Cyclop_Cave` (scope `Hero`, unlike the rest of
this family which are unscoped).

**`Tree_Quest_Current_Step`** (Avalon, scope `Tree_Quest`) — one counter,
but two quests in the actual play experience. Values: `0 → 1 Start →
2 Morgan_Saved → 3 Reach_Orchard → 4 Boss_Fight → 5 Success → 6 Failed →
7 Knights_Fight → 8 Boss_Fight_Intro_Cine`. `Success`(5)/`Failed`(6)
resolve phase one (find Morgan, reach the orchard, fight the tree boss —
`Giant_Tree_HP_Ratio` tracks that fight). `Knights_Fight`(7) and
`Boss_Fight_Intro_Cine`(8) belong to a second, distinct phase that
follows — hence the values not reading as one continuous chronological
climb, unlike every other quest chain decoded so far. Live-verified for
phase one: step `5` read alongside `Tree_Quest_Boss_Is_Dead_Bool` = `1`,
`Tree_Quest_Tree_Is_Dead_Bool` = `0` and `Giant_Tree_HP_Ratio` = `0.64`
— boss dead, tree alive at 64%, which is what `Success` should mean.
Also has `Tree_Quest_Boss_Is_Dead_Bool` / `_Tree_Is_Dead_Bool`.

All four are wired into the reader as labels and resolve live
from any map.

## Which map the run is on

`Current map id` holds the live map, and each map's id is published as its
own static constant, so the id → name mapping is readable from the process
instead of guessed:

| Value name | id |
|---|---|
| `Dark Hills map id` | `0` |
| `Storm Island map id` | `1` |
| `Avalon map id` | `2` |
| `Baba Yaga Map map id` | `3` |

All four are unscoped, int-like/boxed, same chain as `Hero_Level`.
The reader collects every `"<name> map id"` value at startup
rather than hardcoding the table, so a patch that adds a map is picked up
without a code change.

**`Current map id == 0` is not self-validating.** Dark Hills is id `0`, so
a zero reading is indistinguishable from an uninitialised one — the same
trap as a quest step reading `0`. Confirm it against a map that isn't
Dark Hills before relying on it, and see "When a value reads wrong".

`Current chapter` (scope `Player location`) is a separate live counter and
is not the map id.

### Naming the questline before it starts

Every `*_Quest_Current_Step` reads `0` until its quest actually begins, so
at run start no step identifies the run's questline. The map does. Each
map carries two, so the map narrows it to a pair:

| Map | Questlines |
|---|---|
| Dark Hills | 3 Pigs, Jack |
| Storm Island | Roc, Sinbad's Cyclop |
| Avalon | Mordred, Tree/Morgan |
| Baba Yaga Map | none decoded |

Each map's pair is mutually exclusive: exactly one of the two questlines
is placed per run.

**Dark Hills** resolves at map generation via `Current_House_Type`:
non-zero is a Pigs run, zero is a Jack run (see "Detecting Pig vs. Jack
at run start").

**Storm Island** resolves at map generation via
`Cyclop_Quest_Cave_Current_Step`. On a Cyclops run it reads `1`
(`Cave_Step_0`) from the moment the map loads — before the cave is
discovered, with `Is local hero in Sinbad Cyclop cave` still `0` and
`Roc_Quest_Current_Step` still `0`. So on Storm Island,
`Cyclop_Quest_Cave_Current_Step == 0` is a Roc run and non-zero is a
Cyclops run. Note the asymmetry with Dark Hills: the discriminator is the
quest's own step counter, not a separate map-generation field. It reads
`0` again once the run leaves Storm Island, so the check has to be gated
on the current map. Observed live on one Cyclops run; a Roc run has not
yet been read at load.

**Avalon** has no equivalent. Read live at map load on a confirmed
Tree/Morgan run: `Tree_Quest_Current_Step`, `Mordred_Quest_Current_Step`,
`Giant_Tree_HP_Ratio` and `Mordred_Quest_Morgan_Stamina_Ratio` all read
`0`, with only the static `*_ID` constants non-zero. Neither questline
announces itself at generation and no side value substitutes, so both
stay named as candidates until a step ticks. Identifying an Avalon run
earlier needs the placed-tile data — see `deferred_investigations.md`.

## Reading type + default straight from the `.gen` bytes

Every `GlobalValues/**/*.gen` file encodes its value's type and
compiled-in default inline, readable with no live process. After the
display-name string and the (often empty) scope string, the fixed tail
is:

```
11 11 bb aa   vtable fixup marker (oCEntityValueUnion)
03 00 00 00   constant, all types seen so far
TT TT TT TT   type tag: 01 = Int, 02 = Bool
00 00 00 00   reserved
DD ...        default value: 1 byte for Bool, int32 for Int
22 22 bb aa   fixup marker
```

`0xAABB1111` / `0xAABB2222` are cooker fixup placeholders, not real data.
Confirmed against 5 known-answer files: `Is_In_Combat` /
`Is_Boss_Stuned` / `Arena_Fight_In_Progress` all decode to default `0`
(matches expected false-by-default behavior), `Hero_Level` decodes to
default `1` (matches the confirmed live starting level), and
`Is_Boss_Buffed_In_Overtime` decodes as Bool with default `1` (true) —
the compiled-in default, not a claim about live behavior outside
overtime.

A third type tag, `00`, shows up on `NGP_Boss_Tentacle_Master_Enraged_
Timer_Modifier` and `Minimum_Map_Remaining_Time_Ratio` — both decode to
default `0`, and is `Float`. No third read path is needed: floats use the
existing inline variant and come back as a raw int32 bit pattern to
reinterpret — confirmed on `Giant_Tree_HP_Ratio`, see "Value union
variants".

The scope string on `NGP_Boss_Tentacle_Master_Enraged_Timer_Modifier` is
literally `"New Game Plus"` — confirms what `NGP` stands for.

## Generalizing to other GlobalValues

Steps 3–5 are name-agnostic — swap in a different display name to find any
other entry under `GlobalValues/`. Take the spelling from `value_types()`,
the "Known values" table, or the `.gen` file itself, since the filename
isn't reliable. Check the union variant before assuming the value's
offset. The vtable RVAs from
step 1 only need resolving once per game version.

`tools/discover_values.py "<name>" ["<name>" ...]` automates steps
3–5 for a batch of display names in one run, auto-detecting the union
variant. It finds the running `Ravenswatch.exe` by image name; a leading
integer argument overrides that with an explicit PID, needed only when two
copies are running. One memory sweep covers the whole batch (see "Scan cost" below),
so a run takes about two seconds regardless of how many names are asked
for. With no names given it dumps every live GlobalValue and its current
value — the fastest way to check a name's exact spelling or to see what
exists on the map you're currently on.

## Vtables are module-relative RVAs

Vtable identity is stored as an RVA and combined with the current
process's module base, re-queried each run via
`rtti_gv.get_module_base(pid)`. ASLR relocates `Ravenswatch.exe` on every
launch, so an absolute address captured in one session has no reason to
be correct in the next.

`SETTINGS_VTABLE` / `UNION_VTABLE` RVAs come from the RTTI class-name
scan, ASLR-safe by construction since it re-scans the live process on
every call. `BINDING_VTABLE` has no matching RTTI class name (see the
"unresolved runtime-binding class" note above), so its RVA was
bootstrapped by walking the chain with `Hero Level` as a known-good
anchor and reading the binding object's vtable pointer directly:
The original `BINDING_VTABLE_RVA = 0xF10F48` was confirmed stable across
two separate launches (different PIDs, same RVA both times). On 2026-10-12,
the updated game (image size `22802432`, PID `15328`) still resolved 445
named settings through RTTI, but that RVA found zero bindings. Following
references to `Hero Level` and `Current map id` independently yielded
**`0xF0D968`**, now stored in `app/reader/struct_offsets.json`. Both bindings
passed the existing union-vtable validation at `+0x48` and read through
the existing boxed-int layout (`1` and `0`, respectively). A fresh index
using the corrected shared RVA then found 445 bindings for 445 names;
all nine tracked values and the four map-id constants resolved `ok` with
valid union vtables (`build/bootstrap-verification.json`, local evidence).
This establishes the new binding RVA for this build, not the layouts of
the other channels.
`discover_values.bootstrap_binding_vtable_rva()` re-derives it if a game
update changes the binary layout and the stored RVA stops producing
`union_vtable_ok: true`.

## Matching a settings instance by name

Enumerate every live settings instance (`scan_for_pointer(handle,
settings_vtable_abs)` — same operation as "find every live settings
instance" above), then read each instance's own name field and compare.
`discover_values.build_index()` does this for every live instance in one
pass and returns a `name -> settings_addr` dict. Searching for the
display-name string and working back to its owner finds fewer of them.

The name field at `+0x68` is a `{const char *data; uint32 len; uint32
flags}` triple, not a `std::string` — pointer at
`+0x68`, length at `+0x70` with `0x80000000` OR'd in (the static-literal
flag), so `0x8000000D` means 13 characters. `data` always points into the
module's `.rdata` string pool, for short names as well as long ones;
there is no inline small-string form to handle. Read `len & 0x7FFFFFFF`
bytes from `data` and that is the display name exactly.

When bootstrapping `BINDING_VTABLE_RVA` without already knowing it,
`scan_for_pointer(handle,
settings_addr)` returns mostly *neighboring settings records* in the
master instance array (their own prev/next-instance pointer fields), not
the binding object. A naive "take the first candidate with a non-null
value at +0x20" bootstrap will happily mistake one of those neighbors'
fields for a vtable pointer — the giveaway is that the resulting address
lands in heap space (`0x1C0...`-ish) rather than the module's mapped
range (`0x00007FF6...`-ish). Guard against it two ways: reject any
candidate that is itself a settings record (its own `+0x00` field equals
`SETTINGS_VTABLE`), and require the harvested vtable-like value to
actually fall within `[module_base, module_base + module_size)`.

## Finding the binding object without a second scan

Sweep for `BINDING_VTABLE` and read the qword immediately before each
hit: that qword is the settings pointer. Every binding object stores the
settings instance it belongs to at `+0x18` and its own vtable at `+0x20`,
so one pass yields the whole `settings_addr -> binding_addr` mapping, and
joining it against the name index resolves every value at once. Scanning
for references to one specific settings address instead costs a full scan
per name. `discover_values.build_index()` searches both vtables in the
same pass, so the complete index costs a single sweep.

## Scan cost

A full sweep of a ~5.4 GB live process takes **about a second**. Three
things get it there; skipping any one of them puts it back into the tens
of seconds:

- **Writable regions only** (`iter_regions(writable_only=True)`). Settings
  and binding objects are heap objects. Including read-only and
  image-backed regions grows the sweep from 1.8 GB to 5.4 GB, costs ~30 s
  because file-backed pages fault in from disk, and yields zero
  additional settings instances (verified: 434 either way).
- **One reusable buffer.** `ReadProcessMemory` into a single preallocated
  64 MB buffer. Allocating a fresh `create_string_buffer` per region and
  then copying the result out — `buf.raw` copies the whole buffer, and
  `[:br.value]` copies again — is what dominated the old cost. Raw RPM
  over the writable set alone runs at ~3.9 GB/s, i.e. 0.5 s for the lot.
- **Aligned qword comparison, not a byte search.** Pointers are always
  8-byte aligned, so the buffer is compared as a `uint64` array (numpy
  where available, `bytes.find` with an alignment filter otherwise)
  rather than scanning every byte offset for an 8-byte needle.

`build_index()` covers every name in 1.9 s on a 5.4 GB process, including
the RTTI vtable resolve. Per-name scanning costs ~48 s per scan and two
scans per name, so resolving a set of any size that way runs to minutes.

## Per-entity component values (a second live channel)

GlobalValues are not the only live state readable from the process. Gameplay
objects are ECS components (`*EntityCpnt*` classes, ~692 of them in the RTTI
table), and a component's live values sit in embedded sub-objects rather than
in the GlobalValue binding chain. Nothing here goes through
`oCGlobalEntityValueSettings`.

**Inverse RTTI — vtable to class name.** The reverse of `rtti_gv.py`'s
name-to-vtable scan, and much cheaper: read the Complete Object Locator
pointer at `vtable - 8`, take the TypeDescriptor RVA at `COL + 0x0C`, and read
the mangled name at `TypeDescriptor + 0x10`. Validate with `COL + 0x00 == 1`
(signature) and `module_base + COL[0x14] == COL` (self-RVA) before trusting
it. `ingredients.class_of_vtable()` is the implementation. This names any
live object from its address alone, which is what makes an unknown heap
object identifiable instead of guessable — including the "unresolved
runtime-binding class" noted above.

**Component layout.** Every component instance shares a prefix:

| Offset | Contents |
|---|---|
| `0x00` | vtable ptr — the component's own class |
| `0x08` | ptr to the owning `oCEntity` |
| `0x10` | ptr to the component's `*Settings` resource |

`+0x08` resolving to `oCEntity` is a reliable test for "this address is really
a component" when walking backwards through memory; a plain
nearest-preceding-vtable search finds neighbouring allocations instead.

**`EntityCpntValueSignal<T>` — the value slot.** A `0x20`-byte sub-object
embedded in the component, one per exposed value:

| Offset | Contents |
|---|---|
| `0x00` | vtable — `EntityCpntValueSignal@<T>@oe@@`; `H` = int, `_N` = bool, `M` = float |
| `0x08` | owner/listener ptr |
| `0x10` | the live value, int32 |
| `0x14` | `8` when the slot is populated |

Scanning for the `<H>` vtable finds every live int signal at once (~94k on a
mid-run process, though only ~4.7k carry the populated flag, and observed
values are all small — `0` through `8`).

**Component names are readable.** The `*Settings` resource at `+0x10`
contains `{const char *, uint32 len, uint32 flags}` triples — the same shape
as a settings-instance name, without the `0x80000000` static-literal flag —
holding the editor path of the component: `MO Dmg Per Health Globe`,
`Debuff Lose Shards`, `Skill Controller Trait Quest Gain Charge`,
`Hero Collected Ingredient Listener`. `ingredients.object_strings()` extracts
them. This makes a component identifiable by name, the way `build_index()`
identifies a GlobalValue.

**A signal is not always the live value.** Some components expose a
configuration constant through the same slot type. See the trap under
"Carried ingredients".

## Carried ingredients

Wood, Straw and Stone — the 3-Pigs build materials — are **Ingredients**, a
separate resource type, and are **not GlobalValues**: nothing under
`GlobalValues/` matches them by filename or content. The definitions live at
`Ravenswatch decoded/Definitions/Ingredients/` (`Wood`, `Straw`, `Stone`,
plus `Bean`, `Key`, `Note`), and the three pig materials are identifiable by
their icons, `MiniMap\Icons\Map_Icons_3Pigs_Resources_*.png`.

**Definitions.** RTTI class `oCDtIngredientDefinition`; exactly six live
instances, `736` (`0x2E0`) bytes each. Display name at `+0x298` and icon path
at `+0x2B8`, both as the `{char *, len, flags}` triple. `ingredients.
ingredient_definitions()` returns `{name: address}`.

**The count does not reference a definition.** No `{definition*, count}`
record exists — a sweep for pointers to a definition instance finds only the
resource registry, the six-element library array and an icon table. Runtime
code refers to ingredients by index or handle, so a definition address is
useful for naming, not for finding the count.

**The chain.**

1. RTTI-resolve `oCDtEntityCpntIngredientListener` and scan for instances
   (5 live on a co-op Dark Hills run).
2. Read each instance's settings at `+0x10` and keep the one whose strings
   contain **`Hero Collected Ingredient Listener`**. The others are
   `Dt Ingredient Key Listener` / `Dt Ingredient Note Listener` under
   `UI Consumables`, mounted per hero from `Hero_Common`.
3. RTTI-resolve `DynamicCpntValueListenerData<int>`
   (`.?AV?$DynamicCpntValueListenerData@H@oe@@`) and scan for instances whose
   `+0x38` points back at that listener. Two match: one feeding an
   `oCEntityCpntLabelUi` (the HUD number) and one an `oCEntityCpntIntTest`.
4. **The live carried count is that object's `+0x08`.** Both observers mirror
   the same number; disagreement means a stale address.

Confirmed live across `1 → 2 → 4 → 5 → 0`, the last on delivering to the
house.

**What the count covers.** The map's collectible material, unambiguously.
Key and Note have their own per-hero listeners with their own listener-data
objects, so consumables never land in this number. And `Current_House_Type`
fixes exactly one pig material per run — Straw *or* Wood *or* Stone — so a
per-material count and a materials total can never differ in any reachable
game state. There is nothing to disambiguate here.

**The trap.** The listener's own int signal at `+0x98` reads `2` regardless
of what the hero is carrying — it is static configuration, identical across
all five listener instances and both heroes. It is stable, plausible, and
wrong; the count is in the listener-data objects, not the component.

`tools/ingredients.py` implements the whole chain with no hardcoded heap
addresses. The count is not part of the readout.

### Related classes

Resolved live and available as further targets:
`oCDtEntityCpntIngredientGain` (on collectible piles and on the delivery
point as `Remove All Player Ingredients On Delivery Complete`),
`oCDtEntityCpntDeliveryPoint` (5 live; one named `Take Resource` publishes
`15`, matching `Pig_House_Resources_To_Collect_Count`), and
`oCDtEntityCpntHeroController`. Note the game's own typo in
`oCDtEntityCpntDeliveryPointNetwotkData` — a correctly-spelled pattern will
never match.

## Hero build stats

Vitality, Damage, Armour, Luck and Crit Damage are **not GlobalValues**:
all 434 live names were checked with `bench/values-by-keyword.js` and no
filter, with no match. They are per-entity component values, read the same
way as the ingredient count. The fifth HUD stat (crossed swords over a
coin) is Crit Damage.

Executed live, hero Snow Queen, hero level 5–9 across one session:

1. RTTI-resolve `oCDtEntityCpntHeroController` and find the live instance
   with `scanPointers`. `scanPointers` can return more than one instance; a
   controller whose entity has a null `SceneContext` at entity `+0x30` is
   an orphaned leftover from a prior scene that the engine has stopped
   ticking. Filter on that field.
2. Follow `+0x08` to the owning `oCEntity`. Its component vector is at
   `Entity+0x190`, count at `+0x198` (3600+ components).
3. Keep the `oCEntityCpntValue` component whose settings string is
   `Last <Stat> Smooth Value`. Its `DynamicCpntValueListenerData<float>`
   pointer is at component `+0x70`, and the raw float at that object's
   `+0x08`.

The better read point is `oCEntityCpntSmoothValue+0x130`: the live
interpolated display float, the one the HUD renders from. It matched the
on-screen values twice at different points in the same run
(`0.0/-10.0/15.0/50.0/20.0`, later `80.0/-10.0/31.0/50.0/30.0`, for
AP/Armour/Crit Chance/Crit Damage/Vitality).

This is a read path only. No write into the chain reaches the HUD or the
combat math; the attempts and their measurements are in `ruled_out.md`
under "Hero build stats". The stats are not part of the readout.

## The run record

The victory and defeat summary reads from one record the game keeps for the
current run: an `oCDtCurrentRunProfileData` embedded in the game profile
(`oCDtGameProfile`). The summary's score data, `HeroScoreData`, is embedded
in the record at `+0xD8`. There is one instance of each. Find the record
with `rtti.resolveAllVtableRvas` and `scanPointers`, like any other class.
It exists from the main menu onward and keeps its address for the session.
It's live during play: level reached and the statistics rows rise through
the run. Playtime reads 0 until the run ends.

The run is over when the GlobalValue `Is in defeat sequence` (or
`Is in victory sequence`) rises to 1. The record is complete on the first
read after that edge, and it stays readable until the player presses
**End** on the rewards page. Then the flag drops to 0 and the record clears
to zero within about a second. Read it on the edge; there's no later
chance.

Fields matched against the summary screen, as record offsets:

| Field | Offset | Type |
|---|---|---|
| Hero entity settings (name pointer at `+0x8`, for example `Hero_Juliet_Carnival`) | `+0x20` | pointer |
| Hero definition path, first string in the buffer | `+0x70` | pointer |
| Playtime, seconds | `+0x9C` | float |
| Level reached (3.06 on screen reads 3.0639) | `+0xA0` | float |
| Magical objects: pointer, count, capacity of 16-byte GUIDs | `+0xE0` | vector |
| Damage dealt, total | `+0x180` | float |
| From attack, power, special | `+0x18C`, `+0x190`, `+0x194` | float |
| Highest single damage | `+0x1A4` | float |
| Self healing | `+0x1A8` | float |
| Damage blocked | `+0x1B8` | float |
| Damage taken | `+0x1C0` | float |
| Death's doors | `+0x1C4` | float |
| Dream shards amassed | `+0x1CC` | float |
| Magical objects collected | `+0x1D8` | float |

The damage, support, sufferings, and resources rows sit at consecutive
floats from `+0x180` to `+0x1D8`, in the order the statistics page lists
them. The page truncates: 61.73 displays as 61. The total score isn't in
the record. `run_history_plan.md` lists every row and how each was
confirmed. `bench/run-record-walk.js` walks the record and its vectors;
`bench/run-end-watch.js` logs the flags, every GlobalValue, and the score
classes across the transition.

## Live readout

`node app/reader/stdio.js` prints one frame per poll with no arguments and no
hardcoded addresses. A worker thread builds the index once and re-checks it
every `SWEEP_INTERVAL` seconds (default 5) while the poll loop reads from the
resolved addresses. `app/reader/README.md` describes what a frame holds.

The index is held across sweeps, not rebuilt: every tracked binding kept its
address for the life of the game process -- across a Dark Hills -> Storm
Island transition, five run restarts and seventeen level-ups over two
sessions (`bench/binding-stability.js`, 2026-09-15 and 2026-09-18, 250+
independent rebuilds, none moved). A sweep pays for a new build only when a
held binding stops matching the union vtable, on a map change, or on a run
reset -- `indexRebuildDue` in `sweeper.js`; the last two are a belt, not a
measured need. Values for a map you haven't visited are absent until you're
there.


## The readout page

The Electron app renders the same reading as a page (`app/web/`, loaded by
`app/main.js`). Frames arrive over IPC from the reader the shell spawns.

Everything renders from one `readState()` call, so which questline is named,
what a step number means, and when a value counts as unresolved are decided in
exactly one place. `readState()` takes optional `values`/`maps`
overrides that stand in for the process, allowing unit tests to exercise
frame synthesis without attaching.

The page holds the last good frame if the sidecar stops sending, marking the
status pill rather than blanking — alt-tabbing out of the game shouldn't look
like the run ending.

Icons are copies of the decoded UI textures; `app/web/assets/SOURCES.tsv`
records the `Ui_png` path, sha1, and size each one came from, so they can be
regenerated with `tools/decode_textures.py` rather than being opaque
binaries. The page's type is Archivo from Google Fonts with a system-ui
fallback, so it degrades rather than breaks offline.


## When a value reads wrong

`0` is usually a real reading, not a failure. Every map's questline is
mutually exclusive per run, so the questlines you aren't on sit at `0`
for the whole run, and the one you are on generally reads `0` until it
actually starts. The exception runs the other way:
`Cyclop_Quest_Cave_Current_Step` is already `1` at map load on a Cyclops
run, so a non-zero step is not proof the player has started anything. `Current_House_Type` reads `0` on a Jack run by design (see
"Detecting Pig vs. Jack at run start"). Check the enum's `NotStarted`
meaning before treating a zero as a broken chain.

`status: ok` with `union_vtable_ok: true` proves the chain landed on a
structurally valid binding object. It does not prove that object is still
the live one — freed memory stays readable, so a stale address returns a
plausible number rather than failing. That is why the held index is also
rebuilt on map change and run reset, not only when the vtable check fails.

Confirm a display name against the process rather than guessing from the
filename: `tools/discover_values.py` with no names lists every live name
(~430 on a mid-run process) with its current value. Formatting isn't
uniform — `Hero Level` and `Is In Combat` use spaces, most others use
underscores.

Every map's questline values resolve from every map, so a `status: ok` on
`Tree_Quest_Current_Step` says nothing about being on Avalon. Read
`Current map id` for that.

Judge a value by whether it moves across a known in-game transition, not
by one sample. A single reading matching or not matching the journal UI
proves neither, since the UI may be driven by different state.
