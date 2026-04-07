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
  PRODUCT_CATEGORIES,
  PRODUCT_FAMILIES,
  resolveStorefront,
} from "./apple-storefronts.mjs";

const FALLBACK_CURRENCY_BY_COUNTRY = {
  ae: "AED",
  at: "EUR",
  au: "AUD",
  be: "EUR",
  br: "BRL",
  ca: "CAD",
  ch: "CHF",
  cl: "CLP",
  cn: "CNY",
  cz: "CZK",
  de: "EUR",
  dk: "DKK",
  es: "EUR",
  fi: "EUR",
  fr: "EUR",
  hk: "HKD",
  hu: "HUF",
  ie: "EUR",
  in: "INR",
  it: "EUR",
  jp: "JPY",
  kr: "KRW",
  lu: "EUR",
  mx: "MXN",
  my: "MYR",
  nl: "EUR",
  no: "NOK",
  nz: "NZD",
  ph: "PHP",
  pl: "PLN",
  pt: "EUR",
  se: "SEK",
  sg: "SGD",
  th: "THB",
  tr: "TRY",
  tw: "TWD",
  uk: "GBP",
  us: "USD",
  vn: "VND",
};

function resolveCatalogCurrency(storefront, currency) {
  if (/^[A-Z]{3}$/.test(currency ?? "")) {
    return currency;
  }

  return FALLBACK_CURRENCY_BY_COUNTRY[storefront.countryCode] ?? null;
}

function applyCurrencyFallbackToVariants(variants, currency) {
  if (!currency) {
    return variants;
  }

  return variants.map((variant) =>
    variant.currency
      ? variant
      : {
          ...variant,
          currency,
        },
  );
}

export async function loadFamilyCatalog(
  storefront,
  familySlug,
  { refresh = false, snapshotDays = DEFAULT_CATALOG_CACHE_DAYS } = {},
) {
  const family = PRODUCT_FAMILIES.find((candidate) => candidate.slug === familySlug);
  if (!family) {
    throw new Error(`Unknown product family: ${familySlug}`);
  }

  const familyUrl = buildFamilyUrl(storefront, familySlug);
  if (!refresh) {
    const cachedCatalog = await readCatalogSnapshot(storefront, familySlug, {
      maxAgeDays: snapshotDays,
    });

    if (cachedCatalog && (cachedCatalog.unsupported || cachedCatalog.variants.length > 0)) {
      const resolvedCurrency = resolveCatalogCurrency(storefront, cachedCatalog.currency);
      return {
        storefront,
        family,
        familyUrl: cachedCatalog.familyUrl ?? familyUrl,
        currency: resolvedCurrency,
        variants: applyCurrencyFallbackToVariants(cachedCatalog.variants, resolvedCurrency),
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
  const currency = resolveCatalogCurrency(storefront, extractCurrency(html));
  const updateConfigUrl = extractQuotedValue(html, "updateConfigUrl");
  const variants = applyCurrencyFallbackToVariants(
    await buildVariants(
      productSelectionData,
      storefront,
      family,
      currency,
      updateConfigUrl ? new URL(updateConfigUrl, familyUrl).toString() : null,
      refresh,
    ),
    currency,
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

export { discoverStorefronts, filterVariants, PRODUCT_CATEGORIES, PRODUCT_FAMILIES, resolveStorefront };
