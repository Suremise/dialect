# Dialect user guide

A first outline: each section is filled in by the card that builds what it describes. Dialect isn't released yet.

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

## Display set (Junos)

Turning a hierarchical Junos config into `set` commands: opening or pasting a config, reading the output, inactive
statements and annotations, saving and copying.

In the app:

- **Open…** (Ctrl+O) picks a file, or drop a file anywhere in the window. **Paste** replaces the source with the
  clipboard's text (if the browser doesn't allow that, click in the source pane and press Ctrl+V). You can also type
  or edit the source directly.
- The display set appears on the right as you go. Click a set line and its statement is marked in the source; click a
  statement and its set lines are marked in the output.
- **Problems** lists the warnings, or the syntax error, with their line and column. Click one to go to it. While there's
  a syntax error there's no output.
- **Copy output** copies the set commands; **Save output** (Ctrl+S) saves them as `<name>.set` (the web build
  downloads the file).
- The theme follows your system's light or dark setting. The button at the top right switches between light, dark
  and the system's.

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

Convert translates a config from one platform to another: for now, **Junos to Cisco IOS / IOS-XE**. Dialect reads the
Junos config into a model of what it configures (system, DNS, interfaces, static routes, NTP, syslog and SNMP so far)
and writes that model as IOS-XE.

Nothing is dropped silently. Every line of the source is either converted, left out on purpose (with why), or marked
as not converted, and every setting is either written or marked as one IOS-XE can't say (a `reject` route, say). These
are listed as warnings, by line, with the reason.

### Interface names

Junos and IOS name interfaces differently, and only you know how the ports line up on the new device, so Dialect never
renames an interface on its own. Every interface the config names, as an interface or in a next hop or a source
interface, needs a name on the target. Dialect suggests one where the name makes it likely (`ge-0/0/0` →
`GigabitEthernet0/0/0`, `xe-0/1/0` → `TenGigabitEthernet0/1/0`, `lo0` → `Loopback0`), but a suggestion is only used once
you take it.

On the command line, give the names in a map file, with `--map`. Either one `from,to` pair per line (`#` starts a
comment, and blank lines are fine):

```
# Junos name,IOS-XE name
ge-0/0/0,GigabitEthernet0/0/0
ge-0/0/1,GigabitEthernet0/0/1
lo0,Loopback0
```

or a JSON object:

```json
{ "ge-0/0/0": "GigabitEthernet0/0/0", "ge-0/0/1": "GigabitEthernet0/0/1", "lo0": "Loopback0" }
```

A Junos unit becomes a subinterface (`ge-0/0/1` unit 10 → `GigabitEthernet0/0/1.10`); unit 0 is the interface itself.
Two interfaces can't be given one name.

## Supported platforms and features

Which platforms and which parts of a config each one reads and writes.

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
name, `convert` writes no config: it lists the unnamed interfaces, with suggestions, and exits 3. `--allow-incomplete`
writes the config anyway, after a warning listing them; they keep their Junos names in the output, so it isn't ready
for a device. Options can also be written `--from=junos`.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Done. There may be warnings on stderr. |
| 1 | The config has a syntax error (on stderr, with its line and column). |
| 2 | A usage error (an unknown command or option, a missing or extra file, a map file it can't read), or a file can't be read. |
| 3 | `convert`: interfaces have no name on the target. Give them with `--map`, or use `--allow-incomplete`. |

`dialect --help` lists the commands, and `dialect --version` prints the version.

## About and Docs

Help → About Dialect, and the Docs view: this guide, the release notes, the license and the third-party notices.
