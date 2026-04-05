import { homedir } from "node:os";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const CATALOG_CACHE_VERSION = 2;
export const DEFAULT_CATALOG_CACHE_DAYS = 30;
const REFRESH_CHECKPOINT_VERSION = 1;

const CATALOG_CACHE_ROOT = join(homedir(), ".cache", "apple-price-index", "catalogs");
const REFRESH_CHECKPOINT_ROOT = join(CATALOG_CACHE_ROOT, "refresh-jobs");

function toSafeSegment(value = "") {
  return String(value).replace(/[^a-z0-9_-]+/gi, "_");
}

function catalogCachePath(storefront, familySlug) {
  const country = toSafeSegment(storefront?.countryCode ?? "unknown");
  const locale = toSafeSegment(storefront?.localeKey ?? "unknown");
  const family = toSafeSegment(familySlug);
  return join(CATALOG_CACHE_ROOT, `${country}__${locale}__${family}.json`);
}

function refreshCheckpointPath(jobKey) {
  return join(REFRESH_CHECKPOINT_ROOT, `${toSafeSegment(jobKey)}.json`);
}

async function readCachedFile(storefront, familySlug) {
  const filePath = catalogCachePath(storefront, familySlug);

  try {
    const [metadata, file] = await Promise.all([
      stat(filePath),
      readFile(filePath, "utf8"),
    ]);

    return {
      metadata,
      payload: JSON.parse(file),
    };
  } catch {
    return null;
  }
}

export async function readCatalogSnapshot(
  storefront,
  familySlug,
  { maxAgeDays = DEFAULT_CATALOG_CACHE_DAYS } = {},
) {
  const cached = await readCachedFile(storefront, familySlug);
  if (!cached) {
    return null;
  }

  const { metadata, payload } = cached;
  if (payload?.schemaVersion !== CATALOG_CACHE_VERSION) {
    return null;
  }

  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  if (Date.now() - metadata.mtimeMs > maxAgeMs) {
    return null;
  }

  return {
    savedAt: payload.savedAt,
    familyUrl: payload.familyUrl,
    currency: payload.currency,
    variants: payload.variants ?? [],
  };
}

export async function hasFreshCatalogSnapshot(
  storefront,
  familySlug,
  { maxAgeDays = DEFAULT_CATALOG_CACHE_DAYS } = {},
) {
  return Boolean(await readCatalogSnapshot(storefront, familySlug, { maxAgeDays }));
}

export async function writeCatalogSnapshot(storefront, familySlug, data) {
  const filePath = catalogCachePath(storefront, familySlug);
  await mkdir(CATALOG_CACHE_ROOT, { recursive: true });
  await writeFile(
    filePath,
    JSON.stringify(
      {
        schemaVersion: CATALOG_CACHE_VERSION,
        savedAt: new Date().toISOString(),
        familyUrl: data.familyUrl,
        currency: data.currency,
        variants: data.variants,
      },
      null,
      2,
    ),
    "utf8",
  );
}

export function buildRefreshTaskId(storefront, familySlug) {
  const country = toSafeSegment(storefront?.countryCode ?? "unknown");
  const locale = toSafeSegment(storefront?.localeKey ?? "unknown");
  const family = toSafeSegment(familySlug);
  return `${country}__${locale}__${family}`;
}

export async function readRefreshCheckpoint(jobKey) {
  const filePath = refreshCheckpointPath(jobKey);

  try {
    const file = await readFile(filePath, "utf8");
    const payload = JSON.parse(file);

    if (payload?.schemaVersion !== REFRESH_CHECKPOINT_VERSION) {
      return null;
    }

    return {
      jobKey: payload.jobKey,
      startedAt: payload.startedAt,
      savedAt: payload.savedAt,
      countryCodes: payload.countryCodes ?? [],
      familySlugs: payload.familySlugs ?? [],
      taskStates: payload.taskStates ?? {},
      lastError: payload.lastError ?? null,
    };
  } catch {
    return null;
  }
}

export async function writeRefreshCheckpoint(jobKey, data) {
  const filePath = refreshCheckpointPath(jobKey);
  await mkdir(REFRESH_CHECKPOINT_ROOT, { recursive: true });
  await writeFile(
    filePath,
    JSON.stringify(
      {
        schemaVersion: REFRESH_CHECKPOINT_VERSION,
        jobKey,
        startedAt: data.startedAt,
        savedAt: new Date().toISOString(),
        countryCodes: data.countryCodes ?? [],
        familySlugs: data.familySlugs ?? [],
        taskStates: data.taskStates ?? {},
        lastError: data.lastError ?? null,
      },
      null,
      2,
    ),
    "utf8",
  );
}

export async function clearRefreshCheckpoint(jobKey) {
  const filePath = refreshCheckpointPath(jobKey);

  try {
    await unlink(filePath);
  } catch {
    return;
  }
}
