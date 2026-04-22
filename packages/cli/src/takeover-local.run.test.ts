import * as fs from 'node:fs'
import * as path from 'node:path'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunLocalSupervisorSessionParams } from './local-supervisor-session.js'
import type { GeneratedAgentConfig, ProjectProfile } from './takeover-project.js'

const execSyncMock = vi.hoisted(() => vi.fn())
const runLocalSupervisorSessionMock = vi.hoisted(() => vi.fn())
const renderDashboardMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  execSync: execSyncMock,
}))

vi.mock('./local-supervisor-session.js', () => ({
  runLocalSupervisorSession: runLocalSupervisorSessionMock,
}))

vi.mock('./tui/dashboard.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./tui/dashboard.js')>()
  return {
    ...actual,
    renderDashboard: renderDashboardMock,
  }
})

import { runLocal } from './takeover-local.js'

describe('runLocal', () => {
  const tmpDirs: string[] = []

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'wanman-run-local-'))
    tmpDirs.push(dir)
    return dir
  }

  it('runs the local takeover loop until a PR is observed', async () => {
    const project = makeTmpDir()
    const wanmanDir = path.join(project, '.wanman')
    const worktree = path.join(wanmanDir, 'worktree')
    fs.mkdirSync(path.join(project, 'packages', 'cli', 'dist'), { recursive: true })
    fs.mkdirSync(path.join(project, 'packages', 'runtime', 'dist'), { recursive: true })
    fs.mkdirSync(path.join(project, 'node_modules'), { recursive: true })
    fs.mkdirSync(path.join(wanmanDir, 'agents'), { recursive: true })
    fs.mkdirSync(path.join(wanmanDir, 'skills'), { recursive: true })
    fs.mkdirSync(worktree, { recursive: true })
    fs.writeFileSync(path.join(project, 'packages', 'cli', 'dist', 'index.js'), '')
    fs.writeFileSync(path.join(project, 'packages', 'runtime', 'dist', 'entrypoint.js'), '')
    fs.writeFileSync(path.join(wanmanDir, 'agents.json'), JSON.stringify({ agents: [] }))

    const prResponses = [
      '[]',
      JSON.stringify([{ url: 'https://github.com/acme/app/pull/7' }]),
    ]
    execSyncMock.mockImplementation((command: string) => {
      if (command.includes('command -v')) return ''
      if (command.includes('git status --porcelain')) {
        return [
          '# branch.head wanman/task',
          '# branch.upstream origin/wanman/task',
          '# branch.ab +1 -0',
          '1 .M N... 100644 100644 100644 abc abc src/app.ts',
        ].join('\n')
      }
      if (command.includes('gh pr list')) return prResponses.shift() ?? prResponses.at(-1) ?? '[]'
      return ''
    })

    runLocalSupervisorSessionMock.mockImplementation(async (params: RunLocalSupervisorSessionParams) => {
      const child = new EventEmitter()
      const tasks = [{ id: '1', title: 'Implement', status: 'done', assignee: 'dev', priority: 1, initiativeId: 'i1', capsuleId: 'c1' }]
      const runtime = {
        getHealth: vi.fn().mockResolvedValue({
          agents: [{ name: 'ceo', state: 'idle', lifecycle: '24/7' }],
          runtime: { completedRuns: 1 },
          loop: { runId: 'run-1' },
        }),
        listTasks: vi.fn()
          .mockResolvedValueOnce([])
          .mockResolvedValue(tasks),
        listInitiatives: vi.fn().mockResolvedValue([{ id: 'i1', status: 'active', title: 'Core' }]),
        listCapsules: vi.fn().mockResolvedValue([{ id: 'c1', status: 'open', goal: 'Patch' }]),
        listArtifacts: vi.fn().mockResolvedValue([{ agent: 'dev', kind: 'patch', cnt: 1 }]),
        createInitiative: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        spawnAgent: vi.fn().mockResolvedValue(undefined),
        updateTask: vi.fn().mockResolvedValue(undefined),
      }
      const supervisor = {
        readLogs: vi.fn()
          .mockResolvedValueOnce({ lines: ['boot'], cursor: 1 })
          .mockResolvedValue({ lines: ['ready'], cursor: 2 }),
      }
      const context = {
        supervisor,
        runtime,
        child,
        port: 3333,
        endpoint: 'http://127.0.0.1:3333',
        entrypoint: '/tmp/entrypoint.js',
        isShuttingDown: () => false,
      }

      await params.onStarted?.(context as never)
      await params.onHealthy?.(context as never)
      await params.run(context as never)
      await params.onStopped?.(context as never, 'completed')

      expect(runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        from: 'local-takeover-bootstrap',
        to: 'ceo',
        priority: 'steer',
      }))
    })

    const profile: ProjectProfile = {
      path: project,
      languages: ['typescript'],
      packageManagers: ['pnpm'],
      frameworks: [],
      ci: [],
      testFrameworks: [],
      hasReadme: true,
      hasClaudeMd: false,
      hasDocs: false,
      issueTracker: 'github',
      githubRemote: 'https://github.com/acme/app.git',
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
      agents: [],
    }

    await runLocal(profile, generated, wanmanDir, {
      loops: 3,
      pollInterval: 0,
      output: path.join(project, 'out'),
      keep: false,
      noBrain: true,
      infinite: false,
      errorLimit: 3,
      runtime: 'codex',
      codexModel: 'gpt-test',
      codexReasoningEffort: 'medium',
    })

    expect(runLocalSupervisorSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      supervisor: expect.objectContaining({
        configPath: path.join(wanmanDir, 'agents.json'),
        gitRoot: worktree,
        runtime: 'codex',
        codexModel: 'gpt-test',
      }),
      keep: false,
      signalMode: 'forward_only',
    }))
    expect(fs.readFileSync(path.join(wanmanDir, 'live-dashboard.txt'), 'utf-8')).toContain('Implement')
  })
})
