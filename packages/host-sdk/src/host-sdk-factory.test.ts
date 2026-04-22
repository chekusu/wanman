import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEnvBackedWanmanHostSdk, createWanmanHostSdk, type WanmanHostSdkAdapters } from './host-sdk-factory.js'

interface ConcreteTakeoverOptions {
  projectPath: string
  goalOverride?: string
  runtime: 'claude' | 'codex'
  githubToken?: string
  enableBrain: boolean
}

const preparedLaunch = {
  id: 'launch-1',
}

const adapters = vi.hoisted(() => ({
  runGoal: vi.fn(),
  prepareTakeoverLaunch: vi.fn(),
  executePreparedTakeoverLaunch: vi.fn(),
}))

const hostSdkAdapters: WanmanHostSdkAdapters<Record<string, never>, typeof preparedLaunch, ConcreteTakeoverOptions> = {
  runGoal: adapters.runGoal,
  prepareTakeoverLaunch: adapters.prepareTakeoverLaunch,
  executePreparedTakeoverLaunch: adapters.executePreparedTakeoverLaunch,
  normalizeTakeoverOptions(options) {
    if ('runtime' in options && typeof options.runtime === 'string') {
      return options as ConcreteTakeoverOptions
    }

    return {
      projectPath: options.projectPath,
      goalOverride: options.goalOverride,
      runtime: (options.runtime as 'claude' | 'codex' | undefined) ?? 'claude',
      githubToken: options.githubToken,
      enableBrain: options.enableBrain ?? true,
    }
  },
}

describe('createWanmanHostSdk', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    adapters.prepareTakeoverLaunch.mockReturnValue(preparedLaunch)
  })

  it('runs with baseline defaults', async () => {
    const sdk = createWanmanHostSdk({}, hostSdkAdapters)

    await sdk.run('ship the feature')

    expect(adapters.runGoal).toHaveBeenCalledWith(
      'ship the feature',
      expect.objectContaining({
        loops: 100,
        output: './deliverables',
      }),
      {},
      expect.objectContaining({
        hostEnv: expect.any(Object),
      }),
    )
  })

  it('merges caller overrides on top of defaults', async () => {
    const sdk = createWanmanHostSdk({}, hostSdkAdapters)

    await sdk.run('debug locally', { keep: true })

    expect(adapters.runGoal).toHaveBeenCalledWith(
      'debug locally',
      expect.objectContaining({
        keep: true,
        loops: 100,
      }),
      {},
      expect.any(Object),
    )
  })

  it('normalizes takeover launches around infinite defaults', async () => {
    const sdk = createWanmanHostSdk({}, hostSdkAdapters)

    const launch = sdk.prepareTakeover({
      projectPath: '/repo',
      goalOverride: 'stabilize release',
    })
    await sdk.executePreparedTakeover(launch)

    expect(adapters.prepareTakeoverLaunch).toHaveBeenCalledWith({
      projectPath: '/repo',
      goalOverride: 'stabilize release',
      runtime: 'claude',
      githubToken: undefined,
      enableBrain: true,
    })
    expect(adapters.executePreparedTakeoverLaunch).toHaveBeenCalledWith(
      preparedLaunch,
      expect.objectContaining({
        infinite: true,
        loops: Infinity,
      }),
      expect.any(Object),
    )
  })
})

describe('createEnvBackedWanmanHostSdk', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('threads the provided env through to the host bindings', async () => {
    const sdk = createEnvBackedWanmanHostSdk(
      {
        CUSTOM_VAR: 'custom-value',
      },
      {},
      hostSdkAdapters,
    )

    await sdk.run('deploy')

    expect(adapters.runGoal).toHaveBeenCalledWith(
      'deploy',
      expect.any(Object),
      {},
      expect.objectContaining({
        hostEnv: expect.objectContaining({
          CUSTOM_VAR: 'custom-value',
        }),
      }),
    )
  })
})
