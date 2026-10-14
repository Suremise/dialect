# Dialect user guide

Dialect isn't released yet. Sections about what isn't built yet (Convert) say what is coming. This guide is also in
the app: **Help → User Guide** (F1).

Dialect translates network device configs between vendor "dialects", offline. It isn't affiliated with or endorsed by
Juniper Networks or Cisco Systems.

## Getting Dialect

- **Desktop app** (Windows): `Dialect_<version>_x64-setup.exe` installs Dialect for you alone, with no admin rights,
  and adds it to the Start menu; uninstall it from Settings → Apps. It also installs the `dialect` command (below) and
  asks whether to add it to your PATH (yes unless you say no), so a new terminal can run `dialect`; uninstalling takes
  both away. Dialect uses WebView2, which is part of Windows 11 and an up-to-date Windows 10; on a PC without it, the
  installer installs it, which needs internet. For a PC with no internet, use `Dialect_<version>_x64-offline-setup.exe`
  instead: the same, with Microsoft's WebView2 installer inside. Open and Save output use the usual Windows dialogs, and you can
  drop a file on the window. The Dialect icon is on the installer, the window and the taskbar, and in the notification
  area while Dialect runs: click it to bring the window back, or right-click it for **Show Dialect**, **New tab** and
  **Quit** (which asks first while output is unsaved, as closing the window does; closing the window quits Dialect).
  The app reads and writes only the files you pick, and reaches no network. Until Dialect
  has a code-signing certificate the installer is unsigned, so Windows SmartScreen may warn about it: choose **More
  info** → **Run anyway**. Until there's a release, build both installers from a checkout with `npm run
  build:installers -w @dialect/desktop` (needs Rust), which writes them to
  `apps/desktop/src-tauri/target/release/bundle/nsis/`.
- **Web build**: one HTML file, `dialect.html`, opened from disk with no install and no server. Open it in Edge or
  Chrome. Until there's a release, build it from a checkout with `npm run build -w @dialect/web`, which writes
  `apps/web/dist/dialect.html`. The page can't reach the network at all: its content security policy allows only its
  own built-in code.
- **Command line**: the `dialect` command, needing nothing installed: the desktop installer adds it, or download
  `dialect-cli.exe` on its own (one file; rename it `dialect.exe` to type `dialect`). If you have Node 24, the
  `dialect.mjs` build runs on it too.

## Your configs stay on your computer

Dialect works offline: it sends nothing anywhere and keeps no logs of your configs.

## Tabs and menus

The desktop app and the web build look and work the same: a menu bar at the top, a strip of tabs below it, and the tab
you're on below that.

- **One tab per job.** **File → New Tab…** (Ctrl+T), or **+** at the end of the tab strip, asks what you're doing:
  **Display set (Junos)**, or **Convert** from one platform to another (Junos, Cisco IOS / IOS-XE, Cisco NX-OS or
  Cisco IOS-XR, chosen in the two lists). Each tab keeps its own source, output,
  problems, interface names and undo history, so several configs can be open at once. New platforms and tools appear
  in this list as Dialect gains them.
- **A tab's title** is its file name and job, such as `phase1.conf → IOS-XE` (`Untitled` until you open a file). A
  dot after it means its output hasn't been saved since it last changed. Hover over it for the file's full path (the
  desktop app) or name.
- **Closing a tab**: its **×**, a middle-click, **File → Close Tab** (Ctrl+W) or Delete on the focused tab. If its
  output hasn't been saved, Dialect asks first: **Save and close**, **Close without saving**, or **Cancel**.
- **Closing Dialect** with a tab's output unsaved asks first too: in the desktop app, **File → Exit**, the window's
  **✕** or Alt+F4 ask whether to exit without saving; in the web build, closing or reloading the browser tab has the
  browser ask whether to leave the page (in its own words: a page can't say more there).
- **The Docs pages** (User Guide, Release Notes, License, Third-Party Notices) each open in a tab of their own, beside
  your conversions. Asking for a page that's already open shows its tab.
- **When you start Dialect again**, your tabs come back with their jobs and file names, but **never their configs**:
  configs can hold passwords and keys, and Dialect doesn't keep them anywhere, not even in the browser's storage. A
  reopened tab says which file it had, with a **Reopen** button to load it again. Docs tabs come back as they were.

The menus:

- **File:** New Tab…, Open…, Save Output, Save Output As…, Close Tab, and in the desktop app **Exit** (it asks first if
  a tab's output hasn't been saved). The web build has no Exit: close its browser tab instead.
- **Edit:** Undo and Redo (in the source you were editing), Copy Output, and Paste (replaces the source with the
  clipboard's text).
- **View:** System Theme, Light Theme and Dark Theme. The theme follows your system's light or dark setting until you
  choose one.
- **Window:** every open tab, the current one ticked, then Next Tab and Previous Tab.
- **Help:** User Guide (F1), Release Notes, License, Third-Party Notices and About Dialect.

The keyboard works as in other Windows apps: **Alt** or **F10** moves to the menu bar, the arrow keys move along it and
through a menu, Enter runs an item and Esc goes back. In the tab strip, the arrow keys move between tabs.

| Shortcut | Desktop app | Web build |
|---|---|---|
| New tab | Ctrl+T | Alt+T |
| Open a file in this tab | Ctrl+O | Ctrl+O |
| Save output, save as | Ctrl+S, Ctrl+Shift+S | Ctrl+S, Ctrl+Shift+S |
| Close tab | Ctrl+W | Alt+W |
| Next, previous tab | Ctrl+Tab, Ctrl+Shift+Tab (or Ctrl+PgDn, Ctrl+PgUp) | Alt+PgDn, Alt+PgUp |
| Tab 1 to 9 | Ctrl+1 … Ctrl+9 | Alt+1 … Alt+9 |
| User guide | F1 | F1 |

A browser keeps Ctrl+T, Ctrl+W, Ctrl+Tab and Ctrl+1…9 for its own tabs, so the web build shows the Alt keys in its
menus. Both work in the desktop app.

## Display set (Junos)

Turning a hierarchical Junos config into `set` commands: opening or pasting a config, reading the output, inactive
statements and annotations, saving and copying. The desktop app and the web build work the same way; the command line
is [below](#display-set).

In the app:

- **Open…** (Ctrl+O) picks a file for this tab (the desktop app shows the Windows Open dialog, the web build the
  browser's file picker), or drop a file anywhere in the window. **Paste** replaces the source with the clipboard's text (if the
  browser doesn't allow that, click in the source pane and press Ctrl+V). You can also type or edit the source
  directly.
- The display set appears on the right as you go. Click a set line and its statement is marked in the source; click a
  statement and its set lines are marked in the output.
- Above the output, and in the status bar, is how many commands there are (`set`, `deactivate` and `protect`). A
  quoted value with line breaks (a login banner) is one command over several lines, so then the line count follows:
  "2 commands (4 lines)".
- **Problems** lists the warnings, or the syntax error, with their line and column. Click one to go to it. While there's
  a syntax error there's no output.
- **Copy output** copies the set commands; **Save output** (Ctrl+S) saves them as `<name>.set`: the desktop app
  asks where, in the Windows Save dialog, the first time, then saves there again until you choose **File → Save Output
  As…**; the web build downloads the file each time.

The output is what `show configuration | display set` prints on the device:

- One `set` line for each statement, and one for each value of a `[ ]` list. An empty container gives a `set` line
  of its own.
- An `inactive:` statement gives a `deactivate` line, and a `protect:` statement a `protect` line, **after** the `set`
  lines it covers (Juniper's documented order, which loads into an empty config). `replace:` gives no line.
- Quoted strings stay exactly as written. `## comments` are left out, and so is a byte order mark at the start of the
  text. A redacted secret (`/* SECRET-DATA */`) stays in its line.
- `/* annotations */` have no `set` form: they are left out, and each one is listed as a warning, with its line.
- An unknown tag such as `deleted:` is kept as a word, with a warning.
- A syntax error (an unterminated quote or annotation, a missing or extra brace, a missing `;` or `]`) gives no output,
  only the error, with its line and column.
- Errors and warnings never quote the config's names, values or annotations (a value can be a secret): they say what
  is wrong, and the line and column say where.

## Convert

Convert translates a config from one platform to another: from any of **Junos, Cisco IOS / IOS-XE, Cisco NX-OS and
Cisco IOS-XR** to any other (see [Supported platforms and features](#supported-platforms-and-features)). Dialect reads
the source config into a model of what it configures (system, DNS, interfaces with their VRFs, static routes, NTP,
syslog, SNMP, VLANs and switch ports, OSPF, BGP, routing policy and access lists, as far as each platform goes) and
writes that model in the target platform's syntax.

Nothing is dropped silently. Every line of the source is either converted, left out on purpose (with why), or marked
as not converted, and every setting is either written or marked as one the target can't say (a Junos `reject` route
on IOS-XE, say). These are listed as warnings, by line, with the reason. From every platform, every line not
converted says why, even one Dialect doesn't read at all ("logical systems come later", "IS-IS comes later").

In the app, open a convert tab (**File → New Tab…**, then **Convert**, with the platform to convert from and the one
to convert to); both can be changed at the top of the tab. Then open, drop or paste the config as in display set. The target platform's config appears on the right as you type. Below, the **Problems**
panel lists what didn't carry over. The same lines are marked in the source's gutter, with the reason on hover, and
clicking a problem shows its line. The **Interfaces** table lists every interface to name (see below). Moving the
cursor in one pane marks the matching lines in the other. Copy output and Save output work as in display set; a saved
conversion is named after the source with the target's name (`edge-1.conf` → `edge-1.iosxe`).

### Interface names

Each platform names interfaces its own way (Junos `ge-0/0/0`, IOS `GigabitEthernet0/0/0`, NX-OS `Ethernet1/1`, IOS-XR
`GigabitEthernet0/0/0/0`), and only you know how the ports line up on the new device, so Dialect never renames an
interface on its own. Every interface the config names, as an interface or in a next hop or a source interface, needs a
name on the target. Dialect suggests one where the name makes it likely (from Junos to IOS-XE: `ge-0/0/0` →
`GigabitEthernet0/0/0`, `xe-0/1/0` → `TenGigabitEthernet0/1/0`, `lo0` → `Loopback0`), but a suggestion is only used once
you take it. Aggregated interfaces get one on every target: Junos counts them from 0 and Cisco from 1, so `ae0` is
suggested as IOS `Port-channel1`, NX-OS `port-channel1` or IOS-XR `Bundle-Ether1`, and the other way round
`Port-channel1` as `ae0`. Between Cisco platforms the number stays (`Port-channel5` → `Bundle-Ether5`).

**IRB units are named one by one.** A Junos `irb` (or EX `vlan`) interface with several units is listed unit by unit,
`irb.100`, `irb.200`, since on IOS-XE and NX-OS each becomes its own VLAN interface. Each is suggested as `Vlan` and
the number of the VLAN it routes for (`irb.100` → `Vlan100`), and a unit you haven't named yet stays in the list to
name, without holding up the others. The other way, Cisco's `Vlan100` is suggested as Junos's `irb.100`, and the VLAN
interfaces become units of one `irb`, each with its own description. IOS-XR suggests none yet.

In the app, name them in the **Interfaces** table: type a name, click **Use** to take a row's suggestion, or **Use
suggestions** to take every one at once. Until an interface has a name, it is marked, keeps its source name in the
output, and the output pane says the conversion is incomplete. **Load map…** reads a map file (below) and **Save
map** writes your names to one, for next time or for the command line. The names stay while you edit the config; opening
another config starts with none, since its ports may be different ones.

On the command line, give the names in a map file, with `--map`. A map file is either one `from,to` pair per line
(`#` starts a comment, and blank lines are fine), here from Junos to IOS-XE:

```
# source name,target name
ge-0/0/0,GigabitEthernet0/0/0
ge-0/0/1,GigabitEthernet0/0/1
lo0,Loopback0
```

or a JSON object:

```json
{ "ge-0/0/0": "GigabitEthernet0/0/0", "ge-0/0/1": "GigabitEthernet0/0/1", "lo0": "Loopback0" }
```

A Junos unit becomes a subinterface (`ge-0/0/1` unit 10 → `GigabitEthernet0/0/1.10`); unit 0 is the interface itself.
An IRB unit has a line of its own (`irb.100,Vlan100`); `irb` on its own isn't a name in such a config, and a map that
gives it is told so. A name with a unit number puts it at that unit (`Vlan100,irb.100`).
Two interfaces can't end up with one name, counting the source names that unnamed interfaces keep: Dialect refuses those
names (an error, with the interfaces' lines) and both stay unnamed, so neither replaces the other. A map that names an
interface twice is refused whole, in either form.

## Supported platforms and features

Which platforms and which parts of a config each one reads and writes.

| Platform | `--from` / `--to` | Display set | Convert from and to |
|---|---|---|---|
| Junos (MX, EX, QFX) | `junos` | yes | yes |
| Cisco IOS / IOS-XE | `iosxe` | no | yes |
| Cisco NX-OS | `nxos` | no | yes |
| Cisco IOS-XR | `iosxr` | no | yes |

Convert goes from any of them to any other, in the app and on the command line. Each converts system settings (host
name, domain, DNS), interfaces with their addresses and VRFs, static routes, NTP, syslog and SNMP; what one can't read
or write is listed as not converted, with why.

**VLANs and switch ports.** Junos converts VLANs (with their names and descriptions), switch ports (access and trunk,
with a native VLAN) and IRB interfaces, in the ELS syntax of today's EX and QFX switches; the older non-ELS syntax, a
`vlan-id-list` and an IRB unit that routes for no VLAN are listed as not converted. Cisco IOS / IOS-XE and NX-OS
convert VLANs and their names, access and trunk switch ports (allowed VLANs with `add`, `remove`, `except`, `all` and
`none`, a native VLAN) and VLAN interfaces (`interface VlanN`); other switch port modes (`dynamic`, `dot1q-tunnel`,
private VLANs) are listed as not converted. Neither writes a VLAN description, nor a VLAN name with a space in it.
Converting to NX-OS writes the `feature` lines the config needs, and a routed VLAN only once you name it `Vlan` and its
VLAN ID (`Vlan100`), with a warning otherwise. Cisco IOS-XR converts no Layer 2 yet: VLANs, switch ports and routed
VLAN interfaces are listed as not converted, both ways (VLAN-tagged subinterfaces do convert). IRB units and VLAN
interfaces are named as [Interface names](#interface-names) says.

**Link aggregation (LAGs).** Junos and Cisco IOS-XR convert which aggregate each member link is in, the aggregate's
LACP mode (active, passive, or none) and its minimum links. Junos reads `ether-options 802.3ad aeN` (or
`gigether-options`) on the members and `aggregated-ether-options` (`lacp active|passive`, `minimum-links`) on the
aggregate, and writes `ether-options`, with the `chassis aggregated-devices ethernet device-count` Junos needs to make
the `ae` interfaces. IOS-XR reads and writes `bundle id N mode active|passive|on` on the members and `bundle
minimum-active links` on the `Bundle-Ether`; it gives the mode on each member, so members of one bundle that disagree
on it are listed as not converted. Other LAG settings (LACP timers and priorities, link speed, maximum links) are
listed as not converted. An aggregate needs its name on the target like any interface: until you name it (`ae0` for a
`Port-channel1`, say), its members and settings are listed as not written.

Cisco IOS / IOS-XE and NX-OS convert bundles too: each member's `channel-group N mode
active|passive|on` (or no mode) puts it in `Port-channelN` (NX-OS `port-channelN`) with its LACP mode, and a
Port-channel's minimum links (`port-channel min-links` on IOS / IOS-XE, `lacp min-links` on NX-OS) converts too. A
member whose Port-channel the config doesn't configure brings it in, as the device does. Members of one bundle with
different modes stop the conversion with an error, since no device runs that, and PAgP (`mode auto` or `desirable`) is
listed as not converted. Converting to NX-OS writes `feature lacp` when the bundle uses LACP. Each member is written
to match its bundle, as the device needs to bundle it: with the bundle's switch port settings and MTU, and on NX-OS
`no switchport` when the bundle routes. A member whose own settings differ, or that has an IP address of its own, is
listed as not converted. A bundle without LACP is written with no mode
(`channel-group 1`), which IOS routers and NX-OS take as a static bundle; Catalyst switches want `mode on`, so add it
when the target is one.

**OSPF.** Every platform converts OSPF, one process per routing table (the global one and each VRF's): the router ID,
areas (stub, NSSA, authentication) and their interfaces (cost, point-to-point or broadcast, passive, hello and dead
intervals). Cisco IOS / IOS-XE enables OSPF on an interface with `ip ospf … area` or a `network` statement, NX-OS with
`ip router ospf … area` on the interface, IOS-XR by listing the interface in its area, where it takes the area's and
the process's settings; Junos lists the interface in its area. A second process in one table, `ospf3` (OSPFv3) and,
on NX-OS, `network` statements are listed as not converted. Converting a config that enables OSPF with `network`
statements warns that an interface added later in their ranges won't join: the target enables it on the interfaces
the config has now (IOS / IOS-XE with an exact `network … 0.0.0.0` for each). A Junos source has no process number or
name: the target uses `1`.

**BGP.** Every platform converts BGP: the local AS and the router ID, neighbors and their groups (Junos groups, IOS
peer groups, NX-OS peer templates, IOS-XR neighbor groups), each with its peer AS, description, update source (Junos:
local address), eBGP multihop, IPv4 and IPv6 unicast, and the route policies it imports and exports, in the global
table and in VRFs. Other address families, neighbor ranges (dynamic peers), NX-OS session and policy templates and
IOS-XR session and address family groups are listed as not converted, and so is what a target has no form for: a
local address on the Cisco platforms (they take an update source interface), an update source on Junos. On NX-OS and
IOS-XR, a VRF's BGP neighbor that inherits a global peer template (NX-OS `inherit peer`) or neighbor group (IOS-XR
`use neighbor-group`) converts with it. Converting to NX-OS or IOS-XR writes a VRF's group as one template for the
whole `router bgp` when it is the same as the global group of its name (or, with none, as every other VRF's group of
that name), and lists one that differs, or that no neighbor of its VRF uses.

Where the platforms behave differently, a warning says so. An eBGP neighbor with no route policy one way exchanges
every route that way on Junos, IOS / IOS-XE and NX-OS, and none on IOS-XR (RFC 8212): converting from one to the other
warns, and converting to IOS-XR leaves such a neighbor needing a route policy, which Dialect never makes up. A BGP
neighbor with no address family carries no routes on NX-OS and IOS-XR, which warn.

**Keys and passwords are never carried over**, nor written as a placeholder: an OSPF key (or the name of a key chain)
and a BGP password are asked for instead, and written only once you give them. The same goes for a route policy for
an IOS-XR eBGP neighbor that has none, and for a route distinguisher or route targets that a Junos VRF needs and the
source doesn't give. In the app, each is a row of the **Needs input** panel beside the interfaces, with its line and
what the target needs; type the answer there (keys and passwords are masked, unless you click **Show secrets**). An
answer in a form the target doesn't take (an IOS-XR or NX-OS MD5 key without its key ID, say) is asked for again.
Dialect keeps answers only while the tab is open: never in any storage, and not after you open another file or change
the target. On the command line, give them in an answers file (see [convert](#convert)).

Junos also converts routing policy: prefix lists, communities, AS paths and AS-path groups and policy-statements,
with the policies BGP and VRFs import and export, and firewall filters (inet and inet6) with the units they're applied
on. A policy or a filter converts term by term: a term Dialect can't convert in full is listed as not converted,
whole, and when leaving it out would change what a later term does, the whole policy is. A filter's term is left out
alone only when that changes nothing the filter decides: a term that only counts or logs, or the last term when it
discards, as the filter's end does. Any other takes the whole filter with it, and the units applying it, so no filter
lets through or drops other packets than the source's. Regular expressions are kept
as written and never translated to another platform's.

Cisco IOS-XR also converts routing policy in RPL's simple forms: prefix sets, community sets (communities and
`ios-regex`), AS-path sets (`ios-regex`), and route policies made of flat `if … then … endif` blocks (with an `else`)
and top-level actions, matching a prefix set, a community set, an AS-path set or a tag (joined with `and`) and setting
the local preference, MED, communities, AS-path prepends, next hop and tag, with `done`, `drop` and `pass`. A set or
route policy converts whole or not at all: one with a nested `if`, `elseif`, `or` or `not`, parameters, `apply`, an
inline set, or an element Dialect has no form for (a community wildcard or range, `dfa-regex`, `passes-through`) is
listed as not converted. So is a policy whose block passes a route on to later statements, which Dialect can't keep
exactly. BGP neighbors' route policies and a VRF's `import`/`export route-policy` name the converted policies; one
the config doesn't define, or that isn't converted, is listed as not converted. Converting a Junos policy to IOS-XR
adds a final `pass` with a warning, as an IOS-XR policy drops what nothing passes, and warns about a VRF import or
export policy, which on Junos replaces the VRF's route targets and on IOS-XR filters after them.

Cisco IOS-XR also converts access lists: `ipv4 access-list` and `ipv6 access-list`, numbered as IOS-XR numbers them (an
entry with no number gets 10 more than the highest, a remark's included), with `any`, `host`, prefixes and contiguous
wildcards, protocols, ports (`eq`, `gt`, `lt`, `range`, by number or name), ICMP types, `established`, `fragments`,
`dscp`, `log` and `counter`, and the interfaces' `ipv4|ipv6 access-group … ingress|egress`. The remarks before an
entry are kept as its description, and converting to IOS-XR writes a description as a remark just before its entry
(listed as not written when that number is taken). An entry Dialect can't convert (a non-contiguous wildcard, which is never approximated, an object
group, `neq`, ABF and other options) is listed, alone when it is the last entry and denies, as the list's end does,
and otherwise with its whole access list, as the list would decide other packets without it; an interface applying a
list that isn't converted is listed too. An IOS-XR access list denies what no entry decides: converting to IOS-XR warns when the source discards instead
(Junos), or when a list relies on it, an entry left out included.

Cisco IOS / IOS-XE also converts routing policy: prefix lists, community lists (standard, expanded and numbered),
AS-path access lists and route maps (matching prefix lists, communities, AS paths and tags; setting the local
preference, metric, communities, AS-path prepends, next hop and tag), which its BGP neighbors' route maps name. A regex
is kept as written and never translated into another platform's. A list is converted whole or not at all, and a route
map sequence by sequence: one Dialect can't convert is listed, and the whole route map with it when leaving it out would
change what the sequences after it do. A route map named by a neighbor but not defined isn't converted, as IOS then
denies every route. Converting a Junos policy that passes undecided routes on to the next policy adds a final permit
sequence to the route map, with a warning, since an IOS route map denies a route no sequence decides.

Cisco NX-OS converts routing policy the same way: prefix lists (with `eq`), standard and expanded community lists and
AS-path access lists (each entry by its `seq`), and route maps, which its BGP neighbors' route maps name. A route map a
neighbor names but the config doesn't define isn't converted. On both, a VRF's `import map` and `export map` convert
too, with its route targets: a Cisco map filters what the route targets bring in or send out, where a Junos
`vrf-import` or `vrf-export` replaces them, so converting one from Junos warns.

Cisco IOS / IOS-XE and NX-OS also convert access lists (IPv4 and IPv6, named, and on IOS numbered and standard) and the
interfaces that apply them, each entry with its remarks kept as its description (Junos keeps none per term, so
converting to Junos lists a remark as not written, with the entry converted). An address with a wildcard is
converted only when the wildcard is a plain prefix: an entry with any other wildcard is listed as not converted, never
approximated, and so is the whole list, with the interfaces applying it: leaving the entry out would have the list
decide other packets. Every Cisco access list denies what no entry
decides: converting a Junos filter, which drops such packets silently, says so with a warning. An IPv6 access list with no final entry deciding every packet warns too: some Cisco
platforms let neighbor discovery through before the implicit deny, and others don't.

## The command line

`dialect display-set` and `dialect convert`: files, stdin and stdout, and exit codes.

The command needs nothing installed: `dialect.exe` (installed with the desktop app, or the `dialect-cli.exe`
download) has its own runtime. Until there's a release, build it from a checkout with `npm run build:exe -w
@dialect/cli`, which writes `packages/cli/dist/dialect.exe`; or with Node 24, `npm run build -w @dialect/cli` writes
`packages/cli/dist/dialect.mjs`, which you run with `node`.

### display-set

```
dialect display-set <file>
dialect display-set -          (reads stdin)
```

It prints the display set commands to stdout (see [Display set](#display-set-junos)) and nothing else, so the output
can go straight to a file or another command:

```
dialect display-set router.conf > router.set
```

Warnings and errors go to stderr, one per line, with the file (`<stdin>` for stdin), line and column, the way
compilers print them:

```
router.conf:12:5: warning: annotation on this statement isn't shown in display set
router.conf:30:1: error: missing ';' after the statement at line 29, column 5
```

Messages say what is wrong and where, but never quote your config's names, values or annotations, so a password
hash or key can't end up in a terminal log or a CI log through them.

A syntax error prints no set commands at all.

### convert

```
dialect convert --from junos --to iosxe --map names.csv router.conf > router.ios
dialect convert --from junos --to iosxe --map names.csv -          (reads stdin)
```

It prints the converted config to stdout, and to stderr what didn't carry over, by line, with the reason:

```
router.conf:66:9: warning: not written for Cisco IOS / IOS-XE: IOS has no reject route: Null0 discards
router.conf:74:1: warning: not converted: routing protocols come later
```

`--map` gives the interfaces' names on the target (see [Interface names](#interface-names)), and `--answers` the rest
of what the target needs: keys, passwords, an IOS-XR route policy for an eBGP neighbor, a Junos VRF's route
distinguisher or route targets (see [Supported platforms and features](#supported-platforms-and-features)). While an
interface has no name, or something has no answer, `convert` writes no config: it gives each one's line, with what the
target needs (`secret needed: …` or `needs input: …`), and exits 3. `--allow-incomplete` writes the config anyway,
after a warning giving their lines: unnamed interfaces keep their source names and what has no answer is left out,
so it isn't ready for a device. Options can also be written `--from=junos`.

Messages give an interface's line, never its name: a name could be a password or community string reused, and messages
end up in terminal and CI logs. To see the names, with suggestions, let `--write-map` write them to a map file:

```
dialect convert --from junos --to iosxe --write-map names.csv router.conf
```

It lists every interface, and every IRB unit on its own line: the name you gave, else the suggestion (marked
`# suggested`), else none (`lo0,`). Check
it, fill in the rest and give it back with `--map names.csv`; a line with no name is an interface still to name.

#### The answers file

**Never put a key or password on the command line**, where other programs and your shell's history can see it: give
answers in a file, or on stdin. `--write-answers` writes everything the conversion asks for to a file to fill in:

```
dialect convert --from junos --to iosxr --map names.csv --write-answers answers.txt router.conf
```

Each item is a comment saying its line and what's needed, and an `"id" = answer` line:

```
# Line 21: secret. OSPF MD5 authentication on an interface needs its key ID (1 to 255) and key, as "ID KEY": the key isn't carried.
"iosxr.ospf-key:networkInstances.default.ospf.areas[\"0.0.0.0\"].interfaces[\"GigabitEthernet0/0/0/0.0\"]" = 7 my-key

# Line 34: secret. A BGP session with a password needs the password, which isn't carried.
"iosxr.bgp-password:networkInstances.default.bgp.neighbors[\"192.0.2.1\"]" =
```

Write each answer after the `=`, then give the file back:

```
dialect convert --from junos --to iosxr --map names.csv --answers answers.txt router.conf > router.xr
some-vault-tool read router-keys | dialect convert --from junos --to iosxr --map names.csv --answers - router.conf
```

- Each item is asked once, even when its answer goes in several places (a BGP group's password, where VRFs use the
  group too): the comment gives every line.
- The id, in double quotes, says which item, as Dialect names it; keep it as written. It names the target's
  interfaces, so name the interfaces first (an id changes with an interface's name).
- The answer is the rest of the line as typed, so it can hold spaces, `#`, `=` and quotes; spaces at either end are
  dropped. An empty answer leaves the item unanswered. Lines starting with `#` are comments.
- A JSON object of answers by id works too: `{"iosxr.bgp-password:…": "…"}`.
- `--answers -` reads the answers from stdin (the config then comes from a file).
- An answer in a form the target doesn't take is asked for again (`… (the answer given isn't in the form asked for)`),
  and an answer for something the conversion doesn't ask for is counted in a warning. Neither message repeats the
  answer or its id.
- Interface names go in the map, not here.

Running `--write-answers` again with `--answers` keeps the answers you gave. The file holds your secrets in plain
text: keep it somewhere safe and delete it once the config is done.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Done. There may be warnings on stderr. |
| 1 | The config has a syntax error (on stderr, with its line and column). |
| 2 | A usage error (an unknown command or option, a missing or extra file, a map or answers file it can't read), or a file can't be read. |
| 3 | `convert`: interfaces have no name on the target, or it needs a key, a password or another answer. Give the names with `--map` and the answers with `--answers`, or use `--allow-incomplete`. |

`dialect --help` lists the commands, and `dialect --version` prints the version.

## About and Docs

The **Help** menu opens one of the Docs pages, each in a tab of its own, or About:

- **User Guide** (also F1): this guide.
- **Release Notes**: what changed in each version.
- **License**: Dialect's MIT License.
- **Third-Party Notices**: the open-source software Dialect includes, each package and Rust crate with its version,
  license and full license text, and the installer's components. Where one is offered under a choice of licenses, its
  entry says which one Dialect uses: MIT where it is offered, otherwise the first one Dialect may ship under.

A Docs tab lists the other pages beside its own; a page or a link to another of these documents opens that page's tab
(or shows it, if it's open). Your conversion tabs stay as they were. A web link opens in your browser (the desktop app's
default browser, or a new tab in the web build): the only time Dialect leads online, and only when you click one.

**About Dialect** shows the version, which build it is (desktop app or web build), the WebView2 or browser version and
the operating system, with links to the License and the Third-Party Notices. **Copy** copies the version information,
for a bug report, and **Release Notes** opens the release notes. Dialect is independently developed and isn't
affiliated with, endorsed or sponsored by Juniper Networks or Cisco Systems. Juniper and Junos are trademarks of
Juniper Networks, Inc.; Cisco, IOS, IOS-XE, NX-OS and IOS-XR are trademarks of Cisco Systems, Inc.
