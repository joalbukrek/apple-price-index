import { readFile } from "node:fs/promises";
import { fetchText } from "./http.mjs";

const GLOCALZONE_URL = "https://glocalzone.com/vat-refund-calculator";
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

export async function loadTaxRules(path, { refresh = false } = {}) {
  const glocalzoneRulesPromise = loadGlocalzoneRules({ refresh });

  try {
    const file = await readFile(path, "utf8");
    const [glocalzoneRules] = await Promise.all([glocalzoneRulesPromise]);
    return mergeTaxRules(glocalzoneRules, normalizeLocalRules(JSON.parse(file)));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return glocalzoneRulesPromise;
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

export function applyTaxRule(displayedPrice, rule) {
  if (!rule?.taxFreeEnabled) {
    return {
      taxAdjustedPrice: rule?.showDisplayedAsTaxFree ? displayedPrice : null,
      note: rule?.showDisplayedAsTaxFree ? "no refund" : "",
    };
  }

  if (rule.refundType === "glocalzone_tiered") {
    const minimumAmount = Number(rule.minimumAmount);
    if (Number.isFinite(minimumAmount) && displayedPrice <= minimumAmount) {
      return {
        taxAdjustedPrice: null,
        note: `min ${minimumAmount} ${rule.currency ?? ""}`.trim(),
      };
    }

    const refundRate = resolveTieredRefundRate(displayedPrice, rule);
    if (!Number.isFinite(refundRate)) {
      return {
        taxAdjustedPrice: null,
        note: "",
      };
    }

    const refundAmount = Number(((displayedPrice * refundRate) / 100).toFixed(2));
    return {
      taxAdjustedPrice: displayedPrice - refundAmount,
      note: `refund ${refundRate}%`,
    };
  }

  if (typeof rule.effectiveRefundRate === "number") {
    return {
      taxAdjustedPrice: displayedPrice * (1 - rule.effectiveRefundRate),
      note: `refund ${Math.round(rule.effectiveRefundRate * 100)}%`,
    };
  }

  if (rule.displayPriceIncludesTax && typeof rule.vatRate === "number") {
    return {
      taxAdjustedPrice: displayedPrice / (1 + rule.vatRate),
      note: `ex VAT ${Math.round(rule.vatRate * 100)}%`,
    };
  }

  return {
    taxAdjustedPrice: null,
    note: "",
  };
}
