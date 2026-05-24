import { describe, expect, it } from 'vitest'
import { DEFAULT_PROVIDER_PRICING_REGISTRY, refreshProviderPricing } from '../pricing-registry.js'

describe('pricing registry', () => {
  it('keeps source metadata on curated provider rates', () => {
    expect(DEFAULT_PROVIDER_PRICING_REGISTRY.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'openai',
        pricingMethod: 'public-rate-card',
        unit: '1M tokens',
        currency: 'USD',
        sourceUrl: 'https://platform.openai.com/docs/pricing/',
        effectiveDate: '2026-05-24',
        updateCadence: 'weekly',
      }),
      expect.objectContaining({
        provider: 'openrouter',
        pricingMethod: 'public-metadata-api',
        unit: 'token',
        currency: 'USD',
        sourceUrl: 'https://openrouter.ai/api/v1/models',
        updateCadence: 'daily',
      }),
    ]))
  })

  it('refreshes OpenRouter public model prices without credentials', async () => {
    const refreshed = await refreshProviderPricing({
      now: new Date('2026-05-24T12:00:00.000Z'),
      fetchImpl: async (url) => {
        if (String(url).includes('openai.com')) {
          return new Response('ok', { status: 200 })
        }
        return new Response(JSON.stringify({
          data: [{
            id: 'openai/gpt-test',
            name: 'OpenAI: GPT Test',
            created: 1779614400,
            pricing: {
              prompt: '0.000001',
              completion: '0.000002',
              input_cache_read: '0.0000001',
            },
          }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    })

    expect(refreshed.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'openai', ok: true }),
      expect.objectContaining({ provider: 'openrouter', ok: true }),
    ]))
    expect(refreshed.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'openrouter:openai/gpt-test:prompt',
        provider: 'openrouter',
        sku: 'openai/gpt-test',
        metric: 'input_tokens',
        unit: 'token',
        unitPrice: 0.000001,
        sourceCheckedAt: '2026-05-24T12:00:00.000Z',
      }),
      expect.objectContaining({
        id: 'openrouter:openai/gpt-test:completion',
        metric: 'output_tokens',
        unitPrice: 0.000002,
      }),
    ]))
  })
})
