import { buildFinopsDashboardData, type BuildFinopsDashboardOptions } from './dashboard-model.js'
import { DEFAULT_PROVIDER_PRICING_REGISTRY } from './pricing-registry.js'
import type {
  ApiKeyInventory,
  CompanyConfig,
  CostEntry,
  FinopsDashboardData,
  ProductConfig,
  ProviderPricingRegistry,
  RevenueEntry,
  UsageEntry,
} from './types.js'

export interface FinopsRuntimeDataFile {
  schemaVersion: 1
  dataSource: {
    mode: 'demo' | 'real'
    generatedAt: string
    inventoryRoot: string
    reposScanned: number
    credentialReferences: number
    costRows: number
    revenueRows: number
    usageRows: number
    secretValuesIncluded: false
    warnings: string[]
  }
  dashboard: FinopsDashboardData
}

export interface BuildRuntimeDashboardOptions {
  company: CompanyConfig
  inventory: ApiKeyInventory
  products?: ProductConfig[]
  costs?: CostEntry[]
  revenue?: RevenueEntry[]
  usage?: UsageEntry[]
  pricing?: ProviderPricingRegistry
  generatedAt?: string
  warnings?: string[]
}

export function buildRuntimeDashboardFile(options: BuildRuntimeDashboardOptions): FinopsRuntimeDataFile {
  const generatedAt = options.generatedAt ?? new Date().toISOString()
  const costs = options.costs ?? []
  const revenue = options.revenue ?? []
  const usage = options.usage ?? []
  const inventory = sanitizeInventoryForRuntime(options.inventory)
  const input: BuildFinopsDashboardOptions = {
    company: options.company,
    products: options.products ?? productsFromInventory(inventory),
    inventory,
    costs,
    revenue,
    usage,
    pricing: options.pricing ?? DEFAULT_PROVIDER_PRICING_REGISTRY,
    generatedAt,
  }

  return {
    schemaVersion: 1,
    dataSource: {
      mode: 'real',
      generatedAt,
      inventoryRoot: inventory.root,
      reposScanned: inventory.reposScanned,
      credentialReferences: inventory.references.length,
      costRows: costs.length,
      revenueRows: revenue.length,
      usageRows: usage.length,
      secretValuesIncluded: false,
      warnings: options.warnings ?? [],
    },
    dashboard: buildFinopsDashboardData(input),
  }
}

function sanitizeInventoryForRuntime(inventory: ApiKeyInventory): ApiKeyInventory {
  return {
    ...inventory,
    root: `private://${inventory.companyId}`,
    repositories: inventory.repositories.map((repo) => ({
      ...repo,
      repoPath: `private://${repo.repo}`,
    })),
    references: inventory.references.map((ref) => ({
      ...ref,
      repoPath: `private://${ref.repo}`,
    })),
  }
}

export function productsFromInventory(inventory: ApiKeyInventory): ProductConfig[] {
  const products = new Map<string, ProductConfig & { repositories: string[] }>()
  for (const repo of inventory.repositories) {
    const existing = products.get(repo.productId) ?? {
      id: repo.productId,
      name: productName(repo.productId),
      description: `Private repository inventory for ${repo.repo}.`,
      owner: 'Chekusu',
      lifecycle: repo.keyCount > 0 ? 'Needs usage sync' : 'No key refs',
      companyId: repo.companyId,
      repositories: [],
    }
    addUnique(existing.repositories, repo.repo)
    products.set(repo.productId, existing)
  }

  for (const ref of inventory.references) {
    const existing = products.get(ref.productId) ?? {
      id: ref.productId,
      name: productName(ref.productId),
      description: `Private repository inventory for ${ref.repo}.`,
      owner: 'Chekusu',
      lifecycle: 'Needs usage sync',
      companyId: ref.companyId,
      repositories: [],
    }
    addUnique(existing.repositories, ref.repo)
    products.set(ref.productId, existing)
  }

  return [...products.values()].sort((a, b) => a.name?.localeCompare(b.name ?? '') ?? a.id.localeCompare(b.id))
}

function productName(id: string): string {
  return id
    .replace(/^chekusu\//, '')
    .split(/[-_.]/)
    .filter(Boolean)
    .map((part) => part === 'ai' ? 'AI' : `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ')
}

function addUnique(items: string[], item: string): void {
  if (!items.includes(item)) items.push(item)
}
