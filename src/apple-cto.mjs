import { fetchJson } from "./http.mjs";
import { mapLimit, uniqueBy } from "./utils.mjs";
import {
  buildDimensionSignature,
  buildPresetVariants,
  buildVariantKey,
  buildVariantRecord,
  EXPANDABLE_DIMENSION_KEYS,
  extractDisplayedPriceText,
  extractProductDimensions,
  extractPriceDataFromUpdateResponse,
  extractRawAmount,
  pickRepresentativeProduct,
  serializeDimensions,
} from "./apple-variant-helpers.mjs";

const MAX_CTO_RESOLUTION_ATTEMPTS = 4;
const UPDATE_CONFIG_CONCURRENCY = 1;
const updateConfigResponseCache = new Map();

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

  const representativeDimensions = extractProductDimensions(representative);
  let initialState;
  try {
    initialState = await resolveInitialCtoState(
      updateConfigUrl,
      representativeDimensions,
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

      const selectedDimensions = state.selectedDimensions ?? representativeDimensions;
      const selectedVariantKey = buildVariantKey({
        dimensions: selectedDimensions,
        priceKey: representative.priceKey ?? representative.fullPrice ?? representative.basePartNumber,
      });
      const isCustomVariant =
        serializeDimensions(selectedDimensions) !== serializeDimensions(representativeDimensions);

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

export async function buildVariants(
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
