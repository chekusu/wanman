import type {
  PriceUpdateCadence,
  PricingMethod,
  ProviderName,
  ProviderPricingEntry,
  ProviderPricingRegistry,
  ProviderPricingSourceStatus,
} from './types.js'

export interface RefreshProviderPricingOptions {
  registry?: ProviderPricingRegistry
  includeOpenAi?: boolean
  includeOpenRouter?: boolean
  openRouterModelLimit?: number
  fetchImpl?: typeof fetch
  now?: Date
}

interface OpenRouterModelsResponse {
  data?: OpenRouterModel[]
}

interface OpenRouterModel {
  id?: string
  name?: string
  created?: number
  pricing?: Record<string, string | undefined>
}

const OPENAI_PRICING_URL = 'https://platform.openai.com/docs/pricing/'
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'

export const DEFAULT_PROVIDER_PRICING_REGISTRY: ProviderPricingRegistry = {
  generatedAt: '2026-05-24T00:00:00.000Z',
  sources: [
    sourceStatus('openai', OPENAI_PRICING_URL, true, 'Seeded from the public OpenAI API pricing page.'),
    sourceStatus('openrouter', OPENROUTER_MODELS_URL, true, 'Seeded from the public OpenRouter models metadata API.'),
    sourceStatus('stripe', 'https://docs.stripe.com/reports/balance-transaction-types', true, 'Stripe fees are synced from balance transaction ledger rows.'),
  ],
  entries: [
    openAiRate('openai:gpt-5.2:input', 'gpt-5.2', 'input_tokens', 1.75),
    openAiRate('openai:gpt-5.2:cached-input', 'gpt-5.2', 'cached_input_tokens', 0.175),
    openAiRate('openai:gpt-5.2:output', 'gpt-5.2', 'output_tokens', 14),
    openAiRate('openai:gpt-5-mini:input', 'gpt-5-mini', 'input_tokens', 0.25),
    openAiRate('openai:gpt-5-mini:output', 'gpt-5-mini', 'output_tokens', 2),
    openAiRate('openai:text-embedding-3-small:input', 'text-embedding-3-small', 'input_tokens', 0.02, 'embeddings'),
    openRouterRate('openrouter:openai/gpt-5.2-chat:prompt', 'openai/gpt-5.2-chat', 'input_tokens', 0.00000175, '2025-12-10'),
    openRouterRate('openrouter:openai/gpt-5.2-chat:completion', 'openai/gpt-5.2-chat', 'output_tokens', 0.000014, '2025-12-10'),
    openRouterRate('openrouter:openai/gpt-5.2-chat:cache-read', 'openai/gpt-5.2-chat', 'cached_input_tokens', 0.000000175, '2025-12-10'),
    {
      id: 'stripe:balance-transactions:fee-ledger',
      provider: 'stripe',
      service: 'balance-transactions',
      sku: 'stripe_fee',
      metric: 'fee',
      unit: 'ledger-row',
      unitPrice: 0,
      currency: 'USD',
      pricingMethod: 'billing-ledger',
      sourceUrl: 'https://docs.stripe.com/reports/balance-transaction-types',
      effectiveDate: '2026-05-24',
      updateCadence: 'daily',
      sourceCheckedAt: '2026-05-24T00:00:00.000Z',
      notes: 'Fees are read from Stripe balance transactions instead of estimated from a static rate card.',
    },
  ],
}

export async function refreshProviderPricing(
  options: RefreshProviderPricingOptions = {},
): Promise<ProviderPricingRegistry> {
  const now = options.now ?? new Date()
  const checkedAt = now.toISOString()
  const fetcher = options.fetchImpl ?? fetch
  const base = cloneRegistry(options.registry ?? DEFAULT_PROVIDER_PRICING_REGISTRY)
  const sources: ProviderPricingSourceStatus[] = []
  let entries = base.entries.map((entry) => ({ ...entry }))

  if (options.includeOpenAi !== false) {
    const status = await checkSource(fetcher, 'openai', OPENAI_PRICING_URL, checkedAt)
    sources.push(status)
    if (status.ok) {
      entries = entries.map((entry) => entry.provider === 'openai' ? { ...entry, sourceCheckedAt: checkedAt } : entry)
    }
  }

  if (options.includeOpenRouter !== false) {
    const refreshed = await fetchOpenRouterPricing(fetcher, checkedAt, options.openRouterModelLimit)
    sources.push(refreshed.status)
    if (refreshed.status.ok) {
      entries = [
        ...entries.filter((entry) => entry.provider !== 'openrouter'),
        ...refreshed.entries,
      ]
    }
  }

  return {
    generatedAt: checkedAt,
    sources: [...base.sources.filter((source) => !sources.some((item) => item.provider === source.provider)), ...sources],
    entries: sortPricingEntries(entries),
  }
}

function openAiRate(
  id: string,
  sku: string,
  metric: string,
  unitPrice: number,
  service = 'responses',
): ProviderPricingEntry {
  return {
    id,
    provider: 'openai',
    service,
    sku,
    metric,
    unit: '1M tokens',
    unitPrice,
    currency: 'USD',
    pricingMethod: 'public-rate-card',
    sourceUrl: OPENAI_PRICING_URL,
    effectiveDate: '2026-05-24',
    updateCadence: 'weekly',
    sourceCheckedAt: '2026-05-24T00:00:00.000Z',
  }
}

function openRouterRate(
  id: string,
  sku: string,
  metric: string,
  unitPrice: number,
  effectiveDate: string,
): ProviderPricingEntry {
  return {
    id,
    provider: 'openrouter',
    service: 'chat-completions',
    sku,
    metric,
    unit: 'token',
    unitPrice,
    currency: 'USD',
    pricingMethod: 'public-metadata-api',
    sourceUrl: OPENROUTER_MODELS_URL,
    effectiveDate,
    updateCadence: 'daily',
    sourceCheckedAt: '2026-05-24T00:00:00.000Z',
  }
}

async function fetchOpenRouterPricing(
  fetcher: typeof fetch,
  checkedAt: string,
  limit: number | undefined,
): Promise<{ entries: ProviderPricingEntry[], status: ProviderPricingSourceStatus }> {
  try {
    const response = await fetcher(OPENROUTER_MODELS_URL)
    if (!response.ok) {
      return {
        entries: [],
        status: sourceStatus('openrouter', OPENROUTER_MODELS_URL, false, `OpenRouter metadata returned HTTP ${response.status}.`, checkedAt),
      }
    }

    const parsed = await response.json() as OpenRouterModelsResponse
    const models = (parsed.data ?? []).filter((model) => model.id && model.pricing)
    const selected = typeof limit === 'number' ? models.slice(0, limit) : models
    const entries = selected.flatMap((model) => openRouterModelRates(model, checkedAt))
    return {
      entries,
      status: sourceStatus('openrouter', OPENROUTER_MODELS_URL, true, `Loaded ${entries.length} OpenRouter pricing rows from ${selected.length} models.`, checkedAt),
    }
  } catch (err) {
    return {
      entries: [],
      status: sourceStatus('openrouter', OPENROUTER_MODELS_URL, false, errorMessage(err), checkedAt),
    }
  }
}

function openRouterModelRates(model: OpenRouterModel, checkedAt: string): ProviderPricingEntry[] {
  const id = model.id
  if (!id || !model.pricing) return []

  const createdDate = typeof model.created === 'number'
    ? new Date(model.created * 1000).toISOString().slice(0, 10)
    : checkedAt.slice(0, 10)

  return Object.entries(model.pricing)
    .flatMap(([priceKey, rawPrice]) => {
      const metric = openRouterMetric(priceKey)
      if (!metric || rawPrice === undefined) return []
      const unitPrice = Number(rawPrice)
      if (!Number.isFinite(unitPrice)) return []
      return [{
        id: `openrouter:${id}:${priceKey}`,
        provider: 'openrouter' as ProviderName,
        service: 'chat-completions',
        sku: id,
        metric,
        unit: openRouterUnit(priceKey),
        unitPrice,
        currency: 'USD',
        pricingMethod: 'public-metadata-api' as PricingMethod,
        sourceUrl: OPENROUTER_MODELS_URL,
        effectiveDate: createdDate,
        updateCadence: 'daily' as PriceUpdateCadence,
        sourceCheckedAt: checkedAt,
        notes: model.name ? `OpenRouter model: ${model.name}` : undefined,
      }]
    })
}

async function checkSource(
  fetcher: typeof fetch,
  provider: ProviderName,
  sourceUrl: string,
  checkedAt: string,
): Promise<ProviderPricingSourceStatus> {
  try {
    const response = await fetcher(sourceUrl, { method: 'GET' })
    if (!response.ok) {
      return sourceStatus(provider, sourceUrl, false, `Source returned HTTP ${response.status}; retained existing registry rows.`, checkedAt)
    }
    return sourceStatus(provider, sourceUrl, true, 'Source reachable; retained curated public rate-card rows.', checkedAt)
  } catch (err) {
    return sourceStatus(provider, sourceUrl, false, `${errorMessage(err)}; retained existing registry rows.`, checkedAt)
  }
}

function openRouterMetric(priceKey: string): string | null {
  switch (priceKey) {
    case 'prompt':
      return 'input_tokens'
    case 'completion':
      return 'output_tokens'
    case 'input_cache_read':
      return 'cached_input_tokens'
    case 'input_cache_write':
      return 'cache_write_tokens'
    case 'request':
      return 'requests'
    case 'image':
      return 'images'
    case 'web_search':
      return 'web_search_calls'
    case 'audio':
      return 'audio_units'
    case 'internal_reasoning':
      return 'reasoning_tokens'
    default:
      return null
  }
}

function openRouterUnit(priceKey: string): string {
  if (priceKey === 'request' || priceKey === 'web_search') return 'request'
  if (priceKey === 'image') return 'image'
  if (priceKey === 'audio') return 'audio-unit'
  return 'token'
}

function sourceStatus(
  provider: ProviderName,
  sourceUrl: string,
  ok: boolean,
  message: string,
  checkedAt = '2026-05-24T00:00:00.000Z',
): ProviderPricingSourceStatus {
  return { provider, sourceUrl, checkedAt, ok, message }
}

function sortPricingEntries(entries: ProviderPricingEntry[]): ProviderPricingEntry[] {
  return [...entries].sort((a, b) => {
    const byProvider = a.provider.localeCompare(b.provider)
    if (byProvider) return byProvider
    const bySku = a.sku.localeCompare(b.sku)
    if (bySku) return bySku
    return a.metric.localeCompare(b.metric)
  })
}

function cloneRegistry(registry: ProviderPricingRegistry): ProviderPricingRegistry {
  return {
    generatedAt: registry.generatedAt,
    sources: registry.sources.map((source) => ({ ...source })),
    entries: registry.entries.map((entry) => ({ ...entry })),
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
