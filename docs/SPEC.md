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
    unreadable input.
- **Offline and private:** no network access, no telemetry, and secrets in configs are never written to logs. A strict
  content security policy blocks remote content in both shells.

## 2. Stack and repository

- **TypeScript (strict mode)** for the core, the plugins and the UI. Desktop app via **Tauri 2**; the only Rust is
  Tauri's thin, mostly generated shell, and no conversion logic lives there: conversion runs in the webview, from the
  same bundled code as the web build. (Replaces the spike's first Python + PySide6 recommendation.)
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
- **Versions:** semver 0.x until the model and the plugin API are stable.

## 3. License

- **The whole project is MIT.**
- **The license rule has two categories:**
  - **Shipped, or copied into the repo** (anything bundled into the desktop app, the web build or the CLI; the Tauri
    runtime crates; the installer's components; copied code and test data): MIT or equally permissive. The allowlist is
    MIT, MIT-0, Apache-2.0 (its NOTICE text kept), BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, Zlib, Unicode-3.0, BSL-1.0,
    CC0-1.0 and Unlicense. **MPL-2.0 used unmodified is pre-approved** (e.g. Tauri's MPL crates); if one is ever
    modified, its changed files stay MPL and open. GPL, LGPL, AGPL, other copyleft (CPL, MS-RL) and no license are not
    allowed.
  - **Build-only** (never ships: compilers, linters, test runners, the icon pipeline's sharp/libvips): any open-source
    license, GPL and LGPL included. They are **listed** in the generated `docs/BUILD_ONLY_PACKAGES.md`, not just allowed
    silently, and one with no license or a non-open-source license fails.
  - Anything else fails unless it is a recorded exception (`EXCEPTIONS` in `scripts/licensePolicy.mjs`): the package,
    its license, why, and who decided. Only the user decides one.
- **`THIRD_PARTY_NOTICES.md` is generated** from what actually ships (`npm run licenses`): every package with a link,
  version, license and full license text, the products it ships in (a package that publishes no license file, or that
  only another platform installs, needs a reviewed supplement with its text, or the check fails), plus hand-written
  entries for material that isn't a package (`scripts/notices`), such as the jcc test fixtures entry. From B7 it also covers the Rust crates in
  the Tauri binary (runtime crates only) and the installer's components. **Every link is a working `https://` URL, or
  there is none.** `npm run licenses -- --check` and a unit test fail when either generated file is stale or the rule
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

## 5. Configs and test data

- **Only cleaned-up configs go into the repo.** Before committing one, remove passwords and password hashes, SNMP
  communities, keys, public IP addresses, hostnames and customer names. Use the documentation ranges `192.0.2.0/24`,
  `198.51.100.0/24`, `203.0.113.0/24` and `2001:db8::/32`.
- Third-party test data copied in keeps its attribution in `THIRD_PARTY_NOTICES.md` and must be MIT or equally
  permissive.

## 6. Trademarks

- Keep "Juniper", "Junos" and "Cisco" out of the product name and branding. Package names may describe the platform
  they read and write (`platform-junos`).
- The app says it isn't affiliated with or endorsed by either vendor.

## 7. In-app About and Docs

- Like Hive: an **About dialog** (Help → About Dialect) and a **Docs view** that bundles the user guide
  ([USER_GUIDE.md](USER_GUIDE.md)), the release notes ([CHANGELOG.md](../CHANGELOG.md)), the License and the
  Third-Party Notices.

## 8. Icon and theme

- The icon is concept **B, Braces to block**: a violet circle with a `{` opening onto indented lines (`branding/`).
- **Its violet palette is Dialect's theme colour** and runs through the whole app, as Hive's amber does. The tokens
  are in `branding/theme-tokens.css` and documented in `branding/README.md`; the UI uses them from B6 onwards.

## 9. Working agreements

- Agents commit on their own once a card passes review (unlike Hive, without waiting to be asked). No push, remote or
  release unless the user asks.

## 10. Open questions

From the spike report, still for the user to decide:

1. Direction and first platform for Convert: Junos → Cisco or Cisco → Junos first, and which Cisco platform (IOS-XE
   suggested)?
2. Sample configs: cleaned-up real configs (Junos and the chosen Cisco platform) for fixtures?
3. Junos families in scope: MX/EX/QFX? SRX security zones, policies and NAT in or out?
4. Reverse display set (set → hierarchical): needed?
5. Annotations: should display set output include `/* comments */`, or drop them with a warning?
6. Who gets the app (decides code signing, installer or web build first, and whether the CLI is published)?
7. Third-party plugins: OK to leave out of v1?
