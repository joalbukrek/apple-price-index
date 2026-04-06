import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = dirname(SRC_DIR);
export const DATA_DIR = join(PROJECT_ROOT, "data");
export const DEFAULT_TAX_RULES_PATH = join(PROJECT_ROOT, "data", "tax-rules.json");
export const DEFAULT_BUNDLED_CATALOG_ROOT = join(DATA_DIR, "catalogs");
export const DEFAULT_BUNDLED_FX_RATES_PATH = join(DATA_DIR, "fx-rates.snapshot.json");
export const DEFAULT_BUNDLED_TAX_RULES_SNAPSHOT_PATH = join(
  DATA_DIR,
  "tax-rules.snapshot.json",
);
