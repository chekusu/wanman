import { roundMoney } from './money.js'
import type { CostEntry, CostModel, UsageEntry } from './types.js'

export interface EstimateCostOptions {
  companyId: string
  source?: string
}

export function estimateCostsFromUsage(
  usage: UsageEntry[],
  models: CostModel[],
  options: EstimateCostOptions,
): CostEntry[] {
  const modelsByKey = new Map(models.map((model) => [costModelKey(model.provider, model.metric, model.unit), model]))
  const costs: CostEntry[] = []

  for (const item of usage) {
    const model = modelsByKey.get(costModelKey(item.provider, item.metric, item.unit))
    if (!model) continue

    costs.push({
      id: `estimated:${item.id}:${model.id}`,
      provider: item.provider,
      companyId: item.companyId || options.companyId,
      productId: item.productId,
      amount: roundMoney(item.quantity * model.unitPrice),
      currency: model.currency,
      startTime: item.startTime,
      endTime: item.endTime,
      source: options.source ?? `cost-model:${model.id}`,
      category: model.service,
      usageMetric: item.metric,
      providerProjectId: item.providerProjectId,
      lineItem: model.service,
      raw: {
        usageEntryId: item.id,
        costModelId: model.id,
      },
    })
  }

  return costs
}

function costModelKey(provider: string, metric: string, unit: string): string {
  return `${provider}:${metric}:${unit}`.toLowerCase()
}
