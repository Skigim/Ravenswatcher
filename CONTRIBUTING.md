# Contributing

Build, packaging, and test instructions live in [docs/development.md](docs/development.md).
The application architecture and measured reader constraints live in
[docs/architecture.md](docs/architecture.md). Keep maintained technical documentation
in `docs/` and local release plans in the gitignored `plans/` directory.

The default test suite runs without the game, Python, or private data. It
uses synthetic memory and resource fixtures. If a change is only observable against a live
process, say so in the pull request.

Offsets and addresses in the reader were measured, not guessed. Trace any new
number to the measurement that produced it.

## Fork and branch

Contribute through a fork of [Skigim/Ravenswatcher](https://github.com/Skigim/Ravenswatcher)
and a pull request to the current release branch, **`release/0.1.7`**. Base your
work on that branch and select it explicitly as the PR target. When the next
release starts, update the branch named here to the new active release branch.

1. Fork the repository on GitHub into your own account.
2. Clone your fork and add the original repository as `upstream`. Replace
   `YOUR-USERNAME` with your GitHub username:

   ```powershell
   git clone https://github.com/YOUR-USERNAME/Ravenswatcher.git
   cd Ravenswatcher
   git remote add upstream https://github.com/Skigim/Ravenswatcher.git
   git fetch upstream
   git switch --create my-change --no-track upstream/release/0.1.7
   ```

   Choose a descriptive branch name in place of `my-change`. Keep each branch
   focused on one fix or feature.

3. Make your changes, following the conventions below. From `app/`, run
   `npm ci`, `npm run typecheck`, and `npm test` before submitting.
4. From the repository root, stage the intended files, commit, and push your
   branch to your fork:

   ```powershell
   git add <changed-files>
   git commit -m "Describe the change"
   git push --set-upstream origin my-change
   ```

   Replace `<changed-files>` with the paths you intend to submit. Do not include
   generated JavaScript, local plans, or extracted game content.

## Open and update a pull request

On GitHub, open a pull request with these settings:

- **Base repository:** `Skigim/Ravenswatcher`
- **Base branch:** `release/0.1.7`
- **Head repository:** your fork
- **Compare branch:** your change branch

Describe the problem, what changes for the user, and how you verified the fix.
Link the relevant issue, include screenshots for visible UI changes, and state
any platform or live-game behavior you could not validate. Use a draft PR if
the work is still in progress.

If the release branch advances, update your change branch before final review.
With your changes committed and your change branch checked out, run:

```powershell
git fetch upstream
git merge upstream/release/0.1.7
git push
```

Resolve any conflicts, rerun the relevant checks, and push the resulting commits.
Address review feedback on the same branch; further pushes update the existing PR.

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
