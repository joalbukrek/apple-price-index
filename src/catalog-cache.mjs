import { homedir } from "node:os";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_BUNDLED_CATALOG_ROOT } from "./paths.mjs";

export const CATALOG_CACHE_VERSION = 2;
export const DEFAULT_CATALOG_CACHE_DAYS = 30;
const REFRESH_CHECKPOINT_VERSION = 1;

const USER_CATALOG_CACHE_ROOT = join(homedir(), ".cache", "apple-price-index", "catalogs");
const REFRESH_CHECKPOINT_ROOT = join(USER_CATALOG_CACHE_ROOT, "refresh-jobs");

function toSafeSegment(value = "") {
  return String(value).replace(/[^a-z0-9_-]+/gi, "_");
}

function catalogSnapshotPath(root, storefront, familySlug) {
  const country = toSafeSegment(storefront?.countryCode ?? "unknown");
  const locale = toSafeSegment(storefront?.localeKey ?? "unknown");
  const family = toSafeSegment(familySlug);
  return join(root, `${country}__${locale}__${family}.json`);
}

function catalogCachePath(storefront, familySlug) {
  return catalogSnapshotPath(USER_CATALOG_CACHE_ROOT, storefront, familySlug);
}

function bundledCatalogPath(storefront, familySlug) {
  return catalogSnapshotPath(DEFAULT_BUNDLED_CATALOG_ROOT, storefront, familySlug);
}

function refreshCheckpointPath(jobKey) {
  return join(REFRESH_CHECKPOINT_ROOT, `${toSafeSegment(jobKey)}.json`);
}

async function readSnapshotFile(filePath) {
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

function snapshotSavedAtMs(metadata, payload) {
  const parsedSavedAt = Date.parse(payload?.savedAt ?? "");
  return Number.isNaN(parsedSavedAt) ? metadata.mtimeMs : parsedSavedAt;
}

function normalizeSnapshot(cached, source) {
  if (!cached) {
    return null;
  }

  const { metadata, payload } = cached;
  if (payload?.schemaVersion !== CATALOG_CACHE_VERSION) {
    return null;
  }

  return {
    source,
    savedAt: payload.savedAt,
    savedAtMs: snapshotSavedAtMs(metadata, payload),
    familyUrl: payload.familyUrl,
    currency: payload.currency,
    unsupported: Boolean(payload.unsupported),
    variants: payload.variants ?? [],
  };
}

function isFreshSnapshot(snapshot, maxAgeDays) {
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  return Date.now() - snapshot.savedAtMs <= maxAgeMs;
}

function pickNewestSnapshot(snapshots) {
  return [...snapshots].sort((left, right) => right.savedAtMs - left.savedAtMs)[0] ?? null;
}

async function readSnapshotFromRoot(root, source, storefront, familySlug) {
  return normalizeSnapshot(
    await readSnapshotFile(catalogSnapshotPath(root, storefront, familySlug)),
    source,
  );
}

export async function readUserCatalogSnapshot(
  storefront,
  familySlug,
  { maxAgeDays = DEFAULT_CATALOG_CACHE_DAYS, allowStale = true } = {},
) {
  const snapshot = await readSnapshotFromRoot(
    USER_CATALOG_CACHE_ROOT,
    "user",
    storefront,
    familySlug,
  );

  if (!snapshot) {
    return null;
  }

  return allowStale || isFreshSnapshot(snapshot, maxAgeDays) ? snapshot : null;
}

export async function readBundledCatalogSnapshot(
  storefront,
  familySlug,
  { maxAgeDays = DEFAULT_CATALOG_CACHE_DAYS, allowStale = true } = {},
) {
  const snapshot = await readSnapshotFromRoot(
    DEFAULT_BUNDLED_CATALOG_ROOT,
    "bundled",
    storefront,
    familySlug,
  );

  if (!snapshot) {
    return null;
  }

  return allowStale || isFreshSnapshot(snapshot, maxAgeDays) ? snapshot : null;
}

export async function readCatalogSnapshot(
  storefront,
  familySlug,
  { maxAgeDays = DEFAULT_CATALOG_CACHE_DAYS, allowStale = true } = {},
) {
  const snapshots = (
    await Promise.all([
      readUserCatalogSnapshot(storefront, familySlug, { maxAgeDays, allowStale }),
      readBundledCatalogSnapshot(storefront, familySlug, { maxAgeDays, allowStale }),
    ])
  ).filter(Boolean);

  if (!snapshots.length) {
    return null;
  }

  return pickNewestSnapshot(snapshots);
}

export async function hasFreshCatalogSnapshot(
  storefront,
  familySlug,
  { maxAgeDays = DEFAULT_CATALOG_CACHE_DAYS } = {},
) {
  return Boolean(
    await readCatalogSnapshot(storefront, familySlug, {
      maxAgeDays,
      allowStale: false,
    }),
  );
}

export async function writeCatalogSnapshot(storefront, familySlug, data) {
  const filePath = catalogCachePath(storefront, familySlug);
  await mkdir(USER_CATALOG_CACHE_ROOT, { recursive: true });
  await writeFile(
    filePath,
    JSON.stringify(
      {
        schemaVersion: CATALOG_CACHE_VERSION,
        savedAt: new Date().toISOString(),
        familyUrl: data.familyUrl,
        currency: data.currency,
        unsupported: Boolean(data.unsupported),
        variants: data.variants,
      },
      null,
      2,
    ),
    "utf8",
  );
}

export async function writeBundledCatalogSnapshot(storefront, familySlug, data) {
  const filePath = bundledCatalogPath(storefront, familySlug);
  await mkdir(DEFAULT_BUNDLED_CATALOG_ROOT, { recursive: true });
  await writeFile(
    filePath,
    JSON.stringify(
      {
        schemaVersion: CATALOG_CACHE_VERSION,
        savedAt: data.savedAt ?? new Date().toISOString(),
        familyUrl: data.familyUrl,
        currency: data.currency,
        unsupported: Boolean(data.unsupported),
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
