import { fetchText } from "./http.mjs";
import {
  DEFAULT_CATALOG_CACHE_DAYS,
  readCatalogSnapshot,
  writeCatalogSnapshot,
} from "./catalog-cache.mjs";
import { normalizeText } from "./utils.mjs";
import {
  extractBalancedJson,
  extractCurrency,
  extractQuotedValue,
  filterVariants,
} from "./apple-variant-helpers.mjs";
import { buildVariants } from "./apple-cto.mjs";
import {
  buildFamilyUrl,
  discoverStorefronts,
  MAC_FAMILIES,
  resolveStorefront,
} from "./apple-storefronts.mjs";

export async function loadFamilyCatalog(
  storefront,
  familySlug,
  { refresh = false, snapshotDays = DEFAULT_CATALOG_CACHE_DAYS } = {},
) {
  const family = MAC_FAMILIES.find((candidate) => candidate.slug === familySlug);
  if (!family) {
    throw new Error(`Unknown Mac family: ${familySlug}`);
  }

  const familyUrl = buildFamilyUrl(storefront, familySlug);
  if (!refresh) {
    const cachedCatalog = await readCatalogSnapshot(storefront, familySlug, {
      maxAgeDays: snapshotDays,
    });

    if (cachedCatalog) {
      return {
        storefront,
        family,
        familyUrl: cachedCatalog.familyUrl ?? familyUrl,
        currency: cachedCatalog.currency,
        variants: cachedCatalog.variants,
        cachedAt: cachedCatalog.savedAt,
      };
    }
  }

  const html = await fetchText(familyUrl, {
    refresh,
    cacheHours: 12,
    accept: "text/html",
  });

  if (!html.includes("PRODUCT_SELECTION_BOOTSTRAP")) {
    throw new Error(`Apple did not expose product selection data for ${familyUrl}`);
  }

  const productSelectionData = extractBalancedJson(html, "productSelectionData: ");
  const currency = extractCurrency(html);
  const updateConfigUrl = extractQuotedValue(html, "updateConfigUrl");
  const variants = await buildVariants(
    productSelectionData,
    storefront,
    family,
    currency,
    updateConfigUrl ? new URL(updateConfigUrl, familyUrl).toString() : null,
    refresh,
  );

  await writeCatalogSnapshot(storefront, familySlug, {
    familyUrl,
    currency,
    variants,
  });

  return {
    storefront,
    family,
    familyUrl,
    currency,
    variants,
    cachedAt: new Date().toISOString(),
  };
}

export { discoverStorefronts, filterVariants, MAC_FAMILIES, resolveStorefront };
