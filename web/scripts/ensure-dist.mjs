/**
 * `wrangler dev` requires assets.directory to exist. The real site is built by
 * Vite (`pnpm build` -> `dist/`), but while developing the API alone (or
 * running this Worker before ever building the site) we create an empty
 * placeholder so the Worker can start. A real build is never overwritten:
 * only a missing index.html is created.
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
