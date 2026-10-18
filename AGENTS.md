# Ravenswatcher

This is the standalone public application repository. Work on the current
release/<version> branch when one is open, otherwise main. Do not create task
branches or worktrees. Releases are manual: see .github/workflows/release.yml.

The application lives in app/. Read app/reader/README.md before reader work.
Edit TypeScript sources, never their generated JavaScript siblings. Run
`npm ci`, `npm run typecheck`, and `npm test` from app/.

Never add decoded game images, full game text tables, memory dumps, private
datamining source, or credentials. Runtime resources come from the player's
own install. The app opens game memory read-only. Preserve null versus zero.

Tests use synthetic memory and resource fixtures. Optional local-install
checks require an explicit RAVENSWATCH_INSTALL. Do not run live probes or
decode new game data unless asked in the current user message.
