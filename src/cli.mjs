#!/usr/bin/env node

import { usage, parseOptions } from "./cli-common.mjs";
import {
  commandCheapest,
  commandCompare,
  commandCountries,
  commandListProducts,
} from "./cli-compare.mjs";
import { commandInteractive } from "./cli-interactive.mjs";
import { commandBundleData, commandUpdatePrices } from "./cli-refresh.mjs";

async function main() {
  const { command, values } = parseOptions();

  if (values.help || command === "help") {
    console.log(usage());
    return;
  }

  switch (command) {
    case "interactive":
      await commandInteractive(values);
      break;
    case "countries":
      await commandCountries(values);
      break;
    case "list-products":
      await commandListProducts(values);
      break;
    case "compare":
      await commandCompare(values);
      break;
    case "cheapest":
      await commandCheapest(values);
      break;
    case "update-prices":
      await commandUpdatePrices(values);
      break;
    case "bundle-data":
      await commandBundleData(values);
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
