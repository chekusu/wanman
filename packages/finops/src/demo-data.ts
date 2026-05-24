import { DEFAULT_PROVIDER_PRICING_REGISTRY } from './pricing-registry.js'
import type { BuildFinopsDashboardOptions } from './dashboard-model.js'
import type {
  ApiKeyInventory,
  ApiKeyProviderEvidence,
  ApiKeyReference,
  CostEntry,
  ProductConfig,
  ProviderName,
  RevenueEntry,
  UsageEntry,
} from './types.js'

const generatedAt = '2026-05-24T00:00:00.000Z'
const companyId = 'chekusu'

export const demoProducts: ProductConfig[] = [
  { id: 'agent-matrix', name: 'Agent Matrix', companyId, repositories: ['chekusu/wanman', 'chekusu/codeben'] },
  { id: 'payments', name: 'Payments and Keys', companyId, repositories: ['chekusu/shipkey'] },
  { id: 'sandbank-cloud', name: 'Sandbank Cloud', companyId, repositories: ['chekusu/cloud.sandbank.dev'] },
  { id: 'wanman-cloud', name: 'wanman.ai', companyId, repositories: ['chekusu/wanman.ai'] },
]

export const demoInventory: ApiKeyInventory = {
  generatedAt,
  root: 'demo://chekusu',
  companyId,
  reposScanned: 5,
  references: [
    credential('chekusu/codeben', 'agent-matrix', 'OPENAI_API_KEY', 'openai', 'openrouter', [
      evidence('env-access', 'src/providers/openrouter.ts', 'process.env.OPENAI_API_KEY'),
      evidence('sdk-import', 'src/providers/openrouter.ts', 'import:openai', 'openai'),
      evidence('base-url', 'src/providers/openrouter.ts', 'host:openrouter.ai', 'openrouter'),
      evidence('package-name', 'package.json', 'package:openai', 'openai'),
    ]),
    credential('chekusu/wanman', 'agent-matrix', 'GITHUB_TOKEN', 'github', 'github', [
      evidence('github-secret', '.github/workflows/release.yml', 'secrets.GITHUB_TOKEN', 'github'),
    ]),
    credential('chekusu/shipkey', 'payments', 'STRIPE_SECRET_KEY', 'stripe', 'stripe', [
      evidence('env-access', 'src/stripe-ledger.ts', 'process.env.STRIPE_SECRET_KEY', 'stripe'),
      evidence('sdk-import', 'src/stripe-ledger.ts', 'import:stripe', 'stripe'),
    ]),
    credential('chekusu/cloud.sandbank.dev', 'sandbank-cloud', 'CLOUDFLARE_API_TOKEN', 'cloudflare', 'cloudflare', [
      evidence('github-secret', '.github/workflows/deploy.yml', 'secrets.CLOUDFLARE_API_TOKEN', 'cloudflare'),
    ]),
    credential('chekusu/cloud.sandbank.dev', 'sandbank-cloud', 'RESEND_API_KEY', 'resend', 'resend', [
      evidence('env-access', 'apps/api/src/mail.ts', 'process.env.RESEND_API_KEY', 'resend'),
      evidence('package-name', 'package.json', 'package:resend', 'resend'),
    ]),
    credential('chekusu/wanman.ai', 'wanman-cloud', 'OPENAI_ADMIN_KEY', 'openai', 'openai', [
      evidence('env-access', 'apps/api/src/openai-costs.ts', 'process.env.OPENAI_ADMIN_KEY', 'openai'),
      evidence('sdk-import', 'apps/api/src/openai-costs.ts', 'import:openai', 'openai'),
      evidence('base-url', 'apps/api/src/openai-costs.ts', 'host:api.openai.com', 'openai'),
      evidence('package-name', 'package.json', 'package:openai', 'openai'),
    ]),
    credential('chekusu/wanman.ai', 'wanman-cloud', 'STRIPE_SECRET_KEY', 'stripe', 'stripe', [
      evidence('env-access', 'apps/api/src/stripe-ledger.ts', 'process.env.STRIPE_SECRET_KEY', 'stripe'),
      evidence('sdk-import', 'apps/api/src/stripe-ledger.ts', 'import:stripe', 'stripe'),
    ]),
  ],
  byProduct: {
    'agent-matrix': {
      productId: 'agent-matrix',
      repoCount: 2,
      keyCount: 2,
      providers: { github: 1, openrouter: 1 },
      envVars: ['GITHUB_TOKEN', 'OPENAI_API_KEY'],
    },
    payments: {
      productId: 'payments',
      repoCount: 1,
      keyCount: 1,
      providers: { stripe: 1 },
      envVars: ['STRIPE_SECRET_KEY'],
    },
    'sandbank-cloud': {
      productId: 'sandbank-cloud',
      repoCount: 1,
      keyCount: 2,
      providers: { cloudflare: 1, resend: 1 },
      envVars: ['CLOUDFLARE_API_TOKEN', 'RESEND_API_KEY'],
    },
    'wanman-cloud': {
      productId: 'wanman-cloud',
      repoCount: 1,
      keyCount: 2,
      providers: { openai: 1, stripe: 1 },
      envVars: ['OPENAI_ADMIN_KEY', 'STRIPE_SECRET_KEY'],
    },
  },
  byCompany: {
    chekusu: {
      companyId,
      productCount: 4,
      keyCount: 7,
      providers: { cloudflare: 1, github: 1, openai: 1, openrouter: 1, resend: 1, stripe: 2 },
    },
  },
}

export const demoCosts: CostEntry[] = [
  cost('cost:openai:wanman-cloud:2026-05', 'openai', 'wanman-cloud', 184.22, 'openai:organization-costs', 'Text models'),
  cost('cost:stripe:wanman-cloud:2026-05', 'stripe', 'wanman-cloud', 46.1, 'stripe:balance-transactions', 'stripe_fee'),
  cost('cost:openrouter:agent-matrix:2026-05', 'openrouter', 'agent-matrix', 72.44, 'openrouter:pricing-registry-estimate', 'chat-completions'),
  cost('cost:cloudflare:sandbank-cloud:2026-05', 'cloudflare', 'sandbank-cloud', 29.5, 'cloudflare:billing-export', 'workers'),
  cost('cost:resend:sandbank-cloud:2026-05', 'resend', 'sandbank-cloud', 12, 'resend:usage-export', 'email'),
  cost('cost:stripe:payments:2026-05', 'stripe', 'payments', 18.4, 'stripe:balance-transactions', 'stripe_fee'),
]

export const demoRevenue: RevenueEntry[] = [
  revenue('revenue:stripe:wanman-cloud:2026-05', 'wanman-cloud', 640, 'stripe:balance-transactions', 'charge'),
  revenue('revenue:stripe:agent-matrix:2026-05', 'agent-matrix', 155, 'stripe:balance-transactions', 'charge'),
  revenue('revenue:stripe:payments:2026-05', 'payments', 220, 'stripe:balance-transactions', 'charge'),
]

export const demoUsage: UsageEntry[] = [
  usage('usage:openai:wanman-cloud:input:2026-05', 'openai', 'wanman-cloud', 'input_tokens', 94300000, 'count', 'gpt-5.2'),
  usage('usage:openai:wanman-cloud:output:2026-05', 'openai', 'wanman-cloud', 'output_tokens', 6200000, 'count', 'gpt-5.2'),
  usage('usage:openrouter:agent-matrix:input:2026-05', 'openrouter', 'agent-matrix', 'input_tokens', 20800000, 'count', 'openai/gpt-5.2-chat'),
  usage('usage:openrouter:agent-matrix:output:2026-05', 'openrouter', 'agent-matrix', 'output_tokens', 2600000, 'count', 'openai/gpt-5.2-chat'),
]

export const demoWorkspaceInput: BuildFinopsDashboardOptions = {
  company: { id: companyId, name: 'Chekusu', baseCurrency: 'USD' },
  products: demoProducts,
  inventory: demoInventory,
  costs: demoCosts,
  revenue: demoRevenue,
  usage: demoUsage,
  pricing: DEFAULT_PROVIDER_PRICING_REGISTRY,
  generatedAt,
}

function credential(
  repo: string,
  productId: string,
  envVar: string,
  credentialProvider: ProviderName,
  provider: ProviderName,
  providerEvidence: ApiKeyProviderEvidence[],
): ApiKeyReference {
  return {
    repo,
    repoPath: `demo://${repo}`,
    productId,
    companyId,
    envVar,
    credentialProvider,
    provider,
    evidenceKinds: [...new Set(providerEvidence.map((item) => item.kind))],
    sourceFiles: [...new Set(providerEvidence.map((item) => item.sourceFile))],
    providerEvidence,
    secretIncluded: false,
  }
}

function evidence(
  kind: ApiKeyProviderEvidence['kind'],
  sourceFile: string,
  value: string,
  provider?: ProviderName,
): ApiKeyProviderEvidence {
  return { kind, sourceFile, value, provider }
}

function cost(
  id: string,
  provider: ProviderName,
  productId: string,
  amount: number,
  source: string,
  lineItem: string,
): CostEntry {
  return {
    id,
    provider,
    companyId,
    productId,
    amount,
    currency: 'USD',
    startTime: '2026-05-01T00:00:00.000Z',
    endTime: '2026-06-01T00:00:00.000Z',
    source,
    usageMetric: lineItem,
    lineItem,
  }
}

function revenue(
  id: string,
  productId: string,
  amount: number,
  source: string,
  reportingCategory: string,
): RevenueEntry {
  return {
    id,
    provider: 'stripe',
    companyId,
    productId,
    amount,
    currency: 'USD',
    bookedAt: '2026-05-20T00:00:00.000Z',
    source,
    reportingCategory,
  }
}

function usage(
  id: string,
  provider: ProviderName,
  productId: string,
  metric: string,
  quantity: number,
  unit: string,
  model: string,
): UsageEntry {
  return {
    id,
    provider,
    companyId,
    productId,
    startTime: '2026-05-01T00:00:00.000Z',
    endTime: '2026-06-01T00:00:00.000Z',
    metric,
    quantity,
    unit,
    model,
  }
}
