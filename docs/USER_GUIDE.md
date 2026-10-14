# Dialect user guide

Dialect isn't released yet. Sections about what isn't built yet (Convert) say what is coming. This guide is also in
the app: **Help → User Guide** (F1).

Dialect translates network device configs between vendor "dialects", offline. It isn't affiliated with or endorsed by
Juniper Networks or Cisco Systems.

## Getting Dialect

- **Desktop app** (Windows): `Dialect_<version>_x64-setup.exe` installs Dialect for you alone, with no admin rights,
  and adds it to the Start menu; uninstall it from Settings → Apps. It uses WebView2, which is part of Windows 10 and 11
  (the installer downloads it only if it's missing). Open and Save output use the usual Windows dialogs, and you can
  drop a file on the window. The app reads and writes only the files you pick, and reaches no network. Until Dialect
  has a code-signing certificate the installer is unsigned, so Windows SmartScreen may warn about it: choose **More
  info** → **Run anyway**. Until there's a release, build it from a checkout with `npm run build -w @dialect/desktop`
  (needs Rust), which writes the installer to `apps/desktop/src-tauri/target/release/bundle/nsis/`.
- **Web build**: one HTML file, `dialect.html`, opened from disk with no install and no server. Open it in Edge or
  Chrome. Until there's a release, build it from a checkout with `npm run build -w @dialect/web`, which writes
  `apps/web/dist/dialect.html`. The page can't reach the network at all: its content security policy allows only its
  own built-in code.
- **Command line**: the `dialect` command, on Node 24.

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
syslog and SNMP so far) and writes that model in the target platform's syntax.

Nothing is dropped silently. Every line of the source is either converted, left out on purpose (with why), or marked
as not converted, and every setting is either written or marked as one the target can't say (a Junos `reject` route
on IOS-XE, say). These are listed as warnings, by line, with the reason.

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
or write is listed as not converted, with why. Junos also converts VLANs, switch ports (access and trunk, with a
native VLAN) and IRB interfaces, in the ELS syntax of today's EX and QFX switches (the older non-ELS syntax is listed
as not converted), and OSPF and BGP: areas and interfaces, groups and neighbors, with policies by name only. Keys
(OSPF and BGP authentication) are never carried over: Dialect asks you for each one. Cisco NX-OS also converts VLANs,
switch ports (access and trunk), VLAN interfaces, OSPF and BGP; an OSPF key or a BGP password is never carried, so
converting to NX-OS asks for it. Cisco IOS-XR also converts OSPF and BGP; converting to IOS-XR asks for an OSPF key or
a BGP password the same way, and for a route policy for each eBGP neighbor that has none, since IOS-XR exchanges no
routes with it without one.

Cisco IOS / IOS-XE also converts routing policy: prefix lists, community lists (standard, expanded and numbered),
AS-path access lists and route maps (matching prefix lists, communities, AS paths and tags; setting the local
preference, metric, communities, AS-path prepends, next hop and tag), which its BGP neighbors' route maps name. A regex
is kept as written and never translated into another platform's. A list is converted whole or not at all, and a route
map sequence by sequence: one Dialect can't convert is listed, and the whole route map with it when leaving it out would
change what the sequences after it do. A route map named by a neighbor but not defined isn't converted, as IOS then
denies every route. Converting a Junos policy that passes undecided routes on to the next policy adds a final permit
sequence to the route map, with a warning, since an IOS route map denies a route no sequence decides.

## The command line

`dialect display-set` and `dialect convert`: files, stdin and stdout, and exit codes.

The command needs Node 24. Until there's a release, build it from a checkout with `npm run build -w @dialect/cli`,
which writes one file, `packages/cli/dist/dialect.mjs`, and run that with `node`.

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

`--map` gives the interfaces' names on the target (see [Interface names](#interface-names)). While an interface has no
name, `convert` writes no config: it gives each unnamed interface's line and exits 3. `--allow-incomplete` writes the
config anyway, after a warning giving their lines; they keep their Junos names in the output, so it isn't ready for a
device. Options can also be written `--from=junos`.

Messages give an interface's line, never its name: a name could be a password or community string reused, and messages
end up in terminal and CI logs. To see the names, with suggestions, let `--write-map` write them to a map file:

```
dialect convert --from junos --to iosxe --write-map names.csv router.conf
```

It lists every interface: the name you gave, else the suggestion (marked `# suggested`), else none (`irb,`). Check
it, fill in the rest and give it back with `--map names.csv`; a line with no name is an interface still to name.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Done. There may be warnings on stderr. |
| 1 | The config has a syntax error (on stderr, with its line and column). |
| 2 | A usage error (an unknown command or option, a missing or extra file, a map file it can't read), or a file can't be read. |
| 3 | `convert`: interfaces have no name on the target. Give them with `--map`, or use `--allow-incomplete`. |

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
