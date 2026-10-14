- **Project:** Microsoft Edge WebView2 Runtime installers: the Evergreen Bootstrapper (`MicrosoftEdgeWebview2Setup.exe`,
  inside `Dialect_<version>_x64-setup.exe`) and the Evergreen Standalone Installer
  (`MicrosoftEdgeWebView2RuntimeInstallerX64.exe`, inside `Dialect_<version>_x64-offline-setup.exe`), as Tauri's
  bundler fetches them from Microsoft when the installers are built
- **URL:** https://developer.microsoft.com/microsoft-edge/webview2 (the downloads), and Microsoft's terms for
  distributing them with an app: https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution
- **License:** proprietary: Microsoft's. Copyright (C) Microsoft Corporation. Not an open-source license, so they ship
  under a recorded exception to Dialect's license rule (`EXCEPTIONS` in `scripts/licensePolicy.mjs`, decided by Darren
  Marshall, 2026-10-14, #89): unmodified, only to install the WebView2 Runtime on a PC that lacks it. The Runtime they
  install is Microsoft's, under Microsoft's own license terms, which its setup gives.
- **What we used:** the two installers, unmodified, run by Dialect's installer only when the PC has no WebView2 Runtime
  (Windows 11 and an up-to-date Windows 10 have it). Microsoft's distribution guide (the link above, as of 2026-10-02)
  allows both, in these words: for the bootstrapper, "Or, download the bootstrapper and package it with your WebView2
  app."; for the standalone installer, "Include the Evergreen Standalone Installer in your app installer or updater."
- **NOTICE text:** none
