#!/usr/bin/env node

import { usage, parseOptions } from "./cli-common.mjs";
import {
  commandCheapest,
  commandCompare,
  commandCountries,
  commandListProducts,
} from "./cli-compare.mjs";
import { commandInteractive } from "./cli-interactive.mjs";
import { commandBundleData, commandUpdateFx, commandUpdatePrices } from "./cli-refresh.mjs";
import { commandSelfTest } from "./cli-self-test.mjs";

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
    case "update-fx":
      await commandUpdateFx(values);
      break;
    case "bundle-data":
      await commandBundleData(values);
      break;
    case "self-test":
      await commandSelfTest(values);
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
