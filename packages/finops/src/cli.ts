import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  fetchOpenAiCostEntries,
  fetchOpenAiUsageEntries,
  fetchStripeLedgerEntries,
  refreshProviderPricing,
  buildRuntimeDashboardFile,
  scanApiKeyInventory,
  summarizeFinops,
  writeInventoryFile,
} from './index.js'
import type { ApiKeyInventory, CostEntry, FinopsConfig, ProviderPricingRegistry, RevenueEntry, UsageEntry } from './types.js'

export const HELP = `wanman-finops - cost, revenue, and API-key inventory tools

Usage:
  wanman-finops inventory --root <path> [--company <id>] [--config <file>] [--out <file>] [--json] [--include-local-env]
  wanman-finops openai-costs --start <yyyy-mm-dd> [--end <yyyy-mm-dd>] [--company <id>] [--out <file>]
  wanman-finops openai-usage --service <name> --start <yyyy-mm-dd> [--end <yyyy-mm-dd>] [--company <id>] [--out <file>]
  wanman-finops stripe-ledger --start <yyyy-mm-dd> [--end <yyyy-mm-dd>] [--company <id>] [--out <file>]
  wanman-finops refresh-prices [--out <file>] [--limit <n>] [--no-openai] [--no-openrouter]
  wanman-finops roi --costs <file[,file]> --revenue <file[,file]> [--company <id>] [--out <file>]
  wanman-finops dashboard --inventory <file> [--costs <file[,file]>] [--revenue <file[,file]>] [--usage <file[,file]>] [--pricing <file>] [--company <id>] [--company-name <name>] [--out <file>]

Credential env vars:
  OPENAI_ADMIN_KEY    Used only by openai-costs/openai-usage.
  STRIPE_SECRET_KEY   Used only by stripe-ledger.
`

export async function run(command: string | undefined, args: string[]): Promise<void> {
  switch (command) {
    case 'inventory':
      await inventoryCommand(args)
      break
    case 'openai-costs':
      await openAiCostsCommand(args)
      break
    case 'openai-usage':
      await openAiUsageCommand(args)
      break
    case 'stripe-ledger':
      await stripeLedgerCommand(args)
      break
    case 'refresh-prices':
      await refreshPricesCommand(args)
      break
    case 'roi':
      await roiCommand(args)
      break
    case 'dashboard':
      await dashboardCommand(args)
      break
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      console.log(HELP)
      break
    default:
      throw new Error(`Unknown command: ${command}\n${HELP}`)
  }
}

async function inventoryCommand(args: string[]): Promise<void> {
  const config = await readOptionalConfig(flag(args, '--config'))
  const root = flag(args, '--root') ?? args.find((arg) => !arg.startsWith('-')) ?? process.cwd()
  const inventory = await scanApiKeyInventory({
    root,
    companyId: flag(args, '--company') ?? config?.company.id,
    config,
    includeLocalEnvFiles: hasFlag(args, '--include-local-env'),
  })

  const out = flag(args, '--out')
  if (out) {
    await writeInventoryFile(inventory, path.resolve(out))
  }

  if (hasFlag(args, '--json') || !out) {
    console.log(JSON.stringify(inventory, null, 2))
    return
  }

  console.log(`Scanned ${inventory.reposScanned} repos; found ${inventory.references.length} credential references. Wrote ${out}.`)
}

async function openAiCostsCommand(args: string[]): Promise<void> {
  const entries = await fetchOpenAiCostEntries({
    companyId: flag(args, '--company') ?? 'default',
    credentialEnv: flag(args, '--credential-env') ?? undefined,
    productIdForUnmapped: flag(args, '--product') ?? undefined,
    projectToProduct: keyValueFlags(args, '--project-product'),
    startTime: parseDateFlag(args, '--start'),
    endTime: optionalDateFlag(args, '--end'),
  })
  await writeOrPrint(entries, flag(args, '--out'))
}

async function openAiUsageCommand(args: string[]): Promise<void> {
  const service = flag(args, '--service')
  if (!service) throw new Error('Missing --service')

  const entries = await fetchOpenAiUsageEntries({
    service: service as never,
    companyId: flag(args, '--company') ?? 'default',
    credentialEnv: flag(args, '--credential-env') ?? undefined,
    productIdForUnmapped: flag(args, '--product') ?? undefined,
    projectToProduct: keyValueFlags(args, '--project-product'),
    startTime: parseDateFlag(args, '--start'),
    endTime: optionalDateFlag(args, '--end'),
  })
  await writeOrPrint(entries, flag(args, '--out'))
}

async function stripeLedgerCommand(args: string[]): Promise<void> {
  const entries = await fetchStripeLedgerEntries({
    companyId: flag(args, '--company') ?? 'default',
    credentialEnv: flag(args, '--credential-env') ?? undefined,
    productIdForUnmapped: flag(args, '--product') ?? undefined,
    startTime: parseDateFlag(args, '--start'),
    endTime: optionalDateFlag(args, '--end'),
  })
  await writeOrPrint(entries, flag(args, '--out'))
}

async function refreshPricesCommand(args: string[]): Promise<void> {
  const registry = await refreshProviderPricing({
    includeOpenAi: !hasFlag(args, '--no-openai'),
    includeOpenRouter: !hasFlag(args, '--no-openrouter'),
    openRouterModelLimit: optionalIntegerFlag(args, '--limit'),
  })
  await writeOrPrint(registry, flag(args, '--out'))
}

async function roiCommand(args: string[]): Promise<void> {
  const costs = await readCostEntries(flag(args, '--costs'))
  const revenue = await readRevenueEntries(flag(args, '--revenue'))
  const summary = summarizeFinops(costs, revenue, {
    companyId: flag(args, '--company') ?? 'default',
  })
  await writeOrPrint(summary, flag(args, '--out'))
}

async function dashboardCommand(args: string[]): Promise<void> {
  const inventoryPath = flag(args, '--inventory')
  if (!inventoryPath) throw new Error('Missing --inventory')

  const inventory = await readJsonFile<ApiKeyInventory>(inventoryPath)
  const costs = flag(args, '--costs') ? await readCostEntries(flag(args, '--costs')) : []
  const revenue = flag(args, '--revenue') ? await readRevenueEntries(flag(args, '--revenue')) : []
  const usage = flag(args, '--usage') ? await readUsageEntries(flag(args, '--usage')) : []
  const pricing = flag(args, '--pricing') ? await readJsonFile<ProviderPricingRegistry>(flag(args, '--pricing')!) : undefined
  const warnings: string[] = []
  if (!costs.length) warnings.push('No provider cost rows were loaded. Configure provider admin/master credentials to sync billable usage.')
  if (!revenue.length) warnings.push('No revenue rows were loaded. Configure Stripe or another revenue ledger to calculate ROI.')

  const dashboard = buildRuntimeDashboardFile({
    company: {
      id: flag(args, '--company') ?? inventory.companyId,
      name: flag(args, '--company-name') ?? 'Chekusu',
      baseCurrency: flag(args, '--base-currency') ?? 'USD',
    },
    inventory,
    costs,
    revenue,
    usage,
    pricing,
    warnings,
  })

  await writeOrPrint(dashboard, flag(args, '--out'))
}

async function readOptionalConfig(configPath: string | undefined): Promise<FinopsConfig | undefined> {
  if (!configPath) return undefined
  const content = await fs.readFile(configPath, 'utf8')
  return JSON.parse(content) as FinopsConfig
}

async function writeOrPrint(value: unknown, outPath: string | undefined): Promise<void> {
  const json = `${JSON.stringify(value, null, 2)}\n`
  if (!outPath) {
    console.log(json.trimEnd())
    return
  }
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true })
  await fs.writeFile(outPath, json, 'utf8')
  console.log(`Wrote ${outPath}`)
}

async function readCostEntries(input: string | undefined): Promise<CostEntry[]> {
  if (!input) throw new Error('Missing --costs')
  const entries: CostEntry[] = []
  for (const file of input.split(',').map((item) => item.trim()).filter(Boolean)) {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as unknown
    if (Array.isArray(parsed)) entries.push(...parsed as CostEntry[])
    else if (isObject(parsed) && Array.isArray(parsed['costs'])) entries.push(...parsed['costs'] as CostEntry[])
  }
  return entries
}

async function readRevenueEntries(input: string | undefined): Promise<RevenueEntry[]> {
  if (!input) throw new Error('Missing --revenue')
  const entries: RevenueEntry[] = []
  for (const file of input.split(',').map((item) => item.trim()).filter(Boolean)) {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as unknown
    if (Array.isArray(parsed)) entries.push(...parsed as RevenueEntry[])
    else if (isObject(parsed) && Array.isArray(parsed['revenue'])) entries.push(...parsed['revenue'] as RevenueEntry[])
  }
  return entries
}

async function readUsageEntries(input: string | undefined): Promise<UsageEntry[]> {
  if (!input) throw new Error('Missing --usage')
  const entries: UsageEntry[] = []
  for (const file of input.split(',').map((item) => item.trim()).filter(Boolean)) {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as unknown
    if (Array.isArray(parsed)) entries.push(...parsed as UsageEntry[])
    else if (isObject(parsed) && Array.isArray(parsed['usage'])) entries.push(...parsed['usage'] as UsageEntry[])
  }
  return entries
}

async function readJsonFile<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  return args[index + 1]
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name)
}

function keyValueFlags(args: string[], name: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== name) continue
    const raw = args[i + 1]
    if (!raw) continue
    const splitAt = raw.indexOf('=')
    if (splitAt === -1) continue
    values[raw.slice(0, splitAt)] = raw.slice(splitAt + 1)
  }
  return values
}

function parseDateFlag(args: string[], name: string): Date {
  const value = flag(args, name)
  if (!value) throw new Error(`Missing ${name}`)
  return parseDate(value, name)
}

function optionalDateFlag(args: string[], name: string): Date | undefined {
  const value = flag(args, name)
  return value ? parseDate(value, name) : undefined
}

function optionalIntegerFlag(args: string[], name: string): number | undefined {
  const value = flag(args, name)
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Invalid ${name}: ${value}`)
  return parsed
}

function parseDate(value: string, name: string): Date {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid ${name}: ${value}`)
  return parsed
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, ...args] = process.argv.slice(2)
  run(command, args).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
