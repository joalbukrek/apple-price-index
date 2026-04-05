import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { discoverStorefronts, filterVariants, loadFamilyCatalog, MAC_FAMILIES, resolveStorefront } from "./apple.mjs";
import {
  DEFAULT_COMPARE_COUNTRIES,
  DEFAULT_COMPARE_COUNTRY_CODES,
  filterSupportedStorefronts,
  VARIANT_PAGE_SIZE,
} from "./cli-common.mjs";
import { buildComparison, printComparison } from "./cli-compare.mjs";
import { formatMoney, renderTable } from "./utils.mjs";

async function promptForOption(rl, title, options, { showExitHint = true } = {}) {
  console.log(`\n${title}`);
  options.forEach((option, index) => {
    console.log(`  ${index + 1}. ${option.label}`);
  });
  if (showExitHint) {
    console.log("  /exit");
  }

  while (true) {
    const answer = (await rl.question("> ")).trim();
    if (answer === "/exit") {
      return null;
    }

    const choice = Number.parseInt(answer, 10);
    if (Number.isInteger(choice) && choice >= 1 && choice <= options.length) {
      return options[choice - 1].value;
    }

    console.log(`Enter a number between 1 and ${options.length}, or /exit.`);
  }
}

async function promptForVariant(rl, catalog, initialState = {}) {
  const state = initialState ?? {};
  let query = state.query ?? "";
  let page = state.page ?? 0;
  let showAll = state.showAll ?? false;

  while (true) {
    const matches = filterVariants(catalog.variants, query);
    if (!matches.length) {
      console.log("\nNo matches. Type another filter.");
      query = "";
      page = 0;
      showAll = false;
      continue;
    }

    const totalPages = Math.max(1, Math.ceil(matches.length / VARIANT_PAGE_SIZE));
    if (page >= totalPages) {
      page = totalPages - 1;
    }

    const startIndex = showAll ? 0 : page * VARIANT_PAGE_SIZE;
    const pageSize = showAll ? matches.length : VARIANT_PAGE_SIZE;
    const shown = matches.slice(startIndex, startIndex + pageSize).map((variant, index) => ({
      index: String(startIndex + index + 1),
      title: variant.title,
      price: formatMoney(variant.displayedPrice, variant.currency, 0),
    }));
    const rangeStart = shown.length ? startIndex + 1 : 0;
    const rangeEnd = startIndex + shown.length;

    console.log(`\n${catalog.family.name} in ${catalog.storefront.name}`);
    console.log(`Filter: ${query || "all products"}`);
    if (matches.length > VARIANT_PAGE_SIZE) {
      if (showAll) {
        console.log(`Showing all ${matches.length} matches. Type /paged to return to pages.`);
      } else {
        console.log(
          `Showing ${rangeStart}-${rangeEnd} of ${matches.length}. Page ${page + 1}/${totalPages}. Type /next for more, /all to show all, or /prev to go back.`,
        );
      }
    }
    console.log(
      renderTable(shown, [
        { key: "index", label: "#" },
        { key: "title", label: "product", maxWidth: 78 },
        { key: "price", label: "price" },
      ]),
    );

    const answer = (
      await rl.question(
        '\nChoose a product number, type a filter like "m5 max", or use /next, /prev, /all, /clear, /exit: ',
      )
    ).trim();

    if (!answer) {
      continue;
    }

    if (answer === "/exit") {
      return {
        type: "exit",
        state: { query, page, showAll },
      };
    }

    if (answer === "/clear") {
      query = "";
      page = 0;
      showAll = false;
      continue;
    }

    if (answer === "/next") {
      if (showAll) {
        continue;
      }

      page = Math.min(totalPages - 1, page + 1);
      continue;
    }

    if (answer === "/prev") {
      if (showAll) {
        showAll = false;
        page = 0;
        continue;
      }

      if (page > 0) {
        page -= 1;
        continue;
      }

      return {
        type: "back",
        state: { query, page, showAll },
      };
    }

    if (answer === "/all") {
      showAll = true;
      page = 0;
      continue;
    }

    if (answer === "/paged") {
      showAll = false;
      page = 0;
      continue;
    }

    const choice = Number.parseInt(answer, 10);
    if (Number.isInteger(choice) && choice >= 1 && choice <= matches.length) {
      return {
        type: "variant",
        variant: matches[choice - 1],
        state: { query, page, showAll },
      };
    }

    query = answer;
    page = 0;
    showAll = false;
  }
}

async function promptAfterComparison(rl) {
  console.log(
    "\nCommands: /prev to return to the variant list, /home to choose another Mac family, /exit to quit.",
  );

  while (true) {
    const answer = (await rl.question("> ")).trim();

    if (answer === "/prev") {
      return "variants";
    }

    if (answer === "/home") {
      return "families";
    }

    if (answer === "/exit") {
      return "exit";
    }

    console.log("Use /prev, /home, or /exit.");
  }
}

export async function commandInteractive(values) {
  const rl = createInterface({ input, output });

  try {
    console.log("Apple Price Index");
    console.log("Choose a Mac product and get a country comparison.\n");

    const storefronts = await discoverStorefronts({
      refresh: values.refresh,
      allLocales: values["all-locales"],
    });
    const supportedStorefronts = filterSupportedStorefronts(storefronts);
    const turkeyStorefront = resolveStorefront(supportedStorefronts, "tr");

    if (!turkeyStorefront) {
      throw new Error("Could not resolve Turkey storefront.");
    }

    let familySlug = null;
    let variantBrowserState = null;

    while (true) {
      if (!familySlug) {
        variantBrowserState = null;
        familySlug = await promptForOption(
          rl,
          "Choose a Mac family:",
          MAC_FAMILIES.map((family) => ({
            label: family.name,
            value: family.slug,
          })),
          { showExitHint: false },
        );

        if (!familySlug) {
          return;
        }
      }

      const turkeyCatalog = await loadFamilyCatalog(turkeyStorefront, familySlug, {
        refresh: values.refresh,
      });
      const variantSelection = await promptForVariant(rl, turkeyCatalog, variantBrowserState);
      variantBrowserState = variantSelection.state ?? null;

      if (variantSelection.type === "exit") {
        return;
      }

      if (variantSelection.type === "back") {
        familySlug = null;
        variantBrowserState = null;
        continue;
      }

      console.log(
        `\nLoading Apple price comparison for ${DEFAULT_COMPARE_COUNTRY_CODES.length} default countries...\n`,
      );
      const comparison = await buildComparison({
        ...values,
        family: familySlug,
        variant: variantSelection.variant.variantKey,
        countries: DEFAULT_COMPARE_COUNTRIES,
        "resolve-country": "tr",
      });
      printComparison(comparison);

      const nextAction = await promptAfterComparison(rl);
      if (nextAction === "exit") {
        return;
      }

      if (nextAction === "families") {
        familySlug = null;
        variantBrowserState = null;
      }
    }
  } finally {
    rl.close();
  }
}
