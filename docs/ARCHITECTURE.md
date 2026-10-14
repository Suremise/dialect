# Dialect: architecture

How the code fits together. Product decisions are in [SPEC.md](SPEC.md); the reasoning behind the design is in the
spike report ([spike-desktop-app.md](spike-desktop-app.md)). This describes the repo as built so far: B1's scaffold and B2's core contracts.
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

`core` and `conformance` hold B2's contracts (below); the other packages are stubs for now. Packages are **source packages**: their `exports` point at
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
- `cli` and the dev-only `conformance` kit have Node's types; `ui` and the two apps have the DOM's. Core's own tests run
  on Node with a config of their own (`packages/core/tsconfig.test.json`).
- The shells own file access: the CLI through Node, the desktop app through Tauri's dialog and fs plugins, the web build
  through a file picker and downloads.

## Core contracts (`@dialect/core`, model 0.1.0)

Frozen as v0 by B2: a change to these is a change to every plugin and shell, and goes through the model's versioning.

### The shared model (`model.ts`)

`Device` is OpenConfig-shaped, as plain readonly types:
- `system`: hostname, domain name, `ntp` (servers), `logging` (remote syslog servers) and `snmp` (location, contact,
  communities);
- `interfaces`: type, description, enabled, MTU, VLAN tagging, and `subinterfaces` with a VLAN id and `ipv4`/`ipv6`
  addresses;
- `networkInstances`: `default` for the global table (VRFs later), each with `staticRoutes` and their next hops.

These are the phase 1 areas; later minor versions add VLANs, OSPF, BGP, policy and filters.

Three conventions keep the model walkable by the ledger:
- **collections are maps keyed by their natural key** (interface name, address, prefix), never arrays of objects, so
  every leaf has a stable path;
- **leaves are primitives or arrays of primitives** (leaf-lists); a presence-only setting is `true`. An entry configured
  with no options is an empty object (an NTP server `servers["192.0.2.1"]: {}`), and the ledger counts it as a leaf,
  valued `{}`, so a renderer that drops it is caught like one that drops any other leaf;
- **absent means not configured**: no nulls, no defaults the source didn't say.

`MODEL_VERSION` is the model's own semver, separate from the package's. Minor versions only add; major versions
break. That holds in 0.x too, so a plugin built for 0.1 declares `modelApi: '>=0.1.0 <1.0.0'`, not `^0.1.0`.

### Field paths (`paths.ts`)

A leaf's path names it in dispositions and reports:
`interfaces["ge-0/0/0"].subinterfaces["0"].ipv4.addresses["192.0.2.1"].prefixLength`. Identifier keys are written
with a dot, other keys quoted in brackets, array indexes as `[0]`. Plugins build paths with `fieldPath(...segments)`,
so they always match what the core computes; `populatedLeaves(model)` lists every populated leaf.

### The plugin interface (`plugin.ts`, `results.ts`)

A platform package's default export is a `PlatformPlugin`:

| Member | What |
|---|---|
| `id`, `name` | `junos`, "Junos" |
| `modelApi` | the model versions it supports, a semver range |
| `capabilities` | per feature area, how far it parses and renders it (`full`, `partial`, `none`) |
| `detect?(text)` | 0..1, for auto-detect |
| `parse?(text, context)` | → `ParseResult`: the syntax tree, the model, a `StatementDisposition` per statement id, diagnostics, needs-input items |
| `render?(model, context)` | → `RenderResult`: the text, a `FieldDisposition` per populated field path, diagnostics, needs-input items |
| `tools?()` | platform-only `Tool`s that don't go through the model, such as Junos display set: `run(input) → { text, diagnostics }` |

`parse`, `render`, `detect` and `tools` are optional, so a plugin can ship its tools before its mapping (B3 before
B4). Plugins take and return strings and plain objects only.

- A **syntax node** has an `id` unique in its tree, a `label` (its full path as the platform writes it), an optional
  display-only `span` (lines and columns from 1, end column exclusive) and its `children`.
- **Statement dispositions:** `mapped` (with the field paths it filled; none for a container that only groups),
  `ignored-by-design` (with a reason) or `unsupported`.
- **Field dispositions:** `rendered` (with its output span), `unsupported`, or `not-applicable` (with a reason).
- **Diagnostics** have a severity, and optionally a category (`syntax`, `semantic`), a code, a span, a statement and a
  field. Semantic warnings are diagnostics with `category: 'semantic'`.
- **Needs-input items** are what the user must supply (an interface's name on the target, a secret that won't carry
  over), answered through `context.inputs` by id.

### The coverage ledger (`ledger.ts`)

The core checks completeness itself; it doesn't trust the plugin's count:
- `checkStatements(tree, dispositions)`: every node needs a disposition, children included. A container's disposition
  never covers its children. It also reports dispositions for ids not in the tree, and ids the tree has twice.
- `checkFields(model, dispositions)`: every populated leaf needs a disposition. An object's disposition covers none of
  its leaves (it is reported as stray), so a field from a later minor version that an older renderer never heard of
  shows as unrendered.
- `buildLedger(parse, render?)` puts both together with both sides' diagnostics and needs-input items. `complete` is
  true only when nothing is unmapped or unrendered; `ledgerProblems()` says what isn't, a line each.

Spans are for display only: the ledger never uses them, because one line can hold several statements.

### The registry (`registry.ts`)

`createRegistry(plugins)` checks each plugin's `modelApi` against `MODEL_VERSION` (semver's `satisfies`) and throws
`PluginRejectedError` naming both versions: `Plugin "junos" supports model versions >=1.2.0 <2.0.0, but this core's
model is 0.1.0.` It also rejects an invalid range, a duplicate plugin id and two tools with one id. It lists the
plugins, the sources (those that parse), the targets (those that render), every tool, and the plugins that detect a
text, best first.

### JSON (`serialize.ts`)

`serializeModel(device)` writes `{ "modelVersion": "0.1.0", "device": { … } }`. `deserializeModel()` reads a document
of the same major version and the same or an older minor, and refuses a newer one rather than drop its fields.

### Platform neutrality

`packages/core` gets neither Node's nor the DOM's types (its tsconfig), so `process`, `Buffer` or `window` fail the
typecheck. `packages/core/tests/platformNeutral.test.ts` fails on an import of a Node built-in or of any package not on
its allowlist (only `semver` today).

## Conformance kit (`@dialect/conformance`, dev-only)

A plugin's fixtures live in its `tests/fixtures/<area>/`: `<case>.<ext>` (the source), `<case>.model.json` (the
expected model, with `modelVersion`) and optionally `<case>.rendered.<ext>` (the expected render). A source without its
model file, or the reverse, is an error. A plugin's test file runs the kit with one line:

```ts
describeConformance(plugin, new URL('./fixtures', import.meta.url))
```

Each fixture goes through four checks (`checkFixture()`):
1. parse → no error, and the expected model;
2. render → no error, and the expected text (skipped when there is none and the render reported no error);
3. render → reparse → no error, and the same model;
4. the coverage ledger is complete for the parse and the render.

An error a step reports (a diagnostic with `severity: 'error'`) fails its check even when its output matches;
warnings and info don't.

The kit's own tests (`packages/conformance/tests`) use a test-only stub platform, a tiny brace language, to show the
checks catch careless plugins:
- a mapper that handles only `host-name` in `system { host-name r1; services { ssh; } }`: `system services ssh` is
  unmapped although line 1 is "covered";
- a renderer that handles only a BGP neighbor's address and remote AS: `…neighbors["10.0.0.2"].multihop.ttl` is
  unrendered although the neighbor was, also when `multihop` is a field of a later minor model version.

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
  Messages never quote the config's words, values or annotations (they reach stderr, logs and the UI, and a value can
  be a secret): only punctuation and tag names, with positions to say where.
- `displaySet.ts`: `flatten()` turns the tree into `set` lines, each with the source line it comes from (for the UI's
  source and output highlighting). A statement's `deactivate` and `protect` lines come after the `set` lines of its
  subtree, Juniper's documented order. `displaySet()` wraps both: the lines and warnings, or the first error.
- Tests: the prototype's self-test cases and jcc's failure cases (`tests/displaySet.test.ts`), and jcc's 22 pairs,
  cleaned up by `tests/cleanFixtures.ts` into `tests/fixtures/display-set/` (`tests/displaySetFixtures.test.ts`). The
  tests have their own tsconfig with Node's types, so `src` stays platform-neutral.

## The command line (`packages/cli`)

- `src/cli.ts`: `run(argv, io, version)` parses the arguments, reads the input through `io`, runs the Junos plugin's
  `displaySet()` and returns the exit code (0 done, 1 a syntax error, 2 a usage error or unreadable input). It never
  touches `process`, so it can be called directly.
- `src/bin.ts`: the entry. It wires `run()` to Node's file system, stdin, stdout and stderr, sets `process.exitCode`,
  and ignores a closed stdout pipe.
- `vite.config.ts`: `npm run build -w @dialect/cli` bundles `bin.ts` and the workspace packages it imports into one ES
  module, `dist/dialect.mjs`, for Node 24, with a `#!/usr/bin/env node` line. Only Node's own modules stay imports.
  Vite is build-only.
- `tests/cli.test.ts` builds into a temp folder with Vite's API and runs the built file with Node: the 22 display set
  fixtures, stdin, invalid input, warnings, unreadable files and usage errors.

## The UI (`packages/ui`)

The React UI both shells share: `<App platform={…} />`, where `Platform` (`src/platform.ts`) is the shell's file and
clipboard access (open, open a dropped file, save, read and write the clipboard). The UI never touches files itself:
even a dropped file is read by the shell, from the drop event's data.

- `src/store.ts`: one zustand store, with the source text and its name, the display set result, the problems (the
  syntax error or the warnings), the theme choice, and requests to reveal a place in an editor. Display set runs
  synchronously on every change (config_22, 316 KB, parses in tens of milliseconds).
- `src/App.tsx`: the title bar and its actions (Open, Paste, Copy output, Save output, the theme), the source and output
  panes, the problems panel and the status bar. A file dropped anywhere opens, even on an editor: the drop is handled
  in the capture phase, so CodeMirror doesn't insert it, and `platform.openDropped()` reads it. Moving the cursor in one pane marks the matching lines in the other, through
  each set line's `sourceLine`.
- `src/editor/`: the CodeMirror 6 editor component, and Junos colouring as a stream language (colouring only: the
  parser does the real work).
- `src/styles/app.css`: Hive's surface and text colours, and the violet accent from `branding/theme-tokens.css`.
  `[data-theme]` on `<html>` picks light or dark; the app follows the system unless the user picks one (kept in
  `localStorage` when the browser allows it).

### Editor: CodeMirror 6, not Monaco

The spike planned Monaco, with CodeMirror 6 as the fallback if Monaco didn't work in the single-file build. Both were
built single-file with vite-plugin-singlefile and opened from `file://` in Edge under the web build's CSP (2026-10-14,
Monaco 0.57.0 and CodeMirror 6.43, in a scratch probe):

| | Monaco (editor core only, its worker inlined) | CodeMirror 6 |
|---|---|---|
| Single-file size, editor alone | 3.1 MB | 274 KB |
| Under a hash-only CSP | **Breaks**: it injects `<style>` elements and starts its worker from a `blob:` URL, so it needs `style-src 'unsafe-inline'` and `worker-src blob:` | **Works**, mounted in a shadow root |
| Workers | One, inlined | None |

So the editors are **CodeMirror 6**. Its style-mod injects styles at runtime too: into a `<style>` element in a
document, but into a constructed stylesheet (`adoptedStyleSheets`) in a shadow root, which CSP doesn't govern. Each
editor is therefore mounted in its own shadow root (`Editor.tsx`), and the CSP stays hash-only. The theme's custom
properties inherit into the shadow roots, so the editors follow light and dark without being reconfigured. A diff view,
when one is needed, is `@codemirror/merge`.

## The web build (`apps/web`)

`npm run build -w @dialect/web` writes one file, `apps/web/dist/dialect.html` (about 570 KB), that runs from `file://`
with no server and no network.

- `src/main.tsx` renders the UI with `src/webPlatform.ts`: a file picker, downloads (a `blob:` link), and the clipboard
  API with the copy command as its fallback.
- `vite.config.ts`: the React plugin, then vite-plugin-singlefile, which inlines the script and the styles, then
  `dialect-csp`, which fills in the page's Content Security Policy from their SHA-256 hashes: `default-src 'none'`,
  `script-src` and `style-src` only those hashes, `img-src data:` (the icon), and `base-uri`, `form-action` and
  `object-src` `'none'`. No `unsafe-inline`, no `blob:` or remote sources, no `connect-src`. The build fails if the page
  still loads a file. It renames the page to `dialect.html` and adds the icon as a `data:` URL.
- `tests/web.test.ts` builds into a temp folder, then drives Microsoft Edge with playwright-core (Edge comes with
  Windows and GitHub's Windows runners, so no browser is downloaded). The page is opened from `file://` in an offline
  context that aborts and records every request but the page's own. It checks the CSP, opening fixtures with the
  picker and saving their display set, the output pane, drag and drop, a syntax error and warnings in the problems
  panel, paste and copy, the themes and the linked lines. Every test also fails on a console error or warning, a page
  error, a CSP violation or a blocked request. `DIALECT_SCREENSHOTS=<folder>` also writes light and dark screenshots.

## Branding

`branding/` holds the SVG icon masters, the rendered icons in `branding/out/` and the theme tokens
(`theme-tokens.css`). `npm run icons` (`scripts/build-icons.mjs`, with sharp and png-to-ico, build-only) renders the
icons; `npm run contrast` (`scripts/check-contrast.mjs`) checks the tokens against WCAG AA.
