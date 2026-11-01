# Releasing Ray

Releases are automatic. Every merge into `main`:

1. Bumps the patch version in `package.json`, `src-tauri/tauri.conf.json`,
   `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock`
   (`scripts/bump-version.mjs`).
2. Commits and pushes that bump with `[skip release]` in the message.
3. Builds the NSIS installer on `windows-latest`.
4. Signs the updater bundle and publishes a GitHub Release tagged
   `v<version>`, including `latest.json`.

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
  repository secrets.
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
- Development builds never check for updates (`pnpm tauri dev` is excluded in
  `src/lib/updater.ts`), so a dev build cannot replace itself.
- If `main` ever gains a rule that blocks direct pushes, the version-bump push
  will fail. Give the workflow a fine-grained PAT with `contents: write` for
  this repository and use it as the checkout token instead.
