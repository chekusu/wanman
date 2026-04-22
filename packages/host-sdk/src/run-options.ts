import type { AgentRuntime } from '@wanman/core'

export interface RunOptions {
  loops: number
  pollInterval: number
  runtime?: AgentRuntime
  codexModel?: string
  codexReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
  configPath?: string
  projectDir?: string
  workerUrl?: string
  workerModel?: string
  workerKey?: string
  noBrain: boolean
  keep: boolean
  output: string
  infinite: boolean
  errorLimit: number
}

export function createDefaultRunOptions(): RunOptions {
  return {
    loops: 100,
    pollInterval: 15,
    runtime: undefined,
    codexModel: undefined,
    codexReasoningEffort: undefined,
    configPath: undefined,
    projectDir: undefined,
    workerUrl: undefined,
    workerModel: undefined,
    workerKey: 'lmstudio',
    noBrain: false,
    keep: false,
    output: './deliverables',
    infinite: false,
    errorLimit: 20,
  }
}

export function createRunOptions(overrides: Partial<RunOptions> = {}): RunOptions {
  const options = {
    ...createDefaultRunOptions(),
    ...overrides,
  }

  if (options.infinite) options.loops = Infinity

  return options
}

export function createTakeoverRunOptions(overrides: Partial<RunOptions> = {}): RunOptions {
  return createRunOptions({
    infinite: true,
    loops: Infinity,
    ...overrides,
  })
}
