/**
 * Build the `latest.json` update manifest Tauri's updater polls.
 *
 * Usage: node scripts/latest-json.mjs <version> <installer-path> <owner/repo> <tag>
 *
 * Prints the manifest to stdout. Reads the signature written next to the
 * installer by `tauri signer sign`.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const [version, installer, repo, tag] = process.argv.slice(2);

if (!version || !installer || !repo || !tag) {
  console.error(
    "Usage: node scripts/latest-json.mjs <version> <installer-path> <owner/repo> <tag>",
  );
  process.exit(1);
}

const signature = readFileSync(`${installer}.sig`, "utf8").trim();
if (!signature) {
  console.error(`Signature file ${installer}.sig is empty.`);
  process.exit(1);
}

const name = basename(installer);
const url = `https://github.com/${repo}/releases/download/${tag}/${name}`;

const manifest = {
  version,
  notes: `Ray ${version} for Windows.`,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": { signature, url },
  },
};

console.log(JSON.stringify(manifest, null, 2));
