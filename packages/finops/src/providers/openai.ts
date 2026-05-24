import type { CostEntry, ProviderName, UsageEntry } from '../types.js'

export type OpenAiUsageService =
  | 'audio_speeches'
  | 'audio_transcriptions'
  | 'code_interpreter_sessions'
  | 'completions'
  | 'embeddings'
  | 'images'
  | 'moderations'
  | 'vector_stores'

export interface OpenAiSyncOptions {
  adminKey?: string
  credentialEnv?: string
  companyId: string
  productIdForUnmapped?: string
  projectToProduct?: Record<string, string>
  startTime: Date | number
  endTime?: Date | number
  limit?: number
  fetchImpl?: typeof fetch
}

export interface OpenAiUsageSyncOptions extends OpenAiSyncOptions {
  service: OpenAiUsageService
  groupBy?: string[]
}

interface OpenAiPage {
  data?: OpenAiBucket[]
  has_more?: boolean
  next_page?: string | null
}

interface OpenAiBucket {
  start_time?: number
  end_time?: number
  results?: Array<Record<string, unknown>>
}

const PROVIDER: ProviderName = 'openai'
const OPENAI_API_BASE = 'https://api.openai.com/v1'

export async function fetchOpenAiCostEntries(options: OpenAiSyncOptions): Promise<CostEntry[]> {
  const adminKey = resolveAdminKey(options)
  const entries: CostEntry[] = []

  for await (const page of paginateOpenAi('/organization/costs', {
    ...options,
    adminKey,
    groupBy: ['project_id', 'line_item'],
  })) {
    for (const bucket of page.data ?? []) {
      for (const result of bucket.results ?? []) {
        const amount = asObject(result['amount'])
        const value = asNumber(amount?.['value'])
        const currency = asString(amount?.['currency'])
        if (value === null || !currency) continue

        const projectId = asString(result['project_id'])
        const lineItem = asString(result['line_item'])
        const startTime = unixToIso(bucket.start_time)
        const endTime = unixToIso(bucket.end_time)
        entries.push({
          id: `openai-cost:${bucket.start_time ?? 'unknown'}:${projectId ?? 'org'}:${lineItem ?? 'total'}`,
          provider: PROVIDER,
          companyId: options.companyId,
          productId: resolveProductId(projectId, options),
          amount: value,
          currency,
          startTime,
          endTime,
          source: 'openai:organization-costs',
          providerProjectId: projectId,
          lineItem,
          raw: {
            object: result['object'],
          },
        })
      }
    }
  }

  return entries
}

export async function fetchOpenAiUsageEntries(options: OpenAiUsageSyncOptions): Promise<UsageEntry[]> {
  const adminKey = resolveAdminKey(options)
  const entries: UsageEntry[] = []
  const groupBy = options.groupBy ?? ['project_id', 'api_key_id', 'model']

  for await (const page of paginateOpenAi(`/organization/usage/${options.service}`, {
    ...options,
    adminKey,
    groupBy,
  })) {
    for (const bucket of page.data ?? []) {
      for (const result of bucket.results ?? []) {
        const projectId = asString(result['project_id'])
        const apiKeyId = asString(result['api_key_id'])
        const model = asString(result['model'])

        for (const [metric, quantity] of numericMetrics(result)) {
          entries.push({
            id: `openai-usage:${options.service}:${bucket.start_time ?? 'unknown'}:${projectId ?? 'org'}:${apiKeyId ?? 'all'}:${model ?? 'all'}:${metric}`,
            provider: PROVIDER,
            companyId: options.companyId,
            productId: resolveProductId(projectId, options),
            startTime: unixToIso(bucket.start_time),
            endTime: unixToIso(bucket.end_time),
            metric,
            quantity,
            unit: metric.includes('bytes') ? 'byte' : 'count',
            providerProjectId: projectId,
            providerApiKeyId: apiKeyId,
            model,
            raw: {
              service: options.service,
              object: result['object'],
            },
          })
        }
      }
    }
  }

  return entries
}

async function* paginateOpenAi(
  endpoint: string,
  options: OpenAiSyncOptions & { adminKey: string, groupBy?: string[] },
): AsyncGenerator<OpenAiPage> {
  const fetcher = options.fetchImpl ?? fetch
  let page: string | undefined

  do {
    const url = new URL(`${OPENAI_API_BASE}${endpoint}`)
    url.searchParams.set('start_time', String(toUnixSeconds(options.startTime)))
    if (options.endTime !== undefined) {
      url.searchParams.set('end_time', String(toUnixSeconds(options.endTime)))
    }
    url.searchParams.set('limit', String(options.limit ?? 180))
    for (const field of options.groupBy ?? []) {
      url.searchParams.append('group_by[]', field)
    }
    if (page) url.searchParams.set('page', page)

    const response = await fetcher(url, {
      headers: {
        Authorization: `Bearer ${options.adminKey}`,
        'Content-Type': 'application/json',
      },
    })
    if (!response.ok) {
      throw new Error(`OpenAI request failed with HTTP ${response.status}`)
    }

    const parsed = await response.json() as OpenAiPage
    yield parsed
    page = parsed.next_page ?? undefined
    if (!parsed.has_more) page = undefined
  } while (page)
}

function resolveAdminKey(options: OpenAiSyncOptions): string {
  const credentialEnv = options.credentialEnv ?? 'OPENAI_ADMIN_KEY'
  const adminKey = options.adminKey ?? process.env[credentialEnv]
  if (!adminKey) {
    throw new Error(`Missing OpenAI admin key. Set ${credentialEnv}; the key is read only from process env and is never written to output.`)
  }
  return adminKey
}

function resolveProductId(projectId: string | null, options: OpenAiSyncOptions): string {
  if (projectId && options.projectToProduct?.[projectId]) {
    return options.projectToProduct[projectId]
  }
  return options.productIdForUnmapped ?? 'unmapped-openai'
}

function numericMetrics(result: Record<string, unknown>): Array<[string, number]> {
  const ignored = new Set(['start_time', 'end_time'])
  return Object.entries(result)
    .filter(([key, value]) => !ignored.has(key) && typeof value === 'number' && Number.isFinite(value))
    .map(([key, value]) => [key, value as number])
}

function toUnixSeconds(value: Date | number): number {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000)
  return value
}

function unixToIso(value: number | undefined): string {
  if (value === undefined) return new Date(0).toISOString()
  return new Date(value * 1000).toISOString()
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
