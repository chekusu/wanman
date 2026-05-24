import { describe, expect, it } from 'vitest'
import { summarizeFinops } from '../ledger.js'
import type { CostEntry, RevenueEntry } from '../types.js'

describe('summarizeFinops', () => {
  it('summarizes revenue, costs, break-even, and roi by company and product', () => {
    const costs: CostEntry[] = [
      cost({ productId: 'alpha', amount: 30 }),
      cost({ productId: 'beta', amount: 10 }),
    ]
    const revenue: RevenueEntry[] = [
      revenueEntry({ productId: 'alpha', amount: 100 }),
      revenueEntry({ productId: 'beta', amount: 5 }),
    ]

    const summary = summarizeFinops(costs, revenue, { companyId: 'jpco' })

    expect(summary.byCompany).toEqual([expect.objectContaining({
      companyId: 'jpco',
      currency: 'usd',
      revenue: 105,
      cost: 40,
      grossProfit: 65,
      roi: 1.625,
      breakEven: true,
    })])
    expect(summary.byProduct).toEqual(expect.arrayContaining([
      expect.objectContaining({ productId: 'alpha', grossProfit: 70, breakEven: true }),
      expect.objectContaining({ productId: 'beta', grossProfit: -5, breakEven: false }),
    ]))
  })
})

function cost(overrides: Partial<CostEntry>): CostEntry {
  return {
    id: 'c',
    provider: 'openai',
    companyId: 'jpco',
    productId: 'alpha',
    amount: 1,
    currency: 'usd',
    startTime: '2026-05-01T00:00:00.000Z',
    endTime: '2026-05-02T00:00:00.000Z',
    source: 'test',
    ...overrides,
  }
}

function revenueEntry(overrides: Partial<RevenueEntry>): RevenueEntry {
  return {
    id: 'r',
    provider: 'stripe',
    companyId: 'jpco',
    productId: 'alpha',
    amount: 1,
    currency: 'usd',
    bookedAt: '2026-05-01T00:00:00.000Z',
    source: 'test',
    ...overrides,
  }
}
