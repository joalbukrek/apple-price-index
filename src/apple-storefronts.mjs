import { fetchText } from "./http.mjs";
import { humanizeIdentifier, normalizeText, stripHtml, uniqueBy } from "./utils.mjs";

export const PRODUCT_CATEGORIES = [
  { slug: "mac", name: "Mac" },
  { slug: "iphone", name: "iPhone" },
  { slug: "ipad", name: "iPad" },
  { slug: "watch", name: "Watch" },
  { slug: "airpods", name: "AirPods" },
];

export const PRODUCT_FAMILIES = [
  { slug: "macbook-neo", name: "MacBook Neo", category: "mac", buyPath: "buy-mac" },
  { slug: "macbook-air", name: "MacBook Air", category: "mac", buyPath: "buy-mac" },
  { slug: "macbook-pro", name: "MacBook Pro", category: "mac", buyPath: "buy-mac" },
  { slug: "imac", name: "iMac", category: "mac", buyPath: "buy-mac" },
  { slug: "mac-mini", name: "Mac mini", category: "mac", buyPath: "buy-mac" },
  { slug: "mac-studio", name: "Mac Studio", category: "mac", buyPath: "buy-mac" },
  { slug: "iphone-17-pro", name: "iPhone 17 Pro", category: "iphone", buyPath: "buy-iphone" },
  { slug: "iphone-air", name: "iPhone Air", category: "iphone", buyPath: "buy-iphone" },
  { slug: "iphone-17", name: "iPhone 17", category: "iphone", buyPath: "buy-iphone" },
  { slug: "iphone-17e", name: "iPhone 17e", category: "iphone", buyPath: "buy-iphone" },
  { slug: "iphone-16", name: "iPhone 16", category: "iphone", buyPath: "buy-iphone" },
  { slug: "ipad-pro", name: "iPad Pro", category: "ipad", buyPath: "buy-ipad" },
  { slug: "ipad-air", name: "iPad Air", category: "ipad", buyPath: "buy-ipad" },
  { slug: "ipad", name: "iPad", category: "ipad", buyPath: "buy-ipad" },
  { slug: "ipad-mini", name: "iPad mini", category: "ipad", buyPath: "buy-ipad" },
  { slug: "apple-watch", name: "Apple Watch", category: "watch", buyPath: "buy-watch" },
  { slug: "apple-watch-se", name: "Apple Watch SE", category: "watch", buyPath: "buy-watch" },
  { slug: "apple-watch-ultra", name: "Apple Watch Ultra", category: "watch", buyPath: "buy-watch" },
  { slug: "airpods-4", name: "AirPods 4", category: "airpods", buyPath: "buy-airpods" },
  {
    slug: "airpods-pro-3",
    path: "airpods-pro-3",
    name: "AirPods Pro 3",
    category: "airpods",
    buyPath: "buy-airpods",
  },
  {
    slug: "airpods-max",
    path: "airpods-max-2",
    name: "AirPods Max",
    category: "airpods",
    buyPath: "buy-airpods",
  },
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
const PREFERRED_LOCALE_BY_COUNTRY = {
  be: "be-fr",
};

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function canonicalizeLocalePath(pathname = "") {
  const trimmed = pathname.replace(/^\/|\/$/g, "");
  if (/^[a-z]{4}$/i.test(trimmed)) {
    return `/${trimmed.slice(0, 2)}-${trimmed.slice(2)}/`;
  }

  return pathname;
}

function normalizeStorefrontHref(href) {
  if (href === "/") {
    return "https://www.apple.com/us/";
  }

  if (href.startsWith("http://") || href.startsWith("https://")) {
    const parsed = new URL(href);
    parsed.pathname = canonicalizeLocalePath(parsed.pathname);
    return ensureTrailingSlash(parsed.toString());
  }

  const parsed = new URL(href, "https://www.apple.com");
  parsed.pathname = canonicalizeLocalePath(parsed.pathname);
  return ensureTrailingSlash(parsed.toString());
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
  const preferredLocale = PREFERRED_LOCALE_BY_COUNTRY[storefront.countryCode];

  if (preferredLocale && locale === preferredLocale) {
    return 110;
  }

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

function buildBuyLocalePath(localeKey) {
  if (/^[a-z]{4}$/i.test(localeKey)) {
    return `${localeKey.slice(0, 2)}-${localeKey.slice(2)}`;
  }

  return localeKey;
}

export function resolveProductFamily(familySlug) {
  return PRODUCT_FAMILIES.find((family) => family.slug === familySlug) ?? null;
}

export function buildFamilyUrl(storefront, familySlug) {
  const localePath = buildBuyLocalePath(storefront.localeKey);
  const family = resolveProductFamily(familySlug);
  if (!family) {
    throw new Error(`Unknown product family: ${familySlug}`);
  }
  const relativePath = `shop/${family.buyPath}/${family.path ?? family.slug}`;

  if (localePath !== storefront.localeKey) {
    return `https://www.apple.com/${localePath}/${relativePath}`;
  }

  return new URL(relativePath, storefront.url).toString();
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
