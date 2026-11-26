import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  buildRunBrainName,
  createRunSessionPlan,
  createRunLaunchPlan,
  getRunSourceLabel,
  resolveRequestedProjectDir,
} from './run-orchestrator.js'

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    existsSync: vi.fn(),
    statSync: vi.fn(),
  }
})

const mockExistsSync = vi.mocked(fs.existsSync)
const mockStatSync = vi.mocked(fs.statSync)

describe('run orchestrator helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('validates and resolves the requested project directory', () => {
    mockExistsSync.mockReturnValue(true)
    mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats)

    const result = resolveRequestedProjectDir('./tmp/project')

    expect(result).toBe(path.resolve('./tmp/project'))
  })

  it('derives launch defaults for the local git root', () => {
    mockExistsSync.mockReturnValue(true)
    mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats)

    const plan = createRunLaunchPlan(
      { projectDir: './tmp/project' },
      { projectDir: '/tmp/overlay' },
    )

    expect(plan.requestedProjectDir).toBe(path.resolve('./tmp/project'))
    expect(plan.projectDir).toBe('/tmp/overlay')
    expect(plan.repoSourceDir).toBe(path.resolve('./tmp/project'))
    expect(plan.localGitRoot).toBe(path.resolve('./tmp/project'))
  })

  it('respects explicit git root and repo source overrides', () => {
    const plan = createRunLaunchPlan(
      { projectDir: undefined },
      {
        repoSourceDir: '/tmp/source',
        gitRoot: '/tmp/source',
      },
    )

    expect(plan.repoSourceDir).toBe('/tmp/source')
    expect(plan.localGitRoot).toBe('/tmp/source')
  })

  it('describes the resolved run source consistently', () => {
    expect(getRunSourceLabel({ projectDir: '/tmp/overlay', requestedProjectDir: '/tmp/source' }, { standalone: false })).toBe('project (overlay)')
    expect(getRunSourceLabel({ projectDir: undefined, requestedProjectDir: '/tmp/source' }, { standalone: false })).toBe('working dir (source)')
    expect(getRunSourceLabel({ projectDir: undefined, requestedProjectDir: undefined }, { standalone: true })).toBe('standalone')
    expect(getRunSourceLabel({ projectDir: undefined, requestedProjectDir: undefined }, { standalone: false })).toBe('monorepo')
  })

  it('builds a run session plan from launch context and environment', () => {
    const plan = createRunSessionPlan({
      goal: 'Launch the moonshot beta',
      opts: {
        runtime: undefined,
        codexModel: undefined,
        codexReasoningEffort: undefined,
        workerUrl: undefined,
      },
      launchPlan: {
        projectDir: '/tmp/overlay',
        requestedProjectDir: '/tmp/source',
      },
      configName: 'agents.json (project)',
      configText: JSON.stringify({
        agents: [
          { name: 'ceo', lifecycle: '24/7', runtime: 'codex' },
        ],
      }),
      standalone: false,
      db9Token: 'db9-token',
      env: {
        ANTHROPIC_BASE_URL: 'https://api.example.com',
        WANMAN_CODEX_MODEL: 'gpt-5.4',
      },
    })

    expect(plan.configName).toBe('agents.json (project)')
    expect(plan.sourceLabel).toBe('project (overlay)')
    expect(plan.useThirdPartyApi).toBe(true)
    expect(plan.useHybrid).toBe(false)
    expect(plan.requiredRuntimes).toEqual(['codex'])
    expect(plan.runtimeLabel).toBe('codex')
    expect(plan.llmModeLabel).toBe('codex-cli')
    expect(plan.codexConfigLabel).toBe('gpt-5.4 / default')
    expect(plan.brainName).toMatch(/^wanman-run-/)
    expect(plan.runId).toBe(plan.brainName)
  })

  it('isolates two runs of the same goal started at the same time', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-06-01T10:00:00Z'))
      const first = buildRunBrainName('Launch beta now')
      expect(first).toMatch(/^wanman-run-/)
      expect(buildRunBrainName('Launch beta now')).not.toBe(first)
    } finally {
      vi.useRealTimers()
    }
  })
})
