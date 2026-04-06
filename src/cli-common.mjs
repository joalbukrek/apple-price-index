import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { discoverStorefronts, MAC_FAMILIES, resolveStorefront } from "./apple.mjs";
import { loadFxRates } from "./fx.mjs";
import { DEFAULT_TAX_RULES_PATH } from "./paths.mjs";
import { loadTaxRules } from "./tax.mjs";
import { parseCsv } from "./utils.mjs";

export const SUPPORTED_COUNTRY_CODES = [
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
  "us",
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

export const DEFAULT_COMPARE_COUNTRY_CODES = SUPPORTED_COUNTRY_CODES;
export const DEFAULT_COMPARE_COUNTRIES = DEFAULT_COMPARE_COUNTRY_CODES.join(",");
export const DEFAULT_WARMUP_FAMILY_SLUGS = MAC_FAMILIES.map((family) => family.slug);
export const DEFAULT_COMPARE_ROW_LIMIT = 20;
export const SNAPSHOT_WARMUP_CONCURRENCY = 1;
export const VARIANT_PAGE_SIZE = 20;

export function usage() {
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
  node cli.mjs update-prices [--family <slug|all>] [--countries <csv>|all] [--bundle]
  node cli.mjs bundle-data [--family <slug|all>] [--countries <csv>|all]

Known family slugs:
  ${MAC_FAMILIES.map((family) => family.slug).join(", ")}`;
}

export function parseOptions() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "all-locales": { type: "boolean", default: false },
      bundle: { type: "boolean", default: false },
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

export function requireFamily(familySlug) {
  if (!familySlug) {
    throw new Error("--family is required.");
  }

  if (familySlug !== "all" && !MAC_FAMILIES.some((family) => family.slug === familySlug)) {
    throw new Error(`Unknown family slug: ${familySlug}`);
  }
}

export function resolveRequestedStorefronts(storefronts, selectors) {
  const resolved = selectors.map((selector) => resolveStorefront(storefronts, selector));
  const missing = selectors.filter((selector, index) => !resolved[index]);

  if (missing.length) {
    throw new Error(`Unknown countries/locales: ${missing.join(", ")}`);
  }

  return resolved;
}

export function filterSupportedStorefronts(storefronts) {
  const supported = new Map(storefronts.map((storefront) => [storefront.countryCode, storefront]));

  return SUPPORTED_COUNTRY_CODES.map((countryCode) => supported.get(countryCode)).filter(Boolean);
}

export function resolveFamilySlugs(familySlug = "all") {
  requireFamily(familySlug);
  return familySlug === "all"
    ? MAC_FAMILIES.map((family) => family.slug)
    : [familySlug];
}

export function buildCatalogTasks(storefronts, familySlugs) {
  const tasks = [];

  for (const storefront of storefronts) {
    for (const familySlug of familySlugs) {
      tasks.push({ storefront, familySlug });
    }
  }

  return tasks;
}

export function buildRefreshJobKey(storefronts, familySlugs) {
  const payload = JSON.stringify({
    countries: storefronts.map((storefront) => storefront.countryCode),
    locales: storefronts.map((storefront) => storefront.localeKey),
    families: [...familySlugs],
  });

  return createHash("sha1").update(payload).digest("hex");
}

export async function loadSharedContext(values) {
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

export function resolveCountrySelectors(value) {
  return parseCsv(value ?? DEFAULT_COMPARE_COUNTRIES);
}
