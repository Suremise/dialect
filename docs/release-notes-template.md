# Dialect <version>

<!-- The release notes template (#89, for #84's release script): the downloads, and the release's entries from
CHANGELOG.md below them. The asset names are the ones the release attaches. -->

## Downloads (Windows, x64)

Nothing else to install for any of them: no Node.js, no runtime.

| Download | What it is |
|---|---|
| `Dialect_<version>_x64-setup.exe` | **The one most people want.** The desktop app and the `dialect` command, for you alone (no admin rights). It needs internet only on the rare PC without Microsoft WebView2 (every Windows 11 and an up-to-date Windows 10 have it). |
| `Dialect_<version>_x64-offline-setup.exe` | The same, for a PC with no internet: Microsoft's WebView2 installer is inside, so it's much bigger. |
| `dialect-cli.exe` | The `dialect` command on its own: one file, nothing to install. Rename it `dialect.exe` to type `dialect`. |
| `dialect.html` | The app as one web page: open it in Edge or Chrome, from any folder or a USB stick, with no network. |

Until Dialect has a code-signing certificate, Windows SmartScreen may warn about the downloads: choose **More info** →
**Run anyway**. Third-party licenses: `THIRD_PARTY_NOTICES.md`, attached.

## What's new

<!-- CHANGELOG.md's entries for this version. -->
