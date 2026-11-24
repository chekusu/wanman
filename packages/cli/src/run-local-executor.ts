import type { AgentRuntime } from '@wanman/core'
import type { LocalSupervisorHandle } from './local-supervisor.js'
import { runLocalSupervisorSession } from './local-supervisor-session.js'
import type { ExecutionHooks, ProjectRunSpec, RunOptions } from './execution-session.js'
import type { RuntimeClient } from './runtime-client.js'

export interface LocalRunLayout {
  baseDir: string
  configPath: string
  workspaceRoot: string
  gitRoot: string
  sharedSkillsDir: string
  cleanup(): void
}

export interface LocalRunRuntimeOptions {
  runtime?: AgentRuntime
  codexModel?: string
  codexReasoningEffort?: RunOptions['codexReasoningEffort']
}

export interface LocalRunObservationParams {
  backend: LocalSupervisorHandle
  goal: string
  opts: RunOptions
  spec: ProjectRunSpec
  runId: string
  workspaceRoot: string
  brainName?: string
  hooks?: ExecutionHooks
  shouldStop: () => boolean
}

export interface LocalRunExecutorParams {
  hostEnv?: NodeJS.ProcessEnv
  goal: string
  opts: RunOptions
  spec: ProjectRunSpec
  runId: string
  localLayout: LocalRunLayout
  runtime: LocalRunRuntimeOptions
  brainName?: string
  hooks?: ExecutionHooks
  observeExecution(params: LocalRunObservationParams): Promise<unknown>
  downloadDeliverables(runtime: RuntimeClient, outputDir: string, workspaceRoot: string, brainName?: string, runId?: string): Promise<void>
  downloadRepoPatch(outputDir: string, repoRoot: string, runId?: string): Promise<void>
}

export async function runLocalExecution(params: LocalRunExecutorParams): Promise<void> {
  const {
    goal,
    opts,
    spec,
    runId,
    localLayout,
    runtime,
    brainName,
    hooks,
  } = params

  console.log('  [3/4] Starting local supervisor...')
  await runLocalSupervisorSession({
    supervisor: {
      hostEnv: params.hostEnv,
      threadSync: spec.threadSync,
      configPath: localLayout.configPath,
      workspaceRoot: localLayout.workspaceRoot,
      gitRoot: localLayout.gitRoot,
      sharedSkillsDir: localLayout.sharedSkillsDir,
      homeRoot: localLayout.baseDir,
      goal,
      runtime: runtime.runtime,
      codexModel: runtime.codexModel,
      codexReasoningEffort: runtime.codexReasoningEffort,
    },
    keep: opts.keep,
    signalMode: 'exit_process',
    onStarted: ({ endpoint, entrypoint }) => {
      console.log(`  Endpoint:   ${endpoint}`)
      console.log(`  Entrypoint: ${entrypoint}`)
    },
    onHealthy: () => {
      console.log('  Supervisor healthy!\n')
    },
    onSignal: () => {
      console.log('\n  Shutting down...')
    },
    onError: async (err, { runtime: supervisorRuntime }) => {
      console.error(`\n  Error: ${err instanceof Error ? err.message : String(err)}`)
      process.exitCode = 1
      try { await params.downloadDeliverables(supervisorRuntime, opts.output, localLayout.workspaceRoot, brainName, runId) } catch { /* best-effort */ }
      try { await params.downloadRepoPatch(opts.output, localLayout.gitRoot, runId) } catch { /* best-effort */ }
    },
    onStopped: (_context, reason) => {
      localLayout.cleanup()
      if (reason === 'signal') {
        console.log('  Local supervisor stopped.')
      }
    },
    onKeptAlive: ({ endpoint }) => {
      console.log(`  Local supervisor kept alive: ${endpoint}`)
      console.log(`  Local workspace kept at: ${localLayout.baseDir}`)
    },
    run: async ({ supervisor, runtime: supervisorRuntime, isShuttingDown }) => {
      await params.observeExecution({
        backend: supervisor,
        goal,
        opts,
        spec,
        runId,
        workspaceRoot: localLayout.workspaceRoot,
        brainName,
        hooks,
        shouldStop: () => isShuttingDown(),
      })

      await params.downloadDeliverables(supervisorRuntime, opts.output, localLayout.workspaceRoot, brainName, runId)
      await params.downloadRepoPatch(opts.output, localLayout.gitRoot, runId).catch(() => undefined)
    },
  })
}
