## Round 1

- Step 1: created the `app` branch, copied the web app and `rocket-physics/` into the repo, added `space-flight-godot` and `.claude` to `.gitignore`, and copied the design docs.
- Step 1 check: `npm test` passed 211 tests in 20 files, `npm run build` passed, and `rocket-physics` `npm test` passed 200 tests with 0 failures.
- Step 1 note: added `vitest.config.ts` scoping app tests to `src/` so the sibling worktrees and the `rocket-physics` Node tests are not collected.
