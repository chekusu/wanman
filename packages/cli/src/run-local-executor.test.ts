import { describe, expect, it, vi } from 'vitest'
import type { RunLocalSupervisorSessionParams } from './local-supervisor-session.js'
import { runLocalExecution, type LocalRunExecutorParams } from './run-local-executor.js'

const runLocalSupervisorSessionMock = vi.hoisted(() => vi.fn())

vi.mock('./local-supervisor-session.js', () => ({
  runLocalSupervisorSession: runLocalSupervisorSessionMock,
}))

function makeParams(overrides: Partial<LocalRunExecutorParams> = {}): LocalRunExecutorParams {
  return {
    goal: 'ship',
    opts: {
      loops: 1,
      pollInterval: 0,
      output: '/tmp/out',
      keep: false,
      noBrain: true,
      infinite: false,
      errorLimit: 3,
    },
    spec: {},
    runId: 'run-1',
    localLayout: {
      baseDir: '/tmp/run',
      configPath: '/tmp/run/agents.json',
      workspaceRoot: '/tmp/run/agents',
      gitRoot: '/tmp/repo',
      sharedSkillsDir: '/tmp/run/skills',
      cleanup: vi.fn(),
    },
    runtime: {
      runtime: 'codex',
      codexModel: 'gpt-test',
      codexReasoningEffort: 'high',
    },
    hooks: {},
    observeExecution: vi.fn().mockResolvedValue(undefined),
    downloadDeliverables: vi.fn().mockResolvedValue(undefined),
    downloadRepoPatch: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('runLocalExecution', () => {
  it('runs observation, downloads outputs, and cleans up when the supervisor stops', async () => {
    const params = makeParams()
    runLocalSupervisorSessionMock.mockImplementationOnce(async (session: RunLocalSupervisorSessionParams) => {
      const context = {
        supervisor: { endpoint: 'http://127.0.0.1:3333' },
        runtime: { listTasks: vi.fn() },
        child: {},
        port: 3333,
        endpoint: 'http://127.0.0.1:3333',
        entrypoint: '/tmp/entrypoint.js',
        isShuttingDown: () => false,
      }
      await session.onStarted?.(context as never)
      await session.onHealthy?.(context as never)
      await session.run(context as never)
      await session.onStopped?.(context as never, 'completed')
    })

    await runLocalExecution(params)

    expect(runLocalSupervisorSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      supervisor: expect.objectContaining({
        configPath: '/tmp/run/agents.json',
        workspaceRoot: '/tmp/run/agents',
        gitRoot: '/tmp/repo',
        runtime: 'codex',
        codexModel: 'gpt-test',
      }),
      signalMode: 'exit_process',
    }))
    expect(params.observeExecution).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1',
      workspaceRoot: '/tmp/run/agents',
    }))
    expect(params.downloadDeliverables).toHaveBeenCalledWith(expect.any(Object), '/tmp/out', '/tmp/run/agents', undefined)
    expect(params.downloadRepoPatch).toHaveBeenCalledWith('/tmp/out', '/tmp/repo', undefined)
    expect(params.localLayout.cleanup).toHaveBeenCalled()
  })

  it('exports best-effort outputs when the supervisor session reports an error', async () => {
    const params = makeParams()
    const previousExitCode = process.exitCode
    runLocalSupervisorSessionMock.mockImplementationOnce(async (session: RunLocalSupervisorSessionParams) => {
      await session.onError?.(new Error('boom'), {
        runtime: { listTasks: vi.fn() },
      } as never)
    })

    await runLocalExecution(params)

    expect(process.exitCode).toBe(1)
    expect(params.downloadDeliverables).toHaveBeenCalled()
    expect(params.downloadRepoPatch).toHaveBeenCalled()
    process.exitCode = previousExitCode
  })
})
