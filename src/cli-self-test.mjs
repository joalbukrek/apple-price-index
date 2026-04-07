import { readBundledCatalogSnapshot } from "./catalog-cache.mjs";
import {
  commandCheapest,
  commandCompare,
  commandCountries,
  commandListProducts,
} from "./cli-compare.mjs";
import {
  filterSupportedStorefronts,
  FAMILY_GROUP_ALIASES,
  resolveCountrySelectors,
  resolveFamilySlugs,
  resolveRequestedStorefronts,
} from "./cli-common.mjs";
import { discoverStorefronts, PRODUCT_FAMILIES } from "./apple.mjs";

const SAMPLE_COUNTRY_PREFERENCE = [
  "tr",
  "us",
  "jp",
  "fr",
  "de",
  "tw",
  "sg",
  "uk",
  "ch",
  "kr",
];
const MAX_REPORTED_ISSUES = 20;

function sortStorefrontsForSampling(storefronts) {
  const preference = new Map(
    SAMPLE_COUNTRY_PREFERENCE.map((countryCode, index) => [countryCode, index]),
  );

  return [...storefronts].sort((left, right) => {
    const leftRank = preference.get(left.countryCode) ?? Number.POSITIVE_INFINITY;
    const rightRank = preference.get(right.countryCode) ?? Number.POSITIVE_INFINITY;

    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    return left.name.localeCompare(right.name);
  });
}

async function captureOutput(task) {
  const lines = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args) => {
    lines.push(args.join(" "));
  };
  console.error = (...args) => {
    lines.push(args.join(" "));
  };

  try {
    await task();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  return lines.join("\n");
}

async function findSampleVariant(storefronts, familySlug) {
  for (const storefront of sortStorefrontsForSampling(storefronts)) {
    const snapshot = await readBundledCatalogSnapshot(storefront, familySlug, {
      allowStale: true,
    });

    if (snapshot?.variants?.length) {
      return {
        storefront,
        snapshot,
        variant: snapshot.variants[0],
      };
    }
  }

  return null;
}

async function collectCoverageWarnings(storefronts, familySlugs) {
  const warnings = [];

  for (const storefront of storefronts) {
    for (const familySlug of familySlugs) {
      const snapshot = await readBundledCatalogSnapshot(storefront, familySlug, {
        allowStale: true,
      });

      if (!snapshot) {
        warnings.push(`${storefront.countryCode.toUpperCase()} ${familySlug}: missing bundled snapshot`);
        continue;
      }

      if (!snapshot.unsupported && !(snapshot.variants?.length > 0)) {
        warnings.push(`${storefront.countryCode.toUpperCase()} ${familySlug}: empty bundled snapshot`);
      }
    }
  }

  return warnings;
}

function printIssueBlock(title, issues) {
  if (!issues.length) {
    return;
  }

  console.log(`\n${title}`);
  for (const issue of issues.slice(0, MAX_REPORTED_ISSUES)) {
    console.log(`- ${issue}`);
  }
  if (issues.length > MAX_REPORTED_ISSUES) {
    console.log(`- ...and ${issues.length - MAX_REPORTED_ISSUES} more`);
  }
}

export async function commandSelfTest(values) {
  const requestedFamily = values.family ?? "all";
  const familySlugs = resolveFamilySlugs(requestedFamily);
  const storefronts = filterSupportedStorefronts(
    await discoverStorefronts({
      refresh: values.refresh,
      allLocales: values["all-locales"],
    }),
  );
  const selectedStorefronts =
    !values.countries || values.countries === "all"
      ? storefronts
      : resolveRequestedStorefronts(storefronts, resolveCountrySelectors(values.countries));
  const selectedFamilySet = new Set(familySlugs);
  const selectedFamilies = PRODUCT_FAMILIES.filter((family) => selectedFamilySet.has(family.slug));
  const failures = [];

  console.log(
    `Running self-test for ${selectedStorefronts.length} countries and ${selectedFamilies.length} product families.\n`,
  );

  const countriesOutput = await captureOutput(() =>
    commandCountries({
      refresh: false,
      "all-locales": false,
    }),
  );
  if (!countriesOutput.includes("country") || !countriesOutput.includes("storefront")) {
    failures.push("countries: command output did not contain the expected table headers");
  }

  const coverageWarnings = await collectCoverageWarnings(selectedStorefronts, familySlugs);

  for (const family of selectedFamilies) {
    const sample = await findSampleVariant(selectedStorefronts, family.slug);

    if (!sample) {
      failures.push(`${family.slug}: no bundled sample variant found in the selected countries`);
      continue;
    }

    const listOutput = await captureOutput(() =>
      commandListProducts({
        family: family.slug,
        country: sample.storefront.countryCode,
        refresh: false,
      }),
    );
    if (!listOutput.includes("variant(s)")) {
      failures.push(
        `${family.slug}: list-products did not print a variant table for ${sample.storefront.countryCode.toUpperCase()}`,
      );
    }

    const compareCountries = [];
    for (const storefront of sortStorefrontsForSampling(selectedStorefronts)) {
      const snapshot = await readBundledCatalogSnapshot(storefront, family.slug, {
        allowStale: true,
      });
      const hasVariant = snapshot?.variants?.some(
        (variant) => variant.canonicalKey === sample.variant.canonicalKey,
      );
      if (hasVariant) {
        compareCountries.push(storefront.countryCode);
      }
      if (compareCountries.length >= 5) {
        break;
      }
    }

    const compareOutput = await captureOutput(() =>
      commandCompare({
        family: family.slug,
        variant: sample.variant.variantKey,
        countries: compareCountries.join(","),
        "resolve-country": sample.storefront.countryCode,
        refresh: false,
      }),
    );
    if (!compareOutput.includes("displayed_local") || !compareOutput.includes("average_try")) {
      failures.push(`${family.slug}: compare did not print the expected comparison table`);
    }
  }

  const groupChecks = [...Object.keys(FAMILY_GROUP_ALIASES).filter((alias) => alias !== "airpod"), "all"];

  for (const alias of groupChecks) {
    const cheapestOutput = await captureOutput(() =>
      commandCheapest({
        family: alias,
        countries: "tr",
        limit: "1",
        refresh: false,
      }),
    );

    if (!cheapestOutput.includes("average_try")) {
      failures.push(`${alias}: cheapest did not print the expected table`);
    }
  }

  const totalFamilyChecks = selectedFamilies.length * 2;
  const totalGroupChecks = groupChecks.length;
  const failedFamilyChecks = failures.filter(
    (issue) =>
      issue.includes(": list-products") ||
      issue.includes(": compare") ||
      issue.includes(": no bundled sample"),
  ).length;
  const failedGroupChecks = failures.filter((issue) =>
    issue.endsWith(": cheapest did not print the expected table"),
  ).length;

  console.log("Self-test summary");
  console.log(`- countries command: ${failures.some((issue) => issue.startsWith("countries:")) ? "failed" : "passed"}`);
  console.log(`- family smoke checks passed: ${totalFamilyChecks - failedFamilyChecks}/${totalFamilyChecks}`);
  console.log(`- group cheapest checks passed: ${totalGroupChecks - failedGroupChecks}/${totalGroupChecks}`);
  console.log(`- bundled coverage warnings: ${coverageWarnings.length}`);

  printIssueBlock("Failures", failures);
  printIssueBlock("Coverage Warnings", coverageWarnings);

  if (failures.length) {
    throw new Error(`Self-test failed with ${failures.length} issue(s).`);
  }

  console.log("\nSelf-test passed.");
  if (coverageWarnings.length) {
    console.log("Bundled snapshot coverage warnings were reported above.");
  }
}
