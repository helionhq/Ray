# Releasing Ray

Releases are automatic. Every merge into `main` runs two jobs:

1. **Build** — a read-only job with no signing key and no `GITHUB_TOKEN`.
   It bumps the patch version in `package.json`,
   `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and
   `src-tauri/Cargo.lock` (`scripts/bump-version.mjs`), builds the NSIS
   installer on `windows-latest`, and checks that the installer exists, is
   non-empty, has the version in its filename, and that all four version
   files agree.
2. **Publish** — the only job with write access. Before committing, it
   verifies that the downloaded version files differ from the build's starting
   commit only in their version declarations (`scripts/verify-bump.mjs`) and
   installs dependencies with `--ignore-scripts`, so an altered build artifact
   cannot smuggle in other changes or lifecycle scripts. It then commits those
   four version files as `github-actions[bot]` with `[skip release]` in the
   message, signs the installer with `--app-version` so the signature's
   trusted comment carries the release version (`requireSignedVersion`),
   writes `latest.json`, pushes the bump to `main`, and creates the GitHub
   Release tagged `v<version>`. The tag points at the bump commit, and the
   bump is pushed only after the build and signing have both succeeded.

Assets on the release are the NSIS installer, its `.sig`, and `latest.json`.
Publishing uses `gh release` directly; `tauri-action` is no longer involved.

Installed copies of Ray check that release endpoint at launch and every six
hours, then offer the update in the sidebar. A manual check (and install) is
also in **Settings → About → Check for updates**.

To skip a release for a docs-only or internal change, put `[skip release]`
in the merge/squash commit message.

## Cutting a release manually

Actions → **Release** → **Run workflow**, on `main`, choosing `patch`,
`minor`, or `major`. The same pipeline runs; only the bump size differs.

## One-time setup (already done)

- The repository is public, so installed apps can read
  `https://github.com/helionhq/Ray/releases/latest/download/latest.json`
  without credentials. **Making the repo private again will stop updates.**
- The updater public key is in `src-tauri/tauri.conf.json`.
- `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` are
  repository secrets. Only the publish job receives them.
- The matching private key was generated at `~/.tauri/ray.key`, with its
  password at `~/.tauri/ray.key.password`.

**Back up those two files somewhere safe now.** If the private key is lost,
new installers can still be built, but existing installs cannot verify or
install updates and users must reinstall by hand. Do not regenerate the key
casually: installs already in the field only trust the public key baked into
the version they are running.

## Notes

- The installer is not Authenticode-signed, so Windows SmartScreen may warn on
  a first install. Tauri's updater signature (separate from Authenticode) is
  what guards the update channel.
- A local `pnpm tauri build` signs updater artifacts, so it needs the signing
  key. For an unsigned local installer, add
  `--config '{"bundle":{"createUpdaterArtifacts":false}}'`.
- Development builds never check for updates (`pnpm tauri dev` is excluded in
  `src/lib/updater.ts`), so a dev build cannot replace itself.
- If `main` ever gains a rule that blocks direct pushes, the version-bump push
  will fail. Give the workflow a fine-grained PAT with `contents: write` for
  this repository and use it as `GH_TOKEN` in the push and publish steps; the
  checkout deliberately does not persist credentials.
- If a release for the tag already exists, the publish step uploads the assets
  with `--clobber` instead of failing.
