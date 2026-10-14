# Dialect: architecture

How the code fits together. Product decisions are in [SPEC.md](SPEC.md); the reasoning behind the design is in the
spike report ([spike-desktop-app.md](spike-desktop-app.md)). This describes the repo as built so far: B1's scaffold.
Each card that adds code updates the part it changes.

## Packages

```
packages/
  core/             @dialect/core           shared model (+ MODEL_VERSION), coverage ledger, plugin interface, registry
  conformance/      @dialect/conformance    dev-only: Vitest conformance kit + negative tests for plugins
  platform-junos/   @dialect/platform-junos tree parser, display set tool, map/render
  cli/              @dialect/cli            Node CLI: display-set and convert, files and stdin/stdout
  ui/               @dialect/ui             React UI shared by both shells
apps/
  desktop/          @dialect/desktop        Tauri 2 shell: dialogs and file access, installer
  web/              @dialect/web            offline build: the ui as one self-contained HTML file
docs/  scripts/  tests/  branding/
```

Every package is a stub for now (`src/index.ts`). Packages are **source packages**: their `exports` point at
TypeScript, and whichever shell bundles them compiles them (Vite, from group C). Nothing is emitted by `tsc`, which
only checks.

Dependencies point one way:

```
platform-*  →  core  ←  conformance (dev-only)
     ↑           ↑
     └── cli, ui ←── apps/web, apps/desktop
```

- `core` and the `platform-*` plugins are **platform-neutral**: no Node, DOM or file system APIs. Their tsconfigs give
  them neither Node's nor the DOM's types, so using one fails the typecheck. Plugins take and return strings and plain
  objects.
- `cli` is the only package with Node's types; `ui` and the two apps have the DOM's.
- The shells own file access: the CLI through Node, the desktop app through Tauri's dialog and fs plugins, the web build
  through a file picker and downloads.

## TypeScript

`tsconfig.base.json` holds Hive's settings (strict, ES2023, `module: ESNext`, `moduleResolution: bundler`,
`isolatedModules`, `noEmit`). Each package's `tsconfig.json` extends it and sets its own `lib` and `types`; the root
`tsconfig.json` covers the repo-wide tests and the Vitest config, on Node. `npm run typecheck` runs the root one, then
each workspace's `typecheck` script.

## Checks

- **Lint:** oxlint with `--deny-warnings` (`.oxlintrc.json`: correctness errors, suspicious warnings).
- **Tests:** Vitest (`vitest.config.ts`), from `tests/` and each package's `tests/`.
- **CI:** `.github/workflows/ci.yml`, on Windows with Node 24 and npm 12: `npm ci`, typecheck, lint, tests and the
  license check.

## Licenses

`npm run licenses` (`scripts/licenses.mjs`) writes two generated files and checks the license rule:

- `scripts/thirdPartyNotices.mjs` takes an **inventory** of the checkout from `package-lock.json`. What ships is
  found by walking the `dependencies`, `optionalDependencies` and `peerDependencies` of each product's workspace
  (`PRODUCTS`: the desktop app, the web build and the CLI), through our own workspace packages, resolving each name in
  the lockfile as Node does (the package's own `node_modules` first, then each enclosing one). Everything else in the
  lockfile is build-only. Working from the lockfile rather than `node_modules` judges the platform-specific packages
  other machines install the same way everywhere: an optional runtime dependency only macOS installs is still shipped.
- `THIRD_PARTY_NOTICES.md` lists each shipped package with its link, version, license, the products it ships in and
  its full license text, then the hand-written entries in `scripts/notices`. The link and the texts come from the
  installed package: its `repository`, normalised to an `https://` browse URL (`repositoryUrl()`, using npm's
  hosted-git-info for GitHub, GitLab, Bitbucket and gists), else its `https://` homepage, else none; and its LICENSE or
  COPYING (and NOTICE) files. A shipped package that publishes no license file, or isn't installed on every platform,
  needs a reviewed **supplement** (`SUPPLEMENTS`, by `name@version`, with its text in `scripts/notices/texts`),
  which then gives its link and text on every machine; without one the check fails.
- `docs/BUILD_ONLY_PACKAGES.md` lists every build-only package with its version and license.
- `scripts/licensePolicy.mjs` judges each package's SPDX expression against its category's list (`SHIPPED_ALLOWED`
  or `OPEN_SOURCE`), with the recorded `EXCEPTIONS`.
- `scripts/licenseText.mjs` keeps the text steps pure: line endings, whether to rewrite a file, and what changed.

`--check` writes nothing and fails on a stale file or a broken rule; `tests/licenses.test.ts` checks the same.

## The Junos plugin (`packages/platform-junos`)

B3's parser and display set, ported from the spike prototype (B4 adds the mapping to and from the model).

- `tokenizer.ts`: words (quoted strings kept as written, escapes included), braces, brackets, `;` and
  `/* annotations */`; `#` comments to the end of the line. Each token has a 1-based line and column.
- `tree.ts`: `parseConfig()` builds a generic syntax tree from the curly-brace syntax alone, without the Junos schema.
  A `ConfigNode` is its words, then children (a container), a `[ ]` list (a leaf with values) or neither (a leaf), the
  `inactive:`/`protect:`/`replace:` tags and the annotation before it. A syntax error throws `JunosParseError` with
  its line and column; unknown `word:` tags, annotations with no statement after them and empty lists are warnings.
- `displaySet.ts`: `flatten()` turns the tree into `set` lines, each with the source line it comes from (for the UI's
  source and output highlighting). A statement's `deactivate` and `protect` lines come after the `set` lines of its
  subtree, Juniper's documented order. `displaySet()` wraps both: the lines and warnings, or the first error.
- Tests: the prototype's self-test cases and jcc's failure cases (`tests/displaySet.test.ts`), and jcc's 22 pairs,
  cleaned up by `tests/cleanFixtures.ts` into `tests/fixtures/display-set/` (`tests/displaySetFixtures.test.ts`). The
  tests have their own tsconfig with Node's types, so `src` stays platform-neutral.

## Branding

`branding/` holds the SVG icon masters, the rendered icons in `branding/out/` and the theme tokens
(`theme-tokens.css`). `npm run icons` (`scripts/build-icons.mjs`, with sharp and png-to-ico, build-only) renders the
icons; `npm run contrast` (`scripts/check-contrast.mjs`) checks the tokens against WCAG AA.
