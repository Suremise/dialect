# Dialect

Dialect (working name) is a desktop app that translates network configs between vendor "dialects". It starts with Junos `display set` conversion (hierarchical config to `set` commands) and Junos ⇄ Cisco translation, with each platform (Junos, IOS/IOS-XE, NX-OS, IOS-XR, …) built as its own plugin so new vendors can be added without changing the core. See `docs/spike-desktop-app.md` for the research behind the design; `spike/` holds throwaway prototype code only.

## License

MIT, see `LICENSE`. Third-party material is listed in `THIRD_PARTY_NOTICES.md`.

## Trademarks

Juniper, Junos and Cisco are trademarks of their respective owners. Dialect is not affiliated with or endorsed by Juniper Networks or Cisco Systems.

## Contributing rules

- **Dependencies and code must be MIT-compatible:** MIT, Apache-2.0, BSD or ISC only. No GPL, LGPL or AGPL code or dependencies, and no code without a license. Record third-party material in `THIRD_PARTY_NOTICES.md` (Apache-2.0 also needs its NOTICE text).
- **Sample configs and test fixtures must be cleaned up first.** Before committing one, remove passwords and password hashes, SNMP communities, keys, real public IP addresses, hostnames and customer names. Use documentation ranges instead: `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24` and `2001:db8::/32`.
