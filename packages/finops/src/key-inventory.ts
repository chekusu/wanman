import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  classifyProvider,
  classifyProviderByName,
  providerFromHost,
  providerFromPackageName,
} from './provider-classifier.js'
import type {
  ApiKeyProviderEvidence,
  ApiKeyInventory,
  ApiKeyReference,
  CompanyApiKeySummary,
  FinopsConfig,
  InventoryRepository,
  InventoryEvidenceKind,
  ProductApiKeySummary,
  ProductConfig,
} from './types.js'

export interface InventoryScanOptions {
  root: string
  companyId?: string
  config?: FinopsConfig
  includeLocalEnvFiles?: boolean
  maxFileBytes?: number
}

interface RepoTarget {
  repo: string
  repoPath: string
}

interface EnvReferenceDraft {
  envVar: string
  evidenceKind: InventoryEvidenceKind
  sourceFile: string
}

interface EnvReferenceFinding extends EnvReferenceDraft {
  providerEvidence: ApiKeyProviderEvidence[]
}

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024

const SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.nuxt',
  '.turbo',
  '.venv',
  '.wrangler',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'vendor',
])

const TEXT_EXTENSIONS = new Set([
  '.cjs',
  '.conf',
  '.config',
  '.css',
  '.env',
  '.go',
  '.graphql',
  '.html',
  '.ini',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.sql',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
])

const IGNORE_ENV_VARS = new Set([
  'API',
  'API_BASE',
  'API_BASE_URL',
  'API_KEY',
  'API_KEY_FLAG',
  'API_SECRET',
  'API_URL',
  'EXAMPLE_API_KEY',
  'GITHUB_API',
  'INVALID_TOKEN',
  'KEY',
  'MY_API_KEY',
  'NO_TOKEN',
  'SECRET',
  'TOKEN',
  'YOUR_API_KEY',
  'FOREIGN_KEY',
  'PRIMARY_KEY',
  'UNIQUE_KEY',
])

const NON_CREDENTIAL_SUFFIXES = [
  '_ACCOUNT_ID',
  '_API_URL',
  '_BASE',
  '_BASE_URL',
  '_CLIENT_ID',
  '_ENDPOINT',
  '_EXPIRY_SECONDS',
  '_EXPIRE_MINUTES',
  '_FILE',
  '_HOST',
  '_MAX_CPU',
  '_MAX_DISK_GB',
  '_MAX_MEMORY_MB',
  '_ORIGIN',
  '_PID',
  '_PROJECT_ID',
  '_PUBLISHABLE_KEY',
  '_PUBLIC_KEY',
  '_TEAM_ID',
  '_URI',
  '_URL',
  '_VALUE',
  '_VERSION',
]

export async function scanApiKeyInventory(options: InventoryScanOptions): Promise<ApiKeyInventory> {
  const root = path.resolve(options.root)
  const companyId = options.config?.company.id ?? options.companyId ?? path.basename(root)
  const repos = await findRepositories(root)
  const drafts: ApiKeyReference[] = []
  const repositorySummaries: InventoryRepository[] = []

  for (const repo of repos) {
    const product = resolveProduct(repo.repo, options.config?.products)
    const perRepo = new Map<string, ApiKeyReference>()
    const findings: EnvReferenceFinding[] = []
    const repoProviderEvidence: ApiKeyProviderEvidence[] = []
    for await (const filePath of walkFiles(repo.repoPath)) {
      if (!shouldScanFile(filePath, repo.repoPath, Boolean(options.includeLocalEnvFiles))) {
        continue
      }
      const stat = await fs.stat(filePath)
      if (stat.size > (options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES)) continue

      const rel = path.relative(repo.repoPath, filePath)
      const content = await fs.readFile(filePath, 'utf8')
      const fileProviderEvidence = extractProviderEvidence(content, rel)
      for (const evidence of fileProviderEvidence) {
        if (evidence.kind === 'package-name') addUniqueProviderEvidence(repoProviderEvidence, evidence)
      }

      for (const found of extractEnvReferences(content, rel)) {
        if (!isRelevantCredentialName(found.envVar)) continue
        findings.push({ ...found, providerEvidence: fileProviderEvidence })
      }
    }

    for (const found of findings) {
      const key = found.envVar
      const providerEvidence = mergeProviderEvidence(
        found.providerEvidence,
        matchingRepoProviderEvidence(key, found.providerEvidence, repoProviderEvidence),
      )
      const existing = perRepo.get(key)
      if (existing) {
        addUnique(existing.evidenceKinds, found.evidenceKind)
        addUnique(existing.sourceFiles, found.sourceFile)
        for (const evidence of providerEvidence) {
          addUnique(existing.evidenceKinds, evidence.kind)
          addUnique(existing.sourceFiles, evidence.sourceFile)
          addUniqueProviderEvidence(existing.providerEvidence, evidence)
        }
        existing.provider = classifyProvider(existing.envVar, existing.providerEvidence)
        continue
      }

      perRepo.set(key, {
        repo: repo.repo,
        repoPath: repo.repoPath,
        productId: product.id,
        companyId: product.companyId ?? companyId,
        envVar: key,
        credentialProvider: classifyProviderByName(key),
        provider: classifyProvider(key, providerEvidence),
        evidenceKinds: uniqueEvidenceKinds([found.evidenceKind, ...providerEvidence.map((item) => item.kind)]),
        sourceFiles: uniqueStrings([found.sourceFile, ...providerEvidence.map((item) => item.sourceFile)]),
        providerEvidence,
        secretIncluded: false,
      })
    }
    const repoReferences = [...perRepo.values()]
    drafts.push(...repoReferences)
    repositorySummaries.push({
      repo: repo.repo,
      repoPath: repo.repoPath,
      productId: product.id,
      companyId: product.companyId ?? companyId,
      keyCount: repoReferences.length,
    })
  }

  drafts.sort((a, b) => {
    const byProduct = a.productId.localeCompare(b.productId)
    if (byProduct) return byProduct
    const byRepo = a.repo.localeCompare(b.repo)
    if (byRepo) return byRepo
    return a.envVar.localeCompare(b.envVar)
  })

  return {
    generatedAt: new Date().toISOString(),
    root,
    companyId,
    reposScanned: repos.length,
    repositories: repositorySummaries.sort((a, b) => a.repo.localeCompare(b.repo)),
    references: drafts,
    byProduct: summarizeByProduct(drafts),
    byCompany: summarizeByCompany(drafts),
  }
}

export async function writeInventoryFile(inventory: ApiKeyInventory, outPath: string): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  await fs.writeFile(outPath, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8')
}

export async function findRepositories(root: string): Promise<RepoTarget[]> {
  const resolved = path.resolve(root)
  if (await pathExists(path.join(resolved, '.git'))) {
    return [repoTargetForPath(resolved)]
  }

  const owner = path.basename(resolved)
  const entries = await fs.readdir(resolved, { withFileTypes: true })
  const repos: RepoTarget[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const repoPath = path.join(resolved, entry.name)
    if (await pathExists(path.join(repoPath, '.git'))) {
      repos.push({ repo: `${owner}/${entry.name}`, repoPath })
    }
  }
  repos.sort((a, b) => a.repo.localeCompare(b.repo))
  return repos
}

export function extractEnvReferences(content: string, sourceFile = '<memory>'): EnvReferenceDraft[] {
  const refs: EnvReferenceDraft[] = []
  collectMatches(refs, content, /(?:^|\n)\s*(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*=/g, 'assignment', sourceFile)
  collectMatches(refs, content, /process\.env(?:\.([A-Z][A-Z0-9_]{2,})|\[['"]([A-Z][A-Z0-9_]{2,})['"]\])/g, 'env-access', sourceFile)
  collectMatches(refs, content, /(?:Deno|Bun)\.env(?:\.get\(['"]([A-Z][A-Z0-9_]{2,})['"]\)|\.([A-Z][A-Z0-9_]{2,}))/g, 'env-access', sourceFile)
  collectMatches(refs, content, /import\.meta\.env\.([A-Z][A-Z0-9_]{2,})/g, 'env-access', sourceFile)
  collectMatches(refs, content, /os\.(?:environ\.get\(['"]([A-Z][A-Z0-9_]{2,})['"]\)|environ\[['"]([A-Z][A-Z0-9_]{2,})['"]\])/g, 'env-access', sourceFile)
  collectMatches(refs, content, /\b(?:getenv|env)\(['"]([A-Z][A-Z0-9_]{2,})['"]\)/g, 'env-access', sourceFile)
  collectMatches(refs, content, /\bsecrets\.([A-Z][A-Z0-9_]{2,})\b/g, 'github-secret', sourceFile)
  collectMatches(
    refs,
    content,
    /\b([A-Z][A-Z0-9_]*(?:API_KEY|SECRET_KEY|ACCESS_TOKEN|REFRESH_TOKEN|WEBHOOK_SECRET|CLIENT_SECRET|CLIENT_ID|DATABASE_URL|POSTGRES_URL|REDIS_URL|AUTH_TOKEN|BEARER_TOKEN|PRIVATE_KEY|PUBLIC_KEY|SERVICE_ROLE_KEY|ANON_KEY|TOKEN|SECRET|API|KEY)[A-Z0-9_]*)\b/g,
    'identifier',
    sourceFile,
  )

  const unique = new Map<string, EnvReferenceDraft>()
  for (const ref of refs) {
    unique.set(`${ref.envVar}:${ref.evidenceKind}:${ref.sourceFile}`, ref)
  }
  return [...unique.values()]
}

export function extractProviderEvidence(content: string, sourceFile = '<memory>'): ApiKeyProviderEvidence[] {
  const evidence: ApiKeyProviderEvidence[] = []

  collectImportEvidence(evidence, content, sourceFile)
  collectUrlEvidence(evidence, content, sourceFile)
  collectPackageEvidence(evidence, content, sourceFile)

  const unique = new Map<string, ApiKeyProviderEvidence>()
  for (const item of evidence) {
    unique.set(`${item.kind}:${item.sourceFile}:${item.value}:${item.provider ?? ''}`, item)
  }
  return [...unique.values()]
}

function collectMatches(
  refs: EnvReferenceDraft[],
  content: string,
  pattern: RegExp,
  evidenceKind: InventoryEvidenceKind,
  sourceFile: string,
): void {
  for (const match of content.matchAll(pattern)) {
    const envVar = match.slice(1).find(Boolean)
    if (!envVar || IGNORE_ENV_VARS.has(envVar)) continue
    refs.push({ envVar, evidenceKind, sourceFile })
  }
}

function collectImportEvidence(evidence: ApiKeyProviderEvidence[], content: string, sourceFile: string): void {
  const importPattern = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g
  for (const match of content.matchAll(importPattern)) {
    const packageName = match[1]
    if (!packageName) continue
    const provider = providerFromPackageName(packageName)
    if (!provider) continue
    evidence.push({
      kind: 'sdk-import',
      sourceFile,
      value: `import:${packageName}`,
      provider,
    })
  }
}

function collectUrlEvidence(evidence: ApiKeyProviderEvidence[], content: string, sourceFile: string): void {
  const urlPattern = /https?:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]*)?/g
  for (const match of content.matchAll(urlPattern)) {
    const rawUrl = match[0]
    const parsed = safeUrl(rawUrl)
    if (!parsed) continue
    const provider = providerFromHost(parsed.hostname)
    if (!provider) continue
    evidence.push({
      kind: 'base-url',
      sourceFile,
      value: `host:${parsed.hostname}`,
      provider,
    })
  }
}

function collectPackageEvidence(evidence: ApiKeyProviderEvidence[], content: string, sourceFile: string): void {
  if (!sourceFile.endsWith('package.json')) return

  const parsed = safeJsonObject(content)
  if (!parsed) return

  for (const dependencyField of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const dependencies = asObject(parsed[dependencyField])
    if (!dependencies) continue
    for (const packageName of Object.keys(dependencies)) {
      const provider = providerFromPackageName(packageName)
      if (!provider) continue
      evidence.push({
        kind: 'package-name',
        sourceFile,
        value: `package:${packageName}`,
        provider,
      })
    }
  }
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      yield* walkFiles(fullPath)
    } else if (entry.isFile()) {
      yield fullPath
    }
  }
}

function shouldScanFile(filePath: string, repoPath: string, includeLocalEnvFiles: boolean): boolean {
  const rel = path.relative(repoPath, filePath)
  const base = path.basename(filePath)

  if (base === '.env' || base === '.env.local' || base.endsWith('.local')) {
    return includeLocalEnvFiles
  }

  if (base.startsWith('.env')) return true
  if (base.includes('.env.')) return true
  if (rel.startsWith('.github/workflows/')) return true
  if (base === 'wrangler.toml' || base === 'vercel.json') return true

  return TEXT_EXTENSIONS.has(path.extname(base))
}

function isRelevantCredentialName(envVar: string): boolean {
  if (IGNORE_ENV_VARS.has(envVar)) return false
  if (NON_CREDENTIAL_SUFFIXES.some((suffix) => envVar.endsWith(suffix))) return false
  if (/^(VITE|EXPO_PUBLIC|NEXT_PUBLIC|PUBLIC)_/.test(envVar)) return false
  return /(API_KEY|SECRET_KEY|ACCESS_TOKEN|AUTH_TOKEN|BEARER_TOKEN|PRIVATE_KEY|SERVICE_ROLE_KEY|WEBHOOK_SECRET|PASSWORD|CREDENTIAL|DATABASE_URL|POSTGRES_URL|REDIS_URL|DSN|STRIPE|OPENAI|OPENROUTER|ANTHROPIC|CLAUDE|GITHUB|CLOUDFLARE|SUPABASE|RESEND|SENDGRID|AWS|GOOGLE|GEMINI|SLACK|LINE|DISCORD|SENTRY|TWILIO|VERCEL)/.test(envVar)
}

function repoTargetForPath(repoPath: string): RepoTarget {
  const repoName = path.basename(repoPath)
  const owner = path.basename(path.dirname(repoPath))
  return { repo: `${owner}/${repoName}`, repoPath }
}

function resolveProduct(repo: string, products: ProductConfig[] = []): ProductConfig {
  const repoName = repo.split('/').at(-1) ?? repo
  for (const product of products) {
    const repositories = product.repositories ?? []
    if (repositories.includes(repo) || repositories.includes(repoName)) {
      return product
    }
  }
  return { id: repoName, repositories: [repo] }
}

function summarizeByProduct(refs: ApiKeyReference[]): Record<string, ProductApiKeySummary> {
  const summaries = new Map<string, ProductApiKeySummary & { repoSet: Set<string> }>()
  for (const ref of refs) {
    const summary = summaries.get(ref.productId) ?? {
      productId: ref.productId,
      repoCount: 0,
      keyCount: 0,
      providers: {},
      envVars: [],
      repoSet: new Set<string>(),
    }
    summary.keyCount += 1
    summary.repoSet.add(ref.repo)
    summary.providers[ref.provider] = (summary.providers[ref.provider] ?? 0) + 1
    addUnique(summary.envVars, ref.envVar)
    summaries.set(ref.productId, summary)
  }

  return Object.fromEntries([...summaries].map(([id, summary]) => {
    const { repoSet, ...rest } = summary
    return [id, { ...rest, repoCount: repoSet.size, envVars: rest.envVars.sort() }]
  }))
}

function summarizeByCompany(refs: ApiKeyReference[]): Record<string, CompanyApiKeySummary> {
  const summaries = new Map<string, CompanyApiKeySummary & { productSet: Set<string> }>()
  for (const ref of refs) {
    const summary = summaries.get(ref.companyId) ?? {
      companyId: ref.companyId,
      productCount: 0,
      keyCount: 0,
      providers: {},
      productSet: new Set<string>(),
    }
    summary.keyCount += 1
    summary.productSet.add(ref.productId)
    summary.providers[ref.provider] = (summary.providers[ref.provider] ?? 0) + 1
    summaries.set(ref.companyId, summary)
  }

  return Object.fromEntries([...summaries].map(([id, summary]) => {
    const { productSet, ...rest } = summary
    return [id, { ...rest, productCount: productSet.size }]
  }))
}

function addUnique<T>(items: T[], item: T): void {
  if (!items.includes(item)) items.push(item)
}

function addUniqueProviderEvidence(items: ApiKeyProviderEvidence[], item: ApiKeyProviderEvidence): void {
  if (items.some((existing) => providerEvidenceKey(existing) === providerEvidenceKey(item))) return
  items.push(item)
}

function mergeProviderEvidence(
  fileEvidence: ApiKeyProviderEvidence[],
  repoEvidence: ApiKeyProviderEvidence[],
): ApiKeyProviderEvidence[] {
  const merged: ApiKeyProviderEvidence[] = []
  for (const evidence of [...fileEvidence, ...repoEvidence]) addUniqueProviderEvidence(merged, evidence)
  return merged
}

function matchingRepoProviderEvidence(
  envVar: string,
  fileEvidence: ApiKeyProviderEvidence[],
  repoEvidence: ApiKeyProviderEvidence[],
): ApiKeyProviderEvidence[] {
  const credentialProvider = classifyProviderByName(envVar)
  const inferredProvider = classifyProvider(envVar, fileEvidence)
  return repoEvidence.filter((evidence) => {
    if (!evidence.provider) return false
    if (credentialProvider !== 'unknown' && evidence.provider === credentialProvider) return true
    if (inferredProvider !== 'unknown' && evidence.provider === inferredProvider) return true
    return isOpenAiFamily(credentialProvider) && isOpenAiFamily(evidence.provider)
  })
}

function isOpenAiFamily(provider: string): boolean {
  return provider === 'openai' || provider === 'openrouter' || provider === 'azure-openai' || provider === 'openai-compatible'
}

function uniqueEvidenceKinds(items: InventoryEvidenceKind[]): InventoryEvidenceKind[] {
  return [...new Set(items)]
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items)]
}

function providerEvidenceKey(item: ApiKeyProviderEvidence): string {
  return `${item.kind}:${item.sourceFile}:${item.value}:${item.provider ?? ''}`
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function safeJsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content) as unknown
    return asObject(parsed)
  } catch {
    return null
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}
