import { describe, expect, it } from 'vitest'
import { fetchOpenAiCostEntries, fetchOpenAiUsageEntries } from '../providers/openai.js'
import { fetchStripeLedgerEntries } from '../providers/stripe.js'

describe('provider adapters', () => {
  it('maps OpenAI organization costs to cost entries', async () => {
    const entries = await fetchOpenAiCostEntries({
      adminKey: 'test-admin-key',
      companyId: 'jpco',
      projectToProduct: { proj_123: 'alpha' },
      startTime: 1730419200,
      fetchImpl: async (url) => {
        expect(String(url)).toContain('/v1/organization/costs')
        return jsonResponse({
          data: [{
            start_time: 1730419200,
            end_time: 1730505600,
            results: [{
              amount: { value: 0.42, currency: 'usd' },
              project_id: 'proj_123',
              line_item: 'Text models',
            }],
          }],
          has_more: false,
        })
      },
    })

    expect(entries).toEqual([expect.objectContaining({
      provider: 'openai',
      companyId: 'jpco',
      productId: 'alpha',
      amount: 0.42,
      currency: 'usd',
      providerProjectId: 'proj_123',
      lineItem: 'Text models',
    })])
  })

  it('maps OpenAI usage buckets to usage entries', async () => {
    const entries = await fetchOpenAiUsageEntries({
      adminKey: 'test-admin-key',
      service: 'completions',
      companyId: 'jpco',
      productIdForUnmapped: 'unknown',
      startTime: 1730419200,
      fetchImpl: async () => jsonResponse({
        data: [{
          start_time: 1730419200,
          end_time: 1730505600,
          results: [{
            project_id: null,
            api_key_id: 'key_123',
            model: 'gpt-test',
            input_tokens: 10,
            output_tokens: 5,
          }],
        }],
        has_more: false,
      }),
    })

    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: 'input_tokens', quantity: 10, providerApiKeyId: 'key_123' }),
      expect.objectContaining({ metric: 'output_tokens', quantity: 5, model: 'gpt-test' }),
    ]))
  })

  it('maps Stripe balance transactions to gross revenue and fee costs', async () => {
    const entries = await fetchStripeLedgerEntries({
      secretKey: 'test-stripe-key',
      companyId: 'jpco',
      productIdForUnmapped: 'fallback',
      startTime: 1730419200,
      fetchImpl: async (url) => {
        expect(String(url)).toContain('/v1/balance_transactions')
        return jsonResponse({
          data: [{
            id: 'txn_123',
            amount: 1000,
            fee: 59,
            created: 1730419200,
            currency: 'jpy',
            reporting_category: 'charge',
            type: 'charge',
            source: {
              id: 'ch_123',
              customer: 'cus_123',
              metadata: { product_id: 'alpha' },
            },
          }],
          has_more: false,
        })
      },
    })

    expect(entries.revenue).toEqual([expect.objectContaining({
      productId: 'alpha',
      amount: 1000,
      currency: 'jpy',
      customerId: 'cus_123',
    })])
    expect(entries.costs).toEqual([expect.objectContaining({
      productId: 'alpha',
      amount: 59,
      lineItem: 'stripe_fee',
    })])
  })
})

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
