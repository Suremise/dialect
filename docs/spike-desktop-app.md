# Spike: desktop app for Junos config tools

Card #1. Research only; no product code. Checked on 2026-10-14. Throwaway code
backing the claims below is under `spike/` (see `spike/README.md`).

## Summary

- **Recommended stack:** Python 3.13+ (3.14 is installed here) + PySide6 (Qt), packaged as a signed
  onedir build inside an installer. Keep the conversion core a pure-Python
  package with no Qt imports, so it can be tested headless and gets a CLI for
  free. Details: [Desktop app stack](#desktop-app-stack).
- **Tool 1 (display set):** write our own small parser in Python. Don't wrap or
  port the prior art. The prior art the card points at
  ([saidvandeklundert/juniper-config-converter](https://github.com/saidvandeklundert/juniper-config-converter))
  is a **Rust** crate, not Python scripts. It has no syntax tree and several
  real bugs: a panic, a hang, corrupted `deactivate` lines and silently dropped
  characters. A 350-line stdlib prototype (`spike/display_set/junos_set.py`)
  produces the same lines as all 22 of its test fixtures (4,952 output lines)
  and fixes those bugs. It follows Juniper's documented `deactivate` ordering,
  which jcc gets wrong for stanzas. Size: **S**.
  The best Python alternative found, [junoscfg](https://github.com/dg-i/junoscfg)
  (MIT), is schema-driven and does the **reverse** (set → hierarchical)
  properly. But on our tests it matched only 18 of 22 of jcc's fixtures, with
  silent errors in some of them. Use it as a candidate for the reverse
  direction, not for the forward one.
- **Tool 2 (Junos ⇄ Cisco):** the user is broadly right. No mature tool does
  offline Junos ⇄ Cisco translation:
  - Batfish parses many vendors but never writes config.
  - Ansible's `parsed`/`rendered` resource modules use a different data shape
    for each vendor and are GPL-3.0.
  - Vendor migration tools are discontinued or not public.

  The one exception is new: [netcanon](https://github.com/netcanon/netcanon)
  (MIT, Python, started May 2026). It translates the basics (interfaces, VLANs,
  static routes, VRFs, SNMP) but deliberately **doesn't render** routing
  protocols, ACLs/firewall filters or route policy. Building on it vs building
  our own is a decision for the user (open question 1). If we build our own: a
  **hub model**, where each platform plugin parses into a shared,
  OpenConfig-shaped model and renders from it. The core, not the plugin,
  checks that every source *statement* and every populated model *field* got
  an explicit disposition (mapped, rendered or unsupported), so nothing is
  dropped silently. That's accounting, not a proof that the output behaves
  the same.
- **Sizes for the MVP feature set, per plugin:** Junos (the hub side) **M–L**,
  IOS/IOS-XE **M**, NX-OS **M**, IOS-XR **M–L** (its route-policy language is
  the hard part).
- **Plugins:** first-party plugins are separate Python packages, found through
  entry points and bundled into the installer. Leave third-party drop-in
  plugins out of v1.
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
or do the reverse direction. Its language is Rust, so using it from the
recommended Python app means PyO3 bindings or a subprocess, for about 600 lines
of logic that are simpler to rewrite.

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
| Wrap jcc (PyO3 or a subprocess) | No. It's Rust, buggy, abandoned, and has no tree to reuse. |
| Port jcc's logic | No. Its streaming design is what causes the bugs. |
| Depend on junoscfg for the forward direction | No. Silent errors on 4/22 real fixtures (above), a young single-maintainer project, and a large dependency (schema files, Lark, netutils) for a job a small tree parser does exactly. |
| **Write our own: tokenizer → generic tree → flatteners** | **Yes.** It's small, it gives one tree for display-set, the reverse and the Junos plugin's model mapping, and we control the error messages. Borrow Batfish's design and jcc's MIT fixtures as test data. |

The throwaway prototype `spike/display_set/junos_set.py` (stdlib only) shows
the size of the job:

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

A grammar library isn't needed for the curly-brace syntax: the hand-written
tokenizer is about 60 lines. If we want one later,
[Lark](https://pypi.org/project/lark/) (MIT, 1.3.1) is the fit. junoscfg
already generates a Lark grammar from the Junos schema. There is no
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

junoscfg's reverse already worked correctly in my test (above). So the options
are:
- adopt junoscfg for the reverse only, behind our own interface, with our
  fixtures guarding it: **S–M**;
- build our own schema loader: **M**.

The cheap version, folding chains as above, isn't good enough to ship.

### Tool 1 MVP scope

1. Hierarchical → set, using the tree parser. Paste or open a file, copy or
   save the output, see errors with line numbers, list annotations that were
   dropped. **S**.
2. Options: show `deactivate`/`protect` lines or not; strip `SECRET-DATA`
   lines. **S**.
3. (Later, if wanted) set → hierarchical, schema-driven: either wrap
   junoscfg's reverse (**S–M**) or build our own from Juniper/yang or the
   device XSD (**M**).

---

## Tool 2: Junos ⇄ Cisco converter

### What exists, and why it isn't enough

Checked 2026-10-14 against each project's repo, PyPI or docs. Statuses
(archived, license, last push) come from the GitHub API that day. **UNVERIFIED**
marks what I couldn't confirm from a primary source.

| Tool | What it is | License / status | Why it isn't enough |
|---|---|---|---|
| [**netcanon**](https://github.com/netcanon/netcanon) | "Multi-vendor network config translator". Python, with a shared canonical model; every field is labelled supported, lossy or unsupported. Codecs include IOS-XE CLI, NX-OS, IOS-XR and Junos (set form; hierarchical input is converted to set form first, per [CAPABILITIES.md](https://github.com/netcanon/netcanon/blob/HEAD/docs/CAPABILITIES.md)). FastAPI web UI plus a Windows PySide6 shell | MIT; created 2026-05-13, PyPI 0.7.7 (2026-10-08), 11 stars | **The closest thing to Tool 2, and new.** By design its "Tier 3" (firewall rules/ACLs, route-maps/policy, **dynamic routing protocols**, QoS, NAT) is detected and listed but **never rendered**. Its README also says that where a codec doesn't handle a field, "the source-side value is currently dropped without a banner". So it covers our phase 1 but not phases 2–3, which are the valuable part. **Not run hands-on:** `pip install` failed on Windows path length in my scratch folder, so this is from its docs only |
| [**Batfish**](https://github.com/batfish/batfish) / pybatfish | Java analysis engine. It parses Junos (MX/EX/QFX/SRX…), IOS, IOS-XE, NX-OS, IOS-XR, ASA, Arista and more into a vendor-independent model, then answers reachability and policy questions | Apache-2.0, very active (1.5k stars) | **Parse-only**: there's no config writer, and the model keeps derived semantics rather than the syntax needed to re-render. Good reference for our model (routing policy, ACL semantics) and for the Junos flattener |
| [**Ansible network resource modules**](https://github.com/ansible-collections/cisco.ios) (`state: parsed` / `state: rendered`) | Offline parse → structured data → render, per resource (interfaces, l3_interfaces, vlans, static_routes, ospfv2, bgp_global, acls, prefix_lists, ntp_global, snmp_server, logging_global, …), for Junos, IOS, NX-OS and IOS-XR | **GPL-3.0**. cisco.ios/nxos/iosxr active. The `junipernetworks.junos` repo is **archived**; the code now lives in [Juniper/ansible-junos-stdlib](https://github.com/Juniper/ansible-junos-stdlib) (`ansible_collections/juniper/device`, still GPL-3.0 per the module headers) | **The data shapes are per vendor, not shared** (e.g. Junos static routes use `next_hop[].forward_router_address`, IOS uses `next_hops[]`), so every resource needs mapping glue. The **Junos side takes and emits XML** (`parsed` expects `<rpc-reply><configuration>…`; `rendered` emits `<nc:routing-options …>`), not set or brace text. There's no users/AAA resource, and GPL-3.0 rules out embedding unless the app is GPL. Useful as a test oracle |
| [**ciscoconfparse2**](https://github.com/mpenning/ciscoconfparse2) (and the archived [ciscoconfparse](https://github.com/mpenning/ciscoconfparse)) | Parses indented configs into parent/child line objects for querying. Its Junos support strips braces and re-indents "as IOS would" | **GPL-3.0**; ciscoconfparse archived (last release 2024-11); ciscoconfparse2 0.9.18 | A text-tree query tool with no model and no translation. GPL |
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
policy and filters. netcanon now covers the simple L1–L3 basics, and is worth
evaluating before we build our own (open question 1). Batfish, OpenConfig and
Aerleon are the design references. Avoid embedding the GPL-3.0 ones
(ciscoconfparse2, the Ansible collections) unless the app is GPL.

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
  (Apache-2.0) and implement them as plain
  Python dataclasses. YANG tooling isn't worth it for an offline converter.
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

A Python package (e.g. `juniper-platform-junos`) that exposes one object
implementing this interface. It's illustrative, not final:

```python
class PlatformPlugin(Protocol):
    id: str                      # "junos", "ios", "nxos", "iosxr"
    name: str                    # "Cisco IOS / IOS-XE"
    model_api: str               # model versions it supports, e.g. ">=1.2,<2"
    capabilities: Capabilities   # per feature area: parse/render = full | partial | none

    def detect(self, text: str) -> float: ...                     # 0..1, for auto-detect
    def parse(self, text: str, ctx: Context) -> ParseResult: ...  # tree + model + statement dispositions
    def render(self, model: Device, ctx: Context) -> RenderResult: ...  # text + field dispositions
    def tools(self) -> list[Tool]: ...  # extra platform-only actions (Junos: display set)
```

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
- **Fixtures** ship with each plugin: `fixtures/<area>/<case>.cfg` +
  `<case>.model.json` (+ `<case>.rendered.cfg`). The core provides a pytest
  conformance kit that runs every plugin's fixtures through four checks:
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

- The model is its own package (`juniper-model`) with semver. A plugin
  declares the range it supports (`model_api`), and the core refuses to load a
  plugin outside that range with a clear message.
- **Minor = additive only:** new optional fields and new object types. An
  old renderer never assigns a disposition to a field it doesn't know, so
  the ledger's per-field check reports any populated new field as unrendered.
  Additions can't cause silent drops.
- **Major = breaking.** These should be rare: renames, changed meanings.
  Migrate all first-party plugins in the same release.
- Every serialised model (fixtures, and saved sessions if we add them) carries
  `model_version`, so fixtures can be upgraded by script.

### Display set: Junos plugin feature or separate tool?

**A Junos plugin tool, sharing the Junos plugin's tree parser.** Display set is
Junos → Junos and never touches the shared model, so it is exposed through
`tools()` rather than parse/render. Because the same tree feeds both, a fix to
the Junos parser fixes both tools. In the GUI it still appears as its own
top-level mode ("Junos: display set"), so the user doesn't have to think about
plugins.

### Finding and loading plugins

- **First-party plugins are separate packages in the same repo**
  (monorepo, one `pyproject.toml` each). They are registered through the
  standard [entry points](https://packaging.python.org/en/latest/specifications/entry-points/)
  group `juniper.platforms` and bundled into the installer.
- In the frozen app, PyInstaller doesn't collect package metadata by default.
  Use its hook helpers `copy_metadata` / `collect_entry_point`
  ([docs](https://pyinstaller.org/en/stable/hooks.html)). Also keep an explicit
  built-in registry as a fallback, so discovery can't fail silently.
- **Third-party / drop-in plugins: not in v1.** It's technically easy
  (a `plugins\` folder next to the exe, loaded with `importlib`; find it via
  `sys.executable`, not the temp extraction folder, see
  [PyInstaller runtime info](https://pyinstaller.org/en/stable/runtime-information.html)).
  But:
  - a plugin is arbitrary code running with the user's rights, next to
    configs that hold secrets;
  - a dropped-in plugin can only import libraries already frozen into the app;
  - we'd be committing to a stable public API early.
  Revisit once the model has reached 1.x and stayed stable.

---

## Desktop app stack

Versions and dates were checked on PyPI, npm, NuGet and the vendors' docs on
2026-10-14.

| | **Python + PySide6** (recommended) | **Tauri 2** (Rust + TS web UI) / Electron | **.NET 10 + Avalonia/WPF** |
|---|---|---|---|
| Current | [PySide6](https://pypi.org/project/PySide6/) 6.12.0 (2026-10-08, Python 3.10–3.15) | Tauri 2.12.x; Electron 44.x | .NET 10 LTS (to 2028-11). **.NET 8 and 9 both end support on 2026-11-10** ([policy](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core)). Avalonia 12.1.4 |
| Windows packaging | PyInstaller 6.22 or Nuitka via Qt's [`pyside6-deploy`](https://doc.qt.io/qtforpython-6/deployment/deployment-pyside6-deploy.html), then an installer. [Briefcase](https://briefcase.beeware.org/en/stable/reference/platforms/windows/index.html) builds an MSI. **Use onedir, not onefile:** onefile unpacks to a temp folder on every launch, so it starts slower ([PyInstaller docs](https://pyinstaller.org/en/stable/operating-mode.html)) | MSI or NSIS; WebView2 already ships with Windows 11 ([docs](https://v2.tauri.app/distribute/windows-installer/)). Electron via Forge (Squirrel/WiX/MSIX) | `PublishSingleFile` + self-contained ([docs](https://learn.microsoft.com/en-us/dotnet/core/deploying/single-file/overview)) |
| Reuse of Python parsing libs | Native | Only as a **sidecar** exe (Tauri's [sidecar docs](https://v2.tauri.app/develop/sidecar/) suggest a PyInstaller-built CLI), so you still get the PyInstaller exe plus an IPC protocol. Otherwise rewrite the parsers in TS/Rust | [pythonnet](https://pythonnet.github.io/pythonnet/dotnet.html) 3.2.1. You bundle and initialise CPython yourself, and every call holds the GIL. Painful |
| Plugins | Entry points + importlib. Works frozen with PyInstaller's `copy_metadata`/`collect_entry_point` ([hooks](https://pyinstaller.org/en/stable/hooks.html)) | Tauri plugins are **compile-time** Rust crates ([docs](https://v2.tauri.app/develop/plugins/)). Runtime plugins need WASM (e.g. Extism, which has no Python PDK) or JS modules. Electron: JS modules, easy | The strongest model: `AssemblyLoadContext` per plugin ([docs](https://learn.microsoft.com/en-us/dotnet/core/tutorials/creating-app-with-plugin-support)) |
| Languages for a solo dev | 1 | 2–3 | 1 (C#), plus Python if reused |
| Main risks | Antivirus false positives on PyInstaller exes, which [PyInstaller says it can't fix](https://github.com/pyinstaller/pyinstaller/blob/develop/.github/ISSUE_TEMPLATE/antivirus.md). Qt's [LGPL obligations](https://www.qt.io/licensing/open-source-lgpl-obligations), where onedir keeps the DLLs replaceable. Bundle size (the PySide6-Essentials wheel alone is 82 MB, so expect a large install; trim unused Qt modules) | Two runtimes. The parser rewrite loses Python reuse | Parsers in C#, or the pythonnet pain |
| Effort | Lowest | Highest | Medium if the developer knows C# |

**Recommendation: Python 3.13+ (3.14 is installed here) + PySide6, onedir build with an installer,
code-signed.**
- It is one language, and the parsing ecosystem we'd lean on (our own Junos
  parser, Lark if needed) is Python.
- It has a plain plugin story that works when frozen.
- The core package stays Qt-free, so it also ships as a CLI and is tested
  without a GUI.
- Windows 11 first is fine. Qt also keeps macOS and Linux open later at no
  extra cost.

When to choose otherwise:
- **Tauri:** only if a web-tech UI is a hard requirement.
- **.NET 10 + Avalonia:** only if the work will be done in C# and rewriting the
  parsers in C# is acceptable.
- Python web-UI wrappers (pywebview 6.2, NiceGUI 3.18, Flet 1.0) keep Python
  but have weaker desktop widgets for a large side-by-side editor with gutters.

Libraries to avoid depending on: [ciscoconfparse2](https://pypi.org/project/ciscoconfparse2/)
is GPL-3.0, which would force the app to be GPL. Useful as a reference only.

### UI sketch

```
┌ Juniper Config Tools ───────────────────────────────────────────────────────────┐
│ Mode: (•) Display set   ( ) Convert         [Open…] [Paste] [Save output] [Copy]│
│ Source: [Junos      ▾] (auto: Junos 0.97)  →  Target: [Cisco IOS-XE ▾]  [Convert]│
├───────────────────────────────────────┬─────────────────────────────────────────┤
│ SOURCE                                │ OUTPUT                                  │
│  1 interfaces {                       │  1 hostname r1                          │
│  2     ge-0/0/0 {                     │  2 !                                    │
│  3         description uplink;        │  3 interface GigabitEthernet0/0/0       │
│  4         unit 0 {                   │  4  description uplink                  │
│  5             family inet {          │  5  ip address 10.0.0.1 255.255.255.0   │
│▌ 6                 filter input F;    │  6 !                                    │
│  …  (unmapped lines marked ▌)         │  (click a line ↔ highlights its source) │
├───────────────────────────────────────┴─────────────────────────────────────────┤
│ Warnings (3)  [Unmapped 1] [Semantic 1] [Needs input 1]                         │
│  ▌ line 6  firewall filter input F: ACLs not in phase 1, not converted          │
│  ⚠ line 12 OSPF: interface-level config rendered as `ip ospf` (check area)      │
│  ? ge-0/0/0 → GigabitEthernet0/0/0  (edit interface map…)                       │
└─────────────────────────────────────────────────────────────────────────────────┘
```

The editors are Qt `QPlainTextEdit` with line numbers and a gutter, plus a
syntax highlighter per platform. Each plugin can supply its own highlighting
rules.

---

## Risks

1. **Semantic correctness.** Output that parses but behaves differently is
   worse than no output. To mitigate: semantic warnings, conservative
   defaults, and fixtures reviewed against real devices or labs.
2. **Test data.** Good fixtures need real, sanitised configs from each platform
   and version. Without them the estimates above slip.
3. **Version drift.** Junos and Cisco syntax changes across releases. Pin
   supported ranges per plugin and say so in the UI.
4. **Secrets.** Configs hold password hashes and keys. Keep the app fully
   offline with no telemetry, and never write secrets to logs.
5. **Packaging friction.** PyInstaller exes get antivirus false positives.
   Plan to code-sign and to submit false positives to the AV vendors.
6. **Scope creep across platforms.** Each new platform is a whole plugin with
   fixtures. Ship one pair end to end before starting a second.
7. **LGPL (Qt).** Use the onedir layout, which keeps Qt DLLs replaceable, and
   ship the license notices. If the app is ever distributed commercially,
   confirm the licensing (not legal advice).

## Open questions for the user

1. **Build our own Tool 2, or build on netcanon?**
   [netcanon](https://github.com/netcanon/netcanon) (MIT, Python, five months
   old) already does Junos ⇄ IOS-XE/NX-OS/XR for interfaces, VLANs, static
   routes, VRFs and SNMP, but by design doesn't render routing protocols,
   policy or ACLs/filters. The options:
   - (a) build our own as this report describes, using netcanon as a benchmark;
   - (b) contribute phases 2–3 upstream;
   - (c) fork it.

   Recommendation: evaluate it hands-on first (follow-up card 0), then decide.
   Our design differs on purpose: a core-enforced "no silent drops" check, and
   a desktop app first rather than a web app.
2. **Direction and first platform for Tool 2:** Junos → Cisco or Cisco →
   Junos first, and which Cisco platform (IOS-XE suggested)?
3. **Sample configs:** can you provide sanitised real configs (Junos and the
   chosen Cisco platform) for fixtures? This is the biggest factor in quality.
4. **Junos families in scope:** MX/EX/QFX (routing and ELS switching)? Are SRX
   security zones, policies and NAT out of scope?
5. **Reverse display set (set → hierarchical):** needed? If so, wrap
   junoscfg's reverse (**S–M**, adds a young third-party dependency) or build
   our own schema loader (**M**)?
6. **Annotations:** should display set output include `/* comments */`
   (Junos has an `annotate` command), or drop them with a warning as the
   prototype does? A device capture would show what Junos itself prints.
7. **Who gets the app:** just you, or a team or customers? That decides code
   signing, an installer vs a zip, and how much the LGPL/onefile question
   matters.
8. **Third-party plugins:** OK to leave out of v1 as recommended?
9. **Open source or private?** This affects licensing choices: ciscoconfparse2
   and the Ansible collections are GPL-3.0, so we'd avoid depending on them
   unless the app is GPL.

## Suggested follow-up build cards

Not created on the board; the user decides what gets built.

0. **Evaluate netcanon hands-on** (1–2 days). Run it on the same sample
   configs, check its warnings and silent drops, and report build vs extend
   (open question 1). Note: installing it on Windows hit path-length limits
   in a deep folder. **S**
1. **Repo skeleton**: monorepo with `juniper-core` (model, plugin API, coverage
   checks, CLI), `juniper-gui` (PySide6) and `juniper-platform-junos`; pytest
   and the plugin conformance kit; CI on Windows. **S**
2. **Junos tree parser + display set**: productionise the spike parser, with
   jcc's fixtures (MIT, attributed; fix the `deactivate` order in config_8, 15
   and 16 to Juniper's documented order) and our edge cases. **S**
3. **GUI shell**: source/output panes, open/paste/save/copy, warnings panel,
   display-set mode. **S–M**
4. **Packaging**: PyInstaller onedir + installer + signing + LGPL notices;
   smoke test on clean Windows 11. **S**
5. **Shared model v0 + coverage ledger** (per-statement and per-field
   dispositions, the two counterexample negative tests, display-only spans,
   warnings). **M**
6. **Junos plugin: map tree → model, phase 1 areas**, including apply-groups
   expansion. **M**
7. **First Cisco plugin (IOS-XE suggested): parse and render, phase 1 areas.**
   **M**
8. **Interface-name mapping UI + Convert mode end to end.** **S**
9. Phase 2 areas (VLANs, OSPF, BGP basics) for both plugins. **M**
10. Phase 3 areas (policy, filters ↔ ACLs). **M–L**
11. Second and third Cisco plugins (NX-OS, IOS-XR), each its own card. **M**,
    **M–L**
12. (If wanted) set → hierarchical: wrap junoscfg's reverse (**S–M**) or our
    own schema loader (**M**).
