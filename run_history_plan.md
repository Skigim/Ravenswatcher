# Run history plan

This plan adds run history to Ravenswatcher: when a run ends, the overlay
records what the victory or defeat summary showed, keeps it across runs and
app updates, and lets the player look back over past runs.

It's a plan, not the feature. The evidence comes from three live defeats on
October 15, 2026, each matched against screenshots of the summary pages:

| Run | Hero | Difficulty | Playtime | Level reached | Damage dealt | Score |
|---|---|---|---|---|---|---|
| 1 | Kintaro | Twilight | 04:26 | 3.06 | 9,072 | 122 |
| 2 | Juliet | Adventure | 18:11 | 6.52 | 55,038 | 196 |
| 3 | Kintaro | Nightmare | 04:57 | 2.71 | 11,134 | 139 |

The probes are `app/reader/bench/run-end-watch.js` (phase flags, every
GlobalValue, and instance dumps across the transition) and
`app/reader/bench/run-record-walk.js` (the run record and everything it points
at). The confirmed method is recorded in `live_memory_reading.md` under
"The run record."

## What memory holds

The game keeps one record of the current run, an `oCDtCurrentRunProfileData`
embedded in the game profile (`oCDtGameProfile`). The score data shown on the
summary (`HeroScoreData`) is embedded in that record at `+0xD8`. There is one
instance of each, found by vtable with the same RTTI walk the melody and shop
channels use. The record exists from the main menu onward and keeps its
address for the session.

Offsets in the following tables are from the start of the record. Status
means:

- **Confirmed**: the value matched the screen in at least two runs.
- **Matched once**: the value matched the screen in one run.
- **By position**: the field read zero where the screen showed zero, and it
  sits where the screen order puts it between confirmed fields.
- **Inferred**: plausible from structure, not yet tied to the screen.

### Run summary page

| Field | Where | Type | Status | Evidence |
|---|---|---|---|---|
| Result: defeat | GlobalValue `Is in defeat sequence` | 0/1 | Confirmed | 1 on all three defeat screens, 0 elsewhere |
| Result: victory | GlobalValue `Is in victory sequence` | 0/1 | Taken as given | Paired with the defeat flag, same shape; no victory was played |
| Hero and skin | `+0x20` → `oCEntitySettings`, name pointer at `+0x8` | string | Confirmed | `Hero_Juliet_Carnival` (run 2), `Hero_Kintaro_Jungle` (run 3) |
| Hero definition | first string in the `+0x70` buffer | string | Matched once | `Heroes\Juliet_Update6.herodef.ot` in run 2 |
| Playtime, seconds | `+0x9C` | float | Confirmed | 266.5 (04:26), 1091.9 (18:11), 297.1 (04:57) |
| Level reached | `+0xA0` | float | Confirmed | 3.0639, 6.52, 2.71 |
| Difficulty | GlobalValue `Game Difficulty` | int | Confirmed | 1 on Twilight, 3 on Nightmare; Adventure wasn't logged |
| Chapter reached | GlobalValue `Current chapter` | int | Matched once | 0 when run 1 died in chapter I |
| Map | GlobalValue `Current map id`, last value before `-1` | int | Confirmed | The reader already tracks it; it reads `-1` on the summary |
| Total score | not located | — | Not found | Not in the record or the score page controller; see "Open risks" |
| Score details | not located | — | Not found | Three, five, and two icons across the runs |

`Game Difficulty` holds through the summary, drops to 0 when the player
presses **End**, and returns to the selected difficulty at hero select.

### Statistics page

All floats, in `HeroScoreData`. The record offset is the score data offset
plus `0xD8`. The screen rounds down: 61.73 shows as 61.

| Row | Record offset | Status |
|---|---|---|
| Damage dealt, total | `+0x180` | Confirmed (9,072.8; 55,038.1; 11,134.7) |
| From dash | `+0x184` | By position |
| From trait | `+0x188` | By position |
| From attack | `+0x18C` | Confirmed (4,650.4; 5,056.3) |
| From power | `+0x190` | Confirmed (2,496.2; 2,956.4) |
| From special | `+0x194` | Confirmed (1,926.2; 3,121.9) |
| From defense | `+0x198` | By position |
| From ultimate | `+0x19C` | By position |
| Other sources | `+0x1A0` | By position |
| Highest single damage | `+0x1A4` | Confirmed (173.15; 156) |
| Self healing | `+0x1A8` | Confirmed (63.58; 78.78) |
| Healing to allies | `+0x1AC` | By position |
| Self shield | `+0x1B0` | By position |
| Shield to allies | `+0x1B4` | By position |
| Damage blocked | `+0x1B8` | Confirmed (61.73; 364.2) |
| Revive assists | `+0x1BC` | By position |
| Damage taken | `+0x1C0` | Confirmed (426.7; 1,519.8; 708.5) |
| Death's doors | `+0x1C4` | Matched once (3) |
| Raven feathers consumed | `+0x1C8` | Inferred (2 in run 3; off screen in the screenshot) |
| Dream shards amassed | `+0x1CC` | Matched once (228) |
| Dream shards spent | `+0x1D0` | By position |
| Stars of fate used | `+0x1D4` | By position |
| Magical objects collected | `+0x1D8` | Matched once (1) |

### Behind pointers

| Field | Where | Status | Evidence |
|---|---|---|---|
| Magical objects | `+0xE0` vector (pointer, count, capacity) of 16-byte GUIDs | Confirmed by count | 0, 5, and 1 GUIDs for 0, 5, and 1 objects |
| Melodies | `+0x140` vector of 16-byte melody GUIDs | Inferred | Run 2: `Increase_Fountain_Effect`, `Instant_Level_Up`; run 3: `Instant_Level_Up`. Which melodies it lists isn't tied to the screen yet |
| Talents | `+0x10` vector; 28 `oCDtEntityCpntSkillControllerPersistentData` entries with a skill GUID at entry `+0x20` and state ints at `+0x30` and `+0x50` | Not resolved | Run 3 showed two talents; four entries read `+0x50 = 1` and six read `4`. No GUID-to-name table yet |
| Hero build stats (vitality, damage, and so on) | not in the record | — | Per-entity component values ("Hero build stats" in `live_memory_reading.md`); the reader doesn't read them |

## Trigger

A run is over when `Is in defeat sequence` or `Is in victory sequence` rises
from 0 to 1. In run 1 the defeat flag and `Current map id` → `-1` changed in
the same 500 ms poll. The flag is the better signal: `-1` also appears between
any two runs and doesn't say how the run ended.

The data is complete on arrival. The first read after the flag (0.7 s in run
2, 2.9 s in run 1) already held every value the screen showed, and later reads
at +1, +5, and +15 s were identical.

The window closes when the player presses **End**. The flags drop to 0 and
the record clears to zero within about a second. In run 1 the window lasted
76 s. A capture has to happen in that window, so it must be on the flag's
rising edge, not on a later state.

The record is live during play. Run 3's walks every 30 s showed level
reached and the damage rows rising through the run. Playtime is the
exception: it reads 0 until the flag, then holds the final time. The design
still reads only on the flag, because the summary is the complete set.

## Extraction in the reader

1. Add the two result flags to the tracked GlobalValue names, so the existing
   sweep reads them on its cadence.
2. Find the run record once per attachment by vtable (`oCDtCurrentRunProfileData`)
   and hold its address, the way `melodies.findHeroes` holds controllers. A
   scan costs 270–400 ms at the menu and up to 1.5 s on the busy summary
   screen, so take it at the menu, not at the trigger.
3. On the rising edge of either flag, read the record once: the scalars, the
   `+0x20` hero name, and the `+0xE0` GUIDs. Check that playtime is above zero
   before accepting it. A zero playtime means the read raced the clear or hit
   a stale address, so re-find the record and read once more. If that read
   is zero too, emit nothing; there's no partial record.
4. Add the map id, difficulty, chapter, and final melody states from the
   reader's last in-run frame. These come from channels that already
   exist, captured just before the flag.
5. Emit the summary through one new key, `run_summary`, which is `null` on
   every frame except the one carrying a capture. This keeps the fixed key
   count that `test-stdio` asserts. The summary carries a capture id (the wall
   clock time of the edge) so the main process can drop a duplicate.

## Storage

The history lives in the main process, in one file:
`<userData>/run-history.jsonl`. `userData` is the per-user app folder Electron
resolves from the product name (`Ravenswatcher`), so it's the same on every
install and outlives app updates and install slots.

- One JSON object per line, one line per run, appended when a capture
  arrives. Appending never rewrites earlier runs.
- Every line carries a schema version, `"v": 1`. A later version adds fields;
  it never changes what an existing field means.
- Store internal names and raw numbers (`Hero_Juliet_Carnival`, magical
  object GUIDs, map id, difficulty number, seconds), not display text. The
  renderer turns them into words at display time, so a language change or a
  renamed item never rewrites history.
- A line that doesn't parse is skipped and counted; the count shows in the
  diagnostics bar, which is opt-in.

Sample line, with run 2's values (wrapped here for reading). Fields that
weren't logged or were cut off in the screenshot are `null`:

```json
{"v":1,"id":1760545133000,"ended":"2026-10-15T15:18:53Z","result":"defeat",
 "hero":"Hero_Juliet_Carnival","difficulty":null,"map":null,"chapter":null,
 "playtime_s":1091.9,"level":6.52,
 "damage":{"total":55038.1,"dash":0,"trait":4042,"attack":16717,"power":19829,
           "special":7649,"defense":0,"ultimate":6799,"other":0,"highest":1449},
 "support":{"self_heal":635,"ally_heal":0,"self_shield":0,"ally_shield":0,
            "blocked":0,"revive_assists":0},
 "sufferings":{"taken":1519.8,"deaths_doors":1,"feathers":0},
 "resources":{"shards_amassed":null,"shards_spent":null,"stars_of_fate":0,
              "objects_collected":5},
 "objects":["a848f17e-…"],"melodies":[]}
```

## How the overlay shows it

A **History** tab beside the live readout:

- A list, newest first. Each row shows the date, hero portrait, **Victory** or
  **Defeat**, the map and chapter, difficulty, time, and level reached.
- Selecting a row opens the summary: the damage, support, sufferings, and
  resources rows as the game words them, plus the magical objects with their
  icons.
- With no history yet, the tab says "Finish a run and it shows up here."

Text stays in the game's own words. Nothing on screen names offsets, flags,
or capture ids.

## Open risks and live checks

1. **Total score and score details (required, not found).** Neither is
   in the record. The score page controller
   (`EntityCpntBookScoreUiController`) has no field holding the score in its
   first 0x800 bytes, and its one candidate vector reads count 2 in every
   run and mid-run, so it isn't the detail list. Next: while the summary is
   up, search writable memory for the displayed score as an int and a
   float, and name the object around each hit. That probe needs the score
   typed in by the player, so it costs one more run with a pause on the
   summary.
2. **Talents (required, not resolved).** Run 3 showed two talents. Of the
   28 skill entries, four read `+0x50 = 1` and six read `4`, so neither
   field alone marks a taken talent. The skill GUIDs also have no name
   table: the decoded hero definitions predate Kintaro and don't contain
   these GUIDs. Next: one run with a hero in the decoded set, where the
   talents are hovered, to tie GUIDs to names and test which state marks a
   taken talent.
3. **Victory.** Taken as given from the flags. A run that ends with neither
   flag rising is not recorded.
4. **Magical object names.** The GUIDs need a GUID-to-definition table. The
   app's item tables are keyed by definition name, so this needs the GUID
   from each cooked definition.
5. **Difficulty and chapter numbering.** Difficulty reads 1 for Twilight
   and 3 for Nightmare; Adventure wasn't logged. Chapter has one data point.
   Check: a death in chapter II or III with `run-end-watch.js` running.
6. **Fields by position.** Twelve statistics rows have only ever read zero
   where the screen showed zero. A run that uses dash damage, the trait,
   defense, ultimate, shields, or the Sandman confirms them.
7. **Multiplayer.** All three runs were solo. The summary has four player cards,
   and `HeroScoreData` is synced per player (`oCDtNetMsgSyncHeroScoreData`).
   With more players there may be more than one score instance, and the local
   player's has to be picked.
9. **Game patches.** The offsets are a layout, and the October 12, 2026 update
   already moved a hero-controller field. A capture whose playtime or level
   reads outside a sane range (0 to 14,400 s, 1 to 99) is dropped and reported,
   not stored.
