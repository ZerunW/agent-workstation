// Copies non-TS assets (SQL schema) next to the compiled output.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = ["db/schema.sql"];
for (const rel of assets) {
  const to = join(root, "dist", rel);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(root, "src", rel), to);
}
