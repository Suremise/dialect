# Release Notes

## Unreleased

### The window
- **Tabs and a menu bar**, the same in the desktop app and the web build. Open several conversions at once, each in
  its own tab (File → New Tab, Ctrl+T, or +, then Display set or Convert), with its own source, output, interface
  names and undo history. A dot marks a tab whose output isn't saved, and closing it asks first. The Docs pages open in
  tabs of their own, beside your conversions.
- **The menus:** File, Edit, View (the theme), Window (every open tab, the current one ticked) and Help, all usable
  from the keyboard (Alt or F10, the arrow keys, Enter, Esc). Exit is in the desktop app's File menu. In a browser,
  which keeps Ctrl+T, Ctrl+W and Ctrl+Tab for itself, the web build uses Alt+T, Alt+W and Alt+PgDn.
- **Tabs come back after a restart** with their file names, but never your configs: Dialect doesn't keep configs
  anywhere. Reopen the file from the tab.
- **Controls stand out:** buttons, tabs and menus have a visible edge, the current tab is marked in violet, and the
  keyboard focus shows.

### Convert
- **Junos routing instances convert:** VRFs and virtual routers, with their units, route distinguisher and vrf-target
  (one target or an import and export), to and from the model, so their interfaces stay in the right VRF. A unit in two
  instances is an error, as on the device, and instance types Dialect doesn't convert yet (mac-vrf, EVPN) are listed as
  not converted. Writing a VRF to Junos that the source gives without a route distinguisher or route targets asks for
  them rather than making them up.
- **Junos to Cisco IOS / IOS-XE** on the command line: `dialect convert --from junos --to iosxe [--map file]
  [--allow-incomplete] <file|->`. What didn't carry over is listed on stderr by line, with the reason, and never quotes
  the config.
- **Convert in the app**, the web build and the desktop app: a Convert mode beside Display set, with the target
  platform to choose. What didn't carry over is listed in the problems panel and marked in the source's gutter, with
  the reason on hover, and the source and output lines are linked as in display set. An **Interfaces** table names
  each interface on the target: type a name, take the suggestion, or load and save a map file.
- **Interface names are never guessed.** Every interface needs a name on the target, from a `--map` file (`from,to`
  lines or JSON). Dialect suggests names (`ge-0/0/0` → `GigabitEthernet0/0/0`) but uses none unasked: with interfaces
  left unnamed, `convert` gives their lines and exits 3, unless `--allow-incomplete` is given. `--write-map` writes
  every interface, with suggestions, to a map file to fill in. Two interfaces are never given one name: such names are
  refused, so neither is lost.

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
  violet. The output is counted in commands (set, deactivate and protect), so a multi-line banner counts once, with
  its lines said too.
- **The desktop app** for Windows: the same display set in its own window, from a per-user installer (no admin rights
  needed). Open and save with the Windows dialogs or drop a file on the window; the app can touch only the files you
  pick and reaches no network. Unsigned for now, so SmartScreen may warn.
- **Help, About and Docs** in the desktop app and the web build: the user guide (F1), the release notes, the license
  and the third-party notices in the app, and About Dialect with the version, the build, the WebView2 or browser
  version and the OS, links to the license and the notices, the release notes, and the copyright and independence
  notice.

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
