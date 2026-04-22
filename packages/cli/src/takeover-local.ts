import * as fs from 'node:fs'
import * as path from 'node:path'
import { execSync } from 'node:child_process'
import logUpdate from 'log-update'
import type { RunOptions } from './execution-session.js'
import { runLocalSupervisorSession } from './local-supervisor-session.js'
import {
  createTakeoverCoordinationBackend,
  ensureMissionBoard,
  listDevWorkers,
  maybeNudgeMissionControl,
  maybeScaleWorkforce,
  type MissionNudgeState,
  planDynamicClone,
  sendKickoffSteer,
} from './takeover-coordination.js'
import {
  type RuntimeArtifact,
  type RuntimeCapsule,
  type RuntimeClient,
  type RuntimeHealth,
  type RuntimeInitiative,
  type TaskInfo,
} from './runtime-client.js'
import {
  type GeneratedAgentConfig,
  type ProjectIntent,
  type ProjectProfile,
  type TakeoverRuntimePaths,
  writeTakeoverOverlayFiles,
} from './takeover-project.js'
import { formatDashboard, renderDashboard, type DashboardState } from './tui/dashboard.js'

const MAX_DEV_WORKERS = 3

export interface LocalObservationState {
  health: RuntimeHealth
  tasks: TaskInfo[]
  initiatives: RuntimeInitiative[]
  capsules: RuntimeCapsule[]
  artifacts: RuntimeArtifact[]
  logs: string[]
  activeBranch?: string
  branchAhead: number
  hasUpstream: boolean
  prUrl?: string
  modifiedFiles: string[]
}

interface LocalGitState {
  activeBranch?: string
  branchAhead: number
  branchBehind: number
  hasUpstream: boolean
  modifiedFiles: string[]
}

interface LocalPrNudgeState {
  lastSignature?: string
  lastSentAt?: number
}

type LocalMissionNudgeState = MissionNudgeState

/** @internal exported for testing */
export function warnLocalEnvironment(profile: ProjectProfile, worktreePath: string): void {
  const warnings: string[] = []

  try {
    execSync('command -v node', { stdio: 'ignore', shell: '/bin/bash' })
  } catch {
    warnings.push('`node` is not available in the current environment')
  }

  if (profile.packageManagers.includes('pnpm')) {
    try {
      execSync('command -v pnpm', { stdio: 'ignore', shell: '/bin/bash' })
    } catch {
      warnings.push('project expects `pnpm`, but it is not available in PATH')
    }
  }

  const hostCli = path.join(profile.path, 'packages/cli/dist/index.js')
  const hostRuntime = path.join(profile.path, 'packages/runtime/dist/entrypoint.js')
  if (!fs.existsSync(hostCli)) warnings.push(`missing built CLI entrypoint: ${hostCli}`)
  if (!fs.existsSync(hostRuntime)) warnings.push(`missing built runtime entrypoint: ${hostRuntime}`)

  const hostNodeModules = path.join(profile.path, 'node_modules')
  const worktreeNodeModules = path.join(worktreePath, 'node_modules')
  if (!fs.existsSync(hostNodeModules) && !fs.existsSync(worktreeNodeModules)) {
    warnings.push('no node_modules found in host repo or worktree; agent verification commands may fail')
  }

  if (warnings.length === 0) return

  console.log('  [local] Environment warnings:')
  for (const warning of warnings) {
    console.log(`    - ${warning}`)
  }
  console.log('  [local] Continuing without reinstalling dependencies. Local mode reuses the host environment.')
}

function snapshotTasks(tasks: Array<{ id: string; status: string; assignee?: string; initiativeId?: string; capsuleId?: string }>): string {
  return JSON.stringify(tasks.map(task => ({
    id: task.id,
    status: task.status,
    initiativeId: task.initiativeId,
    capsuleId: task.capsuleId,
  })))
}

function snapshotBoard<T extends { id: string; status: string }>(items: T[]): string {
  return JSON.stringify(items.map(item => ({
    id: item.id,
    status: item.status,
  })))
}

function snapshotArtifacts(artifacts: RuntimeArtifact[]): string {
  return JSON.stringify(
    artifacts
      .map(artifact => ({
        agent: artifact.agent,
        kind: artifact.kind,
        cnt: artifact.cnt,
      }))
      .sort((left, right) => `${left.agent}:${left.kind}`.localeCompare(`${right.agent}:${right.kind}`)),
  )
}

function snapshotWorktree(state: Pick<LocalObservationState, 'activeBranch' | 'branchAhead' | 'hasUpstream' | 'prUrl' | 'modifiedFiles'>): string {
  return JSON.stringify({
    activeBranch: state.activeBranch,
    branchAhead: state.branchAhead,
    hasUpstream: state.hasUpstream,
    prUrl: state.prUrl,
    modifiedFiles: [...state.modifiedFiles].sort(),
  })
}

export function parseLocalGitStatus(raw: string): LocalGitState {
  const state: LocalGitState = {
    activeBranch: undefined,
    branchAhead: 0,
    branchBehind: 0,
    hasUpstream: false,
    modifiedFiles: [],
  }

  const seenFiles = new Set<string>()
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue

    if (line.startsWith('# branch.head ')) {
      const branch = line.slice('# branch.head '.length).trim()
      state.activeBranch = branch && branch !== '(detached)' ? branch : undefined
      continue
    }

    if (line.startsWith('# branch.upstream ')) {
      state.hasUpstream = true
      continue
    }

    if (line.startsWith('# branch.ab ')) {
      const match = line.match(/^# branch\.ab \+(\d+) -(\d+)$/)
      if (match) {
        state.branchAhead = Number.parseInt(match[1] ?? '0', 10)
        state.branchBehind = Number.parseInt(match[2] ?? '0', 10)
      }
      continue
    }

    const changedPath = extractPorcelainPath(line)
    if (changedPath && !seenFiles.has(changedPath)) {
      seenFiles.add(changedPath)
      state.modifiedFiles.push(changedPath)
    }
  }

  return state
}

async function detectPullRequestUrl(worktreePath: string, branch?: string): Promise<string | undefined> {
  if (!branch) return undefined
  try {
    const raw = execSync(`gh pr list --head ${JSON.stringify(branch)} --json url --limit 1`, {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as Array<{ url?: string }>
    return parsed[0]?.url
  } catch {
    return undefined
  }
}

function extractPorcelainPath(line: string): string | undefined {
  if (line.startsWith('? ') || line.startsWith('! ')) {
    return line.slice(2).trim() || undefined
  }

  const ordinary = line.match(/^1 [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.+)$/)
  if (ordinary) return ordinary[1]?.trim() || undefined

  const renamed = line.match(/^2 [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.+)$/)
  if (renamed) {
    return renamed[1]?.split('\t')[0]?.trim() || undefined
  }

  const unmerged = line.match(/^u [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.+)$/)
  if (unmerged) return unmerged[1]?.trim() || undefined

  return undefined
}

async function readLocalGitState(worktreePath: string): Promise<LocalGitState> {
  try {
    const raw = execSync('git status --porcelain=v2 --branch --untracked-files=all', {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return parseLocalGitStatus(raw)
  } catch {
    return {
      activeBranch: undefined,
      branchAhead: 0,
      branchBehind: 0,
      hasUpstream: false,
      modifiedFiles: [],
    }
  }
}

/** @internal exported for testing */
export function buildLocalDashboardState(
  goal: string,
  observedLoops: number,
  maxLoops: number,
  startedAt: number,
  state: LocalObservationState,
): DashboardState {
  return {
    goal,
    loop: Math.max(observedLoops, 1),
    maxLoops: Math.max(maxLoops, 1),
    elapsed: Date.now() - startedAt,
    brainName: state.prUrl ? `PR: ${state.prUrl}` : state.activeBranch,
    agents: state.health.agents.map(agent => ({
      name: agent.name,
      state: agent.state,
      lifecycle: agent.lifecycle,
    })),
    tasks: state.tasks,
    logs: state.logs,
    artifacts: state.artifacts,
  }
}

/** @internal exported for testing */
export function appendLogLines(buffer: string[], lines: string[], maxLines = 200): void {
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    buffer.push(trimmed)
  }
  if (buffer.length > maxLines) buffer.splice(0, buffer.length - maxLines)
}

/** @internal exported for testing */
export async function collectLocalObservationState(
  runtime: RuntimeClient,
  worktreePath: string,
  logLines: string[],
): Promise<LocalObservationState> {
  const health = await runtime.getHealth()
  const tasks = await runtime.listTasks().catch(() => [])
  const initiatives = await runtime.listInitiatives().catch(() => [])
  const capsules = await runtime.listCapsules().catch(() => [])
  const artifacts = await runtime.listArtifacts().catch(() => [])
  const gitState = await readLocalGitState(worktreePath)
  const prUrl = await detectPullRequestUrl(worktreePath, gitState.activeBranch)
  return {
    health,
    tasks,
    initiatives,
    capsules,
    artifacts,
    logs: logLines.slice(-50),
    activeBranch: gitState.activeBranch,
    branchAhead: gitState.branchAhead,
    hasUpstream: gitState.hasUpstream,
    prUrl,
    modifiedFiles: gitState.modifiedFiles,
  }
}

export function hasLocalProgress(previous: LocalObservationState, current: LocalObservationState): boolean {
  if (snapshotTasks(previous.tasks) !== snapshotTasks(current.tasks)) return true
  if (snapshotBoard(previous.initiatives) !== snapshotBoard(current.initiatives)) return true
  if (snapshotBoard(previous.capsules) !== snapshotBoard(current.capsules)) return true
  if (snapshotArtifacts(previous.artifacts) !== snapshotArtifacts(current.artifacts)) return true
  return snapshotWorktree(previous) !== snapshotWorktree(current)
}

function createLoggedLocalCoordinationBackend(runtime: RuntimeClient) {
  return createTakeoverCoordinationBackend(runtime, {
    log: message => {
      console.log(`  [local] ${message}`)
    },
  })
}

export function planLocalDynamicClone(state: LocalObservationState) {
  return planDynamicClone(
    state.tasks,
    listDevWorkers(state.health.agents.map(agent => agent.name)),
    MAX_DEV_WORKERS,
  )
}

async function maybeScaleLocalWorkforce(runtime: RuntimeClient, state: LocalObservationState): Promise<boolean> {
  return maybeScaleWorkforce(
    createLoggedLocalCoordinationBackend(runtime),
    state.tasks,
    listDevWorkers(state.health.agents.map(agent => agent.name)),
    'takeover-allocator',
    MAX_DEV_WORKERS,
  )
}

function isTakeoverFeatureBranch(branch?: string): boolean {
  return !!branch && /^(wanman|fix|feat|chore|docs)\//.test(branch)
}

/** @internal exported for testing */
export function collectPrNudgeRecipients(state: LocalObservationState): string[] {
  const recipients = new Set<string>()
  for (const task of state.tasks) {
    if (!task.assignee) continue
    if (task.status === 'done') continue
    if (task.assignee === 'dev' || task.assignee === 'devops' || /^dev-\d+$/.test(task.assignee)) {
      recipients.add(task.assignee)
    }
  }
  recipients.add('ceo')
  return [...recipients]
}

/** @internal exported for testing */
export function buildPrNudgeSignature(state: LocalObservationState): string {
  return JSON.stringify({
    branch: state.activeBranch ?? null,
    branchAhead: state.branchAhead,
    hasUpstream: state.hasUpstream,
    modifiedFiles: state.modifiedFiles,
    recipients: collectPrNudgeRecipients(state),
    tasks: state.tasks
      .filter(task => task.assignee && (task.assignee === 'dev' || task.assignee === 'devops' || /^dev-\d+$/.test(task.assignee)))
      .map(task => ({ id: task.id, status: task.status, assignee: task.assignee })),
  })
}

async function maybeNudgeLocalMissionControl(
  runtime: RuntimeClient,
  state: LocalObservationState,
  intent: ProjectIntent,
  nudgeState: LocalMissionNudgeState,
): Promise<boolean> {
  return maybeNudgeMissionControl(
    createLoggedLocalCoordinationBackend(runtime),
    intent,
    state.tasks,
    nudgeState,
    'takeover-mission-control',
  )
}

/** @internal exported for testing */
export async function maybeNudgeLocalPrExecution(
  runtime: RuntimeClient,
  state: LocalObservationState,
  nudgeState: LocalPrNudgeState,
): Promise<boolean> {
  if (state.prUrl) return false

  const onFeatureBranch = isTakeoverFeatureBranch(state.activeBranch)
  const hasDirtyFiles = state.modifiedFiles.length > 0
  const hasLocalCommitsToPush = state.branchAhead > 0
  const hasBranchReadyForPr = onFeatureBranch && state.hasUpstream
  if (!hasDirtyFiles && !hasLocalCommitsToPush && !hasBranchReadyForPr) return false

  const recipients = collectPrNudgeRecipients(state)
  if (recipients.length === 0) return false

  const signature = buildPrNudgeSignature(state)
  const now = Date.now()
  if (nudgeState.lastSignature === signature && now - (nudgeState.lastSentAt ?? 0) < 90_000) {
    return false
  }

  const summary = state.modifiedFiles.slice(0, 6).join(', ')
  const contextLines: string[] = []
  if (hasDirtyFiles) {
    contextLines.push(`Modified files: ${summary}${state.modifiedFiles.length > 6 ? ', ...' : ''}.`)
  }
  if (hasLocalCommitsToPush) {
    contextLines.push(`Current branch is ahead of origin by ${state.branchAhead} commit${state.branchAhead === 1 ? '' : 's'}.`)
  }
  if (hasBranchReadyForPr && !hasDirtyFiles && !hasLocalCommitsToPush) {
    contextLines.push(`Feature branch ${state.activeBranch} is pushed to origin but still has no PR.`)
  }

  const nextAction = onFeatureBranch
    ? 'Immediately commit any remaining verified changes, push the task branch to origin, create a PR with coverage notes, then notify cto with the PR URL.'
    : 'Immediately switch from detached HEAD to a task branch (`wanman/<task-slug>`), commit the verified changes, push to origin, create a PR with coverage notes, then notify cto with the PR URL.'
  const payload = [
    'Takeover has implementation progress but no PR exists yet.',
    ...contextLines,
    nextAction,
    'Do not leave validated work without a branch, commit, push, and PR.',
  ].join(' ')

  for (const to of recipients) {
    await runtime.sendMessage({
      from: 'takeover-pr-allocator',
      to,
      type: 'message',
      payload,
      priority: 'steer',
    }).catch(() => undefined)
  }

  nudgeState.lastSignature = signature
  nudgeState.lastSentAt = now
  console.log(`  [local] PR nudge: sent branch/commit/PR steer to ${recipients.join(', ')}`)
  return true
}

export function materializeLocalTakeoverProject(
  profile: ProjectProfile,
  generated: GeneratedAgentConfig,
  opts?: { enableBrain?: boolean },
): string {
  const wanmanDir = path.join(profile.path, '.wanman')
  const worktreePath = path.join(wanmanDir, 'worktree')

  execSync('git worktree prune', {
    cwd: profile.path,
    stdio: 'pipe',
  })
  const currentHead = execSync('git rev-parse --verify HEAD', {
    cwd: profile.path,
    encoding: 'utf-8',
  }).trim()
  fs.rmSync(worktreePath, { recursive: true, force: true })
  execSync(`git worktree add --detach -f "${worktreePath}" ${currentHead}`, {
    cwd: profile.path,
    stdio: 'pipe',
  })
  console.log(`  [local] Created git worktree at ${worktreePath}`)

  const localRuntimePaths: TakeoverRuntimePaths = {
    projectRoot: worktreePath,
    sharedSkillPath: path.join(wanmanDir, 'skills', 'takeover-context', 'SKILL.md'),
    cliCommand: 'wanman',
    localMode: true,
  }

  writeTakeoverOverlayFiles(profile, generated, {
    baseDir: wanmanDir,
    agentsDir: path.join(wanmanDir, 'agents'),
    skillsDir: path.join(wanmanDir, 'skills', 'takeover-context'),
    configPath: path.join(wanmanDir, 'agents.json'),
    workspaceRoot: path.join(wanmanDir, 'agents'),
    gitRoot: worktreePath,
    dbPath: path.join(wanmanDir, 'wanman.db'),
    runtimePaths: localRuntimePaths,
    enableBrain: opts?.enableBrain,
  })

  return wanmanDir
}

export async function runLocal(
  profile: ProjectProfile,
  generated: GeneratedAgentConfig,
  wanmanDir: string,
  opts: RunOptions,
): Promise<void> {
  const configPath = path.join(wanmanDir, 'agents.json')
  const agentsDir = path.join(wanmanDir, 'agents')
  const worktreePath = path.join(wanmanDir, 'worktree')
  const liveDashboardPath = path.join(wanmanDir, 'live-dashboard.txt')
  const sharedSkillsDir = path.join(wanmanDir, 'skills')
  fs.writeFileSync(liveDashboardPath, 'takeover starting...\n')
  warnLocalEnvironment(profile, worktreePath)

  console.log('\n  Starting supervisor locally...')
  console.log(`  Config:     ${configPath}`)
  console.log(`  Workspace:  ${agentsDir}`)
  console.log(`  Git root:   ${worktreePath}`)
  console.log(`  Runtime:    ${generated.runtime}`)
  if (generated.runtime === 'codex') {
    const codexModel = opts.codexModel ?? process.env['WANMAN_CODEX_MODEL'] ?? process.env['WANMAN_MODEL'] ?? 'default'
    const codexEffort = opts.codexReasoningEffort ?? process.env['WANMAN_CODEX_REASONING_EFFORT'] ?? 'default'
    console.log(`  Codex:      ${codexModel} / ${codexEffort}`)
  }
  await runLocalSupervisorSession({
    supervisor: {
      configPath,
      workspaceRoot: agentsDir,
      gitRoot: worktreePath,
      sharedSkillsDir,
      homeRoot: wanmanDir,
      goal: generated.goal,
      runtime: generated.runtime,
      codexModel: opts.codexModel,
      codexReasoningEffort: opts.codexReasoningEffort,
    },
    keep: opts.keep,
    signalMode: 'forward_only',
    onStarted: ({ entrypoint, port }) => {
      console.log(`  Entrypoint: ${entrypoint}`)
      console.log(`  Port:       ${port}`)
    },
    onHealthy: ({ port }) => {
      console.log(`  Supervisor healthy on http://127.0.0.1:${port}`)
    },
    onStopped: () => {
      if (process.stdout.isTTY) logUpdate.clear()
    },
    onKeptAlive: () => {
      if (process.stdout.isTTY) logUpdate.clear()
    },
    run: async ({ supervisor, runtime, child, port }) => {
      const coordinationBackend = createLoggedLocalCoordinationBackend(runtime)
      await ensureMissionBoard(coordinationBackend, profile, generated.intent)
      await sendKickoffSteer(coordinationBackend, generated.intent, 'local-takeover-bootstrap')

      const startedAt = Date.now()
      let observedLoops = 0
      let idlePolls = 0
      let logCursor = 0
      const localLogs: string[] = []
      const initialLogs = await supervisor.readLogs(logCursor)
      logCursor = initialLogs.cursor
      appendLogLines(localLogs, initialLogs.lines)
      let previous = await collectLocalObservationState(runtime, worktreePath, localLogs)
      let lastProgressAt = Date.now()
      const prNudgeState: LocalPrNudgeState = {}
      const missionNudgeState: LocalMissionNudgeState = {}
      let lastPrintedSnapshot = ''
      let childExitCode: number | null = null
      let childError: Error | null = null
      child.on('error', err => { childError = err })
      child.on('close', code => { childExitCode = code ?? 0 })
      const maxIdleMs = opts.infinite
        ? 10 * 60 * 1000
        : Math.max(opts.loops * opts.pollInterval * 30 * 1000, 180_000)

      while (opts.infinite || observedLoops < opts.loops) {
        await new Promise(resolve => setTimeout(resolve, opts.pollInterval * 1000))
        const nextLogs = await supervisor.readLogs(logCursor)
        logCursor = nextLogs.cursor
        appendLogLines(localLogs, nextLogs.lines)
        let current = await collectLocalObservationState(runtime, worktreePath, localLogs)
        const nudgedMission = await maybeNudgeLocalMissionControl(runtime, current, generated.intent, missionNudgeState).catch(() => false)
        if (nudgedMission) current = await collectLocalObservationState(runtime, worktreePath, localLogs)
        const scaled = await maybeScaleLocalWorkforce(runtime, current).catch(() => false)
        if (scaled) current = await collectLocalObservationState(runtime, worktreePath, localLogs)
        const nudgedPr = await maybeNudgeLocalPrExecution(runtime, current, prNudgeState).catch(() => false)
        if (nudgedPr) current = await collectLocalObservationState(runtime, worktreePath, localLogs)
        const progressed = hasLocalProgress(previous, current)
        const dashboardMaxLoops = opts.infinite ? Math.max(observedLoops, 1) : opts.loops
        const dashboardState = buildLocalDashboardState(
          `takeover: ${path.basename(profile.path)}`,
          observedLoops,
          dashboardMaxLoops,
          startedAt,
          current,
        )
        const dashboardSnapshot = formatDashboard(dashboardState)
        fs.writeFileSync(liveDashboardPath, `${dashboardSnapshot}\n`)
        if (process.stdout.isTTY) {
          renderDashboard(dashboardState)
        }

        if (current.prUrl) {
          if (process.stdout.isTTY) logUpdate.clear()
          console.log(`\n  [local] Pull request created: ${current.prUrl}`)
          previous = current
          break
        }

        if (progressed) {
          observedLoops++
          idlePolls = 0
          lastProgressAt = Date.now()
          const done = current.tasks.filter(task => task.status === 'done').length
          const runId = current.health.loop?.runId ?? 'unknown'
          const completedRuns = current.health.runtime?.completedRuns ?? 0
          if (!process.stdout.isTTY) {
            const loopLabel = opts.infinite ? observedLoops : `${observedLoops}/${opts.loops}`
            console.log(`  [local] Loop ${loopLabel}: ${current.tasks.length} task(s), ${done} done, ${completedRuns} completed run(s), runId=${runId}`)
            if (dashboardSnapshot !== lastPrintedSnapshot) {
              console.log(dashboardSnapshot)
              lastPrintedSnapshot = dashboardSnapshot
            }
          }
        } else {
          idlePolls++
          if (!process.stdout.isTTY && idlePolls % Math.max(1, Math.ceil(15 / opts.pollInterval)) === 0) {
            const completedRuns = current.health.runtime?.completedRuns ?? 0
            console.log(`  [local] Waiting for progress: ${current.tasks.length} task(s), ${completedRuns} completed run(s)`)
            if (dashboardSnapshot !== lastPrintedSnapshot) {
              console.log(dashboardSnapshot)
              lastPrintedSnapshot = dashboardSnapshot
            }
          }
          if (Date.now() - lastProgressAt >= maxIdleMs) {
            throw new Error(`Local takeover made no observable progress for ${Math.round(maxIdleMs / 1000)}s on port ${port}`)
          }
        }
        if (childError) throw childError
        if (childExitCode !== null && childExitCode !== 0) {
          throw new Error(`Supervisor exited with code ${childExitCode}`)
        }
        if (childExitCode === 0 && opts.infinite) {
          if (process.stdout.isTTY) logUpdate.clear()
          console.log('\n  [local] Supervisor exited cleanly before a PR was created')
          break
        }
        previous = current
      }
    },
  })
}
