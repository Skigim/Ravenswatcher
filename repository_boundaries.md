# Repository boundaries

Ravenswatcher is the public application repository. The private
`ravenswatch-live-readout` repository holds game dumps, datamining tools,
viewer experiments, and private reference exports. Its Git history is not
imported here.

The intended longer-term flow is:

```text
ravenswatch-live-readout ──> ravenswatch-wiki-data ──> Wiki
           │                         │
           └─────────────────────────┴─────────────> Ravenswatcher
```

`ravenswatch-wiki-data` will hold shared, versioned exports for the Wiki
and the app. The direct path carries app-specific findings and measured
reader layouts. These are upstream maintenance inputs, not dependencies
on a neighboring private checkout during build or runtime.

Today, `app/value_types.json` is a bundled snapshot of type metadata and
`app/reader/struct_offsets.json` is the reader layout registry. They make
this repository independently buildable. A future shared export can replace
or update that snapshot through an explicit versioned import. No shared
data repository or publishing pipeline is created by this split.

Decoded art, full game-description tables, and process dumps are excluded.
Runtime icons and descriptions are decoded from the player's own install.
The source tree includes resource identifiers, measured layouts, synthetic
test fixtures, and the separately licensed Archivo font.

Releases belong here. `.github/workflows/release.yml` is manually dispatched
against a pushed version tag and uses this repository's `GITHUB_TOKEN`.
The private repository no longer builds or publishes the application.
