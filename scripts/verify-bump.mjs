/**
 * Verify the downloaded release artifact before the publish job commits it.
 *
 * Usage: node scripts/verify-bump.mjs <expected-version>
 *
 * The publish checkout is detached at the pre-bump commit, so each downloaded
 * file must differ from `HEAD:<file>` only in its version declaration and must
 * name the expected version. Anything else means the build output was altered.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const expected = process.argv[2];

if (!expected || !/^\d+\.\d+\.\d+$/.test(expected)) {
  console.error("Usage: node scripts/verify-bump.mjs <expected-version>");
  process.exit(1);
}

const normalize = (text) => text.replace(/\r\n/g, "\n");
const head = (file) =>
  normalize(execFileSync("git", ["show", `HEAD:${file}`], { encoding: "utf8" }));
const working = (file) => normalize(readFileSync(file, "utf8"));

function fail(file, reason) {
  console.error(`${file}: ${reason}`);
  process.exit(1);
}

for (const file of ["package.json", "src-tauri/tauri.conf.json"]) {
  const headText = head(file);
  const workingText = working(file);
  let workingJson;
  try {
    JSON.parse(headText);
    workingJson = JSON.parse(workingText);
  } catch (error) {
    fail(file, `could not parse JSON: ${error.message}`);
  }
  if (workingJson.version !== expected) {
    fail(
      file,
      `working version is ${workingJson.version ?? "missing"}, expected ${expected}`,
    );
  }
  // Compare the text, not the parsed value: a reformatted file would pass a
  // deep-equal check but break the next bump script, which expects the version
  // declaration on its own line.
  const versionLine = /^(\s*)"version":\s*"[^"]+"/m;
  if (!versionLine.test(headText)) {
    fail(file, "could not find the version declaration in HEAD");
  }
  const expectedText = headText.replace(
    versionLine,
    `$1"version": "${expected}"`,
  );
  if (expectedText !== workingText) {
    fail(file, "differs from HEAD beyond the version field");
  }
}

const cargoChecks = [
  {
    file: "src-tauri/Cargo.toml",
    versionPattern: /\[package\][\s\S]*?^version = "([^"]+)"/m,
    bumpPattern: /(\[package\][\s\S]*?^version = )"[^"]+"/m,
  },
  {
    file: "src-tauri/Cargo.lock",
    versionPattern:
      /\[\[package\]\]\r?\nname = "ray"\r?\nversion = "([^"]+)"/,
    bumpPattern:
      /(\[\[package\]\]\r?\nname = "ray"\r?\nversion = )"[^"]+"/,
  },
];

for (const { file, versionPattern, bumpPattern } of cargoChecks) {
  const headText = head(file);
  const workingText = working(file);
  const workingVersion = versionPattern.exec(workingText)?.[1];
  if (workingVersion !== expected) {
    fail(
      file,
      `working version is ${workingVersion ?? "missing"}, expected ${expected}`,
    );
  }
  if (!bumpPattern.test(headText)) {
    fail(file, "could not find the version declaration in HEAD");
  }
  const expectedText = headText.replace(bumpPattern, `$1"${expected}"`);
  if (expectedText !== workingText) {
    fail(file, "differs from HEAD beyond the version line");
  }
}

console.log(`Verified ${expected}: only version declarations differ from HEAD.`);
