import * as fs from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalObservationState } from './takeover-local.js'
import {
  appendLogLines,
  buildLocalDashboardState,
  buildPrNudgeSignature,
  collectPrNudgeRecipients,
  hasLocalProgress,
  materializeLocalTakeoverProject,
  maybeNudgeLocalPrExecution,
  parseLocalGitStatus,
  planLocalDynamicClone,
} from './takeover-local.js'
import type { GeneratedAgentConfig, ProjectProfile } from './takeover-project.js'

function makeState(overrides: Partial<LocalObservationState> = {}): LocalObservationState {
  return {
    health: {
      agents: [
        { name: 'ceo', state: 'idle', lifecycle: '24/7' },
        { name: 'dev', state: 'idle', lifecycle: 'on-demand' },
        { name: 'dev-1', state: 'idle', lifecycle: 'on-demand' },
      ],
    },
    tasks: [],
    initiatives: [],
    capsules: [],
    artifacts: [],
    logs: [],
    activeBranch: undefined,
    branchAhead: 0,
    hasUpstream: false,
    prUrl: undefined,
    modifiedFiles: [],
    ...overrides,
  }
}

describe('parseLocalGitStatus', () => {
  it('extracts branch state and changed paths from porcelain v2 output', () => {
    const state = parseLocalGitStatus([
      '# branch.head wanman/task',
      '# branch.upstream origin/wanman/task',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 abc abc src/app.ts',
      '2 R. N... 100644 100644 100644 abc abc R100 src/new.ts\tsrc/old.ts',
      'u UU N... 100644 100644 100644 100644 abc abc abc conflicted.ts',
      '? notes.md',
      '! ignored.log',
    ].join('\n'))

    expect(state).toEqual({
      activeBranch: 'wanman/task',
      branchAhead: 2,
      branchBehind: 1,
      hasUpstream: true,
      modifiedFiles: ['src/app.ts', 'src/new.ts', 'conflicted.ts', 'notes.md', 'ignored.log'],
    })
  })

  it('treats detached heads as no active branch', () => {
    expect(parseLocalGitStatus('# branch.head (detached)\n').activeBranch).toBeUndefined()
  })
})

describe('local takeover progress helpers', () => {
  it('detects progress across task, board, artifact, and worktree snapshots', () => {
    const previous = makeState({
      tasks: [{ id: '1', title: 'Task', status: 'todo', assignee: 'dev', priority: 1 }],
    })

    expect(hasLocalProgress(previous, makeState({
      tasks: [{ id: '1', title: 'Task', status: 'done', assignee: 'dev', priority: 1 }],
    }))).toBe(true)
    expect(hasLocalProgress(previous, makeState({
      tasks: previous.tasks,
      initiatives: [{ id: 'i1', title: 'Initiative', status: 'active' }],
    }))).toBe(true)
    expect(hasLocalProgress(previous, makeState({
      tasks: previous.tasks,
      artifacts: [{ agent: 'dev', kind: 'patch', cnt: 1 }],
    }))).toBe(true)
    expect(hasLocalProgress(previous, makeState({
      tasks: previous.tasks,
      modifiedFiles: ['src/app.ts'],
    }))).toBe(true)
    expect(hasLocalProgress(previous, makeState({ tasks: previous.tasks }))).toBe(false)
  })

  it('plans dynamic dev clones only when backlog needs more workers', () => {
    const plan = planLocalDynamicClone(makeState({
      health: {
        agents: [{ name: 'ceo', state: 'idle', lifecycle: '24/7' }],
      },
      tasks: [
        { id: '1', title: 'A', status: 'todo', assignee: 'dev', priority: 1 },
        { id: '2', title: 'B', status: 'todo', assignee: 'dev', priority: 1 },
        { id: '3', title: 'C', status: 'todo', assignee: 'dev', priority: 1 },
      ],
    }))

    expect(plan?.clonesToSpawn).toEqual(['dev-2', 'dev-3'])
    expect(plan?.reassignments).toEqual([
      { taskId: '2', taskTitle: 'B', assignee: 'dev-2' },
      { taskId: '3', taskTitle: 'C', assignee: 'dev-3' },
    ])
  })

  it('keeps a bounded trimmed local log buffer', () => {
    const lines: string[] = ['old']

    appendLogLines(lines, [' first ', '', 'second', 'third'], 3)

    expect(lines).toEqual(['first', 'second', 'third'])
  })

  it('builds dashboard state from local observation state', () => {
    const state = buildLocalDashboardState('takeover: app', 0, 0, Date.now(), makeState({
      activeBranch: 'wanman/task',
      prUrl: 'https://github.com/acme/app/pull/1',
      tasks: [{ id: '1', title: 'Task', status: 'done', assignee: 'dev', priority: 1 }],
      logs: ['ready'],
      artifacts: [{ agent: 'dev', kind: 'patch', cnt: 1 }],
    }))

    expect(state.loop).toBe(1)
    expect(state.maxLoops).toBe(1)
    expect(state.brainName).toBe('PR: https://github.com/acme/app/pull/1')
    expect(state.agents.map(agent => agent.name)).toEqual(['ceo', 'dev', 'dev-1'])
    expect(state.tasks).toHaveLength(1)
    expect(state.artifacts).toHaveLength(1)
  })
})

describe('maybeNudgeLocalPrExecution', () => {
  it('steers implementers and mission control when progress has no PR', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const state = makeState({
      activeBranch: 'wanman/task',
      branchAhead: 2,
      hasUpstream: true,
      modifiedFiles: ['src/app.ts', 'src/test.ts'],
      tasks: [
        { id: '1', title: 'Implement', status: 'todo', assignee: 'dev', priority: 1 },
        { id: '2', title: 'Review', status: 'in_progress', assignee: 'dev-1', priority: 1 },
        { id: '3', title: 'Done', status: 'done', assignee: 'devops', priority: 1 },
      ],
    })
    const nudgeState: { lastSignature?: string; lastSentAt?: number } = {}

    await expect(maybeNudgeLocalPrExecution({ sendMessage } as never, state, nudgeState)).resolves.toBe(true)

    expect(collectPrNudgeRecipients(state)).toEqual(['dev', 'dev-1', 'ceo'])
    expect(buildPrNudgeSignature(state)).toContain('wanman/task')
    expect(sendMessage).toHaveBeenCalledTimes(3)
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      from: 'takeover-pr-allocator',
      to: 'dev',
      priority: 'steer',
    }))
    expect(nudgeState.lastSignature).toBeDefined()

    await expect(maybeNudgeLocalPrExecution({ sendMessage } as never, state, nudgeState)).resolves.toBe(false)
    expect(sendMessage).toHaveBeenCalledTimes(3)
  })

  it('does not send PR nudges when a PR already exists or no branch work is ready', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined)

    await expect(maybeNudgeLocalPrExecution(
      { sendMessage } as never,
      makeState({ prUrl: 'https://github.com/acme/app/pull/1' }),
      {},
    )).resolves.toBe(false)
    await expect(maybeNudgeLocalPrExecution(
      { sendMessage } as never,
      makeState({ activeBranch: 'main', tasks: [{ id: '1', title: 'Task', status: 'todo', assignee: 'dev', priority: 1 }] }),
      {},
    )).resolves.toBe(false)

    expect(sendMessage).not.toHaveBeenCalled()
  })
})

describe('materializeLocalTakeoverProject', () => {
  const tmpDirs: string[] = []

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'wanman-takeover-project-'))
    tmpDirs.push(dir)
    return dir
  }

  it('creates a local worktree and writes local-mode takeover overlay files', () => {
    const repo = makeTmpDir()
    execGit(repo, 'init')
    execGit(repo, 'config user.email test@example.com')
    execGit(repo, 'config user.name Test')
    fs.writeFileSync(path.join(repo, 'README.md'), '# App\n')
    execGit(repo, 'add README.md')
    execGit(repo, 'commit -m init')

    const profile: ProjectProfile = {
      path: repo,
      languages: ['typescript'],
      packageManagers: [],
      frameworks: [],
      ci: [],
      testFrameworks: [],
      hasReadme: true,
      hasClaudeMd: false,
      hasDocs: false,
      issueTracker: 'none',
      readmeExcerpt: 'App',
      codeRoots: ['src'],
      packageScripts: ['test'],
    }
    const generated: GeneratedAgentConfig = {
      runtime: 'codex',
      goal: 'Ship project',
      intent: {
        projectName: 'app',
        summary: 'Ship project',
        canonicalDocs: [],
        roadmapDocs: [],
        codeRoots: ['src'],
        packageScripts: ['test'],
        strategicThemes: ['quality'],
        mission: 'Ship project',
      },
      agents: [
        {
          name: 'ceo',
          lifecycle: '24/7',
          runtime: 'codex',
          model: 'high',
          systemPromptHint: 'Lead',
          enabled: true,
          reason: 'test',
        },
      ],
    }

    const wanmanDir = materializeLocalTakeoverProject(profile, generated)

    expect(wanmanDir).toBe(path.join(repo, '.wanman'))
    expect(fs.existsSync(path.join(wanmanDir, 'worktree', 'README.md'))).toBe(true)
    expect(fs.readFileSync(path.join(wanmanDir, 'agents', 'ceo', 'AGENT.md'), 'utf-8')).toContain('CEO Takeover Agent')
    const agentsConfig = JSON.parse(fs.readFileSync(path.join(wanmanDir, 'agents.json'), 'utf-8')) as {
      gitRoot: string
      agents: Array<{ model: string }>
    }
    expect(agentsConfig.gitRoot).toBe(path.join(wanmanDir, 'worktree'))
    expect(agentsConfig.agents[0]?.model).toBe('high')
    expect(fs.readFileSync(path.join(wanmanDir, 'skills', 'takeover-context', 'SKILL.md'), 'utf-8')).toContain('Ship project')
  })
})

function execGit(cwd: string, args: string): void {
  execSync(`git ${args}`, { cwd, stdio: 'ignore' })
}
