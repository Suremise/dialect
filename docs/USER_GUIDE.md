# Dialect user guide

A first outline: each section is filled in by the card that builds what it describes. Dialect isn't released yet.

Dialect translates network device configs between vendor "dialects", offline. It isn't affiliated with or endorsed by
Juniper Networks or Cisco Systems.

## Getting Dialect

- **Desktop app** (Windows): the installer, and what it needs (WebView2, part of Windows 10 and 11).
- **Web build**: one HTML file, opened from disk with no install and no server.
- **Command line**: the `dialect` command, on Node 24.

## Your configs stay on your computer

Dialect works offline: it sends nothing anywhere and keeps no logs of your configs.

## Display set (Junos)

Turning a hierarchical Junos config into `set` commands: opening or pasting a config, reading the output, inactive
statements and annotations, saving and copying.

## Convert

Translating a config from one platform to another: choosing the source and target, what is converted, and reading the
warnings (unmapped lines, semantic warnings, input needed such as an interface map).

## Supported platforms and features

Which platforms and which parts of a config each one reads and writes.

## The command line

`dialect display-set` and `dialect convert`: files, stdin and stdout, and exit codes.

## About and Docs

Help → About Dialect, and the Docs view: this guide, the release notes, the license and the third-party notices.
