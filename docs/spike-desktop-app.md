# Spike: desktop app for Junos config tools

Card #1. Research only; no product code. Checked on 2026-10-14. Throwaway code
backing the claims below is under `spike/` (see `spike/README.md`).

**Revised for card #4 (2026-10-14)** to match the user's decisions in
[Recorded decisions](#recorded-decisions): TypeScript + Tauri 2 instead of
Python + PySide6, the whole project MIT, netcanon for ideas only. The product's
working name is **Dialect**. The original stack comparison is kept as history
in [Original comparison (superseded)](#original-comparison-superseded).

## Summary

- **Stack:** **TypeScript (strict) + Tauri 2**, in an npm-workspaces monorepo:
  a UI-free `core` package, one package per platform plugin, a `cli` package,
  a shared `ui` package, and two shells around it: the Tauri desktop app and
  an offline single-file browser build. Details:
  [Desktop app stack](#desktop-app-stack).
- **Conventions from Hive** (the user's own MIT TypeScript app): its
  TypeScript settings, oxlint, Vitest, Windows CI, generated third-party
  notices (with a license check over all dependencies), line-endings test,
  icon pipeline (sharp, allowed as build-only), agent docs, and an About dialog
  and in-app Docs view. See
  [Conventions adopted from Hive](#conventions-adopted-from-hive).
- **Licensing:** the whole project is MIT. Every library this report mentions
  is checked in [License check](#license-check).
- **Tool 1 (display set):** write our own small parser in TypeScript. Don't wrap or
  port the prior art. The prior art the card points at
  ([saidvandeklundert/juniper-config-converter](https://github.com/saidvandeklundert/juniper-config-converter))
  is a **Rust** crate, not Python scripts. It has no syntax tree and several
  real bugs: a panic, a hang, corrupted `deactivate` lines and silently dropped
  characters. A 350-line stdlib Python prototype (`spike/display_set/junos_set.py`)
  produces the same lines as all 22 of its test fixtures (4,952 output lines)
  and fixes those bugs. It follows Juniper's documented `deactivate` ordering,
  which jcc gets wrong for stanzas. The prototype is the **reference for the
  TypeScript port**, not code to keep: its self-test cases and the fixture
  comparison carry over as the port's tests. Size: **S**.
  The best alternative found, [junoscfg](https://github.com/dg-i/junoscfg)
  (Python, MIT), is schema-driven and does the **reverse** (set → hierarchical)
  properly. But on our tests it matched only 18 of 22 of jcc's fixtures, with
  silent errors in some of them. It isn't a dependency we can take from
  TypeScript; its schema-driven approach is the one to learn from for the
  reverse direction.
- **Tool 2 (Junos ⇄ Cisco):** the user is broadly right. No mature tool does
  offline Junos ⇄ Cisco translation:
  - Batfish parses many vendors but never writes config.
  - Ansible's `parsed`/`rendered` resource modules use a different data shape
    for each vendor and are GPL-3.0.
  - Vendor migration tools are discontinued or not public.

  The one exception is new: [netcanon](https://github.com/netcanon/netcanon)
  (MIT, Python, started May 2026). It translates the basics (interfaces, VLANs,
  static routes, VRFs, SNMP) but deliberately **doesn't render** routing
  protocols, ACLs/firewall filters or route policy. **Decided:** netcanon is
  for ideas only; we write our own converter and don't depend on it, fork it
  or wrap it. Our design: a
  **hub model**, where each platform plugin parses into a shared,
  OpenConfig-shaped model and renders from it. The core, not the plugin,
  checks that every source *statement* and every populated model *field* got
  an explicit disposition (mapped, rendered or unsupported), so nothing is
  dropped silently. That's accounting, not a proof that the output behaves
  the same.
- **Sizes for the MVP feature set, per plugin:** Junos (the hub side) **M–L**,
  IOS/IOS-XE **M**, NX-OS **M**, IOS-XR **M–L** (its route-policy language is
  the hard part).
- **Plugins:** each platform is its own TypeScript workspace package. At first
  they are built in, through a static registry that the CLI, the desktop app
  and the web build import. Loading plugins at runtime comes later, and
  third-party drop-in plugins stay out of v1.
- **First MVP:** one direction, Junos → IOS-XE, covering
  system/interfaces/static routes/NTP/syslog/SNMP, then OSPF and BGP basics,
  then ACLs and policy. Which direction and which Cisco platform come first is
  the user's call ([open questions](#open-questions-for-the-user)).

---

## Tool 1: Junos hierarchical → `display set`

### Prior art: saidvandeklundert/juniper-config-converter ("jcc")

I checked these facts against the repository, crates.io and the GitHub API on
2026-10-14:

| | |
|---|---|
| Language | **Rust**: a library crate `jcc` and a `jcc-cli` crate. Its git history has never contained a Python file. The card's "all Python scripts" doesn't match this repo. |
| Size | About 590 lines of source, in [`lexer.rs`](https://github.com/saidvandeklundert/juniper-config-converter/blob/main/crates/jcc/src/lexer.rs), [`configwriter.rs`](https://github.com/saidvandeklundert/juniper-config-converter/blob/main/crates/jcc/src/configwriter.rs) and `utils.rs` |
| License | MIT |
| Activity | 31 commits, from 2023-08-27 to 2023-09-02. Nothing since. 13 stars, no issues ever filed. README says "Currently in Beta". |
| Published | [crates.io `jcc`](https://crates.io/crates/jcc): latest 0.1.7 (2023-09-02). The repo's manifests say 0.2.1, which was never published, so `jcc-cli` in the repo depends on a version that doesn't exist on crates.io. |
| Direction | Hierarchical → set only. No reverse. |
| Tests | 22 fixture pairs (`tests/data/config_N.txt` → `config_N_set.txt`), several of them real router configs (one is 3,472 set lines). They pass on an LF checkout. On a default Windows git checkout (`core.autocrlf=true`) the fixture test fails, because CRLF expected files don't match LF output. |

**How it works.** A hand-written lexer splits input into words, braces,
brackets, `;` and `#`. A single pass then keeps a stack of the words seen at
each brace depth and prints `set <stack> <words>` whenever a word ends in `;`.
It never builds a tree. `inactive:`/`protect:` work by remembering a flag and
running `.replace("set", "deactivate")` on the finished line. `replace:` is
skipped. A `#` skips to the end of the line.

**What I tested.** I built jcc locally (Rust 1.98) and ran it on edge cases
(inputs in the scratchpad; the results are reproduced here):

| Case | jcc result | Severity |
|---|---|---|
| `inactive:` on a leaf | `set …` then `deactivate …`, as Junos does | ok |
| **`inactive:`/`protect:` on a stanza** | `deactivate interfaces ge-0/0/0` is printed **before** the `set` lines that create the stanza. Juniper's documented `display set` example ([View the Configuration](https://www.juniper.net/documentation/us/en/software/junos/cli/topics/topic-map/junos-configuartion-viewing.html), "Example: Display set Commands from the Configuration") prints the unit's `set` lines first and `deactivate … unit 1` after. Juniper also notes that `deactivate` can't be added to an empty hierarchy ([Modify the Configuration](https://www.juniper.net/documentation/us/en/software/junos/cli/topics/topic-map/modifying-configuration.html)), so pasting jcc's output into an empty config would fail on that line. jcc's own fixtures (8, 15, 16) encode this wrong order, so passing them doesn't prove fidelity to display set. See [Ordering of `deactivate` lines](#ordering-of-deactivate-lines) | **high** |
| `protect:`, `replace:` | `protect …` emitted; `replace:` dropped. Both are correct for display set | ok |
| `[ a b c ]` lists | One `set` line per element, as Junos does | ok |
| `apply-groups`, `groups { <*> … }` | Emitted as plain statements. That is right for display set, which doesn't expand groups | ok |
| Quoted strings with `;`, `{`, escaped `\"` | Correct output, though partly by luck: tokens are re-joined with single spaces | ok |
| `## SECRET-DATA`, `## Last commit` | Skipped as comments | ok |
| CRLF line endings, tabs | Works: unknown characters are ignored | ok |
| **`inactive:` on a name containing "set"**: `inactive: term block-reset { then { inactive: reject tcp-reset; } }` | `deactivate firewall filter F term block-redeactivate` and `… then reject tcp-redeactivate`, because `.replace("set", …)` rewrites every occurrence of `set` in the line. This produces wrong, unloadable output | **high** |
| **Annotations** `/* comment */` before a statement | Leak into the path: `set system /* management box */ host-name r1` | **high** |
| **Last line without a trailing newline** (`version 21.4R3;` at EOF) | Panics: `index out of bounds` in `lexer.rs:84` | **high** |
| **Unterminated quote** | Infinite loop (killed by a 5 s timeout) | **high** |
| **Words starting with `_`, `@`, `=`** (e.g. `host-name _r1`) | First character silently dropped: `set system host-name r1`. Only a `warn!` log line | **high**: silent data change |
| `deleted:` | Treated as a word: `set protocols deleted: ospf …`. Junos prints this tag only in `show | compare`-style output, so it's low priority | low |
| Error reporting | None. Bad input gives wrong output or a crash, never a message with a line number | medium |

**Why it falls short for us.** Beyond the bugs, it has no syntax tree, so it
can't feed the Junos ⇄ Cisco converter, map output lines back to source lines,
or do the reverse direction. Its language is Rust, so using it from our
TypeScript core means a WASM build or a subprocess (and a subprocess isn't
possible in the offline browser build), for about 600 lines of logic that are
simpler to rewrite.

### Other Junos converters

The repos were checked on GitHub and PyPI. I ran junoscfg myself in a scratch
venv; the rest were not run.

| Project | Lang / license | Activity | Notes |
|---|---|---|---|
| [dg-i/junoscfg](https://github.com/dg-i/junoscfg) | Python, MIT | PyPI 0.5.10 (2026-06-18); created 2026-03; 0 stars, one maintainer | **Tested; see below.** Schema-driven: it generates a Lark grammar and validators from Juniper's `netconf.xsd`. Converts JSON/YAML/XML/structured/set both ways, validates, anonymises. "Inspired by Junoser" |
| [codeout/junoser](https://github.com/codeout/junoser) | Ruby, MIT | gem 0.7.6 (2026-09-30), 75 stars, since 2015 | PEG parser generated from Juniper's XSD. Validates both forms; set → structured marked "experimental". Ruby, so not reusable directly |
| [ckishimo/juniper_display_set](https://github.com/ckishimo/juniper_display_set) | Python, Apache-2.0 | last push 2023-06, 42 stars | single brace → set script |
| [as2518/junos_config_converter](https://github.com/as2518/junos_config_converter), [mkomon/junos_to_set](https://github.com/mkomon/junos_to_set), [khornem/jnp-dset-converter](https://github.com/khornem/jnp-dset-converter), [aledwmorris/juniper-display-set](https://github.com/aledwmorris/juniper-display-set) | Python / Awk, mixed or no license | 2015–2020, inactive | small scripts |
| Batfish `JuniperFlattener` | Java, Apache-2.0 | active | internal to Batfish, see below |

**junoscfg results** (0.5.10, Python 3.14; scripts and inputs in the
scratchpad, results quoted here):

- **Gets right everything that broke jcc:** `_r1`, `tcp-reset` names,
  annotations, the missing trailing newline. Schema-aware validation warns on
  bad values (e.g. `host-name @r1`).
- **Matches only 18/22 of jcc's fixtures.** Real errors, all silent (no
  exception):
  - `config_13`: a one-line block `generate-event { ztp-registration
    time-interval 30; }` makes it **drop the whole `generate-event` line and
    the `event-options` prefix** of the next line. It also **strips the quotes**
    from a command string with spaces. The output would load differently.
  - `config_22`: `as-path { path "…"; }` under a static route renders without
    the `path` keyword.
  - The other two: it puts `deactivate` **before** the `set` lines for leaves
    and stanzas alike. That's the opposite of Juniper's documented order and
    fails when loaded into an empty hierarchy (see
    [Ordering of `deactivate` lines](#ordering-of-deactivate-lines)). It also
    quotes `/* SECRET-DATA */` (cosmetic).
- **Other inputs:**
  - Escaped quotes lose their backslashes (`"say \"hi\""` → `"say "hi""`).
  - An unterminated quote produces output plus a warning, not an error.
  - A second `inactive:` stanza in one file lost its `deactivate` line (case
    `13_set_substring`).
- **Windows:** `junoscfg --help` crashes with `UnicodeEncodeError` on a default
  Windows console. Its help text contains `→`, and the cp1252 console can't
  encode it. It works with `PYTHONUTF8=1`.
- **Reverse works properly.** Given set lines with `unit 0`, a two-value
  `vlan-id-list` and a `deactivate`, it produced correct hierarchical config
  (`unit 0 { … }`, `vlan-id-list [ 10 20 ];`, `inactive: description x;`).
  That's the schema at work.

Verdict: not reliable enough for the forward direction, where we need exact,
lossless output. Worth adopting or learning from for the reverse direction
(below), and as a source of a ready-made Junos schema.

### Better reference: Batfish's Junos flattener

[Batfish](https://github.com/batfish/batfish) (Apache-2.0, actively developed)
does the same job as a first step before its own analysis. It uses a small
generic ANTLR grammar for the curly-brace syntax,
[`JuniperParser.g4`](https://github.com/batfish/batfish/blob/master/projects/batfish/src/main/antlr4/org/batfish/grammar/juniper/JuniperParser.g4),
and a listener,
[`JuniperFlattener.java`](https://github.com/batfish/batfish/blob/master/projects/batfish/src/main/java/org/batfish/grammar/juniper/JuniperFlattener.java)
(about 250 lines). From the source:

- It handles the tags `active`, `inactive`, `delete`, `protect` and `replace`,
  bracketed lists (one line per word) and empty braced clauses (`set <path>`).
- It keeps a **line map** from each flat word back to its original line and
  column. We want the same thing for the GUI's source↔output highlighting and
  for warnings.
- It emits tag commands as it enters a statement, so `deactivate X` comes
  *before* `set X…`, even for leaves. Juniper's documented order is the
  opposite (see [Ordering of `deactivate` lines](#ordering-of-deactivate-lines)),
  so don't copy this part. That's harmless for Batfish's own flat parser, but
  wrong for output a user will paste into a device.

Its design (generic syntax tree first, then flatten) is the one to copy. The
license allows porting with attribution.

### Recommendation: write our own (tree-based) parser

| Option | Verdict |
|---|---|
| Wrap jcc (WASM or a subprocess) | No. It's Rust, buggy, abandoned, and has no tree to reuse. |
| Port jcc's logic | No. Its streaming design is what causes the bugs. |
| Use junoscfg for the forward direction | No. Silent errors on 4/22 real fixtures (above), a young single-maintainer project, and it's Python, so a TypeScript app could only run it as a sidecar. |
| **Write our own in TypeScript: tokenizer → generic tree → flatteners** | **Yes.** It's small, it gives one tree for display-set, the reverse and the Junos plugin's model mapping, and we control the error messages. Borrow Batfish's design and jcc's MIT fixtures as test data. |

The throwaway Python prototype `spike/display_set/junos_set.py` (stdlib only)
shows the size of the job. It is the **reference for the TypeScript port**, not
code to keep: port its tokenizer, tree and flattener into the Junos plugin, and
carry its 12 self-test cases and the jcc fixture comparison over as Vitest
tests. Then delete `spike/`.

- **Tokenizer:** quoted strings with escapes; `/* annotations */`, including the
  `/* SECRET-DATA */` placeholder Junos prints where a secret value would be;
  `#` comments; CRLF and tabs.
- **Tree:** `Node(words, children | None, values for [ ] lists, inactive/protect/replace, annotation, line)`.
- **Flattener:** follows Juniper's documented ordering. A statement's
  `deactivate`/`protect` comes after the `set` lines of its whole subtree.
- **Errors:** `ParseError` with a line and column for unterminated quotes or
  annotations, missing or stray braces, and a missing `]`/`;`. Unknown `word:`
  tags and dropped annotations come back as warnings.
- **Results:**
  - `python -I junos_set.py --selftest` passes 12/12 cases. They include every
    jcc failure above, plus Juniper's documented inactive-unit example.
  - `--compare <jcc tests/data>`: **19/22** fixtures match exactly, including
    the 3,472-line real config. The other **3** (config_8, 15, 16) contain
    exactly the same lines, but our stanza `deactivate`/`protect` lines come
    after the subtree where jcc's come before it. The fixtures are wrong there,
    not the prototype; the production test suite should correct those three
    expected files.

<a id="ordering-of-deactivate-lines"></a>**Ordering of `deactivate` lines.**
The target is Juniper's documented `display set` order: a statement's
`deactivate` (and `protect`) comes **after** the `set` lines of its subtree.
For a leaf that means right after its own `set`. Juniper's example:

```
set interfaces xe-0/0/0 unit 1 family inet address 10.0.0.1/8
deactivate interfaces xe-0/0/0 unit 1
```

The order matters when output is pasted to recreate config: Juniper notes
`deactivate` can't be added to an empty hierarchy. jcc (for stanzas), Batfish
and junoscfg (always) put it first. The prototype follows the documented
order.

<a id="parser-approach"></a>**Parser approach: hand-written, no parser
library.** A grammar library isn't needed for the curly-brace syntax: the
prototype's hand-written tokenizer is about 60 lines, and a recursive-descent
tree builder on top of it gives exact error positions and messages we control.
The Cisco side is the same: an indentation tree plus explicit recognisers for
delimited bodies (see [the hub model](#approach-a-hub-model-not-pairwise-translators)).
So the parsers add no runtime dependency.
If a grammar library becomes worth it later (most likely for XR RPL's
expression language), these were checked on npm on 2026-10-14:
- [Peggy](https://www.npmjs.com/package/peggy) 5.1.0: **MIT, OK**. A PEG parser
  generator. The first choice if we need one.
- [Ohm](https://www.npmjs.com/package/ohm-js) 17.5.0: **MIT, OK**.
- [Chevrotain](https://www.npmjs.com/package/chevrotain) 13.2.0: **Apache-2.0,
  OK** with attribution, plus its NOTICE file if it ships one.

junoscfg generates a Lark grammar (Python, MIT) from the Junos schema; that's
an idea to borrow for the reverse, not a library we can use. There is no
tree-sitter grammar for Junos.

### The reverse (set → hierarchical)

This is a different-sized job. A `set` line doesn't say which words are
keywords, which are names, and which leaves take `[ ]` lists. Without that, the
prototype's heuristic `--reverse` produces:

```
interfaces ge-0/0/0 unit 0 {          <- can't tell that "unit 0" is one node
    family inet address 10.0.0.1/24;
    description x;
}
vlans v10 vlan-id-list {              <- should be: vlan-id-list [ 10 20 ];
    10;
    20;
}
```

A faithful reverse needs the Junos schema. There are two sources:
- Juniper publishes YANG models per release at
  [Juniper/yang](https://github.com/Juniper/yang) (Apache-2.0, releases up to
  25.4, updated 2026-02-25).
- A device can dump its own `netconf.xsd`, which is what junoser and junoscfg
  build from.

junoscfg's reverse already worked correctly in my test (above), which shows
the schema-driven approach works. But junoscfg is Python, so the TypeScript app
can't take it as a dependency (and a Python sidecar wouldn't run in the offline
browser build). The option now is:
- build our own schema loader in TypeScript, from Juniper/yang (Apache-2.0:
  attribute it, and keep its NOTICE text if it has any, in
  `THIRD_PARTY_NOTICES.md` when a schema derived from it ships): **M**. junoscfg
  (MIT) can still serve as a test oracle, run outside the app, to compare
  outputs.

The cheap version, folding chains as above, isn't good enough to ship.

### Tool 1 MVP scope

1. Hierarchical → set, using the tree parser. Paste or open a file, copy or
   save the output, see errors with line numbers, list annotations that were
   dropped. **S**.
2. Options: show `deactivate`/`protect` lines or not; strip `SECRET-DATA`
   lines. **S**.
3. (Later, if wanted) set → hierarchical, schema-driven: our own TypeScript
   schema loader, built from Juniper/yang or the device XSD (**M**).

---

## Tool 2: Junos ⇄ Cisco converter

### What exists, and why it isn't enough

Checked 2026-10-14 against each project's repo, PyPI or docs. Statuses
(archived, license, last push) come from the GitHub API that day. **UNVERIFIED**
marks what I couldn't confirm from a primary source.

| Tool | What it is | License / status | Why it isn't enough |
|---|---|---|---|
| [**netcanon**](https://github.com/netcanon/netcanon) | "Multi-vendor network config translator". Python, with a shared canonical model; every field is labelled supported, lossy or unsupported. Codecs include IOS-XE CLI, NX-OS, IOS-XR and Junos (set form; hierarchical input is converted to set form first, per [CAPABILITIES.md](https://github.com/netcanon/netcanon/blob/HEAD/docs/CAPABILITIES.md)). FastAPI web UI plus a Windows PySide6 shell | MIT; created 2026-05-13, PyPI 0.7.7 (2026-10-08), 11 stars. **Ideas only (decided):** no dependency, fork or wrapper | **The closest thing to Tool 2, and new.** By design its "Tier 3" (firewall rules/ACLs, route-maps/policy, **dynamic routing protocols**, QoS, NAT) is detected and listed but **never rendered**. Its README also says that where a codec doesn't handle a field, "the source-side value is currently dropped without a banner". So it covers our phase 1 but not phases 2–3, which are the valuable part. **Not run hands-on:** `pip install` failed on Windows path length in my scratch folder, so this is from its docs only |
| [**Batfish**](https://github.com/batfish/batfish) / pybatfish | Java analysis engine. It parses Junos (MX/EX/QFX/SRX…), IOS, IOS-XE, NX-OS, IOS-XR, ASA, Arista and more into a vendor-independent model, then answers reachability and policy questions | Apache-2.0, very active (1.5k stars) | **Parse-only**: there's no config writer, and the model keeps derived semantics rather than the syntax needed to re-render. Good reference for our model (routing policy, ACL semantics) and for the Junos flattener |
| [**Ansible network resource modules**](https://github.com/ansible-collections/cisco.ios) (`state: parsed` / `state: rendered`) | Offline parse → structured data → render, per resource (interfaces, l3_interfaces, vlans, static_routes, ospfv2, bgp_global, acls, prefix_lists, ntp_global, snmp_server, logging_global, …), for Junos, IOS, NX-OS and IOS-XR | **GPL-3.0**. cisco.ios/nxos/iosxr active. The `junipernetworks.junos` repo is **archived**; the code now lives in [Juniper/ansible-junos-stdlib](https://github.com/Juniper/ansible-junos-stdlib) (`ansible_collections/juniper/device`, still GPL-3.0 per the module headers) | **The data shapes are per vendor, not shared** (e.g. Junos static routes use `next_hop[].forward_router_address`, IOS uses `next_hops[]`), so every resource needs mapping glue. The **Junos side takes and emits XML** (`parsed` expects `<rpc-reply><configuration>…`; `rendered` emits `<nc:routing-options …>`), not set or brace text. There's no users/AAA resource. **GPL-3.0: can't ship or be copied in.** At most a build/test-only oracle, listed as build-only, never a runtime dependency |
| [**ciscoconfparse2**](https://github.com/mpenning/ciscoconfparse2) (and the archived [ciscoconfparse](https://github.com/mpenning/ciscoconfparse)) | Parses indented configs into parent/child line objects for querying. Its Junos support strips braces and re-indents "as IOS would" | **GPL-3.0**; ciscoconfparse archived (last release 2024-11); ciscoconfparse2 0.9.18 | A text-tree query tool with no model and no translation. **GPL-3.0: can't ship or be copied in** |
| [**NAPALM**](https://github.com/napalm-automation/napalm) | Uniform API to *live* devices: getters, config merge/replace/compare/rollback | Apache-2.0, active | No translation: candidate config must already be in the device's own syntax ([support matrix](https://napalm.readthedocs.io/en/latest/support/)) |
| [**napalm-yang**](https://github.com/napalm-automation/napalm-yang) / [yangify](https://github.com/networktocode/yangify) | Native config ⇄ OpenConfig mapping | napalm-yang **archived** (last push 2019-05, README says abandoned); yangify dormant since 2021-09 | The closest past attempt at native → model → native. Dead, with tiny coverage and no IOS-XR |
| [**OpenConfig**](https://github.com/openconfig/public) + gNMI | Vendor-neutral YANG models served by devices | Apache-2.0, active. Every vendor publishes deviations: Juniper in [Juniper/yang](https://github.com/Juniper/yang), Cisco in [YangModels/yang](https://github.com/YangModels/yang/tree/main/vendor/cisco) | A device API, not an offline text translator; coverage is partial per vendor. **The best shape to borrow for our model** |
| [**Capirca**](https://github.com/google/capirca) / [**Aerleon**](https://github.com/aerleon/aerleon) | Generate ACLs/filters for Juniper, Cisco (IOS, NX-OS, XR, ASA) and many more from a neutral policy language | Apache-2.0, active | **Generate only**: there's no importer for existing device configs, and they cover ACLs only. Their ACL term model is a good reference for our filter ⇄ ACL mapping |
| [TTP](https://github.com/dmulyalin/ttp), [Genie parsers](https://github.com/CiscoTestAutomation/genieparser), [ntc-templates](https://github.com/networktocode/ntc-templates) | Text parsers, almost entirely for `show` *output*. Genie's Junos config parsing is a handful of narrow commands, and its config builders have no Junos | MIT / Apache-2.0 / Apache-2.0 | Operational output, not configs. There's no shared model and nothing renders Junos |
| **Vendor migration tools** | Juniper **I2J** (IOS → Junos) | `i2j.juniper.net` no longer resolves (checked today). Community posts say it was decommissioned (date **UNVERIFIED**) | Gone |
| | Cisco **Nexus Migration Tool** (IOS → NX-OS, 2012-era) | URL dead; a forum post says it was taken down (**UNVERIFIED**) | Gone, and it covered only old Catalyst → Nexus |
| | Cisco IOS → IOS-XR "SoX" | TAC-internal per forum posts (**UNVERIFIED**) | Not public |
| | Cisco Secure Firewall Migration Tool, FortiConverter, Palo Alto Expedition (EoL 2024-12-31) | | Firewall-only and tied to their own target; Juniper isn't a listed source for Cisco's tool |
| **Small GitHub scripts** | e.g. SRX → ASA, ASA → SRX converters, [Junos filters → XR hybrid ACLs](https://github.com/nimaster/JUNOS_TO_CISCO_HYBRID_ACL_CONVERSION) | Mostly dead (2018–2023), several with no license | Firewall-only, partial, one direction |
| **LLMs** | Widely used informally | | They can silently drop or change meaning (ACL order and implicit deny, defaults, interface names) and give no field-level guarantees. A possible later *assistant* for leftovers, not the engine |

**So:** the user's "nothing reliable out there" holds for routing protocols,
policy and filters. netcanon now covers the simple L1–L3 basics. As decided, we
use it for ideas only and write our own; at most it's an optional benchmark
for the phase 1 areas. Batfish, OpenConfig and Aerleon are the design
references. The GPL-3.0 ones (ciscoconfparse2, the Ansible resource modules)
can't ship or be copied into this MIT project; at most they'd be build/test-only
tools. Every library's verdict is in
[License check](#license-check).

### Approach: a hub model, not pairwise translators

```
 source text ──► [platform plugin: parse] ──► vendor syntax tree ──► [plugin: map] ──► SHARED MODEL
                                                                                         │
 target text ◄── [platform plugin: render] ◄─────────────────────────────────────────────┘
                     │
 core: coverage ledger = every syntax statement's disposition + every populated model field's disposition
       + semantic warnings + needs-input items
```

- **Two stages per plugin.** The first stage is a lossless *vendor syntax
  tree* in which every **statement** is a node with an id:
  - **Junos:** the Tool 1 tree (each `;`-terminated leaf, each list value and
    each braced container is a statement).
  - **Cisco:** mostly an indentation tree (IOS, NX-OS and XR ordinary config
    nests by leading spaces, with `!` as a separator). But some bodies are
    **delimited, not indented**, and the parser has to recognise them
    explicitly:
    - **XR RPL** (`route-policy … end-policy`, `prefix-set`/`community-set`/
      `as-path-set … end-set`, with `if … endif` inside). A policy body can be
      unindented, so an indentation tree would detach `pass` from
      `route-policy P` / `pass` / `end-policy`. Sources: Cisco's
      [XR routing policy guide](https://www.cisco.com/c/en/us/td/docs/routers/xr12000/software/xr12k_r4-3/routing/configuration/guide/b_routing_cg43xxr12k/b_routing_cg43xxr12k_chapter_01001.html),
      cited by the reviewer (Cisco's site blocks scripted fetches, so I
      couldn't re-read it), and netcanon's
      [CAPABILITIES.md](https://github.com/netcanon/netcanon/blob/HEAD/docs/CAPABILITIES.md),
      which describes the same `… end-policy` / `… end-set` form.
    - **IOS banners**, delimited by a chosen character, e.g.
      `banner motd ^C … ^C`.
    - **Certificate chains**, ending with `quit`.

    Each delimited body is captured as one **atomic statement**, kept verbatim,
    until a dedicated sub-parser exists. It is then reported as a whole
    (*unsupported: RPL policy P, 14 lines*), never split or partly dropped.

  The second stage is a *mapping* from that tree into the shared model.
  Line spans are kept for **display only** (highlighting, jump-to-line), in
  the style of Batfish's line map. They are not used for accounting.
- **The shared model is shaped like OpenConfig**: `system`, `interfaces`
  (with subinterfaces and addresses), `vlans`, `network-instances` (VRFs,
  static routes, OSPF, BGP), `routing-policy` (prefix-sets, policy
  definitions), `acl` and `system/ntp|logging|aaa`. Borrow the structure and
  naming from the [OpenConfig models](https://github.com/openconfig/public)
  (Apache-2.0: we borrow structure and names, not code) and implement them as
  plain TypeScript types (readonly interfaces) serialised as JSON. YANG tooling
  isn't worth it for an offline converter.
- **No silent drops, enforced by the core through a coverage ledger.** It
  works at the level of individual statements and model fields, not lines or
  objects. Line or object granularity hides data: one Junos line can hold
  several statements, and a block's span hides its unknown children.
  1. *Source side, per statement:* the core walks the syntax tree. Every
     statement node must get a **disposition** from the mapper: `mapped` (with
     the model field paths it filled), `ignored-by-design` (with a reason, e.g.
     a `version` line) or `unsupported`. A node with no disposition is reported
     as unmapped by the core, so a plugin can't hide what it forgot.
     Dispositions are recorded per node, not inherited, so mapping
     `interfaces ge-0/0/0` doesn't cover an unknown child inside it.
  2. *Model side, per populated leaf field:* the core walks the model after
     parsing. Every **populated leaf field** (e.g.
     `bgp.neighbors["10.0.0.2"].multihop.ttl`), not every object, must get a
     disposition from the renderer: `rendered`, `unsupported` or
     `not-applicable` (with a reason). Fields with no disposition are reported
     as unrendered ("BGP neighbor 10.0.0.2: `multihop` not handled by the IOS-XR
     renderer"). This also catches fields added in a later minor model version,
     which an older renderer has never heard of.
  3. *Semantic warnings*: translated, but behaviour may differ. For example,
     an implicit deny is now explicit, eBGP needs a route-policy on XR, or an
     interface name was mapped by the user.
  4. *Needs input*: things the tool can't know, such as the interface name
     mapping (`ge-0/0/1` ↔ `GigabitEthernet0/0/1`) or password hashes that
     won't carry over. The user supplies these through a mapping table in the
     UI.

The ledger is **accounting, not proof of equivalence**. It proves that
every input statement and every populated model field was deliberately dealt
with. It doesn't prove the rendered config behaves the same. That still rests
on the mapping code, the semantic warnings and fixtures reviewed against real
devices.

How hard is it? Parsing and rendering the simple areas (system, interfaces,
static routes, NTP/syslog/SNMP) is routine. The hard part is **semantics**:
defaults that differ (implicit discard in firewall filters vs implicit deny in
ACLs, default BGP import/export behaviour, OSPF interface vs `network`
statements, `apply-groups` inheritance that must be expanded before mapping),
and policy languages that don't map one-to-one (route-maps vs
policy-statements vs XR RPL). Expect most of the effort to go into fixtures
and warnings, not parsers.

### Per-platform estimates

Sizes are for the MVP feature areas below, parse and render both, one
experienced developer, including fixtures. **S** ≈ 1–2 weeks, **M** ≈ 3–6 weeks,
**L** ≈ 2–3 months. These are judgement, not measurement.

**Junos (the hub side, needed for everything): M–L.**
- It reuses the Tool 1 tree.
- Mapping needs `apply-groups` expansion, including wildcard `<*>` groups and
  `apply-groups-except`, before semantic mapping.
- It needs `interface-range`, units/families, routing-instances and
  policy-statements, plus firewall filters per family.
- Switching syntax differs between ELS (EX/QFX: `vlans` + `family
  ethernet-switching interface-mode`) and older non-ELS configs. Pick ELS only.

**IOS / IOS-XE (treated as one): M.**
- *Carry over directly:* hostname/domain, interface description/shutdown, IPv4
  addresses (dotted mask ↔ prefix length), IPv6 addresses, static routes, NTP
  servers, syslog hosts, SNMP communities and locations, VLAN ids and names.
- *Real translation:*
  - Subinterfaces: `Gi0/1.10` + `encapsulation dot1Q 10` ↔ `unit 10 vlan-id 10` + `vlan-tagging`.
  - L2 ports: `switchport mode access/trunk` ↔ `family ethernet-switching interface-mode`.
  - OSPF: `router ospf` + `network … area` with wildcard masks, or per-interface `ip ospf`, ↔ `protocols ospf area X interface Y`.
  - BGP: neighbor-centric with `address-family` blocks and peer-groups/templates ↔ Junos groups.
  - Route-maps + prefix-lists ↔ policy-statements + prefix-lists/route-filters.
  - Numbered/named standard/extended ACLs with wildcard masks and implicit deny ↔ firewall filter terms and implicit discard.
  - VRFs: `vrf definition` (or legacy `ip vrf`) + RD/RT ↔ `routing-instances … instance-type vrf`.
  - AAA: `aaa new-model`/`tacacs server` ↔ `system authentication-order`/`tacplus-server`.
- *Main syntax differences:*
  - Indented blocks with `!` separators vs braces.
  - `no` prefixes for negation and many defaults.
  - Interface names such as `GigabitEthernet0/0/1` (no automatic mapping).
  - IOS-XE vs classic IOS differences, small for the MVP areas.

**NX-OS: M.**
- *Carry over directly:* the same simple areas as IOS. ACLs use prefix
  notation and sequence numbers, which is closer to Junos than IOS wildcards.
- *Real translation:*
  - Every protocol needs `feature ospf|bgp|interface-vlan|…` lines when
    rendering.
  - OSPF is enabled per interface (`ip router ospf 1 area 0`).
  - BGP is hierarchical (`neighbor X` → `remote-as` → `address-family`), which
    maps onto Junos groups reasonably well.
  - VRFs are `vrf context X`, with `vrf member` on interfaces.
  - `mgmt0` lives in the `management` VRF.
- *Main syntax differences:*
  - `Ethernet1/1` naming.
  - Whether a port defaults to L2 or L3 depends on platform and system default,
    so the renderer must emit `switchport`/`no switchport` explicitly.
  - Route-maps and prefix-lists are IOS-like.

**IOS-XR: M–L.**
- *Carry over directly:*
  - Interfaces use `ipv4 address` / `ipv6 address`.
  - Static routes live under `router static` → `address-family`.
  - NTP and syslog.
  - XR's structure (commit model, nested blocks) is the closest of the Cisco
    platforms to Junos.
- *Real translation:*
  - **RPL** (`route-policy` with `if/then/else`, `prefix-set`,
    `community-set`, `as-path-set`) ↔ policy-statements. The simple cases
    (match a prefix-set, set local-pref/community, pass/drop) map cleanly.
    General RPL (nested conditions, parameterised policies) does not, and is
    the main cost.
  - eBGP neighbors need explicit route policies on XR (RFC 8212 behaviour, so
    no routes are exchanged without one). The renderer must create or attach
    policies and warn.
  - ACLs are `ipv4 access-list` with sequence numbers.
  - VRFs are `vrf X` + `address-family`, with the RD under `router bgp … vrf`.
- *Main syntax differences:*
  - `GigabitEthernet0/0/0/0` (four-part) naming.
  - Subinterfaces use `encapsulation dot1q`, and `l2transport` for L2.
  - Ordinary config nests by indentation, with `!` / `exit` between blocks.
    But **RPL policies and sets are delimited sublanguages**: `route-policy …
    end-policy`, `prefix-set`/`community-set`/`as-path-set … end-set`, and
    `if … elseif … else … endif` inside. Their bodies needn't be indented, so
    the XR parser needs a delimiter-aware RPL tokenizer, not the indentation
    tree. Until there is one, each policy or set is kept as one atomic
    unsupported statement (see the approach above). This is a large part of
    the M–L estimate.
  - Sets and policies are defined before use.

### Tool 2 MVP scope

One direction first: **Junos → one Cisco platform**. The UI and plugin API
stay two-way so the reverse is the same work with the stages swapped.

| Phase | Feature areas | Notes |
|---|---|---|
| 1 | hostname/domain, interfaces + units/subinterfaces + IPv4/IPv6 addresses + descriptions, static routes, NTP, syslog hosts, SNMP community/location | Proves the pipeline, coverage report, interface map and warnings panel |
| 2 | VLANs + access/trunk ports, OSPF (single area, then multi-area), BGP basics (eBGP/iBGP neighbors, groups, simple import/export) | BGP policy handled in phase 3. Until then, emit placeholders with warnings |
| 3 | prefix-lists, simple policy ↔ route-map/RPL, firewall filters ↔ ACLs (L3/L4 match, accept/discard/reject, count/log) | Where the semantic warnings matter most |
| 4 | VRFs/routing-instances, users/AAA (passwords flagged, not converted) | |
| Out of MVP | QoS/CoS, MPLS/LDP/RSVP, multicast, SRX security zones/policies, NAT, IPsec, EVPN/VXLAN | Listed as unmapped |

How unconverted content is shown:
- In the **source pane**, unmapped lines get a highlight and a gutter marker.
- A **Warnings panel** groups items by kind: unmapped, unrendered, semantic and
  needs input. Clicking an item jumps to the source and output lines.
- The output carries an optional header comment block listing what wasn't
  converted.
- Nothing is dropped without appearing in one of those places.

---

## Plugin architecture

### What a platform plugin provides

A TypeScript workspace package (e.g. `@dialect/platform-junos` in
`packages/platform-junos`) whose entry point exports one object implementing
this interface from `@dialect/core`. It's illustrative, not final:

```ts
export interface PlatformPlugin {
  readonly id: string                 // "junos", "iosxe", "nxos", "iosxr"
  readonly name: string               // "Cisco IOS / IOS-XE"
  readonly modelApi: string           // model versions it supports (semver range), e.g. ">=1.2.0 <2.0.0"
  readonly capabilities: Capabilities // per feature area: parse/render = full | partial | none

  detect(text: string): number                       // 0..1, for auto-detect
  parse(text: string, ctx: Context): ParseResult     // tree + model + statement dispositions
  render(model: Device, ctx: Context): RenderResult  // text + field dispositions
  tools(): readonly Tool[]                           // extra platform-only actions (Junos: display set)
}
```

Plugins take and return strings and plain objects: no file system, DOM or
Node APIs. That keeps them runnable unchanged in the CLI (Node), the desktop
app (WebView2) and the offline browser build. File access lives in the shells.

- **ParseResult** holds:
  - the syntax tree (statement nodes with ids and display-only line spans);
  - the `Device` model;
  - a **disposition for each statement node**: `mapped` → the model field
    paths it filled, `ignored-by-design` + reason, or `unsupported`;
  - the plugin's warnings.
- **RenderResult** holds:
  - the output text;
  - a **disposition for each populated model leaf field**: `rendered` → output
    line span, `unsupported`, or `not-applicable` + reason;
  - warnings.
- The core checks both disposition sets for completeness against the tree and
  the model itself (see [the coverage ledger](#approach-a-hub-model-not-pairwise-translators)).
  It doesn't trust the plugin's own count.
- **Capabilities** let the GUI warn before converting ("NX-OS renderer: BGP
  partial, ACL none") and drive the feature matrix in the docs.
- **Fixtures** ship with each plugin, under its `tests/fixtures/<area>/`:
  `<case>.cfg` + `<case>.model.json` (+ `<case>.rendered.cfg`). A dev-only
  package, `@dialect/conformance`, provides a Vitest conformance kit that runs every plugin's fixtures through four checks:
  - parse → model matches the expected model;
  - render → text matches the expected text;
  - render → reparse → the same model (round-trip stability);
  - the coverage ledger is complete: no statement or populated field without
    a disposition. The kit includes **negative tests**: deliberately
    incomplete stub mappers and renderers that the check must catch. Among
    them are these two counterexamples:
    - Single-line Junos `system { host-name r1; services { ssh; } }`, with a
      mapper that handles only `host-name`. The ledger must report
      `system services ssh` as unmapped, even though line 1 is "covered".
    - A BGP neighbor with `multihop { ttl 2; }`, with a renderer that handles
      only address and remote-as. The ledger must report
      `…neighbors[…].multihop.ttl` as unrendered, even though the neighbor
      object was rendered. Run it again with `multihop` as a field added in a
      later minor model version.

### Versioning the shared model

- The model lives in `@dialect/core` but has its own semver, `MODEL_VERSION`,
  separate from the package version. A plugin declares the range it supports
  (`modelApi`), and the core's registry refuses to load a plugin outside that
  range with a clear message (range check with
  [semver](https://www.npmjs.com/package/semver), ISC). While every plugin is
  built in this is a unit-tested invariant; it matters most once plugins can
  be loaded at runtime.
- **Minor = additive only:** new optional fields and new object types. An
  old renderer never assigns a disposition to a field it doesn't know, so
  the ledger's per-field check reports any populated new field as unrendered.
  Additions can't cause silent drops.
- **Major = breaking.** These should be rare: renames, changed meanings.
  Migrate all first-party plugins in the same release.
- Every serialised model (fixtures, and saved sessions if we add them) carries
  `modelVersion`, so fixtures can be upgraded by script.

### Display set: Junos plugin feature or separate tool?

**A Junos plugin tool, sharing the Junos plugin's tree parser.** Display set is
Junos → Junos and never touches the shared model, so it is exposed through
`tools()` rather than parse/render. Because the same tree feeds both, a fix to
the Junos parser fixes both tools. In the GUI it still appears as its own
top-level mode ("Junos: display set"), so the user doesn't have to think about
plugins.

### Finding and loading plugins

- **Built in at first.** First-party plugins are workspace packages in the
  same repo (`packages/platform-*`). A static registry in `@dialect/core`'s
  consumers (one `plugins.ts` per shell, or a shared `@dialect/plugins`
  package) imports each one and hands the list to the core:

  ```ts
  import junos from '@dialect/platform-junos'
  import iosxe from '@dialect/platform-iosxe'
  export const BUILT_IN: readonly PlatformPlugin[] = [junos, iosxe]
  ```

  The bundler (Vite) compiles them into the CLI, the desktop app and the web
  build. No discovery runs, so discovery can't fail silently, and the core
  checks each plugin's `modelApi` at registration.
- **Loading at runtime: later, not in v1.** Each plugin builds to a single
  ES module whose default export is the plugin object, so the same file could
  later be loaded with a dynamic `import()`. In the desktop app that means
  reading it from a `plugins` folder under the app's data folder (through
  Tauri's fs plugin) and importing it from a `blob:` URL, which the content
  security policy then has to allow. In the web build the user would pick the
  file. Leave it out of v1 because:
  - a plugin is arbitrary code running with the user's rights, next to
    configs that hold secrets;
  - the CSP has to be loosened to run it;
  - we'd be committing to a stable public API early.

  Revisit once the model has reached 1.x and stayed stable.
- Not to be confused with **Tauri plugins**, which are compile-time Rust
  crates for the shell ([docs](https://v2.tauri.app/develop/plugins/)). We use
  a few of Tauri's own (dialog, fs); our platform plugins are plain TypeScript.

---

## Desktop app stack

**Decided: TypeScript (strict) + Tauri 2.** Versions and licenses below were
checked on npm and the Tauri docs on 2026-10-14.

Why this replaced the original Python + PySide6 recommendation (kept as
history in [Original comparison (superseded)](#original-comparison-superseded)):
- **Portability:** one TypeScript core runs in Node (CLI), in the desktop app's
  webview and in any browser.
- **An offline browser build** that runs on locked-down work laptops with
  nothing installed: a single HTML file opened from disk.
- **One language** for the core, the plugins and the UI. The only Rust is
  Tauri's thin, mostly generated shell (`src-tauri`); no conversion logic
  lives there.
- **No Qt LGPL issue:** PySide6 is LGPL-3.0, which the MIT-only decision rules
  out.

### Monorepo layout

npm workspaces (npm 12, pinned; see the install-scripts note in
[Conventions adopted from Hive](#conventions-adopted-from-hive)), one
`package.json` per package, all under the `@dialect/` scope:

```
packages/
  core/             @dialect/core           shared model (+ MODEL_VERSION), coverage ledger, plugin interface,
                                            registry. No UI, no Node or DOM APIs.
  conformance/      @dialect/conformance    dev-only: Vitest conformance kit + negative tests for plugins
  platform-junos/   @dialect/platform-junos tree parser, display set tool, map/render (one package per platform)
  platform-iosxe/   @dialect/platform-iosxe
  platform-nxos/    @dialect/platform-nxos   (later)
  platform-iosxr/   @dialect/platform-iosxr  (later)
  cli/              @dialect/cli            Node CLI: display-set and convert, files and stdin/stdout
  ui/               @dialect/ui             React UI shared by both shells: editors, warnings panel, modes
apps/
  desktop/          Tauri 2 shell: src-tauri (Rust, generated), dialogs and file access, installer
  web/              offline build: the ui as one self-contained HTML file
docs/  scripts/  tests/   repo-wide docs, scripts (licenses, icons) and tests (line endings, notices)
```

Package names describe the platform they read and write (`platform-junos`);
the product name and branding stay vendor-free, as decided.

### How each piece is built and shipped

| Piece | Build | Ships as |
|---|---|---|
| `core`, `platform-*` | Source packages, compiled by whichever shell bundles them. Typechecked with `tsc --noEmit` per package | Inside the three products below |
| `cli` | Vite library build into one ES module, run by Node 24 | `dialect` command (npm package or a zip with a `.cmd` launcher; a Node single-executable build can come later) |
| `ui` + `apps/web` | Vite + [vite-plugin-singlefile](https://www.npmjs.com/package/vite-plugin-singlefile) (2.3.3, MIT), which inlines all JS and CSS into one HTML file | `dialect.html`: open from disk (`file://`), no server, no install. Open via a file picker or drag and drop, save as a download |
| `ui` + `apps/desktop` | Vite for the frontend, `tauri build` for the shell ([@tauri-apps/cli](https://www.npmjs.com/package/@tauri-apps/cli) 2.12.2, MIT OR Apache-2.0) | NSIS `-setup.exe` only ([Windows installer docs](https://v2.tauri.app/distribute/windows-installer/)), code-signed. **No MSI:** Tauri builds it with WiX 3 (MS-RL), and the MSI includes WiX's `WixUtilExtension` |

The conversion runs **in the webview**, from the same bundled TypeScript as the
web build, so desktop and browser behave the same. The Rust side only opens
windows and file dialogs and reads and writes the files the user chose, through
[@tauri-apps/plugin-dialog](https://www.npmjs.com/package/@tauri-apps/plugin-dialog)
(2.8.2) and [@tauri-apps/plugin-fs](https://www.npmjs.com/package/@tauri-apps/plugin-fs)
(2.7.0), both MIT OR Apache-2.0. Tauri 2's capability files limit those to
what the app needs, and a strict content security policy blocks remote content.

**WebView2.** Tauri uses the system WebView2 on Windows. Per the
[Tauri docs](https://v2.tauri.app/distribute/windows-installer/), it is part of
the OS on Windows 10 (April 2018 and later) and Windows 11. The installer's
`webviewInstallMode` decides what happens when it's missing: the default
`downloadBootstrapper` (0 MB, needs internet only then), `embedBootstrapper`
(~1.8 MB), `offlineInstaller` (~127 MB, no internet needed) or `fixedVersion`
(~180 MB). Use the default; the web build covers machines where installing
isn't allowed.

**NSIS installer licenses.** Tauri's bundler (tauri-bundler 2.10.2, read from
its source on 2026-10-14) downloads NSIS 3.13 and its `nsis_tauri_utils.dll`
plug-in (MIT OR Apache-2.0, per the repo's two license files). NSIS itself and
its `System`, `nsDialogs`, `StartMenu` and `NSISdl` plug-ins are zlib/libpng
licensed. Tauri's default **LZMA** compression embeds NSIS's LZMA module,
which is CPL-1.0 with a linking exception. Set
`bundle.windows.nsis.compression` to **`"zlib"`** so that the installer stub
is zlib/libpng only. The installer gets larger, but no CPL code ships.

**Parser approach:** hand-written tokenizers and tree builders, no parser
library (see [Parser approach](#parser-approach)).

**Frontend libraries (from Hive):** React 19, zustand 5 and Monaco 0.57, all
MIT. They are plain browser libraries, so they carry over to Tauri unchanged:
WebView2 is Chromium-based like Electron's renderer. Notes:
- **Monaco's diff editor** suits views where both sides are the same language,
  such as our display set against a device's own `display set`, or one render
  against another. The main Convert view isn't a diff (Junos on one side, IOS-XE
  on the other), so it uses two plain editors linked through the ledger's line
  spans.
- **Monaco in the single-file web build** needs its web workers inlined (Vite's
  `?worker&inline`) and makes the HTML file several MB. That's **untested**; the
  UI card checks it. If it doesn't work out, [CodeMirror 6](https://codemirror.net/)
  (MIT, with [@codemirror/merge](https://www.npmjs.com/package/@codemirror/merge)
  6.12.2 for diffs) is the fallback.

**Testing the shells:** Playwright (Apache-2.0) drives the web build. For the
desktop app, the [Tauri docs](https://v2.tauri.app/develop/tests/webdriver/)
recommend WebdriverIO with [@wdio/tauri-service](https://www.npmjs.com/package/@wdio/tauri-service)
(1.5.0, MIT), which works on Windows. Keep desktop end-to-end tests to a smoke
test: the logic is the same code the web build tests.

**Build machine:** Node 24 (MIT) with npm 12 (Artistic-2.0; a tool, not
shipped) for everything. Rust (stable, MIT OR Apache-2.0) and the Microsoft
C++ build tools only for `tauri build`. The C++ tools are under Microsoft's
proprietary license: a build toolchain, nothing of it is in our repo, and
what it links into the exe is the normal Windows runtime.

**Which Tauri crates are runtime code and which are build-only.** Under the
license rule, runtime crates must be permissive, MPL-2.0 used unmodified is
pre-approved, and build-only crates may be under any open-source license. So
the split matters. Probe, run on 2026-10-14: a throwaway Cargo project, in my
scratchpad and not in the repo, with this manifest:

```toml
[dependencies]
tauri = "2.12.3"
tauri-plugin-dialog = "2"   # resolved 2.8.2
tauri-plugin-fs = "2"       # resolved 2.7.0
[build-dependencies]
tauri-build = "2"           # resolved 2.7.2
```

It was classified with `cargo tree --target x86_64-pc-windows-msvc`. **Runtime**
means `-e normal,no-proc-macro`: normal dependencies for the Windows target,
not entering a proc-macro. **Host-only** means everything else reached by
`-e normal,build`: proc-macros, build scripts and their dependencies. `cargo
tree` applies resolver 2's separate host and target features, which `cargo
metadata`'s merged resolve doesn't. Round 2's "249 shipped" count came from
`cargo metadata` and was wrong: it counted host-only crates such as
`cssparser-macros` (a proc-macro) as shipped.

| | Crates | Outside MIT/Apache/BSD/ISC |
|---|---|---|
| **Target runtime** (compiled for the app; whether each one is actually linked into the exe was not checked: **UNVERIFIED**) | 135 | `option-ext` 0.2.0, MPL-2.0 (via `dirs` ← `tauri`): **pre-approved, unmodified**. 15 ICU4X crates under Unicode-3.0 (`icu_collections`, `icu_locale_core`, `icu_normalizer`, `icu_normalizer_data`, `icu_properties`, `icu_properties_data`, `icu_provider`, `litemap`, `potential_utf`, `tinystr`, `writeable`, `yoke`, `zerofrom`, `zerotrie`, `zerovec`): **allowed as equally permissive** (an MIT-style license with no copyleft) |
| **Host-only** (proc-macros, build scripts; build-only, any open-source license) | 94 | `cssparser`, `cssparser-macros`, `dtoa-short`, `selectors` (MPL-2.0; via `dom_query` ← `tauri-utils`' HTML handling, reached only through the `tauri-macros` proc-macro); `foldhash` (Zlib); `yoke-derive`, `zerofrom-derive`, `zerovec-derive` (Unicode-3.0). All allowed as build-only |

The proc-macros' generated output is our own material, not theirs: our
frontend assets (compressed), the CSP hashes, and the capability and config
data. So nothing of the host-only crates' code ships. These counts are for
this manifest and lockfile. B7 re-runs the same classification on the real
`src-tauri` and checks it in CI (cargo-deny's per-dependency-kind settings or
the same `cargo tree` query). The Tauri CLI itself (578 crates, including
`colored` MPL-2.0 and `webpki-roots` CDLA-Permissive-2.0) is a build tool and
doesn't ship.

### Conventions adopted from Hive

Hive (`D:\Development\HIVE\hive`) is the user's own TypeScript app (MIT, same
copyright holder), so its code can be reused freely. It's the quality bar.
Read on 2026-10-14; nothing there was changed.

**Adopt:**
- **TypeScript settings:** `strict`, target and lib `ES2023`, `module: ESNext`,
  `moduleResolution: bundler`, `isolatedModules`, `noEmit` (bundlers emit).
  TypeScript 7 (7.0.2 on npm, Apache-2.0).
- **Lint with [oxlint](https://www.npmjs.com/package/oxlint)** (1.88.0, MIT),
  `oxlint --deny-warnings`, with a `.oxlintrc.json` (correctness = error,
  suspicious = warn). Not ESLint: typescript-eslint doesn't support
  TypeScript 7.
- **No Prettier.** Match the surrounding formatting by hand; typecheck and lint
  are the checks.
- **Vitest unit tests**, with fixtures under `tests/fixtures` (per package
  here). **Tests wait for conditions, never for time** (`vi.waitFor`,
  `expect.poll`, each with a named bound). Tests make temp folders with a
  `tempDir()` helper by their long real path, never under `os.tmpdir()` (CI's
  temp folder is an 8.3 short path).
- **CI** (`.github/workflows/ci.yml`): `windows-latest`, Node 24, `npm ci`,
  then typecheck, lint and tests; a newer push cancels the older run;
  `permissions: contents: read`.
- **Generated `THIRD_PARTY_NOTICES.md`**, as Hive does it: copy
  `scripts/licenses.mjs`, `scripts/thirdPartyNotices.mjs` and
  `scripts/licenseText.mjs`, with `npm run licenses` to write it, `--check` to
  check it, and `tests/licenses.test.ts` failing when the committed file is
  stale. Every shipped package gets its link, version, license and full
  license text. Adapt it for Dialect:
  - **npm packages that ship**: what's bundled into the UI (the desktop app and
    the web build) and the CLI. Hive's `RENDERER` list becomes one list per
    product;
  - **Rust crates in the Tauri binary: runtime crates only**, by the
    classification above (no proc-macros, build scripts or their deps), e.g.
    with [cargo-about](https://crates.io/crates/cargo-about) (a build tool,
    MIT OR Apache-2.0) or our own script over `cargo tree`;
  - **the installer's components** (NSIS and its plug-ins), kept in
    `scripts/notices` as Hive does for electron-builder's;
  - a hand-written section for material that isn't a package, such as the jcc
    fixtures entry card #3 added;
  - **repository links normalised to full `https://` URLs**. Hive's generator
    passes shorthand `repository` fields through, so its notices have broken
    links such as `formatjs/formatjs`, `nodeca/argparse` and
    `git@github.com:formatjs/formatjs`. Dialect's must expand `owner/repo`,
    `github:owner/repo`, `git@host:owner/repo(.git)`, `git+https://…` and
    `git://…`, with a unit test for each form.

  The same file is shown in the app's Docs view (card B16).
- **License check in two categories**, matching the license rule:
  - **Shipped or copied into the repo:** must be MIT or equally permissive.
    The allowlist is MIT, Apache-2.0, BSD-2/3-Clause, ISC, 0BSD, MIT-0, Zlib,
    Unicode-3.0, BSL-1.0, CC0-1.0 and Unlicense, plus **MPL-2.0 when used
    unmodified** (pre-approved). Anything else fails, unless an exception
    records the package, its license, why, and who decided. This covers the
    shipped npm packages above, the Tauri runtime crates, the installer's
    components, and files copied into the repo (fixtures, ported code).
  - **Build-only** (never ships): any OSI-approved open-source license,
    including GPL and LGPL (e.g. sharp's libvips). These are **listed** in a
    generated build-only section (or file), not just allowed silently. The
    check fails on no license or a non-open-source license.

  For npm, "shipped" is the per-product bundle lists and everything else in
  `npm ls --all --json` is build-only. For Cargo, it's the runtime and
  host-only split above, enforced with
  [cargo-deny](https://crates.io/crates/cargo-deny) 0.20.2 (MIT OR
  Apache-2.0) or the same `cargo tree` query.
- **Line-endings unit test** (`tests/lineEndings.test.ts`): no text file mixes
  endings or has a lone CR. Our `.gitattributes` already forces LF (card #3),
  which this test backs up.
- **Icon pipeline** (one SVG master, generated sizes). Hive's `scripts/build-icons.mjs` renders with
  [sharp](https://www.npmjs.com/package/sharp), and sharp's license chain on
  Windows x64 is:
  - `sharp` 0.35.5: Apache-2.0;
  - its native package `@img/sharp-win32-x64` 0.35.5: **Apache-2.0 AND
    LGPL-3.0-or-later**;
  - which contains `@img/sharp-libvips-win32-x64` 1.3.4, the libvips DLLs:
    **LGPL-3.0-or-later**.

  Under the license rule this is **allowed as build-only**: sharp and libvips
  run on the build machine, and only the PNG/ICO files they produce ship. It
  is listed in the build-only list. `png-to-ico` 3.0.2 (MIT, with `pngjs` and
  `minimist`, both MIT) completes the pipeline, so card #5 can reuse Hive's
  script as it is. For the Tauri bundle's own icon set, `tauri icon` (Tauri
  CLI 2.12.2, MIT OR Apache-2.0) also takes an SVG master and writes every
  size the bundler needs. It renders with `resvg`/`usvg` (MIT OR Apache-2.0)
  and `tiny-skia` (BSD-3-Clause). Either works; card #5 picks.
- **Agent and decision docs:** `AGENTS.md` as the single agent guide, with
  `CLAUDE.md` containing only `@AGENTS.md`. `docs/SPEC.md` is the source of
  truth for product decisions (it takes over the workspace note's decisions)
  and `docs/ARCHITECTURE.md` explains how the code fits together.
- **`CHANGELOG.md`** with an **Unreleased** section on top, merged with
  `merge=union` in `.gitattributes` (for that file only), and semver 0.x
  until the model and plugin API are stable.
- **Install scripts: use npm 12's default deny.** Hive's AGENTS.md says npm 11
  blocks install scripts by default; that's not what npm 11 does. In npm
  11.17–11.x, `allowScripts` only skips packages explicitly set to `false`;
  unreviewed ones still run and get an advisory warning
  ([rebuild.js, v11.17.0](https://github.com/npm/cli/blob/v11.17.0/workspaces/arborist/lib/arborist/rebuild.js)).
  **npm 12.0.0** (2026-07-08) made it default-deny: only packages set to
  `true` run their scripts
  ([#9424](https://github.com/npm/cli/pull/9424); approvals are managed with
  `npm install-scripts …` since #9629). So: pin npm 12 (`"packageManager":
  "npm@12.2.0"` and `engines.npm: ">=12"`), install it in CI before `npm ci`
  (Node 24 bundles npm 11), and list the few packages whose scripts must run
  (e.g. esbuild) as `true` in `allowScripts`. B1 checks that an unlisted
  package's script doesn't run.

**Doesn't carry over (Electron-only):**
- **electron-builder** → `tauri build` makes the installers.
- **electron-updater** → Tauri's updater plugin (MIT OR Apache-2.0, with its
  own signing key). Not in v1.
- **The asar / `original-fs` rule** and its lint override → Tauri has no asar.
- `ELECTRON_RUN_AS_NODE`, the Electron stub for unit tests, and Playwright's
  `_electron` driver → nothing; the web build is driven by plain Playwright.
- Hive's typed IPC contract (`src/shared/api.ts`) is a good idea, but Dialect
  needs very few Rust commands, because conversion runs in the webview.

### Original comparison (superseded)

> **Superseded on 2026-10-14 by the user's decision: TypeScript + Tauri 2.**
> Reasons: portability, an offline browser build for locked-down laptops,
> one language for the core, plugins and UI, and no Qt LGPL issue (the
> project is MIT only). Kept as the record of what was compared. The
> Python + PySide6 option, and the packaging advice that went with it, no
> longer apply.

Versions and dates as checked on PyPI, npm, NuGet and the vendors' docs on
2026-10-14:

| | **Python + PySide6** (was recommended) | **Tauri 2** (Rust + TS web UI) / Electron | **.NET 10 + Avalonia/WPF** |
|---|---|---|---|
| Current | [PySide6](https://pypi.org/project/PySide6/) 6.12.0 (2026-10-08, Python 3.10–3.15) | Tauri 2.12.x; Electron 44.x | .NET 10 LTS (to 2028-11). **.NET 8 and 9 both end support on 2026-11-10** ([policy](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core)). Avalonia 12.1.4 |
| Windows packaging | PyInstaller 6.22 or Nuitka via Qt's [`pyside6-deploy`](https://doc.qt.io/qtforpython-6/deployment/deployment-pyside6-deploy.html), then an installer. [Briefcase](https://briefcase.beeware.org/en/stable/reference/platforms/windows/index.html) builds an MSI. **Use onedir, not onefile:** onefile unpacks to a temp folder on every launch, so it starts slower ([PyInstaller docs](https://pyinstaller.org/en/stable/operating-mode.html)) | MSI or NSIS; WebView2 already ships with Windows 11 ([docs](https://v2.tauri.app/distribute/windows-installer/)). Electron via Forge (Squirrel/WiX/MSIX) | `PublishSingleFile` + self-contained ([docs](https://learn.microsoft.com/en-us/dotnet/core/deploying/single-file/overview)) |
| Reuse of Python parsing libs | Native | Only as a **sidecar** exe (Tauri's [sidecar docs](https://v2.tauri.app/develop/sidecar/) suggest a PyInstaller-built CLI), so you still get the PyInstaller exe plus an IPC protocol. Otherwise rewrite the parsers in TS/Rust | [pythonnet](https://pythonnet.github.io/pythonnet/dotnet.html) 3.2.1. You bundle and initialise CPython yourself, and every call holds the GIL. Painful |
| Plugins | Entry points + importlib. Works frozen with PyInstaller's `copy_metadata`/`collect_entry_point` ([hooks](https://pyinstaller.org/en/stable/hooks.html)) | Tauri plugins are **compile-time** Rust crates ([docs](https://v2.tauri.app/develop/plugins/)). Runtime plugins need WASM (e.g. Extism, which has no Python PDK) or JS modules. Electron: JS modules, easy | The strongest model: `AssemblyLoadContext` per plugin ([docs](https://learn.microsoft.com/en-us/dotnet/core/tutorials/creating-app-with-plugin-support)) |
| Languages for a solo dev | 1 | 2–3 | 1 (C#), plus Python if reused |
| Main risks | Antivirus false positives on PyInstaller exes, which [PyInstaller says it can't fix](https://github.com/pyinstaller/pyinstaller/blob/develop/.github/ISSUE_TEMPLATE/antivirus.md). Qt's [LGPL obligations](https://www.qt.io/licensing/open-source-lgpl-obligations), where onedir keeps the DLLs replaceable. Bundle size (the PySide6-Essentials wheel alone is 82 MB, so expect a large install; trim unused Qt modules) | Two runtimes. The parser rewrite loses Python reuse | Parsers in C#, or the pythonnet pain |
| Effort | Lowest | Highest | Medium if the developer knows C# |

That comparison recommended Python 3.13+ + PySide6 in a code-signed onedir
build: one language with the Python parsing ecosystem, entry-point plugins,
and a Qt-free core. Tauri was only to be chosen if a web UI was a hard
requirement. The decisions changed the requirements: a browser build and MIT
only.

### UI sketch

```
┌ Dialect ────────────────────────────────────────────────────────────────────────┐
│ Mode: (•) Display set   ( ) Convert         [Open…] [Paste] [Save output] [Copy]│
│ Source: [Junos      ▾] (auto: Junos 0.97)  →  Target: [Cisco IOS-XE ▾]  [Convert]│
├───────────────────────────────────────┬─────────────────────────────────────────┤
│ SOURCE                                │ OUTPUT                                  │
│  1 interfaces {                       │  1 hostname r1                          │
│  2     ge-0/0/0 {                     │  2 !                                    │
│  3         description uplink;        │  3 interface GigabitEthernet0/0/0       │
│  4         unit 0 {                   │  4  description uplink                  │
│  5             family inet {          │  5  ip address 192.0.2.1 255.255.255.0  │
│▌ 6                 filter input F;    │  6 !                                    │
│  …  (unmapped lines marked ▌)         │  (click a line ↔ highlights its source) │
├───────────────────────────────────────┴─────────────────────────────────────────┤
│ Warnings (3)  [Unmapped 1] [Semantic 1] [Needs input 1]                         │
│  ▌ line 6  firewall filter input F: ACLs not in phase 1, not converted          │
│  ⚠ line 12 OSPF: interface-level config rendered as `ip ospf` (check area)      │
│  ? ge-0/0/0 → GigabitEthernet0/0/0  (edit interface map…)                       │
└─────────────────────────────────────────────────────────────────────────────────┘
```

The editors are Monaco instances with line numbers, gutter markers and
decorations, plus a syntax highlighter (a Monarch tokenizer) per platform. Each
plugin can supply its own highlighting rules. The same UI runs in the desktop
app and the web build; only the file open and save calls differ.

---

## License check

The whole project is MIT. The license rule (decided 2026-10-14) has two
categories:
- **Shipped, or copied into the repo:** MIT or equally permissive (Apache-2.0
  with its NOTICE text kept, BSD, ISC, Zlib, Unicode-3.0 and the like).
  **MPL-2.0 used unmodified is pre-approved.** GPL, LGPL, AGPL, other
  copyleft (CPL, MS-RL) and no license are not allowed.
- **Build-only** (never ships): any open-source license, GPL and LGPL
  included. Listed as **build-only**.

Toolchains (Node, npm, Rust, the C++ build tools) and the OS's WebView2 are
marked as tools. Verdicts: **OK (ships)**, **OK (build-only)**, **OK (not
used)** for things we only learn from, and **Not allowed**.
"Use" says what we'd do with it. Licenses were checked on 2026-10-14 against
GitHub's license detection, the npm registry, or the files themselves where
those disagreed.

| Library or project | License | Verdict | Use |
|---|---|---|---|
| saidvandeklundert/juniper-config-converter (jcc) | MIT | OK | Fixtures as test data, attributed in `THIRD_PARTY_NOTICES.md` |
| dg-i/junoscfg | MIT | OK | Ideas; optional test oracle outside the app (Python) |
| codeout/junoser | MIT | OK | Reference (Ruby) |
| ckishimo/juniper_display_set | Apache-2.0 | OK | Reference only |
| as2518/junos_config_converter | MIT | OK | Reference only |
| aledwmorris/juniper-display-set | BSD-3-Clause | OK | Reference only |
| mkomon/junos_to_set, khornem/jnp-dset-converter | none | **Not allowed** | Don't copy anything |
| Batfish | Apache-2.0 | OK | Design reference (flattener, model); port with attribution if any code is used |
| Juniper/yang | Apache-2.0 | OK | Schema source for the reverse; attribute it if derived data ships |
| OpenConfig models (openconfig/public) | Apache-2.0 | OK | Model structure and names |
| YangModels/yang (Cisco and others) | per directory (IETF, Eclipse, vendor terms) | **Check per file first** | Reference only |
| netcanon | MIT | OK, **ideas only (decided)** | No dependency, fork or wrapper; optional benchmark |
| Ansible resource modules (cisco.ios etc.; Juniper's in ansible-junos-stdlib) | GPL-3.0 (Juniper's repo is Apache-2.0 overall, but its resource modules' headers say GPL-3.0) | **Not allowed to ship or copy**; OK (build-only) as a test oracle | At most a test oracle |
| ciscoconfparse / ciscoconfparse2 | GPL-3.0 | **Not allowed to ship or copy** | None |
| NAPALM | Apache-2.0 | OK | Not needed (live devices) |
| napalm-yang (archived), yangify | Apache-2.0 | OK | Past attempts, reference only |
| Capirca, Aerleon | Apache-2.0 | OK | ACL model reference |
| TTP | MIT | OK | Not needed |
| Genie parsers | Apache-2.0 | OK | Not needed |
| ntc-templates | Apache-2.0 (from its LICENSE file; GitHub doesn't detect it) | OK | Not needed |
| nimaster/JUNOS_TO_CISCO_HYBRID_ACL_CONVERSION | Apache-2.0 | OK | Reference only |
| Lark (Python) | MIT | OK | Not usable from TypeScript |
| ANTLR (Batfish's grammar tool) | BSD-3-Clause | OK | Not needed (hand-written parser) |
| tree-sitter | MIT | OK | Not used (no Junos grammar) |
| PyO3 | MIT OR Apache-2.0 (Apache-2.0 per GitHub) | OK | Not used (was for wrapping jcc) |
| gNMI (openconfig/gnmi) | Apache-2.0 | OK | Not used (device API) |
| FastAPI (netcanon's web UI) | MIT | OK | Not used |
| Vendor migration tools (I2J, Nexus Migration Tool, SoX, Cisco Secure Firewall Migration Tool, FortiConverter, Expedition) | proprietary or gone | **Not allowed** as code; not used | Context only |
| **Stack: TypeScript** | Apache-2.0 | OK | Build tool |
| **Tauri 2** (`@tauri-apps/cli`, `@tauri-apps/api`, plugin-dialog, plugin-fs, plugin-updater) | MIT OR Apache-2.0 | OK (take MIT) | Desktop shell |
| Vite | MIT | OK | Bundler |
| @vitejs/plugin-react | MIT | OK | Bundler plugin |
| esbuild (used by Vite) | MIT | OK | Build tool |
| Node.js | MIT | OK | CLI runtime, build |
| npm | Artistic-2.0 | OK as a tool (not a library, not shipped) | Package manager |
| Rust toolchain | MIT OR Apache-2.0 | OK | Builds the Tauri shell |
| Microsoft C++ build tools | Microsoft proprietary | OK as a toolchain (not in the repo) | Needed by `tauri build` |
| WebView2 runtime | Microsoft proprietary, part of Windows | OK as a system component; not redistributed with the default bootstrapper (`offlineInstaller`/`fixedVersion` would redistribute it under Microsoft's terms) | Desktop app's webview |
| **Tauri runtime crates** (135 resolved for the Windows target; linking into the exe UNVERIFIED) | MIT/Apache/BSD/ISC, plus `option-ext` MPL-2.0 and 15 ICU4X crates Unicode-3.0 | **OK (ships):** MPL-2.0 pre-approved (unmodified), Unicode-3.0 equally permissive | Desktop app |
| **Tauri host-only crates** (94: proc-macros, build scripts) | as above, plus `cssparser`, `cssparser-macros`, `dtoa-short`, `selectors` MPL-2.0, `foldhash` Zlib, three `*-derive` Unicode-3.0 | **OK (build-only)** | `tauri build` |
| **Tauri CLI crates** (578) | as above, plus `colored` MPL-2.0, `webpki-roots` CDLA-Permissive-2.0, BSL-1.0, CC0, Unlicense OR MIT | **OK (build-only)** | `tauri build`, `tauri icon` |
| NSIS 3.13 + `System`/`nsDialogs`/`StartMenu`/`NSISdl` plug-ins | zlib/libpng | **OK (ships)**: equally permissive | Installer |
| NSIS LZMA compression module | CPL-1.0 with a linking exception | **Not allowed** (would ship in the installer stub): use `"compression": "zlib"` | Not used |
| nsis_tauri_utils | MIT OR Apache-2.0 | OK | Installer plug-in |
| WiX Toolset 3 (`WixUtilExtension`) | MS-RL | **Not allowed** (reciprocal) | No MSI |
| cargo-deny | MIT OR Apache-2.0 | OK | License check (build only) |
| GitHub Actions `actions/checkout`, `actions/setup-node` | MIT | OK | CI |
| vite-plugin-singlefile | MIT | OK | Offline web build |
| Vitest | MIT | OK | Unit tests |
| oxlint | MIT | OK | Lint |
| ESLint, typescript-eslint | MIT | OK | Not used (no TypeScript 7 support) |
| Prettier | MIT | OK | Not used (convention) |
| React, react-dom, zustand | MIT | OK | UI |
| marked 18.1.1 | MIT | OK (ships) | Renders the Docs view's Markdown |
| DOMPurify 3.4.17 | MPL-2.0 OR Apache-2.0 | OK (ships), **used under Apache-2.0** (as Hive does) | Sanitises the rendered Markdown |
| Monaco editor (incl. its Monarch tokenizers) | MIT | OK | Editors |
| Hive (`D:\Development\HIVE\hive`) | MIT, same copyright holder | OK | Conventions and scripts to copy |
| Python standard library (the spike prototype only) | PSF-2.0 | Not a dependency: the prototype is our own throwaway code and is deleted after the port | Reference |
| Azure Artifact Signing, OV certificates | services, not libraries | — | Code signing, if the user chooses |
| CodeMirror 6, @codemirror/merge | MIT | OK | Fallback editor |
| Peggy, Ohm | MIT | OK | Only if a grammar library is needed |
| Chevrotain | Apache-2.0 | OK | Only if a grammar library is needed |
| semver | ISC | OK | `modelApi` range checks |
| Playwright | Apache-2.0 | OK | Web build tests |
| WebdriverIO, @wdio/tauri-service | MIT | OK | Desktop smoke test |
| sharp 0.35.5 | Apache-2.0 | **OK (build-only)** | Icon pipeline (card #5) |
| `@img/sharp-win32-x64` 0.35.5 (sharp's native part) | Apache-2.0 AND LGPL-3.0-or-later | **OK (build-only)**; never ships | Icon pipeline |
| `@img/sharp-libvips-win32-x64` 1.3.4 (libvips DLLs) | LGPL-3.0-or-later | **OK (build-only)**; never ships | Icon pipeline |
| png-to-ico 3.0.2 (+ pngjs, minimist) | MIT | **OK (build-only)** | Icon pipeline |
| resvg, usvg, image, png | MIT OR Apache-2.0 | OK | Inside `tauri icon` |
| tiny-skia | BSD-3-Clause | OK | Inside `tauri icon` |
| ico | MIT | OK | Inside `tauri icon` |
| cargo-about | Apache-2.0 per GitHub | OK | Rust crate notices (build only) |
| Electron (incl. its built-in `original-fs` module) | MIT | OK | Not used (alternative, history) |
| electron-builder, electron-updater, @electron/asar | MIT | OK | Not used (Electron-only, Hive) |
| Electron Forge, Squirrel.Windows | MIT | OK | Not used (history) |
| MSIX | packaging format, not a library | — | Not used |
| *History only:* .NET 10, WPF | MIT | OK | Superseded |
| *History only:* PySide6 / Qt | LGPL-3.0 (or GPL / commercial) | **Not allowed** | Superseded stack |
| *History only:* PyInstaller | GPL-2.0 with a bootloader exception | **Not allowed** as a dependency | Superseded packaging |
| *History only:* Nuitka | AGPL-3.0 per GitHub | **Not allowed** | Superseded packaging |
| *History only:* Briefcase, pywebview | BSD-3-Clause | OK | Superseded |
| *History only:* NiceGUI, pythonnet, Avalonia | MIT | OK | Superseded |
| *History only:* Flet | Apache-2.0 | OK | Superseded |
| *History only:* Extism | BSD-3-Clause | OK | Superseded |

---

## Risks

1. **Semantic correctness.** Output that parses but behaves differently is
   worse than no output. To mitigate: semantic warnings, conservative
   defaults, and fixtures reviewed against real devices or labs.
2. **Test data.** Good fixtures need real, cleaned-up configs from each
   platform and version (see the README's contributing rules). Without them
   the estimates above slip.
3. **Version drift.** Junos and Cisco syntax changes across releases. Pin
   supported ranges per plugin and say so in the UI.
4. **Secrets.** Configs hold password hashes and keys. Keep the app fully
   offline with no telemetry, and never write secrets to logs. The content
   security policy blocks remote requests in both shells.
5. **WebView2.** The desktop app needs the WebView2 runtime. It is part of
   Windows 10 (April 2018+) and 11, but an organisation can manage or
   restrict it (**UNVERIFIED** for any specific site). Mitigation: the default
   bootstrapper installs it if missing, `offlineInstaller` for offline
   installs, and the web build as the fallback.
6. **Code signing.** Unsigned installers downloaded through a browser get a
   SmartScreen warning. Per the [Tauri signing docs](https://v2.tauri.app/distribute/sign/windows/),
   signing isn't needed to run the app, and since 2024 an EV certificate no
   longer gives instant SmartScreen reputation. Options: an OV certificate, or
   Azure Artifact Signing (formerly Trusted Signing) through Tauri's
   `signCommand`. Cost and who owns the certificate are for the user to decide.
7. **Antivirus.** New, unsigned or rarely seen executables and NSIS installers
   can be flagged by antivirus heuristics. Signing helps but doesn't prevent
   it. Plan to submit false positives to the vendors, and keep the web build
   (a plain HTML file) as the way round it.
8. **Offline web build on locked-down laptops.** Policies can block `file://`
   pages, downloads or local file pickers. That's **UNVERIFIED** until it's
   tried on a target laptop. Test it early (the web build card).
9. **Scope creep across platforms.** Each new platform is a whole plugin with
   fixtures. Ship one pair end to end before starting a second.

## Recorded decisions

Decided by the user on 2026-10-14 (workspace note `juniper-decisions.md`).
These were open questions in the first version of this report.

1. **Stack:** TypeScript (strict) for the core, the plugins and the UI. Desktop
   app via Tauri 2, plus an offline browser build and a CLI from the same core.
2. **License:** the whole project is MIT. What ships, or is copied into the
   repo, must be MIT or equally permissive (Apache-2.0 with its NOTICE text,
   BSD, ISC…). Build-only tools that never ship may use any open-source
   license, GPL and LGPL included, and are listed as build-only. **MPL-2.0
   that ships, used unmodified, is pre-approved** (e.g. Tauri's `option-ext`).
3. **netcanon:** ideas only. We write our own converter: we don't depend on it,
   fork it or wrap it. It may be used as an optional benchmark.
4. **Platforms as plugins:** each platform is its own plugin.
5. **Configs:** only cleaned-up configs go into the repo.
6. **Trademarks:** "Juniper", "Junos" and "Cisco" stay out of the product name
   and branding. The app says it isn't affiliated with either vendor.
7. **Build plan:** borrow conventions and code from Hive (see
   [Conventions adopted from Hive](#conventions-adopted-from-hive)).
8. **About and Docs:** Dialect ships an About dialog and an in-app Docs view
   like Hive's: User Guide, Release Notes, License and the generated
   Third-Party Notices (every shipped package with link, version and full
   license text). See card B16.

## Open questions for the user

1. **Direction and first platform for Tool 2:** Junos → Cisco or Cisco →
   Junos first, and which Cisco platform (IOS-XE suggested)?
2. **Sample configs:** can you provide cleaned-up real configs (Junos and the
   chosen Cisco platform) for fixtures? This is the biggest factor in quality.
3. **Junos families in scope:** MX/EX/QFX (routing and ELS switching)? Are SRX
   security zones, policies and NAT out of scope?
4. **Reverse display set (set → hierarchical):** needed? If so, it's our own
   schema loader (**M**).
5. **Annotations:** should display set output include `/* comments */`
   (Junos has an `annotate` command), or drop them with a warning as the
   prototype does? A device capture would show what Junos itself prints.
6. **Who gets the app:** just you, or a team or customers? That decides code
   signing (and who pays for the certificate), installer vs web build first,
   and whether the CLI is published.
7. **Third-party plugins:** OK to leave out of v1 as recommended?

## Suggested follow-up build cards

Not created on the board; the user picks what gets built. They're numbered
B1… so they aren't confused with board cards, and listed in a workable order.
Sizes as above: **S** ≈ 1–2 weeks, **M** ≈ 3–6 weeks, **L** ≈ 2–3 months
(judgement, not measurement). Card #5 (icons) is already on the board. It can
reuse Hive's sharp pipeline (allowed as build-only) or `tauri icon` (see
[Conventions adopted from Hive](#conventions-adopted-from-hive)).

**Core interfaces stable** means B2 is merged and the plugin interface, the
model's v0 shape and the ledger API haven't changed for a card or two. Cards
marked ◆ need that first. Cards that touch different packages can run in
parallel in separate worktrees once it holds. Cards that add to the model
(B9's interface map, B10, B11, B12, B13) also touch `packages/core`. They
don't run alongside each other's core changes: each merges its core part
first, or they take turns.

Every card's done-when includes: `npm run typecheck`, `npm run lint` and
`npm test` pass locally and in CI, and the license checks pass.

### Group A: repo and core (in order, one at a time)

**B1. Monorepo scaffold, with Hive's conventions.** **S**
- *Goal:* an empty, fully checked repo that every later card builds in.
- *Files:* root `package.json` (npm workspaces, `packageManager: npm@12.2.0`,
  `allowScripts`), `tsconfig*.json`, `.oxlintrc.json`, `vitest.config.ts`,
  `.github/workflows/ci.yml`, `scripts/licenses.mjs`,
  `scripts/thirdPartyNotices.mjs`, `scripts/licenseText.mjs`,
  `scripts/licensePolicy.mjs`, `tests/lineEndings.test.ts`,
  `tests/licenses.test.ts`, `tests/tempDir.ts`, `AGENTS.md`, `CLAUDE.md`,
  `docs/SPEC.md`, `docs/ARCHITECTURE.md`, `docs/USER_GUIDE.md` (a first
  outline), `CHANGELOG.md` (with an **Unreleased** section), `README.md`
  (contributing rules updated to the two-category license rule),
  `THIRD_PARTY_NOTICES.md` (now generated), `.gitattributes` (adds
  `CHANGELOG.md merge=union`), and a stub `package.json` + `src/index.ts` per
  workspace in the layout above.
- *Scope:* Hive's TypeScript settings, oxlint `--deny-warnings`, no Prettier,
  Vitest. Windows CI on Node 24 that installs npm 12, then runs `npm ci`,
  typecheck, lint and tests. The notices generator (npm part) with full
  license texts, the hand-written jcc entry kept, and repository links
  normalised to `https://` URLs. The two-category license check: shipped
  packages against the permissive allowlist (MPL-2.0 unmodified allowed), and
  build-only packages listed and required to be open source, with a
  recorded-exceptions list. SPEC.md takes over the recorded decisions. No
  product code.
- *Needs:* nothing.
- *Done when:* the checks pass on the empty skeleton, locally and in CI.
  `tests/licenses.test.ts` fails on a stale notices file, on a shipped fixture
  package that's GPL, and on a build-only fixture package with no license. It
  passes with a build-only LGPL fixture, which appears in the build-only
  list. A repository-URL test covers `owner/repo`, `github:owner/repo`,
  `git@github.com:owner/repo.git`, `git+https://…` and `git://…`, each giving
  a full `https://` URL. The line-endings test fails on a mixed file. With
  npm 12, a fixture dependency with an unlisted `postinstall` doesn't run
  it.

**B2. Core v0: shared model, coverage ledger, plugin interface, conformance
kit.** **M**
- *Goal:* the contracts every plugin and shell builds on, frozen as v0.
- *Files:* `packages/core`, `packages/conformance`.
- *Scope:* `PlatformPlugin`, `ParseResult`/`RenderResult`, statement and
  field dispositions, `MODEL_VERSION` and the registry's `modelApi` check
  (semver), the phase 1 model types (system, interfaces/subinterfaces/
  addresses, static routes, NTP, syslog, SNMP), the ledger's two
  completeness checks, warnings, needs-input items, display-only spans, and
  JSON (de)serialisation with `modelVersion`. The conformance kit runs a
  plugin's fixtures through the four checks.
- *Needs:* B1.
- *Done when:* the kit's two counterexample negative tests (the single-line
  `system { host-name r1; services { ssh; } }` mapper and the `multihop.ttl`
  renderer, also as a later-minor field) are caught. A stub plugin passes the
  kit. The registry rejects a plugin with an out-of-range `modelApi`, with a
  message naming both versions. `packages/core` imports no Node or DOM API
  (a lint rule or test checks it).

### Group B: Junos (`packages/platform-junos`)

**B3. Junos tree parser + display set, ported from the prototype.** **S**
- *Goal:* production display set in TypeScript, replacing `spike/`.
- *Files:* `packages/platform-junos` (tokenizer, tree, flattener, `tools()`
  entry), its `tests/` and `tests/fixtures/display-set/`. Delete `spike/`.
  Update the jcc entry in the notices if fixture files are copied in.
- *Scope:* port the tokenizer, tree and flattener of
  `spike/display_set/junos_set.py`; parse errors with line and column;
  warnings for unknown tags and dropped annotations. Expose display set
  through `tools()`.
- *Needs:* B1; B2 for the `tools()` wiring only (the parser can start
  before).
- *Done when:* the prototype's 12 self-test cases pass as Vitest tests. All
  22 jcc fixture pairs pass, after being cleaned up per the README and
  attributed, with config_8, 15 and 16 corrected to Juniper's documented
  `deactivate` order. Every jcc failure case in this report has a test.
  `spike/` is gone.

◆ **B4. Junos plugin: map tree → model, phase 1 areas.** **M**
- *Goal:* Junos parses into the shared model with every statement accounted
  for.
- *Files:* `packages/platform-junos` (mapper, renderer for phase 1,
  `detect()`), `tests/fixtures/<area>/`.
- *Scope:* phase 1 areas; `apply-groups` expansion, including `<*>`
  wildcards and `apply-groups-except`, before mapping; `interface-range`;
  units and families; ELS only. Rendering Junos from the model for the same
  areas, so the reverse direction and round-trip work.
- *Needs:* B2, B3.
- *Done when:* at least one cleaned-up fixture per phase 1 area passes the
  conformance kit's four checks, including round-trip. A fixture with
  unsupported statements shows them as `unsupported` in the ledger, not
  missing.

### Group C: shells (`packages/cli`, `packages/ui`, `apps/web`, `apps/desktop`)

**B5. CLI: display set.** **S**
- *Goal:* display set from the command line.
- *Files:* `packages/cli`.
- *Scope:* `dialect display-set <file|->` to stdout. Errors go to stderr with
  line and column; exit codes are 0 ok, 1 parse error, 2 usage. Built into one
  ES module run by Node 24. `convert` is **not** in this card (B9 adds it).
- *Needs:* B3.
- *Done when:* tests run the built CLI on the display-set fixtures and an
  invalid input, and check stdout, stderr and exit codes.

**B6. UI + offline web build: display set mode.** **S–M**
- *Goal:* the display-set tool in a browser, from one HTML file with nothing
  installed.
- *Files:* `packages/ui`, `apps/web`.
- *Scope:* React + zustand + Monaco; source and output panes; open (picker,
  drag and drop), paste, save (download), copy; the warnings panel; a
  single-file build with vite-plugin-singlefile, with Monaco's workers inlined
  or the CodeMirror 6 fallback; a strict CSP meta tag (no network).
- *Needs:* B3.
- *Done when:* Playwright opens the built `dialect.html` from `file://` with
  the network blocked, converts a fixture and checks the output and a parse
  error's warning. The file's size is recorded in the card's report. The
  Monaco-or-CodeMirror decision is recorded in `docs/ARCHITECTURE.md`. A
  manual try on a locked-down work laptop is reported, or listed as not done.

**B7. Desktop app: Tauri 2 shell and installer.** **S**
- *Goal:* an installable Windows app around the same UI.
- *Files:* `apps/desktop` (incl. `src-tauri`, `tauri.conf.json`,
  capabilities), `deny.toml` (cargo-deny), and the notices script's additions
  for Rust crates and NSIS components.
- *Scope:* Tauri 2 wrapping `packages/ui`. Open and save through the dialog
  and fs plugins, scoped to the files the user picks. A strict CSP. An NSIS
  installer only, with `compression: "zlib"` and the default WebView2 mode. A
  `signCommand` hook (signing itself waits for the user's certificate
  decision). Icons from card #5. The notices generator's Rust part: **runtime
  crates only**, classified as in the stack section (no proc-macros or build
  scripts), plus the NSIS components; host-only crates go in the build-only
  list. The license check for both, in CI. A WebdriverIO smoke test.
- *Needs:* B6, card #5.
- *Done when:* the installer installs and runs on a clean Windows 11 VM, and
  display set works there with open and save. The WebdriverIO smoke test
  passes. The notices list the runtime crates (with `option-ext` as MPL-2.0)
  and the NSIS components, and no proc-macro crate (a test checks that
  `cssparser-macros` isn't listed). The license check passes.

**B16. About dialog and Docs view.** **S**
- *Goal:* the app documents itself and its licenses, as Hive does, in both
  the desktop app and the web build.
- *Files:* `packages/ui` (About dialog, Docs view, a Help menu or command),
  `docs/USER_GUIDE.md` (filled in for display set), and a check that the
  bundled docs are current.
- *Scope:* modelled on Hive's `DOCS` list (`OtherViews.tsx`, docs imported
  with Vite's `?raw`) and its `help.about` command and `AboutDialog`. The
  Docs view has User Guide (`docs/USER_GUIDE.md`), Release Notes
  (`CHANGELOG.md`), License (`LICENSE`) and Third-Party Notices (the generated
  `THIRD_PARTY_NOTICES.md`), rendered with marked + DOMPurify. The About
  dialog shows the version, the build (desktop or web), the WebView2 or
  browser version where available, the "not affiliated with Juniper Networks
  or Cisco Systems" line, links into the Docs pages, and Copy. Numbered B16
  to keep the earlier numbers stable; do it after B7 and before B9.
- *Needs:* B1 (the generated notices, CHANGELOG, USER_GUIDE), B6, B7.
- *Done when:* in the web build (Playwright, from `file://` with no network)
  and the desktop app (smoke test), About opens and shows the version, and
  each of the four Docs pages renders, with the notices page listing a known
  shipped package with its version and license text. A test fails when the
  notices bundled into the UI differ from the committed file.

### Group D: conversion (needs the core interfaces stable)

◆ **B8. First Cisco plugin (IOS-XE suggested): parse and render, phase 1
areas.** **M**
- *Goal:* IOS-XE in and out of the shared model for phase 1.
- *Files:* `packages/platform-iosxe`.
- *Scope:* the indentation tree with `!` separators; banners and certificate
  chains as atomic statements; mapping and rendering for phase 1 (dotted
  mask ↔ prefix length, subinterfaces with `encapsulation dot1Q`, NTP,
  logging, SNMP); `detect()`.
- *Needs:* B2. Can run in parallel with B3–B7.
- *Done when:* at least one cleaned-up fixture per phase 1 area passes the
  conformance kit's four checks. A banner and a certificate chain each come
  through as one atomic `unsupported` statement.

◆ **B9. Convert mode end to end + interface-name mapping.** **S**
- *Goal:* Junos → IOS-XE conversion usable in all three products.
- *Files:* `packages/ui` (Convert mode, mapping table, source↔output
  highlighting), `packages/cli` (`dialect convert --from junos --to iosxe
  [--map file]`), `packages/core` (the interface-map type and its use in the
  ledger's needs-input items).
- *Needs:* B4, B5, B6, B7, B8 (B16 should be in first).
- *Done when:* a Junos phase 1 fixture converts to IOS-XE in the CLI, the web
  build (Playwright) and the desktop app (smoke test). Unmapped statements
  show in the source gutter and the warnings panel. An interface map given in
  the UI or as a `--map` file changes the output names. The CLI exits
  non-zero when needs-input items are unanswered, unless `--allow-incomplete`
  is given.

◆ **B10. Phase 2 areas: VLANs, OSPF, BGP basics, for Junos and IOS-XE.** **M**
- *Goal:* the routing basics both ways.
- *Files:* `packages/core` (model fields), `packages/platform-junos`,
  `packages/platform-iosxe`.
- *Scope:* VLANs and access/trunk ports; OSPF single area, then multi-area;
  BGP neighbors, groups/peer-groups, simple import/export references. Policy
  bodies are placeholders with warnings (B11). Semantic warnings for the
  defaults that differ (OSPF `network` statements vs per-interface, default
  BGP import/export behaviour).
- *Needs:* B9.
- *Done when:* fixtures for each area pass the conformance kit for both
  plugins. Each semantic warning in the scope has a fixture that raises it.
  BGP policy references come out as placeholders plus a warning, never
  dropped.

◆ **B11. Phase 3 areas: prefix lists, policy ↔ route-maps, firewall filters ↔
ACLs.** **M–L**
- *Goal:* the policy and filter translation, where most of the value and risk
  is.
- *Files:* as B10.
- *Scope:* prefix-lists; simple policy-statements ↔ route-maps (match prefix
  list, set local-pref/community, accept/reject); firewall filter terms ↔
  extended ACLs (L3/L4 match, accept/discard/reject, count/log), including
  the implicit discard ↔ implicit deny difference. Anything more complex is
  reported as `unsupported`, per term.
- *Needs:* B10.
- *Done when:* fixtures pass the conformance kit for both plugins, including
  a negative case per unsupported construct (nested policy, `next term`,
  unsupported match conditions) that the ledger reports per term. The
  implicit-deny warning has a fixture.

◆ **B12. NX-OS plugin.** **M**
- *Goal:* NX-OS as a second Cisco platform.
- *Files:* `packages/platform-nxos` (+ model fields in `packages/core` only if
  needed).
- *Scope:* the areas the model has at the time (phase 1 at least); `feature`
  lines on render; `vrf context`; `mgmt0` in the `management` VRF; explicit
  `switchport`/`no switchport`.
- *Needs:* B2 (phase 1); B10/B11 for those areas.
- *Done when:* fixtures pass the conformance kit for every area the plugin
  claims in `capabilities`. A render that would need a `feature` line without
  emitting it fails a test.

◆ **B13. IOS-XR plugin.** **M–L**
- *Goal:* IOS-XR as a Cisco platform, including its policy language.
- *Files:* `packages/platform-iosxr` (+ model fields in `packages/core` only if
  needed).
- *Scope:* the indentation tree plus a delimiter-aware tokenizer for RPL
  (`route-policy … end-policy`, `*-set … end-set`, `if … endif`); until a
  policy's sub-parser handles it, each policy or set is one atomic
  `unsupported` statement. Phase 1 areas, then RPL for the simple cases B11
  defines. eBGP neighbors get a policy plus a warning (RFC 8212 behaviour).
- *Needs:* B2 (phase 1); B11 for RPL.
- *Done when:* fixtures pass the conformance kit for every area the plugin
  claims. An unindented RPL body stays one statement (never split). An eBGP
  neighbor without a policy raises the warning.

### Optional / later

**B14. Reverse display set (set → hierarchical).** **M**
- *Goal:* turn `set` lines back into hierarchical config, faithfully.
- *Files:* `packages/platform-junos` (schema loader, reverse flattener), a
  generated schema data file, and a notices entry for Juniper/yang
  (Apache-2.0).
- *Scope:* only if open question 4 says yes. A schema from Juniper/yang for
  one pinned Junos release, used to tell keywords from names and lists from
  leaves.
- *Needs:* B3.
- *Done when:* the jcc fixtures round-trip (hierarchical → set →
  hierarchical) to the same tree. The report's `unit 0` and `vlan-id-list`
  cases come out right. Unknown statements are an error, not a guess.

**B15. Benchmark against netcanon (optional).** **S**
- *Goal:* an outside comparison of what we and netcanon drop or flag.
- *Files:* `docs/benchmarks/netcanon.md` (the report) only. netcanon runs
  outside the repo; nothing of it is added.
- *Scope:* phase 1 fixtures through netcanon and through Dialect; per area,
  what each converts, flags or drops.
- *Needs:* B9.
- *Done when:* `docs/benchmarks/netcanon.md` lists both tools' results per
  fixture and area, with netcanon's version and the date, and names any case
  where Dialect drops something silently (each one becomes a bug card).

**What can run in parallel:** B1 → B2 run one at a time. After B2, three
lanes can run in separate worktrees: B3 → B4 (Junos), B8 (IOS-XE), and
B5, B6 → B7 → B16 (shells, which need only B3). B9 joins them. B10 → B11 run in
order. B12 and B13 can run in parallel with each other and alongside B10/B11,
taking turns on `packages/core`. B14 can run any time after B3.
