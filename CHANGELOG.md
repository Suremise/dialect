# Release Notes

## Unreleased

### Display set
- **Junos display set**, in the Junos plugin: hierarchical config to the `set` lines Junos prints, with
  `deactivate` and `protect` lines after the statements they cover, as Juniper documents. Annotations and unknown tags
  are reported as warnings, and syntax errors with their line and column. Fixes the bugs found in jcc (the earlier
  open-source converter) during research: words containing `set`, annotations in the output, words starting with `_`
  or `@`, a last line without a newline, and an unterminated quote.
- **`dialect display-set <file|->`** on the command line (Node 24): the set commands to stdout, and warnings and errors
  to stderr with their file, line and column. Messages never quote the config itself, so secrets stay out of logs.
  Exit codes: 0 done, 1 a syntax error, 2 a usage error or unreadable input.
- **The web build**, `dialect.html`: display set in a browser, from one file opened from disk, with nothing installed
  and no network. Open a file, drop one or paste, and see the display set as you type, with warnings and syntax errors
  in a problems panel, linked lines between source and output, copy and save, and light and dark themes in Dialect's
  violet.
- **The desktop app** for Windows: the same display set in its own window, from a per-user installer (no admin rights
  needed). Open and save with the Windows dialogs or drop a file on the window; the app can touch only the files you
  pick and reaches no network. Unsigned for now, so SmartScreen may warn.
- **Help, About and Docs** in the desktop app and the web build: the user guide (F1), the release notes, the license
  and the third-party notices in the app, and About Dialect with the version, the build and the WebView2 or browser
  version.

### Repository
- **The monorepo is in place.** npm workspaces for the core, the conformance kit, the Junos plugin, the CLI, the UI and
  the web and desktop shells (all stubs for now), with Hive's TypeScript settings, oxlint, Vitest and Windows CI, on
  npm 12.
- **Third-party notices are generated** from what ships, with full license texts and working `https://` links, and a
  license check in two categories: what ships must be MIT or equally permissive, and build-only tools, listed in
  `docs/BUILD_ONLY_PACKAGES.md`, must be open source.
- **The notices cover the desktop app's Rust crates**, the installer's components and the WebView2 loader: only crates
  compiled into the app ship; proc-macros and build scripts are listed as build-only.
- **The notices say which license Dialect uses** for each package and crate offered under a choice of licenses: MIT
  where it is offered, otherwise the first allowed one (e.g. "MIT OR Apache-2.0, used under MIT").
