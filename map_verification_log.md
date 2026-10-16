# Map verification log

Whether the readout's questline answer is the one the game actually placed,
checked per map against a live process.

## What this can and cannot establish

The probe reads through the same code the app reads through. It cannot be a
second opinion on the app's answer — if the marker table is wrong, the probe
is wrong the same way. Ground truth for "which questline is this" is the game
on screen, and that is the operator's job.

What the probe adds is the intermediate state the panel discards, so a wrong
answer has a chance to look wrong. The panel shows a conclusion. A wrong
conclusion built from plausible working is indistinguishable from a right one.
Wrong working usually is not.

## The two halves of a marker

A marker can fail in two unrelated ways, and they need different evidence.
The Roc bug was both at once, which is why it survived so long.

**Spelling.** Is this path a string the game actually carries? Checkable with
no run loaded, on any map, at any time. A wrong path is ABSENT — zero copies
in the process. A right path is LOADED — several copies with matching
resource-object pointer triples.

**Placement.** Does the map generator ever create an entity pointing at this
path from `oCEntity+0x38`? Only a live run on that questline answers it, and
only a run that chose that side of the pair.

`Roc_Quest_Manager` is the case that separates them: correctly spelled,
genuinely resident, and never placed on any run. Residency proves the string
exists in the game's data. It proves nothing about use.

## Residency is process-wide, not per-map

Measured 2026-08-29 with **no run loaded** — map id −1, hero level 0: all
twelve marker paths across all three maps read LOADED, 4–5 copies each with
matching triples, zero entities.

**"From startup" is not yet measured.** Every read so far is against a
process that had already loaded Dark Hills at least once, so residency could
be a leftover from that load rather than present from launch. Settling it
needs a genuine game relaunch, checked at the menu before entering a run.
Until then the safe statement is that residency is not scoped to the map
currently running.

`app/reader/placement.js` says both of a map's questline resources are loaded
"on every run of that map," which reads as though residency were scoped to the
running map. It is not. The whole path catalog is resident from startup.

Two consequences:

- ABSENT never fires for a correctly spelled path, so it is a clean spelling
  signal and nothing else. It cannot indicate "wrong map."
- Only the entity column is map-scoped. Cross-map residency is normal and is
  not evidence of anything.

## The procedure

**Spelling, any time, no run needed:**

    node app/reader/bench/spell-control.js

Runs known-good and known-bad paths through the same machinery before
reporting, so a check that has stopped discriminating says so instead of
passing everything. Then lists any shipped marker path that is not resident.

**Placement lags the map id change by tens of seconds.** Measured 24-38 s on
a Storm Island -> Avalon transition. Run the probe once the map has settled,
or use the watcher, which retries while the answer is inconclusive exactly as
`placementDue()` does. A fixed delay reports "nothing placed" and looks like a
broken marker.

**Watching a transition, started before it happens:**

    node app/reader/bench/transition-watch.js [outfile]

Timestamps every change to map id, hero level, the step counters and the
melody channel, and classifies markers on the map you land on, retrying until
the pair test is conclusive. Its classification scans block its own poll loop
for 8-10 s, so it under-samples during those windows; treat any outage
duration it reports as an upper bound.

**Placement, while the map is loaded:**

    node app/reader/bench/verify-map.js

Attaches a second read-only reader beside the app's own. The app latches its
placement answer per map generation and then stops scanning, so asking the app
only replays the latch; a fresh attach re-derives it.

Reads the output in this order:

1. **Tracked values** against the panel. A probe runs tens of seconds after
   a screenshot is taken, so anything that moves while you play will differ
   and that difference is elapsed time, not a defect. `Is In Combat` in
   particular tracks the game without fail in continuous observation and is
   not under test here. Map id and the step counters should agree exactly.
2. **The marker table**, every path with its state and counts. On the current
   map, one side of the pair should be PLACED and the other LOADED.
3. **The pair test.** The current map must be conclusive and name what the
   panel shows. The other two maps read inconclusive.
4. **Melodies**, three slots with note counts and lifecycle state.

## Coverage

| Questline | Map | Spelling | Placement |
|---|---|---|---|
| Jack | Dark Hills | verified 2026-08-29 | **observed placed 2026-08-29** |
| 3 Pigs | Dark Hills | verified 2026-08-29 | confirmed before this log |
| Roc | Storm Island | verified 2026-08-29 | **observed placed 2026-08-29** |
| Sinbad's Cyclop | Storm Island | verified 2026-08-29 | **observed placed 2026-08-29** |
| Mordred | Avalon | verified 2026-08-29 | **confirmed working 2026-09-12, by exclusion ‡** |
| Tree / Morgan | Avalon | verified 2026-08-29 | **observed placed 2026-08-29** |

† **Historical, 2026-08-29.** At the time this was accepted rather than
observed — a judgement, not a measurement, because no run had yet been on
Avalon with Mordred drawn while the entity column was being read.

`Mordred_Quest_Manager` itself is now confirmed permanently absent — it is
resident (correctly spelled, LOADED) but has never been observed to place on
any run, Mordred drawn or not. Of the four questline managers whose behaviour
on their own active run is known, three place — `Jack_Quest_Manager`,
`Tree_Quest_Main_Manager`, `Sinbad_Cyclop_Quest_Main_Manager` — and
`Mordred_Quest_Manager` does not, the same failure shape as
`Roc_Quest_Manager`. Naming does not sort the two groups.

‡ **Confirmed working 2026-09-12, but by exclusion, not by a positive Mordred
marker.** A real Mordred run on Avalon showed the correct questline on the
panel — see the 2026-09-12 entry below. The mechanism is `state.ts`'s
`ELIMINATION_BY_MAP`: Tree's manager is the only side of this pair with a
marker confirmed to place and persist, so Mordred is inferred from that
marker's sustained absence (`PLACEMENT_ELIMINATION_SWEEPS` consecutive misses),
never from a Mordred entity placing. A best-effort fast-path list of Mordred
props exists and can resolve a lucky sweep directly, but that list's own
residency was found inconsistent on 2026-09-12 (see `QUEST_MARKERS.mordred`'s
comment in `state.ts`) — present on that run, absent on an earlier one. Do not
read "Avalon works now" as "Mordred has a positive marker." It does not; the
guarantee is Tree's absence, not anything Mordred-side.

What a future reader should not do is treat a fast-path hit as evidence that
list is reliable. If it stops hitting on some future run, elimination is the
part that has to keep working, and `node app/reader/bench/verify-map.js`
settles any doubt about a given run in seconds.

Both Storm Island questlines are confirmed from their own side, and the
cross-placement question that hung over the map is answered in both directions
— a Roc run places no Cyclops entity, and a Cyclops run places no Roc entity.
`questFromPlacement` therefore sees exactly one side hit on either run, which
is the condition it answers under.

For Avalon that question is answered one way only: a Tree run places no Mordred
entity, observed. Whether a Mordred run places any `Tree_*` is untested.

## Entries

### Spelling control — 2026-08-29 — PASS

No run loaded. Controls behaved as required:

    ABSENT   0 copies   pre-fix Roc path (one directory level short)
    LOADED   4 copies   Storm_Island\Quest_Sinbad\Quest_Roc\Roc_Quest_Manager
    ABSENT   0 copies   invented entity, correct prefix and shape
    ABSENT   0 copies   Jack_Quest_Manager with one character changed
    LOADED   5 copies   DarkHills\Jack\Jack_Quest_Manager

All twelve shipped marker paths resident, none absent. The spelling half is
closed for all six questlines.

The one-character typo reading ABSENT is what makes this a control rather than
a restatement: the check distinguishes a real path from a near-miss, so a
LOADED verdict carries information.

### Dark Hills — Jack — 2026-08-29 — PASS

Hero level 1, map id 0, eleven of eleven tracked values resolved, every quest
step counter 0. Placement scan 5416 ms.

    x1    DarkHills\Jack\Jack_Quest_Manager.entity.ot

No other marker path had any entity pointing at it — the three pig houses
included, which is the correct reading for the side of the pair that was not
chosen. The pair test returned `jack` on Dark Hills and inconclusive on Storm
Island and Avalon.

The panel's "Jack / Not Started" is coming from placement, not from the step
cascade: `Jack_Quest_Current_Step` was 0, which is the reading the deprecated
cascade cannot name a questline from.

No entity from another map's marker set was placed. That is one run's worth of
evidence toward the Storm Island cross-placement risk and does not settle it.

### Dark Hills — Jack — 2026-08-29 — second run — PASS

A new run in the same process (pid unchanged, sweep counter continuous from
the first entry). Hero level 1, map id 0, eleven of eleven values resolved,
every step counter 0. Placement scan 9351 ms.

    PLACED  6 copies  5 triples  1 entity   DarkHills\Jack\Jack_Quest_Manager
    LOADED  5 copies  4 triples  0 entities  the three pig houses

Pair test `jack` on Dark Hills, inconclusive on the other two. Melodies matched
the panel exactly: Hansel & Gretel 5 notes active, Long John Silver 6 locked,
Little Tailor 5 locked.

**What this run demonstrates about the method.** `pigs` reads LOADED with zero
entities — structurally identical to Roc's broken manager. On this run that is
the correct answer, because Jack was chosen and pigs is the side that was not.
A working marker on the unchosen side and a permanently broken marker cannot
be told apart from one run. The old hit/miss output printed MISS for both and
hid the distinction. Only a run that picks pigs separates them.

**Copy counts drift within a process.** Jack's manager went 5 copies → 6 and
the pig houses 4 → 5 between reads, while triples stayed flat. Extra string
copies appear without resource-object triples. Only presence versus absence
carries information; the counts do not.

**Placement scan timing is drifting.** 4639 ms, 5416 ms, 9351 ms across three
reads of twelve targets. `placedAmong` is documented at 3.7 s against a 1.5 GB
working set. These reads run a second reader alongside the app's own against a
process that has been up fifteen minutes. Nothing is wrong, but 3.7 s should
not be treated as a budget.

### Storm Island — Roc — 2026-08-29 — PASS

Same run continued from Dark Hills. Hero level 6, map id 1, Chapter II,
eleven of eleven values resolved, every step counter 0.

    PLACED  1 entity   Roc_Cave_Entrance_A_In
    PLACED  1 entity   Roc_Cave_Entrance_A_Out
    LOADED  0 entities Roc_Cave_Entrance_B_In
    PLACED  1 entity   Roc_Cave_Entrance_B_Out
    PLACED  1 entity   Roc_Quest_FogOfWar_Eraser
    LOADED  0 entities Sinbad_Cyclop_Quest_Main_Manager

Pair test `roc` on Storm Island, inconclusive elsewhere. Panel showed
Roc / Not Started. The branch fix is confirmed on a second, independent run.

**`B_In` was unplaced again.** That is two runs where this specific entrance
does not appear while the other three do. Keying Roc on all four entrances
plus the eraser, rather than on whichever one looked canonical, is what makes
the marker survive that. Confirmed rather than argued.

**One direction of the cross-placement risk is now closed.** A Roc run places
no Cyclops entity. The other direction — whether a Cyclops run places any
`Roc_*` entity, which would make both sides of the pair hit and take the
answer inconclusive — is untouched by this and still needs a Cyclops run.

### Transition: Dark Hills -> Storm Island — 2026-08-29

    [ 89.7s] Hero Level: 5 -> 6
    [ 97.7s] Current map id: 0 -> 1        (no -1)
    [ 99.7s] Jack_Quest_Current_Step: 9 -> 0

Answers the parked question in `deferred_investigations.md`: a mid-run map
change does not route through map id -1. Step counters reset about two seconds
after the id moves.

**Placement lags the map id change, and a one-shot probe will misreport it.**
The first watcher classified Storm Island three seconds after the id flipped
and found every marker LOADED with zero entities — pair test inconclusive,
indistinguishable on paper from six broken markers. The generator had not
placed anything yet.

The app is immune to this because `placementDue()` keeps scanning every sweep
while the answer is inconclusive and stops once it is not. That retry loop is
not an optimisation detail; it is what makes the answer correct at all. Any
probe written against this data has to mirror it, and
`transition-watch.js` now does, logging each attempt so the delay stays
visible instead of being smoothed away.

### Avalon — Tree / Morgan — 2026-08-29 — PASS

Same run continued from Storm Island. Hero level 9, map id 2, Chapter III.

    PLACED  copies 8  triples 8  1 entity   Avalon\Objects_Tree_Quest\Tree_Quest_Main_Manager
    LOADED  copies 5  triples 5  0 entities Avalon\Mordred\Mordred_Quest_Manager

Pair test `tree` on Avalon, inconclusive elsewhere. Panel showed
Tree / Morgan / Not Started.

**First of the three never-observed markers closed.** `tree` is keyed on a
`*_Quest_Main_Manager` and that manager is placed, the same way `jack`'s is.
Roc's manager stays the only one that is never placed.

**Copy counts rise on the map where the entity is placed.** `tree` read 4
copies on Dark Hills and Storm Island and 8 on Avalon; `roc` read 4 elsewhere
and 6 on Storm Island; `jack` 4 elsewhere and 6 on Dark Hills. Do not use this
as a signal: `Roc_Cave_Entrance_B_In` also read 6 copies on Storm Island with
zero entities. The entity column is the answer; copies only correlate.

### Transition: Storm Island -> Avalon — 2026-08-29

    [1565.7s] Current map id: 1 -> 2        (no -1, second observation)
    [1567.2s] Roc_Quest_Current_Step: 6 -> 0

Second confirmation that a mid-run map change does not route through -1, and
that the step counters reset after the id moves rather than with it -- 1.5 s
here against 2.0 s on the Dark Hills boundary.

**Placement lags the map id change by tens of seconds.**

    classify #1  (+10s)  INCONCLUSIVE -- nothing placed anywhere yet
    classify #2  (+24s)  INCONCLUSIVE -- nothing placed anywhere yet
    classify #3  (+38s)  tree

Between 24 and 38 seconds elapsed before the generator had placed the marker.
The first version of this watcher allowed three seconds and reported every
marker on the new map as unplaced, which on paper is indistinguishable from
six broken markers.

This is why `placementDue()` scans every sweep while the answer is
inconclusive and stops once it is not. Nothing that reads this data can use a
fixed delay. The retry is the mechanism.

### Melody channel across the same transition

    [1576.7s] MELODIES null
    [1590.7s] MELODIES  identical pool, identical states

Written up in `open_findings.md`. The measured duration is not trustworthy:
the watcher's classification scans block its own poll loop for 8-10 s, so an
outage overlapping a scan is inflated by up to that much. Live play reports a
quick recovery. A melody-only watcher that never scans is what would settle it.

### Run end and process exit — 2026-08-29

    [2716.2s] MELODIES  Hansel & Gretel completed, Long John Silver completed,
                        Little Tailor active
    [2972.9s] Current map id: 2 -> -1
    [2981.9s] MELODIES null
    [2983.7s] Hero Level: 14 -> 0          <- 10.8 s after map id
    [3022.7s] every step counter -> null   (process tearing down)
    [3023.2s] game process exited

Independently confirms the ten-second figure the `no_run` condition is built
on: 10.8 s between map id reaching -1 and Hero Level reaching 0.

**What that window actually renders.** `no_run` is `mapId === -1 && level === 0`.
Through those 10.8 s mapId is -1 and level is still 14, so `no_run` is false
and the panel shows a live run at level 14 on a map that resolves to null.
Dropping the level term would show the between-runs state immediately.

That inverts the reasoning recorded when the mid-run question was first
answered. The level term was documented as protecting against mid-run loads
flashing the between-runs screen; mid-run loads never produce -1, so it never
did that. Its real effect is an eleven-second delay at the end of every run.

**Still not safe to drop.** Entering a run is unmeasured. If Hero Level rises
before map id leaves -1, a bare map-id test would flash the between-runs
screen as a run starts. Every observation so far either attached mid-run or
watched a run end. That boundary is the one reading left before this can be
simplified.

**Read on 2026-08-30 and again on 2026-09-01; the term was dropped.** Map id
leaves -1 first both times, by 13 s and by 26.2 s, so a bare map-id test does
not flash the between-runs screen as a run starts. `no_run` is now
`mapId === -1` alone. See "Does a mid-run map change pass through
`Current map id` -1?" in `deferred_investigations.md`.

Also confirmed: the reader's own exit path. `alive()` went false when the game
closed and the watcher terminated on its own with status 0, rather than
lingering as an orphan attached to a dead process.

### Full-run summary — 2026-08-29

One run, three maps, watched end to end: Dark Hills (Jack) -> Storm Island
(Roc) -> Avalon (Tree / Morgan), levels 1 to 14.

Confirmed placed on this run: `jack`, `roc`, `tree`. Confirmed LOADED and not
placed on the map where each is the unchosen half of the pair: `pigs`,
`cyclop`, `mordred`.

Both mid-run map changes went directly from one id to the next with no -1, and
both reset their step counters 1.5-2.0 s after the id moved.

### Storm Island — Sinbad's Cyclop — 2026-08-29 — PASS

The run this log had been waiting for. Hero level 5, map id 1, Chapter II,
eleven of eleven values resolved. `Cyclop_Quest_Cave_Current_Step` 1, every
other step counter 0.

    PLACED  1 entity   Sinbad_Cyclop_Quest_Main_Manager   6 copies, 5 triples
    LOADED  0 entities Roc_Cave_Entrance_A_In
    LOADED  0 entities Roc_Cave_Entrance_A_Out
    LOADED  0 entities Roc_Cave_Entrance_B_In
    LOADED  0 entities Roc_Cave_Entrance_B_Out
    LOADED  0 entities Roc_Quest_FogOfWar_Eraser

Pair test `cyclop` on Storm Island, inconclusive elsewhere. Panel showed
Sinbad's Cyclop / Cave Step0. Melody channel resolved all three slots.

**The cyclop marker places.** One entity on
`Sinbad_Cyclop_Quest_Main_Manager.entity.ot`, which is a `*_Main_Manager` like
`jack` and `tree`. Roc's manager remains the only one in the table that is
never placed.

**The other direction of the cross-placement risk is now closed.** A Cyclops
run places no `Roc_*` entity — all five read LOADED with zero entities. Taken
with the Roc run that placed no Cyclops entity, both directions on Storm Island
are answered: exactly one side of the pair hits on either run, which is the
condition `questFromPlacement` answers under. Nothing on this map now rests on
an unobserved marker.

**A correct panel does not prove this on its own, which is why the probe was
run.** `Cyclop_Quest_Cave_Current_Step` reads 1 from map load, so the
`OTHER_QUESTS` step fallback names Cyclops with or without placement, and a
placement failure would have rendered identically. The entity column is what
separates them.

### Avalon — Mordred — 2026-09-12 — PASS, by exclusion

Live run, Avalon drawn with Mordred as the questline (hero Snow Queen).
Checked after the quest had already finished (`Mordred_Quest_Current_Step` 6,
`Mordred_Quest_Boss_Is_Dead` 1) — not the run itself, the state it left
behind:

    ABSENT  0 entities  Avalon\Objects_Tree_Quest\Tree_Quest_Main_Manager
    PLACED  1 entity    Avalon\Mordred\Mordred_Quest_Destructible_Door
    PLACED  1 entity    Avalon\Mordred\Mordred_Portcullis
    PLACED  1 entity    Avalon\Mordred\Mordred_Arena_Teleporter_In
    PLACED  1 entity    Avalon\Mordred\Mordred_Arena_Teleporter_Out
    PLACED  1 entity    Avalon\Mordred\Mordred_Undergound_Teleporter_In
    PLACED  1 entity    Avalon\Mordred\Mordred_Undergound_Teleporter_Out
    PLACED  1 entity    Avalon\Mordred\Mordred_Undergound_Entrance_Minimap_Marker

Panel showed Mordred correctly, confirmed by the operator during the run.

**Tree's absence is what this run proves, not Mordred's presence.** All seven
fast-path Mordred props read placed here, at quest step 6 — the same set an
earlier check (this session, no run active at the time) found fully despawned
at the same step. Residency of this list is inconsistent; it is not a
dependable positive signal, only a bonus when it happens to hit. What is
dependable, and what this run confirms working end to end, is Tree's manager
staying absent — that is the one fact `ELIMINATION_BY_MAP` needs, and the only
one a future reader should trust for Avalon.
