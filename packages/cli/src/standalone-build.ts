import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build as esbuildBuild, type BuildOptions, type BuildResult } from 'esbuild'
import type { EmbeddedAssets } from './execution-session.js'

export const STANDALONE_BUNDLE_FILENAME = 'wanman.mjs'
export const STANDALONE_BUNDLE_RELATIVE_PATH = path.join('dist', STANDALONE_BUNDLE_FILENAME)
export const EMBEDDED_ASSETS_FILENAME = 'embedded-assets.ts'

export interface StandalonePaths {
  cliRoot: string
  projectRoot: string
  cliEntrypointPath: string
  runtimeEntrypointPath: string
  sharedSkillsDir: string
  agentGuidesDir: string
  containerDir: string
  productsJsonPath: string
  assetsModulePath: string
  bundlePath: string
  bundleEntryPath: string
}

export interface CompileTargets {
  wantCompile: boolean
  buildDarwin: boolean
  buildLinux: boolean
}

export interface BuildStandaloneOptions {
  cliRoot?: string
  projectRoot?: string
  args?: string[]
  buildBundle?: (options: BuildOptions) => Promise<BuildResult>
  execFile?: typeof execFileSync
  smokeTest?: (bundlePath: string, execPath?: string) => void
  log?: (line: string) => void
}

function defaultCliRoot(metaUrl = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(metaUrl)), '..')
}

export function resolveStandalonePaths(
  cliRoot = defaultCliRoot(),
  projectRoot = path.resolve(cliRoot, '../..'),
): StandalonePaths {
  return {
    cliRoot,
    projectRoot,
    cliEntrypointPath: path.join(cliRoot, 'dist', 'index.js'),
    runtimeEntrypointPath: path.join(projectRoot, 'packages', 'runtime', 'dist', 'entrypoint.js'),
    sharedSkillsDir: path.join(projectRoot, 'packages', 'core', 'skills'),
    agentGuidesDir: path.join(projectRoot, 'packages', 'core', 'agents'),
    containerDir: path.join(projectRoot, 'apps', 'container'),
    productsJsonPath: path.join(projectRoot, 'apps', 'container', 'products.json'),
    assetsModulePath: path.join(cliRoot, 'src', EMBEDDED_ASSETS_FILENAME),
    bundlePath: path.join(cliRoot, STANDALONE_BUNDLE_RELATIVE_PATH),
    bundleEntryPath: path.join(cliRoot, 'src', 'index.ts'),
  }
}

function readValidatedTextFile(filePath: string, label: string): string {
  if (!fs.existsSync(filePath)) {
    throw new Error(`[standalone] Missing required ${label}: ${filePath}`)
  }
  const content = fs.readFileSync(filePath, 'utf-8')
  if (!content.trim()) {
    throw new Error(`[standalone] Empty required ${label}: ${filePath}`)
  }
  return content
}

function readOptionalJsonText(filePath: string, label: string): string | null {
  if (!fs.existsSync(filePath)) return null
  const content = readValidatedTextFile(filePath, label)
  try {
    JSON.parse(content)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`[standalone] Invalid ${label} JSON at ${filePath}: ${detail}`)
  }
  return content
}

export function collectDirectoryTextAssets(
  parentDir: string,
  fileName: string,
  label: string,
  options: { requireAtLeastOne?: boolean } = {},
): Record<string, string> {
  if (!fs.existsSync(parentDir)) {
    if (options.requireAtLeastOne) {
      throw new Error(`[standalone] Missing required ${label} directory: ${parentDir}`)
    }
    return {}
  }

  const directories = fs.readdirSync(parentDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))

  if (options.requireAtLeastOne && directories.length === 0) {
    throw new Error(`[standalone] Expected at least one ${label} asset in ${parentDir}`)
  }

  const missing: string[] = []
  const assets: Record<string, string> = {}
  for (const entry of directories) {
    const filePath = path.join(parentDir, entry.name, fileName)
    if (!fs.existsSync(filePath)) {
      missing.push(path.join(entry.name, fileName))
      continue
    }
    const content = readValidatedTextFile(filePath, `${label} asset`)
    assets[entry.name] = content
  }

  if (missing.length > 0) {
    throw new Error(`[standalone] Missing ${fileName} for ${label} assets: ${missing.join(', ')}`)
  }

  if (options.requireAtLeastOne && Object.keys(assets).length === 0) {
    throw new Error(`[standalone] Expected at least one valid ${label} asset in ${parentDir}`)
  }

  return assets
}

function collectAgentConfigs(containerDir: string): Record<string, string> {
  if (!fs.existsSync(containerDir)) return {}
  const configs: Record<string, string> = {}
  const files = fs.readdirSync(containerDir)
    .filter(name => /^agents.*\.json$/i.test(name))
    .sort((a, b) => a.localeCompare(b))
  for (const fileName of files) {
    const fullPath = path.join(containerDir, fileName)
    const content = readOptionalJsonText(fullPath, 'agent config')
    if (content !== null) {
      configs[fileName] = content
    }
  }
  return configs
}

export function validateEmbeddedAssets(assets: EmbeddedAssets): void {
  const issues: string[] = []
  if (!assets.ENTRYPOINT_JS.trim()) issues.push('ENTRYPOINT_JS is empty')
  if (!assets.CLI_JS.trim()) issues.push('CLI_JS is empty')
  if (Object.keys(assets.SHARED_SKILLS).length === 0) issues.push('SHARED_SKILLS is empty')
  for (const [name, content] of Object.entries(assets.AGENT_CONFIGS)) {
    if (!content.trim()) issues.push(`AGENT_CONFIGS.${name} is empty`)
  }
  for (const [name, content] of Object.entries(assets.AGENT_SKILLS)) {
    if (!content.trim()) issues.push(`AGENT_SKILLS.${name} is empty`)
  }
  for (const [name, content] of Object.entries(assets.SHARED_SKILLS)) {
    if (!content.trim()) issues.push(`SHARED_SKILLS.${name} is empty`)
  }
  if (assets.PRODUCTS_JSON !== null && !assets.PRODUCTS_JSON.trim()) {
    issues.push('PRODUCTS_JSON is empty')
  }
  if (issues.length > 0) {
    throw new Error(`[standalone] Invalid embedded assets: ${issues.join('; ')}`)
  }
}

export function collectStandaloneAssets(paths: StandalonePaths): EmbeddedAssets {
  const assets: EmbeddedAssets = {
    ENTRYPOINT_JS: readValidatedTextFile(paths.runtimeEntrypointPath, 'runtime entrypoint.js'),
    CLI_JS: readValidatedTextFile(paths.cliEntrypointPath, 'CLI dist/index.js'),
    AGENT_CONFIGS: collectAgentConfigs(paths.containerDir),
    AGENT_SKILLS: collectDirectoryTextAssets(paths.agentGuidesDir, 'AGENT.md', 'agent guide'),
    SHARED_SKILLS: collectDirectoryTextAssets(paths.sharedSkillsDir, 'SKILL.md', 'shared skill', {
      requireAtLeastOne: true,
    }),
    PRODUCTS_JSON: readOptionalJsonText(paths.productsJsonPath, 'products manifest'),
  }
  validateEmbeddedAssets(assets)
  return assets
}

export function renderEmbeddedAssetsModule(assets: EmbeddedAssets): string {
  validateEmbeddedAssets(assets)
  const sections = [
    '// Auto-generated by build-standalone.mjs - DO NOT EDIT',
    '',
    `export const ENTRYPOINT_JS = ${JSON.stringify(assets.ENTRYPOINT_JS)}`,
    '',
    `export const CLI_JS = ${JSON.stringify(assets.CLI_JS)}`,
    '',
    `export const AGENT_CONFIGS: Record<string, string> = ${JSON.stringify(assets.AGENT_CONFIGS, null, 2)}`,
    '',
    `export const AGENT_SKILLS: Record<string, string> = ${JSON.stringify(assets.AGENT_SKILLS, null, 2)}`,
    '',
    `export const SHARED_SKILLS: Record<string, string> = ${JSON.stringify(assets.SHARED_SKILLS, null, 2)}`,
    '',
    `export const PRODUCTS_JSON: string | null = ${assets.PRODUCTS_JSON === null ? 'null' : JSON.stringify(assets.PRODUCTS_JSON)}`,
    '',
  ]
  return sections.join('\n')
}

export function getStandaloneCompileTargets(args: string[]): CompileTargets {
  const buildLinux = args.includes('--linux') || args.includes('--all')
  const buildDarwin = args.includes('--compile') || args.includes('--all')
  return {
    wantCompile: buildDarwin || buildLinux,
    buildDarwin,
    buildLinux,
  }
}

function logCollectedAssets(assets: EmbeddedAssets, log: (line: string) => void): void {
  log('[standalone] Collected assets:')
  log(`  entrypoint.js: ${(assets.ENTRYPOINT_JS.length / 1024).toFixed(0)} KB`)
  log(`  cli index.js:  ${(assets.CLI_JS.length / 1024).toFixed(0)} KB`)
  log(`  agent configs: ${Object.keys(assets.AGENT_CONFIGS).join(', ') || '(none)'}`)
  log(`  agent skills:  ${Object.keys(assets.AGENT_SKILLS).join(', ') || '(none)'}`)
  log(`  shared skills: ${Object.keys(assets.SHARED_SKILLS).join(', ')}`)
}

function assertFileExistsAndNonEmpty(filePath: string, label: string): fs.Stats {
  if (!fs.existsSync(filePath)) {
    throw new Error(`[standalone] Missing ${label}: ${filePath}`)
  }
  const stat = fs.statSync(filePath)
  if (stat.size <= 0) {
    throw new Error(`[standalone] Empty ${label}: ${filePath}`)
  }
  return stat
}

export function assertStandaloneBundle(bundlePath: string): fs.Stats {
  if (path.basename(bundlePath) !== STANDALONE_BUNDLE_FILENAME) {
    throw new Error(
      `[standalone] Unexpected standalone bundle name: ${path.basename(bundlePath)} (expected ${STANDALONE_BUNDLE_FILENAME})`,
    )
  }
  return assertFileExistsAndNonEmpty(bundlePath, 'standalone bundle')
}

export function smokeTestStandaloneBundle(bundlePath: string, execPath = process.execPath): void {
  assertStandaloneBundle(bundlePath)
  try {
    const output = execFileSync(execPath, [bundlePath, '--help'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (!output.includes('wanman')) {
      throw new Error('expected help output to mention "wanman"')
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`[standalone] Standalone smoke test failed for ${bundlePath}: ${detail}`)
  }
}

function bunBinary(): string {
  return process.platform === 'win32' ? 'bun.exe' : 'bun'
}

export async function buildStandalone(options: BuildStandaloneOptions = {}): Promise<{
  bundlePath: string
  bundleSize: number
}> {
  const cliRoot = options.cliRoot ?? defaultCliRoot()
  const projectRoot = options.projectRoot ?? path.resolve(cliRoot, '../..')
  const args = options.args ?? []
  const log = options.log ?? console.log
  const buildBundle = options.buildBundle ?? esbuildBuild
  const execFile = options.execFile ?? execFileSync
  const smokeTest = options.smokeTest ?? smokeTestStandaloneBundle
  const paths = resolveStandalonePaths(cliRoot, projectRoot)
  const assets = collectStandaloneAssets(paths)

  logCollectedAssets(assets, log)

  fs.mkdirSync(path.dirname(paths.assetsModulePath), { recursive: true })
  fs.writeFileSync(paths.assetsModulePath, renderEmbeddedAssetsModule(assets))
  log(`[standalone] Generated ${paths.assetsModulePath}`)

  try {
    await buildBundle({
      entryPoints: [paths.bundleEntryPath],
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'esm',
      outfile: paths.bundlePath,
      banner: { js: '#!/usr/bin/env node' },
    })

    const bundleStat = assertStandaloneBundle(paths.bundlePath)
    log(`[standalone] -> ${STANDALONE_BUNDLE_RELATIVE_PATH} (${(bundleStat.size / 1024).toFixed(0)} KB)`)
    smokeTest(paths.bundlePath)
    log('[standalone] Smoke test passed')

    const targets = getStandaloneCompileTargets(args)
    if (targets.wantCompile) {
      const bunBin = bunBinary()
      const compile = (target: string | null, outputName: string) => {
        const outfile = path.join('dist', outputName)
        const commandArgs = ['build', '--compile']
        if (target) {
          commandArgs.push(`--target=${target}`)
        }
        commandArgs.push('src/index.ts', '--outfile', outfile)
        log(`[standalone] ${bunBin} ${commandArgs.join(' ')}`)
        execFile(bunBin, commandArgs, { cwd: cliRoot, stdio: 'inherit' })
        const binaryStat = assertFileExistsAndNonEmpty(path.join(cliRoot, outfile), `compiled ${outputName}`)
        log(`[standalone] -> ${outfile} (${(binaryStat.size / 1024 / 1024).toFixed(1)} MB)`)
      }

      if (targets.buildDarwin) compile(null, 'wanman')
      if (targets.buildLinux) compile('bun-linux-x64', 'wanman-linux')
    }

    return {
      bundlePath: paths.bundlePath,
      bundleSize: bundleStat.size,
    }
  } finally {
    fs.rmSync(paths.assetsModulePath, { force: true })
  }
}
