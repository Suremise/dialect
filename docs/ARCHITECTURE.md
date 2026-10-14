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

## Core contracts (`@dialect/core`, model 0.2.0)

Frozen as v0 by B2: a change to these is a change to every plugin and shell, and goes through the model's versioning.

### The shared model (`model.ts`)

`Device` is OpenConfig-shaped, as plain readonly types:
- `system`: hostname, domain name, `dns` (servers by address, each with an optional network instance, and the search
  domains, after OpenConfig `system/dns`), `ntp` (servers), `logging` (remote syslog servers) and `snmp` (location,
  contact, communities);
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

**Any key is safe.** A key is whatever the configuration says, so `__proto__`, `constructor` and `toString` are
ordinary interface names, VRFs, communities and servers. The core reads own properties only (`Object.entries`,
`Object.hasOwn`), so they go through JSON, field paths and both ledger checks like any other key, and the conformance
kit compares models by their own keys, ignoring prototypes. Code that builds a keyed map, in a plugin or a test, uses
null-prototype objects (`Object.create(null)`) or a `Map`, never `map[key] ??= {}` on a plain object, which follows
`Object.prototype` for `__proto__`. `tests/safeKeys.test.ts` in core and in the kit check it, including that
`Object.prototype` is unchanged afterwards.

`MODEL_VERSION` is the model's own semver, separate from the package's. Minor versions only add; major versions
break. That holds in 0.x too, so a plugin built for 0.1 declares `modelApi: '>=0.1.0 <1.0.0'`, not `^0.1.0`.

| Model | What it added |
|---|---|
| 0.1.0 | The phase 1 areas (B2) |
| 0.2.0 | `system.dns` (`Dns`, `DnsServer`) and the `dns` feature area (#21) |

A plugin built for an older minor still loads, and a field it has never heard of, such as `system.dns` for a 0.1
renderer, shows in the ledger as unrendered rather than being dropped (the kit's negative tests).

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
model is 0.2.0.` It also rejects an invalid range, a duplicate plugin id and two tools with one id. It lists the
plugins, the sources (those that parse), the targets (those that render), every tool, and the plugins that detect a
text, best first.

### JSON (`serialize.ts`)

`serializeModel(device)` writes `{ "modelVersion": "0.2.0", "device": { … } }`. `deserializeModel()` reads a document
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
- `scripts/fixtureLicenses.mjs` checks the copied, not shipped fixtures: every source in `fixtures/manifest.json` has
  a license on the shipped allowlist and its text in `fixtures/LICENSES/`, with its NOTICE file when `FIXTURE_NOTICES`
  records one, and nothing else is in that folder. `fixtures/verify.mjs` checks the files against the manifest.

`--check` writes nothing and fails on a stale file or a broken rule; `tests/licenses.test.ts` checks the same, and
`tests/fixtures.test.ts` the fixtures.

## Branding

`branding/` holds the SVG icon masters, the rendered icons in `branding/out/` and the theme tokens
(`theme-tokens.css`). `npm run icons` (`scripts/build-icons.mjs`, with sharp and png-to-ico, build-only) renders the
icons; `npm run contrast` (`scripts/check-contrast.mjs`) checks the tokens against WCAG AA.
