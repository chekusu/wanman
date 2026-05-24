import { roundMoney } from './money.js'
import { summarizeFinops } from './ledger.js'
import type {
  AccountingSummary,
  ApiKeyInventory,
  CompanyConfig,
  CostEntry,
  FinopsDashboardData,
  ProductConfig,
  ProductDashboardSummary,
  ProfitabilityTrendPoint,
  ProviderCategorySpendSummary,
  ProviderName,
  ProviderPricingRegistry,
  ProviderSpendSummary,
  RepositoryInventorySummary,
  RevenueEntry,
  SourceLedgerRow,
  UsageEntry,
} from './types.js'

export interface BuildFinopsDashboardOptions {
  company: CompanyConfig
  products: ProductConfig[]
  inventory: ApiKeyInventory
  costs: CostEntry[]
  revenue: RevenueEntry[]
  usage: UsageEntry[]
  pricing: ProviderPricingRegistry
  generatedAt?: string
}

export function buildFinopsDashboardData(options: BuildFinopsDashboardOptions): FinopsDashboardData {
  const summary = summarizeFinops(options.costs, options.revenue, { companyId: options.company.id })
  const allProductIds = uniqueStrings([
    ...options.products.map((product) => product.id),
    ...options.inventory.references.map((ref) => ref.productId),
    ...options.costs.map((cost) => cost.productId),
    ...options.revenue.map((entry) => entry.productId),
    ...options.usage.map((entry) => entry.productId),
  ])

  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    company: options.company,
    companySummary: summary.byCompany,
    products: allProductIds.map((productId) => productDashboard(productId, options, summary.byProduct)),
    profitabilityTrend: summarizeProfitabilityTrend(options.costs, options.revenue, options.company.baseCurrency ?? 'USD'),
    providerSpend: summarizeProviderSpend(options.costs),
    providerCategorySpend: summarizeProviderCategorySpend(options.costs),
    ledgerRows: buildLedgerRows(options.costs, options.revenue, options.usage),
    inventory: options.inventory,
    pricing: options.pricing,
  }
}

function productDashboard(
  productId: string,
  options: BuildFinopsDashboardOptions,
  summaries: AccountingSummary[],
): ProductDashboardSummary {
  const product = options.products.find((item) => item.id === productId)
  const costs = options.costs.filter((entry) => entry.productId === productId)
  const revenue = options.revenue.filter((entry) => entry.productId === productId)
  const usage = options.usage.filter((entry) => entry.productId === productId)
  const references = options.inventory.references.filter((ref) => ref.productId === productId)

  return {
    productId,
    name: product?.name ?? productId,
    description: product?.description,
    owner: product?.owner,
    lifecycle: product?.lifecycle,
    summary: summaries.find((item) => item.productId === productId) ?? emptySummary(options.company.id, productId, options.company.baseCurrency ?? 'USD'),
    profitabilityTrend: summarizeProfitabilityTrend(costs, revenue, options.company.baseCurrency ?? 'USD'),
    providerSpend: summarizeProviderSpend(costs),
    providerCategorySpend: summarizeProviderCategorySpend(costs),
    repositories: summarizeRepositories(references),
    costs,
    revenue,
    usage,
  }
}

function summarizeProviderSpend(costs: CostEntry[]): ProviderSpendSummary[] {
  const groups = new Map<string, ProviderSpendSummary>()
  for (const cost of costs) {
    const key = `${cost.provider}:${cost.currency}`
    const existing = groups.get(key) ?? { provider: cost.provider, currency: cost.currency, cost: 0 }
    existing.cost += cost.amount
    groups.set(key, existing)
  }

  return [...groups.values()]
    .map((item) => ({ ...item, cost: roundMoney(item.cost) }))
    .sort((a, b) => b.cost - a.cost || a.provider.localeCompare(b.provider))
}

function summarizeProviderCategorySpend(costs: CostEntry[]): ProviderCategorySpendSummary[] {
  const groups = new Map<string, ProviderCategorySpendSummary>()
  for (const cost of costs) {
    const category = cost.category ?? cost.lineItem ?? cost.usageMetric ?? 'unallocated'
    const key = `${cost.provider}:${category}:${cost.currency}`
    const existing = groups.get(key) ?? { provider: cost.provider, category, currency: cost.currency, cost: 0 }
    existing.cost += cost.amount
    groups.set(key, existing)
  }

  return [...groups.values()]
    .map((item) => ({ ...item, cost: roundMoney(item.cost) }))
    .sort((a, b) => b.cost - a.cost || a.provider.localeCompare(b.provider) || a.category.localeCompare(b.category))
}

function summarizeProfitabilityTrend(
  costs: CostEntry[],
  revenue: RevenueEntry[],
  defaultCurrency: string,
): ProfitabilityTrendPoint[] {
  const groups = new Map<string, ProfitabilityTrendPoint>()

  for (const entry of costs) {
    const period = entry.startTime.slice(0, 7)
    const group = ensureTrendGroup(groups, period, entry.currency || defaultCurrency)
    group.cost += entry.amount
  }

  for (const entry of revenue) {
    const period = entry.bookedAt.slice(0, 7)
    const group = ensureTrendGroup(groups, period, entry.currency || defaultCurrency)
    group.revenue += entry.amount
  }

  return [...groups.values()]
    .map((group) => finalizeTrendGroup(group))
    .sort((a, b) => a.period.localeCompare(b.period) || a.currency.localeCompare(b.currency))
}

function ensureTrendGroup(
  groups: Map<string, ProfitabilityTrendPoint>,
  period: string,
  currency: string,
): ProfitabilityTrendPoint {
  const key = `${period}:${currency}`
  const existing = groups.get(key)
  if (existing) return existing

  const created: ProfitabilityTrendPoint = {
    period,
    currency,
    revenue: 0,
    cost: 0,
    grossProfit: 0,
    roi: null,
    breakEven: false,
  }
  groups.set(key, created)
  return created
}

function finalizeTrendGroup(group: ProfitabilityTrendPoint): ProfitabilityTrendPoint {
  const revenue = roundMoney(group.revenue)
  const cost = roundMoney(group.cost)
  const grossProfit = roundMoney(revenue - cost)
  return {
    ...group,
    revenue,
    cost,
    grossProfit,
    roi: cost === 0 ? null : roundMoney(grossProfit / cost),
    breakEven: grossProfit >= 0,
  }
}

function summarizeRepositories(references: ProductDashboardSummary['repositories'][number]['references']): RepositoryInventorySummary[] {
  const groups = new Map<string, RepositoryInventorySummary>()
  for (const ref of references) {
    const existing = groups.get(ref.repo) ?? { repo: ref.repo, repoPath: ref.repoPath, references: [] }
    existing.references.push(ref)
    groups.set(ref.repo, existing)
  }

  return [...groups.values()]
    .map((repo) => ({
      ...repo,
      references: [...repo.references].sort((a, b) => a.envVar.localeCompare(b.envVar)),
    }))
    .sort((a, b) => a.repo.localeCompare(b.repo))
}

function buildLedgerRows(costs: CostEntry[], revenue: RevenueEntry[], usage: UsageEntry[]): SourceLedgerRow[] {
  const costRows = costs.map((entry): SourceLedgerRow => ({
    id: entry.id,
    kind: 'cost',
    provider: entry.provider,
    productId: entry.productId,
    amount: entry.amount,
    currency: entry.currency,
    metric: entry.usageMetric ?? entry.lineItem ?? undefined,
    source: entry.source,
    period: `${entry.startTime.slice(0, 10)} to ${entry.endTime.slice(0, 10)}`,
  }))
  const revenueRows = revenue.map((entry): SourceLedgerRow => ({
    id: entry.id,
    kind: 'revenue',
    provider: entry.provider,
    productId: entry.productId,
    amount: entry.amount,
    currency: entry.currency,
    metric: entry.reportingCategory ?? undefined,
    source: entry.source,
    period: entry.bookedAt.slice(0, 10),
  }))
  const usageRows = usage.map((entry): SourceLedgerRow => ({
    id: entry.id,
    kind: 'usage',
    provider: entry.provider,
    productId: entry.productId,
    metric: entry.metric,
    quantity: entry.quantity,
    unit: entry.unit,
    source: `${entry.provider}:organization-usage`,
    period: `${entry.startTime.slice(0, 10)} to ${entry.endTime.slice(0, 10)}`,
  }))

  return [...costRows, ...revenueRows, ...usageRows].sort((a, b) => a.productId.localeCompare(b.productId) || a.kind.localeCompare(b.kind))
}

function emptySummary(companyId: string, productId: string, currency: string): AccountingSummary {
  return {
    companyId,
    productId,
    currency,
    revenue: 0,
    cost: 0,
    grossProfit: 0,
    roi: null,
    breakEven: true,
  }
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items)].sort()
}
