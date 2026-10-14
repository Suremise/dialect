# Dialect: product decisions

The source of truth for what Dialect is and the decisions behind it. It takes over the decisions recorded in the
workspace note `juniper-decisions.md` and in the spike report ([spike-desktop-app.md](spike-desktop-app.md), whose
research and reasoning stay there). Update this file in the same change when a decision changes; only the user makes
product decisions.

## 1. What Dialect is

- **Name:** the product's working name is **Dialect**. The local project and folder stay `juniper`.
- **What it does:** translates network device configs between vendor "dialects", fully offline:
  - **Junos display set**: hierarchical Junos config to `set` commands (a Junos-only tool, shared with the Junos
    plugin's parser). The app counts its output in commands (`set`, `deactivate` and `protect` alike); when a quoted
    value's line breaks (a banner) make the output longer than that, it gives the line count too ("2 commands (4
    lines)"). Each output line links to its statement.
  - **Convert**: between Junos and the Cisco platforms (IOS/IOS-XE, NX-OS, IOS-XR), any to any, through a shared
    model (§4).
- **Three products from one TypeScript core:**
  - the **desktop app** (Tauri 2, Windows, NSIS installer only, no MSI);
  - the **offline web build**, one self-contained HTML file opened from disk, for laptops where installing isn't
    allowed;
  - the **command-line tool** `dialect` (Node 24), on files or stdin/stdout: results to stdout, warnings and errors
    to stderr with their line and column. Exit codes: 0 done, 1 a syntax error in the config, 2 a usage error or
    unreadable input, 3 a conversion with interfaces left unnamed (unless `--allow-incomplete`).
- **Offline and private:** no network access, no telemetry, and secrets in configs are never written to logs. A strict
  content security policy blocks remote content in both shells. The web build's allows only its own inlined script
  and styles, by hash, and no network at all.

## 2. Stack and repository

- **TypeScript (strict mode)** for the core, the plugins and the UI. Desktop app via **Tauri 2**; the only Rust is
  Tauri's thin, mostly generated shell, and no conversion logic lives there: conversion runs in the webview, from the
  same bundled code as the web build. (Replaces the spike's first Python + PySide6 recommendation.)
- **UI:** React 19, zustand 5 and **CodeMirror 6** for the editors. The spike planned Monaco, but it needs
  `unsafe-inline` styles and `blob:` workers, which the web build's CSP doesn't allow, and is 3.1 MB to CodeMirror's
  0.3 MB (docs/ARCHITECTURE.md, "Editor").
- **npm workspaces monorepo**, every package under the `@dialect/` scope:

  | Folder | Package | What |
  |---|---|---|
  | `packages/core` | `@dialect/core` | Shared model (+ `MODEL_VERSION`), coverage ledger, plugin interface, registry. No UI, Node or DOM APIs |
  | `packages/conformance` | `@dialect/conformance` | Dev-only: the Vitest conformance kit for plugins, with negative tests |
  | `packages/platform-junos` | `@dialect/platform-junos` | Junos: tree parser, display set tool, mapping to and from the model |
  | `packages/platform-*` | `@dialect/platform-*` | One package per further platform (IOS-XE first) |
  | `packages/cli` | `@dialect/cli` | The `dialect` command |
  | `packages/ui` | `@dialect/ui` | The React UI both shells share |
  | `apps/web` | `@dialect/web` | The offline single-file build |
  | `apps/desktop` | `@dialect/desktop` | The Tauri 2 shell |

- **Conventions from Hive** (`D:\Development\HIVE\hive`, TypeScript, MIT, same owner) are the quality bar. Borrow its
  ideas, conventions and code freely, but **read it only and never change anything there**. Adopted so far: its
  TypeScript settings, oxlint with `--deny-warnings` and no Prettier, Vitest with tests that wait for conditions, Windows
  CI, the generated third-party notices, the line-endings test, the icon pipeline, `AGENTS.md`, this SPEC and a
  `CHANGELOG.md` with an Unreleased section. What doesn't carry over (Electron-only) is listed in the spike report.
- **npm 12, pinned** (`packageManager: npm@12.2.0`, `engines.npm >=12`), for its default deny of install scripts: only
  packages approved in `allowScripts` run theirs. CI installs npm 12 before `npm ci`.
- **The desktop app** (B7): Tauri 2 around the same UI, Windows first. An **NSIS installer only**
  (`Dialect_<version>_x64-setup.exe`), installed **per user** (no admin), with NSIS's **zlib** compression (its LZMA
  module is CPL-licensed) and Tauri's default WebView2 mode (download the bootstrapper only if WebView2 is missing). No
  MSI: Tauri builds it with WiX 3 (MS-RL). **Unsigned** until there is a certificate: the build runs a signing hook
  (`apps/desktop/scripts/sign.mjs`) that signs only when `DIALECT_SIGN_COMMAND` is set. A **strict CSP** (nothing remote,
  no inline code, IPC only). Open and save go through the system dialogs, and the app can read and write only the
  files the user picks there; a dropped file is read from the drop itself. Agents build the installer and run the
  smoke test, but **never run the installer**: Darren installs and tests it himself. The **Dialect icon** is on the
  installer, the window and taskbar, and in the **notification area** (#82): left-click shows the window, the menu has
  Show Dialect, New tab and Quit, and Quit goes through the close guard. **Closing the window quits the app**: no
  minimise-to-tray, as Dialect needn't run in the background (Darren's decision; a setting only if he asks).
- **Versions:** semver 0.x until the model and the plugin API are stable.

## 3. License

- **The whole project is MIT.**
- **The license rule has three categories:**
  - **Shipped** (anything bundled into the desktop app, the web build or the CLI; the Tauri runtime crates; the
    installer's components; copied code that ends up in a product): MIT or equally permissive. The allowlist is
    MIT, MIT-0, Apache-2.0 (its NOTICE text kept), BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, Zlib, Unicode-3.0, BSL-1.0,
    CC0-1.0 and Unlicense. **MPL-2.0 used unmodified is pre-approved** (e.g. Tauri's MPL crates); if one is ever
    modified, its changed files stay MPL and open. GPL, LGPL, AGPL, other copyleft (CPL, MS-RL) and no license are not
    allowed.
  - **Build-only** (never ships: compilers, linters, test runners, the icon pipeline's sharp/libvips): any open-source
    license, GPL and LGPL included. They are **listed** in the generated `docs/BUILD_ONLY_PACKAGES.md`, not just allowed
    silently, and one with no license or a non-open-source license fails.
  - **Copied, not shipped** (third-party material copied into the repo that never ships: the test configs in
    `fixtures/`): the same allowlist as shipped, but its attribution is its license text (and NOTICE file, if it has
    one) in `fixtures/LICENSES/`, with each file's provenance in `fixtures/manifest.json`, and it isn't listed in
    `THIRD_PARTY_NOTICES.md`. If any of it ever ships (as samples, say), it moves to the shipped category.
    `npm run licenses` and a unit test check every source against the allowlist and `fixtures/LICENSES/` (decided
    2026-10-14).
  - Anything else fails unless it is a recorded exception (`EXCEPTIONS` in `scripts/licensePolicy.mjs`): the package,
    its license, why, and who decided. Only the user decides one.
- **`THIRD_PARTY_NOTICES.md` is generated** from what actually ships (`npm run licenses`): every package with a link,
  version, license and full license text, the products it ships in (a package that publishes no license file, or that
  only another platform installs, needs a reviewed supplement with its text, or the check fails), plus hand-written
  entries for material that ships but isn't a package (`scripts/notices`; copied, not shipped material isn't listed). It
  also covers the desktop app's **Rust crates**: only those compiled into the app (found with `cargo tree`), while the
  proc-macros and build scripts that run on the build machine are build-only. A crate that publishes no license file
  needs a reviewed supplement, as a package does. The installer's components (NSIS, its `nsis_tauri_utils` plug-in)
  and the Microsoft WebView2 loader linked into the app are hand-written entries. A license text that is the same as
  one given earlier is given once and referred to. So `npm run licenses` needs Rust (cargo). **A package or crate
  offered under a choice of licenses** (an SPDX `OR`) is used under MIT where it is offered, otherwise under the first
  choice the shipped rule allows, decided at each `OR` (`(MIT OR Apache-2.0) AND Unicode-3.0` is used under
  `MIT AND Unicode-3.0`). This is worked out, never listed by hand, and each entry says so: "MIT OR Apache-2.0, used
  under MIT" (decided 2026-10-14). **Every link Dialect gives
  is a working `https://` URL, or there is none**; quoted license texts keep their own words, addresses included. `npm run licenses -- --check` and a unit test fail when either generated file is stale or the rule
  is broken.
- **netcanon:** use it **for ideas only**. We write our own converter: don't depend on it, fork it or wrap it. It may be
  used as an optional benchmark.

## 4. Platforms as plugins

- **Each platform** (Junos, IOS/IOS-XE, NX-OS, IOS-XR, …) **is its own plugin**, a workspace package whose default
  export implements `PlatformPlugin` from `@dialect/core`. Plugins take and return strings and plain objects: no file
  system, DOM or Node APIs, so they run unchanged in the CLI, the desktop app and the browser.
- **A hub model:** each plugin parses into a shared, OpenConfig-shaped model and renders from it. The core, not the
  plugin, checks that every source statement and every populated model field got an explicit disposition (mapped,
  rendered, ignored by design or unsupported), so nothing is dropped silently.
- **The model has its own semver** (`MODEL_VERSION`); a plugin declares the range it supports (`modelApi`), and the
  registry refuses one outside it. Minor versions only add.
- **Built in at first**, through a static registry each shell imports. Loading plugins at runtime comes later;
  third-party drop-in plugins stay out of v1.
- **Junos scope:** MX, EX and QFX, routing and switching. Switching is ELS only (`vlans`, `family
  ethernet-switching` and IRB, converted from model 0.4), not the older non-ELS syntax, which shows as `unsupported`. Both the hierarchical and
  the set form are read, and `apply-groups` and `interface-range` are expanded before mapping. SRX security zones,
  policies and NAT come later: until then they show as `unsupported` in the ledger, never dropped.
- **Routing policy (phase 3, model 0.5):** prefix lists, community and AS-path sets and policies convert **term by
  term**: a term converts whole or not at all, and when leaving one out could change what a later term sees, the whole
  policy is left out. A regular expression is never translated between dialects, a policy's fall-through (Junos goes
  on to the next policy, Cisco rejects) is kept with the model and a target whose fall-through differs says so, and
  where a platform reads the same words another way (Junos matches route filters by longest match) the term isn't
  converted rather than converted wrongly. Junos converts `policy-options` (prefix lists, communities, AS paths and
  policy-statements) and resolves BGP `import` and `export` to them (#76); `vrf-import` and `vrf-export` wait for a
  place in the model (#83).
- **Convert goes Junos → IOS/IOS-XE first** (B9); the reverse follows, from the same plugins, then NX-OS and IOS-XR.
  With all four plugins registered (#50), the CLI and the app convert from any of them to any other.
- **Interface names never map silently.** Every interface a config names, configured or only referenced (a next hop,
  a source interface), needs a name on the target from the user: in the app's interface table, or a `--map` file on
  the command line (`from,to` lines or a JSON object). A plugin may suggest names (Junos `ge-0/0/0` → IOS
  `GigabitEthernet0/0/0`), shown as suggestions and used only once the user takes them. Every target suggests a name
  for an aggregate: Junos `aeN` ↔ Cisco `Port-channel(N+1)`, NX-OS `port-channel(N+1)`, IOS-XR `Bundle-Ether(N+1)`,
  the number kept between Cisco platforms. A plugin describes an aggregate (PortName) by its number counted from 1, as
  Cisco does, so no target needs to know the source. **IRB units are named one by one** (#80): a routed VLAN interface
  with several units (Junos `irb.100`, `irb.200`) is a row per unit, each becoming its own interface on a target with
  one per VLAN; the target suggests Junos `irb.N` ↔ Cisco `VlanN` (IOS-XE, NX-OS; IOS-XR not yet), and SVIs named as
  units (`Vlan100` → `irb.100`) become units of one interface. Until every interface is named,
  the CLI writes no config and exits 3; `--allow-incomplete` writes it anyway, the unnamed interfaces keeping their
  source names and their lines listed on stderr. Messages give an interface's line, never its name (a name can be a
  secret's value reused); `--write-map` writes the names, with suggestions, to a file the user chose. Two interfaces
  never end up with one name: such answers are refused, never merged.
- **Routing policy converts term by term** (phase 3): prefix lists, community and AS-path lists, and policies (Junos
  policy statements, Cisco route maps). A list is converted whole or not at all, and a policy term by term, each whole or
  not at all; the whole policy is left out when leaving a term out would change what later terms see. Regexes are kept
  as written and never translated between platforms. Where the target treats a route no term decides differently, it
  says so: IOS/IOS-XE, whose route maps deny such a route, adds a final permit sequence for a Junos policy that passes
  it on (BGP's default accepts it), with a semantic warning. A BGP route map the IOS config never defines isn't
  converted, as IOS then denies every route.

## 5. Configs and test data

- **Only cleaned-up configs go into the repo.** Before committing one, remove passwords and password hashes, SNMP
  communities, keys, public IP addresses, hostnames and customer names. Use the documentation ranges `192.0.2.0/24`,
  `198.51.100.0/24`, `203.0.113.0/24` and `2001:db8::/32`.
- Third-party test data copied in must be MIT or equally permissive and keeps its attribution in `fixtures/LICENSES/`
  (copied, not shipped: see §3).

## 6. Trademarks

- Keep "Juniper", "Junos" and "Cisco" out of the product name and branding. Package names may describe the platform
  they read and write (`platform-junos`).
- The app says it isn't affiliated with or endorsed by either vendor.

## 7. The window: tabs and menus (UI shell)

- **The same in the desktop app and the web build:** an in-app menu bar, a strip of document tabs and the tab shown.
- **Tabs:** one per conversion or Docs page. A new tab (File → New Tab, Ctrl+T, or "+") asks what the user is doing:
  each plugin tool (today Display set, Junos) or convert from any platform convert reads to any other it writes
  (Junos, IOS/IOS-XE, NX-OS, IOS-XR), listed from the plugin registry so new platforms and tools appear without UI
  changes; a convert tab can change its source and target. Each tab keeps its own job, source,
  file name, output, interface map, problems and editors' undo history. Its title is the file name and job
  ("phase1.conf → IOS-XE", or "Untitled"), with a dot while its output is unsaved and the full path in a tooltip.
  Closing one with unsaved output (×, middle-click, Ctrl+W) asks first: save and close, close without saving, or
  cancel. Each Docs page has one tab, shown again rather than opened twice. Leaving Dialect with unsaved output asks
  too: File → Exit, the desktop window's ✕ or Alt+F4 ask in the app's Exit dialog, and closing or reloading the web
  build's browser tab has the browser ask (`beforeunload`).
- **On restart** the tabs come back with their jobs, file names and Docs pages, and which was shown, but **never config
  contents**, nor the output or the interface names: configs can hold secrets. A restored tab offers to reopen its file.
  Contents live in memory only, never in localStorage, sessionStorage or IndexedDB (the web tests check all three).
- **Menus:** File (New Tab, Open, Save Output, Save Output As, Close Tab, and Exit in the desktop app only), Edit (Undo,
  Redo, Copy Output, Paste), View (the theme: system, light or dark), Window (each open tab, the current one ticked,
  then Next and Previous Tab: Ctrl+Tab, Ctrl+Shift+Tab, and Ctrl+1–9) and Help (User Guide, Release Notes, License,
  Third-Party Notices, About Dialect). Every item is a command in one registry with its keybinding, as in Hive. A
  browser keeps Ctrl+T, Ctrl+W, Ctrl+Tab and Ctrl+1–9 for itself, so the web build also has, and shows, Alt+T, Alt+W,
  Alt+PgDn/PgUp and Alt+1–9.
- **Keyboard and accessibility:** WAI-ARIA's menubar and tablist patterns: Alt or F10 to the bar, the arrow keys, Home,
  End, Enter and Esc in the menus; the arrow keys and Delete in the tab strip; roles, `aria-checked`, `aria-selected`
  and visible focus.
- **Every control is visibly a control:** buttons, tabs, menus and inputs have a distinct edge from the panel behind
  them (3:1 at least, in light and dark), the current tab is marked with the accent, and focus rings show. A narrow
  window keeps the menu bar and scrolls the tab strip sideways.

## 8. In-app About and Docs

- Like Hive: an **About dialog** (Help → About Dialect) and **Docs** pages, each in its own tab (§7), that bundle the user guide
  ([USER_GUIDE.md](USER_GUIDE.md)), the release notes ([CHANGELOG.md](../CHANGELOG.md)), the License and the
  Third-Party Notices, in the desktop app and the web build alike (B16).
- The documents are the committed files, bundled at build time and rendered with marked and DOMPurify; a test fails
  when what the UI bundles differs from the committed file, and the license check keeps the committed notices current.
  The notices make the web build's single file about 1.1 MB (0.59 MB without the Docs).
- About (modelled on Hive's) shows the icon, the name, a one-line description, then the version, the build (desktop or
  web), the WebView2 or browser version and the OS where the browser tells it, with Copy for those rows. "Open source
  under the MIT License. Includes third-party software." links to the License and Third-Party Notices pages, and a
  Release Notes button opens the release notes. In small print, word for word (README.md's Trademarks section is the
  same text, and a test keeps them so): "© 2026 Darren Marshall. Dialect is independently developed and isn't
  affiliated with, endorsed or sponsored by Juniper Networks or Cisco Systems. Juniper and Junos are trademarks of
  Juniper Networks, Inc.; Cisco, IOS, IOS-XE, NX-OS and IOS-XR are trademarks of Cisco Systems, Inc."
- Links in the Docs never navigate the app's own page: a link to another bundled document opens it, and an `https://`
  link opens outside the app (the default browser through Tauri's opener plugin, which the desktop app may use for
  `https://` URLs only; a new tab in the web build).

## 9. Icon and theme

- The icon is concept **B, Braces to block**: a violet circle with a `{` opening onto indented lines (`branding/`).
- **Its violet palette is Dialect's theme colour** and runs through the whole app, as Hive's amber does. The tokens
  are in `branding/theme-tokens.css` and documented in `branding/README.md`; the UI uses them from B6 onwards.

## 10. Working agreements

- Agents commit on their own once a card passes review (unlike Hive, without waiting to be asked). No push, remote or
  release unless the user asks.

## 11. Open questions

From the spike report, still for the user to decide:

1. ~~Direction and first platform for Convert~~: decided, Junos → IOS/IOS-XE first (§4).
2. Sample configs: cleaned-up real configs (Junos and the chosen Cisco platform) for fixtures?
3. ~~Junos families in scope~~: decided, MX/EX/QFX with SRX security as `unsupported` for now (§4).
4. Reverse display set (set → hierarchical): needed?
5. Annotations: should display set output include `/* comments */`, or drop them with a warning?
6. Who gets the app (decides code signing, installer or web build first, and whether the CLI is published)?
7. Third-party plugins: OK to leave out of v1?
