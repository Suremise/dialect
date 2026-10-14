# Hand-written notices

Two kinds of hand-written material for `THIRD_PARTY_NOTICES.md`.

## Other material

Entries for `THIRD_PARTY_NOTICES.md` for material that ships but isn't an npm package: copied or adapted code, and (from
B7) the installer's components. `scripts/thirdPartyNotices.mjs` lists them in `OTHER` and adds each file, as written,
under "Other material". Copied material that doesn't ship, such as the test configs in `fixtures/`, gets no entry: its
license texts in `fixtures/LICENSES/` are its attribution (`docs/SPEC.md`, License).

Add an entry in the same commit that brings the material in, as a new file here and a line in `OTHER`. Give:

1. **Project**: the project or package name.
2. **URL**: where it comes from, as an `https://` link.
3. **License**: its SPDX identifier and copyright line. What ships or is copied into the repo must be MIT or equally
   permissive (see the license rule in `docs/SPEC.md`).
4. **What we used**: what was used or adapted, and where it lives in this repo.
5. **NOTICE text**: for Apache-2.0, the project's `NOTICE` file text word for word (and keep any NOTICE file shipped
   with it). Otherwise "none".

Ideas taken from a project without using its code or data (for example netcanon) don't need an entry.

## Supplements: license texts a package doesn't give

A shipped npm package's notices entry normally comes from the installed package: its repository link and its LICENSE or
COPYING files. When that can't work, the check fails until the package has a reviewed supplement:

- it publishes no license file (only a `license` field, or only a NOTICE);
- it isn't installed on every platform (an optional dependency for another OS or CPU), so some machines can't read it.

To add one, put the license's full text, checked against the package's published license (its repository at that
version), in `texts/<name>@<version>.txt` (a scoped name's `/` as `__`), and add an entry to `SUPPLEMENTS` in
`scripts/thirdPartyNotices.mjs` with the text's file name, its `https://` link (or null), why it's needed and who
reviewed it. Keyed by version, so an update needs a fresh review. With a supplement, its link and text are used on every
machine, so the notices are the same wherever they're generated.
