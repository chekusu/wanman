import * as fs from 'node:fs'
import * as path from 'node:path'
import { execSync } from 'node:child_process'
import type { AgentDefinition, AgentMatrixConfig, AgentRuntime } from '@wanman/core'
import type { ProjectRunSpec as BaseProjectRunSpec, RunOptions } from '@wanman/host-sdk'
import { Heartbeat, LoopEventBus, LoopLogger } from './loop-observability.js'
import {
  type HealthAgent,
  type RuntimeArtifact,
  type RuntimeClient,
  type TaskInfo,
} from './runtime-client.js'
import type { LocalSupervisorHandle } from './local-supervisor.js'
import { createRunLaunchPlan, createRunSessionPlan } from './run-orchestrator.js'
import { runLocalExecution } from './run-local-executor.js'
import { renderDashboard, type DashboardState } from './tui/dashboard.js'
import { countTransitions, classifyLoop, type LoopSnapshot, type LoopClassification } from './loop-classifier.js'

export type { HealthAgent, RuntimeClient, TaskInfo } from './runtime-client.js'
export type { RunOptions } from '@wanman/host-sdk'

/** @internal exported for testing */
export function loadEnvFile(root: string, env: NodeJS.ProcessEnv = process.env): void {
  const envPath = path.join(root, '.env')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (!env[key]) env[key] = val
  }
}

export type ProjectRunSpec = BaseProjectRunSpec<ExecutionHooks>

export interface RunExecutionBindings {
  hostEnv?: NodeJS.ProcessEnv
}

export interface ExecutionContext {
  backend: LocalSupervisorHandle
  runtime: RuntimeClient
  goal: string
  opts: RunOptions
  spec: ProjectRunSpec
  runId: string
  workspaceRoot: string
  brainName?: string
}

export interface PollExecutionContext extends ExecutionContext {
  loop: number
  startTime: number
  agents: HealthAgent[]
  tasks: TaskInfo[]
  logs: string[]
}

export interface ExecutionHooks {
  afterHealthy?(ctx: ExecutionContext): Promise<void>
  afterPoll?(ctx: PollExecutionContext): Promise<void>
  shouldStop?(ctx: PollExecutionContext): Promise<boolean>
}

export interface EmbeddedAssets {
  ENTRYPOINT_JS: string
  CLI_JS: string
  AGENT_CONFIGS: Record<string, string>
  AGENT_SKILLS: Record<string, string>
  SHARED_SKILLS: Record<string, string>
  PRODUCTS_JSON: string | null
}

let embeddedAssets: EmbeddedAssets | null = null

async function getEmbeddedAssets(): Promise<EmbeddedAssets | null> {
  if (embeddedAssets !== null) return embeddedAssets
  try {
    embeddedAssets = await import('./embedded-assets.js')
    return embeddedAssets
  } catch {
    return null
  }
}

/** @internal exported for testing */
export function findProjectRoot(): string | null {
  let dir = process.cwd()
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** @internal exported for testing */
export function isStale(distFile: string, srcDir: string): boolean {
  if (!fs.existsSync(distFile)) return true
  try {
    const files = execSync(
      `find '${srcDir}' -name '*.ts' -not -path '*/node_modules/*' -not -path '*/__tests__/*' -newer '${distFile}'`,
      { encoding: 'utf-8' },
    ).trim()
    return files.length > 0
  } catch {
    return true
  }
}

function buildIfNeeded(root: string): void {
  const runtimeDist = path.join(root, 'packages/runtime/dist/entrypoint.js')
  const runtimeSrc = path.join(root, 'packages/runtime/src')
  const coreSrc = path.join(root, 'packages/core/src')
  const cliDist = path.join(root, 'packages/cli/dist/index.js')
  const cliSrc = path.join(root, 'packages/cli/src')

  if (isStale(runtimeDist, runtimeSrc) || isStale(runtimeDist, coreSrc)) {
    console.log('  [build] Building @wanman/runtime...')
    execSync('pnpm --filter @wanman/runtime build', { cwd: root, stdio: 'inherit' })
  }
  if (isStale(cliDist, cliSrc) || isStale(cliDist, coreSrc)) {
    console.log('  [build] Building @wanman/cli...')
    execSync('pnpm --filter @wanman/cli build', { cwd: root, stdio: 'inherit' })
  }
}

export interface LocalRunLayout {
  baseDir: string
  configPath: string
  workspaceRoot: string
  sharedSkillsDir: string
  gitRoot: string
  cleanup(): void
}

/** @internal exported for testing */
export function localizeRunConfigForHost(
  configText: string,
  baseDir: string,
  workspaceRoot: string,
  gitRoot: string,
): string {
  const config = JSON.parse(configText) as Record<string, unknown>
  config['dbPath'] = path.join(baseDir, 'wanman.db')
  config['workspaceRoot'] = workspaceRoot
  config['gitRoot'] = gitRoot
  return JSON.stringify(config, null, 2)
}

function copyDirectoryContents(sourceDir: string, targetDir: string): void {
  if (!fs.existsSync(sourceDir)) return
  fs.mkdirSync(targetDir, { recursive: true })
  for (const entry of fs.readdirSync(sourceDir)) {
    fs.cpSync(path.join(sourceDir, entry), path.join(targetDir, entry), {
      recursive: true,
      force: true,
      dereference: false,
    })
  }
}

function copyAgentWorkspace(sourceDir: string, targetDir: string): void {
  if (!fs.existsSync(sourceDir)) {
    fs.mkdirSync(targetDir, { recursive: true })
    return
  }
  copyDirectoryContents(sourceDir, targetDir)
}

function writeEmbeddedAgentWorkspace(assets: EmbeddedAssets, targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true })
  for (const [name, content] of Object.entries(assets.AGENT_SKILLS)) {
    const agentDir = path.join(targetDir, name)
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, 'AGENT.md'), content)
  }
}

function writeEmbeddedSharedSkills(assets: EmbeddedAssets, targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true })
  for (const [name, content] of Object.entries(assets.SHARED_SKILLS)) {
    const skillDir = path.join(targetDir, name)
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content)
  }
}

const DEFAULT_RUN_CONFIG_NAME = 'built-in-local-agents.json'

const DEFAULT_RUN_CLI_INSTRUCTIONS = [
  'Use `wanman recv` for messages, `wanman task list` for work state, and `wanman send <agent> "<message>"` to coordinate.',
  'Use `wanman send human --type decision "<question>"` when a human choice is required.',
  'Keep outputs under your workspace output directory and keep task updates concrete.',
].join('\n')

function normalizeDefaultRuntime(runtime?: AgentRuntime): AgentRuntime {
  return runtime === 'codex' ? 'codex' : 'claude'
}

function withWorkerEndpoint(agent: AgentDefinition, opts: RunOptions): AgentDefinition {
  if (!opts.workerUrl || agent.name === 'ceo') return agent
  return {
    ...agent,
    runtime: 'claude',
    model: opts.workerModel ?? agent.model,
    baseUrl: opts.workerUrl,
    ...(opts.workerKey ? { apiKey: opts.workerKey } : {}),
  }
}

function defaultAgent(
  opts: RunOptions,
  name: 'ceo' | 'dev' | 'feedback',
  lifecycle: AgentDefinition['lifecycle'],
  tier: 'high' | 'standard',
  role: string,
): AgentDefinition {
  const runtime = opts.runtime ? normalizeDefaultRuntime(opts.runtime) : undefined
  const agent: AgentDefinition = {
    name,
    lifecycle,
    ...(runtime ? { runtime } : {}),
    model: tier,
    systemPrompt: `${role}\n\n${DEFAULT_RUN_CLI_INSTRUCTIONS}`,
  }
  return withWorkerEndpoint(agent, opts)
}

export function createDefaultLocalRunConfigText(opts: RunOptions): string {
  const config: AgentMatrixConfig = {
    agents: [
      defaultAgent(
        opts,
        'ceo',
        '24/7',
        'high',
        'You are the CEO agent. Turn the run goal into a small backlog, assign work, review progress, and produce a concise final deliverable.',
      ),
      defaultAgent(
        opts,
        'dev',
        'on-demand',
        'standard',
        'You are the Dev agent. Implement assigned code, docs, or analysis tasks end-to-end and report exact files or outputs changed.',
      ),
      defaultAgent(
        opts,
        'feedback',
        'on-demand',
        'standard',
        'You are the Feedback agent. Review outputs, identify gaps, and convert useful observations into concrete follow-up tasks.',
      ),
    ],
    port: 3120,
  }
  return JSON.stringify(config, null, 2)
}

function defaultAgentGuide(agent: AgentDefinition): string {
  return [
    `# ${agent.name}`,
    '',
    agent.systemPrompt,
    '',
    '## Operating Rules',
    '',
    '- Read current messages with `wanman recv` before starting new work.',
    '- Check assigned work with `wanman task list` and update the team through `wanman send`.',
    '- Put files you create under `output/` unless the task explicitly asks for repository changes.',
  ].join('\n')
}

function writeMissingAgentGuides(configText: string, workspaceRoot: string): void {
  let config: Pick<AgentMatrixConfig, 'agents'>
  try {
    config = JSON.parse(configText) as AgentMatrixConfig
  } catch {
    return
  }
  for (const agent of config.agents ?? []) {
    const agentDir = path.join(workspaceRoot, agent.name)
    const guidePath = path.join(agentDir, 'AGENT.md')
    fs.mkdirSync(agentDir, { recursive: true })
    if (!fs.existsSync(guidePath)) {
      fs.writeFileSync(guidePath, defaultAgentGuide(agent))
    }
  }
}

/** @internal exported for testing */
export function materializeLocalRunLayout(params: {
  runId: string
  outputDir: string
  projectDir?: string
  root?: string | null
  embedded?: EmbeddedAssets | null
  configText: string
  gitRoot?: string
}): LocalRunLayout {
  const baseDir = path.resolve(params.outputDir, '.wanman-local', params.runId)
  fs.rmSync(baseDir, { recursive: true, force: true })
  fs.mkdirSync(baseDir, { recursive: true })

  const configPath = path.join(baseDir, 'agents.json')
  const workspaceRoot = path.join(baseDir, 'agents')
  const sharedSkillsDir = path.join(baseDir, 'shared-skills')
  const gitRoot = path.resolve(params.gitRoot ?? params.projectDir ?? params.root ?? process.cwd())
  const localizedConfigText = localizeRunConfigForHost(params.configText, baseDir, workspaceRoot, gitRoot)

  fs.writeFileSync(configPath, localizedConfigText)
  fs.mkdirSync(workspaceRoot, { recursive: true })
  fs.mkdirSync(sharedSkillsDir, { recursive: true })

  if (params.projectDir) {
    copyAgentWorkspace(path.join(params.projectDir, 'agents'), workspaceRoot)
    if (params.root) {
      copyDirectoryContents(path.join(params.root, 'packages/core/skills'), sharedSkillsDir)
    } else if (params.embedded) {
      writeEmbeddedSharedSkills(params.embedded, sharedSkillsDir)
    }
    copyDirectoryContents(path.join(params.projectDir, 'skills'), sharedSkillsDir)
  } else if (params.root) {
    copyAgentWorkspace(path.join(params.root, 'packages/core/agents'), workspaceRoot)
    copyDirectoryContents(path.join(params.root, 'packages/core/skills'), sharedSkillsDir)
  } else if (params.embedded) {
    writeEmbeddedAgentWorkspace(params.embedded, workspaceRoot)
    writeEmbeddedSharedSkills(params.embedded, sharedSkillsDir)
  }
  writeMissingAgentGuides(localizedConfigText, workspaceRoot)

  return {
    baseDir,
    configPath,
    workspaceRoot,
    sharedSkillsDir,
    gitRoot,
    cleanup() {
      fs.rmSync(baseDir, { recursive: true, force: true })
    },
  }
}

function getDb9Token(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env['DB9_TOKEN']) return env['DB9_TOKEN']
  try {
    return execSync('db9 token show 2>/dev/null', { encoding: 'utf-8' }).trim() || undefined
  } catch {
    return undefined
  }
}

export function resolveSelectedConfigName(
  projectDir: string | null | undefined,
  opts: RunOptions,
): string {
  if (opts.configPath) return path.basename(opts.configPath)
  if (projectDir) return 'agents.json (project)'
  return DEFAULT_RUN_CONFIG_NAME
}

export function getSelectedConfigText(
  projectDir: string | null | undefined,
  opts: RunOptions,
): string {
  if (opts.configPath) {
    return fs.readFileSync(path.resolve(opts.configPath), 'utf-8')
  }

  if (projectDir) {
    return fs.readFileSync(path.join(projectDir, 'agents.json'), 'utf-8')
  }

  return createDefaultLocalRunConfigText(opts)
}

function getRunOutputDir(outputDir: string, brainName?: string): string {
  const dirName = brainName || `run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
  return path.resolve(outputDir, dirName)
}

function exportBrainArtifacts(localDir: string, brainName?: string): void {
  if (!brainName) return
  try {
    const out = execSync(
      `db9 db sql $(db9 db list --json 2>/dev/null | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));const f=d.find(x=>x.name==='${brainName}');if(f)process.stdout.write(f.id)") -q "SELECT * FROM artifacts ORDER BY created_at" --json 2>/dev/null`,
      { encoding: 'utf-8', timeout: 15_000 },
    )
    const artifactsPath = path.join(localDir, 'brain-artifacts.json')
    fs.writeFileSync(artifactsPath, out)
    const count = JSON.parse(out).length
    console.log(`  Exported ${count} brain artifacts → brain-artifacts.json`)
  } catch {
    // db might not exist
  }
}

async function exportTasks(runtime: RuntimeClient, localDir: string): Promise<void> {
  try {
    const tasks = await runtime.listTasks()
    if (tasks.length > 0) {
      const tasksPath = path.join(localDir, 'tasks.json')
      fs.writeFileSync(tasksPath, JSON.stringify(tasks, null, 2))
      console.log(`  Saved ${tasks.length} tasks → tasks.json`)
    }
  } catch {
    // supervisor might be down
  }
}

/** @internal exported for testing */
export async function downloadLocalDeliverables(
  runtime: RuntimeClient,
  outputDir: string,
  workspaceRoot: string,
  brainName?: string,
): Promise<void> {
  console.log('\n  Downloading deliverables...')
  const localDir = getRunOutputDir(outputDir, brainName)
  const hasFiles = fs.existsSync(workspaceRoot)
    && execSync(`find '${workspaceRoot}' -type f 2>/dev/null | head -1`, { encoding: 'utf-8' }).trim()

  if (!hasFiles) {
    console.log('  No deliverable files found.')
    return
  }

  fs.rmSync(localDir, { recursive: true, force: true })
  fs.cpSync(workspaceRoot, localDir, {
    recursive: true,
    force: true,
    dereference: false,
  })
  const fileCount = execSync(`find '${localDir}' -type f | wc -l`, { encoding: 'utf-8' }).trim()
  console.log(`  Downloaded ${fileCount} files → ${localDir}`)
  exportBrainArtifacts(localDir, brainName)
  await exportTasks(runtime, localDir)
}

/** @internal exported for testing */
export async function downloadLocalRepoPatch(
  outputDir: string,
  repoRoot: string,
  brainName?: string,
): Promise<void> {
  const localDir = getRunOutputDir(outputDir, brainName)
  fs.mkdirSync(localDir, { recursive: true })

  const status = execSync(`git -C '${repoRoot}' status --short`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (!status.trim()) {
    return
  }

  const diff = execSync(`git -C '${repoRoot}' diff --binary`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
  const cachedDiff = execSync(`git -C '${repoRoot}' diff --cached --binary`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
  fs.writeFileSync(path.join(localDir, 'repo-status.txt'), status)
  if (diff.trim()) {
    fs.writeFileSync(path.join(localDir, 'repo.patch'), diff)
  }
  if (cachedDiff.trim()) {
    fs.writeFileSync(path.join(localDir, 'repo-staged.patch'), cachedDiff)
  }
  console.log(`  Exported repo patch → ${localDir}`)
}

async function recordRunInBrain(runId: string, goal: string, brainName?: string): Promise<void> {
  if (!brainName) return
  try {
    const dbId = execSync(
      `db9 --json db list 2>/dev/null | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));const f=d.find(x=>x.name==='${brainName}');if(f)process.stdout.write(f.id)"`,
      { encoding: 'utf-8', timeout: 10_000 },
    ).trim()
    if (dbId) {
      execSync(
        `db9 db sql ${dbId} -q "INSERT INTO runs (id, goal, config) VALUES ('${runId}', '${goal.replace(/'/g, "''")}', '{}') ON CONFLICT (id) DO NOTHING" 2>/dev/null`,
        { timeout: 10_000 },
      )
    }
  } catch {
    // best-effort
  }
}

export function buildRunKickoffPayload(goal: string): string {
  return [
    `Run kickoff for goal: ${goal}.`,
    'If the backlog is empty, decompose the goal immediately into the first 3-5 concrete tasks and assign them to the right agents.',
    'Use `wanman task create` right away, and include `--path` or `--pattern` for code/docs work to keep scopes clean.',
    'Do not wait for another prompt before creating the initial backlog.',
  ].join(' ')
}

/** @internal exported for testing */
export async function maybeSendRunKickoff(runtime: RuntimeClient, goal: string, from = 'run-bootstrap'): Promise<boolean> {
  const tasks = await runtime.listTasks().catch(() => [])
  if (tasks.length > 0) return false
  await runtime.sendMessage({
    from,
    to: 'ceo',
    type: 'message',
    priority: 'steer',
    payload: buildRunKickoffPayload(goal),
  }).catch(() => undefined)
  return true
}

/** @internal exported for testing */
export async function observeExecutionBackend(params: {
  backend: LocalSupervisorHandle
  goal: string
  opts: RunOptions
  spec: ProjectRunSpec
  runId: string
  workspaceRoot: string
  brainName?: string
  hooks?: ExecutionHooks
  shouldStop?: () => boolean
}): Promise<{ finalLoop: number; finalTasks: TaskInfo[] }> {
  const { backend, goal, opts, spec, runId, workspaceRoot, brainName, hooks } = params
  const runtime = backend.runtime

  if (!hooks?.afterHealthy) {
    await maybeSendRunKickoff(runtime, goal)
  }

  if (hooks?.afterHealthy) {
    await hooks.afterHealthy({
      backend,
      runtime,
      goal,
      opts,
      spec,
      runId,
      workspaceRoot,
      brainName,
    })
  }

  const loopEventsPath = path.join(opts.output, 'loop-events.ndjson')
  fs.mkdirSync(opts.output, { recursive: true })

  const eventBus = new LoopEventBus(runId)
  const loopLogger = new LoopLogger({
    ndjsonPath: loopEventsPath,
    bufferCapacity: 1000,
  })
  loopLogger.attach(eventBus)

  const heartbeatPath = path.join(opts.output, '.wanman', 'heartbeat.json')
  const heartbeat = new Heartbeat(heartbeatPath, runId)
  heartbeat.start(10_000)

  await recordRunInBrain(runId, goal, brainName)

  const startTime = Date.now()
  let logCursor = 0
  const logBuffer: string[] = []
  const maxLogLines = 20
  const doneObserveLoops = 5
  let doneStreak = 0
  let errorStreak = 0
  let prevTasks: TaskInfo[] = []
  let finalLoop = 0

  for (let loop = 1; loop <= opts.loops; loop++) {
    finalLoop = loop
    if (params.shouldStop?.()) break

    let agents: HealthAgent[] = []
    try {
      const health = await runtime.getHealth()
      agents = health.agents
    } catch {
      // ignore
    }

    const tasks = await runtime.listTasks().catch(() => [])
    const nextLogs = await backend.readLogs(logCursor)
    logCursor = nextLogs.cursor
    for (const line of nextLogs.lines) {
      logBuffer.push(line)
      if (logBuffer.length > maxLogLines * 2) logBuffer.splice(0, logBuffer.length - maxLogLines)
    }

    let artifactSummary: RuntimeArtifact[] = []
    if (brainName) {
      try {
        const out = execSync(
          `db9 db sql $(db9 db list --json 2>/dev/null | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));const f=d.find(x=>x.name==='${brainName}');if(f)process.stdout.write(f.id)") -q "SELECT agent, kind, count(*) as cnt FROM artifacts GROUP BY agent, kind ORDER BY agent" --json 2>/dev/null`,
          { encoding: 'utf-8', timeout: 10_000 },
        )
        artifactSummary = JSON.parse(out)
      } catch {
        // db might not exist yet
      }
    }

    const state: DashboardState = {
      goal,
      loop,
      maxLoops: opts.loops,
      elapsed: Date.now() - startTime,
      brainName,
      agents,
      tasks,
      logs: logBuffer.slice(-maxLogLines),
      artifacts: artifactSummary,
    }
    renderDashboard(state)

    if (hooks?.afterPoll || hooks?.shouldStop) {
      const pollContext: PollExecutionContext = {
        backend,
        runtime,
        goal,
        opts,
        spec,
        runId,
        workspaceRoot,
        brainName,
        loop,
        startTime,
        agents,
        tasks,
        logs: logBuffer.slice(-maxLogLines),
      }
      if (hooks.afterPoll) {
        await hooks.afterPoll(pollContext)
      }
      if (hooks.shouldStop && await hooks.shouldStop(pollContext)) {
        console.log('\n  Hook requested stop. Exiting.')
        break
      }
    }

    eventBus.tick()
    heartbeat.tick()
    loopLogger.updateTaskSnapshot(tasks.length, tasks.filter(task => task.status === 'done').length)

    const transitions = countTransitions(prevTasks, tasks)
    if (transitions > 0) {
      for (const task of tasks) {
        const previous = prevTasks.find(item => item.id === task.id)
        if (previous && previous.status !== task.status) {
          eventBus.emit({
            type: 'task.transition', runId, loop: eventBus.currentLoop,
            taskId: parseInt(task.id, 10) || 0,
            assignee: task.assignee, from: previous.status, to: task.status,
            timestamp: new Date().toISOString(),
          })
        }
      }
      for (const task of tasks) {
        if (!prevTasks.find(item => item.id === task.id)) {
          eventBus.emit({
            type: 'task.transition', runId, loop: eventBus.currentLoop,
            taskId: parseInt(task.id, 10) || 0,
            assignee: task.assignee, from: '(new)', to: task.status,
            timestamp: new Date().toISOString(),
          })
        }
      }
    }

    for (const agent of agents) {
      if (agent.state === 'running') {
        eventBus.emit({
          type: 'agent.spawned', runId, loop: eventBus.currentLoop,
          agent: agent.name,
          lifecycle: agent.lifecycle as '24/7' | 'on-demand',
          trigger: loop === 1 ? 'startup' : 'message',
          timestamp: new Date().toISOString(),
        })
      }
    }

    const classified = eventBus.classify(agents.map(agent => ({
      name: agent.name,
      state: agent.state,
      lifecycle: agent.lifecycle,
    })))
    const classification = classified.classification
    const reasons = classified.reasons

    const snapshot: LoopSnapshot = {
      loop,
      timestamp: new Date().toISOString(),
      elapsed: Date.now() - startTime,
      classification: classification as LoopClassification,
      reasons,
      tasks: tasks.map(task => ({ id: task.id, title: task.title, status: task.status, assignee: task.assignee })),
      taskTransitions: transitions,
      agents: agents.map(agent => ({ name: agent.name, state: agent.state, lifecycle: agent.lifecycle })),
    }
    try { fs.appendFileSync(loopEventsPath + '.legacy', JSON.stringify(snapshot) + '\n') } catch { /* best-effort */ }
    prevTasks = tasks

    const doneCount = tasks.filter(task => task.status === 'done').length
    if (!opts.infinite && classification === 'idle' && tasks.length > 0 && doneCount === tasks.length && loop > 10) {
      doneStreak++
      const remaining = doneObserveLoops - doneStreak
      if (remaining > 0) {
        console.log(`\n  All ${doneCount} tasks done. Observing ${remaining} more loops...`)
      } else {
        console.log(`\n  All ${doneCount} tasks done for ${doneObserveLoops} consecutive polls. Exiting.`)
        break
      }
    } else {
      doneStreak = 0
    }

    if (opts.infinite && classification === 'error') {
      errorStreak++
      if (errorStreak >= opts.errorLimit) {
        console.log(`\n  ${errorStreak} consecutive error loops. Exiting infinite mode.`)
        break
      }
    } else if (classification !== 'error') {
      errorStreak = 0
    }

    if (loop < opts.loops) {
      await new Promise(resolve => setTimeout(resolve, opts.pollInterval * 1000))
    }
  }

  heartbeat.stop()
  loopLogger.detach(eventBus)
  eventBus.removeAllListeners()

  console.log('\n  Run complete.')

  try {
    const lines = fs.readFileSync(path.join(opts.output, 'loop-events.ndjson'), 'utf-8').trim().split('\n')
    const classifiedEvents = lines
      .map(line => { try { return JSON.parse(line) } catch { return null } })
      .filter(event => event?.type === 'loop.classified')
    const counts: Record<string, number> = { productive: 0, idle: 0, blocked: 0, backlog_stuck: 0, error: 0 }
    for (const event of classifiedEvents) {
      counts[event.classification] = (counts[event.classification] ?? 0) + 1
    }
    const total = classifiedEvents.length
    const rate = total > 0 ? Math.round(((counts.productive ?? 0) / total) * 100) : 0
    console.log(`  Loop summary: ${total} loops, ${counts.productive} productive (${rate}%), ${counts.idle} idle, ${counts.blocked} blocked`)
  } catch {
    // best-effort
  }

  const finalTasks = await runtime.listTasks().catch(() => [])
  const tasksCreated = finalTasks.length
  const tasksDone = finalTasks.filter(task => task.status === 'done').length
  const completionRate = tasksCreated > 0 ? Math.round((tasksDone / tasksCreated) * 100) : 0
  console.log(`  Tasks: ${tasksDone}/${tasksCreated} done (${completionRate}% completion rate)`)
  console.log(`  NDJSON: ${path.join(opts.output, 'loop-events.ndjson')}`)
  if (fs.existsSync(path.join(opts.output, 'results.tsv'))) {
    console.log(`  results.tsv: ${path.join(opts.output, 'results.tsv')}`)
  }
  if (fs.existsSync(path.join(opts.output, '.wanman', 'heartbeat.json'))) {
    console.log(`  Heartbeat: ${path.join(opts.output, '.wanman', 'heartbeat.json')}`)
  }

  try {
    const meta = {
      goal,
      maxLoops: opts.loops,
      actualLoops: finalLoop,
      startTime: new Date(startTime).toISOString(),
      endTime: new Date().toISOString(),
      brainName: brainName ?? null,
    }
    fs.writeFileSync(path.join(opts.output, 'meta.json'), JSON.stringify(meta, null, 2))
  } catch {
    // best-effort
  }

  return { finalLoop, finalTasks }
}

export async function runExecutionSession(
  goal: string,
  opts: RunOptions,
  spec: ProjectRunSpec = {},
  bindings: RunExecutionBindings = {},
): Promise<void> {
  const hostEnv = bindings.hostEnv ?? process.env
  const launchPlan = createRunLaunchPlan(opts, spec)
  const { projectDir, localGitRoot } = launchPlan
  const hooks = spec.hooks

  const root = findProjectRoot()
  const embedded = root ? null : await getEmbeddedAssets()
  const standalone = !root && !!embedded

  if (root) loadEnvFile(root, hostEnv)

  const db9Token = opts.noBrain ? undefined : getDb9Token(hostEnv)
  const configName = resolveSelectedConfigName(projectDir, opts)
  const configText = getSelectedConfigText(projectDir, opts)
  const sessionPlan = createRunSessionPlan({
    goal,
    opts,
    launchPlan,
    configName,
    configText,
    standalone,
    db9Token,
    env: hostEnv,
  })
  const {
    brainName,
    runId,
    runtimeOverride,
    codexConfigLabel,
    runtimeLabel,
    llmModeLabel,
  } = sessionPlan
  const sourceLabel = spec.sourceLabel ?? sessionPlan.sourceLabel

  console.log(`
  ┌─────────────────────────────────────────────────┐
  │  wanman run                                     │
  ├─────────────────────────────────────────────────┤
  │  Goal:   ${goal.slice(0, 40).padEnd(40)}│
  │  Loops:  ${(opts.infinite ? '∞ (infinite)' : String(opts.loops)).padEnd(40)}│
  │  Config: ${configName.padEnd(40)}│
  │  Source: ${sourceLabel.padEnd(40)}│
  │  Brain:  ${(brainName ?? 'disabled').padEnd(40)}│
  │  Runtime:${runtimeLabel.padEnd(40)}│
  │  LLM:    ${llmModeLabel.padEnd(40)}│
${codexConfigLabel ? `  │  Codex:  ${codexConfigLabel.padEnd(40)}│\n` : ''}  └─────────────────────────────────────────────────┘
`)

  if (root) {
    console.log('  [1/4] Checking builds...')
    buildIfNeeded(root)
  } else {
    console.log('  [1/4] Skip build (no monorepo)')
  }

  console.log('  [2/4] Preparing local workspace...')
  const localLayout = materializeLocalRunLayout({
    runId,
    outputDir: opts.output,
    projectDir,
    root,
    embedded,
    configText,
    gitRoot: localGitRoot,
  })
  await runLocalExecution({
    goal,
    opts,
    spec,
    runId,
    localLayout,
    runtime: {
      runtime: runtimeOverride === 'codex' ? 'codex' : runtimeOverride === 'claude' ? 'claude' : undefined,
      codexModel: opts.codexModel,
      codexReasoningEffort: opts.codexReasoningEffort,
    },
    brainName,
    hooks,
    observeExecution: observeExecutionBackend,
    downloadDeliverables: downloadLocalDeliverables,
    downloadRepoPatch: downloadLocalRepoPatch,
  })
}
