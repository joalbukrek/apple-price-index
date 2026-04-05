import { fetchText } from "./http.mjs";
import { humanizeIdentifier, normalizeText, stripHtml, uniqueBy } from "./utils.mjs";

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

export function buildFamilyUrl(storefront, familySlug) {
  if (storefront.countryCode === "ch" && /^[a-z]{4}$/i.test(storefront.localeKey)) {
    const localePath = `${storefront.localeKey.slice(0, 2)}-${storefront.localeKey.slice(2)}`;
    return `https://www.apple.com/${localePath}/shop/buy-mac/${familySlug}`;
  }

  return new URL(`shop/buy-mac/${familySlug}`, storefront.url).toString();
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
