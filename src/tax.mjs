import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fetchText } from "./http.mjs";
import { DEFAULT_BUNDLED_TAX_RULES_SNAPSHOT_PATH } from "./paths.mjs";

const GLOCALZONE_URL = "https://glocalzone.com/vat-refund-calculator";
const TAX_RULES_SNAPSHOT_VERSION = 1;
const GLOCALZONE_COUNTRY_MAP = {
  ch: "switzerland",
  de: "germany",
  es: "spain",
  fr: "france",
  tr: "turkey",
};
const GLOCALZONE_FALLBACK_RULES = {
  ch: {
    name: "Switzerland",
    taxFreeEnabled: true,
    refundType: "glocalzone_tiered",
    source: "Glocalzone fallback",
    currency: "CHF",
    minimumAmount: 300,
    thresholds: { min: 1000, max: 5000 },
    taxRates: { min: 4.5, mid: 5, max: 5.4 },
  },
  de: {
    name: "Germany",
    taxFreeEnabled: true,
    refundType: "glocalzone_tiered",
    source: "Glocalzone fallback",
    currency: "EUR",
    minimumAmount: 25,
    thresholds: { min: 1000, max: 5000 },
    taxRates: { min: 11.4, mid: 13, max: 13.6 },
  },
  es: {
    name: "Spain",
    taxFreeEnabled: true,
    refundType: "glocalzone_tiered",
    source: "Glocalzone fallback",
    currency: "EUR",
    minimumAmount: 0.01,
    thresholds: { min: 1000, max: 5000 },
    taxRates: { min: 12.75, mid: 14.5, max: 15.3 },
  },
  fr: {
    name: "France",
    taxFreeEnabled: true,
    refundType: "glocalzone_tiered",
    source: "Glocalzone fallback",
    currency: "EUR",
    minimumAmount: 100,
    thresholds: { min: 1000, max: 5000 },
    taxRates: { min: 12, mid: 12, max: 12 },
  },
  tr: {
    name: "Turkey",
    taxFreeEnabled: true,
    refundType: "glocalzone_tiered",
    source: "Glocalzone fallback",
    currency: "TRY",
    minimumAmount: 118,
    thresholds: { min: 1000, max: 5000 },
    taxRates: { min: 10.5, mid: 12.5, max: 12.5 },
  },
};

function normalizeLocalRules(rules) {
  return Object.fromEntries(
    Object.entries(rules).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

function extractNextDataJson(html) {
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!match) {
    throw new Error("Could not find __NEXT_DATA__ on Glocalzone.");
  }
  return JSON.parse(match[1]);
}

function normalizeGlocalzoneCountry(country) {
  return {
    name: country.name,
    taxFreeEnabled: true,
    refundType: "glocalzone_tiered",
    source: "Glocalzone",
    currency: country.currency,
    minimumAmount: Number(country.minimumAmount),
    thresholds: { min: 1000, max: 5000 },
    taxRates: {
      min: Number(country.taxRates?.min),
      mid: Number(country.taxRates?.mid),
      max: Number(country.taxRates?.max),
    },
  };
}

async function loadGlocalzoneRules({ refresh = false } = {}) {
  try {
    const html = await fetchText(GLOCALZONE_URL, {
      refresh,
      cacheHours: 24,
      accept: "text/html",
    });
    const data = extractNextDataJson(html);
    const countries = data.props?.pageProps?.countries ?? [];
    const bySlug = new Map(
      countries.map((country) => [String(country.slug).toLowerCase(), country]),
    );

    return Object.fromEntries(
      Object.entries(GLOCALZONE_COUNTRY_MAP)
        .map(([countryCode, slug]) => {
          const country = bySlug.get(slug);
          if (!country) {
            return [countryCode, GLOCALZONE_FALLBACK_RULES[countryCode]];
          }
          return [countryCode, normalizeGlocalzoneCountry(country)];
        })
        .filter(([, rule]) => Boolean(rule)),
    );
  } catch {
    return GLOCALZONE_FALLBACK_RULES;
  }
}

function mergeTaxRules(baseRules, overrideRules) {
  const merged = { ...baseRules };

  for (const [countryCode, overrideRule] of Object.entries(overrideRules)) {
    merged[countryCode] = {
      ...(baseRules[countryCode] ?? {}),
      ...overrideRule,
    };
  }

  return merged;
}

async function readBundledTaxRulesSnapshot() {
  try {
    const file = await readFile(DEFAULT_BUNDLED_TAX_RULES_SNAPSHOT_PATH, "utf8");
    const payload = JSON.parse(file);

    if (payload?.schemaVersion !== TAX_RULES_SNAPSHOT_VERSION) {
      return null;
    }

    return payload.rules ?? null;
  } catch {
    return null;
  }
}

export async function writeBundledTaxRulesSnapshot(rules) {
  await mkdir(dirname(DEFAULT_BUNDLED_TAX_RULES_SNAPSHOT_PATH), { recursive: true });
  await writeFile(
    DEFAULT_BUNDLED_TAX_RULES_SNAPSHOT_PATH,
    JSON.stringify(
      {
        schemaVersion: TAX_RULES_SNAPSHOT_VERSION,
        savedAt: new Date().toISOString(),
        rules,
      },
      null,
      2,
    ),
    "utf8",
  );
}

export async function loadTaxRules(path, { refresh = false } = {}) {
  const baseRulesPromise = refresh
    ? loadGlocalzoneRules({ refresh: true })
    : readBundledTaxRulesSnapshot().then((rules) => rules ?? GLOCALZONE_FALLBACK_RULES);

  try {
    const file = await readFile(path, "utf8");
    const [baseRules] = await Promise.all([baseRulesPromise]);
    return mergeTaxRules(baseRules, normalizeLocalRules(JSON.parse(file)));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return baseRulesPromise;
    }
    throw error;
  }
}

function resolveTieredRefundRate(displayedPrice, rule) {
  const thresholds = rule.thresholds ?? {};
  const rates = rule.taxRates ?? {};

  if (displayedPrice <= thresholds.min) {
    return rates.min;
  }

  if (displayedPrice <= thresholds.max) {
    return rates.mid;
  }

  return rates.max;
}

function formatRatePercent(rate) {
  const percent = rate * 100;
  if (Number.isInteger(percent)) {
    return `${percent}%`;
  }

  return `${percent.toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "")}%`;
}

export function applyDisplayedPriceRule(displayedPrice, rule) {
  if (displayedPrice == null || Number.isNaN(displayedPrice)) {
    return {
      adjustedDisplayedPrice: displayedPrice,
      note: "",
    };
  }

  if (rule?.displayPriceIncludesTax === false && typeof rule.defaultSalesTaxRate === "number") {
    return {
      adjustedDisplayedPrice: Number(
        (displayedPrice * (1 + rule.defaultSalesTaxRate)).toFixed(2),
      ),
      note: rule.defaultSalesTaxLabel
        ? `incl ${rule.defaultSalesTaxLabel}`
        : `incl tax ${formatRatePercent(rule.defaultSalesTaxRate)}`,
    };
  }

  return {
    adjustedDisplayedPrice: displayedPrice,
    note: "",
  };
}

export function applyTaxRule(displayedPrice, rule) {
  if (!rule?.taxFreeEnabled) {
    return {
      refundAmount: rule?.showDisplayedAsTaxFree ? 0 : null,
      finalPriceAfterRefund: rule?.showDisplayedAsTaxFree ? displayedPrice : null,
      note: rule?.showDisplayedAsTaxFree ? (rule?.noRefundLabel ?? "no refund") : "",
    };
  }

  if (rule.refundType === "glocalzone_tiered") {
    const minimumAmount = Number(rule.minimumAmount);
    if (Number.isFinite(minimumAmount) && displayedPrice <= minimumAmount) {
      return {
        refundAmount: null,
        finalPriceAfterRefund: null,
        note: `min ${minimumAmount} ${rule.currency ?? ""}`.trim(),
      };
    }

    const refundRate = resolveTieredRefundRate(displayedPrice, rule);
    if (!Number.isFinite(refundRate)) {
      return {
        refundAmount: null,
        finalPriceAfterRefund: null,
        note: "",
      };
    }

    const refundAmount = Number(((displayedPrice * refundRate) / 100).toFixed(2));
    return {
      refundAmount,
      finalPriceAfterRefund: Number((displayedPrice - refundAmount).toFixed(2)),
      note: `refund ${refundRate}%`,
    };
  }

  if (typeof rule.effectiveRefundRate === "number") {
    const effectiveRefundRate = Number(rule.effectiveRefundRate);
    const refundAmount = Number((displayedPrice * effectiveRefundRate).toFixed(2));
    return {
      refundAmount,
      finalPriceAfterRefund: Number((displayedPrice - refundAmount).toFixed(2)),
      note: `refund ${formatRatePercent(effectiveRefundRate)}`,
    };
  }

  if (rule.displayPriceIncludesTax && typeof rule.vatRate === "number") {
    const vatRate = Number(rule.vatRate);
    const finalPriceAfterRefund = Number((displayedPrice / (1 + vatRate)).toFixed(2));
    return {
      refundAmount: Number((displayedPrice - finalPriceAfterRefund).toFixed(2)),
      finalPriceAfterRefund,
      note: `ex VAT ${formatRatePercent(vatRate)}`,
    };
  }

  return {
    refundAmount: null,
    finalPriceAfterRefund: null,
    note: "",
  };
}
