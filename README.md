# Ravenswatcher

A second-screen window for [Ravenswatch](https://store.steampowered.com/app/2071280/Ravenswatch/) that shows what the current run has put on the map, what the Sandman is selling, and which melodies are in play. It reads the running game and updates as you play. It changes nothing in the game.

Runs on Windows and Linux. Linux users, see [Linux](#linux).

## Install

These are the Windows instructions.

1. Download the latest `Ravenswatcher-<version>-win-x64.zip` from the [Releases page](https://github.com/Skigim/Ravenswatcher/releases/latest).
2. Extract the folder anywhere. There is no installer.
3. Run `Ravenswatcher.exe`.

The first time, Windows SmartScreen shows **Windows protected your PC**, because the app isn't signed with a paid certificate. Click **More info**, then **Run anyway**.

To uninstall, delete the folder. The app stores its settings in your Windows user profile and nothing else.

## Use

Start the game, then start the readout, or the other way round. The window says **Not running** until it finds the game and **Live** once it has. Panels fill in as a run loads: the questline and melodies first, the map a moment after the level loads, the Sandman's offers after you open his shop once.

Hover anything for details: an item's effect, a melody's effect and note count, what a map icon is, and the expected boss at an optional boss shrine or den.

To keep track of what you've cleared, click a map icon: each click takes one off its count, and the last one marks it done with a check. Right-click to undo a click. The marks reset when the map changes.

The gear opens settings: rules between the panels, a diagnostics footer, and how many map icons sit across a row.

## Linux

1. Download the latest `Ravenswatcher-<version>-linux-x64.tar.gz` from the [Releases page](https://github.com/Skigim/Ravenswatcher/releases/latest).
2. Extract it anywhere.
3. Run the `ravenswatcher` executable inside the extracted folder.

Settings and history are stored in your user config folder, `~/.config/Ravenswatcher`. To uninstall, delete the extracted folder. Delete the config folder too if you want your data gone.

It was tested on Debian 13 with Steam installed as a Flatpak, on X11. Attach, the live readout, and History all worked. Native (non-Flatpak) Steam, Wayland, and Steam Deck have not been tested.

As on Windows, the app reads the icons and item text from your installed copy of the game. The tarball does not include game art.

### The app can't attach to the game

The app reads the game's memory, and Linux's Yama `ptrace_scope` setting controls that. Ubuntu's default (1) refuses the attach, because the game isn't a child of Ravenswatcher. Run:

```
sudo sysctl kernel.yama.ptrace_scope=0
```

This lasts until you reboot, and it loosens a security restriction for the whole system. The alternative is to start Ravenswatcher as the game's parent process.

### The app won't start on Ubuntu 24.04

Ubuntu 24.04 restricts unprivileged user namespaces, which Electron's sandbox uses, so the app may fail to start. The known workaround is:

```
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

## Co-op

The readout shows things the other players can't see. In a co-op run it asks you to agree, once per launch, to use it only for yourself and to turn it off if your group doesn't want it. Declining hides the panels for that run.

## Antivirus

The app reads the game's memory to do its job, which some antivirus products treat as suspicious. Its only network request is one check at launch for a newer release on GitHub. It writes only its own settings and a cache of icons and item text that it builds from your game install.

## Support

If the tool is useful to you, there's a **Support on Ko-fi** button in the settings panel.

Problems and requests go in [Issues](https://github.com/Skigim/Ravenswatcher/issues).

## Build from source

On Windows, install Node.js 22.15 or newer (including Node 24/26) and Git:

```powershell
git clone https://github.com/Skigim/Ravenswatcher.git
cd Ravenswatcher/app
npm ci
npm test
npm start
```

`npm run dist` builds the portable zip in `build/release/` at the repository
root. The build and tests need no game dump, Python, or private repository.
The app needs your own installed copy of Ravenswatch to display live data.
It decodes icons and item descriptions from that install at runtime.

The source is in `app/`: `reader/` reads game memory, `assets/` decodes local
resources, and `web/` renders the readout. See the
[development guide](docs/development.md),
[architecture reference](docs/architecture.md), and
[contributing guide](CONTRIBUTING.md).

## License

Original project code is available under the [MIT License](LICENSE).
The bundled Archivo font retains its SIL Open Font License; see
[third-party notices](app/THIRD_PARTY_NOTICES.md). Ravenswatch game art and
full item-description tables are not included in this source repository.
Ravenswatch and its game content belong to their respective owners.
