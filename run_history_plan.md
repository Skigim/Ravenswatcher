> Share Run implementation, October 17: the expanded card footer now copies
> a saved-run PNG instead of offering deletion. Dedicated offscreen HTML uses
> cached runtime art and bundled fonts, with a 1600x1000 default and vertical
> growth for large inventories. Score modifiers/effect descriptions/section
> counts are omitted. The image includes the GitHub URL in the footer.
> A narrow trusted IPC accepts ID/font choice only; main resolves the saved
> record, waits for resources, captures, normalizes DPI and writes clipboard.
> Display formatters normalize the stage to Epilogue, including saved aliases.
> Germania headings compose Kintarō's o/macron while retaining Unicode text.
> Deletion uses History selection: one row/two confirmations, bulk/three.
> npm ci, typecheck and full tests passed, including 1x/1.5x/2x DPI checks.
> The final 1600x1000 image was copied and pasted into a separate Electron
> document using an existing run/cache; no memory probes or save edits.
> Installed through app/install.ps1 at E:\Apps\Ravenswatcher and reopened.
> Installed executable and app.asar hashes match the tested package.
> Changes remain uncommitted on release/0.1.6; no release was performed.

> October 17: earned-note counts and advanced talent hovers are implemented,
> tested, rebuilt, and installed at E:\Apps\Ravenswatcher. The app was reopened.
> Full typecheck/npm test and final History UI checks passed. Installed app.asar
> and executable SHA256 hashes match build/release/win-unpacked.
> The private end watcher verified five attributes, ten talent descriptions,
> and a final snapshot with Galahad/Fairy Godmother completed and Merry Men
> active at 1/5. At Dwight's request, run 1792282214160 received those note
> fields in SQLite, with a backup/audit. Deleted older saves were not restored.
> Wishing Well and Stingy Jack score mappings are included; all 21 entries
> in that run resolve icons. Changes remain uncommitted on release/0.1.6.


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
reached and the damage rows rising through the run. Playtime first populated
at a chapter boundary in the October 17 victory, before the run ended. The
reader captures on the defeat/victory edge, never on positive playtime alone.

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

The history lives in `<userData>/run-history.sqlite`, managed by the main
process. `main.js` uses the per-user `Ravenswatcher` app data folder, so it
outlives app updates and install slots. The decoded `game-assets` cache
remains separate from run records.

- `runs.id` is the primary key. One row holds one complete versioned run
  object in `summary_json`, with hero, result, difficulty and time columns
  for SQL queries. A duplicate ID never overwrites an earlier run.
- The whole object is committed before the renderer is notified. SQLite's
  built-in runtime is used; there is no new native dependency.
- SQLite is the only supported history format; no legacy import is needed.
- Individual record deletion requires two explicit confirmations. Selected
  records and delete-all require three, including a typed count.
  Confirmation tokens expire after five minutes and are single use. A changed
  delete-all selection requires a new review. Cancelling never deletes data.
- Delete-all deletes every row in one SQLite transaction, retaining the empty database.
  Memory is cleared only after commit. Settings and decoded assets remain separate.
- New captures add `object_counts`, uint16 quantities parallel to `objects`,
  and a snapshot of the last resolved in-run `melodies` payload. Unknown
  counts or melodies are null; older rows may omit them. No old quantity
  is inferred as one. Empty arrays mean a known empty inventory/payload.
- Object identities stay as GUIDs; the runtime tables resolve current names,
  descriptions and icons. Quantities remain paired with their GUIDs.
- Talents, statistics, score lines and melody states stay with the run ID.
  Melody art uses the same cache and state treatment as the live display.

Example stored object, with run 2's values (wrapped here for reading). Fields that
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


The collapsed card uses a borderless 96px hero portrait, an icon-only
40px difficulty marker, the score, and ten fixed talent slots. Filled
slots keep selection order and rarity borders; unfilled slots remain blank.
Hero identity/level, difficulty and talent names/rarities appear in the
shared hover tooltip, with accessible labels. The portrait and slots scale
at narrower widths; the expanded breakdown keeps its existing labels.

- A list, newest first, laid out like a match history. Each card shows
  **Victory** or **Defeat**, difficulty, date, time, the hero, level, map and
  chapter, the score, and the talents as chips in their rarity colour.
- Selecting a card opens the summary in place: the score lines, the talents
  with rarities, and the damage, support, sufferings, and resources rows as
  the game words them. Hero portraits, difficulty icons, and talent art
  arrive through the same runtime asset cache as the Sandman shop. Objects
  show their icon, name, quantity, and existing shop tooltip. Melodies show
  the saved snapshot with portraits and lifecycle states. Older histories
  retain text fallbacks and say when quantities or melodies were not recorded.
- With no history yet, the tab says "Finish a run and it shows up here."

Text stays in the game's own words. Nothing on screen names offsets, flags,
or capture ids.

## Open risks and live checks

1. **Score readiness.** The detail buffer pointer moved once, in one run
   (Kintaro's buffer to Scarlet's). The first run of a game session, with no
   earlier score page, hasn't been observed.
2. **Talents.** Selection, names and rarity work for Kintaro and Scarlet.
   The October 17 Kintaro victory supplied a player-verified History card
   with ten talents, including Rare, Legendary and Ultimate rarities.
3. **Victory.** The October 17 Kintaro victory was captured automatically
   and player-verified. Chapter transitions did not raise end flags. A run
   that ends with neither flag rising is not recorded.
4. **Magical object names.** The GUID join is confirmed: the record's
   16-byte GUID matches the serialized `Dt Magical Object Data` component
   identity in the object's definition. See `live_memory_reading.md`.
   All 15 final GUIDs in the October 17 run resolved to names and icon
   resources. Runtime tables now resolve shipped GUIDs through the existing
   shop name/icon tables. All 15 screen-verified stack quantities total 27;
   the reader now persists them, and History renders them with the objects.
5. **Difficulty and chapter numbering.** Difficulty reads 1 for Twilight,
   2 for Darkness, and 3 for Nightmare; Adventure wasn't logged. Chapters
   were observed progressing 0,1,2,3 with map ids 0,1,2,3 in the October 17
   victory, ending at Baba Yaga. Final numbering was player-verified.
6. **Fields by position.** Five rows still have only read zero: dash,
   trait, other damage, healing to allies, and shield to allies. Self shield
   matched a player-verified nonzero 23,746 in the October 17 victory.
   Run 4 supplied nonzero screen matches for defense, ultimate, revive
   assists, shard spending, Stars of Fate, and feathers. Next: use the five
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


## Player-verified live victory, October 17, 2026

Kintaro, Twilight, Baba Yaga map: score 529, time 57:37, level 14.09.
The player confirmed every visible field in the expanded History card,
including all score lines, ten talent names and rarities, and all 23
statistics. The independent production runs worker captured the same
summary. The record address held across chapter/map counters 0,1,2,3;
end flags stayed zero through chapter changes, and victory rose at the
final end. Playtime populated at a chapter boundary, so a positive playtime
alone is not evidence that the run ended. Both research watchers were stopped.

Self shield read 23746.185546875 and displayed 23,746, resolving its earlier
position-only status. All 15 final Magical Object GUIDs resolved to cooked
definitions and existing icon assets. A subsequent inventory screenshot
verified all 15 stack quantities: 4,4,1,1,1,1,3,4,1,2,1,1,1,1,1, totaling
27 collected. Quantities are uint16-LE values in the `+0xF0` vector, in GUID
order. New v1 summaries now persist these parallel quantities; old records
remain readable without inventing missing counts. This capture validates one full victory; it does not settle
the other open cases above.

Private evidence: `stats/run-history-20261017-live/` in the research checkout,
including `player-validation.json`, `verified-run-summary.json`, and the
player-confirmed screenshot. No captured game data is copied into this repo.


## Expanded History tabs, October 17, 2026

Each expanded run now has seven categories: an icon-only Hero Details tab,
Score Details, Melodies and Magical Objects, Damage Dealt, Support,
Sufferings, and Resources. Hero Details contains the five saved attributes
and ten fixed talent slots. Object icons share the shop cache, use rarity
from the shipped definition, and show saved stack badges. Melody portraits
use the saved state. Names and descriptions are available on hover/focus.
Selection is independent per run and survives history/assets refreshes.
Damage displays each ability/source amount with its share of total damage.
Older records keep unknown attributes, quantities and melodies distinct
from zero or an empty build.

The current Kintaro run's five attributes were restored from the supplied
Statistics screenshot, and its 15 stack quantities from the verified
watcher capture (27 total). The end-screen HUD read had already reset three
attributes; it did not validate a final-stat memory snapshot. Future
pre-end attribute capture is implemented and synthetically tested, but
still needs a real run-end comparison. Melodies absent from this older
record remain unavailable.


### Melody snapshot retention

The Live view clears when map id becomes -1. History must retain the last
melody payload through that clear and through any end-screen level reset,
until the end edge and delayed score have been saved. The reader now relays
the sweep's map id with melody updates; clearing Live does not send a History
reset. The runs worker keeps names, portrait keys, effects, note requirements
and final lifecycle states through menus and chapter outages. A confirmed
next active run or same-map restart clears the previous snapshot. Synthetic
regressions exercise locked/active/completed updates, end-screen reset before
capture, missing readings, next-run clearing and independent payload copies.
This saves the final state, not a timestamped timeline of every progress update.
The completed Kintaro run predates this relay; its saved watcher files contain
no melody payload to restore.


### Attribute art, typography and startup navigation

The five hero attributes now use the game's HUD icons with values below and
hover/focus labels. They are decoded by the existing runtime icon cache.
Settings has a persistent Stylized fonts switch, on by default: Germania One
for headings, Alegreya Sans for body text; turning it off restores Archivo.
Both font families and their original OFL licenses ship for offline use,
independently of the game's bitmap font atlases.

History is the initial view. A confirmed active map switches to Live once;
manual History browsing persists through later polls, unresolved maps, and
chapter changes. A confirmed no-run map or a new game PID arms the next switch.
This uses existing state frames and does not add another memory read.


### Score icons and connection indicator

Score Details keeps one icon for each saved score line, in order, including
repeated activities. Hover or keyboard focus reveals the exact saved line.
Base score reuses the saved difficulty icon; level, victory, multiplayer and
known activities use their matching resource art. Blood Ritual matches the
crossed-swords resource still named KeyKeeper. Unrecognized or localized
labels retain their full text and draw a question-mark icon.

Connection status is a compact dot: connected, connecting, waiting, stale
or unavailable. Hover/focus supplies its name and diagnostic detail, with
an accessible label. Updating the connection also refreshes an open tooltip.


Score-art install check: the old private reference
`Book_Menu_Multiplayer_Team_Icon.png` is absent from the current game. The
runtime cache build correctly failed atomically rather than publishing
partial output. Multiplayer now uses the current
`BookMenu/UI_Icon_PlayerResult_2.png` resource. All 14 manifest score texture
paths were checked against the current install before rebuilding.


### Room icons in the map panel

Cursed stash entrances now reuse the score page's purple cursed-room emblem.
Combat entrances use the existing red HUD crossed swords; this is a panel
choice, not a claim that the game has a separate combat-room minimap marker.
Gold rooms already use Dagda's Harp, and Mirror rooms retain the mirror.
All four keep their existing hover labels. Sublevel records are still excluded
from counts, and an unrecognized room type retains the generic stash icon.
No new texture resource or additional memory read is needed for this change.
