# Third-party notices

Dialect is MIT licensed (see `LICENSE`). This file lists third-party material
the project uses or adapts, with its license and the attribution it requires.

## Entries

### juniper-config-converter ("jcc") test fixtures

- **Project:** saidvandeklundert/juniper-config-converter
- **URL:** https://github.com/saidvandeklundert/juniper-config-converter
- **License:** MIT, Copyright (c) 2023 saidvandeklundert
- **What we used:** its 22 test fixture pairs (`tests/data/config_N.txt` and
  `config_N_set.txt`) as comparison data. The spike prototype
  (`spike/display_set/junos_set.py --compare DIR`) reads them from a local
  checkout of that repo, and `docs/spike-desktop-app.md` reports the results.
  No fixture files are copied into this repo yet. If any are copied in later,
  they must be cleaned up first (see "Contributing rules" in `README.md`) and
  keep this attribution.
- **NOTICE text:** none (MIT).

## How to add an entry

Add an entry here in the same commit that brings in the material, whether it
is a dependency, copied or adapted code, or test data. Give:

1. **Name**: the project or package name.
2. **URL**: where it comes from (repository or package page).
3. **License**: its SPDX identifier and copyright line. Only MIT, Apache-2.0,
   BSD or ISC; no GPL, LGPL, AGPL or unlicensed material.
4. **What we used**: what was used or adapted, and where it lives in this repo.
5. **NOTICE text**: for Apache-2.0, copy the project's `NOTICE` file text here
   word for word (and keep any NOTICE file shipped with it). Otherwise "none".

Ideas taken from a project without using its code or data (for example
netcanon) don't need an entry.
