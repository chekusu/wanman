# FinOps Cost and Revenue Accounting

wanman FinOps is a small open-source toolkit for product-level cost, revenue, and ROI accounting. It is designed for teams that run several products under one company and need to answer three questions:

1. Which repositories reference paid API credentials?
2. What did each product cost during an accounting period?
3. Did Stripe revenue cover those costs?

The toolkit never writes secret values to output. Inventory records contain environment variable names, provider classification, repository names, and source file paths only.

## Reviewable Web App

Run the local browser app from the workspace checkout:

```bash
pnpm --filter @wanman/finops dev -- --host 127.0.0.1 --port 4173
```

Then open `http://127.0.0.1:4173/`.

The app loads a sanitized Chekusu demo dataset from `packages/finops/src/demo-data.ts`. It contains repo names, env var names, provider/source evidence, OpenAI cost rows, OpenAI/OpenRouter usage rows, Stripe revenue and fee rows, and pricing registry rows. It does not contain API key values, local private ledgers, or local filesystem paths.

## Commands

```bash
pnpm --filter @wanman/finops build

pnpm --filter @wanman/finops cli inventory \
  --root /path/to/repos/github.com/chekusu \
  --company jpco \
  --out .wanman/finops/key-inventory.json
```

Provider sync commands read credentials from process environment only:

```bash
OPENAI_ADMIN_KEY=... pnpm --filter @wanman/finops cli openai-costs \
  --company jpco \
  --start 2026-05-01 \
  --end 2026-06-01 \
  --project-product proj_abc=wanman \
  --out .wanman/finops/openai-costs.json

STRIPE_SECRET_KEY=... pnpm --filter @wanman/finops cli stripe-ledger \
  --company jpco \
  --start 2026-05-01 \
  --end 2026-06-01 \
  --out .wanman/finops/stripe-ledger.json

pnpm --filter @wanman/finops cli roi \
  --company jpco \
  --costs .wanman/finops/openai-costs.json,.wanman/finops/stripe-ledger.json \
  --revenue .wanman/finops/stripe-ledger.json \
  --out .wanman/finops/roi.json
```

`.wanman/` is ignored by git in this repository, so generated company inventory and ledgers stay local.

Refresh public pricing metadata without credentials:

```bash
pnpm --filter @wanman/finops cli refresh-prices \
  --limit 100 \
  --out .wanman/finops/provider-pricing.json
```

OpenRouter prices are refreshed from its public models API. OpenAI prices are carried as curated public rate-card rows with source URLs and source reachability checks because the public docs page is the authoritative rate card rather than a stable pricing JSON API.

## Cost Data

The OpenAI adapter uses the organization costs endpoint, grouped by `project_id` and `line_item`, because the official docs describe it as the endpoint intended for organization cost details. The usage adapter can also fetch organization usage buckets for services such as `completions`, `embeddings`, `images`, and `vector_stores`.

When a provider only exposes usage and not invoice-ready costs, record a `CostModel` with a metric, unit, unit price, currency, and source URL. `estimateCostsFromUsage()` turns usage rows into estimated cost rows. Keep exact billing data and estimated usage-derived data separate in reporting.

## Pricing Registry

`ProviderPricingRegistry` records provider, service, SKU, metric, unit, unit price, currency, pricing method, source URL, effective date, update cadence, and source check status. The default registry includes OpenAI public rate-card rows, OpenRouter public metadata rows, and a Stripe ledger method row that documents that fees come from balance transactions instead of a static estimate.

Use `refresh-prices` on a schedule to write `.wanman/finops/provider-pricing.json`; review and promote curated rows only after source checks look correct. The refresh command does not read provider secrets.

## Revenue Data

The Stripe adapter starts from balance transactions. Stripe's reporting docs recommend balance transactions as the ledger-style starting point for account balance activity, and each transaction includes fields such as `amount`, `fee`, `net`, `currency`, `type`, and `reporting_category`.

For ROI, wanman FinOps maps gross charge/payment/refund balance transactions into revenue rows and Stripe fees into cost rows. If the expanded Stripe source object contains metadata such as `product_id`, `productId`, `product`, `repo`, or `app`, that value is used as the product id. Otherwise, rows are assigned to `unmapped-stripe` or the `--product` fallback.

## Product Mapping

Inventory defaults each repository to one product with the same name. For company-level reporting or shared repos, pass a config file:

```json
{
  "company": { "id": "jpco", "name": "Japanese Entity", "baseCurrency": "jpy" },
  "products": [
    {
      "id": "wanman",
      "repositories": ["chekusu/wanman"],
      "openaiProjectIds": ["proj_abc"],
      "stripeMetadata": { "product_id": "wanman" }
    }
  ]
}
```

This mapping lets reports aggregate by product first and by company above that.

## Credential Evidence Model

Inventory stores both `credentialProvider` and `provider`. `credentialProvider` comes from the env var name, while `provider` is the billing/source provider inferred from nearby code evidence. For example, `OPENAI_API_KEY` remains an OpenAI-shaped credential name, but if the same file uses the OpenAI SDK with `https://openrouter.ai/api/v1`, the reference is classified as `provider: "openrouter"`.

Evidence rows include SDK imports, base URL hosts, package names, GitHub secret references, and source files. Evidence values are identifiers such as `import:openai`, `host:openrouter.ai`, or `package:openai`; credential values are never collected.
