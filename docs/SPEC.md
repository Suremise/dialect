# Dialect: product decisions

The source of truth for what Dialect is and the decisions behind it. It takes over the decisions recorded in the
workspace note `juniper-decisions.md` and in the spike report ([spike-desktop-app.md](spike-desktop-app.md), whose
research and reasoning stay there). Update this file in the same change when a decision changes; only the user makes
product decisions.

## 1. What Dialect is

- **Name:** the product's working name is **Dialect**. The local project and folder stay `juniper`.
- **What it does:** translates network device configs between vendor "dialects", fully offline:
  - **Junos display set**: hierarchical Junos config to `set` commands (a Junos-only tool, shared with the Junos
    plugin's parser).
  - **Convert**: Junos ⇄ Cisco (IOS/IOS-XE first; NX-OS and IOS-XR later), through a shared model (§4).
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
  smoke test, but **never run the installer**: Darren installs and tests it himself.
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
  one given earlier is given once and referred to. So `npm run licenses` needs Rust (cargo). **Every link Dialect gives
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
- **Junos scope:** MX, EX and QFX, routing and switching. Switching is ELS only (`vlans` and `family
  ethernet-switching`, with VLANs in a later model version), not the older non-ELS syntax. Both the hierarchical and
  the set form are read, and `apply-groups` and `interface-range` are expanded before mapping. SRX security zones,
  policies and NAT come later: until then they show as `unsupported` in the ledger, never dropped.
- **Convert goes Junos → IOS/IOS-XE first** (B9); the reverse follows, from the same plugins, then NX-OS and IOS-XR.
- **Interface names never map silently.** Every interface a config names, configured or only referenced (a next hop,
  a source interface), needs a name on the target from the user: in the app's interface table, or a `--map` file on
  the command line (`from,to` lines or a JSON object). A plugin may suggest names (Junos `ge-0/0/0` → IOS
  `GigabitEthernet0/0/0`), shown as suggestions and used only once the user takes them. Until every interface is named,
  the CLI writes no config and exits 3; `--allow-incomplete` writes it anyway, the unnamed interfaces keeping their
  source names and their lines listed on stderr. Messages give an interface's line, never its name (a name can be a
  secret's value reused); `--write-map` writes the names, with suggestions, to a file the user chose. Two interfaces
  never end up with one name: such answers are refused, never merged.

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

## 7. In-app About and Docs

- Like Hive: an **About dialog** (Help → About Dialect) and a **Docs view** that bundles the user guide
  ([USER_GUIDE.md](USER_GUIDE.md)), the release notes ([CHANGELOG.md](../CHANGELOG.md)), the License and the
  Third-Party Notices, in the desktop app and the web build alike (B16).
- The documents are the committed files, bundled at build time and rendered with marked and DOMPurify; a test fails
  when what the UI bundles differs from the committed file, and the license check keeps the committed notices current.
  The notices make the web build's single file about 1.1 MB (0.59 MB without the Docs).
- About shows the version, the build (desktop or web), the WebView2 or browser version and the line "Dialect is not
  affiliated with or endorsed by Juniper Networks or Cisco Systems", with links into the Docs pages and Copy for the
  version information.
- Links in the Docs never navigate the app's own page: a link to another bundled document opens it, and an `https://`
  link opens outside the app (the default browser through Tauri's opener plugin, which the desktop app may use for
  `https://` URLs only; a new tab in the web build).

## 8. Icon and theme

- The icon is concept **B, Braces to block**: a violet circle with a `{` opening onto indented lines (`branding/`).
- **Its violet palette is Dialect's theme colour** and runs through the whole app, as Hive's amber does. The tokens
  are in `branding/theme-tokens.css` and documented in `branding/README.md`; the UI uses them from B6 onwards.

## 9. Working agreements

- Agents commit on their own once a card passes review (unlike Hive, without waiting to be asked). No push, remote or
  release unless the user asks.

## 10. Open questions

From the spike report, still for the user to decide:

1. ~~Direction and first platform for Convert~~: decided, Junos → IOS/IOS-XE first (§4).
2. Sample configs: cleaned-up real configs (Junos and the chosen Cisco platform) for fixtures?
3. ~~Junos families in scope~~: decided, MX/EX/QFX with SRX security as `unsupported` for now (§4).
4. Reverse display set (set → hierarchical): needed?
5. Annotations: should display set output include `/* comments */`, or drop them with a warning?
6. Who gets the app (decides code signing, installer or web build first, and whether the CLI is published)?
7. Third-party plugins: OK to leave out of v1?
