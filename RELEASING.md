# Releasing Dialect

Dialect is released on this repository's [GitHub Releases](https://github.com/Suremise/dialect/releases), modelled on
Hive's `RELEASING.md`. There is no updater (#85): users find new versions there, or through Help → Releases on GitHub.
Agents make a release as a **draft** only; **Darren reviews and publishes it himself**.

## What a release contains

`npm run release` builds these and uploads them to a draft release `v<version>`, titled **Dialect &lt;version&gt;**:

| File | What it is |
|---|---|
| `Dialect_<version>_x64-setup.exe` | The NSIS installer, with Microsoft's WebView2 bootstrapper; installs the `dialect` command too |
| `Dialect_<version>_x64-offline-setup.exe` | The same with Microsoft's offline WebView2 installer inside, for a PC with no internet |
| `dialect-cli.exe` | The standalone `dialect` command (packages/cli's `dialect.exe`, renamed) |
| `dialect.html` | The offline single-file web build |
| `LICENSE`, `THIRD_PARTY_NOTICES.md` | Dialect's license, and the notices of what ships |

The notes come from `scripts/release-notes.md`: what each download is, that the installers and `dialect-cli.exe` are
**unsigned** (SmartScreen: More info → Run anyway), that `dialect.html` runs offline in a browser, the disclaimer, the
version's CHANGELOG section, each file's SHA-256 and the independence notice. The script also leaves everything, notes
included, in `dist/release/v<version>/`.

## Steps

1. **Main is green.** Everything for the release is merged into `main` and pushed, and CI
   (`.github/workflows/ci.yml`) has passed on that commit on GitHub: CI on GitHub's runners is the check that counts
   (Hive's 0.4.0 found a failure no local run could). Darren tests a build of it (the desktop installer is his to
   run, never an agent's, docs/SPEC.md and #89's clean-machine test plan).
2. **Version and release notes**, on a branch, reviewed like any card:
   - `npm run set-version -- <version>` (semver: `0.2.0`, or `0.2.0-beta.1` for a pre-release) writes it everywhere:
     the root and every workspace's `package.json` and their `@dialect/*` dependencies, `package-lock.json`,
     `tauri.conf.json`, `Cargo.toml` and `Cargo.lock`. `tests/version.test.ts` fails if any place differs.
   - In `CHANGELOG.md`, turn **Unreleased** into `## <version> — <day> <Month> <year>`, with a short summary first. It
     is bundled into the app (Help → Release Notes), and the script puts the same section into the release notes.
   - `npm run screenshots` makes the README's screenshots again (light and dark, from `docs/screenshots/sample.conf`:
     documentation addresses and placeholder names only, no secrets).
   - `npm run licenses` if anything changed what ships (the script refuses stale notices, as CI does).

   Merge the branch to main and push main; wait for CI to pass on GitHub.
3. **Build and upload,** in the main checkout at that commit: `npm run release`. It refuses a dirty tree, a version
   that isn't the same everywhere, a CHANGELOG without the version's section, stale notices, a commit that isn't on
   `origin/main`, and a version already published. It builds the web page, the CLI and both installers (needs Rust and
   Node 24.19.0, as for `npm run build:installers`), then creates the draft, naming that commit (or updates the draft,
   replacing its files and notes, if one exists). It reads the release's state again just before each change on
   GitHub, so a draft published while the installers build is left alone. `npm run release -- --dry-run` does
   everything but the upload.
4. **Darren reviews the draft** on GitHub: the notes, the files and their SHA-256s (the script prints them). Tick
   **Set as a pre-release** for a beta, then **Publish**. Publishing creates the tag `v<version>` on the commit the
   draft names.

## Notes

- The release is built locally: CI's `desktop` job builds the same installers and `dialect.exe` (kept as the run's
  artifacts for 14 days, never released), so a build that only fails locally, or only on GitHub, shows up there.
- Don't delete or replace the files of a published release: publish a new version instead.
- `main` is protected: it can't be force-pushed or deleted, and a pull request merges only once CI's `check` and
  `desktop` jobs pass. Admins aren't held to it, so the usual flow (merge locally, push main) still works: check CI on
  every push of main.
- No code signing yet (docs/SPEC.md §10). If that changes, sign the installers and `dialect-cli.exe` before the upload
  and drop "unsigned" from `scripts/release-notes.md`.
