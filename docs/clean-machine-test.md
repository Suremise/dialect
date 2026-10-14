# Clean-machine test

The manual test of everything Dialect ships, on a machine with nothing installed: run it before each release (#89, for
#84). It uses **Windows Sandbox**, a clean, throwaway Windows that has no Node.js and nothing of yours. Agents build the
files but never run the installers; Darren runs this.

## What you need

- Windows 11 (or 10) Pro or Enterprise, with **Windows Sandbox** turned on (Settings → System → Optional features →
  More Windows features → Windows Sandbox; restart).
- A folder, for example `C:\dialect-release`, with the release's four files: `Dialect_<version>_x64-setup.exe`,
  `Dialect_<version>_x64-offline-setup.exe`, `dialect-cli.exe` and `dialect.html`. From a checkout they're built by
  `npm run build:installers -w @dialect/desktop` (both installers, in `apps/desktop/src-tauri/target/release/bundle/nsis/`),
  `npm run build:exe -w @dialect/cli` (`packages/cli/dist/dialect.exe`: copy it as `dialect-cli.exe`) and `npm run build
  -w @dialect/web` (`apps/web/dist/dialect.html`); or take CI's `dialect-installer` and `dialect-cli` artifacts.
- A small Junos config to try, for example `packages/cli/tests/fixtures/convert/phase1.conf`, in the same folder.

Two Sandbox configurations, saved as `.wsb` files (double-click one to start a Sandbox). Change `HostFolder` to your
folder. The folder is read-only inside the Sandbox, so nothing can change it.

`offline.wsb`, with no network at all:

```xml
<Configuration>
  <Networking>Disable</Networking>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>C:\dialect-release</HostFolder>
      <SandboxFolder>C:\Users\WDAGUtilityAccount\Desktop\release</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
  </MappedFolders>
</Configuration>
```

`online.wsb`: the same with `<Networking>Default</Networking>`.

## 1. Offline installer, no network (`offline.wsb`)

1. Open **Command Prompt** in the Sandbox and run `where node`: it says it can't find it (no Node.js here).
2. From `Desktop\release`, run `Dialect_<version>_x64-offline-setup.exe`. If SmartScreen warns (the files aren't signed
   yet), choose **More info** → **Run anyway**. The setup file and its window show the Dialect icon.
3. Install. When it asks **"Add the dialect command to your PATH?"**, choose **Yes**. It finishes with no error and no
   download (there's no network).
4. Start Dialect from the Start menu. The window, its taskbar button and the notification area show the Dialect icon.
   Open `Desktop\release\phase1.conf` (File → Open…), see its display set, then New Tab → Convert, Junos → Cisco IOS /
   IOS-XE: the output appears.
5. Open a **new** Command Prompt (one opened before the install doesn't have the new PATH) and run:
   - `where dialect`: one line, `C:\Users\WDAGUtilityAccount\AppData\Local\Dialect\cli\dialect.exe`;
   - `dialect --version`: `dialect <version>`;
   - `dialect display-set Desktop\release\phase1.conf`: the set commands;
   - `dialect convert --from junos --to iosxe --allow-incomplete Desktop\release\phase1.conf`: IOS-XE config, and on
     stderr the interfaces not yet named.
6. Run `Desktop\release\dialect-cli.exe --version`: `dialect <version>`, the standalone download, with nothing
   installed for it.
7. Double-click `Desktop\release\dialect.html`: it opens in Edge, with no network. Open `phase1.conf` in it and see the
   display set.
8. Uninstall: Settings → Apps → Installed apps → Dialect → Uninstall (the uninstaller shows the Dialect icon). Then:
   - `C:\Users\WDAGUtilityAccount\AppData\Local\Dialect` is gone;
   - in a **new** Command Prompt, `where dialect` can't find it, and `reg query HKCU\Environment /v Path` lists no
     `Dialect\cli` folder.

## 2. Normal installer, with network (`online.wsb`)

1. Run `Dialect_<version>_x64-setup.exe`. When it asks to add the dialect command to your PATH, choose **No**.
2. The app starts and converts as in 1.4. In a new Command Prompt, `where dialect` can't find it (you said No), but
   `"%LOCALAPPDATA%\Dialect\cli\dialect.exe" --version` works.
3. Run the installer again and choose **Yes**: a new Command Prompt finds `dialect`.
4. Uninstall, and check as in 1.8.

A silent install also adds the command: in a new Sandbox, `Dialect_<version>_x64-setup.exe /S`, then a new Command
Prompt finds `dialect`.

## 3. `dialect.html` in Chrome, from a USB stick

On a PC with Chrome (the Sandbox has only Edge): copy `dialect.html` to a USB stick, turn the network off (flight
mode), and open it from the stick in Chrome and in Edge. Both show Dialect, open a config and save output.

## What this doesn't cover

Windows Sandbox comes with WebView2 (it's part of Windows 11 and an up-to-date Windows 10), so it can't show the
installers putting WebView2 on a PC without it. Only an old or stripped Windows lacks it, such as a Windows 10 that
has never been updated, or an LTSC image. If one is to hand, run the offline installer there with the network off,
and the normal one with it on: either installs WebView2 first, then Dialect starts.
