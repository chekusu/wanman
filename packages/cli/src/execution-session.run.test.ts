import * as fs from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalRunExecutorParams } from './run-local-executor.js'

const execSyncMock = vi.hoisted(() => vi.fn(() => ''))
const runLocalExecutionMock = vi.hoisted(() => vi.fn())
const renderDashboardMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  execSync: execSyncMock,
}))

vi.mock('./run-local-executor.js', () => ({
  runLocalExecution: runLocalExecutionMock,
}))

vi.mock('./tui/dashboard.js', () => ({
  renderDashboard: renderDashboardMock,
}))

import { observeExecutionBackend, runExecutionSession } from './execution-session.js'

describe('runExecutionSession', () => {
  const tmpDirs: string[] = []

  beforeEach(() => {
    vi.clearAllMocks()
    execSyncMock.mockReturnValue('')
  })

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'wanman-run-session-'))
    tmpDirs.push(dir)
    return dir
  }

  it('materializes a local run and observes the supervisor through the local executor', async () => {
    const output = makeTmpDir()
    let capturedParams: LocalRunExecutorParams | undefined

    runLocalExecutionMock.mockImplementation(async (params: LocalRunExecutorParams) => {
      capturedParams = params
      const taskStates = [
        [],
        [{ id: '1', title: 'Draft plan', status: 'todo', assignee: 'dev' }],
        [{ id: '1', title: 'Draft plan', status: 'done', assignee: 'dev' }],
        [{ id: '1', title: 'Draft plan', status: 'done', assignee: 'dev' }],
      ]
      const runtime = {
        getHealth: vi.fn().mockResolvedValue({
          agents: [{ name: 'ceo', state: 'running', lifecycle: '24/7' }],
          runtime: { completedRuns: 1 },
          loop: { runId: params.runId },
        }),
        listTasks: vi.fn(async () => taskStates.shift() ?? taskStates.at(-1) ?? []),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      }
      const backend = {
        runtime,
        readLogs: vi.fn(async (cursor: number) => ({
          lines: [`log ${cursor + 1}`],
          cursor: cursor + 1,
        })),
      }

      await params.observeExecution({
        backend: backend as never,
        goal: params.goal,
        opts: params.opts,
        spec: params.spec,
        runId: params.runId,
        workspaceRoot: params.localLayout.workspaceRoot,
        brainName: params.brainName,
        hooks: params.hooks,
        shouldStop: () => false,
      })

      expect(runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        from: 'run-bootstrap',
        to: 'ceo',
        priority: 'steer',
      }))
    })

    await runExecutionSession('Ship the open source run path', {
      loops: 2,
      pollInterval: 0,
      output,
      keep: false,
      noBrain: true,
      infinite: false,
      errorLimit: 3,
      runtime: 'codex',
      codexModel: 'gpt-test',
      codexReasoningEffort: 'high',
    }, {
      sourceLabel: 'test',
    }, {
      hostEnv: {
        PATH: process.env['PATH'],
        WANMAN_RUNTIME: 'claude',
      },
    })

    expect(capturedParams).toBeDefined()
    expect(capturedParams?.runtime).toEqual({
      runtime: 'codex',
      codexModel: 'gpt-test',
      codexReasoningEffort: 'high',
    })
    expect(capturedParams?.brainName).toBeUndefined()
    expect(capturedParams?.localLayout.configPath.endsWith('agents.json')).toBe(true)
    expect(fs.existsSync(capturedParams!.localLayout.configPath)).toBe(true)

    const config = JSON.parse(fs.readFileSync(capturedParams!.localLayout.configPath, 'utf-8')) as {
      agents: Array<{ name: string; model: string; runtime?: string }>
      workspaceRoot: string
      gitRoot: string
    }
    expect(config.agents.map(agent => agent.model)).toEqual(['high', 'standard', 'standard'])
    expect(config.agents.every(agent => agent.runtime === 'codex')).toBe(true)
    expect(config.workspaceRoot).toBe(capturedParams?.localLayout.workspaceRoot)
    expect(fs.existsSync(path.join(capturedParams!.localLayout.workspaceRoot, 'ceo', 'AGENT.md'))).toBe(true)
    expect(fs.existsSync(path.join(output, 'loop-events.ndjson'))).toBe(true)
    expect(fs.existsSync(path.join(output, 'meta.json'))).toBe(true)
    expect(renderDashboardMock).toHaveBeenCalled()
  })

  it('exports deliverables, task snapshots, and local repo patches from the local layout', async () => {
    const output = makeTmpDir()
    let workspaceFile = ''

    execSyncMock.mockImplementation((command = '') => {
      if (command.includes("-name '*.ts'")) return ''
      if (command.includes('-type f 2>/dev/null | head -1')) return `${workspaceFile}\n`
      if (command.includes('-type f | wc -l')) return '3\n'
      if (command.includes('status --short')) return ' M src/app.ts\n'
      if (command.includes('diff --cached')) return ''
      if (command.includes('diff --binary')) return 'diff --git a/src/app.ts b/src/app.ts\n'
      return ''
    })

    runLocalExecutionMock.mockImplementation(async (params: LocalRunExecutorParams) => {
      const devDir = path.join(params.localLayout.workspaceRoot, 'dev')
      fs.mkdirSync(devDir, { recursive: true })
      workspaceFile = path.join(devDir, 'output.txt')
      fs.writeFileSync(workspaceFile, 'done\n')
      const runtime = {
        listTasks: vi.fn().mockResolvedValue([
          { id: '1', title: 'Task', status: 'done', assignee: 'dev', priority: 1 },
        ]),
      }

      await params.downloadDeliverables(runtime as never, params.opts.output, params.localLayout.workspaceRoot)
      await params.downloadRepoPatch(params.opts.output, params.localLayout.gitRoot)
    })

    await runExecutionSession('Export run output', {
      loops: 1,
      pollInterval: 0,
      output,
      keep: false,
      noBrain: true,
      infinite: false,
      errorLimit: 3,
    }, {}, {
      hostEnv: { PATH: process.env['PATH'] },
    })

    const runDirs = fs.readdirSync(output).filter(entry => entry.startsWith('run-'))
    expect(runDirs).toHaveLength(1)
    const runDir = path.join(output, runDirs[0]!)
    expect(fs.readFileSync(path.join(runDir, 'dev', 'output.txt'), 'utf-8')).toBe('done\n')
    expect(JSON.parse(fs.readFileSync(path.join(runDir, 'tasks.json'), 'utf-8'))).toEqual([
      { id: '1', title: 'Task', status: 'done', assignee: 'dev', priority: 1 },
    ])
    expect(fs.readFileSync(path.join(runDir, 'repo-status.txt'), 'utf-8')).toContain('src/app.ts')
    expect(fs.readFileSync(path.join(runDir, 'repo.patch'), 'utf-8')).toContain('diff --git')
  })

  it('observes backend loops with hooks, dashboard state, transitions, and meta output', async () => {
    const output = makeTmpDir()
    const taskTodo = { id: '1', title: 'Draft plan', status: 'todo', assignee: 'dev' }
    const taskDone = { ...taskTodo, status: 'done' }
    const runtime = {
      getHealth: vi.fn()
        .mockResolvedValueOnce({ agents: [{ name: 'ceo', state: 'running', lifecycle: '24/7' }] })
        .mockResolvedValueOnce({ agents: [{ name: 'ceo', state: 'idle', lifecycle: '24/7' }] }),
      listTasks: vi.fn()
        .mockResolvedValueOnce([taskTodo])
        .mockResolvedValueOnce([taskDone])
        .mockResolvedValue([taskDone]),
      sendMessage: vi.fn(),
    }
    const backend = {
      runtime,
      readLogs: vi.fn(async (cursor: number) => ({
        lines: Array.from({ length: 25 }, (_, index) => `line ${cursor + index + 1}`),
        cursor: cursor + 25,
      })),
    }
    const afterHealthy = vi.fn(async () => undefined)
    const afterPoll = vi.fn(async () => undefined)
    const shouldStop = vi.fn(async (ctx: { loop: number }) => ctx.loop >= 2)

    const result = await observeExecutionBackend({
      backend: backend as never,
      goal: 'Observe hooks',
      opts: {
        loops: 5,
        pollInterval: 0,
        output,
        keep: false,
        noBrain: true,
        infinite: false,
        errorLimit: 3,
      },
      spec: { hooks: { afterHealthy, afterPoll, shouldStop } },
      runId: 'run-hooks',
      workspaceRoot: '/tmp/workspace',
      hooks: { afterHealthy, afterPoll, shouldStop },
    })

    expect(result.finalLoop).toBe(2)
    expect(afterHealthy).toHaveBeenCalledOnce()
    expect(afterPoll).toHaveBeenCalledTimes(2)
    expect(runtime.sendMessage).not.toHaveBeenCalled()
    expect(renderDashboardMock).toHaveBeenCalledWith(expect.objectContaining({
      logs: expect.arrayContaining(['line 50']),
    }))
    expect(fs.readFileSync(path.join(output, 'loop-events.ndjson'), 'utf-8')).toContain('task.transition')
    expect(JSON.parse(fs.readFileSync(path.join(output, 'meta.json'), 'utf-8')).actualLoops).toBe(2)
  })

  it('stops after completed tasks stay idle for the done observation window', async () => {
    const output = makeTmpDir()
    const doneTask = { id: '1', title: 'Done', status: 'done', assignee: 'dev' }
    const runtime = {
      getHealth: vi.fn().mockResolvedValue({ agents: [{ name: 'ceo', state: 'idle', lifecycle: '24/7' }] }),
      listTasks: vi.fn().mockResolvedValue([doneTask]),
      sendMessage: vi.fn(),
    }
    const backend = {
      runtime,
      readLogs: vi.fn(async (cursor: number) => ({ lines: [], cursor })),
    }

    const result = await observeExecutionBackend({
      backend: backend as never,
      goal: 'Finish',
      opts: {
        loops: 20,
        pollInterval: 0,
        output,
        keep: false,
        noBrain: true,
        infinite: false,
        errorLimit: 3,
      },
      spec: {},
      runId: 'run-done',
      workspaceRoot: '/tmp/workspace',
    })

    expect(result.finalLoop).toBe(15)
    expect(runtime.sendMessage).not.toHaveBeenCalled()
  })
})
