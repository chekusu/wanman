import { fromMinorUnits } from '../money.js'
import type { CostEntry, ProviderName, RevenueEntry } from '../types.js'

export interface StripeSyncOptions {
  secretKey?: string
  credentialEnv?: string
  companyId: string
  productIdForUnmapped?: string
  metadataProductKeys?: string[]
  startTime: Date | number
  endTime?: Date | number
  limit?: number
  fetchImpl?: typeof fetch
}

export interface StripeLedgerEntries {
  revenue: RevenueEntry[]
  costs: CostEntry[]
}

interface StripeListPage {
  data?: StripeBalanceTransaction[]
  has_more?: boolean
}

interface StripeBalanceTransaction {
  id: string
  amount?: number
  created?: number
  currency?: string
  fee?: number
  net?: number
  reporting_category?: string | null
  source?: string | Record<string, unknown> | null
  type?: string | null
}

const PROVIDER: ProviderName = 'stripe'
const STRIPE_API_BASE = 'https://api.stripe.com/v1'
const REVENUE_CATEGORIES = new Set([
  'application_fee',
  'application_fee_refund',
  'charge',
  'payment',
  'payment_refund',
  'refund',
])

export async function fetchStripeLedgerEntries(options: StripeSyncOptions): Promise<StripeLedgerEntries> {
  const secretKey = resolveSecretKey(options)
  const revenue: RevenueEntry[] = []
  const costs: CostEntry[] = []

  for await (const page of paginateStripeBalanceTransactions({ ...options, secretKey })) {
    for (const tx of page.data ?? []) {
      const category = tx.reporting_category ?? tx.type ?? null
      const currency = tx.currency
      if (!currency || tx.created === undefined) continue

      const productId = resolveProductId(tx.source, options)
      const bookedAt = new Date(tx.created * 1000).toISOString()
      const sourceId = sourceIdentifier(tx.source)

      if (category && REVENUE_CATEGORIES.has(category) && typeof tx.amount === 'number') {
        revenue.push({
          id: `stripe-revenue:${tx.id}`,
          provider: PROVIDER,
          companyId: options.companyId,
          productId,
          amount: fromMinorUnits(tx.amount, currency),
          currency,
          bookedAt,
          source: 'stripe:balance-transactions',
          transactionId: tx.id,
          customerId: sourceCustomerId(tx.source),
          reportingCategory: category,
          raw: {
            source: sourceId,
            type: tx.type,
          },
        })
      }

      if (typeof tx.fee === 'number' && tx.fee > 0) {
        costs.push({
          id: `stripe-fee:${tx.id}`,
          provider: PROVIDER,
          companyId: options.companyId,
          productId,
          amount: fromMinorUnits(tx.fee, currency),
          currency,
          startTime: bookedAt,
          endTime: bookedAt,
          source: 'stripe:balance-transactions',
          usageMetric: 'fee',
          lineItem: 'stripe_fee',
          raw: {
            source: sourceId,
            type: tx.type,
          },
        })
      }
    }
  }

  return { revenue, costs }
}

async function* paginateStripeBalanceTransactions(
  options: StripeSyncOptions & { secretKey: string },
): AsyncGenerator<StripeListPage> {
  const fetcher = options.fetchImpl ?? fetch
  let startingAfter: string | undefined

  do {
    const url = new URL(`${STRIPE_API_BASE}/balance_transactions`)
    url.searchParams.set('limit', String(options.limit ?? 100))
    url.searchParams.set('created[gte]', String(toUnixSeconds(options.startTime)))
    if (options.endTime !== undefined) {
      url.searchParams.set('created[lt]', String(toUnixSeconds(options.endTime)))
    }
    url.searchParams.append('expand[]', 'data.source')
    if (startingAfter) url.searchParams.set('starting_after', startingAfter)

    const response = await fetcher(url, {
      headers: {
        Authorization: `Bearer ${options.secretKey}`,
      },
    })
    if (!response.ok) {
      throw new Error(`Stripe balance transaction request failed with HTTP ${response.status}`)
    }

    const parsed = await response.json() as StripeListPage
    yield parsed
    const data = parsed.data ?? []
    const last = data.at(-1)
    startingAfter = parsed.has_more && last ? last.id : undefined
  } while (startingAfter)
}

function resolveSecretKey(options: StripeSyncOptions): string {
  const credentialEnv = options.credentialEnv ?? 'STRIPE_SECRET_KEY'
  const secretKey = options.secretKey ?? process.env[credentialEnv]
  if (!secretKey) {
    throw new Error(`Missing Stripe secret key. Set ${credentialEnv}; the key is read only from process env and is never written to output.`)
  }
  return secretKey
}

function resolveProductId(source: StripeBalanceTransaction['source'], options: StripeSyncOptions): string {
  const metadata = sourceMetadata(source)
  const keys = options.metadataProductKeys ?? ['product_id', 'productId', 'product', 'repo', 'app']
  for (const key of keys) {
    const value = metadata?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return options.productIdForUnmapped ?? 'unmapped-stripe'
}

function sourceMetadata(source: StripeBalanceTransaction['source']): Record<string, unknown> | null {
  const object = asObject(source)
  return asObject(object?.['metadata'])
}

function sourceIdentifier(source: StripeBalanceTransaction['source']): string | null {
  if (typeof source === 'string') return source
  const object = asObject(source)
  return typeof object?.['id'] === 'string' ? object['id'] : null
}

function sourceCustomerId(source: StripeBalanceTransaction['source']): string | null {
  const object = asObject(source)
  const customer = object?.['customer']
  if (typeof customer === 'string') return customer
  const customerObject = asObject(customer)
  return typeof customerObject?.['id'] === 'string' ? customerObject['id'] : null
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

function toUnixSeconds(value: Date | number): number {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000)
  return value
}
