# Contributing

The default test suite runs without the game, Python, or private data. It
uses synthetic memory and resource fixtures. If a change is only observable against a live
process, say so in the pull request.

Offsets and addresses in the reader were measured, not guessed. Trace any new
number to the measurement that produced it.

## Code conventions

- CommonJS, `'use strict'`, two-space indent.
- The tree is a file-by-file TypeScript port in progress. A converted file is a
  tracked `.ts` with a gitignored compiled `.js` beside it; an unconverted file
  is a plain tracked `.js`. Check which one you're in.
- Compilation is in place, with no output directory. Never edit or commit a
  generated `.js`. After you touch a `.ts`, run `npm run build`, or `npm test`,
  which builds first.
- In TypeScript files, don't use `any`, and don't use a non-null assertion
  (`!`) to silence a null error.
- `reader/` uses single quotes. `web/` uses double quotes. Match the file you're
  in.
- Comments explain why, not what. File headers record what was measured and
  what was ruled out; keep that voice.
- Never test a value read from the game for truthiness. Map id 0 is a real map,
  and level 0 is a real level. Compare against `null` explicitly.
- Don't add a dependency without discussing it in an issue first.

## Tests

- Do not change expectations to conceal a regression. Keep tests independent
  of private dumps and full game-description tables.
- Never weaken a test to fit the code. Loosening an assertion or deleting a case
  are both ways of doing that.

Run `npm ci`, `npm run typecheck`, and `npm test` from `app/` on Windows.
Optional local-install checks require an explicit `RAVENSWATCH_INSTALL`;
do not run live probes or decode resources as part of a normal source edit.
Game art and full description tables stay out of Git. Resource identifiers
and small synthetic test payloads are sufficient for unit tests.
