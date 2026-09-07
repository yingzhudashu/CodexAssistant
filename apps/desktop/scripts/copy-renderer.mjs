import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
await mkdir(join(root, "../dist/renderer"), { recursive: true });
await cp(join(root, "../src/renderer"), join(root, "../dist/renderer"), { recursive: true });
