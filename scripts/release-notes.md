Dialect {{version}} for Windows (x64): it translates network device configs between vendor dialects, offline.

**Always review converted configuration before applying it to a device.** Dialect reports what it couldn't convert,
but you are responsible for what you deploy.

## Downloads

None needs anything else installed: no Node.js, no runtime.

| File | What it is |
|---|---|
| `{{setup}}` | **The one most people want.** The desktop app and the `dialect` command, for you alone (no admin rights). It needs internet only on the rare PC without Microsoft WebView2. |
| `{{offline}}` | The same, for a PC with no internet: Microsoft's WebView2 installer is inside, so it's much bigger. |
| `dialect-cli.exe` | The `dialect` command on its own: one file, nothing to install. Rename it `dialect.exe` to type `dialect`. |
| `dialect.html` | The app as one web page. It runs offline in Edge, Chrome or another modern browser: open it from any folder or a USB stick, with no network. |
| `LICENSE`, `THIRD_PARTY_NOTICES.md` | Dialect's MIT License, and the licenses of the open-source software it includes. |

**The installers and `dialect-cli.exe` are unsigned:** Dialect has no code-signing certificate yet, so Windows
SmartScreen warns about them. Choose **More info** → **Run anyway**. Dialect doesn't update itself or check for new
versions: look here, or use Help → Releases on GitHub.

## What's new

{{changes}}

## SHA-256 checksums

| File | SHA-256 |
|---|---|
{{checksums}}

Check one in PowerShell with `Get-FileHash <file>`.

---

{{notice}}
