import type { ProviderName } from './types.js'

const PROVIDER_RULES: Array<[ProviderName, RegExp]> = [
  ['openrouter', /OPENROUTER/],
  ['azure-openai', /AZURE_OPENAI/],
  ['openai', /(^|_)OPENAI_|AZURE_OPENAI|CHATGPT/],
  ['anthropic', /ANTHROPIC|CLAUDE/],
  ['stripe', /STRIPE/],
  ['github', /GITHUB|^GH_/],
  ['cloudflare', /CLOUDFLARE|^CF_|^R2_|WORKERS_|TURNSTILE/],
  ['supabase', /SUPABASE/],
  ['resend', /RESEND/],
  ['sendgrid', /SENDGRID/],
  ['aws', /^AWS_|^S3_|^SES_/],
  ['google', /GOOGLE|^GCP_|GEMINI|FIREBASE/],
  ['slack', /SLACK/],
  ['line', /^LINE_/],
  ['discord', /DISCORD/],
  ['database', /DATABASE|POSTGRES|POSTGRESQL|MYSQL|NEON|PRISMA/],
  ['redis', /REDIS|UPSTASH/],
  ['sentry', /SENTRY/],
  ['twilio', /TWILIO/],
  ['vercel', /VERCEL/],
]

export interface ProviderClassificationEvidence {
  provider?: ProviderName
  value: string
}

export function classifyProvider(envVar: string, evidence: ProviderClassificationEvidence[] = []): ProviderName {
  const nameProvider = classifyProviderByName(envVar)
  const hostProvider = strongestEvidenceProvider(evidence.filter((item) => item.value.startsWith('host:')))
  if (hostProvider && (nameProvider === 'unknown' || isOpenAiFamily(nameProvider))) return hostProvider

  const contextualEvidence = evidence.filter((item) => !item.value.startsWith('package:'))
  const evidenceProvider = strongestEvidenceProvider(contextualEvidence)
  if (evidenceProvider && (nameProvider === 'unknown' || isOpenAiFamily(nameProvider))) return evidenceProvider
  return nameProvider
}

export function classifyProviderByName(envVar: string): ProviderName {
  const normalized = envVar.toUpperCase()
  for (const [provider, pattern] of PROVIDER_RULES) {
    if (pattern.test(normalized)) return provider
  }
  return 'unknown'
}

export function providerFromHost(host: string): ProviderName | undefined {
  const normalized = host.toLowerCase()
  if (normalized === 'api.openai.com' || normalized.endsWith('.api.openai.com')) return 'openai'
  if (normalized === 'openrouter.ai' || normalized.endsWith('.openrouter.ai')) return 'openrouter'
  if (normalized.endsWith('.openai.azure.com')) return 'azure-openai'
  if (normalized.includes('openai') || normalized.includes('llm') || normalized.includes('ai-gateway')) {
    return 'openai-compatible'
  }
  return undefined
}

export function providerFromPackageName(packageName: string): ProviderName | undefined {
  const normalized = packageName.toLowerCase()
  if (normalized === 'openai' || normalized === '@ai-sdk/openai') return 'openai'
  if (normalized.includes('openrouter')) return 'openrouter'
  if (normalized.includes('anthropic')) return 'anthropic'
  if (normalized.includes('stripe')) return 'stripe'
  if (normalized.includes('resend')) return 'resend'
  if (normalized.includes('sendgrid')) return 'sendgrid'
  if (normalized.includes('sentry')) return 'sentry'
  if (normalized.includes('supabase')) return 'supabase'
  if (normalized.includes('twilio')) return 'twilio'
  return undefined
}

function strongestEvidenceProvider(evidence: ProviderClassificationEvidence[]): ProviderName | undefined {
  const providers = evidence.map((item) => item.provider).filter((item): item is ProviderName => Boolean(item))
  if (providers.includes('openrouter')) return 'openrouter'
  if (providers.includes('azure-openai')) return 'azure-openai'
  if (providers.includes('openai-compatible')) return 'openai-compatible'
  if (providers.includes('openai')) return 'openai'
  return providers[0]
}

function isOpenAiFamily(provider: ProviderName): boolean {
  return provider === 'openai' || provider === 'openrouter' || provider === 'azure-openai' || provider === 'openai-compatible'
}
