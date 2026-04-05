import { fetchJson } from "./http.mjs";

const FX_URL = "https://open.er-api.com/v6/latest/TRY";

export async function loadFxRates({ refresh = false } = {}) {
  return fetchJson(FX_URL, {
    refresh,
    cacheHours: 6,
  });
}

export function convertToTry(amount, currency, fx) {
  if (amount == null || !currency) {
    return null;
  }

  const normalizedCurrency = currency.toUpperCase();
  if (normalizedCurrency === "TRY") {
    return amount;
  }

  const rate = fx?.rates?.[normalizedCurrency];
  if (!rate) {
    return null;
  }

  return amount / rate;
}
