# Run history plan

This plan adds run history to Ravenswatcher: when a run ends, the overlay
records what the victory or defeat summary showed, keeps it across runs and
app updates, and lets the player look back over past runs.

The first version is built: `app/reader/runs.ts` and `runs-worker.ts`
capture the run, `app/history.ts` stores it, and the **History** tab shows
it. The rest of this file is the design it follows and the evidence behind
it. The evidence comes from three solo defeats on
October 15, 2026, and a two-player defeat on October 16, each matched against
the summary screen and player-supplied build details:

| Run | Hero | Difficulty | Playtime | Level reached | Damage dealt | Score |
|---|---|---|---|---|---|---|
| 1 | Kintaro | Twilight | 04:26 | 3.06 | 9,072 | 122 |
| 2 | Juliet | Adventure | 18:11 | 6.52 | 55,038 | 196 |
| 3 | Kintaro | Nightmare | 04:57 | 2.71 | 11,134 | 139 |
| 4 | Kintaro | Darkness | 20:01 | 5.26 | 39,694 | 258 |

A fifth capture, Scarlet on October 16, read a different score (195), four
score details and four selected talents. The player confirmed Legendary=3
for Devourer in reply to the score/build confirmation request. That capture
also exposed stale previous-run score data at the defeat flag; see the
freshness check below.

The probes are `app/reader/bench/run-end-watch.js` (phase flags, every
GlobalValue, and instance dumps across the transition) and
`app/reader/bench/run-record-walk.js` (the run record and everything it points
at). The confirmed method is recorded in `live_memory_reading.md` under
"The run record."

## What memory holds

The game keeps one record of the current run, an `oCDtCurrentRunProfileData`
embedded in the game profile (`oCDtGameProfile`). The score data shown on the
summary (`HeroScoreData`) is embedded in that record at `+0xD8`. The profile
has one embedded pair, found by the same RTTI walk the melody and shop
channels use. Run 4 also had a second `HeroScoreData` instance for co-op;
the embedded profile matched the local player. The record exists from the
main menu onward and keeps its address for the session.

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
| Difficulty | GlobalValue `Game Difficulty` | int | Confirmed | 1 on Twilight, 2 on Darkness, 3 on Nightmare; Adventure wasn't logged |
| Chapter reached | GlobalValue `Current chapter` | int | Confirmed for chapter I | 0 when runs 1 and 4 died in chapter I; later chapters taken to count up |
| Map | GlobalValue `Current map id`, last value before `-1` | int | Confirmed | The reader already tracks it; it reads `-1` on the summary |
| Total score | score page entity, named `Score Label` component; see method | numeric UTF-8 text, independently matched to int cache | Matched once | 258 in run 4, read by fresh RTTI discovery without supplying the score |
| Score details | score controller `+0x1F8` vector, stride `0x20`, text at entry `+0x08` | UTF-8 strings plus icon pointers | Matched once | All five run 4 lines matched the player: base 140, level x1.44, multiplayer +10%, Grimoire +5%, Side Quest +25% |

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
| From defense | `+0x198` | Matched once (3,765.81 -> 3,765) |
| From ultimate | `+0x19C` | Matched once (1,024.87 -> 1,024) |
| Other sources | `+0x1A0` | By position |
| Highest single damage | `+0x1A4` | Confirmed (173.15; 156) |
| Self healing | `+0x1A8` | Confirmed (63.58; 78.78) |
| Healing to allies | `+0x1AC` | By position |
| Self shield | `+0x1B0` | By position |
| Shield to allies | `+0x1B4` | By position |
| Damage blocked | `+0x1B8` | Confirmed (61.73; 364.2) |
| Revive assists | `+0x1BC` | Matched once (3) |
| Damage taken | `+0x1C0` | Confirmed (426.7; 1,519.8; 708.5) |
| Death's doors | `+0x1C4` | Matched once (3) |
| Raven feathers consumed | `+0x1C8` | Matched once (3 visible in run 4) |
| Dream shards amassed | `+0x1CC` | Matched once (228) |
| Dream shards spent | `+0x1D0` | Matched once (270) |
| Stars of fate used | `+0x1D4` | Matched once (2) |
| Magical objects collected | `+0x1D8` | Matched once (1) |

### Behind pointers

| Field | Where | Status | Evidence |
|---|---|---|---|
| Magical objects | `+0xE0` vector (pointer, count, capacity) of 16-byte GUIDs | Distinct-type count matched | Run 4 has five GUIDs for five distinct types and seven objects; `+0xF0` begins with uint16 counts 1,3,1,1,1, a candidate parallel quantity vector, still needing GUID/order validation |
| Melodies | `+0x140` vector of 16-byte melody GUIDs | Inferred | Run 2: `Increase_Fountain_Effect`, `Instant_Level_Up`; run 3: `Instant_Level_Up`. Run 4 has one GUID despite no melodies unlocked; this must not be treated as the unlocked-melody list |
| Talents | `+0x10` persistent components → hero-controller persistent entry `+0xE8` selected GUID vector; join skill GUID `+0x20` to rarity `+0x50` and loaded settings/names | Matched once | Run 4: all five names and rarities match, in screen order; fresh discovery succeeded again with Statistics closed. See "Run talents" in `live_memory_reading.md` |
| Hero build stats (vitality, damage, and so on) | not in the record | — | Per-entity component values ("Hero build stats" in `live_memory_reading.md`); the reader doesn't read them |

## Trigger

A run is over when `Is in defeat sequence` or `Is in victory sequence` rises
from 0 to 1. In run 1 the defeat flag and `Current map id` → `-1` changed in
the same 500 ms poll. The flag is the better signal: `-1` also appears between
any two runs and doesn't say how the run ended.

The run-record data is complete on arrival. This does not establish the
readiness of the separately located score UI. The first record read after the flag (0.7 s in run 2, 2.9 s in run 1)
already held every matched record value, and later reads
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
5. Read total score and detail lines from the score UI by the method in
   `live_memory_reading.md` under "Run score and score details." On the
   edge, hold the score controller's detail buffer pointer (`+0x1F8`) as a
   baseline. Poll until the pointer moves and the label and int cache
   agree, then read score once, before End. Run 5 kept the previous run's
   score for over 25 seconds, and the buffer moved when the current score
   arrived. If End comes first, emit the summary with `score: null`.
6. Read selected talent GUIDs from the hero persistent entry's `+0xE8`
   vector, join to persistent rarity and resolve names from loaded
   definitions/listeners by "Run talents" in `live_memory_reading.md`.
   Rarity codes 0–4 are Common, Rare, Epic, Legendary and Ultimate; keep
   any other code as a raw value. Reject missing or ambiguous names.
7. Emit the summary through one new key, `run_summary`, which is `null` on
   every frame except the one carrying a capture. This keeps the fixed key
   count that `test-stdio` asserts. The summary carries a capture id (the wall
   clock time of the edge) so the main process can drop a duplicate.

## Storage

The history lives in the main process, in one file:
`<userData>/run-history.jsonl`. `main.js` sets `userData` to a `Ravenswatcher`
folder under the per-user app data directory, so it's the same on every
install and outlives app updates and install slots. On first launch it moves
the folder earlier releases used, `ravenswatch-live-readout`, to that name.
The decoded `game-assets` cache lives beside it.

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

- A list, newest first, laid out like a match history. Each card shows
  **Victory** or **Defeat**, difficulty, date, time, the hero, level, map and
  chapter, the score, and the talents as chips in their rarity colour.
- Selecting a card opens the summary in place: the score lines, the talents
  with rarities, and the damage, support, sufferings, and resources rows as
  the game words them. The portrait is the hero's initial, and magical
  objects show as a count, until their art and names can be resolved.
- With no history yet, the tab says "Finish a run and it shows up here."

Text stays in the game's own words. Nothing on screen names offsets, flags,
or capture ids.

## Open risks and live checks

1. **Score readiness.** The detail buffer pointer moved once, in one run
   (Kintaro's buffer to Scarlet's). The first run of a game session, with no
   earlier score page, hasn't been observed.
2. **Talents.** Selection, names and rarity work for Kintaro and Scarlet.
   Rare=1 comes from the player, not a screen match. Delegated names are
   taken as available at the flag.
3. **Victory.** Taken as given from the flags. A run that ends with neither
   flag rising is not recorded.
4. **Magical object names.** The app has item tables, keyed by definition
   name. How the record's GUIDs map to those names isn't known yet.
5. **Difficulty and chapter numbering.** Difficulty reads 1 for Twilight,
   2 for Darkness, and 3 for Nightmare; Adventure wasn't logged. Chapters
   are taken to count up from 0 for chapter I.
6. **Fields by position.** Six rows still have only read zero: dash,
   trait, other damage, healing to allies, self shield, and shield to allies.
   Run 4 supplied nonzero screen matches for defense, ultimate, revive
   assists, shard spending, Stars of Fate, and feathers. Next: use the six
   remaining sources and match their statistics rows.
7. **Multiplayer.** Run 4 had two players and two `HeroScoreData`
   instances. All 23 statistics in the current-run profile's embedded score
   matched the local player's screen (39,694 damage versus the other
   player's 39,619). This validates that profile in one co-op run, not an
   arbitrary first-instance rule for player score objects.
9. **Game patches.** The offsets are a layout, and the October 12, 2026 update
   already moved a hero-controller field. A capture whose playtime or level
   reads outside a sane range (0 to 14,400 s, 1 to 99) is dropped and reported,
   not stored.
