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
- **Nothing unsaved is lost on the way out:** File → Exit, the desktop window's ✕ and Alt+F4 ask first while a tab's
  output is unsaved, and the web build has the browser ask before its tab closes or reloads.
- **Controls stand out:** buttons, tabs and menus have a visible edge, the current tab is marked in violet, and the
  keyboard focus shows.

### Convert
- **Cisco NX-OS routing policy converts:** prefix lists (IPv4 and IPv6, with `eq`), standard and expanded community lists
  and AS-path access lists with their sequence numbers, and route maps; BGP neighbors' route maps now carry the policy,
  not only its name. As on IOS-XE, regexes are kept as written, a route map converts sequence by sequence, and a Junos
  policy that passes undecided routes on gets a final permit sequence, with a warning.
- **Cisco IOS / IOS-XE routing policy converts:** prefix lists (IPv4 and IPv6), community lists (standard, expanded and
  numbered), AS-path access lists and route maps, and BGP neighbors' route maps now carry the policy itself, not only
  its name. Regexes are kept as written and never translated between platforms. A route map converts sequence by
  sequence: one that can't (`continue`, an ACL match) is listed, with the whole route map when leaving it out would
  change what later sequences see. A Junos policy that passes undecided routes to the next policy gets a final permit
  sequence, with a warning, as an IOS route map denies them.
- **Every IRB unit converts:** a Junos `irb` with several units is named unit by unit (`irb.100`, `irb.200`), in the
  Interfaces table and in map files (`irb.100,Vlan100`), and each becomes its own VLAN interface on IOS-XE and NX-OS,
  suggested as `Vlan100`, `Vlan200`. Before, only one unit could be converted. The other way, Cisco's `Vlan100` is
  suggested as Junos's `irb.100`, and VLAN interfaces become units of one `irb`.
- **Junos routing policy converts:** prefix lists, communities (literal, extended and large members, and regular
  expressions, marked as Junos's), AS paths and policy-statements, with their terms' conditions (prefix lists and
  `prefix-list-filter`, route filters, communities, AS paths, protocol, neighbor, tag, family) and actions (accept,
  reject, next term, next policy, local preference, metric, community add, set and delete, AS-path prepend, next hop,
  tag). BGP `import` and `export` now name the converted policies, and the "policies by name only" warning is gone where
  they convert. A term converts whole or not at all; when leaving one out could change what a later term sees, the
  whole policy is listed as not converted. Junos's own readings are respected: route filters match by longest prefix,
  so nested ones that would match differently aren't converted, nor a term with both route filters and prefix lists.
  Converting to Junos warns when the source rejects routes no term decides (a Cisco route map), as Junos passes them
  to the next policy. `vrf-import` and `vrf-export` aren't converted yet.
- **Cisco NX-OS and IOS-XR join convert**, in the app and on the command line: convert from any of Junos, IOS / IOS-XE,
  NX-OS and IOS-XR to any other (`dialect convert --from nxos --to iosxr …`). In the app, a new tab's Convert row has
  the platform to convert from and the one to convert to, and a convert tab can change either.
- **Cisco NX-OS VLANs, switch ports, VLAN interfaces, OSPF and BGP convert:** VLANs and their names, access and trunk
  ports (allowed VLANs with add, remove and except, a native VLAN), VLAN interfaces (SVIs), OSPF as NX-OS enables it on
  each interface (areas, stub and NSSA, cost, network type, passive, timers, `passive-interface default`) and BGP
  (neighbors, peer templates, eBGP multihop, address families, route maps by name only), in the global table and in
  VRFs. The `feature` lines they need are written. OSPF keys and BGP passwords are never carried: converting to NX-OS
  asks for them. Warnings say where NX-OS behaves differently: an eBGP neighbor with no route map exchanges every route
  (IOS-XR exchanges none, RFC 8212), and OSPF enabled with `network` statements is enabled per interface.
- **Junos OSPF and BGP convert:** OSPF areas (stub, NSSA) and their interfaces (passive, metric, point-to-point,
  timers), and BGP groups and neighbors (type, peer AS, description, local address, multihop, IPv4 and IPv6 unicast,
  import and export policies by name), with the router ID and AS number, in the global table and in VRFs. Keys are
  never carried over: Dialect asks for each one. Converting into Junos warns where its defaults differ from the
  source's: OSPF enabled by `network` statements becomes per interface, and an eBGP peer without a policy accepts its
  routes on Junos where IOS-XR rejects them. Policy bodies aren't converted yet, with a warning.
- **Aggregated interfaces get a suggested name on every target:** Junos `ae0` is suggested as IOS `Port-channel1`,
  NX-OS `port-channel1` or IOS-XR `Bundle-Ether1` (Cisco counts from 1, Junos from 0), and back again; between Cisco
  platforms the number is kept (`Port-channel5` → `Bundle-Ether5`). As with every suggestion, it's used only once you
  take it.
- **Cisco IOS-XR OSPF and BGP convert:** OSPF processes with their areas (stub, NSSA, authentication) and interfaces
  (cost, network type, passive, timers), taking IOS-XR's inheritance from the area and the process into each interface,
  and BGP (neighbors, neighbor groups, eBGP multihop, address families, route policies by name only), in the global
  table and in VRFs, with each VRF's route distinguisher. Layer 2 (bridge domains) isn't converted yet. Converting to
  IOS-XR, an eBGP neighbor with no route policy one way asks for one, since IOS-XR exchanges no routes without it
  (RFC 8212), and warns when the source accepted them; no policy is made up. OSPF keys and BGP passwords are never
  carried: converting to IOS-XR asks for them.
- **Junos VLANs, switch ports and IRB convert** (ELS, as on today's EX and QFX): VLANs with their names and
  descriptions, access and trunk ports with their VLANs and native VLAN, and IRB units with the VLAN each routes for.
  What Junos itself refuses (two VLANs with one ID, or naming one IRB unit) is an error, and what can't be read one way
  (a vlan-id-list, the older non-ELS port-mode, an IRB unit that routes for no VLAN) is listed as not converted rather
  than guessed.
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
