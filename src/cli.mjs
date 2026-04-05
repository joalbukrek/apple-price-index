#!/usr/bin/env node

import { createHash } from "node:crypto";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  buildRefreshTaskId,
  clearRefreshCheckpoint,
  DEFAULT_CATALOG_CACHE_DAYS,
  hasFreshCatalogSnapshot,
  readRefreshCheckpoint,
  writeRefreshCheckpoint,
} from "./catalog-cache.mjs";
import {
  discoverStorefronts,
  filterVariants,
  loadFamilyCatalog,
  MAC_FAMILIES,
  resolveStorefront,
} from "./apple.mjs";
import { loadFxRates, convertToTry } from "./fx.mjs";
import {
  getHttpStatsSnapshot,
  isAppleRejectionError,
  isNotFoundError,
} from "./http.mjs";
import { DEFAULT_TAX_RULES_PATH } from "./paths.mjs";
import { applyTaxRule, loadTaxRules } from "./tax.mjs";
import { formatDeltaTry, formatMoney, formatTry, mapLimit, parseCsv, renderTable } from "./utils.mjs";

const SUPPORTED_COUNTRY_CODES = [
  "vn",
  "hk",
  "jp",
  "kr",
  "th",
  "in",
  "ph",
  "tw",
  "ae",
  "my",
  "ca",
  "tr",
  "nz",
  "cn",
  "sg",
  "au",
  "ch",
  "uk",
  "lu",
  "pl",
  "cl",
  "at",
  "be",
  "de",
  "es",
  "fr",
  "nl",
  "mx",
  "cz",
  "ie",
  "it",
  "pt",
  "fi",
  "dk",
  "hu",
  "no",
  "se",
  "br",
];
const DEFAULT_COMPARE_COUNTRY_CODES = SUPPORTED_COUNTRY_CODES;
const DEFAULT_COMPARE_COUNTRIES = DEFAULT_COMPARE_COUNTRY_CODES.join(",");
const DEFAULT_WARMUP_FAMILY_SLUGS = MAC_FAMILIES.map((family) => family.slug);
const DEFAULT_COMPARE_ROW_LIMIT = 20;
const SNAPSHOT_WARMUP_CONCURRENCY = 1;
const VARIANT_PAGE_SIZE = 20;

function usage() {
  return `Usage:
  node cli.mjs
  npm start
  apple-price-index

Commands:
  node cli.mjs interactive
  node cli.mjs countries [--all-locales] [--refresh]
  node cli.mjs list-products --family <slug> [--country tr] [--query "..."] [--refresh]
  node cli.mjs compare --family <slug> (--variant <variant_key> | --query "...") [--countries <csv>|all] [--resolve-country tr] [--refresh]
  node cli.mjs cheapest --family <slug|all> [--countries <csv>|all] [--query "..."] [--limit 20] [--refresh]
  node cli.mjs update-prices [--family <slug|all>] [--countries <csv>|all]

Known family slugs:
  ${MAC_FAMILIES.map((family) => family.slug).join(", ")}`;
}

function parseOptions() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "all-locales": { type: "boolean", default: false },
      countries: { type: "string" },
      country: { type: "string" },
      family: { type: "string" },
      help: { type: "boolean", default: false },
      limit: { type: "string" },
      query: { type: "string" },
      refresh: { type: "boolean", default: false },
      "resolve-country": { type: "string" },
      "tax-rules": { type: "string" },
      variant: { type: "string" },
    },
  });

  return {
    command: positionals[0] ?? "interactive",
    values,
  };
}

function requireFamily(familySlug) {
  if (!familySlug) {
    throw new Error("--family is required.");
  }

  if (familySlug !== "all" && !MAC_FAMILIES.some((family) => family.slug === familySlug)) {
    throw new Error(`Unknown family slug: ${familySlug}`);
  }
}

function resolveRequestedStorefronts(storefronts, selectors) {
  const resolved = selectors.map((selector) => resolveStorefront(storefronts, selector));
  const missing = selectors.filter((selector, index) => !resolved[index]);

  if (missing.length) {
    throw new Error(`Unknown countries/locales: ${missing.join(", ")}`);
  }

  return resolved;
}

function filterSupportedStorefronts(storefronts) {
  const supported = new Map(storefronts.map((storefront) => [storefront.countryCode, storefront]));

  return SUPPORTED_COUNTRY_CODES.map((countryCode) => supported.get(countryCode)).filter(Boolean);
}

function resolveFamilySlugs(familySlug = "all") {
  requireFamily(familySlug);
  return familySlug === "all"
    ? MAC_FAMILIES.map((family) => family.slug)
    : [familySlug];
}

function buildCatalogTasks(storefronts, familySlugs) {
  const tasks = [];

  for (const storefront of storefronts) {
    for (const familySlug of familySlugs) {
      tasks.push({ storefront, familySlug });
    }
  }

  return tasks;
}

function buildRefreshJobKey(storefronts, familySlugs) {
  const payload = JSON.stringify({
    countries: storefronts.map((storefront) => storefront.countryCode),
    locales: storefronts.map((storefront) => storefront.localeKey),
    families: [...familySlugs],
  });

  return createHash("sha1").update(payload).digest("hex");
}

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

function formatDurationMs(durationMs) {
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

async function ensureDefaultCatalogSnapshots(values, storefronts) {
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

async function loadSharedContext(values) {
  const [discoveredStorefronts, fx, taxRules] = await Promise.all([
    discoverStorefronts({
      refresh: values.refresh,
      allLocales: values["all-locales"],
    }),
    loadFxRates({ refresh: values.refresh }),
    loadTaxRules(values["tax-rules"] ?? DEFAULT_TAX_RULES_PATH, {
      refresh: values.refresh,
    }),
  ]);

  return { storefronts: filterSupportedStorefronts(discoveredStorefronts), fx, taxRules };
}

async function buildComparison(values) {
  requireFamily(values.family);

  if (!values.variant && !values.query) {
    throw new Error("compare requires either --variant or --query.");
  }

  const { storefronts, fx, taxRules } = await loadSharedContext(values);
  const selectedStorefronts =
    values.countries === "all"
      ? storefronts
      : resolveRequestedStorefronts(
          storefronts,
          parseCsv(values.countries ?? DEFAULT_COMPARE_COUNTRIES),
        );

  const resolveCountry =
    values["resolve-country"] ??
    selectedStorefronts.find((storefront) => storefront.countryCode === "tr")?.countryCode ??
    selectedStorefronts[0]?.countryCode ??
    "tr";
  const baseStorefront = resolveStorefront(storefronts, resolveCountry);

  if (!baseStorefront) {
    throw new Error(`Unknown resolve country: ${resolveCountry}`);
  }

  const baseCatalog = await loadFamilyCatalog(baseStorefront, values.family, {
    refresh: values.refresh,
  });
  const targetVariant = resolveVariantFromCatalog(baseCatalog, {
    variant: values.variant,
    query: values.query,
  });

  const catalogs = await mapLimit(selectedStorefronts, 2, async (storefront) => {
    try {
      return await loadFamilyCatalog(storefront, values.family, {
        refresh: values.refresh,
      });
    } catch {
      return null;
    }
  });

  const baseDisplayedTry = convertToTry(targetVariant.displayedPrice, targetVariant.currency, fx);
  const rows = catalogs
    .map((catalog, index) => {
      const storefront = selectedStorefronts[index];
      const match = catalog?.variants.find(
        (variant) => variant.canonicalKey === targetVariant.canonicalKey,
      );

      if (!match) {
        return {
          country: storefront.countryCode,
          name: storefront.name,
          displayedLocal: "unavailable",
          displayedTry: "",
          deltaTry: "",
          taxLocal: "",
          taxTry: "",
          taxDeltaTry: "",
          taxNote: "",
          displayedTryRaw: Number.POSITIVE_INFINITY,
          taxTryRaw: Number.POSITIVE_INFINITY,
          averageTryRaw: Number.POSITIVE_INFINITY,
          averageTry: "",
          available: false,
        };
      }

      const displayedTry = convertToTry(match.displayedPrice, match.currency, fx);
      const taxRule = taxRules[storefront.countryCode];
      const tax = applyTaxRule(match.displayedPrice, taxRule);
      const taxAdjustedTry =
        tax.taxAdjustedPrice == null
          ? null
          : convertToTry(tax.taxAdjustedPrice, match.currency, fx);
      const averageTryRaw =
        taxAdjustedTry == null ? displayedTry : (displayedTry + taxAdjustedTry) / 2;

      return {
        country: storefront.countryCode,
        name: storefront.name,
        displayedLocal: formatMoney(match.displayedPrice, match.currency, 0),
        displayedTry: formatTry(displayedTry),
        deltaTry: formatDeltaTry(displayedTry - baseDisplayedTry),
        taxLocal:
          tax.taxAdjustedPrice == null
            ? ""
            : formatMoney(tax.taxAdjustedPrice, match.currency, 0),
        taxTry: taxAdjustedTry == null ? "" : formatTry(taxAdjustedTry),
        taxDeltaTry:
          taxAdjustedTry == null ? "" : formatDeltaTry(taxAdjustedTry - baseDisplayedTry),
        averageTry: formatTry(averageTryRaw),
        taxNote: tax.note,
        displayedTryRaw: displayedTry,
        taxTryRaw: taxAdjustedTry ?? Number.POSITIVE_INFINITY,
        averageTryRaw,
        available: true,
      };
    })
    .sort((left, right) => {
      if (left.averageTryRaw !== right.averageTryRaw) {
        return left.averageTryRaw - right.averageTryRaw;
      }

      if (left.displayedTryRaw !== right.displayedTryRaw) {
        return left.displayedTryRaw - right.displayedTryRaw;
      }

      return left.name.localeCompare(right.name);
    });

  return {
    targetVariant,
    baseStorefront,
    rows,
    fxUpdated: fx.time_last_update_utc,
  };
}

function printComparison(result) {
  const rows = result.rows.slice(0, DEFAULT_COMPARE_ROW_LIMIT);

  console.log(result.targetVariant.title);
  console.log(`variant_key: ${result.targetVariant.variantKey}`);
  console.log(`base country: ${result.baseStorefront.name}`);
  console.log(`fx updated: ${result.fxUpdated}`);
  if (result.rows.length > rows.length) {
    console.log(`showing ${rows.length} cheapest country matches by average TRY out of ${result.rows.length}`);
  }
  console.log("");
  console.log(
    renderTable(rows, [
      { key: "country", label: "country" },
      { key: "name", label: "name", maxWidth: 22 },
      { key: "displayedLocal", label: "displayed_local", maxWidth: 16 },
      { key: "displayedTry", label: "displayed_try" },
      { key: "deltaTry", label: "vs_base_try" },
      { key: "taxLocal", label: "tax_free_local", maxWidth: 16 },
      { key: "taxTry", label: "tax_free_try" },
      { key: "taxDeltaTry", label: "taxfree_vs_base" },
      { key: "averageTry", label: "average_try" },
      { key: "taxNote", label: "tax_note", maxWidth: 16 },
    ]),
  );
}

async function commandCountries(values) {
  const storefronts = filterSupportedStorefronts(
    await discoverStorefronts({
      refresh: values.refresh,
      allLocales: values["all-locales"],
    }),
  );

  const rows = storefronts.map((storefront) => ({
    country: storefront.countryCode,
    locale: storefront.localeKey,
    name: storefront.name,
    url: storefront.url,
  }));

  console.log(
    renderTable(rows, [
      { key: "country", label: "country" },
      { key: "locale", label: "locale" },
      { key: "name", label: "name", maxWidth: 28 },
      { key: "url", label: "storefront", maxWidth: 48 },
    ]),
  );
}

async function commandListProducts(values) {
  requireFamily(values.family);

  const storefronts = await discoverStorefronts({
    refresh: values.refresh,
    allLocales: values["all-locales"],
  });
  const storefront = resolveStorefront(storefronts, values.country ?? "tr");

  if (!storefront) {
    throw new Error(`Unknown country/locale: ${values.country ?? "tr"}`);
  }

  const catalog = await loadFamilyCatalog(storefront, values.family, {
    refresh: values.refresh,
  });
  const matches = filterVariants(catalog.variants, values.query);

  if (!matches.length) {
    console.log("No matching variants.");
    return;
  }

  console.log(`${catalog.family.name} in ${catalog.storefront.name}`);
  console.log(`${matches.length} variant(s)\n`);
  console.log(
    renderTable(matches, [
      { key: "variantKey", label: "variant_key", maxWidth: 34 },
      { key: "title", label: "title", maxWidth: 72 },
      { key: "type", label: "type", maxWidth: 16 },
      {
        key: "displayedPrice",
        label: "displayed",
        format: (row) => formatMoney(row.displayedPrice, row.currency, 0),
      },
    ]),
  );
}

function resolveVariantFromCatalog(catalog, { variant, query }) {
  if (variant) {
    const exact =
      catalog.variants.find((candidate) => candidate.priceKey === variant) ??
      catalog.variants.find((candidate) => candidate.variantKey === variant) ??
      catalog.variants.find((candidate) => candidate.priceKeys?.includes(variant)) ??
      catalog.variants.find((candidate) => candidate.canonicalKey === variant);

    if (!exact) {
      throw new Error(`Could not find variant: ${variant}`);
    }

    return exact;
  }

  const matches = filterVariants(catalog.variants, query);
  if (!matches.length) {
    throw new Error("No matching variants were found.");
  }

  if (matches.length > 1) {
    console.log("Query matched multiple variants. Use --variant with one of these variant keys:\n");
    console.log(
      renderTable(matches, [
        { key: "variantKey", label: "variant_key", maxWidth: 34 },
        { key: "title", label: "title", maxWidth: 72 },
        {
          key: "displayedPrice",
          label: "displayed",
          format: (row) => formatMoney(row.displayedPrice, row.currency, 0),
        },
      ]),
    );
    process.exit(2);
  }

  return matches[0];
}

async function commandCompare(values) {
  printComparison(await buildComparison(values));
}

async function commandCheapest(values) {
  const requestedFamily = values.family ?? "all";
  requireFamily(requestedFamily);

  const { storefronts, fx, taxRules } = await loadSharedContext(values);
  const selectedStorefronts =
    values.countries === "all"
      ? storefronts
      : resolveRequestedStorefronts(
          storefronts,
          parseCsv(values.countries ?? DEFAULT_COMPARE_COUNTRIES),
        );

  const familySlugs =
    requestedFamily === "all" ? MAC_FAMILIES.map((family) => family.slug) : [requestedFamily];
  const limit = Number.parseInt(values.limit ?? "20", 10);

  const tasks = [];
  for (const storefront of selectedStorefronts) {
    for (const familySlug of familySlugs) {
      tasks.push({ storefront, familySlug });
    }
  }

  const catalogs = (
    await mapLimit(tasks, 2, async ({ storefront, familySlug }) => {
      try {
        return await loadFamilyCatalog(storefront, familySlug, {
          refresh: values.refresh,
        });
      } catch {
        return null;
      }
    })
  ).filter(Boolean);

  const rows = [];

  for (const catalog of catalogs) {
    for (const variant of filterVariants(catalog.variants, values.query)) {
      const taxRule = taxRules[variant.countryCode];
      const tax = applyTaxRule(variant.displayedPrice, taxRule);
      const displayedTry = convertToTry(variant.displayedPrice, variant.currency, fx);
      const taxAdjustedTry =
        tax.taxAdjustedPrice == null
          ? null
          : convertToTry(tax.taxAdjustedPrice, variant.currency, fx);
      const averageTryRaw =
        taxAdjustedTry == null
          ? displayedTry ?? Number.POSITIVE_INFINITY
          : (displayedTry + taxAdjustedTry) / 2;

      rows.push({
        country: variant.countryCode,
        name: variant.countryName,
        family: variant.familyName,
        title: variant.title,
        displayedLocal: formatMoney(variant.displayedPrice, variant.currency, 0),
        displayedTry: formatTry(displayedTry),
        taxLocal:
          tax.taxAdjustedPrice == null ? "" : formatMoney(tax.taxAdjustedPrice, variant.currency, 0),
        taxTry: taxAdjustedTry == null ? "" : formatTry(taxAdjustedTry),
        averageTryRaw,
        averageTry: formatTry(averageTryRaw),
        taxNote: tax.note,
      });
    }
  }
  rows.sort((left, right) => left.averageTryRaw - right.averageTryRaw);
  const limitedRows = rows.slice(0, limit);

  if (!limitedRows.length) {
    console.log("No matching variants.");
    return;
  }

  console.log(`FX updated: ${fx.time_last_update_utc}\n`);
  console.log(
    renderTable(limitedRows, [
      { key: "country", label: "country" },
      { key: "name", label: "name", maxWidth: 18 },
      { key: "family", label: "family", maxWidth: 14 },
      { key: "title", label: "variant", maxWidth: 72 },
      { key: "displayedLocal", label: "displayed_local", maxWidth: 16 },
      { key: "displayedTry", label: "displayed_try" },
      { key: "taxLocal", label: "tax_free_local", maxWidth: 16 },
      { key: "taxTry", label: "tax_free_try" },
      { key: "averageTry", label: "average_try" },
      { key: "taxNote", label: "tax_note", maxWidth: 16 },
    ]),
  );
}

async function promptForOption(rl, title, options, { showExitHint = true } = {}) {
  console.log(`\n${title}`);
  options.forEach((option, index) => {
    console.log(`  ${index + 1}. ${option.label}`);
  });
  if (showExitHint) {
    console.log("  /exit");
  }

  while (true) {
    const answer = (await rl.question("> ")).trim();
    if (answer === "/exit") {
      return null;
    }

    const choice = Number.parseInt(answer, 10);
    if (Number.isInteger(choice) && choice >= 1 && choice <= options.length) {
      return options[choice - 1].value;
    }

    console.log(`Enter a number between 1 and ${options.length}, or /exit.`);
  }
}

async function promptForVariant(rl, catalog, initialState = {}) {
  const state = initialState ?? {};
  let query = state.query ?? "";
  let page = state.page ?? 0;
  let showAll = state.showAll ?? false;

  while (true) {
    const matches = filterVariants(catalog.variants, query);
    if (!matches.length) {
      console.log("\nNo matches. Type another filter.");
      query = "";
      page = 0;
      showAll = false;
      continue;
    }

    const totalPages = Math.max(1, Math.ceil(matches.length / VARIANT_PAGE_SIZE));
    if (page >= totalPages) {
      page = totalPages - 1;
    }

    const startIndex = showAll ? 0 : page * VARIANT_PAGE_SIZE;
    const pageSize = showAll ? matches.length : VARIANT_PAGE_SIZE;
    const shown = matches.slice(startIndex, startIndex + pageSize).map((variant, index) => ({
      index: String(startIndex + index + 1),
      title: variant.title,
      price: formatMoney(variant.displayedPrice, variant.currency, 0),
    }));
    const rangeStart = shown.length ? startIndex + 1 : 0;
    const rangeEnd = startIndex + shown.length;

    console.log(`\n${catalog.family.name} in ${catalog.storefront.name}`);
    console.log(`Filter: ${query || "all products"}`);
    if (matches.length > VARIANT_PAGE_SIZE) {
      if (showAll) {
        console.log(`Showing all ${matches.length} matches. Type /paged to return to pages.`);
      } else {
        console.log(
          `Showing ${rangeStart}-${rangeEnd} of ${matches.length}. Page ${page + 1}/${totalPages}. Type /next for more, /all to show all, or /prev to go back.`,
        );
      }
    }
    console.log(
      renderTable(shown, [
        { key: "index", label: "#" },
        { key: "title", label: "product", maxWidth: 78 },
        { key: "price", label: "price" },
      ]),
    );

    const answer = (
      await rl.question(
        '\nChoose a product number, type a filter like "m5 max", or use /next, /prev, /all, /clear, /exit: ',
      )
    ).trim();

    if (!answer) {
      continue;
    }

    if (answer === "/exit") {
      return {
        type: "exit",
        state: { query, page, showAll },
      };
    }

    if (answer === "/clear") {
      query = "";
      page = 0;
      showAll = false;
      continue;
    }

    if (answer === "/next") {
      if (showAll) {
        continue;
      }

      page = Math.min(totalPages - 1, page + 1);
      continue;
    }

    if (answer === "/prev") {
      if (showAll) {
        showAll = false;
        page = 0;
        continue;
      }

      if (page > 0) {
        page -= 1;
        continue;
      }

      return {
        type: "back",
        state: { query, page, showAll },
      };
    }

    if (answer === "/all") {
      showAll = true;
      page = 0;
      continue;
    }

    if (answer === "/paged") {
      showAll = false;
      page = 0;
      continue;
    }

    const choice = Number.parseInt(answer, 10);
    if (Number.isInteger(choice) && choice >= 1 && choice <= matches.length) {
      return {
        type: "variant",
        variant: matches[choice - 1],
        state: { query, page, showAll },
      };
    }

    query = answer;
    page = 0;
    showAll = false;
  }
}

async function promptAfterComparison(rl) {
  console.log("\nCommands: /prev to return to the variant list, /home to choose another Mac family, /exit to quit.");

  while (true) {
    const answer = (await rl.question("> ")).trim();

    if (answer === "/prev") {
      return "variants";
    }

    if (answer === "/home") {
      return "families";
    }

    if (answer === "/exit") {
      return "exit";
    }

    console.log("Use /prev, /home, or /exit.");
  }
}

async function commandUpdatePrices(values) {
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
      : resolveRequestedStorefronts(
          storefronts,
          parseCsv(values.countries ?? DEFAULT_COMPARE_COUNTRIES),
        );
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

async function commandInteractive(values) {
  const rl = createInterface({ input, output });

  try {
    console.log("Apple Price Index");
    console.log("Choose a Mac product and get a country comparison.\n");

    const storefronts = await discoverStorefronts({
      refresh: values.refresh,
      allLocales: values["all-locales"],
    });
    const supportedStorefronts = filterSupportedStorefronts(storefronts);
    const turkeyStorefront = resolveStorefront(supportedStorefronts, "tr");

    if (!turkeyStorefront) {
      throw new Error("Could not resolve Turkey storefront.");
    }

    let familySlug = null;
    let variantBrowserState = null;

    while (true) {
      if (!familySlug) {
        variantBrowserState = null;
        familySlug = await promptForOption(
          rl,
          "Choose a Mac family:",
          MAC_FAMILIES.map((family) => ({
            label: family.name,
            value: family.slug,
          })),
          { showExitHint: false },
        );

        if (!familySlug) {
          return;
        }
      }

      const turkeyCatalog = await loadFamilyCatalog(turkeyStorefront, familySlug, {
        refresh: values.refresh,
      });
      const variantSelection = await promptForVariant(rl, turkeyCatalog, variantBrowserState);
      variantBrowserState = variantSelection.state ?? null;

      if (variantSelection.type === "exit") {
        return;
      }

      if (variantSelection.type === "back") {
        familySlug = null;
        variantBrowserState = null;
        continue;
      }

      console.log(
        `\nLoading Apple price comparison for ${DEFAULT_COMPARE_COUNTRY_CODES.length} default countries...\n`,
      );
      const comparison = await buildComparison({
        ...values,
        family: familySlug,
        variant: variantSelection.variant.variantKey,
        countries: DEFAULT_COMPARE_COUNTRIES,
        "resolve-country": "tr",
      });
      printComparison(comparison);

      const nextAction = await promptAfterComparison(rl);
      if (nextAction === "exit") {
        return;
      }

      if (nextAction === "families") {
        familySlug = null;
        variantBrowserState = null;
      }
    }
  } finally {
    rl.close();
  }
}

async function main() {
  const { command, values } = parseOptions();

  if (values.help || command === "help") {
    console.log(usage());
    return;
  }

  switch (command) {
    case "interactive":
      await commandInteractive(values);
      break;
    case "countries":
      await commandCountries(values);
      break;
    case "list-products":
      await commandListProducts(values);
      break;
    case "compare":
      await commandCompare(values);
      break;
    case "cheapest":
      await commandCheapest(values);
      break;
    case "update-prices":
      await commandUpdatePrices(values);
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
