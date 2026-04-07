import { humanizeIdentifier, normalizeText, stripHtml, uniqueBy } from "./utils.mjs";

export const EXPANDABLE_DIMENSION_KEYS = [
  "memory-dimensionMemory",
  "storage-dimensionCapacity",
  "dimensionScreensize",
  "dimensionCapacity",
];

const EXCLUDED_VARIANT_DIMENSION_KEYS = new Set([
  "chassis-dimensionColor",
  "dimensionSteporder",
  "dimensionColor",
  "keyboard-localizationCode",
  "power_adapter-wattage",
  "carrierModel",
  "watch_cases-dimensionColor",
  "watch_bands-dimensionBandStyle",
  "watch_bands-dimensionColor",
  "watch_bands-dimensionbandsize",
]);

const VARIANT_DIMENSION_PRIORITY = [
  "dimensionActiveNoiseCancellation",
  "dimensionScreensize",
  "dimensionConnection",
  "chassis-dimensionScreensize",
  "chassis-dimensionEnclosureType",
  "display-dimensionFinish",
  "processor-dimensionChip-cpuCoreCount-gpuCoreCount",
  "processor-cpuCoreCount-gpuCoreCount",
  "processor-dimensionChip",
  "watch_cases-dimensionCaseMaterial",
  "watch_cases-dimensionCaseSize",
  "watch_cases-dimensionConnection",
  "memory-dimensionMemory",
  "storage-dimensionCapacity",
  "dimensionCapacity",
  "ethernet_adapter-ethernetBandwidth",
  "ethernet_adapter-ethernetPortCount",
  "chassis_support-dimensionStandType",
  "chassis-dimensionStandType",
  "keyboard-keyboardFormFactor",
];

const INCLUDED_FLAT_DIMENSION_KEYS = new Set(["carrierModel"]);

export function extractBalancedJson(source, marker) {
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

export function extractCurrency(html) {
  const match = html.match(/"priceCurrency":"([A-Z]{3})"/);
  return match?.[1] ?? null;
}

export function extractQuotedValue(source, key) {
  const match = source.match(new RegExp(`${key}:\\s*'([^']+)'`));
  return match?.[1] ?? null;
}

function normalizePriceKey(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\//g, "_");
}

function buildPriceKeyLookup(priceMap) {
  return new Map(
    Object.keys(priceMap ?? {}).map((priceKey) => [normalizePriceKey(priceKey), priceKey]),
  );
}

export function extractProductDimensions(productOrDimensions = {}) {
  if (productOrDimensions?.dimensions && typeof productOrDimensions.dimensions === "object") {
    return productOrDimensions.dimensions;
  }

  return Object.fromEntries(
    Object.entries(productOrDimensions ?? {}).filter(
      ([dimensionKey, dimensionValue]) =>
        Boolean(dimensionValue) &&
        (dimensionKey.startsWith("dimension") || INCLUDED_FLAT_DIMENSION_KEYS.has(dimensionKey)),
    ),
  );
}

function resolveFallbackProductKey(product = {}) {
  return (
    product.priceKey ??
    product.fullPrice ??
    product.basePartNumber ??
    product.partNumber ??
    product.seoUrlToken ??
    "custom"
  );
}

function resolveProductPriceKey(product, priceMap, priceKeyLookup = buildPriceKeyLookup(priceMap)) {
  const candidates = [
    product?.priceKey,
    product?.price,
    product?.fullPrice,
    product?.partNumber,
    product?.basePartNumber,
    product?.seoUrlToken,
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const resolved = priceKeyLookup.get(normalizePriceKey(candidate));
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

function findPriceMap(productSelectionData) {
  const directPriceMap = productSelectionData.mainDisplayValues?.prices;
  if (
    directPriceMap &&
    typeof directPriceMap === "object" &&
    Object.keys(directPriceMap).length
  ) {
    return { key: "mainDisplayValues.prices", map: directPriceMap };
  }

  const displayValuesPriceMap = productSelectionData.displayValues?.prices;
  if (
    displayValuesPriceMap &&
    typeof displayValuesPriceMap === "object" &&
    Object.keys(displayValuesPriceMap).length
  ) {
    return { key: "displayValues.prices", map: displayValuesPriceMap };
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
  const dimensions = extractProductDimensions(productOrDimensions);
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

export function buildVariantKey(product) {
  const dimensions = extractProductDimensions(product);
  const relevantDimensions = listRelevantDimensions(product);
  const hasDetailedProcessor = hasDetailedProcessorDimension(dimensions);
  if (!relevantDimensions.length) {
    return "default";
  }
  const orderedDimensionKeys = [
    "dimensionActiveNoiseCancellation",
    "dimensionScreensize",
    "dimensionConnection",
    "chassis-dimensionScreensize",
    "chassis-dimensionEnclosureType",
    "display-dimensionFinish",
    "processor-dimensionChip-cpuCoreCount-gpuCoreCount",
    "processor-cpuCoreCount-gpuCoreCount",
    ...(hasDetailedProcessor ? [] : ["processor-dimensionChip"]),
    "watch_cases-dimensionCaseMaterial",
    "watch_cases-dimensionCaseSize",
    "watch_cases-dimensionConnection",
    "memory-dimensionMemory",
    "storage-dimensionCapacity",
    "dimensionCapacity",
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

  return pieces.join("-") || resolveFallbackProductKey(product);
}

export function buildDimensionSignature(product) {
  const dimensions = listRelevantDimensions(product);
  if (!dimensions.length) {
    return "default";
  }

  return dimensions
    .map(([dimensionKey, dimensionValue]) => `${dimensionKey}:${dimensionValue}`)
    .join("|");
}

function buildVariantTitle(familyName, product) {
  const dimensions = extractProductDimensions(product);
  const relevantDimensions = listRelevantDimensions(product);
  const hasDetailedProcessor = hasDetailedProcessorDimension(dimensions);
  const dimensionOrder = [
    "dimensionActiveNoiseCancellation",
    "dimensionScreensize",
    "dimensionConnection",
    "chassis-dimensionScreensize",
    "chassis-dimensionEnclosureType",
    "display-dimensionFinish",
    "processor-dimensionChip-cpuCoreCount-gpuCoreCount",
    "processor-cpuCoreCount-gpuCoreCount",
    ...(hasDetailedProcessor ? [] : ["processor-dimensionChip"]),
    "watch_cases-dimensionCaseMaterial",
    "watch_cases-dimensionCaseSize",
    "watch_cases-dimensionConnection",
    "memory-dimensionMemory",
    "storage-dimensionCapacity",
    "dimensionCapacity",
  ];

  const pieces = [familyName];
  if (!relevantDimensions.length) {
    return familyName;
  }
  const consumed = new Set();
  for (const dimensionKey of dimensionOrder) {
    const dimensionValue = dimensions[dimensionKey];
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

  return pieces.join(" | ");
}

export function pickRepresentativeProduct(products) {
  return [...products].sort((left, right) => {
    const leftCarrierScore =
      left.isCarrierDevice === false || normalizeText(left.carrierModel).includes("no carrier")
        ? -1
        : normalizeText(left.carrierModel).includes("unlocked")
          ? 0
          : 1;
    const rightCarrierScore =
      right.isCarrierDevice === false || normalizeText(right.carrierModel).includes("no carrier")
        ? -1
        : normalizeText(right.carrierModel).includes("unlocked")
          ? 0
          : 1;
    if (leftCarrierScore !== rightCarrierScore) {
      return leftCarrierScore - rightCarrierScore;
    }

    if (left.type !== right.type) {
      if (left.type === "PRECONFIGURED_BTR") {
        return -1;
      }
      if (right.type === "PRECONFIGURED_BTR") {
        return 1;
      }
    }

    return String(resolveFallbackProductKey(left)).localeCompare(String(resolveFallbackProductKey(right)));
  })[0];
}

export function buildVariantRecord({
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

export function extractPriceDataFromUpdateResponse(body) {
  return body?.selectedKits?.priceData ?? body?.priceData ?? null;
}

export function extractRawAmount(priceData) {
  const rawAmount = Number(
    priceData?.currentPrice?.raw_amount ?? priceData?.amount ?? priceData?.seoPrice,
  );

  return Number.isNaN(rawAmount) ? null : rawAmount;
}

export function extractDisplayedPriceText(priceData) {
  return priceData?.currentPrice?.amount ?? stripHtml(priceData?.fullPrice ?? "");
}

export function serializeDimensions(dimensions = {}) {
  return Object.keys(dimensions)
    .sort()
    .map((dimensionKey) => `${dimensionKey}:${dimensions[dimensionKey]}`)
    .join("|");
}

export function buildPresetVariants(productSelectionData, storefront, family, currency) {
  const { map: priceMap } = findPriceMap(productSelectionData);
  const priceKeyLookup = buildPriceKeyLookup(priceMap);
  const bySignature = new Map();

  for (const product of productSelectionData.products ?? []) {
    const resolvedPriceKey = resolveProductPriceKey(product, priceMap, priceKeyLookup);
    if (!resolvedPriceKey || !priceMap[resolvedPriceKey]) {
      continue;
    }

    const signature = buildDimensionSignature(product);
    if (!bySignature.has(signature)) {
      bySignature.set(signature, []);
    }
    bySignature.get(signature).push({
      ...product,
      resolvedPriceKey,
    });
  }

  return [...bySignature.entries()]
    .map(([signature, products]) => {
      const product = pickRepresentativeProduct(products);
      const priceEntry = priceMap[product.resolvedPriceKey];
      const rawAmount = extractRawAmount(priceEntry);

      if (rawAmount == null) {
        return null;
      }

      return buildVariantRecord({
        storefront,
        family,
        currency,
        dimensions: extractProductDimensions(product),
        displayedPrice: rawAmount,
        displayedPriceText: extractDisplayedPriceText(priceEntry),
        priceKey: product.resolvedPriceKey,
        priceKeys: products.map((candidate) => candidate.resolvedPriceKey),
        type: product.type,
        signature,
      });
    })
    .filter(Boolean)
    .sort((left, right) => left.displayedPrice - right.displayedPrice);
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
