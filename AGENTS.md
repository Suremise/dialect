# Dialect: notes for agents

Dialect translates network device configs between vendor "dialects" (Junos display set, Junos ⇄ Cisco), as a Tauri 2
desktop app, an offline single-file web build and a CLI, from one TypeScript core. These notes are for every agent
working on this repository, whichever CLI runs it: Codex reads this file, and Claude Code reads it through `CLAUDE.md`.
The local project and folder are called `juniper`; the product is Dialect.

- Product decisions: [docs/SPEC.md](docs/SPEC.md), the source of truth. Update it when a decision changes.
- How the code fits together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- User-facing docs (bundled into the app's Docs view later): [docs/USER_GUIDE.md](docs/USER_GUIDE.md),
  [CHANGELOG.md](CHANGELOG.md)
- The research and the build plan (cards B1…): [docs/spike-desktop-app.md](docs/spike-desktop-app.md)

## Project conventions

Adapted from Hive's (`D:\Development\HIVE\hive`), the quality bar for this repo: borrow its ideas, conventions and code
freely, but **read it only and never change anything there**.

- **Commit once a card passes review**, on your own branch, without waiting to be asked. **Never push**, add a remote,
  tag or release unless the user asks. Commits use the GitHub no-reply address in the repo's git config
  (`git config user.email`), never a personal email: never set or pass another email (`git config`, `-c user.email`,
  `--author`, `GIT_AUTHOR_EMAIL`).
- **Merging into main:** run `git -C D:/Development/Workspaces/Scratch/juniper merge --no-ff <branch>` as a command of
  its own, the path written out in full (not `$M` or `cd … &&`), so the allow rule in each developer's user-level Claude
  settings matches it. `.claude/` is machine-local and not in git.
- **Keep to your card's files.** Cards that run in parallel own different packages; a change another lane's package
  needs goes through the Hive Assistant, not into your card. Work you find that isn't your card's goes on a new card.
- **Never run Prettier** (`prettier --write` or as a check): the repo has no Prettier config. Match the surrounding
  formatting by hand (long lines, single quotes, no semicolons) and check with `npm run typecheck` and `npm run lint`.
- **Line endings:** `.gitattributes` checks text out as LF (`.bat`, `.cmd` and `.ps1` as CRLF). Write a file with one
  ending throughout; `tests/lineEndings.test.ts` fails on a mixed file or a lone CR.
- User-visible behaviour changes go into SPEC.md and the user guide in the same change, and an entry under
  **Unreleased** at the top of `CHANGELOG.md`. `CHANGELOG.md` merges with `merge=union`, so two branches' new entries
  both stay: after merging main, look for an entry that appears twice in two wordings. Use union for nothing else.
- **No product code outside its package:** platform-neutral code goes in `packages/core` or a `packages/platform-*`
  plugin, which use no Node or DOM APIs (their tsconfigs give them neither's types). File access lives in the shells.
- Personal, machine-specific notes belong in `CLAUDE.local.md` (git-ignored), not here. `CLAUDE.md` only imports this
  file.

## No secrets in diagnostics

No diagnostic, warning, error, log line or ledger reason may contain a secret value from the config: passwords and
their hashes (`$1$`, `$5$`, `$6$`, `$9$`, Cisco types 5, 7, 8 and 9), SNMP communities, keys (pre-shared,
TACACS+/RADIUS, NTP authentication) and certificates' private parts. They go to stderr, logs and screenshots. Say what
is wrong and where instead: the statement's path and position, e.g. "snmp community (line 12)", never the line's text
or a word from it. A tool's report (any output that isn't config) is a message too. Only converted config keeps its
values: a render, and the text of a tool whose output is config (display set).

Core has a safety net (docs/ARCHITECTURE.md, The secret safety net): `createRegistry()` and `convert()` guard every
plugin, withholding a reason or message that holds a secret of the source (`findSecrets()`, core's shared finder). It
is a net, not the fix: plugins keep their own care. Every plugin's conformance run checks it, unguarded
(docs/ARCHITECTURE.md, Conformance kit). A plugin with a tool that outputs config names it in `configTools`; every
other tool's text is checked like a diagnostic. Give a fixture with secrets a `<case>.secrets.json` when the kit's
patterns would miss them. A secret stays one wherever else its value appears. A leak is fixed, not allowed: the only
allowances are the temporary ones in `packages/conformance/src/allowances.ts`, each naming the card that removes it.

## Commands

```bash
npx npm@12.2.0 install # after cloning (or ci): npm 12, which the repo pins
npm run typecheck      # tsc for the repo-wide tests and every workspace package
npm run lint           # oxlint (.oxlintrc.json), fails on warnings
npx npm@12.2.0 test    # Vitest: tests/ and each package's tests/
npm run licenses       # regenerate THIRD_PARTY_NOTICES.md and docs/BUILD_ONLY_PACKAGES.md (-- --check: only check)
npm run icons          # regenerate branding/out/ from the SVG masters
npm run contrast       # check the theme tokens against WCAG AA
npm run fixtures       # check fixtures/ against its manifest and print the coverage table (npm test runs it too)
npm run set-version -- 0.2.0  # set Dialect's version everywhere it's written (no argument: list them)
npm run screenshots    # remake the README's light and dark screenshots (docs/screenshots)
npm run release        # build every asset and upload a DRAFT GitHub release (RELEASING.md; -- --dry-run: no upload)
npm run build -w @dialect/desktop       # the desktop app and its NSIS installer (needs Rust); never run the installer
npm run test:smoke -w @dialect/desktop  # the desktop smoke test: builds the app (target/e2e), needs msedgedriver
```

Rust (stable, through rustup) and the Visual Studio C++ build tools are needed for the desktop app, and cargo for
`npm run licenses` and its test, which list the desktop app's crates (docs/ARCHITECTURE.md, Licenses).

CI (`.github/workflows/ci.yml`, Windows, Node 24 with npm 12) runs typecheck, lint, the tests and the license check on
every push to main and every pull request. A second job, `desktop`, runs `cargo deny --locked check`, builds the
installer (kept as the run's `dialect-installer` artifact, never released) and runs the desktop smoke test, with the
msedgedriver of the runner's WebView2. The repo is public at https://github.com/Suremise/dialect; CI runs there.

**Only on GitHub's runners** (fixed, keep them so): the runners run jobs elevated, and WebView2 in an elevated process
ignores a debugging port passed through `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` ("DevToolsActivePort file doesn't
exist"), so the smoke test builds the app with its own port and attaches msedgedriver to it, not through tauri-driver
(docs/ARCHITECTURE.md, The desktop app). The app also runs without its tray icon where Windows has no notification
area.

**npm 12 through npx:** the global npm stays 11, because Hive on the same PC uses it, so run install, ci and test as
`npx npm@12.2.0 …`. Under npm 11, `npm test` skips the npm 12 install-script checks (`tests/installScripts.test.ts`)
with a warning; with `CI` set they run anyway and fail, as CI must use npm 12.

## Licenses and dependencies

The project is MIT. The license rule (docs/SPEC.md §3) has two categories, checked by `scripts/licensePolicy.mjs`:

- **Shipped** (bundled into a product, or copied into the repo): MIT or equally permissive; MPL-2.0 only unmodified.
- **Build-only** (never ships): any open-source license, GPL and LGPL included, listed in
  `docs/BUILD_ONLY_PACKAGES.md`.

What ships is worked out from the products' dependencies (`PRODUCTS` in `scripts/thirdPartyNotices.mjs`: the desktop
app, the web build and the CLI): everything reached through `dependencies` of their package.json and of the workspace
packages they depend on. So **a library that is bundled into a product goes in `dependencies`** of the package that
imports it, never `devDependencies`, or it would be missing from the notices; tools go in `devDependencies`. After
changing dependencies, run `npm run licenses` and commit both generated files: a unit test (and CI) fails when they are
stale or a package breaks the rule. Only the user can allow an exception (`EXCEPTIONS` in `scripts/licensePolicy.mjs`).
A shipped package that publishes no LICENSE file, or is only installed on another platform, needs a reviewed
supplement with its full license text (`SUPPLEMENTS` in `scripts/thirdPartyNotices.mjs`). Material that isn't a package
(copied code, test data) gets a hand-written entry in `scripts/notices`; its README says how to add either.

**Install scripts:** npm 12 runs no dependency's install script unless `allowScripts` in package.json approves it
(`npm install-scripts approve <pkg>`); `tests/installScripts.test.ts` checks the default deny holds. Approve a script
only when the package doesn't work without it, and say why on the card.

## Tests

- **Tests wait for conditions, never for time**: poll what you expect to see (`vi.waitFor`, `expect.poll`, each with a
  named bound) rather than sleep and then check, or read state once right after an action. A timeout bounds a hung run
  and is never the fix. Each test cleans up its own state and passes under load, not only alone.
- The web build's tests (`apps/web/tests`) drive **Microsoft Edge** through playwright-core. Edge comes with Windows,
  so no browser is downloaded. They build the page first, as the CLI's tests build the CLI.
- Temp folders come from `tempDir()` (`tests/tempDir.ts`), by their long, real paths, never under `os.tmpdir()`
  directly (CI's temp folder is an 8.3 short path; `tests/tempDir.test.ts` fails on it).
- git and npm started by tests get `childEnv()` (`tests/childEnv.ts`), so a shell's `GIT_*` or `npm_*` variables can't
  steer them.
- Fixtures live under each package's `tests/fixtures`, and configs in them are cleaned up first (docs/SPEC.md §5).
- Probes, logs and scratch files go in your scratchpad or a temp folder, never in the repo or beside a worktree.

## Code map

| Path | What |
|---|---|
| `packages/core` | The shared model, the coverage ledger, the plugin interface and the registry (B2) |
| `packages/conformance` | The conformance kit plugins' fixtures run through (B2) |
| `packages/platform-junos` | The Junos plugin: tree parser and display set (B3), mapping and rendering |
| `packages/platform-iosxe`, `platform-nxos`, `platform-iosxr` | The Cisco plugins: IOS / IOS-XE (B8), NX-OS (B12) and IOS-XR (B13), each a tree parser, mapping, rendering and detect |
| `packages/cli`, `packages/ui`, `apps/web`, `apps/desktop` | The CLI, the shared UI and the two shells (group C) |
| `scripts/licenses.mjs`, `thirdPartyNotices.mjs`, `licensePolicy.mjs`, `licenseText.mjs`, `notices/` | The generated notices, the build-only list and the license check |
| `scripts/build-icons.mjs`, `check-contrast.mjs`, `branding/` | The icon pipeline and the theme tokens |
| `RELEASING.md`, `scripts/release.mjs`, `release-notes.md`, `version.mjs`, `screenshots.mjs` | Releases: the draft GitHub release, its notes, the version everywhere, the README's screenshots |
| `tests/` | Repo-wide tests: licenses, install scripts, line endings, temp folders |
