# Dialect

Dialect (working name) is a desktop app that translates network configs between vendor "dialects". It starts with Junos `display set` conversion (hierarchical config to `set` commands) and Junos ⇄ Cisco translation, with each platform (Junos, IOS/IOS-XE, NX-OS, IOS-XR, …) built as its own plugin so new vendors can be added without changing the core. See `docs/spike-desktop-app.md` for the research behind the design; `spike/` holds throwaway prototype code only.
