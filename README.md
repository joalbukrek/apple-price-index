# Apple Price Index

CLI prototype for comparing Apple Mac prices against Turkey.

The default mode is interactive:

1. Open the CLI
2. Choose a Mac family
3. Pick the product
4. Get the price comparison

## Quick start

From this project folder:

```bash
npm start
```

or:

```bash
node cli.mjs
```

If you want a global command:

```bash
npm link
apple-price-index
```

## Interactive flow

The interactive CLI lets you:

- choose the Mac family
- filter products by typing text like `m5 pro`
- select the exact product from a numbered list
- page through large product sets with `/next`, show all matches with `/all`, and move back a level with `/prev`
- stay inside the CLI after a comparison and leave only with `/exit`
- compare against your curated 38-country basket
- see only the 20 cheapest rows by `average_try` when a result set is large
- see full RAM and storage CTO variants, not just Apple’s surfaced presets
- instantly compare against the default country set you selected
- ignore color duplicates when the Apple price is the same

Normal runs use the saved catalog snapshots instead of re-checking Apple live every time. Use `update-prices` when you want to refresh them intentionally.

## Direct commands

List countries:

```bash
node cli.mjs countries
```

List products from Turkey:

```bash
node cli.mjs list-products --family macbook-pro --country tr
```

Compare one product directly:

```bash
node cli.mjs compare \
  --family macbook-pro \
  --variant 14inch-standard-m5pro-15-16-24gb-1tb \
  --countries tr,ch,fr,de,uk,jp,kr
```

Find cheapest countries:

```bash
node cli.mjs cheapest --family macbook-pro --countries all --limit 20
```

Refresh the monthly catalog snapshot on demand:

```bash
node cli.mjs update-prices
node cli.mjs update-prices --family macbook-pro --countries tr,ch,fr
node cli.mjs update-prices --family all --countries all
```

If a long refresh stops in the middle, rerun the exact same `update-prices` command and it will resume from the last completed country/family pair instead of starting over.
Each refresh line also shows the Apple request count and elapsed time for that country/family task.

## Tax rules

The CLI loads Glocalzone VAT refund rules for Switzerland, France, Spain, and Germany.

Local overrides still live in `data/tax-rules.json`.

- `displayPriceIncludesTax`
- `vatRate`
- `effectiveRefundRate`
- `taxFreeEnabled`
- `refundType`

Mac comparisons use the Glocalzone tiered refund percentages when available, with a built-in fallback snapshot if Glocalzone is unreachable.
Turkey is overridden to show `tax_free_try` equal to the local list price with `no refund`.

## Notes

- Prices come from Apple Store buy pages.
- The catalog expands Apple CTO memory and storage combinations by walking Apple’s `update-config` API.
- Catalog snapshots are cached for 30 days under `~/.cache/apple-price-index/catalogs/`.
- `update-prices` forces a fresh rebuild of the saved catalog snapshots.
- Refresh progress is checkpointed per country and Mac family, so interrupted runs can resume later.
- If Apple starts returning blocking responses such as `403` or `429`, the refresh stops immediately and keeps the completed checkpoints.
- Transient network failures use bounded retry/backoff, but Apple blocking responses still stop the job immediately.
- The default comparison basket is limited to your selected 38 supported countries.
- Large result sets are ranked by `average_try`, which averages displayed TRY and tax-free TRY when tax-free pricing exists.
- FX conversion uses live rates converted into TRY.
- Results are cached under `~/.cache/apple-price-index/`.
- This follows the same CLI-first direction emphasized by [CLI-Anything](https://github.com/HKUDS/CLI-Anything): simple entrypoint, self-describing commands, and an agent-friendly terminal workflow.
