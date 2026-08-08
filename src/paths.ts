import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SRC_DIR = dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = join(SRC_DIR, "..");
