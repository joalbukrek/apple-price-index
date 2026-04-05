import {
  discoverStorefronts,
  filterVariants,
  loadFamilyCatalog,
  MAC_FAMILIES,
  resolveStorefront,
} from "./apple.mjs";
import { convertToTry } from "./fx.mjs";
import { applyTaxRule } from "./tax.mjs";
import { formatDeltaTry, formatMoney, formatTry, mapLimit, renderTable } from "./utils.mjs";
import {
  DEFAULT_COMPARE_COUNTRIES,
  DEFAULT_COMPARE_ROW_LIMIT,
  filterSupportedStorefronts,
  loadSharedContext,
  requireFamily,
  resolveCountrySelectors,
  resolveRequestedStorefronts,
} from "./cli-common.mjs";

export async function buildComparison(values) {
  requireFamily(values.family);

  if (!values.variant && !values.query) {
    throw new Error("compare requires either --variant or --query.");
  }

  const { storefronts, fx, taxRules } = await loadSharedContext(values);
  const selectedStorefronts =
    values.countries === "all"
      ? storefronts
      : resolveRequestedStorefronts(storefronts, resolveCountrySelectors(values.countries));

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

export function printComparison(result) {
  const rows = result.rows.slice(0, DEFAULT_COMPARE_ROW_LIMIT);

  console.log(result.targetVariant.title);
  console.log(`variant_key: ${result.targetVariant.variantKey}`);
  console.log(`base country: ${result.baseStorefront.name}`);
  console.log(`fx updated: ${result.fxUpdated}`);
  if (result.rows.length > rows.length) {
    console.log(
      `showing ${rows.length} cheapest country matches by average TRY out of ${result.rows.length}`,
    );
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

export async function commandCountries(values) {
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

export async function commandListProducts(values) {
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

export function resolveVariantFromCatalog(catalog, { variant, query }) {
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

export async function commandCompare(values) {
  printComparison(await buildComparison(values));
}

export async function commandCheapest(values) {
  const requestedFamily = values.family ?? "all";
  requireFamily(requestedFamily);

  const { storefronts, fx, taxRules } = await loadSharedContext(values);
  const selectedStorefronts =
    values.countries === "all"
      ? storefronts
      : resolveRequestedStorefronts(storefronts, resolveCountrySelectors(values.countries));

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
