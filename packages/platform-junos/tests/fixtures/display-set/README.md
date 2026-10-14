# Display set fixtures

jcc's 22 hierarchical → set test pairs, cleaned up for this repo: `config_N.conf` is the hierarchical config and
`config_N.set` the expected display set. `displaySetFixtures.test.ts` checks that each `.conf` gives its `.set` line for
line, in order.

- **Source:** [saidvandeklundert/juniper-config-converter](https://github.com/saidvandeklundert/juniper-config-converter)
  (MIT, Copyright (c) 2023 saidvandeklundert), `crates/jcc/tests/data/`, commit
  `d4574088266a100aafa37dfe79b85e478bfecec9`. The untouched copies are in `fixtures/public/junos/pairs/`, with their
  provenance in `fixtures/manifest.json`. They are copied, not shipped (`docs/SPEC.md` §3), so their attribution is the
  license text in `fixtures/LICENSES/juniper-config-converter.MIT.txt`, not `THIRD_PARTY_NOTICES.md`.
- **Generated, not hand-edited:** `../../cleanFixtures.ts` makes these files from the public copies, and a test fails
  if they differ from what it gives. After changing the cleaner, regenerate them with
  `DIALECT_WRITE_FIXTURES=1 npx vitest run packages/platform-junos`.

## What was cleaned

Following the repo's rule for configs (`docs/SPEC.md` §5). Each change is applied the same way to both files of a pair,
with one mapping across all 22 pairs, so a pair still matches and an address means the same thing everywhere.

- **Public IPv4 addresses** (the 455 the manifest's scan lists, nearly all in config_22) move into the documentation
  ranges `192.0.2.0/24`, `198.51.100.0/24` and `203.0.113.0/24`, one address each, skipping ones the files already
  use. Prefix lengths are kept, so a mapped network address can have host bits set (`198.51.100.169/24`): fine for a syntax test, not a
  routable plan. Private, loopback, link-local, multicast and reserved addresses stay.
- **Public IPv6 addresses** move into `2001:db8::/32`: each network part (before `::`) becomes `2001:db8:<n>`, and the
  host part is kept.
- **Password hashes and keys:** every `$1$`, `$5$`, `$6$` and `$9$` string becomes `$1$PLACEHOLDER` (and so on).
  `/* SECRET-DATA */` placeholders and jcc's made-up `"$some_hash"` stay as they are.
- **Names:** the host name `dar01-dal09` becomes `edge-1` and the site code `DAL09` becomes `site-1`. The other host
  names (`router-1`, `myrouter`, `vMX01`, `example-hostname`) and the descriptions are already neutral lab names.
- **Not changed:** AS numbers. config_22 is a lab that simulates a full table, so its static routes carry real public
  AS paths (`as-path path "6939 855"`) and its routing instances use lab ASNs (100, 300, 12156…). These are public
  routing data, not a customer's.

## Order corrections

jcc's expected files put a container's `deactivate` or `protect` line **before** the `set` lines of its subtree.
Juniper's documented display set puts it **after** them (`docs/spike-desktop-app.md`, "Ordering of `deactivate`
lines"), and Junos can't deactivate a hierarchy that doesn't exist yet. The expected files of three pairs were changed
to that order (`ORDER_CORRECTIONS` in `cleanFixtures.ts`):

| Pair | Line moved after its subtree |
|---|---|
| config_8 | `deactivate system scripts commit` |
| config_15 | `protect system services`, `deactivate system syslog` |
| config_16 | `protect system services` |
