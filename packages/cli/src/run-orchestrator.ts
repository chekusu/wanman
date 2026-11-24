import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { AgentMatrixConfig, AgentRuntime } from '@wanman/core'
import type { ProjectRunSpec, RunOptions } from './execution-session.js'

export interface RunLaunchPlan {
  requestedProjectDir?: string
  projectDir?: string
  repoSourceDir?: string
  localGitRoot?: string
}

export interface RunSessionPlan {
  brainName?: string
  runId: string
  configName: string
  sourceLabel: string
  useThirdPartyApi: boolean
  useHybrid: boolean
  runtimeOverride?: string
  codexModelOverride?: string
  codexReasoningEffort?: string
  requiredRuntimes: AgentRuntime[]
  runtimeLabel: string
  llmModeLabel: string
  codexConfigLabel: string | null
}

export function resolveRequestedProjectDir(projectDir?: string): string | undefined {
  if (!projectDir) return undefined

  const resolvedProjectDir = path.resolve(projectDir)
  if (!fs.existsSync(resolvedProjectDir)) {
    throw new Error(`Project directory does not exist: ${resolvedProjectDir}`)
  }
  if (!fs.statSync(resolvedProjectDir).isDirectory()) {
    throw new Error(`Project directory is not a directory: ${resolvedProjectDir}`)
  }

  return resolvedProjectDir
}

export function createRunLaunchPlan(opts: Pick<RunOptions, 'projectDir'>, spec: ProjectRunSpec = {}): RunLaunchPlan {
  const requestedProjectDir = resolveRequestedProjectDir(opts.projectDir)
  const projectDir = spec.projectDir
  const repoSourceDir = spec.repoSourceDir ?? requestedProjectDir
  const localGitRoot = spec.gitRoot ?? repoSourceDir ?? requestedProjectDir

  return {
    requestedProjectDir,
    projectDir,
    repoSourceDir,
    localGitRoot,
  }
}

export function getRunSourceLabel(
  plan: Pick<RunLaunchPlan, 'projectDir' | 'requestedProjectDir'>,
  options: { standalone: boolean },
): string {
  if (plan.projectDir) return `project (${path.basename(plan.projectDir)})`
  if (plan.requestedProjectDir) return `working dir (${path.basename(plan.requestedProjectDir)})`
  return options.standalone ? 'standalone' : 'monorepo'
}

export function buildRunBrainName(goal: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16)
  const slug = goal.slice(0, 20).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase() || 'goal'
  return `wanman-run-${ts}-${slug}-${randomBytes(8).toString('hex')}`
}

export function normalizeRuntime(value?: string | null): AgentRuntime {
  return value === 'codex' ? 'codex' : 'claude'
}

export function detectRequiredRuntimes(
  configText: string,
  envRuntime?: string | null,
): AgentRuntime[] {
  if (envRuntime) {
    return [normalizeRuntime(envRuntime)]
  }

  try {
    const config = JSON.parse(configText) as Partial<AgentMatrixConfig>
    const runtimes = new Set<AgentRuntime>()
    for (const agent of config.agents ?? []) {
      runtimes.add(normalizeRuntime(agent.runtime))
    }
    return runtimes.size > 0 ? Array.from(runtimes) : ['claude']
  } catch {
    return ['claude']
  }
}

export function createRunSessionPlan(args: {
  goal: string
  opts: Pick<RunOptions, 'runtime' | 'codexModel' | 'codexReasoningEffort' | 'workerUrl'>
  launchPlan: Pick<RunLaunchPlan, 'projectDir' | 'requestedProjectDir'>
  configName: string
  configText: string
  standalone: boolean
  db9Token?: string
  env?: NodeJS.ProcessEnv
}): RunSessionPlan {
  const env = args.env ?? process.env
  const brainName = args.db9Token ? buildRunBrainName(args.goal) : undefined
  const runId = brainName || `run-${Date.now().toString(36)}-${randomBytes(8).toString('hex')}`
  const useThirdPartyApi = !!env['ANTHROPIC_BASE_URL']
  const useHybrid = !!args.opts.workerUrl
  const runtimeOverride = args.opts.runtime ?? env['WANMAN_RUNTIME']
  const codexModelOverride = args.opts.codexModel
    ?? env['WANMAN_CODEX_MODEL']
    ?? (runtimeOverride === 'codex' ? env['WANMAN_MODEL'] : undefined)
  const codexReasoningEffort = args.opts.codexReasoningEffort ?? env['WANMAN_CODEX_REASONING_EFFORT']
  const requiredRuntimes = detectRequiredRuntimes(args.configText, runtimeOverride)
  const runtimeLabel = runtimeOverride || (requiredRuntimes.length === 1 ? requiredRuntimes[0]! : requiredRuntimes.join(', '))
  const llmModeLabel = useHybrid
    ? 'hybrid-worker'
    : requiredRuntimes.every(runtime => runtime === 'codex')
      ? 'codex-cli'
      : useThirdPartyApi
        ? 'anthropic-compatible'
        : 'claude-cli'
  const shouldShowCodexConfig = runtimeOverride === 'codex' || requiredRuntimes.some(runtime => runtime === 'codex')

  return {
    brainName,
    runId,
    configName: args.configName,
    sourceLabel: getRunSourceLabel(args.launchPlan, { standalone: args.standalone }),
    useThirdPartyApi,
    useHybrid,
    runtimeOverride,
    codexModelOverride,
    codexReasoningEffort,
    requiredRuntimes,
    runtimeLabel,
    llmModeLabel,
    codexConfigLabel: shouldShowCodexConfig
      ? `${codexModelOverride ?? 'default'} / ${codexReasoningEffort ?? 'default'}`
      : null,
  }
}
