import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fetchJson } from "./http.mjs";
import { DEFAULT_BUNDLED_FX_RATES_PATH } from "./paths.mjs";

const FX_URL = "https://open.er-api.com/v6/latest/TRY";
const FX_SNAPSHOT_VERSION = 1;

async function readBundledFxSnapshot() {
  try {
    const file = await readFile(DEFAULT_BUNDLED_FX_RATES_PATH, "utf8");
    const payload = JSON.parse(file);
    if (payload?.schemaVersion !== FX_SNAPSHOT_VERSION) {
      return null;
    }
    return payload.response ?? null;
  } catch {
    return null;
  }
}

export async function writeBundledFxSnapshot(response) {
  await mkdir(dirname(DEFAULT_BUNDLED_FX_RATES_PATH), { recursive: true });
  await writeFile(
    DEFAULT_BUNDLED_FX_RATES_PATH,
    JSON.stringify(
      {
        schemaVersion: FX_SNAPSHOT_VERSION,
        savedAt: new Date().toISOString(),
        response,
      },
      null,
      2,
    ),
    "utf8",
  );
}

export async function loadFxRates({ refresh = false } = {}) {
  if (!refresh) {
    const bundledSnapshot = await readBundledFxSnapshot();
    if (bundledSnapshot) {
      return bundledSnapshot;
    }
  }

  return fetchJson(FX_URL, {
    refresh,
    cacheHours: 6,
  });
}

export function convertToTry(amount, currency, fx) {
  if (amount == null || !currency) {
    return null;
  }

  const normalizedCurrency = currency.toUpperCase();
  if (normalizedCurrency === "TRY") {
    return amount;
  }

  const rate = fx?.rates?.[normalizedCurrency];
  if (!rate) {
    return null;
  }

  return amount / rate;
}
