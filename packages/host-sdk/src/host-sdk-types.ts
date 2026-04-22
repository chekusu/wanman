import type { AgentRuntime } from '@wanman/core'
import type { RunOptions } from './run-options.js'

export interface WanmanHostSdkConfig {
  env?: NodeJS.ProcessEnv
}

export type WanmanHostRunOptions = Partial<RunOptions>

export interface WanmanHostTakeoverOptions {
  projectPath: string
  goalOverride?: string
  runtime?: AgentRuntime
  githubToken?: string
  enableBrain?: boolean
}

export type WanmanHostRunInvocation = RunOptions | WanmanHostRunOptions

export interface WanmanHostSdk<
  TProjectRunSpec = unknown,
  TPreparedTakeoverPlan = unknown,
  TTakeoverInvocation = WanmanHostTakeoverOptions,
> {
  run(goal: string, options?: WanmanHostRunInvocation, spec?: TProjectRunSpec): Promise<void>
  prepareTakeover(options: TTakeoverInvocation): TPreparedTakeoverPlan
  executePreparedTakeover(
    plan: TPreparedTakeoverPlan,
    options?: WanmanHostRunInvocation,
  ): Promise<void>
  takeover(
    options: TTakeoverInvocation,
    runOptions?: WanmanHostRunInvocation,
  ): Promise<void>
}
