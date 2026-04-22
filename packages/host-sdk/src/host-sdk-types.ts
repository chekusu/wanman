import type { AgentRuntime } from '@wanman/core'
import type { RunOptions } from './run-options.js'

export type WanmanExecutionMode = 'sandbox' | 'local'

export interface WanmanHostSdkConfig {
  env?: NodeJS.ProcessEnv
  defaultMode?: WanmanExecutionMode
}

export interface WanmanHostRunOptions extends Partial<Omit<RunOptions, 'local'>> {
  mode?: WanmanExecutionMode
}

export interface WanmanHostTakeoverOptions {
  projectPath: string
  goalOverride?: string
  runtime?: AgentRuntime
  githubToken?: string
  mode?: WanmanExecutionMode
  enableBrain?: boolean
}

export type WanmanHostRunInvocation = RunOptions | WanmanHostRunOptions

export interface WanmanHostSdk<
  TProjectRunSpec = unknown,
  TPreparedTakeoverLaunch = unknown,
  TTakeoverInvocation = WanmanHostTakeoverOptions,
> {
  run(goal: string, options?: WanmanHostRunInvocation, spec?: TProjectRunSpec): Promise<void>
  prepareTakeover(options: TTakeoverInvocation): TPreparedTakeoverLaunch
  executePreparedTakeover(
    launch: TPreparedTakeoverLaunch,
    options?: WanmanHostRunInvocation,
  ): Promise<void>
  takeover(
    options: TTakeoverInvocation,
    runOptions?: WanmanHostRunInvocation,
  ): Promise<void>
}
