# Dialect: architecture

How the code fits together. Product decisions are in [SPEC.md](SPEC.md); the reasoning behind the design is in the
spike report ([spike-desktop-app.md](spike-desktop-app.md)). This describes the repo as built so far: B1's scaffold, B2's core contracts,
B3 and B4's Junos plugin, B8's IOS / IOS-XE plugin and B9's convert mode.
Each card that adds code updates the part it changes.

## Packages

```
packages/
  core/             @dialect/core           shared model (+ MODEL_VERSION), coverage ledger, plugin interface, registry
  conformance/      @dialect/conformance    dev-only: Vitest conformance kit + negative tests for plugins
  platform-junos/   @dialect/platform-junos tree parser, display set tool, map/render
  platform-iosxe/   @dialect/platform-iosxe indentation-tree parser, map/render for phase 1, detect
  cli/              @dialect/cli            Node CLI: display-set and convert, files and stdin/stdout
  ui/               @dialect/ui             React UI shared by both shells
apps/
  desktop/          @dialect/desktop        Tauri 2 shell: dialogs and file access, installer
  web/              @dialect/web            offline build: the ui as one self-contained HTML file
docs/  scripts/  tests/  branding/
```

`core` and `conformance` hold B2's contracts (below), and `platform-iosxe` and `platform-junos` are the plugins built on them (below); the
other packages are stubs for now. Packages are **source packages**: their `exports` point at
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
| `describeInterface?(name)` | what an interface name says, as a `PortName` (type, Ethernet speed, numbers), for convert's suggestions |
| `nameInterface?(port)` | the plugin's own name for a port another plugin described, as a suggestion |
| `tools?()` | platform-only `Tool`s that don't go through the model, such as Junos display set: `run(input) → { text, diagnostics, sourceLines? }`, where `sourceLines` is the 1-based source line of each line of `text`, for linking output to source |

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

### Convert (`convert.ts`)

`convert(source, target, text, { modelVersion, inputs })` is convert mode for every shell: the source's parse, the
interfaces renamed by the user's answers, the target's render, and the ledger over both (no render after a parse
error). Interface names are the core's job, not a plugin's, so they never map silently:
- every interface the model names, as a key or by reference (`ntp`/`logging` `sourceInterface`, a next hop's
  `interface`, written `name` or `name.<subinterface>`), is a needs-input item (`kind: 'interface-name'`, id
  `interface:<name>`, `interfaceInputId()`), first in the ledger's `needsInput`, with its field and the source statement
  that configures it (the outermost whose mapped fields are all that interface's), or the one that references it;
- a suggestion comes from the source's `describeInterface` and the target's `nameInterface`, and is only offered
  (`suggestions`): an unanswered interface keeps its source name and stays in `unanswered`;
- `renameInterfaces(model, map)` renames keys and references (`ge-0/0/0.0` → `GigabitEthernet0/0/0.0`; the IOS-XE
  renderer writes a `.0` reference as the main interface), with null-prototype maps;
- two interfaces given one name are refused (an error diagnostic, `convert.interface-name-taken`) and left unanswered.

`issues` lists, by source statement in tree order, what didn't carry over: `unmapped`, `unsupported` (the source's
reason), or `not-rendered` (a field the statement filled that the target marked unsupported or left without a
disposition, found by mapping the render's paths back to the source's names). Shells show them in the source gutter
and as warnings; a reason is the plugin's words, never the statement's text. `parseInterfaceMap()` reads a map file
(`from,to` lines with `#` comments, or a JSON object) and says what's wrong by line; `formatInterfaceMap()` writes the
line form. `interfaceInputs(map)` turns a map into answers.

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
expected model, with `modelVersion`), optionally `<case>.rendered.<ext>` (the expected render) and optionally
`<case>.secrets.json` (a JSON list of the secret values in the source). A source without its model file, or a model or
secrets file without its source, is an error. A plugin's test file runs the kit with one line:

```ts
describeConformance(plugin, new URL('./fixtures', import.meta.url))
```

Each fixture goes through five checks (`checkFixture()`):
1. parse → no error, and the expected model;
2. render → no error, and the expected text (skipped when there is none and the render reported no error);
3. render → reparse → no error, and the same model;
4. the coverage ledger is complete for the parse and the render;
5. no secret in a message (`checkSecrets()` in `secrets.ts`, AGENTS.md's rule), skipped for a fixture with none.

An error a step reports (a diagnostic with `severity: 'error'`) fails its check even when its output matches;
warnings and info don't.

The secrets check takes the fixture's secrets from its `secrets.json`, or else finds them in the source by pattern
(`findSecrets()`: crypt-style hashes and Junos `$9$`, IOS typed passwords and keys, SNMP communities, TACACS+/RADIUS
and NTP keys, Junos's `secret`, `authentication-key`, `encrypted-password` and pre-shared keys). A value found as a
secret stays one wherever else the source has it (a comment, a VRF of the same name). It runs the parse, the render of
the parse's model and each of the plugin's tools on the fixture and on broken copies of it (cut just after a secret; a
quote opened after one), since a syntax error is where a message most often quotes its line. It looks in diagnostics'
messages, needs-input items' messages and suggestions, statement and field dispositions' reasons, thrown errors, and
the text of every tool not named in `configTools` (a report). It doesn't look in the render's text or a config tool's,
the config itself: the core's `Tool` doesn't say what its text is, so the plugin's suite names its config tools
(`describeConformance(plugin, dir, { configTools: ['display-set'] })`). It doesn't look in statement labels or field
paths either, which name the config's own structure. A plugin with tools but no parse or render still gets it.

A leak found when the check came in can have a temporary allowance (`SECRET_ALLOWANCES` in `allowances.ts`), keyed by
plugin, site (`statement reason`, `tool diagnostic`, `tool text`, …) and optionally the diagnostic's code, the tool or
the fixtures' names, naming the card that fixes it. `describeConformance()` fails a plugin's allowance that none of its
fixtures needs any more, so the fix takes the allowance with it (one scoped to fixtures of another test file is that
file's). Today's: IOS-XE's prototype-names test uses one name as an SNMP community and a VRF, and the VRF messages
name it (#29).

The kit's own tests (`packages/conformance/tests`) use a test-only stub platform, a tiny brace language, to show the
checks catch careless plugins:
- a mapper that handles only `host-name` in `system { host-name r1; services { ssh; } }`: `system services ssh` is
  unmapped although line 1 is "covered";
- a renderer that handles only a BGP neighbor's address and remote AS: `…neighbors["10.0.0.2"].multihop.ttl` is
  unrendered although the neighbor was, also when `multihop` is a field of a later minor model version;
- a stub that quotes a secret in each kind of message the secrets check looks in (`tests/secrets.test.ts`).

## IOS / IOS-XE plugin (`@dialect/platform-iosxe`, B8)

The first Cisco platform, IOS and IOS-XE treated as one. Its default export is the `PlatformPlugin` (`id: 'iosxe'`,
`modelApi: '>=0.2.0 <1.0.0'`, for model 0.2's DNS), with `detect`, `parse` and `render`.

- **The tree (`tree.ts`):** one statement per line, nested by indentation; bare `!` and blank lines are separators, not
  statements, and a `!` line with text is a comment. Ids are `L<line>`, labels the full path (`interface Gi1 shutdown`).
  Two delimited bodies are recognised and kept whole, verbatim, as one atomic statement with no children: a **banner**
  (`banner [type] <d>…<d>`, any delimiter; `^C` as `show running-config` writes Ctrl-C is one two-character delimiter;
  text after the closing delimiter belongs to it) and a **certificate chain** (`crypto pki|ca certificate chain`, each
  `certificate` running to its own `quit` whatever the hex's indentation). An unterminated one is an error diagnostic
  and takes the rest of the text.
- **Parse (`parse.ts`):** hostname, `ip domain name`, DNS (`ip name-server [vrf V] A [B …]`, one statement naming
  several servers, and `ip domain list` search domains), interfaces and subinterfaces (`Gi0/1.10`: subinterface `10` of
  `Gi0/1`; a main interface's addresses are subinterface `0`), dotted masks → prefix lengths, `secondary` addresses (the
  primary gets `primary: true` only beside secondaries), `encapsulation dot1Q` (also setting the parent's
  `vlanTagging`), `shutdown`, `description`, MTUs; `ip route` / `ipv6 route` with VRF, interface, next hop, distance,
  `tag` and `name`, `Null0` as `drop: 'discard'`; `ntp server`/`source`; `logging host`, `trap`, `facility` (IOS's one
  trap level and facility are copied onto every host) and `source-interface`; `snmp-server community` (`RO`/`RW`),
  `location` and `contact`. The interface type is derived from the name. A statement is `mapped` only when every
  option on it is understood; one with an option the model can't hold (`ntp server … key 1`, a community with an ACL,
  `ip route … track 1`) is `unsupported` as a whole, and so is every unknown statement and everything inside it. A later
  single-valued setting supersedes an earlier one (`ignored-by-design`, "superseded by line N"), as on the device, and
  `no ip address` removes the addresses before it. A `secondary` address with no primary is unsupported: the model
  can mark a primary but not a secondary, so it would come back as the primary. The model keys name servers by address alone,
  so the same server in a second VRF is unsupported. `vrf default` (on a name server, NTP server or syslog host) is the
  global table, mapped as if no VRF were given, since that is how it renders. Keys come from the configuration (`snmp-server community __proto__`), so the
  model is built with own properties only, never through Object.prototype.
- **Render (`render.ts`):** gives every leaf of model 0.2 a disposition (DNS as one `ip name-server` line per server) and leaves a later version's fields without
  one, so the ledger reports them. `type` and `vlanTagging` are `not-applicable` (IOS says them through the name and
  `encapsulation dot1Q`). What IOS can't write is `unsupported` with why: unit 0's own description or shutdown, a
  `reject` route, a static route's metric, an SNMP community limited to some clients (left out whole, with a warning, rather than
  written open to every client: that needs an ACL, with filters later), and per-host syslog
  severities or facilities that differ. A VRF's `type` is unsupported (no `vrf definition` yet) and its routes get a
  semantic warning; with several IPv4 addresses and no primary, the first becomes primary, with a warning.
- **Tests:** `tests/fixtures/<area>` are hand-written, with expected models and renders, through the conformance kit.
  `tests/corpus.test.ts` reads the corpus by path (`fixtures/public/iosxe`, not copied): chosen files per phase 1 area
  against expected models in `tests/corpus/`, and every IOS / IOS-XE file through the kit's checks against its own
  parse (no error, a complete ledger, a stable round trip).

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

The desktop app's **Rust crates** come from `scripts/crateNotices.mjs` (`CRATE_PRODUCTS`: `apps/desktop/src-tauri`, for
`x86_64-pc-windows-msvc`), with `--locked` against the committed `Cargo.lock`:

- **Runtime** crates, which ship, are `cargo tree -e normal,no-proc-macro`: normal dependencies, not entering a
  proc-macro. **Host-only** crates are the rest of `cargo tree -e normal,build`: proc-macros, build scripts and what
  only they use, such as `cssparser-macros`; they run on the build machine and are build-only. `cargo tree` applies
  resolver 2's separate host and target features, which `cargo metadata`'s merged resolve doesn't. `cargo metadata`
  gives each crate's license (Cargo's deprecated `A/B` read as `A OR B`), its link (the same `packageLink()` as npm's)
  and its source folder, whose LICENSE, COPYING and NOTICE files are its texts (`LICENSE.spdx` is metadata, not a
  text). A crate with no license file needs a reviewed `CRATE_SUPPLEMENTS` entry.
- Both files list the crates in a section of their own, and the crates are judged by the same rule. In the notices, a
  license text that is the same as one given earlier (Apache-2.0's, mostly) is given once and referred to, which
  keeps the file near 390 KB instead of over 1 MB.
- The installer's NSIS and `nsis_tauri_utils`, and Microsoft's WebView2 loader, which `webview2-com-sys` links
  statically into the exe, are hand-written entries in `scripts/notices` (`OTHER`).
- `apps/desktop/src-tauri/deny.toml` configures cargo-deny (licenses, sources, advisories) as a second look; the rule's
  own check is the one above, which is in `npm test` and CI.

`--check` writes nothing and fails on a stale file or a broken rule; `tests/licenses.test.ts` checks the same, and
`tests/fixtures.test.ts` the fixtures.

## The Junos plugin (`packages/platform-junos`)

B3's parser and display set, ported from the spike prototype, and B4's mapping to and from the model for the phase 1
areas, with `detect()`. Junos scope is MX, EX and QFX (SPEC.md §4): SRX security, policies and NAT are `unsupported`.

- `plugin.ts`: the package's default export, the `junos` `PlatformPlugin` (`modelApi: '>=0.2.0 <1.0.0'`, for model
  0.2's DNS), with `detect`, `parse`, `render` and the capabilities per area. Its `tools()` has one tool,
  `displaySetTool`: id `display-set`, name "Display set". `run(text)`
  returns the set lines as text, one per line, each ended by a newline (none on an error), and `sourceLines`, the
  statement's source line for each output line (a quoted value with line breaks makes one set line several output
  lines, each with its statement's line). It also returns the parse error or the warnings as diagnostics: `category: 'syntax'`, codes `junos.syntax`, `junos.annotation`,
  `junos.unknown-tag`, `junos.stray-annotation`, `junos.empty-list`, and a point span at their line and column. The
  core's `Tool` has no field for what a tool reads and writes, so `JunosTool` adds `input: 'junos-hierarchical'` and
  `output: 'junos-set'`. Its text is config, so the conformance kit's secrets check is told so (`configTools`).

- `tokenizer.ts`: words (quoted strings kept as written, escapes included), braces, brackets, `;` and
  `/* annotations */`; `#` comments to the end of the line. Each token has a 1-based line and column.
- `tree.ts`: `parseConfig()` builds a generic syntax tree from the curly-brace syntax alone, without the Junos schema.
  A `ConfigNode` is its words, then children (a container), a `[ ]` list (a leaf with values) or neither (a leaf), the
  `inactive:`/`protect:`/`replace:` tags and the annotation before it. A syntax error throws `JunosParseError` with
  its line and column; unknown `word:` tags, annotations with no statement after them (also one ended by `;`, as
  Batfish's tests write it) and empty lists are warnings. A bare `;` is an error.
  Messages never quote the config's words, values or annotations (they reach stderr, logs and the UI, and a value can
  be a secret): only punctuation and tag names, with positions to say where.
- `displaySet.ts`: `flatten()` turns the tree into `set` lines, each with the source line it comes from (for the UI's
  source and output highlighting). A statement's `deactivate` and `protect` lines come after the `set` lines of its
  subtree, Juniper's documented order. `displaySet()` wraps both: the lines and warnings, or the first error.

### Parse: text → statements → model

- **Statements (`statements.ts`):** the text is read as set form when commands (`set`, `deactivate`, `delete`…) start
  its lines and none ends in `{` or `;`, else as hierarchical. Either way it becomes the core's syntax tree and a flat
  list of statements: a statement is a full path of words, values included and quotes undone, as a `set` command says
  it, so both forms map the same way (the 22 jcc pairs give the same model in both forms). Hierarchical: a syntax
  node per statement, ids `L<line>:<column>`; a leaf gives one statement per value of its `[ ]` list, an empty
  container one, and a container none of its own. Set form: a syntax node per command, ids `L<line>`; a quoted string
  or an annotation can run over lines. `delete` removes the statements before it under its path and `deactivate`
  every statement under its path (`ignored-by-design`, with the line that did it), as does `inactive:`; `protect` and
  `unprotect` change nothing. A set-form line that isn't a command (a stray `{`) is an error on that line only.
- **Groups and ranges (`expand.ts`), before mapping:** `apply-groups G` at a level inherits group G's statements under
  that level, and `apply-groups-except G` stops it below one (at the top level, where Junos refuses it, it is
  `unsupported`). A wildcard word in a group (`<*>`, `<ge-*>`, `<[xe][et]-*>`: `*`, `?` and `[…]` classes) matches
  the names the configuration has at that place, the members of its interface ranges included, so it adds to what
  exists and never creates it. Every matching entry of a group applies, wildcard or literal, and gives the values the
  others don't; where two set the same value, the first entry in the group wins ("the first item encountered … that
  matches is used"). Each group is kept as a tree, every level's children (wildcards and names alike) in the order the
  group first gives them; two of its statements setting the same value are compared where their paths part, and the
  earlier sibling wins, whatever the group says above that level. Paths that part at two names (no wildcard) are one
  statement and its new value, so the later command wins, as `set` does.
  Groups that apply only on some devices (`re0`/`re1` by Routing Engine slot, `node0`/`node1` through `apply-groups
  "${node}"`, and any group with a `when` condition) aren't converted: their statements and applications are
  `unsupported`, with a `junos.device-group` warning, rather than guessing the device. Then the configuration wins over what it inherits, a deeper `apply-groups` over a shallower one,
  and the first group listed over later ones; sets add up. Each expanded statement carries a **rank** saying this (one per
  application of a group) and, when inherited, its group and words; the mapper gives a single value to the statement
  that outranks the others (`outranks()`: rank, then the group's tree), the later of equal ones, so precedence doesn't
  depend on order. `interfaces interface-range R` gives each member (`member X`, `member-range A to
  B` differing in the last number) the settings of every range it is in, the first range's where they differ;
  explicit interface settings win over the range's, and a range's over a group's. Ranges and members a group defines
  count too. Member patterns (`"xe-0/0/[0,1]"`) aren't expanded yet (`unsupported`), nor is `apply-groups` inside a
  group. `tests/inheritance.test.ts` has a test per rule, each with the Juniper page that states it. A group or range
  statement is mapped wherever it applies; one that applies nowhere is `ignored-by-design` with why; the
  `apply-groups` and `member` statements themselves are `ignored-by-design`, or `unsupported` (an unknown group, a
  member pattern). **A node that stands for several statements** (a `[ … ]` list, a group or range statement applied
  in several places) is `unsupported` when any of them is, "only partly converted", so a value that isn't converted
  can't hide behind the ones that are.
- **Mapping (`parse.ts`):** each statement on its own: `system host-name`, `domain-name`, `domain-search`,
  `name-server A [routing-instance R]`, `ntp server A [version N] [prefer] [routing-instance R]`, `syslog host H` with
  `any <severity>` (`info` is informational, `any` debug), `port`, `routing-instance` and `facility-override`;
  interfaces with `description`, `disable`, `mtu`, `vlan-tagging`, units with `description`, `disable`, `vlan-id` and
  `family inet`/`inet6` (`address A/L [primary]`, `mtu`); static routes in `routing-options static` and `rib
  inet6.0 static`, and in routing instances (`instance-type vrf`, `rib R.inet6.0`): `next-hop` (an address or an
  interface), `qualified-next-hop` with its own `preference`, `metric`, `tag` and `interface`, `discard`, `reject`,
  and the route's `preference`, `metric` and `tag`, applied to each hop without its own; SNMP `location`, `contact`
  and communities with `authorization` and `clients`. A statement is `mapped` only when everything it says went into
  the model. A later single-valued setting supersedes an earlier one ("superseded by line N"): a statement left with
  only the fields it filled in passing (the interface's type, its unit) is superseded too. Everything else is
  `unsupported`, with a reason where one helps (`family ethernet-switching`, per-facility syslog severities, NTP
  keys, `protocols`, `security`). **An SNMP community is converted whole or not at all:** one setting the mapper
  can't carry (a `client-list-name`, `clients … restrict`, a `view`) makes all its statements unsupported and leaves it
  out of the model, so it can't come out answering clients it shouldn't. The interface type comes from the name
  (`ge-`, `xe-`, `et-` ethernet, `ae` aggregate, `lo` loopback, `irb` vlan, `fxp`/`em`/`me` management, `gr-`/`st`
  tunnels). Reasons never quote the configuration.
- **Render (`render.ts`):** hierarchical Junos with 4-space indents, every leaf of model 0.2 with a disposition and a
  later version's fields left without one. `type` is `not-applicable` (Junos names it), as are `enabled: true` and
  `primary: false` (the defaults). A setting every next hop of a route shares is written once for the route; a hop
  with its own, or with both an address and an interface, is a `qualified-next-hop`. What Junos can't say is
  `unsupported` with why: a route's description, NTP and syslog source interfaces (Junos uses addresses), a drop beside
  other next hops (with a warning), a routing instance that isn't a VRF. **An SNMP community whose client list can't
  be written (empty, or not prefixes) is left out whole**, with a warning that names no community.
- `detect.ts`: hierarchical (`system {`, `unit 0 {`, `version …;`) and set-form signs, discounted by IOS's
  (`hostname`, `!`, `interface GigabitEthernet…`).
- **Tests:** the prototype's self-test cases and jcc's failure cases (`tests/displaySet.test.ts`), and jcc's 22 pairs,
  cleaned up by `tests/cleanFixtures.ts` into `tests/fixtures/display-set/` (`tests/displaySetFixtures.test.ts`). The
  plugin in the core's registry, and display set through `registry.tools()` on the same pairs (`tests/plugin.test.ts`).
  The conformance kit over hand-written fixtures, one folder per area plus groups, set form and an SRX config whose
  security statements are `unsupported` (`tests/fixtures/conformance/`, `tests/conformance.test.ts`). The corpus
  (`tests/corpus.test.ts`), read by path: chosen files per area against expected models in `tests/corpus/`, and every
  Junos file through the kit's checks against its own parse, secrets included; the one that isn't a configuration (a
  terminal capture that cuts a quoted hash) must give a syntax error that quotes nothing. `tests/mapping.test.ts`:
  both forms, `detect()`, nodes standing for several statements, member ranges, inactive statements, keys named like
  `Object.prototype`'s, secrets, SNMP communities and render from another platform's model.
  `tests/inheritance.test.ts`: the group and range inheritance rules, one per test, each citing Juniper's page.
  The tests have their own tsconfig with Node's types, so `src` stays platform-neutral.

## The command line (`packages/cli`)

- `src/cli.ts`: `run(argv, io, version)` parses the arguments, reads the input through `io`, and runs the command
  through the core's registry (`createRegistry([junos, iosxe])`): `display-set` as the Junos plugin's tool, `convert`
  through the core's `convert()` with the plugins `--from` and `--to` name and the `--map` file's answers. It returns the
  exit code (0 done, 1 an error diagnostic, 2 a usage error or unreadable input, 3 interfaces unnamed without
  `--allow-incomplete`). Diagnostics and convert's issues print as `name:line:column: severity: message`, an issue with
  its plugin's reason only. It never touches `process`, so it can be called directly.
- `src/bin.ts`: the entry. It wires `run()` to Node's file system, stdin, stdout and stderr, sets `process.exitCode`,
  and ignores a closed stdout pipe.
- `vite.config.ts`: `npm run build -w @dialect/cli` bundles `bin.ts` and the workspace packages it imports into one ES
  module, `dist/dialect.mjs`, for Node 24, with a `#!/usr/bin/env node` line. Only Node's own modules stay imports.
  Vite is build-only.
- `tests/cli.test.ts` builds into a temp folder with Vite's API and runs the built file with Node: the 22 display set
  fixtures, stdin, invalid input, warnings, unreadable files and usage errors; and convert on
  `tests/fixtures/convert/phase1.conf` (a Junos phase 1 config, its map `phase1.map.csv` and the IOS-XE it gives,
  `phase1.iosxe`, also used by the web and desktop tests), other maps, exit 3 and `--allow-incomplete`.

## The UI (`packages/ui`)

The React UI both shells share: `<App platform={…} />`, where `Platform` (`src/platform.ts`) is the shell's file and
clipboard access (open, open a dropped file, save, read and write the clipboard), which build it is (`kind`, `version`)
and how it opens a web link (`openLink`). Open and save take what the file holds (`FileKind`: a config, or an interface
map), so the shells offer the right file types. The UI never touches files itself: even a dropped file is read by the shell,
from the drop event's data. Both shells take the version from the root `package.json` (a named JSON import, so only
that field is bundled).

- `src/store.ts`: one zustand store, with the mode (display set or convert), the convert target, the source text and
  its name, the interface map, what the source gives in the mode (the output, the linked lines as source/output pairs,
  the problems, and in convert the interface rows), the theme choice, and requests to reveal a place in an editor. Both
  modes go through the core's registry (`createRegistry([junos, iosxe])`), as the CLI does: display set as the Junos
  plugin's tool (its problems from the result's diagnostics, its links from `sourceLines`), convert as the core's
  `convert()` from Junos to the target (its problems from the ledger's diagnostics and `issues`, its links from
  `links` and the statements' spans, its rows from `interfaces`). Both run synchronously on every change (config_22,
  316 KB, parses in tens of milliseconds). The interface map is kept while the source is edited and dropped when
  another file opens or the target changes, so no name carries over to other ports unasked.
- `src/App.tsx`: the title bar (the mode switch, convert's target, and the actions: Open, Paste, Copy output, Save
  output, Help, the theme), the source and output panes, the problems panel (and in convert, the interface table beside
  it) and the status bar. A file dropped anywhere opens, even on an editor: the drop is handled
  in the capture phase, so CodeMirror doesn't insert it, and `platform.openDropped()` reads it. Moving the cursor in one pane marks the matching lines in the other, through
  the store's links.
- `src/components/InterfaceTable.tsx`: convert's interface table: each interface with its name on the target, the
  suggestion as the input's placeholder and a Use button, Use suggestions, and Load map… / Save map in the CLI's map
  format (the core's `parseInterfaceMap()` and `formatInterfaceMap()`).
- `src/editor/`: the CodeMirror 6 editor component, and Junos colouring as a stream language (colouring only: the
  parser does the real work). The source editor has an issue gutter: a marker on each error or warning line, with what
  it says on hover.
- `src/help/` (B16, Hive's Docs view and About dialog): `docs.ts` bundles `docs/USER_GUIDE.md`, `CHANGELOG.md`,
  `LICENSE` and `THIRD_PARTY_NOTICES.md` with Vite's `?raw`; `Markdown.tsx` renders one with marked, cleans it with
  DOMPurify, gives headings GitHub's ids and keeps every link from navigating the page (another bundled document
  opens in the view, `#heading` scrolls, `https://` goes to `platform.openLink`); `DocsView.tsx` takes the place of
  the panes; `AboutDialog.tsx` shows the version, the build and the engine (`engine.ts`: `navigator.userAgentData`'s
  full version where there is one, else the user agent string); `HelpMenu.tsx` opens them (F1: the guide, Esc: back);
  `state.ts` is their own small store. `tests/help.test.ts` fails when a bundled document isn't the committed file, so
  with the license check the app's notices are always the current ones. The rendered HTML stays inside the CSP: no
  inline styles or scripts (DOMPurify drops scripts and handlers; marked writes none), so the web build's hash-only
  policy is unchanged. The notices are most of the web build's size: about 1.1 MB in all.
- `src/styles/help.css`: the menu, the Docs view, the Markdown pages and the About dialog, imported by `app.css`.
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

## The desktop app (`apps/desktop`)

`npm run build -w @dialect/desktop` runs `tauri build`: Vite builds the frontend (`src/main.tsx`, the shared UI with
`src/desktopPlatform.ts`) into `dist/`, cargo builds `src-tauri` with it embedded, and the bundler makes the NSIS
installer, `src-tauri/target/release/bundle/nsis/Dialect_<version>_x64-setup.exe` (about 1.7 MB; the exe is 4 MB).

- **Rust:** `src-tauri/src/main.rs` only opens the window and adds the dialog, fs and opener plugins. Conversion runs
  in the webview, from the same TypeScript as the web build.
- **The Platform** (`src/desktopPlatform.ts`): Open and Save output use `@tauri-apps/plugin-dialog`'s open and save
  dialogs, then `@tauri-apps/plugin-fs` to read or write that path. A dropped file is read from the drop event, as in
  the web build: the window sets `dragDropEnabled: false`, so the page gets the HTML drop and the UI hands it to
  `openDropped`. The clipboard is WebView2's clipboard API. `openLink` (a Docs link) is `@tauri-apps/plugin-opener`'s
  `openUrl`, which starts the default browser.
- **Capabilities** (`src-tauri/capabilities/default.json`): `dialog:allow-open`, `dialog:allow-save`,
  `fs:allow-read-text-file` and `fs:allow-write-text-file`, with no fs scope: the dialog plugin adds each file the user
  picks to the fs scope, so the page can read or write those files and no other (the smoke test checks
  `C:\Windows\win.ini` is refused). `opener:allow-open-url` with the scope `https://*` (the opener's glob, whose `*`
  spans `/`): the page can open https links and nothing else (the smoke test checks an `http://` and a `file://` URL and
  a path are refused).
- **CSP** (`tauri.conf.json`, `app.security.csp`): `default-src 'none'`, `script-src 'self'`, `style-src 'self'`,
  `img-src 'self' data:`, `connect-src ipc: http://ipc.localhost`, and `'none'` for `base-uri`, `form-action` and
  `object-src`. Tauri adds its own scripts' hashes. The editors' styles are constructed stylesheets in shadow roots,
  as in the web build, so `style-src` needs no `unsafe-inline`.
- **Installer** (`bundle`): NSIS only, `installMode: currentUser`, `compression: zlib` (no CPL code from NSIS's LZMA),
  the default WebView2 mode, icons from `branding/out`. `bundle.windows.signCommand` runs `scripts/sign.mjs` on every
  file the bundler signs: unsigned (it says so) until `DIALECT_SIGN_COMMAND` gives a signing command with `%1` for
  the file.
- **Tests:** `tests/desktop.test.ts` (in `npm test`) checks the Platform with the plugins mocked, and the config and
  capability above. `e2e/smoke.test.ts` (`npm run test:smoke -w @dialect/desktop`, not in `npm test`) builds the app
  (`tauri build --no-bundle`), starts it from the build output through tauri-driver and Edge WebDriver, drops a
  fixture and checks its display set, opens About and each Docs page, then checks that the CSP refuses an inline
  script, a remote image and a fetch (WebDriver's own scripts aren't subject to the CSP, so it checks what the page
  does), that the fs plugin refuses a file nobody picked and that the opener refuses anything but https. It talks WebDriver with fetch (`e2e/webdriver.ts`): every WebdriverIO package depends on
  `@promptbook/utils`, CC-BY-4.0, which the license rule doesn't allow even as build-only. It needs tauri-driver
  (`cargo install tauri-driver --locked --version ^2`) and the msedgedriver matching the installed WebView2 (from
  `https://msedgedriver.microsoft.com/<version>/edgedriver_win64.zip`), through `MSEDGEDRIVER` or `PATH`.

## Branding

`branding/` holds the SVG icon masters, the rendered icons in `branding/out/` and the theme tokens
(`theme-tokens.css`). `npm run icons` (`scripts/build-icons.mjs`, with sharp and png-to-ico, build-only) renders the
icons; `npm run contrast` (`scripts/check-contrast.mjs`) checks the tokens against WCAG AA.
