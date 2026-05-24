# Wanman FinOps

Cost, usage, revenue, and credential-inventory tooling for Wanman products.

The package is designed so the open-source app can render sanitized runtime data
without committing API keys or billing exports. Runtime files may contain
repository names, environment variable names, source-file evidence, provider
attribution, and aggregated ledger rows. They must not contain secret values.

## Data Flow

1. Scan private repositories for credential references:

   ```bash
   export CHEKUSU_SCAN_ROOT=/secure/local/scans/github.com/chekusu
   export FINOPS_DATA_DIR=/secure/local/finops

   pnpm --filter @wanman/finops cli inventory \
     --root "$CHEKUSU_SCAN_ROOT" \
     --company chekusu \
     --out "$FINOPS_DATA_DIR/chekusu-inventory.json"
   ```

2. Sync provider usage or cost ledgers with provider admin credentials:

   ```bash
   OPENAI_ADMIN_KEY=... pnpm --filter @wanman/finops cli openai-costs \
     --start 2026-05-01 \
     --out "$FINOPS_DATA_DIR/openai-costs.json"

   OPENAI_ADMIN_KEY=... pnpm --filter @wanman/finops cli openai-usage \
     --service completions \
     --start 2026-05-01 \
     --out "$FINOPS_DATA_DIR/openai-usage.json"

   STRIPE_SECRET_KEY=... pnpm --filter @wanman/finops cli stripe-ledger \
     --start 2026-05-01 \
     --out "$FINOPS_DATA_DIR/stripe-ledger.json"
   ```

3. Build the runtime dashboard file:

   ```bash
   pnpm --filter @wanman/finops cli dashboard \
     --inventory "$FINOPS_DATA_DIR/chekusu-inventory.json" \
     --costs "$FINOPS_DATA_DIR/openai-costs.json" \
     --usage "$FINOPS_DATA_DIR/openai-usage.json" \
     --revenue "$FINOPS_DATA_DIR/stripe-ledger.json" \
     --company chekusu \
     --company-name Chekusu \
     --out "$FINOPS_DATA_DIR/runtime-data.json"
   ```

4. Serve the web app with the runtime file:

   ```bash
   WANMAN_FINOPS_RUNTIME_DATA="$FINOPS_DATA_DIR/runtime-data.json" \
     pnpm --filter @wanman/finops dev -- --host 127.0.0.1 --port 4173
   ```

## Usage Access Model

Provider usage access is tracked in `src/usage-capabilities.ts`.

- OpenAI: organization usage and costs APIs with `OPENAI_ADMIN_KEY`.
- Anthropic: Usage and Cost Admin API with an organization admin key.
- OpenRouter: per-generation usage and cost lookup; persist generation IDs for historical cost attribution.
- Stripe: balance transactions as the revenue, fee, refund, and payout ledger.
- GitHub, Vercel, AWS, Google Cloud, Twilio, SendGrid, Cloudflare, Supabase, Resend, Sentry, Slack, and Discord: capability rows document whether usage is available, limited, export-based, or unavailable.

When no admin/master credentials are configured, the app still shows real
sanitized inventory and provider requirements, but ROI remains `n/a` until
cost and revenue ledgers are loaded.
