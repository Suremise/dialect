# Private configs, cleaned up

This folder is for the user's own device configs, after they have been cleaned. It holds only this README for now.

Unlike `fixtures/public/`, nothing here was published before. **A config goes in only once every item below is done.** This is the checklist from the repository README's contributing rules, plus banners and descriptions.

## Cleaning checklist

- [ ] **Passwords and password hashes:** user, root and enable passwords, `secret 5/8/9`, `password 7`, Junos `$1$`/`$5$`/`$6$` and `$9$` strings, TACACS+/RADIUS keys. Replace them with an obvious placeholder of the same shape, e.g. `secret 9 $9$PLACEHOLDER` or `encrypted-password "$6$PLACEHOLDER"`.
- [ ] **SNMP communities and SNMPv3 users and keys:** replace them with `public-example` / `private-example`.
- [ ] **Keys:** pre-shared keys (IKE/IPsec), routing protocol keys (OSPF, BGP, IS-IS MD5/key chains), SSH public keys, certificates and private keys. Remove certificates and private keys entirely.
- [ ] **Real public IP addresses:** move them into the documentation ranges `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24` and `2001:db8::/32`. Keep the addressing consistent: the same original address always maps to the same documentation address, so neighbours and routes still line up. Private (RFC 1918) addressing may stay.
- [ ] **Hostnames and domain names:** replace them with neutral names (`edge-1`, `core-2`, `example.net`).
- [ ] **Customer names**, and anything else that identifies an organisation: site codes, circuit IDs, account numbers, contact details, AS numbers that aren't private or documentation ASNs (use 64496–64511, 65536–65551 or private ASNs).
- [ ] **Banners and descriptions:** login/MOTD banners, interface, BGP neighbour and policy descriptions often name customers, people or sites. Rewrite or remove them.
- [ ] Search the cleaned file once more for every original name and address before committing it.

## Adding a file

Use the same layout as `fixtures/public/`: `private-cleaned/<platform>/<area>/<name>.<ext>`, LF line endings, and an entry in `fixtures/manifest.json` with `source` set to `"private"` and a note on what was cleaned. `fixtures/verify.mjs` checks only `public/` and `originals/` today: extend it when the first private file lands.
