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
  {
    id: 'agent-matrix',
    name: 'Agent Matrix',
    description: 'Demo planning and model-routing surface for agent collaboration costs.',
    owner: 'Platform AI',
    lifecycle: 'Review demo',
    companyId,
    repositories: ['chekusu/wanman', 'chekusu/codeben'],
  },
  {
    id: 'payments',
    name: 'Payments and Keys',
    description: 'Demo billing controls for Stripe-led revenue and credential inventory.',
    owner: 'Revenue Systems',
    lifecycle: 'Live adapter ready',
    companyId,
    repositories: ['chekusu/shipkey'],
  },
  {
    id: 'sandbank-cloud',
    name: 'Sandbank Cloud',
    description: 'Demo workspace infrastructure view for edge runtime and messaging spend.',
    owner: 'Infrastructure',
    lifecycle: 'Internal platform',
    companyId,
    repositories: ['chekusu/cloud.sandbank.dev'],
  },
  {
    id: 'wanman-cloud',
    name: 'wanman.ai',
    description: 'Demo hosted app view combining sanitized AI usage costs and Stripe revenue.',
    owner: 'Product',
    lifecycle: 'Private app mirror',
    companyId,
    repositories: ['chekusu/wanman.ai'],
  },
]

export const demoInventory: ApiKeyInventory = {
  generatedAt,
  root: 'demo://chekusu',
  companyId,
  reposScanned: 5,
  repositories: [
    inventoryRepo('chekusu/codeben', 'agent-matrix', 1),
    inventoryRepo('chekusu/wanman', 'agent-matrix', 1),
    inventoryRepo('chekusu/shipkey', 'payments', 1),
    inventoryRepo('chekusu/cloud.sandbank.dev', 'sandbank-cloud', 2),
    inventoryRepo('chekusu/wanman.ai', 'wanman-cloud', 2),
  ],
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

const demoMonths = [
  month('2026-01', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'),
  month('2026-02', '2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'),
  month('2026-03', '2026-03-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'),
  month('2026-04', '2026-04-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'),
  month('2026-05', '2026-05-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'),
]

export const demoCosts: CostEntry[] = [
  ...monthlyCosts('openai', 'wanman-cloud', 'openai:organization-costs', 'text-models', [94, 118, 139, 162, 184.22]),
  ...monthlyCosts('stripe', 'wanman-cloud', 'stripe:balance-transactions', 'payment-fees', [22.4, 29.8, 35.6, 41.2, 46.1]),
  ...monthlyCosts('openrouter', 'agent-matrix', 'openrouter:pricing-registry-estimate', 'agent-inference', [36.8, 44.5, 53.6, 64.2, 72.44]),
  ...monthlyCosts('github', 'agent-matrix', 'github:billing-export', 'source-control', [6, 6, 8, 8, 10]),
  ...monthlyCosts('stripe', 'payments', 'stripe:balance-transactions', 'payment-fees', [10.8, 13.6, 15.7, 17.2, 18.4]),
  ...monthlyCosts('database', 'payments', 'demo:database-metering', 'transaction-storage', [8, 9.5, 11.25, 12.5, 14]),
  ...monthlyCosts('cloudflare', 'sandbank-cloud', 'cloudflare:billing-export', 'edge-runtime', [18.5, 21.75, 24.2, 27.1, 29.5]),
  ...monthlyCosts('resend', 'sandbank-cloud', 'resend:usage-export', 'email', [5.5, 7.1, 8.4, 10.2, 12]),
  ...monthlyCosts('github', 'sandbank-cloud', 'github:billing-export', 'automation', [4, 4, 4, 4, 4]),
]

export const demoRevenue: RevenueEntry[] = [
  ...monthlyRevenue('wanman-cloud', 'stripe:balance-transactions', 'subscription', [360, 430, 505, 575, 640]),
  ...monthlyRevenue('agent-matrix', 'stripe:balance-transactions', 'pilot-seat', [82, 104, 128, 143, 155]),
  ...monthlyRevenue('payments', 'stripe:balance-transactions', 'platform-fee', [130, 156, 184, 204, 220]),
  ...monthlyRevenue('sandbank-cloud', 'stripe:balance-transactions', 'workspace-seat', [165, 206, 246, 286, 320]),
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

function inventoryRepo(repo: string, productId: string, keyCount: number): ApiKeyInventory['repositories'][number] {
  return {
    repo,
    repoPath: `demo://${repo}`,
    productId,
    companyId,
    keyCount,
  }
}

function cost(
  id: string,
  provider: ProviderName,
  productId: string,
  amount: number,
  source: string,
  category: string,
  period: (typeof demoMonths)[number],
): CostEntry {
  return {
    id,
    provider,
    companyId,
    productId,
    amount,
    currency: 'USD',
    startTime: period.startTime,
    endTime: period.endTime,
    source,
    category,
    usageMetric: category,
    lineItem: category,
  }
}

function revenue(
  id: string,
  productId: string,
  amount: number,
  source: string,
  reportingCategory: string,
  period: (typeof demoMonths)[number],
): RevenueEntry {
  return {
    id,
    provider: 'stripe',
    companyId,
    productId,
    amount,
    currency: 'USD',
    bookedAt: `${period.id}-20T00:00:00.000Z`,
    source,
    reportingCategory,
  }
}

function month(id: string, startTime: string, endTime: string): { id: string, startTime: string, endTime: string } {
  return { id, startTime, endTime }
}

function monthlyCosts(
  provider: ProviderName,
  productId: string,
  source: string,
  category: string,
  amounts: number[],
): CostEntry[] {
  return demoMonths.map((period, index) => cost(
    `demo-cost:${provider}:${productId}:${category}:${period.id}`,
    provider,
    productId,
    amounts[index] ?? 0,
    source,
    category,
    period,
  ))
}

function monthlyRevenue(
  productId: string,
  source: string,
  reportingCategory: string,
  amounts: number[],
): RevenueEntry[] {
  return demoMonths.map((period, index) => revenue(
    `demo-revenue:stripe:${productId}:${reportingCategory}:${period.id}`,
    productId,
    amounts[index] ?? 0,
    source,
    reportingCategory,
    period,
  ))
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
