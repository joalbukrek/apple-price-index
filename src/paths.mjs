import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = dirname(SRC_DIR);
export const DEFAULT_TAX_RULES_PATH = join(PROJECT_ROOT, "data", "tax-rules.json");
