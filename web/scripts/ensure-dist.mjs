/**
 * `wrangler dev` requires assets.directory to exist. The real site is built by
 * Vite (`pnpm build`), but while developing the API alone we create an empty
 * placeholder so the Worker can start.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(packageRoot, "dist");
mkdirSync(dist, { recursive: true });

const index = join(dist, "index.html");
if (!existsSync(index)) {
  writeFileSync(
    index,
    "<!doctype html><html><head><title>Ray</title></head><body></body></html>\n",
  );
}
