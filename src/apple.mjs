import { fetchJson, fetchText } from "./http.mjs";
import {
  DEFAULT_CATALOG_CACHE_DAYS,
  readCatalogSnapshot,
  writeCatalogSnapshot,
} from "./catalog-cache.mjs";
import {
  humanizeIdentifier,
  mapLimit,
  normalizeText,
  stripHtml,
  uniqueBy,
} from "./utils.mjs";

export const MAC_FAMILIES = [
  { slug: "macbook-neo", name: "MacBook Neo" },
  { slug: "macbook-air", name: "MacBook Air" },
  { slug: "macbook-pro", name: "MacBook Pro" },
  { slug: "imac", name: "iMac" },
  { slug: "mac-mini", name: "Mac mini" },
  { slug: "mac-studio", name: "Mac Studio" },
];

const COUNTRY_REGION_URL = "https://www.apple.com/choose-country-region/";
const LANGUAGE_SUFFIXES = new Set([
  "arabic",
  "chinese",
  "english",
  "french",
  "german",
  "italian",
  "japanese",
  "korean",
  "portuguese",
  "spanish",
]);
const EXPANDABLE_DIMENSION_KEYS = ["memory-dimensionMemory", "storage-dimensionCapacity"];
const EXCLUDED_VARIANT_DIMENSION_KEYS = new Set([
  "chassis-dimensionColor",
  "keyboard-localizationCode",
  "power_adapter-wattage",
]);
const VARIANT_DIMENSION_PRIORITY = [
  "chassis-dimensionScreensize",
  "chassis-dimensionEnclosureType",
  "display-dimensionFinish",
  "processor-dimensionChip-cpuCoreCount-gpuCoreCount",
  "processor-cpuCoreCount-gpuCoreCount",
  "processor-dimensionChip",
  "memory-dimensionMemory",
  "storage-dimensionCapacity",
  "ethernet_adapter-ethernetBandwidth",
  "ethernet_adapter-ethernetPortCount",
  "chassis_support-dimensionStandType",
  "chassis-dimensionStandType",
  "keyboard-keyboardFormFactor",
];
const MAX_CTO_RESOLUTION_ATTEMPTS = 4;
const UPDATE_CONFIG_CONCURRENCY = 1;
const updateConfigResponseCache = new Map();

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function normalizeStorefrontHref(href) {
  if (href === "/") {
    return "https://www.apple.com/us/";
  }

  if (href.startsWith("http://") || href.startsWith("https://")) {
    return ensureTrailingSlash(href);
  }

  return ensureTrailingSlash(new URL(href, "https://www.apple.com").toString());
}

function deriveLocaleKey(storefrontUrl) {
  const parsed = new URL(storefrontUrl);
  if (parsed.hostname === "www.apple.com.cn") {
    return "cn";
  }

  const path = parsed.pathname.replace(/^\/|\/$/g, "");
  return path || "us";
}

function deriveCountryCode(storefrontUrl) {
  const parsed = new URL(storefrontUrl);
  if (parsed.hostname === "www.apple.com.cn") {
    return "cn";
  }

  const localeKey = deriveLocaleKey(storefrontUrl);
  const firstSegment = localeKey.split("/")[0];

  if (firstSegment.length === 2) {
    return firstSegment;
  }

  if (firstSegment.length === 5 && firstSegment[2] === "-") {
    return firstSegment.slice(0, 2);
  }

  if (firstSegment.length === 4) {
    return firstSegment.slice(0, 2);
  }

  return firstSegment.slice(0, 2);
}

function cleanCountryName(rawName, analyticsTitle) {
  const cleaned = stripHtml(rawName);
  if (cleaned) {
    return cleaned;
  }

  const fallback = analyticsTitle
    .split("-")
    .filter((part) => !LANGUAGE_SUFFIXES.has(part))
    .map((part) => humanizeIdentifier(part))
    .join(" ");

  return fallback || analyticsTitle;
}

function storefrontPreferenceScore(storefront) {
  const locale = storefront.localeKey;

  if (locale === storefront.countryCode) {
    return 100;
  }

  if (locale.endsWith("/en")) {
    return 90;
  }

  if (locale.endsWith("-en")) {
    return 85;
  }

  if (normalizeText(storefront.analyticsTitle).includes("english")) {
    return 80;
  }

  return 50 - locale.length;
}

function dedupeStorefronts(storefronts) {
  const grouped = new Map();

  for (const storefront of storefronts) {
    const current = grouped.get(storefront.countryCode);
    if (!current || storefrontPreferenceScore(storefront) > storefrontPreferenceScore(current)) {
      grouped.set(storefront.countryCode, storefront);
    }
  }

  return [...grouped.values()];
}

export async function discoverStorefronts({ refresh = false, allLocales = false } = {}) {
  const html = await fetchText(COUNTRY_REGION_URL, {
    refresh,
    cacheHours: 24,
    accept: "text/html",
  });

  const anchorPattern =
    /<a\s+property="schema:url"\s+href="([^"]+)"\s+data-analytics-title="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;

  const storefronts = [];
  let match;

  while ((match = anchorPattern.exec(html)) !== null) {
    const [, href, analyticsTitle, body] = match;
    const normalizedUrl = normalizeStorefrontHref(href);

    storefronts.push({
      url: normalizedUrl,
      localeKey: deriveLocaleKey(normalizedUrl),
      countryCode: deriveCountryCode(normalizedUrl),
      analyticsTitle,
      name: cleanCountryName(body, analyticsTitle),
    });
  }

  storefronts.push({
    url: "https://www.apple.com/us/",
    localeKey: "us",
    countryCode: "us",
    analyticsTitle: "united-states-english",
    name: "United States",
  });

  const uniqueStorefronts = uniqueBy(storefronts, (storefront) => storefront.url);
  const normalized = allLocales ? uniqueStorefronts : dedupeStorefronts(uniqueStorefronts);

  return normalized.sort((left, right) => left.name.localeCompare(right.name));
}

function extractBalancedJson(source, marker) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Could not find marker: ${marker}`);
  }

  const start = markerIndex + marker.length;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }

  if (end === -1) {
    throw new Error(`Could not extract JSON for marker: ${marker}`);
  }

  return JSON.parse(source.slice(start, end));
}

function extractCurrency(html) {
  const match = html.match(/"priceCurrency":"([A-Z]{3})"/);
  return match?.[1] ?? null;
}

function extractQuotedValue(source, key) {
  const match = source.match(new RegExp(`${key}:\\s*'([^']+)'`));
  return match?.[1] ?? null;
}

function findPriceMap(productSelectionData) {
  const directPriceMap = productSelectionData.mainDisplayValues?.prices;
  if (directPriceMap && typeof directPriceMap === "object") {
    return { key: "mainDisplayValues.prices", map: directPriceMap };
  }

  for (const [key, value] of Object.entries(productSelectionData)) {
    if (!value || Array.isArray(value) || typeof value !== "object") {
      continue;
    }

    const values = Object.values(value);
    const looksLikePriceMap = values.some(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        "currentPrice" in entry &&
        (entry.currentPrice?.raw_amount != null || entry.amount != null),
    );

    if (looksLikePriceMap) {
      return { key, map: value };
    }
  }

  throw new Error("Could not find a price map in productSelectionData.");
}

function hasDetailedProcessorDimension(dimensions = {}) {
  return (
    Boolean(dimensions["processor-dimensionChip-cpuCoreCount-gpuCoreCount"]) ||
    Boolean(dimensions["processor-cpuCoreCount-gpuCoreCount"])
  );
}

function isVariantDimensionExcluded(dimensionKey) {
  return (
    !dimensionKey ||
    EXCLUDED_VARIANT_DIMENSION_KEYS.has(dimensionKey) ||
    dimensionKey.startsWith("software_")
  );
}

function compareDimensionKeys(leftKey, rightKey) {
  const leftPriority = VARIANT_DIMENSION_PRIORITY.indexOf(leftKey);
  const rightPriority = VARIANT_DIMENSION_PRIORITY.indexOf(rightKey);

  if (leftPriority !== -1 || rightPriority !== -1) {
    if (leftPriority === -1) {
      return 1;
    }
    if (rightPriority === -1) {
      return -1;
    }
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
  }

  return leftKey.localeCompare(rightKey);
}

function listRelevantDimensions(productOrDimensions) {
  const dimensions = productOrDimensions?.dimensions ?? productOrDimensions ?? {};
  const hasDetailedProcessor = hasDetailedProcessorDimension(dimensions);

  return Object.entries(dimensions)
    .filter(([dimensionKey]) => {
      if (isVariantDimensionExcluded(dimensionKey)) {
        return false;
      }

      if (hasDetailedProcessor && dimensionKey === "processor-dimensionChip") {
        return false;
      }

      return true;
    })
    .sort(([leftKey], [rightKey]) => compareDimensionKeys(leftKey, rightKey));
}

function buildVariantKey(product) {
  const dimensions = product.dimensions ?? {};
  const hasDetailedProcessor = hasDetailedProcessorDimension(dimensions);
  const orderedDimensionKeys = [
    "chassis-dimensionScreensize",
    "chassis-dimensionEnclosureType",
    "display-dimensionFinish",
    "processor-dimensionChip-cpuCoreCount-gpuCoreCount",
    "processor-cpuCoreCount-gpuCoreCount",
    ...(hasDetailedProcessor ? [] : ["processor-dimensionChip"]),
    "memory-dimensionMemory",
    "storage-dimensionCapacity",
  ];
  const consumed = new Set();
  const pieces = [];

  for (const dimensionKey of orderedDimensionKeys) {
    const dimensionValue = dimensions[dimensionKey];
    if (!dimensionValue || pieces.includes(dimensionValue)) {
      continue;
    }

    consumed.add(dimensionKey);
    pieces.push(dimensionValue);
  }

  for (const [dimensionKey, dimensionValue] of listRelevantDimensions(product)) {
    if (consumed.has(dimensionKey) || pieces.includes(dimensionValue)) {
      continue;
    }

    pieces.push(dimensionValue);
  }

  return pieces.join("-") || product.priceKey;
}

function buildDimensionSignature(product) {
  const dimensions = listRelevantDimensions(product);
  if (!dimensions.length) {
    return buildVariantKey(product);
  }

  return dimensions
    .map(([dimensionKey, dimensionValue]) => `${dimensionKey}:${dimensionValue}`)
    .join("|");
}

function buildVariantTitle(familyName, product) {
  const hasDetailedProcessor = hasDetailedProcessorDimension(product.dimensions ?? {});
  const dimensionOrder = [
    "chassis-dimensionScreensize",
    "chassis-dimensionEnclosureType",
    "display-dimensionFinish",
    "processor-dimensionChip-cpuCoreCount-gpuCoreCount",
    "processor-cpuCoreCount-gpuCoreCount",
    ...(hasDetailedProcessor ? [] : ["processor-dimensionChip"]),
    "memory-dimensionMemory",
    "storage-dimensionCapacity",
  ];

  const pieces = [familyName];
  const consumed = new Set();
  for (const dimensionKey of dimensionOrder) {
    const dimensionValue = product.dimensions?.[dimensionKey];
    if (!dimensionValue) {
      continue;
    }

    consumed.add(dimensionKey);
    const label = humanizeIdentifier(dimensionValue);
    if (label && !pieces.includes(label)) {
      pieces.push(label);
    }
  }

  for (const [dimensionKey, dimensionValue] of listRelevantDimensions(product)) {
    if (consumed.has(dimensionKey)) {
      continue;
    }

    const label = humanizeIdentifier(dimensionValue);
    if (label && !pieces.includes(label)) {
      pieces.push(label);
    }
  }

  if (pieces.length === 1) {
    pieces.push(humanizeIdentifier(product.priceKey));
  }

  return pieces.join(" | ");
}

function buildFamilyUrl(storefront, familySlug) {
  if (storefront.countryCode === "ch" && /^[a-z]{4}$/i.test(storefront.localeKey)) {
    const localePath = `${storefront.localeKey.slice(0, 2)}-${storefront.localeKey.slice(2)}`;
    return `https://www.apple.com/${localePath}/shop/buy-mac/${familySlug}`;
  }

  return new URL(`shop/buy-mac/${familySlug}`, storefront.url).toString();
}

function pickRepresentativeProduct(products) {
  return [...products].sort((left, right) => {
    if (left.type !== right.type) {
      if (left.type === "PRECONFIGURED_BTR") {
        return -1;
      }
      if (right.type === "PRECONFIGURED_BTR") {
        return 1;
      }
    }

    return String(left.priceKey).localeCompare(String(right.priceKey));
  })[0];
}

function buildVariantRecord({
  storefront,
  family,
  currency,
  dimensions,
  displayedPrice,
  displayedPriceText,
  priceKey,
  priceKeys = [],
  type,
}) {
  const normalizedProduct = {
    dimensions,
    priceKey: priceKey ?? "custom",
  };
  const variantKey = buildVariantKey(normalizedProduct);
  const signature = buildDimensionSignature(normalizedProduct);

  return {
    canonicalKey: `${family.slug}::${variantKey}`,
    familySlug: family.slug,
    familyName: family.name,
    variantKey,
    priceKey: priceKey ?? variantKey,
    priceKeys: uniqueBy(
      [priceKey ?? variantKey, ...priceKeys].filter(Boolean).sort(),
      (candidate) => candidate,
    ),
    signature,
    title: buildVariantTitle(family.name, normalizedProduct),
    type,
    displayedPrice,
    displayedPriceText,
    currency,
    storefrontUrl: storefront.url,
    countryCode: storefront.countryCode,
    countryName: storefront.name,
  };
}

function extractSelectedDimensionValues(selectedKitDimensions, fallbackDimensions = {}) {
  const selectedDimensions = { ...fallbackDimensions };

  for (const [dimensionKey, entry] of Object.entries(selectedKitDimensions ?? {})) {
    const dimensionValue =
      typeof entry === "string"
        ? entry
        : entry?.dimensionValue ?? entry?.value ?? entry?.selectedValue ?? entry?.currentValue;

    if (dimensionValue) {
      selectedDimensions[dimensionKey] = dimensionValue;
    }
  }

  return selectedDimensions;
}

function extractPriceDataFromUpdateResponse(body) {
  return body?.selectedKits?.priceData ?? body?.priceData ?? null;
}

function extractRawAmount(priceData) {
  const rawAmount = Number(
    priceData?.currentPrice?.raw_amount ?? priceData?.amount ?? priceData?.seoPrice,
  );

  return Number.isNaN(rawAmount) ? null : rawAmount;
}

function extractDisplayedPriceText(priceData) {
  return priceData?.currentPrice?.amount ?? stripHtml(priceData?.fullPrice ?? "");
}

function serializeDimensions(dimensions = {}) {
  return Object.keys(dimensions)
    .sort()
    .map((dimensionKey) => `${dimensionKey}:${dimensions[dimensionKey]}`)
    .join("|");
}

function buildUpdateConfigRequestUrl(updateConfigUrl, selectedDimensions, selection, sections) {
  const url = new URL(updateConfigUrl);

  for (const dimensionKey of Object.keys(selectedDimensions).sort()) {
    const dimensionValue = selectedDimensions[dimensionKey];
    if (!dimensionValue) {
      continue;
    }
    url.searchParams.append(`sv.${dimensionKey}`, dimensionValue);
  }

  for (const dimensionKey of Object.keys(selection).sort()) {
    const dimensionValue = selection[dimensionKey];
    if (!dimensionValue) {
      continue;
    }

    const prefix = Object.prototype.hasOwnProperty.call(selectedDimensions, dimensionKey)
      ? "uv"
      : "sv";
    url.searchParams.append(`${prefix}.${dimensionKey}`, dimensionValue);
  }

  if (sections.length) {
    url.searchParams.set("sections", uniqueBy(sections, (section) => section).join(","));
  }

  return url.toString();
}

async function fetchUpdateConfig(
  updateConfigUrl,
  { selectedDimensions = {}, selection = {}, sections = [], refresh = false } = {},
) {
  const requestUrl = buildUpdateConfigRequestUrl(
    updateConfigUrl,
    selectedDimensions,
    selection,
    sections,
  );

  const cacheKey = `${refresh ? "refresh" : "cached"}::${requestUrl}`;
  let responsePromise = updateConfigResponseCache.get(cacheKey);

  if (!responsePromise) {
    responsePromise = fetchJson(requestUrl, {
      refresh,
      cacheHours: 12,
    });
    updateConfigResponseCache.set(cacheKey, responsePromise);
  }

  let response;
  try {
    response = await responsePromise;
  } catch (error) {
    updateConfigResponseCache.delete(cacheKey);
    throw error;
  }

  return response?.body ?? response;
}

function listOptionValues(state, dimensionKey) {
  const optionGroup = state?.body?.options?.[dimensionKey];
  const currentValue = state?.selectedDimensions?.[dimensionKey];

  if (!optionGroup || typeof optionGroup !== "object") {
    return currentValue ? [currentValue] : [];
  }

  const compatibleValues = Object.keys(optionGroup.compatibleOptions ?? {});
  const upgradeValues = Array.isArray(optionGroup.upgradeOptions)
    ? optionGroup.upgradeOptions
    : Object.keys(optionGroup.upgradeOptions ?? {});
  const variantOrder = Array.isArray(optionGroup.variantOrder)
    ? optionGroup.variantOrder
    : [...compatibleValues, ...upgradeValues, ...Object.keys(optionGroup)];
  const values = variantOrder.filter((valueKey) => {
    if (
      valueKey === "variantOrder" ||
      valueKey === "compatibleOptions" ||
      valueKey === "upgradeOptions" ||
      valueKey === "dynamicFooter" ||
      valueKey === "hasChanged"
    ) {
      return false;
    }

    const option = optionGroup[valueKey];
    if (compatibleValues.includes(valueKey) || upgradeValues.includes(valueKey)) {
      if (!option || typeof option !== "object") {
        return true;
      }
    } else if (!option || typeof option !== "object") {
      return false;
    }

    if (
      option.disabled === true ||
      option.isDisabled === true ||
      option.available === false ||
      option.isAvailable === false
    ) {
      return false;
    }

    return true;
  });

  if (currentValue && !values.includes(currentValue)) {
    values.unshift(currentValue);
  }

  return uniqueBy(values, (value) => value);
}

async function resolveInitialCtoState(updateConfigUrl, baseDimensions, sections, refresh) {
  const body = await fetchUpdateConfig(updateConfigUrl, {
    selectedDimensions: baseDimensions,
    sections,
    refresh,
  });

  return {
    body,
    selectedDimensions: extractSelectedDimensionValues(body?.selectedKits?.dimensions, baseDimensions),
  };
}

async function resolveSingleSelection(
  updateConfigUrl,
  state,
  dimensionKey,
  dimensionValue,
  sections,
  refresh,
) {
  let currentDimensions = { ...(state?.selectedDimensions ?? {}) };
  let currentBody = state?.body ?? null;

  for (let attempt = 0; attempt < MAX_CTO_RESOLUTION_ATTEMPTS; attempt += 1) {
    if (currentDimensions[dimensionKey] === dimensionValue && currentBody) {
      return {
        body: currentBody,
        selectedDimensions: currentDimensions,
      };
    }

    const body = await fetchUpdateConfig(updateConfigUrl, {
      selectedDimensions: currentDimensions,
      selection: { [dimensionKey]: dimensionValue },
      sections,
      refresh,
    });
    const nextDimensions = extractSelectedDimensionValues(
      body?.selectedKits?.dimensions,
      currentDimensions,
    );

    currentBody = body;

    if (nextDimensions[dimensionKey] === dimensionValue) {
      return {
        body,
        selectedDimensions: nextDimensions,
      };
    }

    if (serializeDimensions(nextDimensions) === serializeDimensions(currentDimensions)) {
      return {
        body,
        selectedDimensions: nextDimensions,
      };
    }

    currentDimensions = nextDimensions;
  }

  return {
    body: currentBody,
    selectedDimensions: currentDimensions,
  };
}

function dedupeStates(states) {
  const deduped = new Map();

  for (const state of states) {
    if (!state?.selectedDimensions) {
      continue;
    }

    const signature = buildDimensionSignature({
      dimensions: state.selectedDimensions,
      priceKey: "custom",
    });
    if (!deduped.has(signature)) {
      deduped.set(signature, state);
    }
  }

  return [...deduped.values()];
}

function buildPresetVariants(productSelectionData, storefront, family, currency) {
  const { map: priceMap } = findPriceMap(productSelectionData);
  const bySignature = new Map();

  for (const product of productSelectionData.products ?? []) {
    if (!product.priceKey || !priceMap[product.priceKey]) {
      continue;
    }

    const signature = buildDimensionSignature(product);
    if (!bySignature.has(signature)) {
      bySignature.set(signature, []);
    }
    bySignature.get(signature).push(product);
  }

  return [...bySignature.entries()]
    .map(([signature, products]) => {
      const product = pickRepresentativeProduct(products);
      const priceEntry = priceMap[product.priceKey];
      const rawAmount = extractRawAmount(priceEntry);

      if (rawAmount == null) {
        return null;
      }

      return buildVariantRecord({
        storefront,
        family,
        currency,
        dimensions: product.dimensions ?? {},
        displayedPrice: rawAmount,
        displayedPriceText: extractDisplayedPriceText(priceEntry),
        priceKey: product.priceKey,
        priceKeys: products.map((candidate) => candidate.priceKey),
        type: product.type,
        signature,
      });
    })
    .filter(Boolean)
    .sort((left, right) => left.displayedPrice - right.displayedPrice);
}

async function expandRepresentativeProduct(
  representative,
  products,
  productSelectionData,
  storefront,
  family,
  currency,
  updateConfigUrl,
  refresh,
) {
  const sectionKeys = EXPANDABLE_DIMENSION_KEYS.filter(
    (dimensionKey) => productSelectionData.configDisplayValues?.[dimensionKey],
  );

  if (!updateConfigUrl || !sectionKeys.length) {
    return buildPresetVariants(
      { ...productSelectionData, products },
      storefront,
      family,
      currency,
    );
  }

  let initialState;
  try {
    initialState = await resolveInitialCtoState(
      updateConfigUrl,
      representative.dimensions ?? {},
      sectionKeys,
      refresh,
    );
  } catch {
    return buildPresetVariants(
      { ...productSelectionData, products },
      storefront,
      family,
      currency,
    );
  }

  const initialPriceData = extractPriceDataFromUpdateResponse(initialState.body);
  if (extractRawAmount(initialPriceData) == null) {
    return buildPresetVariants(
      { ...productSelectionData, products },
      storefront,
      family,
      currency,
    );
  }

  let states = [initialState];

  for (const dimensionKey of sectionKeys) {
    const nextStates = [];

    for (const state of states) {
      const optionValues = listOptionValues(state, dimensionKey);
      if (!optionValues.length) {
        nextStates.push(state);
        continue;
      }

      for (const dimensionValue of optionValues) {
        if (!dimensionValue) {
          continue;
        }

        if (state.selectedDimensions?.[dimensionKey] === dimensionValue) {
          nextStates.push(state);
          continue;
        }

        try {
          const resolvedState = await resolveSingleSelection(
            updateConfigUrl,
            state,
            dimensionKey,
            dimensionValue,
            sectionKeys,
            refresh,
          );

          if (resolvedState.selectedDimensions?.[dimensionKey] !== dimensionValue) {
            continue;
          }

          nextStates.push(resolvedState);
        } catch {
          continue;
        }
      }
    }

    states = dedupeStates(nextStates);
  }

  const variants = dedupeStates(states)
    .map((state) => {
      const priceData = extractPriceDataFromUpdateResponse(state.body);
      const displayedPrice = extractRawAmount(priceData);

      if (displayedPrice == null) {
        return null;
      }

      const selectedDimensions = state.selectedDimensions ?? representative.dimensions ?? {};
      const selectedVariantKey = buildVariantKey({
        dimensions: selectedDimensions,
        priceKey: representative.priceKey,
      });
      const isCustomVariant =
        serializeDimensions(selectedDimensions) !== serializeDimensions(representative.dimensions ?? {});

      return buildVariantRecord({
        storefront,
        family,
        currency,
        dimensions: selectedDimensions,
        displayedPrice,
        displayedPriceText: extractDisplayedPriceText(priceData),
        priceKey: selectedVariantKey,
        priceKeys: products.map((candidate) => candidate.priceKey),
        type: isCustomVariant ? "CONFIGURABLE" : representative.type,
      });
    })
    .filter(Boolean);

  return variants.length
    ? variants
    : buildPresetVariants({ ...productSelectionData, products }, storefront, family, currency);
}

async function buildVariants(
  productSelectionData,
  storefront,
  family,
  currency,
  updateConfigUrl,
  refresh,
) {
  const bySignature = new Map();

  for (const product of productSelectionData.products ?? []) {
    const signature = buildDimensionSignature(product);
    if (!bySignature.has(signature)) {
      bySignature.set(signature, []);
    }
    bySignature.get(signature).push(product);
  }

  const expandedGroups = await mapLimit(
    [...bySignature.values()],
    UPDATE_CONFIG_CONCURRENCY,
    async (products) =>
      expandRepresentativeProduct(
        pickRepresentativeProduct(products),
        products,
        productSelectionData,
        storefront,
        family,
        currency,
        updateConfigUrl,
        refresh,
      ),
  );

  const dedupedVariants = new Map();

  for (const variants of expandedGroups) {
    for (const variant of variants) {
      const existing = dedupedVariants.get(variant.canonicalKey);

      if (!existing) {
        dedupedVariants.set(variant.canonicalKey, variant);
        continue;
      }

      existing.priceKeys = uniqueBy(
        [...existing.priceKeys, ...(variant.priceKeys ?? [])].sort(),
        (candidate) => candidate,
      );

      if (variant.displayedPrice < existing.displayedPrice) {
        dedupedVariants.set(variant.canonicalKey, {
          ...existing,
          ...variant,
          priceKeys: existing.priceKeys,
        });
      }
    }
  }

  return [...dedupedVariants.values()].sort(
    (left, right) => left.displayedPrice - right.displayedPrice,
  );
}

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

export function filterVariants(variants, query) {
  if (!query) {
    return variants;
  }

  const normalizedTokens = normalizeText(query)
    .split(/\s+/)
    .filter(Boolean);

  return variants.filter((variant) => {
    const haystack = normalizeText(
      [
        variant.familyName,
        variant.title,
        variant.variantKey,
        variant.priceKey,
        variant.priceKeys?.join(" "),
        variant.countryName,
      ].join(" "),
    );
    return normalizedTokens.every((token) => haystack.includes(token));
  });
}

export function resolveStorefront(storefronts, selector) {
  const normalizedSelector = normalizeText(selector);

  return storefronts.find((storefront) => {
    const candidates = [
      storefront.countryCode,
      storefront.localeKey,
      storefront.name,
      storefront.analyticsTitle,
    ];

    return candidates.some((candidate) => normalizeText(candidate) === normalizedSelector);
  });
}
