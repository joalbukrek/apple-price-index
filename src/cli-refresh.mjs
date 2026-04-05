import {
  buildRefreshTaskId,
  clearRefreshCheckpoint,
  DEFAULT_CATALOG_CACHE_DAYS,
  hasFreshCatalogSnapshot,
  readRefreshCheckpoint,
  writeRefreshCheckpoint,
} from "./catalog-cache.mjs";
import { discoverStorefronts, loadFamilyCatalog } from "./apple.mjs";
import { getHttpStatsSnapshot, isAppleRejectionError, isNotFoundError } from "./http.mjs";
import { mapLimit } from "./utils.mjs";
import {
  buildCatalogTasks,
  buildRefreshJobKey,
  DEFAULT_COMPARE_COUNTRIES,
  DEFAULT_WARMUP_FAMILY_SLUGS,
  filterSupportedStorefronts,
  resolveCountrySelectors,
  resolveFamilySlugs,
  resolveRequestedStorefronts,
  SNAPSHOT_WARMUP_CONCURRENCY,
} from "./cli-common.mjs";

function isUnsupportedCatalogError(error) {
  return (
    isNotFoundError(error) ||
    /Apple did not expose product selection data/i.test(error?.message ?? "")
  );
}

function formatRefreshTaskLabel(storefront, familySlug) {
  return `${storefront.countryCode.toUpperCase()} ${familySlug}`;
}

function diffHttpStats(before, after) {
  return {
    logicalRequests: after.logicalRequests - before.logicalRequests,
    cacheHits: after.cacheHits - before.cacheHits,
    networkRequests: after.networkRequests - before.networkRequests,
    appleNetworkRequests: after.appleNetworkRequests - before.appleNetworkRequests,
    retries: after.retries - before.retries,
    networkDurationMs: after.networkDurationMs - before.networkDurationMs,
  };
}

export function formatDurationMs(durationMs) {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  const seconds = durationMs / 1000;
  if (seconds < 60) {
    return `${seconds < 10 ? seconds.toFixed(1) : seconds.toFixed(0)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds - minutes * 60;
  return `${minutes}m ${remainingSeconds < 10 ? remainingSeconds.toFixed(1) : remainingSeconds.toFixed(0)}s`;
}

function formatRefreshMetrics(metrics) {
  const parts = [];

  if (metrics.appleNetworkRequests > 0) {
    parts.push(
      `${metrics.appleNetworkRequests} Apple req${metrics.appleNetworkRequests === 1 ? "" : "s"}`,
    );
  }

  if (metrics.retries > 0) {
    parts.push(`${metrics.retries} retr${metrics.retries === 1 ? "y" : "ies"}`);
  }

  parts.push(formatDurationMs(metrics.elapsedMs));
  return parts.join(" | ");
}

async function warmCatalogTasks(tasks, { refresh = false, showProgress = false } = {}) {
  let completed = 0;

  return mapLimit(tasks, SNAPSHOT_WARMUP_CONCURRENCY, async ({ storefront, familySlug }) => {
    try {
      const catalog = await loadFamilyCatalog(storefront, familySlug, {
        refresh,
        snapshotDays: DEFAULT_CATALOG_CACHE_DAYS,
      });
      completed += 1;

      if (showProgress) {
        console.log(
          `[${completed}/${tasks.length}] ${storefront.countryCode.toUpperCase()} ${catalog.family.name}: ${catalog.variants.length} variants`,
        );
      }

      return {
        storefront,
        familySlug,
        variantCount: catalog.variants.length,
        success: true,
      };
    } catch (error) {
      completed += 1;

      if (showProgress) {
        console.log(
          `[${completed}/${tasks.length}] ${storefront.countryCode.toUpperCase()} ${familySlug}: skipped (${error.message || error})`,
        );
      }

      return {
        storefront,
        familySlug,
        variantCount: 0,
        success: false,
        error: error.message || String(error),
      };
    }
  });
}

export async function ensureDefaultCatalogSnapshots(values, storefronts) {
  const selectedStorefronts = filterSupportedStorefronts(storefronts);
  const tasks = buildCatalogTasks(selectedStorefronts, DEFAULT_WARMUP_FAMILY_SLUGS);

  const pendingTasks = values.refresh
    ? tasks
    : (
        await mapLimit(tasks, 12, async (task) =>
          (await hasFreshCatalogSnapshot(task.storefront, task.familySlug, {
            maxAgeDays: DEFAULT_CATALOG_CACHE_DAYS,
          }))
            ? null
            : task,
        )
      ).filter(Boolean);

  if (!pendingTasks.length) {
    return;
  }

  console.log(
    `Preparing a ${DEFAULT_CATALOG_CACHE_DAYS}-day Apple price snapshot for ${selectedStorefronts.length} countries and ${DEFAULT_WARMUP_FAMILY_SLUGS.length} Mac families.`,
  );
  console.log("This may take a few minutes the first time.\n");
  await warmCatalogTasks(pendingTasks, {
    refresh: true,
    showProgress: true,
  });
  console.log("");
}

export async function commandUpdatePrices(values) {
  const requestedFamily = values.family ?? "all";
  const familySlugs = resolveFamilySlugs(requestedFamily);
  const storefronts = filterSupportedStorefronts(
    await discoverStorefronts({
      refresh: values.refresh,
      allLocales: values["all-locales"],
    }),
  );
  const selectedStorefronts =
    values.countries === "all"
      ? storefronts
      : resolveRequestedStorefronts(storefronts, resolveCountrySelectors(values.countries));
  const tasks = buildCatalogTasks(selectedStorefronts, familySlugs);
  const jobKey = buildRefreshJobKey(selectedStorefronts, familySlugs);
  const checkpoint = await readRefreshCheckpoint(jobKey);
  const taskStates = { ...(checkpoint?.taskStates ?? {}) };
  const startedAt = checkpoint?.startedAt ?? new Date().toISOString();
  const completedTaskIds = new Set(
    Object.entries(taskStates)
      .filter(([, state]) => state?.status === "success" || state?.status === "unsupported")
      .map(([taskId]) => taskId),
  );
  const pendingTasks = tasks.filter(
    ({ storefront, familySlug }) => !completedTaskIds.has(buildRefreshTaskId(storefront, familySlug)),
  );

  console.log(
    `Updating Apple price snapshots for ${selectedStorefronts.length} countries and ${familySlugs.length} Mac families.\n`,
  );

  if (checkpoint) {
    console.log(
      `Resuming saved refresh job from ${checkpoint.savedAt}. ${completedTaskIds.size}/${tasks.length} tasks already completed.\n`,
    );
  } else {
    await writeRefreshCheckpoint(jobKey, {
      startedAt,
      countryCodes: selectedStorefronts.map((storefront) => storefront.countryCode),
      familySlugs,
      taskStates,
      lastError: null,
    });
  }

  let processedCount = completedTaskIds.size;

  for (const { storefront, familySlug } of pendingTasks) {
    const taskId = buildRefreshTaskId(storefront, familySlug);
    const taskStartedAtMs = Date.now();
    const statsBefore = getHttpStatsSnapshot();

    try {
      const catalog = await loadFamilyCatalog(storefront, familySlug, {
        refresh: true,
        snapshotDays: DEFAULT_CATALOG_CACHE_DAYS,
      });
      const statsAfter = getHttpStatsSnapshot();
      const taskMetrics = {
        ...diffHttpStats(statsBefore, statsAfter),
        elapsedMs: Date.now() - taskStartedAtMs,
      };

      processedCount += 1;
      taskStates[taskId] = {
        status: "success",
        completedAt: new Date().toISOString(),
        countryCode: storefront.countryCode,
        localeKey: storefront.localeKey,
        familySlug,
        variantCount: catalog.variants.length,
        appleNetworkRequests: taskMetrics.appleNetworkRequests,
        networkRequests: taskMetrics.networkRequests,
        retries: taskMetrics.retries,
        networkDurationMs: taskMetrics.networkDurationMs,
        elapsedMs: taskMetrics.elapsedMs,
      };

      await writeRefreshCheckpoint(jobKey, {
        startedAt,
        countryCodes: selectedStorefronts.map((storefrontCandidate) => storefrontCandidate.countryCode),
        familySlugs,
        taskStates,
        lastError: null,
      });

      console.log(
        `[${processedCount}/${tasks.length}] ${storefront.countryCode.toUpperCase()} ${catalog.family.name}: ${catalog.variants.length} variants | ${formatRefreshMetrics(taskMetrics)}`,
      );
    } catch (error) {
      const statsAfter = getHttpStatsSnapshot();
      const taskMetrics = {
        ...diffHttpStats(statsBefore, statsAfter),
        elapsedMs: Date.now() - taskStartedAtMs,
      };

      if (isUnsupportedCatalogError(error)) {
        processedCount += 1;
        taskStates[taskId] = {
          status: "unsupported",
          completedAt: new Date().toISOString(),
          countryCode: storefront.countryCode,
          localeKey: storefront.localeKey,
          familySlug,
          variantCount: 0,
          error: error.message || String(error),
          appleNetworkRequests: taskMetrics.appleNetworkRequests,
          networkRequests: taskMetrics.networkRequests,
          retries: taskMetrics.retries,
          networkDurationMs: taskMetrics.networkDurationMs,
          elapsedMs: taskMetrics.elapsedMs,
        };

        await writeRefreshCheckpoint(jobKey, {
          startedAt,
          countryCodes: selectedStorefronts.map((storefrontCandidate) => storefrontCandidate.countryCode),
          familySlugs,
          taskStates,
          lastError: null,
        });

        console.log(
          `[${processedCount}/${tasks.length}] ${formatRefreshTaskLabel(storefront, familySlug)}: skipped (${error.message || error}) | ${formatRefreshMetrics(taskMetrics)}`,
        );
        continue;
      }

      taskStates[taskId] = {
        status: "failed",
        completedAt: new Date().toISOString(),
        countryCode: storefront.countryCode,
        localeKey: storefront.localeKey,
        familySlug,
        variantCount: 0,
        error: error.message || String(error),
        appleNetworkRequests: taskMetrics.appleNetworkRequests,
        networkRequests: taskMetrics.networkRequests,
        retries: taskMetrics.retries,
        networkDurationMs: taskMetrics.networkDurationMs,
        elapsedMs: taskMetrics.elapsedMs,
      };

      await writeRefreshCheckpoint(jobKey, {
        startedAt,
        countryCodes: selectedStorefronts.map((storefrontCandidate) => storefrontCandidate.countryCode),
        familySlugs,
        taskStates,
        lastError: {
          taskId,
          countryCode: storefront.countryCode,
          localeKey: storefront.localeKey,
          familySlug,
          message: error.message || String(error),
          httpStatus: error.httpStatus ?? null,
          happenedAt: new Date().toISOString(),
        },
      });

      if (isAppleRejectionError(error)) {
        console.log(
          `\nApple started rejecting requests for ${formatRefreshTaskLabel(storefront, familySlug)}${error.httpStatus ? ` (HTTP ${error.httpStatus})` : ""}.`,
        );
        console.log(
          `Progress was saved after ${formatRefreshMetrics(taskMetrics)}. Rerun the same update-prices command later to resume.\n`,
        );
        throw new Error("Refresh stopped after Apple rejected requests.");
      }

      console.log(
        `[${processedCount}/${tasks.length}] ${formatRefreshTaskLabel(storefront, familySlug)}: failed (${error.message || error}) | ${formatRefreshMetrics(taskMetrics)}`,
      );
      console.log("Progress was saved. Rerun the same update-prices command later to resume.\n");
      throw error;
    }
  }

  const completedStates = Object.values(taskStates);
  const successfulResults = completedStates.filter((state) => state.status === "success");
  const failedResults = completedStates.filter((state) => state.status === "failed");
  const unsupportedResults = completedStates.filter((state) => state.status === "unsupported");
  const totalVariants = successfulResults.reduce(
    (sum, result) => sum + (result.variantCount ?? 0),
    0,
  );
  const totalAppleRequests = completedStates.reduce(
    (sum, result) => sum + (result.appleNetworkRequests ?? 0),
    0,
  );
  const totalRetries = completedStates.reduce(
    (sum, result) => sum + (result.retries ?? 0),
    0,
  );
  const totalNetworkDurationMs = completedStates.reduce(
    (sum, result) => sum + (result.networkDurationMs ?? 0),
    0,
  );
  const totalActiveTaskDurationMs = completedStates.reduce(
    (sum, result) => sum + (result.elapsedMs ?? 0),
    0,
  );

  await clearRefreshCheckpoint(jobKey);

  console.log(
    `\nUpdated ${successfulResults.length} catalog snapshots with ${totalVariants} total product variants.`,
  );
  console.log(
    `Observed ${totalAppleRequests} Apple requests, ${totalRetries} retries, ${formatDurationMs(totalNetworkDurationMs)} of request time, and ${formatDurationMs(totalActiveTaskDurationMs)} of active task time.`,
  );

  if (unsupportedResults.length) {
    console.log(
      `Skipped ${unsupportedResults.length} catalog(s) that Apple did not expose through this buyflow.`,
    );
  }

  if (failedResults.length) {
    console.log(`Encountered ${failedResults.length} failed catalog refreshes.`);
  }
}
