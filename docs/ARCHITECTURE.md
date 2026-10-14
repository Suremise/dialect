# Dialect: architecture

How the code fits together. Product decisions are in [SPEC.md](SPEC.md); the reasoning behind the design is in the
spike report ([spike-desktop-app.md](spike-desktop-app.md)). This describes the repo as built so far: B1's scaffold, B2's core contracts,
B3 and B4's Junos plugin, B8's IOS / IOS-XE plugin, B9's convert mode, and B12 and B13's NX-OS and IOS-XR plugins.
Each card that adds code updates the part it changes.

## Packages

```
packages/
  core/             @dialect/core           shared model (+ MODEL_VERSION), coverage ledger, plugin interface, registry
  conformance/      @dialect/conformance    dev-only: Vitest conformance kit + negative tests for plugins
  platform-junos/   @dialect/platform-junos tree parser, display set tool, map/render
  platform-iosxe/   @dialect/platform-iosxe indentation-tree parser, map/render for phase 1, detect
  platform-nxos/    @dialect/platform-nxos  indentation-tree parser (banners whole), map/render for phase 1, detect
  platform-iosxr/   @dialect/platform-iosxr indentation-tree parser (route policies, sets, banners whole), map/render for phase 1, detect
  cli/              @dialect/cli            Node CLI: display-set and convert, files and stdin/stdout
  ui/               @dialect/ui             React UI shared by both shells
apps/
  desktop/          @dialect/desktop        Tauri 2 shell: dialogs and file access, installer
  web/              @dialect/web            offline build: the ui as one self-contained HTML file
docs/  scripts/  tests/  branding/
```

`core` and `conformance` hold B2's contracts (below), and `platform-junos`, `platform-iosxe`, `platform-nxos` and
`platform-iosxr` are the plugins built on them (below); `cli`, `ui` and the two apps use them. Packages are **source packages**: their `exports` point at
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

## Core contracts (`@dialect/core`, model 0.4.1)

Frozen as v0 by B2: a change to these is a change to every plugin and shell, and goes through the model's versioning.

### The shared model (`model.ts`)

`Device` is OpenConfig-shaped, as plain readonly types:
- `system`: hostname, domain name, `dns` (servers by address, each with an optional network instance, and the search
  domains, after OpenConfig `system/dns`), `ntp` (servers), `logging` (remote syslog servers) and `snmp` (location,
  contact, communities);
- `interfaces`: type, description, enabled, MTU, VLAN tagging, and `subinterfaces` with a VLAN id, `ipv4`/`ipv6`
  addresses and the `networkInstance` (VRF) they route in when not the global table. A main interface's own L3 is
  subinterface `0`, so NX-OS `vrf member`, IOS `vrf forwarding` and IOS-XR `vrf` on an interface go there, and Junos's
  `routing-instances V interface ge-0/0/0.0` on its unit;
  - a switch port's `switching` (after OpenConfig `switched-vlan`): `mode` `access` or `trunk`, the `accessVlan`, a
    trunk's `allowedVlans` (a leaf-list of IDs and ranges, `"10"`, `"20-30"`, `"1-4094"` for all) and `nativeVlan`.
    Junos ELS `unit 0 family ethernet-switching` and Cisco `switchport` map here. An access port's frames are untagged;
    a trunk's are tagged, except the native VLAN's. The settings of the mode a port isn't in are kept as the source
    has them;
  - a routed VLAN interface (IRB/SVI) is of type `irb-or-svi`, and the subinterface that routes for a VLAN says which
    in `routedVlan`: Junos `irb` unit 10 (`vlans V l3-interface irb.10`), Cisco `interface Vlan10` on subinterface `0`.
    Plugins built before 0.4 call these interfaces `vlan`, which stays;
- `vlans`, keyed by VLAN ID (`"10"`), with a `name` (Junos's key for it) and `description`;
- `networkInstances`: `default` for the global table, each with a `type` (`default`, `vrf`, `virtual-router`),
  `staticRoutes` and their next hops, and for a VRF its `routeDistinguisher` and `routeTargets` (`import` and `export`
  leaf-lists), in the forms `ASN:nn`, `IP:nn` or `ASN4:nn` (4-byte AS, plain), without a `target:` prefix;
  - `ospf` (OSPFv2, after OpenConfig `ospfv2`): Cisco's `processId`, `routerId`, and `areas` by dotted ID (`0.0.0.0`;
    Cisco's `area 0` is that), each with a `type` (`normal`, `stub`, `nssa`) and its `interfaces` by interface
    reference (`ge-0/0/0.0`, `GigabitEthernet0/0/1`): `passive`, `cost`, `networkType` (`point-to-point`,
    `broadcast`), `helloInterval`, `deadInterval`, and `enabledBy`, whether the source enabled it on the interface or
    with a `network` statement, so a target that can't say it the same way raises a semantic warning;
  - `bgp` (after OpenConfig `bgp`): `localAs` and `routerId`, `groups` by name (Junos groups, Cisco peer groups) and
    `neighbors` by address, each with a `peerAs`, `description`, `localAddress` or `updateSource` (an interface
    reference), `multihop` (`{}`, or a `ttl`), `addressFamilies` (`ipv4-unicast`, `ipv6-unicast`), and
    `importPolicies`/`exportPolicies` by name only, on the peer or per address family (policy bodies are phase 3); a
    neighbor names its `group`, and its own settings win over the group's. Since 0.4.1, `ebgpDefaultPolicy` says what
    the source platform does with an eBGP peer's routes when no policy applies (`import`, `export`: `accept` on Junos
    and IOS-XE, `reject` on IOS-XR after RFC 8212). It is the source's default, not configuration, kept with the data
    as `enabledBy` is: a **parser** sets the side(s) that apply when the instance has an eBGP peer without an import
    or an export policy; a **renderer** gives it a `not-applicable` disposition and raises a `category: 'semantic'`
    warning when its own default differs, naming the line, never a peer's address.

**Secrets are flags, never values:** OSPF `authentication` (`simple`, `md5`, `key-chain`, on an area or an interface)
and a BGP peer's `authentication: true` say the source had a key; the key never reaches the model, so the target asks
for it (a needs-input item of kind `secret`, whose `field` is the flag's path) and writes it from the answer. **A
renderer never writes a placeholder key**: unanswered, the key is left out, and the conformance kit's round trip
excuses that leaf (below).

These are the phase 1 and phase 2 areas; later minor versions add policy bodies and filters (phase 3).

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
| 0.3.0 | `Subinterface.networkInstance` (VRF membership), `NetworkInstance.routeDistinguisher` and `routeTargets`, and the `virtual-router` type (#44) |
| 0.4.0 | `Device.vlans`, `Interface.switching`, the `irb-or-svi` type and `Subinterface.routedVlan`, `NetworkInstance.ospf` and `bgp`, and the `vlans`, `ospf` and `bgp` feature areas (#59, phase 2) |
| 0.4.1 | `Bgp.ebgpDefaultPolicy` (`BgpDefaultPolicy`), the source's default for eBGP peers without a policy (#68) |

A plugin built for an older minor still loads, and a field it has never heard of, such as `system.dns` for a 0.1
renderer, a subinterface's `networkInstance` for a 0.2 one or any of 0.4's VLAN, switch port, routed VLAN, OSPF and BGP
fields for a 0.3 one, shows in the ledger as unrendered rather than being dropped (the kit's negative tests). Each
plugin adopts 0.4 in its own phase 2 cards.

### Validation (`validate.ts`)

The types can't say everything a model must hold, so `modelProblems(device)` checks the rest, as error diagnostics
with a `model.…` code and the leaf's path as `field`: a subinterface's `networkInstance` must name an entry of
`networkInstances` (own keys only, so a VRF called `toString` is found only when declared), and isn't `default`, which
is said by leaving it out; a route distinguisher and each route target must be in one of the three forms
(`isRouteDistinguisher()`: `ASN:nn` with a 2-byte AS and a 4-byte number, `IP:nn` and `ASN4:nn` with a 2-byte number).

From 0.4.0, references resolve and values are in range:
- VLANs: keys, access, native and routed VLANs are VLAN IDs from 1 to 4094 (`isVlanId()`, `model.vlan-id`); an
  allowed VLAN is an ID or a range, first below last (`model.vlan-range`); an access, native, routed or single allowed
  VLAN names a VLAN of `vlans` (`model.unknown-vlan`; a range carries whichever of its VLANs exist, so `1-4094` needs
  none declared); an `irb-or-svi` interface routes for a VLAN (`model.irb-without-vlan`), and only such an interface
  does (`model.routed-vlan-interface`);
- OSPF and BGP: router IDs are IPv4 addresses (`model.router-id`), areas dotted (`model.ospf-area`), local and peer AS
  numbers plain, from 1 to 4294967295 (`isAsNumber()`, `model.as-number`); an OSPF interface and a BGP update source
  name an interface, and with a `.N` that isn't part of a key, one of its subinterfaces (`model.unknown-interface`); a
  neighbor's group is one of its instance's (`model.unknown-bgp-group`).

Messages never quote the value, which can share its text with a secret. The conformance kit runs it on every parse and
reparse.

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
  `interface`, an OSPF interface's key, a BGP `updateSource`, written `name` or `name.<subinterface>`), is a needs-input
  item (`kind: 'interface-name'`, id
  `interface:<name>`, `interfaceInputId()`), first in the ledger's `needsInput`, with its field and the source statement
  that configures it (the outermost whose mapped fields are all that interface's), or the one that references it;
- a suggestion comes from the source's `describeInterface` and the target's `nameInterface`, and is only offered
  (`suggestions`): an unanswered interface keeps its source name and stays in `unanswered`;
- `renameInterfaces(model, map)` renames keys and references (`ge-0/0/0.0` → `GigabitEthernet0/0/0.0`; the IOS-XE
  renderer writes a `.0` reference as the main interface), OSPF interface keys included, with null-prototype maps;
- two interfaces that would have one name are refused, counting the source names unanswered interfaces keep: the
  answers in a clash are dropped (an error diagnostic, `convert.interface-name-taken`, with the interfaces' lines), so
  each keeps its distinct source name and none replaces another. So are answers that would give two OSPF interfaces of
  an area one reference (`eth0` → `Gig0.0` beside `eth1.0` with `eth1` → `Gig0`), with the OSPF statements' lines.
  `renameInterfaces()` throws rather than merge two;
- no message names an interface (needs-input items say which by `statement` and `field`): a name can be a secret's
  value reused, and messages reach stderr and logs.

`issues` lists, by source statement in tree order, what didn't carry over: `unmapped`, `unsupported` (the source's
reason), or `not-rendered` (a field the statement filled that the target marked unsupported or left without a
disposition, found by mapping the render's paths back to the source's names). Shells show them in the source gutter
and as warnings; a reason is the plugin's words, never the statement's text. `parseInterfaceMap()` reads a map file
(`from,to` lines with `#` comments, `from,` for one not named yet, or a JSON object, refused whole when it names an
interface twice) and says what's wrong by line, quoting no name; `formatInterfaceMap()` writes the line form, and with
the conversion's interfaces every one of them to fill in, suggestions marked `# suggested` (the CLI's `--write-map`). `interfaceInputs(map)` turns a map into answers.

### The registry (`registry.ts`)

`createRegistry(plugins)` checks each plugin's `modelApi` against `MODEL_VERSION` (semver's `satisfies`) and throws
`PluginRejectedError` naming both versions: `Plugin "junos" supports model versions >=1.2.0 <2.0.0, but this core's
model is 0.4.1.` It also rejects an invalid range, a duplicate plugin id and two tools with one id. It lists the
plugins, the sources (those that parse), the targets (those that render), every tool, and the plugins that detect a
text, best first.

### JSON (`serialize.ts`)

`serializeModel(device)` writes `{ "modelVersion": "0.4.1", "device": { … } }`. `deserializeModel()` reads a document
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
1. parse → no error, a model with no `modelProblems()`, and the expected model;
2. render → no error, and the expected text (skipped when there is none and the render reported no error);
3. render → reparse → no error, a model with no `modelProblems()`, and the same model, except a leaf the render left
   to the user: a populated leaf it didn't write that a `secret` needs-input item (with an id) names as its `field`
   (`deferredSecrets()`), a key the model flags but never carries (#68), and an object only taking it out left empty
   (a group whose one leaf was its key), which the reparse may have empty or not (`group G;` or nothing); an object
   the model has empty still counts. The result lists them (`deferred`), and the
   suite puts them in the test's name, so none is left out unseen. A leaf dropped without such an item, or left to an
   item of another kind, still fails;
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
file's). There are none today: the last ones, for IOS-XE's VRF messages naming a VRF that shared its name with an
SNMP community, went when those messages stopped quoting the name (#29).

### Probes (`probes.ts`, #33)

Beside its fixtures, a plugin runs the kit's probes for the bug classes reviews kept finding, by giving its
`ProbeAdapter` (`describeConformance(plugin, dir, { probes })`): small sources in its own syntax, and the kit checks
what comes out the same way for every platform (`runProbes()`):
1. **prototype keys:** one source using `__proto__`, `constructor` and `toString` as each name it can (an interface, a
   VRF, an SNMP community, a DNS name, a VLAN's name, a BGP group in the default instance), in one text: each stays an own key where the model keeps that name, the source
   passes the five fixture checks with the key as a secret (a community is one, and a VRF of the same name is too), and
   `Object.prototype` is unchanged after two parses and renders: every own property's descriptor (a value or accessor
   by identity, each flag), no property added or removed, and its prototype. What changed is reported and put back;
2. **SNMP access never widens:** a source with one community limited to some clients, read-only and read-write. The
   parse and the render → reparse each have it with clients or not at all. A render of the kit's own limited community
   (`PROBE-COMMUNITY`, read-only or read-write, clients `192.0.2.0/24`) → reparse has it back exactly (the same access
   and clients, its fields `rendered`, no other community, no error), or not at all with its fields `unsupported`;
3. **negation clears state** (an address, a description, a name server, a static route, a community, a BGP neighbor,
   an OSPF interface): the value at the case's path is there after `set`, and in neither the parse nor the render →
   reparse of `negated`;
4. **malformed values are flagged, not mapped** (an IPv4 or IPv6 address, a mask, a next hop, an AS number, a VLAN
   ID): unless the parse reports an error, a statement on the value's line (the case's `line`, or every line with it)
   is `unsupported`, none starting there is `mapped` or `ignored-by-design`, and the value is in no model (as a key, a
   string or a number). A statement that vanishes without a word fails;
5. **VRF scoping** (a delete, a DNS change, a static route, OSPF or BGP change): every leaf that differs between `base` and
   `changed` is the VRF's, and the case changes something. A leaf is the VRF's under its network instance, or under an
   entry that belongs to it: where `base` puts an entry it already has (no `networkInstance`: the global table), and
   where `changed` puts a new one, so a change can't move another VRF's entry in and make its edits look in scope.

Every probe source also goes through the five fixture checks, the secrets check with the community names its parse
has (and a cleared one's) among its secrets. Every probe and case is a choice in the adapter's types: given, or
`{ notApplicable: 'why' }` for an area the plugin doesn't have, which the suite shows as a skipped test with its reason.
The cases model 0.4.0 added (the VLAN and BGP group uses, BGP and OSPF negation, AS and VLAN malformed values, OSPF and
BGP scoping) are optional in the types, so an adapter written before 0.4 compiles and runs as it did: `runProbes()`
leaves out the ones it doesn't give, `probesNotGiven()` lists them, and the suite shows them as one skipped test, `not
given yet (model 0.4.0)`, until the plugin's phase 2 card gives each or declares it not applicable.
A plugin with no adapter shows its probes as one skipped test, never as passing; each existing plugin's adapter is its
own lane's follow-up card, which fixes what its probes find in the plugin (that lane owns it), so the probes have no
allowances of their own; a probe source's secrets go through the secrets allowances like any fixture's.

The kit's own tests (`packages/conformance/tests`) use a test-only stub platform, a tiny brace language, to show the
checks catch careless plugins:
- a mapper that handles only `host-name` in `system { host-name r1; services { ssh; } }`: `system services ssh` is
  unmapped although line 1 is "covered";
- a renderer that handles only a BGP neighbor's address and remote AS: `…neighbors["10.0.0.2"].multihop.ttl` is
  unrendered although the neighbor was, also when `multihop` is a field of a later minor model version, and a 0.2
  renderer leaves 0.3's VRF membership, route distinguisher and route targets unrendered;
- a parse that puts an interface in a VRF it never declares, or gives a malformed route distinguisher, fails the parse
  check; so does a 0.4 model with an access or trunk VLAN, an OSPF interface, a BGP update source or group that doesn't
  exist, or an IRB/SVI with no VLAN;
- a 0.3 renderer leaves each of 0.4's areas (VLANs, switch ports, IRB/SVI, OSPF, BGP) unrendered, field by field;
- a stub that quotes a secret in each kind of message the secrets check looks in (`tests/secrets.test.ts`);
- a line-language probe stub (`tests/probeStub.ts`) with a switch for each probe's bug class: `{}` containers that
  turn `__proto__` into a prototype, a client list dropped on parse or on render, `no` forms that remove nothing, any
  address, AS number or VLAN ID taken as one, and a `no` in one VRF that removes the same thing (a route, a BGP
  neighbor, an OSPF interface) everywhere. Each fails its probe; the
  careful stub passes them all (`tests/probes.test.ts`).

## IOS / IOS-XE plugin (`@dialect/platform-iosxe`, B8)

The first Cisco platform, IOS and IOS-XE treated as one. Its default export is the `PlatformPlugin` (`id: 'iosxe'`,
`modelApi: '>=0.4.0 <1.0.0'`, for model 0.4's VLANs, switch ports and routed VLANs), with `detect`, `parse`, `render`
and `nameInterface`.

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
  `no ip address` removes the addresses before it, as do `no description`, `no ip route [vrf V] P [next hop]` (that
  next hop of the route in that VRF or the global table, or every one; the others keep their order, renumbered),
  `no ip name-server [vrf V] A …` (only in the VRF it names) and `no snmp-server community X` (with every statement
  about it, its access list too) (#55). A community with any statement not converted, anywhere in the text (an access
  list, a view), is left out whole rather than mapped open to every client, and a route's next-hop interface must be an
  IOS interface name (`isInterfaceName()`), so a malformed address isn't taken for one. A `secondary` address with no primary is unsupported: the model
  can mark a primary but not a secondary, so it would come back as the primary. The model keys name servers by address alone,
  so the same server in a second VRF is unsupported. `vrf default` (on a name server, NTP server or syslog host) is the
  global table, mapped as if no VRF were given, since that is how it renders. Keys come from the configuration
  (`snmp-server community __proto__`), so the model is built with own properties only, never through Object.prototype.
  - **VRF membership (#45):** `vrf forwarding V` (and the older `ip vrf forwarding V`) on an interface or subinterface
    is the subinterface's `networkInstance` (subinterface `0` for a main interface). It clears the IPv4 and IPv6
    addresses before it, as on the device ("removed by line N, which moves the interface to another VRF"), so only the
    addresses after it stay; `no vrf forwarding [V]` returns the interface to the global table, clearing them too, and
    one naming another VRF touches nothing. A VRF the text never defines (`vrf definition` or `ip vrf`: an
    `ip route vrf V` naming it isn't a definition) would name a VRF the device doesn't have: the membership and the
    interface's addresses are then `unsupported` rather than put in the global table. `vrf forwarding default` is
    `unsupported` (IOS names no global table).
  - **VRF definitions:** `vrf definition V` (and the older `ip vrf V`) is a network instance of type `vrf`. Its `rd`
    maps in any of the model's three forms (a later one supersedes it, `no rd` removes it). Route targets
    (`route-target import|export|both V`, `no route-target …` taking one direction) can be VRF-wide or in
    `address-family ipv4|ipv6`. As on IOS, a family with route targets of its own uses only those, and one with none
    inherits the VRF-wide ones (which are then `ignored-by-design` as overridden when no family inherits them). The
    model holds one set for the VRF, so every family's effective set must agree, or they are all `unsupported`; so they
    are when a family overrides one direction only (what it keeps of the other isn't certain) or one statement about
    them isn't converted: an import or export map, VRF-wide or in a family, or anything else in the definition but a
    description. The address family statements are `ignored-by-design`. `no address-family ipv4|ipv6` removes the
    family, its route targets and what in it blocked them (a blocker VRF-wide or in another family still blocks), and
    leaves out the VRF's interface addresses and routes in that family before it
    (`unsupported`: what the device keeps of them isn't guessed). `no vrf definition V` / `no ip vrf V` removes the VRF,
    everything in it, its `ip route vrf V` routes, and its interfaces' membership and addresses, as the device does.
  - **A VRF only routes name (#53):** `ip route vrf V …` with no `vrf definition V` or `ip vrf V` in the text keeps V
    for its routes (type `vrf`, nothing else: no route distinguisher or targets is invented), with a parse warning,
    `iosxe.vrf-created`, whose `field` names the instance and whose message names no VRF (it can share its name with a
    secret). The warning is the parse's: only it can tell the source had no definition, which a model from another
    platform can't say. A render writes `vrf definition V` with the address families its routes need, as for any VRF.
    When a later `no ip route` removes its last route, nothing names it, and it goes too.
  - **VLANs, switch ports and VLAN interfaces (#62, model 0.4):** `vlan N` (or a list, `vlan 100,3000`, `vlan 10-20`)
    is a VLAN, with a single VLAN's `name` (one word); `no vlan N` removes it and its name, but IOS keeps its default
    VLANs (1, 1002 to 1005). `switchport` on a main interface is its `switching` (bare, an empty one): `mode access` or
    `trunk` (a later mode the model doesn't have, `dynamic auto|desirable`, `dot1q-tunnel` or `private-vlan …`, is
    `unsupported` and still supersedes the one before it, so a negotiated port never becomes a forced trunk), `access
    vlan`, `trunk native vlan`, and `trunk allowed vlan` read as the device does: a list, `all`, `none`
    or `except` replaces the list (the earlier statements `ignored-by-design`, superseded), `add` and `remove` change it,
    from every VLAN when it has none yet. The list is kept as IDs in order, a run of two or more as a range
    (`10,11,12` is `10-12`). `trunk encapsulation dot1q` is `ignored-by-design` (the model's only one). The `no` forms
    remove their setting, and `no switchport` every switch port setting before it; it stays `unsupported` itself (the
    model has no routed-port setting). A malformed VLAN ID or list is `unsupported` and changes nothing. `interface
    VlanN` is of type `irb-or-svi`, routing for VLAN N on subinterface `0` (`routedVlan`); a `Vlan` subinterface or a
    switch port setting on one is `unsupported`. A VLAN a port or VLAN interface uses that the text doesn't define (a
    switch in VTP server mode keeps its VLANs out of its configuration) is kept with no name, mapped by the first
    statement using it, with a parse warning, `iosxe.vlan-created`, naming it by `field` only; VLAN 1, which IOS always
    has, gets none. A VLAN `no vlan` deleted (and no later `vlan` defines again) isn't brought back: its ports are
    inactive and its VLAN interface down on the device, which the model can't say, so a switch port using it is left
    out whole (its `switchport` statements `unsupported`) and so is its VLAN interface, with its addresses. A
    `switchport access vlan` creates a VLAN that doesn't exist, one deleted before too, where it is read, as IOS does:
    it stays when the port moves on to another VLAN or becomes routed, until a later `no vlan` deletes it again.
- **Render (`render.ts`):** gives every leaf of model 0.3, and of 0.4's VLANs, switch ports and routed VLANs, a
  disposition (DNS as one `ip name-server` line per server) and leaves the rest (OSPF, BGP, a later version's fields)
  without one, so the ledger reports them. VLANs come first (`vlan N`, ` name X`; VLAN 1, always there, isn't written,
  and a name with a space or any VLAN's description is `unsupported`); a switch port is ` switchport`, its VLANs, then
  its mode, as `show running-config` orders them (an empty allowed list as `none`); a routed VLAN is rendered by the
  interface's name, `interface VlanN`, and is `unsupported` on an interface of another name or a subinterface. Each VRF is a `vrf definition` before
  the interfaces, with its `rd` and its route targets VRF-wide (the model's are the VRF's), and the address families
  its interfaces' addresses and routes need (IPv4 also for a VRF with an RD or route targets); an interface's
  `vrf forwarding V` comes before its addresses, which it would otherwise clear, and `ip route vrf V` after. `type`
  and `vlanTagging` are `not-applicable` (IOS says them through the name and `encapsulation dot1Q`). What IOS can't
  write is `unsupported` with why: unit 0's own description or shutdown, a `reject` route, a static route's metric, an
  SNMP community limited to some clients (left out whole, with a warning, rather than written open to every client:
  that needs an ACL, with filters later), per-host syslog severities or facilities that differ, a membership in a VRF the model doesn't have (with the interface's addresses,
  which would otherwise land in another table), a route distinguisher or route targets on the global table, and an
  instance type other than `vrf`. With several IPv4 addresses and no primary, the first becomes primary, with a
  warning.
- **Tests:** `tests/fixtures/<area>` are hand-written, with expected models and renders, through the conformance kit.
  `tests/corpus.test.ts` reads the corpus by path (`fixtures/public/iosxe`, not copied): chosen files per phase 1 area
  against expected models in `tests/corpus/`, and every IOS / IOS-XE file through the kit's checks against its own
  parse (no error, a complete ledger, a stable round trip). `tests/probes.ts` is its adapter for the kit's probes
  (#55): every probe runs, but a prototype key as an interface name, which IOS can't say; of model 0.4's cases, a VLAN
  name and a malformed VLAN ID so far.
- **Convert suggestions (`names.ts`):** `nameInterface()` names an Ethernet port by its speed, `Port-channel`,
  `Loopback` and `Tunnel` by number, and a `vlan` or `irb-or-svi` port `Vlan<id>` by its VLAN's ID. A Junos `irb.100`
  gets `Vlan100` only once the core's convert names an IRB unit on its own (#41): today it names the `irb` interface
  as a whole.

## NX-OS plugin (`@dialect/platform-nxos`, B12)

The second Cisco platform, built like the IOS / IOS-XE plugin (its code copied, not imported: plugins don't depend on
each other). Its default export is the `PlatformPlugin` (`id: 'nxos'`, `modelApi: '>=0.4.1 <1.0.0'`, for model 0.4's
VLANs, switch ports, SVIs, OSPF and BGP and 0.4.1's eBGP default policy), with `detect`, `parse`, `render`, and `describeInterface` and
`nameInterface` for convert's suggested names.

- **The tree (`tree.ts`):** as IOS's, nested by NX-OS's two-space indents; `!Command:` and `!Time:` headers are
  comments. Banners (`banner motd|exec <d>…<d>`) are kept whole as one atomic statement; an unterminated one is an
  error diagnostic. NX-OS has no certificate chains in its running config.
- **Parse (`parse.ts`):** `hostname` and `switchname`, `ip domain-name`, DNS (`ip name-server A [B …] [use-vrf V]`,
  `ip domain-list`), interfaces (`Ethernet1/1`, `port-channel10`, `loopback0`, `Vlan10`, `mgmt0`; type from the name,
  `mgmt0` as `management`), subinterfaces with `encapsulation dot1q`, addresses with a prefix length or a dotted mask,
  `secondary` for IPv4 and IPv6 alike (one primary per family, as NX-OS keeps it: a second primary replaces the first),
  `vrf context X` (a VRF, with its `rd`, route targets and `ip route`/`ipv6 route` inside), `vrf member V` on interfaces
  and subinterfaces, static routes (interface, next hop, `name`, `tag`,
  distance, `Null0`), `ntp server … [prefer] [use-vrf V]` and `source-interface`, `logging server H [level] [port P]
  [use-vrf V] [facility F]` and `source-interface`, and `snmp-server community` (`group network-operator|network-admin`
  or `ro`/`rw`), `location` and `contact`. As in the IOS plugin, a statement with an option the model can't hold
  (`key`, `track`, `secure`, a next hop in another VRF) is `unsupported` as a whole. A route's next-hop interface must
  be an interface name: a malformed address or a stray word makes the route unsupported.
  - **Later statements act on earlier ones, as on the device.** A second setting supersedes the first; the same route
    next hop again is an edit of it (NX-OS keys a route by its prefix, interface and next hop). `no` forms of every
    setting the parser maps remove it and mark what they removed: `no hostname`, `no ip domain-name`,
    `no ip domain-list X`, `no ip name-server … [use-vrf V]` (only in the VRF it names, no VRF and `default` alike),
    `no ip|ipv6 route P [next hop]` (at the top or in a `vrf context`; every next hop when it names none),
    `no vrf context X` (with its routes, route distinguisher and route targets), `no rd`,
    `no route-target import|export|both V` (that direction only), `no description`, `no mtu`, `no encapsulation dot1q` (the parent's
    `vlanTagging` goes with the last tag), `no ip|ipv6 address [A/L]`, `no vrf member`, `no ntp server X`,
    `no ntp|logging source-interface`, `no logging server X`, `no snmp-server community X`,
    `no snmp-server contact|location`, `no feature X`. `vrf member` and `ip address dhcp` clear the addresses before
    them.
  - **VRF membership:** `vrf member V` is the subinterface's `networkInstance` (subinterface `0` for a main interface),
    and clears the addresses before it, as on the device. `vrf member default` returns the interface to the global
    table as `no vrf member` does, leaving `networkInstance` out. A VRF the text never defines would name a network
    instance the model doesn't have: the membership and the interface's addresses are then `unsupported` rather than
    put in the global table. When `no vrf context V` deletes a VRF that interfaces are in, NX-OS's guides say only that
    it deletes "the VRF and all associated configuration" (and that an interface can be in a VRF that doesn't exist
    yet, down until it does), not what the interfaces keep, so (#47, the user's decision) their membership and their
    addresses up to the deletion are `unsupported` ("in a VRF line N deletes: what the device keeps of it isn't
    certain"), even when V is defined again later; so are addresses given to such an interface before a new
    `vrf member` or `no vrf member` says where it is, and from then on it maps normally. `mgmt0` is always in the management VRF, which
    is built in: its interface statement maps `networkInstance: management` (and the `management` network instance when
    the text has no `vrf context management`), so the model says so whether `vrf member management` is shown or not;
    that statement is `ignored-by-design`, and any other VRF on mgmt0, or `management` on another interface, is
    `unsupported`.
  - **Route distinguishers and targets:** `rd V` in a `vrf context` maps in any of the model's three forms (a later one
    supersedes it; `rd auto` is `unsupported`). NX-OS sets route targets per address family
    (`address-family ipv4|ipv6 unicast`, `route-target import|export|both V`); the model holds one set for the VRF, so
    they map only when every unicast family's agree, as sets in each direction (in any order, the model keeping the first
    family's; a family with none disagrees with one with some), and are all
    `unsupported` otherwise, or when one of them isn't converted (`route-target both auto`), since a partial list would
    be wrong. EVPN's (`route-target … evpn`, `address-family l2vpn evpn`) are another family's, `unsupported` on their
    own. They are BGP's (L3VPN): `feature bgp` is `ignored-by-design` when a converted route distinguisher or target
    needs it, and `unsupported` otherwise, like the rest of BGP; `no feature bgp` leaves out the ones before it.
  - **`feature` lines:** one a converted statement needs (`interface-vlan` for Vlan interfaces, `tunnel` for Tunnel
    interfaces, `ospf` for OSPF, `bgp` for BGP and a VRF's route distinguisher and targets; `features.ts`) is
    `ignored-by-design`, since the render writes it back whenever it is needed. Every other feature turns on a service
    the model doesn't hold, and is `unsupported`. `no feature ospf` and `no feature bgp` leave out what the feature's
    configuration before them said, as the device deletes it.
  - **VLANs:** `vlan 10` and `vlan 4,6-8` define each VLAN of the list (`vlans`, by ID), with `name` for a single VLAN;
    `no vlan` removes those VLANs (a statement about others too keeps them). VLAN 1 is built in: a port or an SVI that
    uses it brings `vlans["1"]` into the model, and `no vlan 1` is `unsupported`.
  - **Switch ports:** `switchport mode access|trunk`, `switchport access vlan`, `switchport trunk native vlan` and
    `switchport trunk allowed vlan` map to `switching`; the allowed list as written, `all` (`1-4094`), `none` (an empty
    list), and `add`, `remove` and `except` applied as NX-OS does (from every VLAN when no list came before), as
    compact ranges. Their `no` forms go back to NX-OS's defaults, which the model leaves out, and `no switchport` clears
    them, as the device does. A VLAN they name must be defined: one that isn't is `unsupported` with its statement (a
    range carries whichever of its VLANs exist). Another mode, and a setting on a loopback, a subinterface or a port
    with IP configuration, are `unsupported`. `switchport` alone is `ignored-by-design` on a port with no IP
    configuration and `no switchport` on one with some (an address, a VRF, subinterfaces or OSPF; the render writes
    both back), each `unsupported` otherwise.
  - **SVIs:** `interface Vlan10` is an `irb-or-svi` interface routing for VLAN 10 on subinterface `0` when VLAN 10 is
    defined; without it, it stays an interface of type `vlan` with no routed VLAN, as before model 0.4.
  - **OSPF:** per interface, as NX-OS enables it: `ip router ospf TAG area A` (any area form, dotted in the model) puts
    the interface in that area of the network instance it is in (`enabledBy: 'interface'`), with `ip ospf cost`,
    `network point-to-point|broadcast`, `passive-interface`, `hello-interval`, `dead-interval` and `authentication
    [message-digest|key-chain K]` (flagged; `null` is `unsupported`). The key (`authentication-key`,
    `message-digest-key`) is `ignored-by-design`: never carried. `router ospf TAG` holds `router-id`, `area A
    stub|nssa`, `area A authentication [message-digest]` and `passive-interface default` for the global table, and
    the same under `vrf V` for V. `passive-interface default` maps as `passive` on each of the process's interfaces that
    doesn't say `no ip ospf passive-interface`. `network` statements are `unsupported`: NX-OS no longer documents them.
    The model has one process per network instance: the one its interfaces enable first, else the first with settings
    there; another process's settings and interfaces there are `unsupported`, and one with nothing of its own there is
    `ignored-by-design`. `vrf member` deletes an interface's OSPF settings with its addresses, as NX-OS deletes its
    Layer 3 configuration. `no ip router ospf`, `no ip ospf …`, `no router-id`, `no area A …` and `no router ospf TAG`
    remove what they name; interfaces enabling a removed process are `unsupported`, as what the device keeps isn't
    certain. Settings on an interface with no converted `ip router ospf` are `unsupported`.
  - **BGP:** `router bgp ASN` (plain or asdot) is `localAs`, with `router-id`; NX-OS runs one process, so a second AS is
    `unsupported`. `neighbor X [remote-as N]` and `template peer T` (a group) take `remote-as`, `description`,
    `update-source`, `ebgp-multihop`, `password` (flagged: `authentication`, never carried), `inherit peer T` (a
    neighbor's group), `no shutdown` (`ignored-by-design`) and `address-family ipv4|ipv6 unicast` with `route-map NAME
    in|out` (by name only, with the warning `nxos.route-map-name-only`, which gives the line, not the name). `vrf V`
    under it is V's BGP, with the process's AS as V's `localAs`. A global `address-family ipv4|ipv6 unicast` is
    `ignored-by-design` (the render writes it where a peer carries the family); what is inside it, a neighbor range
    (dynamic peers), `template peer-session|peer-policy` and other families are `unsupported`. `no neighbor`, `no
    template peer`, `no address-family`, each setting's `no` form and `no router bgp ASN` remove what they name. Once
    every statement is read, BGP in a VRF the text doesn't define, an update source that names no interface and a
    template a neighbor's VRF doesn't have (a VRF neighbor inheriting a global template, for now) are `unsupported`.
  - **eBGP default policy (model 0.4.1, #69):** NX-OS takes and sends an eBGP peer's routes with no route map (no
    RFC 8212). For each network instance with an eBGP neighbor that has no route map one way in a family it carries
    (each family by its effective policy: the family's own, else the neighbor's, else the template's family's, else the
    template's; with no family, the neighbor's or the template's), the parse sets `ebgpDefaultPolicy` to `accept` that
    way, mapped by `router bgp` or the VRF's `vrf V`: the platform's default, not configuration.
  - **A VRF's deletion** (`no vrf context V`) leaves V's OSPF and BGP so far out as `unsupported`, as its interfaces'
    membership is (#47).
  - **SNMP communities:** a community with any statement not converted, anywhere in the text (an access list in any
    form, `use-ipv4acl … use-ipv6acl …` on one line included; a group other than network-operator or network-admin;
    `no snmp-server community X …` removing part of it), is left out whole, every statement about it `unsupported`,
    rather than mapped with access it may not have.
  - **No secrets in reasons:** no disposition reason or diagnostic repeats a word of the config (AGENTS.md); they give
    line numbers and word positions instead ("word 5 isn't converted yet", "an address in the VRF of line 4"), so a
    secret reused as a VRF, a route name or an option stays out too. The kit's secrets check runs on every fixture and
    corpus file.
  - Keys come from the configuration (`vrf context __proto__`), so the model is built with own properties only, and
    per-name bookkeeping uses `Map`s.
- **Render (`render.ts`):** every leaf of model 0.4 gets a disposition; a later version's fields get none, for the
  ledger to report. The text relies on no switch default: it writes each `feature` a written statement needs before it,
  and `switchport` or `no switchport` on every Ethernet and port-channel interface (`no switchport` with an address or
  subinterfaces, a VRF or OSPF). Each VRF is a `vrf context` with its `rd`, its routes and its route targets under both
  `address-family ipv4 unicast` and `ipv6 unicast` (the model's are the VRF's), after `feature bgp`, and before the
  interfaces; `vrf member V` comes before an interface's addresses, which it would otherwise clear, and `mgmt0` always
  gets `vrf member management`. What NX-OS can't write is `unsupported` with why: a membership in a VRF the model
  doesn't have, in `management` on an interface other than mgmt0, or in another VRF (`default` included) on mgmt0
  (each with the interface's addresses, which would otherwise land in another table), a route distinguisher or target
  on the global table, subinterface 0's own description or shutdown, an address family's MTU, an NTP server's version,
  a `reject` route, a route's metric, and an SNMP community limited to some clients (left out whole, with a warning
  that doesn't name it). With several addresses and no primary, the first becomes primary, with
  a warning.
  - **VLANs and switch ports:** each VLAN as `vlan N` with its `name` (a description, or a name with a space or over
    32 characters, is `unsupported`), before the interfaces; a switch port's settings after its `switchport` line
    (`none` for an empty allowed list). On a routed port or an interface NX-OS can't switch they are `unsupported`.
  - **SVIs:** an `irb-or-svi` interface is written only as `Vlan<ID>`, routing for that VLAN, with the subinterface
    that routes for it (`0`, or another, as Junos's `irb` unit 100 renamed `Vlan100` is) as its own Layer 3. Under any
    other name it isn't written, with the warning `nxos.svi-name`: the interface map names it. Other subinterfaces of
    a Vlan interface are `unsupported`.
  - **OSPF:** each instance's process under `router ospf TAG`, VRFs as `vrf V` in it, with `router-id` and each area's
    `stub|nssa` and `authentication [message-digest]` (a key chain for an area is `unsupported`); a source with no tag
    (Junos) is written as `1`, with an info diagnostic. Each OSPF interface gets `ip router ospf TAG area A` and its
    settings after its addresses, in its own interface's block; one in another network instance than its interface's,
    or a second area for one interface, is `unsupported`. One the source enabled with `network` statements raises the
    warning `nxos.ospf-enabled-per-interface`: a later interface in the range doesn't join by itself.
  - **BGP:** `router bgp` with the local AS (a VRF's own other AS is `unsupported`), `router-id`, the global address
    family for each family a peer carries, groups as `template peer` (a VRF's groups are `unsupported`: NX-OS's
    templates are the process's) and neighbors, then each VRF as `vrf V`. A Junos `internal` group writes
    `remote-as` with the local AS; `localAddress` and multihop with no TTL are `unsupported`. Route maps go per family,
    one each way: a policy for the whole peer goes into each family it carries (its template's too) unless the family
    has its own, and a chain of policies is `unsupported`. Warnings: `nxos.route-map-name-only` (a policy written by
    name), `nxos.ebgp-default-policy` (an eBGP neighbor with no route map one way, by the same per-family rule, where
    the source's `ebgpDefaultPolicy` is `reject` that way: IOS-XR's RFC 8212 drops those routes and NX-OS exchanges
    them all; the warning names no peer), `nxos.bgp-no-address-family` (it carries no routes). `ebgpDefaultPolicy` is
    `not-applicable`: the source's default.
  - **Secrets the model only flags** are `secret` needs-input items, each naming the `authentication` leaf, written
    when the answer is one NX-OS takes and never made up: an OSPF key per interface (`nxos.ospf-key:<the OSPF
    interface's path>`; for MD5, `ID KEY`; an area's authentication asks on each interface without its own), a key
    chain's name, and a BGP password (`nxos.bgp-password:<the peer's path>`). A key chain's and a password's field is
    `unsupported` until answered, since NX-OS's line needs the answer; the kit's round trip leaves them to it (#68). An answer NX-OS can't take raises `nxos.answer-not-taken`, without repeating it.
- **Suggested names (`names.ts`):** `describeInterface` says `port-channelN` is aggregate N; `nameInterface`
  suggests `port-channel` for another platform's aggregate, counted as Cisco does: Junos `aeN` is `port-channel(N+1)`,
  IOS-XE `Port-channelN` and IOS-XR `Bundle-EtherN` keep N (the user's decision). It takes the describing plugin's id as
  an optional second argument, which the core's convert doesn't pass yet (#64's comment proposes it): without it,
  nothing is suggested, rather than guess the numbering.
- **Detect (`detect.ts`):** counts NX-OS's own signs (`feature`, `vrf context`, `vrf member`, `use-vrf`, prefix-length
  addresses, `switchname`, `version 9.3(3)`, `!Command: show running-config`, RANCID's `cisco-nx`) and discounts IOS's
  (dotted masks, `end`, `service timestamps`, `vrf definition`), IOS-XR's and Junos's. Over the corpus, wherever either
  plugin is sure (0.4 or more), the right one of NX-OS and IOS-XE scores higher.
- **Tests:** the same layout as the IOS plugin's: hand-written fixtures per area through the kit
  (`tests/fixtures/<area>`, with expected models and renders), chosen corpus files against expected models in
  `tests/corpus/`, and every file of `fixtures/public/nxos` through the kit's checks. `plugin.test.ts` also checks
  every render of the fixtures and the corpus for a missing `feature` line, with its own table of what needs one.
  `tests/probes.ts` is its adapter for the kit's probes (#54): every probe runs, a community limited by an access list
  in either order beside an open statement and a letter-led malformed next hop among them, and model 0.4's (a VLAN name
  and a peer template named by a prototype key, `no neighbor`, `no ip router ospf`, an AS number and a VLAN ID out of
  range, OSPF and BGP changes in one VRF), but a prototype key as an interface name, which NX-OS can't say.
  `phase2.test.ts` covers the phase 2 areas beyond their fixtures, and checks that each phase 2 warning comes from a
  saved source fixture or a saved model from another platform (`tests/models`: `<case>.model.json`, its expected
  `.rendered.cfg` and `.warnings.json`), for what an NX-OS parse can't produce (an IRB not named `Vlan<ID>`, OSPF
  enabled by `network` statements).

## IOS-XR plugin (`@dialect/platform-iosxr`, B13)

The third Cisco platform, built like the NX-OS plugin (its code copied, not imported). Its default export is the
`PlatformPlugin` (`id: 'iosxr'`, `modelApi: '>=0.4.1 <1.0.0'`, for model 0.4's OSPF and BGP and 0.4.1's eBGP default
policy), with `detect`, `parse`, `render`, and `describeInterface` and `nameInterface` for convert's suggested names.

- **The tree (`tree.ts`):** as NX-OS's, nested by IOS-XR's one-space indents; `!` lines are separators and `!!`
  headers comments. Three bodies are delimited, not indented, and each is kept whole, verbatim, as one atomic statement
  with no children, never split: a **route policy** (`route-policy NAME` … `end-policy`, its `if … then … elseif …
  else … endif` blocks and `#` comments inside, whether its body is indented or not), a **set** (any `*-set …`:
  `prefix-set`, `community-set`, `as-path-set`, `rd-set`, `extcommunity-set rt`, `large-community-set`, `tag-set` …
  `end-set`) and a **banner** (any delimiter, `^C` as one). A policy or set opens only at the top level: `route-policy
  P in` inside `router bgp` is a reference. An unterminated one is an error diagnostic (`iosxr.unterminated-policy`,
  `-set`, `-banner`) and takes the rest of the text.
- **Parse (`parse.ts`):** `hostname`; `domain name`, `domain [vrf V] name-server A` (one server a statement),
  `domain list`; interfaces (`GigabitEthernet0/0/0/0`, `TenGigE…`, `Bundle-Ether1`, `Loopback0`, `MgmtEth0/RP0/CPU0/0`;
  type from the name), subinterfaces with `encapsulation dot1q`, `ipv4 address A M|A/L [secondary]` (one primary, a
  second replaces it) and `ipv6 address A/L` (all alike: IPv6 has no primary on IOS-XR), `vrf V`, `shutdown`,
  `description`, `mtu`; `vrf X` with its route targets; `router static` with `address-family ipv4|ipv6 unicast` and
  `vrf V` inside, routes with an interface, next hop, distance, `tag` and `description`, `Null0` as discard; the `ntp`
  block (`server [vrf V] A [prefer] [version N]`, `source IF`, also on one line after `ntp`); `logging A [vrf V]
  [severity S] [port P]` and `logging source-interface IF`; `snmp-server community [clear] NAME [RO|RW]`, `contact`
  and `location`. As in the other Cisco plugins, a statement with an option the model can't hold (`key`, `track`,
  `bfd`, `route-tag`, `link-local`, a next hop in another VRF) is `unsupported` as a whole, and so is every statement
  the plugin doesn't know with everything inside it. `interface X.N l2transport` is Layer 2, unsupported whole, and so
  is a later `interface X.N` for it.
  - **Later statements act on earlier ones, as on the device**, as in the NX-OS plugin: a second setting supersedes the
    first, the same route next hop again is an edit, and the `no` forms of every setting it maps remove it
    (`no hostname`, `no domain name|list|[vrf V] name-server` (that VRF only), `no description|mtu|encapsulation
    dot1q|ipv4 address [A M]|ipv6 address A/L|vrf`, `no server|source` in `ntp`, `no logging A [vrf V]|source-interface`,
    `no snmp-server community|contact|location`, `no vrf X` with its routes), and so do the scopes of `router static`:
    `no router static`, and inside it `no vrf V` and `no address-family ipv4|ipv6 unicast` (in a VRF's too) remove
    every route in that scope and no other. A route line is matched by prefix and next hop alone, so `no P hop …`
    removes a line that wasn't converted (`… track 2`) too.
  - **An edit that isn't converted still replaces what it edits.** IOS-XR keys NTP servers and syslog hosts by address
    and VRF: a later statement for the same server, converted or not, replaces the earlier one, so `server A key 1`
    after `server A` leaves the server out rather than mapped without its key; a second VRF for the same address is a
    server the address-keyed model can't hold, and `unsupported`; `no server [vrf V] A` and `no logging A [vrf V]`
    remove it only in the VRF they name (no VRF and `default` alike). An address edited to add a `route-tag` replaces
    the primary (or the same IPv4 secondary or IPv6 address) the same way.
  - **Numbers in IOS-XR's ranges only:** a VLAN ID from 1 to 4094, an MTU from 64 to 65535, a route tag up to
    4294967295, a port up to 65535; anything else (or a number too long to be exact) is `unsupported`, never mapped
    rounded, and the render checks a model's the same way.
  - **VRF membership:** `vrf V` on an interface is the subinterface's `networkInstance` (subinterface `0` for a main
    interface), and clears the addresses before it, as on the device; `no vrf` returns it to the global table. A VRF
    the text never defines (`vrf X` at the top), or removes, would name a network instance the model doesn't have: the
    membership and the interface's addresses are then `unsupported` rather than put in the global table.
  - **Route targets:** IOS-XR sets them per address family, one per line (`import route-target V`) or listed in a
    block (`import route-target` with a value a line). As NX-OS, they map only when every unicast family's agree, as
    sets in each direction, and are all `unsupported` when one isn't converted (`stitching`, an asdot AS `1.10:12`).
    Other families (`ipv4 multicast`, `flowspec`) and a VRF's import and export route policies are `unsupported`.
  - **Route distinguishers** are BGP's on IOS-XR: `router bgp N` → `vrf X` → `rd` maps a VRF's (`rd auto` is
    `unsupported`), and `no rd` removes it.
  - **OSPF:** `router ospf P` (the global table) and `vrf V` inside it (V's), with `router-id`, `area A` (any form,
    dotted in the model) with `stub`, `nssa` and `authentication [message-digest|keychain K]` (the area's, flagged;
    `stub no-summary` and other options are `unsupported`), and `interface X` in an area (`enabledBy: 'interface'`)
    with `cost`, `network point-to-point|broadcast`, `passive [enable|disable]`, `hello-interval`, `dead-interval` and
    `authentication` (flagged; `null` is `unsupported`). The keys (`message-digest-key`, `authentication-key`) are
    `ignored-by-design`: never carried. **IOS-XR's inheritance:** an interface takes its own setting, else its area's,
    else its process's (a process's `authentication` is each area's that has none); the area's or process's statement
    maps each interface field it fills, and says so when no interface takes it. `passive disable` overrides an
    inherited `passive`. The model has one process per network instance: the first in the text; another one there is
    `unsupported`, and so is an interface the text doesn't define, one in another VRF than its process's, and one
    already in an area of the process. `no router-id`, `no area A`, `no interface X`, `no stub|nssa`, each setting's
    `no` form, `no vrf V` inside it and `no router ospf P` remove what they name.
  - **BGP:** `router bgp ASN` (plain or asdot) is `localAs`, with `bgp router-id`; a second AS is `unsupported`.
    `neighbor X [remote-as N]` and `neighbor-group G` (a group) take `remote-as`, `use neighbor-group G` (a neighbor's
    group; nested in a group, `unsupported`), `update-source`, `ebgp-multihop [N]` (with no TTL, `multihop: {}`),
    `description`, `password` (flagged: `authentication`, never carried), `no shutdown` (`ignored-by-design`) and
    `address-family ipv4|ipv6 unicast` with `route-policy NAME in|out` (by name only, with the warning
    `iosxr.route-policy-name-only`, which gives the line, not the name; one with parameters is `unsupported`; RPL
    bodies stay atomic and `unsupported`). `vrf V` under it is V's BGP, with the AS as V's `localAs`. A global
    `address-family ipv4|ipv6 unicast` is `ignored-by-design` (the render writes it where a peer carries the family);
    what is inside it, other families, `af-group`, `session-group` and `use` of them, and neighbor ranges are
    `unsupported`. `no neighbor`, `no neighbor-group`, `no address-family`, each setting's `no` form, `no vrf V` under
    it and `no router bgp ASN` remove what they name. Once every statement is read, BGP in a VRF the text doesn't
    define, an update source that names no interface and a group a neighbor's VRF doesn't have are `unsupported`.
  - **RFC 8212 (model 0.4.1):** IOS-XR drops an eBGP peer's routes, both ways, with no policy. For each network
    instance with an eBGP neighbor (its peer AS, or its group's, isn't the local AS) that has no policy one way in a
    family it carries (its own families and its group's, each by its effective policy: the family's own, else the
    neighbor's, else the group's family's, else the group's; with no family, the neighbor's or the group's), the parse
    sets `ebgpDefaultPolicy` to `reject` that way, mapped by `router bgp` or the VRF's `vrf V`: the platform's default,
    not configuration. A policy on IPv4 doesn't cover IPv6.
  - **A VRF's deletion** (`no vrf X`) leaves its OSPF and BGP so far, and its route distinguisher, out as `unsupported`:
    what the device keeps of them isn't certain.
  - **SNMP communities:** one with any statement not converted, anywhere (an access list in any form, `IPv4 ACL`,
    `IPv6 ACL` or a bare ACL; `SystemOwner` or `SDROwner`; `no snmp-server community X …` removing part of it), is left
    out whole. An `encrypted` community doesn't carry over and is `unsupported`.
  - **No secrets in reasons**, value-free as in the NX-OS plugin; route policies and sets are never named, and nor is a
    banner's type, which could be a secret's value reused.
    Keys come from the configuration, so the model is built with own properties only, and bookkeeping uses `Map`s.
- **Render (`render.ts`):** `show running-config`'s shape, one-space indents and `!` closing each block. Every leaf of
  model 0.4.1 gets a disposition; a later version's fields get none. VRFs come first (`vrf X` with its route targets in
  the block form under both `address-family ipv4 unicast` and `ipv6 unicast`), then interfaces (`vrf V` before the
  addresses, IPv4 with a dotted mask), `router static` (the global table, then each VRF), the `ntp` block, `logging`
  hosts (each with its VRF, `vrf default` for the global table) and SNMP. A network instance with only routes isn't
  written as `vrf X`: its routes say it. What IOS-XR can't write is `unsupported` with why: a route distinguisher, a
  `virtual-router`, a membership in a VRF the model doesn't have (with the interface's addresses), subinterface 0's
  own description or shutdown, an address family's MTU, a syslog facility per host, an NTP version outside 1–4, a
  `reject` route, a route's metric, and an SNMP community limited to some clients (left out whole, with a warning that
  doesn't name it). With several IPv4 addresses and no primary, the first becomes primary, with a warning.
  - **Layer 2** stays `unsupported` this phase (l2vpn, bridge domains): VLANs, switch ports, and a routed VLAN (a BVI
    on IOS-XR). VLAN-tagged subinterfaces are written as before.
  - **OSPF:** after `router static`, each process as `router ospf P` (a source with no name, Junos, is written as `1`,
    with an info diagnostic), the global table's areas, then each VRF's under `vrf V`; each area with its
    `authentication`, `stub|nssa` and interfaces, each interface with its settings (as the model has them, per
    interface: an inherited one is written on each interface). An OSPF interface the model doesn't have, in another
    network instance than its interface's, or in a second area of the process, is `unsupported`. One the source enabled
    with `network` statements raises the warning `iosxr.ospf-enabled-per-interface`.
  - **BGP:** `router bgp` with the local AS (a VRF's own other AS is `unsupported`; with no local AS, BGP and route
    distinguishers are `unsupported`), `bgp router-id`, the global address family for each family a peer carries,
    groups as `neighbor-group` (a VRF's are `unsupported`: IOS-XR's belong to the whole `router bgp`) and neighbors,
    then each VRF as `vrf V` with its `rd`. A Junos `internal` group writes `remote-as` with the local AS;
    `localAddress` is `unsupported`. Route policies go per family, one each way: a policy for the whole peer goes into
    each family it carries (its group's too) unless the family has its own, and a chain of policies is `unsupported`.
    `ebgpDefaultPolicy` is `not-applicable`: the source's default. Warnings: `iosxr.route-policy-name-only`,
    `iosxr.bgp-no-address-family` (it carries no routes).
  - **RFC 8212:** an eBGP neighbor with no policy one way (its own or its group's) exchanges nothing that way on
    IOS-XR. Each such neighbor is a needs-input item (`iosxr.ebgp-policy:<the neighbor's path>`, kind `other`) asking
    for an existing route policy's name, written each way the neighbor has none in each family it carries; no `pass`
    policy is made up. When the source accepted those routes (`ebgpDefaultPolicy` `accept` that way: Junos, IOS-XE,
    NX-OS), the render also raises `iosxr.ebgp-default-policy`.
  - **Secrets the model only flags** are `secret` needs-input items, written when the answer is one IOS-XR takes and
    never made up: an OSPF key per interface (`iosxr.ospf-key:<the OSPF interface's path>`; for MD5, `ID KEY`; an
    area's authentication asks on each interface without its own), a key chain's name (on an area or an interface),
    and a BGP password (`iosxr.bgp-password:<the peer's path>`), whose field is `unsupported` until answered. The kit's
    round trip leaves these leaves to the answer (#68). An answer IOS-XR can't take raises `iosxr.answer-not-taken`,
    without repeating it.
- **Suggested names (`names.ts`):** `describeInterface` says `Bundle-EtherN` is aggregate N; `nameInterface` suggests
  `Bundle-Ether` for another platform's aggregate, counted as Cisco does: Junos `aeN` is `Bundle-Ether(N+1)`, IOS-XE's
  and NX-OS's port-channel N keep N (the user's decision). As NX-OS's, it takes the describing plugin's id as an
  optional second argument, which the core's convert doesn't pass yet: without it, nothing is suggested.
- **Detect (`detect.ts`):** counts IOS-XR's own signs (RANCID's `cisco-xr`, `!! IOS XR Configuration`, `ipv4
  address`, four-part interface names, `Bundle-Ether`, `MgmtEth`, `router static`, `end-policy`, `end-set`, `domain …`,
  `logging A vrf V`, `import|export route-target`) and discounts IOS's (`ip address`, `ip access-list`, `ip route`,
  `vrf definition`), NX-OS's and Junos's. Over the corpus, wherever any of the three Cisco plugins is sure (0.4 or
  more), the right one scores highest.
- **Tests:** as the other Cisco plugins': hand-written fixtures per area through the kit (`tests/fixtures/<area>`,
  `policy` among them), chosen corpus files against expected models in `tests/corpus/`, and every file of
  `fixtures/public/iosxr` through the kit's checks. Its probe adapter (`tests/probes.ts`, #51) gives every probe in
  IOS-XR syntax, except the prototype keys as an interface name, which IOS-XR can't have (a name is a type and numbers),
  and as a VLAN name (Layer 2 isn't converted this phase). `phase2.test.ts` covers OSPF and BGP beyond their fixtures,
  RFC 8212 with a Junos-sourced model among them, and checks that each phase 2 warning comes from a saved source
  fixture or a saved model from another platform (`tests/models`, as NX-OS's).

## TypeScript

`tsconfig.base.json` holds Hive's settings (strict, ES2023, `module: ESNext`, `moduleResolution: bundler`,
`isolatedModules`, `noEmit`). Each package's `tsconfig.json` extends it and sets its own `lib` and `types`; the root
`tsconfig.json` covers the repo-wide tests and the Vitest config, on Node. `npm run typecheck` runs the root one, then
each workspace's `typecheck` script.

## Checks

- **Lint:** oxlint with `--deny-warnings` (`.oxlintrc.json`: correctness errors, suspicious warnings).
- **Tests:** Vitest (`vitest.config.ts`), from `tests/` and each package's `tests/`.
- **CI:** `.github/workflows/ci.yml`, on Windows with Node 24 and npm 12: `npm ci`, typecheck, lint, tests and the
  license check; and the desktop job (The desktop app, below): cargo-deny, the installer and the smoke test.

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
  or `OPEN_SOURCE`), with the recorded `EXCEPTIONS`. Its `chosenLicense()` says which license a package or crate
  offering a choice is used under (MIT where offered, else the first allowed choice, at each `OR`), which each notices
  entry shows (`shownLicense()`: "MIT OR Apache-2.0, used under MIT").
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

- `plugin.ts`: the package's default export, the `junos` `PlatformPlugin` (`modelApi: '>=0.4.0 <1.0.0'`, for model
  0.4's VLANs, switch ports and routed VLANs), with `detect`, `parse`, `render` and the capabilities per area. Its `tools()` has one tool,
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
  inet6.0 static`, and in routing instances (`rib R.inet6.0`): `next-hop` (an address or an
  interface), `qualified-next-hop` with its own `preference`, `metric`, `tag` and `interface`, `discard`, `reject`,
  and the route's `preference`, `metric` and `tag`, applied to each hop without its own; SNMP `location`, `contact`
  and communities with `authorization` and `clients`. A statement is `mapped` only when everything it says went into
  the model. A later single-valued setting supersedes an earlier one ("superseded by line N"): a statement left with
  only the fields it filled in passing (the interface's type, its unit) is superseded too. Everything else is
  `unsupported`, with a reason where one helps (per-facility syslog severities, NTP keys, `protocols`, `security`). **An SNMP community is converted whole or not at all:** one setting the mapper
  can't carry (a `client-list-name`, `clients … restrict`, a `view`) makes all its statements unsupported and leaves it
  out of the model, so it can't come out answering clients it shouldn't. The interface type comes from the name
  (`ge-`, `xe-`, `et-` ethernet, `ae` aggregate, `lo` loopback, `irb` irb-or-svi, the non-ELS `vlan` vlan,
  `fxp`/`em`/`me` management, `gr-`/`st` tunnels). Reasons never quote the configuration.
- **Routing instances (#46):** `instance-type vrf` or `virtual-router` is the network instance's `type`;
  `interface ge-0/0/0.0` is that unit's `networkInstance` (Junos binds units, so an interface without its unit is
  `unsupported`; `irb.100` and `lo0.1` are units), and makes sure the instance and the unit exist; `route-distinguisher`
  is its `routeDistinguisher` and `vrf-target target:X` both its `routeTargets`, with `vrf-target import` and `export`
  overriding their side (the plain one is `ignored-by-design` when both do). Junos writes a 4-byte AS with `L`
  (`4200000000L:100`): the model writes it plain (`communities.ts`, `fromJunos()` and `toJunos()`); `L` on a 2-byte AS,
  `vrf-target auto`, `vrf-import` and `vrf-export` policies are `unsupported`. Groups apply as everywhere (R1–R12). **A
  unit named in two instances is in neither:** Junos refuses that, so it's an error diagnostic naming the lines (not
  the unit), and every statement that named it is `unsupported`. **An instance of another type** (`mac-vrf`, `evpn`,
  `forwarding`…) is converted not at all, as SNMP communities are: its route distinguisher, targets and units mean
  something else there. Which type an instance has is settled as any single setting is (the configuration over a
  group, an earlier group over a later one), so a group's `mac-vrf` under the instance's own `vrf` is superseded and
  the VRF converts.
- **VLANs, switch ports and IRB (#60, ELS only):** the model keys VLANs by ID and Junos by name, so a VLAN's
  statements and the ports naming it settle once every statement is read. `vlans V vlan-id N` is `vlans["N"]` with
  `name` V, and `description` its description; `l3-interface irb.U` makes irb unit U route for it (`routedVlan`,
  creating the unit as `routing-instances … interface` does). On unit 0, `family ethernet-switching` is the
  interface's `switching`: `interface-mode` its `mode`, and `vlan members` (names, IDs, ranges, `all` as `1-4094`) a
  trunk's `allowedVlans`, each once, or an access port's `accessVlan` (access is Junos's default mode, so a port with
  no `interface-mode` is one); `native-vlan-id` on the interface is a trunk's `nativeVlan` (on a port without
  `interface-mode trunk` it is `unsupported`, as Junos takes one on a trunk only, and no mode is made up). Where the source can't be read
  one way, nothing is guessed: **Junos refuses** two VLANs with one ID and two VLANs naming one IRB unit, so each is an
  error naming the lines, and neither converts; `vlan-id` and `vlan-id-list` replace each other, so they settle as one
  setting (rank, then order): **a VLAN whose `vlan-id-list` wins** converts not at all, and a list its `vlan-id` wins
  over is superseded; a VLAN with no ID converts neither, nor a member that names a VLAN without one;
  **an access port** naming more than one VLAN, a range or a VLAN that doesn't convert is in none; **a non-ELS port**
  (`port-mode`, `native-vlan-id` under its family, VLAN ports listed under the VLAN, `l3-interface vlan.N`) converts
  not at all, so a trunk never comes out an access port; switching on another unit is `unsupported`. A port or
  interface that only unconverted statements configured is left out of the model. **An IRB unit that routes for no
  VLAN** (none of `vlans … l3-interface` names it, or only a mac-vrf's) isn't converted (the user's decision on #60): its statements, its routing
  instance membership too, are `unsupported`, with a `junos.irb-without-vlan` warning naming the lines, and the irb
  interface goes whole when none of its units routes, so the model's referential check (`model.irb-without-vlan`)
  holds. Groups and ranges apply as everywhere (R1–R12): a VLAN's ID is a single setting, members add up.
- **Render (`render.ts`):** hierarchical Junos with 4-space indents, every leaf of model 0.3 and 0.4's VLAN, switch
  port and routed VLAN fields with a disposition, and its OSPF and BGP fields left without one. `type` is `not-applicable` (Junos names it), as are `enabled: true` and
  `primary: false` (the defaults). A setting every next hop of a route shares is written once for the route; a hop
  with its own, or with both an address and an interface, is a `qualified-next-hop`. What Junos can't say is
  `unsupported` with why: a route's description, NTP and syslog source interfaces (Junos uses addresses), a drop beside
  other next hops (with a warning), an instance type Junos doesn't have. **An SNMP community whose client list can't
  be written (empty, or not prefixes) is left out whole**, with a warning that names no community. A routing instance
  has its `instance-type`, an `interface` line per unit that names it, its `route-distinguisher` and `vrf-target` (one
  target each way: the same both ways is `vrf-target target:X`, else `vrf-target { import …; export …; }`; more than one
  needs vrf-import or vrf-export policies, so it is `unsupported`). A virtual router and the global table have no route
  distinguisher or targets (`unsupported`), and a unit naming an instance the model doesn't have is `unsupported`.
  `vlans` names each VLAN by the model's `name`, or `vlan<ID>` for one without (or whose name an earlier VLAN took:
  that `name` is `unsupported`), with its `description`, `vlan-id` and `l3-interface irb.U` from the unit that routes
  for it (a routed VLAN on an interface not named `irb`, one naming no VLAN, or a second unit for one VLAN is
  `unsupported`). A switch port is unit 0's `family ethernet-switching` (`interface-mode`, `vlan members` by name,
  `30-40`, `all`) and `native-vlan-id` on the interface; `vlan members` holds an access port's VLAN or a trunk's, so
  the other mode's VLANs are `unsupported`, as is a native VLAN off a trunk.
  **A VRF Junos can't commit isn't made whole by guessing:** one without a route distinguisher, or without a route
  target for a side, is written with what it has, and each missing part is a needs-input item
  (`routeDistinguisherInputId()`, `routeTargetInputId()`), filled from `Context.inputs` when the user answers (an
  answer in another form is left unused, with a warning). A route target answer goes to every side without one Junos
  can write (left out, empty, malformed or more than one); the item is withdrawn only once the answer is written.
- `detect.ts`: hierarchical (`system {`, `unit 0 {`, `version …;`) and set-form signs, discounted by IOS's
  (`hostname`, `!`, `interface GigabitEthernet…`).
- **Tests:** the prototype's self-test cases and jcc's failure cases (`tests/displaySet.test.ts`), and jcc's 22 pairs,
  cleaned up by `tests/cleanFixtures.ts` into `tests/fixtures/display-set/` (`tests/displaySetFixtures.test.ts`). The
  plugin in the core's registry, and display set through `registry.tools()` on the same pairs (`tests/plugin.test.ts`).
  The conformance kit over hand-written fixtures, one folder per area plus groups, set form and an SRX config whose
  security statements are `unsupported` (`tests/fixtures/conformance/`, `tests/conformance.test.ts`), and the kit's
  probes with two Junos adapters (`tests/probes.ts`, #56), each running every probe and case, none not applicable:
  one in set form, negation as `delete`, and one in the hierarchical form, where negation is the configuration with
  the setting left out (the form has no negation of its own). The corpus
  (`tests/corpus.test.ts`), read by path: chosen files per area against expected models in `tests/corpus/`, and every
  Junos file through the kit's checks against its own parse, secrets included; the one that isn't a configuration (a
  terminal capture that cuts a quoted hash) must give a syntax error that quotes nothing. `tests/mapping.test.ts`:
  both forms, `detect()`, nodes standing for several statements, member ranges, inactive statements, keys named like
  `Object.prototype`'s, secrets, SNMP communities and render from another platform's model.
  `tests/inheritance.test.ts`: the group and range inheritance rules, one per test, each citing Juniper's page.
  `tests/vlans.test.ts`: VLANs, switch ports and IRB beyond the fixtures (`tests/fixtures/conformance/vlans/`): the
  conflicts Junos refuses, what converts not at all, IRB units without a VLAN, render from another platform's model and
  names like `Object.prototype`'s. The corpus's expected models include an access, a trunk and an IRB file, and the
  probes give the VLAN name and the malformed VLAN ID cases.
  The tests have their own tsconfig with Node's types, so `src` stays platform-neutral.

## The command line (`packages/cli`)

- `src/cli.ts`: `run(argv, io, version)` parses the arguments, reads the input through `io`, and runs the command
  through the core's registry (`createRegistry([junos, iosxe, nxos, iosxr])`): `display-set` as the Junos plugin's tool, `convert`
  through the core's `convert()` with the plugins `--from` and `--to` name and the `--map` file's answers (`--write-map`
  writes every interface to a map file to fill in, through `io.writeFile`). It returns the
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
and how it opens a web link (`openLink`). Two parts are optional, for a shell that can do them: `saveTextTo` writes
again to a path an earlier save returned (the desktop app; a download can't be written to again), `exit` quits (File →
Exit, the desktop app only), and `guardClose(mayClose)` guards the window's own close (its ✕, Alt+F4, a browser tab's
close or reload): the UI's `mayClose` says no while a tab's output is unsaved, and shows the Exit dialog where the
shell can quit itself; the web build's guard is a `beforeunload` handler, so the browser asks. Open and save take what the file holds (`FileKind`: a config, or an interface
map), so the shells offer the right file types. The UI never touches files itself: even a dropped file is read by the shell,
from the drop event's data. Both shells take the version from the root `package.json` (a named JSON import, so only
that field is bundled).

The window is a menu bar, a tab strip and the current tab's page (juniper-decisions: UI shell), the same in both shells.

- `src/store.ts`: one zustand store of **tabs**, each a conversion or a Docs page, and which is shown; the theme
  choice, the notice, requests to reveal a place in a tab's editor, and the open dialogs (the new tab picker, closing a
  tab or exiting with unsaved output). A conversion tab holds its **job** (`{ kind: 'tool', tool: 'junos.display-set' }`
  or `{ kind: 'convert', target: 'iosxe' }`), its source and file name, its interface map, what the source gives with
  the job (the output, the linked lines as source/output pairs, the problems, and in convert the interface rows), the
  output as last saved (unsaved while the output differs) and where it was saved. Jobs come from the core's registry
  (`createRegistry([junos, iosxe, nxos, iosxr])`), as the CLI's do: `toolJobs()` lists every plugin's tools, and
  the picker's Convert row offers every source (`SOURCES`) and every target but the source (`targetsFor()`), so a new
  plugin or tool shows up unasked. A convert job names its `source` (Junos when left out, as before #50) and its
  `target`; a tab can change either. A tool runs generically (its problems from the result's diagnostics, its links
  from `sourceLines`); convert is the core's `convert()` from the source to the target (its problems from the ledger's diagnostics and `issues`, its links from `links` and the statements' spans,
  its rows from `interfaces`). Each runs synchronously on every change (config_22, 316 KB, parses in tens of
  milliseconds). The store's actions act on the tab shown. The interface map is kept while the source is edited and
  dropped when another file opens or the target changes, so no name carries over to other ports unasked.
- `src/session.ts`: what the next start gets back, in `localStorage` (`dialect.session`): each tab's job and file name,
  or its Docs page, and which was shown. **Never a config's contents**, the output or the interface names: configs
  hold secrets, and browser storage is plain text in the user's profile. A restored conversion tab has no source and
  offers to reopen its file (`reopen`). Nothing is kept in IndexedDB or sessionStorage; the web tests check all three.
- `src/commands.ts`: every command the menus and the shortcuts run, with its keybinding, in one registry (Hive's
  `commands.ts`): `createCommands(platform)` (Exit only with `platform.exit`), `matchKey()` for the window's keydown
  handler (after the editors, so CodeMirror keeps Undo, Redo and its search keys), and `keysOf()`, which puts a
  command's browser-safe keys (`webKeys`: Alt+T, Alt+W, Alt+1…9, Alt+PgDn) first in the web build, since a browser
  keeps Ctrl+T, Ctrl+W, Ctrl+Tab and Ctrl+1…9 for its own tabs.
- `src/actions.ts`: what the commands and buttons do with the shell: open, drop and paste into a tab (a new display set
  tab when a Docs tab shows), load an interface map, copy and save a tab's output (Save output writes to the earlier
  save's path where the shell can, Save output as always asks), Exit, and Edit's Undo and Redo on the tab's editor
  last focused (`editor/views.ts` keeps each tab's editors). The shell answers later, so each action takes the tab it
  started in and the store's `loadSource` and `mergeInterfaceMap` put the answer there, even if another tab is shown by
  then; if that tab has been closed, the answer goes nowhere and a notice says so (`tests/actions.test.ts`).
- `src/App.tsx`: the menu bar, the tab strip, every tab's page (a conversion's or a Docs page's, all mounted, the others
  hidden, so each tab's editors keep their text and undo history), the status bar for the tab shown and the dialogs. A
  file dropped anywhere opens, even on an editor: the drop is handled in the capture phase, so CodeMirror doesn't
  insert it, and `platform.openDropped()` reads it.
- `src/components/MenuBar.tsx`: File, Edit, View, Window (each open tab, the current one ticked) and Help, every item a
  command from the registry with its shortcut. WAI-ARIA's menubar pattern: `menubar`, `menu`, `menuitem` and
  `menuitemradio` (the theme, the tabs) with `aria-checked`; Alt or F10 moves to the bar and back, the arrow keys,
  Home and End move, Enter or Space runs, Esc closes a menu and then leaves the bar, handing the focus back to where it
  was: inside an editor's shadow root, the editor itself (the focus event's composed path, not its host). A menu stays
  inside the window and scrolls (the Window menu with many tabs).
- `src/components/TabStrip.tsx`: a `tablist` of the tabs (title, an unsaved dot, ×, the path on hover), "+" for a new
  tab, middle-click and Delete to close, the arrow keys, Home and End to move; it scrolls sideways in a narrow window
  and keeps the current tab in view. `Dialogs.tsx`: the new tab picker (from `jobs()`) and the questions before closing
  a tab or exiting with unsaved output. `ConversionView.tsx`: a conversion tab's page: its toolbar (the job, convert's
  target, Open, Paste, Copy output, Save output, and a Reopen bar for a restored tab), the source and output panes and
  the problems panel (and in convert, the interface table beside it). Moving the cursor in one pane marks the matching
  lines in the other, through the tab's links.
- `src/components/InterfaceTable.tsx`: convert's interface table: each interface with its name on the target, the
  suggestion as the input's placeholder and a Use button, Use suggestions, and Load map… / Save map in the CLI's map
  format (the core's `parseInterfaceMap()` and `formatInterfaceMap()`).
- `src/editor/`: the CodeMirror 6 editor component, and Junos colouring as a stream language (colouring only: the
  parser does the real work). The source editor has an issue gutter: a marker on each error or warning line, with what
  it says on hover.
- `src/help/` (B16, Hive's Docs view and About dialog): `docs.ts` bundles `docs/USER_GUIDE.md`, `CHANGELOG.md`,
  `LICENSE` and `THIRD_PARTY_NOTICES.md` with Vite's `?raw`; `Markdown.tsx` renders one with marked, cleans it with
  DOMPurify, gives headings GitHub's ids and keeps every link from navigating the page (another bundled document
  opens its tab, `#heading` scrolls, `https://` goes to `platform.openLink`); `DocsView.tsx` is a Docs tab's page, the
  list of pages beside it (each opens or shows that page's tab); `AboutDialog.tsx` shows the version, the build, the
  engine and the OS (`engine.ts`: `navigator.userAgentData` where it tells, else the user agent string); `state.ts`
  holds whether About is open. The Help menu and F1 are commands (`commands.ts`). `tests/help.test.ts` fails when a bundled document isn't the committed file, so
  with the license check the app's notices are always the current ones. The rendered HTML stays inside the CSP: no
  inline styles or scripts (DOMPurify drops scripts and handlers; marked writes none), so the web build's hash-only
  policy is unchanged. The notices are most of the web build's size: about 1.1 MB in all.
- `src/styles/help.css`: the Docs view, the Markdown pages, the About dialog and the tab dialogs, imported by
  `app.css`.
- `src/styles/app.css`: Hive's surface and text colours, and the violet accent from `branding/theme-tokens.css`, with
  the layout, the menu bar and the tab strip. Every control is visibly one: buttons, tabs, menus and inputs have an
  edge (`--border-control`, 3:1 at least on every surface, which `tests/contrast.test.ts` checks), the current tab
  has the accent on top and joins its page, and focus rings are the accent's (`--focus-ring`, `npm run contrast`).
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

`npm run build -w @dialect/web` writes one file, `apps/web/dist/dialect.html` (about 1.1 MB), that runs from `file://`
with no server and no network.

- `src/main.tsx` renders the UI with `src/webPlatform.ts`: a file picker, downloads (a `blob:` link), and the clipboard
  API with the copy command as its fallback.
- `vite.config.ts`: the React plugin, then `dialect-inline`, which inlines the script and the styles (the build makes
  one of each: no code splitting, no preload helper, assets as `data:` URLs) and fails on any other file, then
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
  dialogs, then `@tauri-apps/plugin-fs` to read or write that path; an opened file's path is the tab's tooltip, and a
  saved one's is where Save output writes again this session (`saveTextTo`, in the fs scope the dialog gave it).
  `exit` destroys the window through `@tauri-apps/api/window` (not `close()`, which would ask the guard again).
  `guardClose` is the window's `onCloseRequested`: with a listener, Tauri leaves the close to the page, which destroys
  the window unless the guard prevents it. A dropped file is read from the drop event, as in
  the web build: the window sets `dragDropEnabled: false`, so the page gets the HTML drop and the UI hands it to
  `openDropped`. The clipboard is WebView2's clipboard API. `openLink` (a Docs link) is `@tauri-apps/plugin-opener`'s
  `openUrl`, which starts the default browser.
- **Capabilities** (`src-tauri/capabilities/default.json`): `core:event:allow-listen` and `allow-unlisten` (the close
  guard's listener), `core:window:allow-destroy` (Exit, and a close the guard allows: the only window, so the app
  quits), `core:window:allow-close` (the close request itself, which the smoke test makes as the ✕ would),
  `dialog:allow-open`, `dialog:allow-save`,
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
  fixture and checks its display set, opens About and each Docs page in its tab, converts in a tab of its own and
  switches back through the Window menu, then checks that the CSP refuses an inline
  script, a remote image and a fetch (WebDriver's own scripts aren't subject to the CSP, so it checks what the page
  does), that the fs plugin refuses a file nobody picked and that the opener refuses anything but https, and last that
  the window's own close request with unsaved output shows the Exit dialog and stays open on Cancel, and that File →
  Exit (past the unsaved output question) ends the app's process. It talks WebDriver with fetch (`e2e/webdriver.ts`): every WebdriverIO package depends on
  `@promptbook/utils`, CC-BY-4.0, which the license rule doesn't allow even as build-only. It needs tauri-driver
  (`cargo install tauri-driver --locked --version ^2`) and the msedgedriver matching the installed WebView2 (from
  `https://msedgedriver.microsoft.com/<version>/edgedriver_win64.zip`), through `MSEDGEDRIVER` or `PATH`.
- **CI:** the `desktop` job in `.github/workflows/ci.yml` (`windows-latest`) does the same. It caches cargo's registry
  and `src-tauri/target`, and keeps tauri-driver and cargo-deny cached in `~/.cargo-tools`. It runs
  `cargo deny --locked check` in `src-tauri`, then reads the runner's WebView2 version from the registry
  (`HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`, `pv`), downloads
  that msedgedriver and sets `MSEDGEDRIVER`. Then it runs `npm run build` and the smoke test, and uploads the installer
  as the `dialect-installer` artifact (14 days, no release).

## Branding

`branding/` holds the SVG icon masters, the rendered icons in `branding/out/` and the theme tokens
(`theme-tokens.css`). `npm run icons` (`scripts/build-icons.mjs`, with sharp and png-to-ico, build-only) renders the
icons; `npm run contrast` (`scripts/check-contrast.mjs`) checks the tokens against WCAG AA.
