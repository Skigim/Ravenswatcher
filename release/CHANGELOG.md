# Changelog

## 0.1.6 — 2026-10-17

* Ravenswatcher is now fully open source under the MIT license. The complete app source has moved into the [Ravenswatcher repository](https://github.com/Skigim/Ravenswatcher) alongside its releases.
* Share Run copies a complete build image to the clipboard, including hero, score, melodies, talents, object stacks and damage.
* The final stage is displayed as Epilogue across Live, History and shared images.
* Stylized headings compose Kintarō’s macron using Germania One’s own glyphs.
* Individual run deletion is available through History selection.

* History shows earned/required notes for active melodies and marks completed melodies as Completed.
* Talent hovers include their icon, rarity and recorded game-formatted effect, preserving percentages and damage values.
* Melodies update again when you start or complete one, after the game update.
* Finished runs are saved in History with their result, hero, difficulty, score, talents and end-of-run statistics.
* Run cards show hero portraits, difficulty icons and ten talent slots, with details on hover.
* Expanded runs have tabs for Hero Details, Score Details, Melodies and Magical Objects, Damage Dealt, Support, Sufferings and Resources.
* Magical objects show their icons, rarity and stack counts; recorded melodies keep their portraits and final progress state.
* Hero attributes use game icons with hover labels, and damage is broken down by ability with percentage bars.
* The app opens on History and switches to Live when a run starts.
* Settings can switch between stylized Germania One and Alegreya Sans fonts or the standard font, with the choice saved between launches.
* Score details use activity icons, including Wishing Well and Stingy Jack, with each saved score line available on hover.
* Combat and Cursed rooms have distinct icons in the map panel; Gold and Mirror rooms retain their harp and mirror icons.
* Connection status is a small dot with details on hover.
* Delete individual runs, selected runs, or the entire history, with two confirmations for one run and three for bulk or delete-all.
* Scrollbars now match the app's dark theme.

## 0.1.5 — 2026-10-12

* Restored run detection and map POI loading after the game update.
* Fixed missing optional boss den entrances in the map readout.
* Hovering an optional boss icon now shows the expected boss across all three chapters.

## 0.1.4 — 2026-09-22

* Icons and Item descriptions are now read from your game at runtime instead of redistributing the games own png files. (Follows the approach used by [RSMM](https://github.com/Ovilli/RavenswatchModManager))
* The app tells you when a newer release is out, with a download link. You can skip a release or be reminded next time; the settings panel always shows your version and the download.

## 0.1.3 — 2026-09-19

* Corrected descriptions and images for several shop items.
* Added the ability to manually decrement POI count via left click, and undo via right click.

## 0.1.2 — 2026-09-18

* Questline tile shows the questline name only; the step line under it is gone. On Dark Hills the name is the house you picked (Straw, Wood or Stone House) once it's known.

## 0.1.1 — 2026-09-17

* fixed initial sweep to be more durable against reward selectors that load late on first run.
* Linux: runs under Proton inside the game's own Steam session. See the Linux section of the README.

## 0.1.0 — 2026-09-16

* First release.
