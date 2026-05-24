import { roundMoney } from './money.js'
import type { AccountingSummary, CostEntry, FinopsSummary, RevenueEntry } from './types.js'

export interface SummarizeFinopsOptions {
  companyId: string
}

export function summarizeFinops(
  costs: CostEntry[],
  revenue: RevenueEntry[],
  options: SummarizeFinopsOptions,
): FinopsSummary {
  return {
    generatedAt: new Date().toISOString(),
    companyId: options.companyId,
    byCompany: summarizeGroups(costs, revenue, ({ companyId, currency }) => `${companyId}:${currency}`),
    byProduct: summarizeGroups(costs, revenue, ({ companyId, productId, currency }) => `${companyId}:${productId}:${currency}`),
  }
}

interface GroupKeyParts {
  companyId: string
  productId?: string
  currency: string
}

interface MutableSummary extends AccountingSummary {
  revenue: number
  cost: number
}

function summarizeGroups(
  costs: CostEntry[],
  revenue: RevenueEntry[],
  keyFor: (parts: GroupKeyParts) => string,
): AccountingSummary[] {
  const groups = new Map<string, MutableSummary>()

  for (const entry of costs) {
    const key = keyFor(entry)
    const group = ensureGroup(groups, key, entry.companyId, entry.productId, entry.currency)
    group.cost += entry.amount
  }

  for (const entry of revenue) {
    const key = keyFor(entry)
    const group = ensureGroup(groups, key, entry.companyId, entry.productId, entry.currency)
    group.revenue += entry.amount
  }

  return [...groups.values()]
    .map((group) => finalizeGroup(group))
    .sort((a, b) => {
      const byCompany = a.companyId.localeCompare(b.companyId)
      if (byCompany) return byCompany
      const byProduct = (a.productId ?? '').localeCompare(b.productId ?? '')
      if (byProduct) return byProduct
      return a.currency.localeCompare(b.currency)
    })
}

function ensureGroup(
  groups: Map<string, MutableSummary>,
  key: string,
  companyId: string,
  productId: string | undefined,
  currency: string,
): MutableSummary {
  const existing = groups.get(key)
  if (existing) return existing

  const created: MutableSummary = {
    companyId,
    productId,
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

function finalizeGroup(group: MutableSummary): AccountingSummary {
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
