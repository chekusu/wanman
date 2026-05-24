import { describe, expect, it } from 'vitest'
import { buildFinopsDashboardData } from '../dashboard-model.js'
import { demoWorkspaceInput } from '../demo-data.js'

describe('dashboard model', () => {
  it('builds company, product, provider, ledger, inventory, and pricing views', () => {
    const dashboard = buildFinopsDashboardData(demoWorkspaceInput)

    expect(dashboard.companySummary[0]).toEqual(expect.objectContaining({
      companyId: 'chekusu',
      revenue: 5239,
      cost: 1497.06,
      grossProfit: 3741.94,
      breakEven: true,
    }))
    expect(dashboard.providerSpend).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'openai', cost: 697.22 }),
      expect.objectContaining({ provider: 'openrouter', cost: 271.54 }),
      expect.objectContaining({ provider: 'stripe', cost: 250.8 }),
    ]))
    expect(dashboard.profitabilityTrend).toHaveLength(5)
    expect(dashboard.profitabilityTrend.at(-1)).toEqual(expect.objectContaining({
      period: '2026-05',
      revenue: 1335,
      cost: 390.66,
      grossProfit: 944.34,
      breakEven: true,
    }))
    expect(dashboard.providerCategorySpend).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'openai', category: 'text-models', cost: 697.22 }),
      expect.objectContaining({ provider: 'database', category: 'transaction-storage', cost: 55.25 }),
    ]))
    expect(dashboard.products.every((product) => product.profitabilityTrend.length === 5)).toBe(true)
    expect(dashboard.products.every((product) => product.providerCategorySpend.length > 0)).toBe(true)
    expect(dashboard.products.find((product) => product.productId === 'agent-matrix')).toEqual(expect.objectContaining({
      name: 'Agent Matrix',
      owner: 'Platform AI',
      profitabilityTrend: expect.arrayContaining([
        expect.objectContaining({ period: '2026-05', revenue: 155, cost: 82.44 }),
      ]),
      providerCategorySpend: expect.arrayContaining([
        expect.objectContaining({ provider: 'openrouter', category: 'agent-inference' }),
      ]),
      repositories: expect.arrayContaining([
        expect.objectContaining({
          repo: 'chekusu/codeben',
          references: expect.arrayContaining([
            expect.objectContaining({ envVar: 'OPENAI_API_KEY', provider: 'openrouter', credentialProvider: 'openai' }),
          ]),
        }),
      ]),
    }))
    expect(dashboard.ledgerRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'cost', source: 'openai:organization-costs' }),
      expect.objectContaining({ kind: 'revenue', source: 'stripe:balance-transactions' }),
      expect.objectContaining({ kind: 'usage', source: 'openai:organization-usage' }),
    ]))
    expect(dashboard.pricing.entries.length).toBeGreaterThan(0)
    expect(JSON.stringify(dashboard)).not.toContain('sk-')
    expect(dashboard.inventory.references.every((ref) => ref.repoPath.startsWith('demo://'))).toBe(true)
  })
})
