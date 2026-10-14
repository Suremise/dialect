# Release Notes

## Unreleased

### Display set
- **Junos display set**, in the Junos plugin: hierarchical config to the `set` lines Junos prints, with
  `deactivate` and `protect` lines after the statements they cover, as Juniper documents. Annotations and unknown tags
  are reported as warnings, and syntax errors with their line and column. Fixes the bugs found in jcc (the earlier
  open-source converter) during research: words containing `set`, annotations in the output, words starting with `_`
  or `@`, a last line without a newline, and an unterminated quote. The command line and the app use it from later
  cards.

### Repository
- **The monorepo is in place.** npm workspaces for the core, the conformance kit, the Junos plugin, the CLI, the UI and
  the web and desktop shells (all stubs for now), with Hive's TypeScript settings, oxlint, Vitest and Windows CI, on
  npm 12.
- **Third-party notices are generated** from what ships, with full license texts and working `https://` links, and a
  license check in two categories: what ships must be MIT or equally permissive, and build-only tools, listed in
  `docs/BUILD_ONLY_PACKAGES.md`, must be open source.
