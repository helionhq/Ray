/**
 * Bump Ray's version in every file that declares it.
 *
 * Usage: node scripts/bump-version.mjs [patch|minor|major]
 *
 * Prints the new version and nothing else so the release workflow can capture
 * it. Keeps package.json, tauri.conf.json, Cargo.toml, and Cargo.lock in step.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const BUMPS = ["patch", "minor", "major"];
const bump = process.argv[2] ?? "patch";

if (!BUMPS.includes(bump)) {
  console.error(`Unknown bump "${bump}". Use one of: ${BUMPS.join(", ")}.`);
  process.exit(1);
}

const root = resolve(import.meta.dirname, "..");
const read = (file) => readFileSync(resolve(root, file), "utf8");
const write = (file, text) => writeFileSync(resolve(root, file), text);

const packageJson = read("package.json");
const current = JSON.parse(packageJson).version;
const parsed = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
if (!parsed) {
  console.error(`package.json has a version that is not semver: "${current}"`);
  process.exit(1);
}

const [major, minor, patch] = parsed.slice(1).map(Number);
const next =
  bump === "major"
    ? `${major + 1}.0.0`
    : bump === "minor"
      ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`;

const tauriConf = read("src-tauri/tauri.conf.json");
const cargoToml = read("src-tauri/Cargo.toml");
const cargoLock = read("src-tauri/Cargo.lock");

const tauriVersion = JSON.parse(tauriConf).version;
const cargoVersion = /\[package\][\s\S]*?^version = "([^"]+)"/m.exec(cargoToml)?.[1];
const lockVersion =
  /\[\[package\]\]\r?\nname = "ray"\r?\nversion = "([^"]+)"/.exec(cargoLock)?.[1];

// Refuse to bump a tree whose declarations already disagree; that would make
// the installer, the About line, and the release tag lie about each other.
for (const [file, version] of [
  ["src-tauri/tauri.conf.json", tauriVersion],
  ["src-tauri/Cargo.toml", cargoVersion],
  ["src-tauri/Cargo.lock", lockVersion],
]) {
  if (version !== current) {
    console.error(
      `${file} is at ${version ?? "an unknown version"}, expected ${current}.`,
    );
    process.exit(1);
  }
}

// Replace only the top-level version line so these files keep their existing
// formatting (tauri.conf.json uses compact arrays that JSON.stringify would
// expand).
function setJsonVersion(file, before) {
  const after = before.replace(
    /^(\s*)"version":\s*"[^"]+"/m,
    `$1"version": "${next}"`,
  );
  if (after === before || JSON.parse(after).version !== next) {
    console.error(`Could not bump ${file}.`);
    process.exit(1);
  }
  write(file, after);
}

setJsonVersion("package.json", packageJson);
setJsonVersion("src-tauri/tauri.conf.json", tauriConf);
write(
  "src-tauri/Cargo.toml",
  cargoToml.replace(/(\[package\][\s\S]*?^version = )"[^"]+"/m, `$1"${next}"`),
);
write(
  "src-tauri/Cargo.lock",
  cargoLock.replace(
    /(\[\[package\]\]\r?\nname = "ray"\r?\nversion = )"[^"]+"/,
    `$1"${next}"`,
  ),
);

console.log(next);
