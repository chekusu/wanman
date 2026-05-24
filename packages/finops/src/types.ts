export type ProviderName =
  | 'anthropic'
  | 'aws'
  | 'azure-openai'
  | 'cloudflare'
  | 'database'
  | 'discord'
  | 'github'
  | 'google'
  | 'line'
  | 'openai'
  | 'openai-compatible'
  | 'openrouter'
  | 'redis'
  | 'resend'
  | 'sendgrid'
  | 'sentry'
  | 'slack'
  | 'stripe'
  | 'supabase'
  | 'twilio'
  | 'vercel'
  | 'unknown'

export type InventoryEvidenceKind =
  | 'assignment'
  | 'base-url'
  | 'env-access'
  | 'github-secret'
  | 'identifier'
  | 'package-name'
  | 'sdk-import'

export interface ApiKeyProviderEvidence {
  kind: InventoryEvidenceKind
  sourceFile: string
  value: string
  provider?: ProviderName
}

export interface CompanyConfig {
  id: string
  name?: string
  baseCurrency?: string
}

export interface ProductConfig {
  id: string
  name?: string
  description?: string
  owner?: string
  lifecycle?: string
  companyId?: string
  repositories?: string[]
  repositoryGlobs?: string[]
  openaiProjectIds?: string[]
  stripeMetadata?: Record<string, string>
}

export interface FinopsConfig {
  company: CompanyConfig
  products?: ProductConfig[]
}

export interface ApiKeyReference {
  repo: string
  repoPath: string
  productId: string
  companyId: string
  envVar: string
  credentialProvider: ProviderName
  provider: ProviderName
  evidenceKinds: InventoryEvidenceKind[]
  sourceFiles: string[]
  providerEvidence: ApiKeyProviderEvidence[]
  secretIncluded: false
}

export interface ApiKeyInventory {
  generatedAt: string
  root: string
  companyId: string
  reposScanned: number
  references: ApiKeyReference[]
  byProduct: Record<string, ProductApiKeySummary>
  byCompany: Record<string, CompanyApiKeySummary>
}

export interface ProductApiKeySummary {
  productId: string
  repoCount: number
  keyCount: number
  providers: Record<string, number>
  envVars: string[]
}

export interface CompanyApiKeySummary {
  companyId: string
  productCount: number
  keyCount: number
  providers: Record<string, number>
}

export interface MoneyAmount {
  amount: number
  currency: string
}

export interface CostEntry {
  id: string
  provider: ProviderName
  companyId: string
  productId: string
  amount: number
  currency: string
  startTime: string
  endTime: string
  source: string
  category?: string | null
  usageMetric?: string
  providerProjectId?: string | null
  lineItem?: string | null
  raw?: Record<string, unknown>
}

export interface RevenueEntry {
  id: string
  provider: ProviderName
  companyId: string
  productId: string
  amount: number
  currency: string
  bookedAt: string
  source: string
  customerId?: string | null
  transactionId?: string
  reportingCategory?: string | null
  raw?: Record<string, unknown>
}

export interface UsageEntry {
  id: string
  provider: ProviderName
  companyId: string
  productId: string
  startTime: string
  endTime: string
  metric: string
  quantity: number
  unit: string
  providerProjectId?: string | null
  providerApiKeyId?: string | null
  model?: string | null
  raw?: Record<string, unknown>
}

export interface CostModel {
  id: string
  provider: ProviderName
  service: string
  metric: string
  unit: string
  unitPrice: number
  currency: string
  effectiveFrom?: string
  sourceUrl?: string
  notes?: string
}

export type PricingMethod =
  | 'billing-ledger'
  | 'manual-rate-card'
  | 'public-metadata-api'
  | 'public-rate-card'

export type PriceUpdateCadence =
  | 'daily'
  | 'manual'
  | 'monthly'
  | 'weekly'

export interface ProviderPricingEntry {
  id: string
  provider: ProviderName
  service: string
  sku: string
  metric: string
  unit: string
  unitPrice: number
  currency: string
  pricingMethod: PricingMethod
  sourceUrl: string
  effectiveDate: string
  updateCadence: PriceUpdateCadence
  sourceCheckedAt?: string
  notes?: string
}

export interface ProviderPricingSourceStatus {
  provider: ProviderName
  sourceUrl: string
  checkedAt: string
  ok: boolean
  message?: string
}

export interface ProviderPricingRegistry {
  generatedAt: string
  entries: ProviderPricingEntry[]
  sources: ProviderPricingSourceStatus[]
}

export interface FinopsSummary {
  generatedAt: string
  companyId: string
  byCompany: AccountingSummary[]
  byProduct: AccountingSummary[]
}

export interface AccountingSummary {
  companyId: string
  productId?: string
  currency: string
  revenue: number
  cost: number
  grossProfit: number
  roi: number | null
  breakEven: boolean
}

export interface ProviderSpendSummary {
  provider: ProviderName
  currency: string
  cost: number
}

export interface ProviderCategorySpendSummary extends ProviderSpendSummary {
  category: string
}

export interface ProfitabilityTrendPoint {
  period: string
  currency: string
  revenue: number
  cost: number
  grossProfit: number
  roi: number | null
  breakEven: boolean
}

export interface RepositoryInventorySummary {
  repo: string
  repoPath: string
  references: ApiKeyReference[]
}

export interface ProductDashboardSummary {
  productId: string
  name: string
  description?: string
  owner?: string
  lifecycle?: string
  summary: AccountingSummary
  profitabilityTrend: ProfitabilityTrendPoint[]
  providerSpend: ProviderSpendSummary[]
  providerCategorySpend: ProviderCategorySpendSummary[]
  repositories: RepositoryInventorySummary[]
  costs: CostEntry[]
  revenue: RevenueEntry[]
  usage: UsageEntry[]
}

export interface SourceLedgerRow {
  id: string
  kind: 'cost' | 'revenue' | 'usage'
  provider: ProviderName
  productId: string
  amount?: number
  currency?: string
  metric?: string
  quantity?: number
  unit?: string
  source: string
  period: string
}

export interface FinopsDashboardData {
  generatedAt: string
  company: CompanyConfig
  products: ProductDashboardSummary[]
  companySummary: AccountingSummary[]
  profitabilityTrend: ProfitabilityTrendPoint[]
  providerSpend: ProviderSpendSummary[]
  providerCategorySpend: ProviderCategorySpendSummary[]
  ledgerRows: SourceLedgerRow[]
  inventory: ApiKeyInventory
  pricing: ProviderPricingRegistry
}
