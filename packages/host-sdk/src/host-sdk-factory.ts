import { createRunOptions, createTakeoverRunOptions, type RunOptions } from './run-options.js'
import type {
  WanmanHostRunInvocation,
  WanmanHostSdk,
  WanmanHostSdkConfig,
  WanmanHostTakeoverOptions,
} from './host-sdk-types.js'

export interface WanmanHostSdkBindings {
  hostEnv: NodeJS.ProcessEnv
}

export interface WanmanHostSdkAdapters<
  TProjectRunSpec,
  TPreparedTakeoverLaunch,
  TConcreteTakeoverOptions extends object,
> {
  runGoal(
    goal: string,
    options: RunOptions,
    spec: TProjectRunSpec,
    bindings: WanmanHostSdkBindings,
  ): Promise<void>
  prepareTakeoverLaunch(options: TConcreteTakeoverOptions): TPreparedTakeoverLaunch
  executePreparedTakeoverLaunch(
    launch: TPreparedTakeoverLaunch,
    options: RunOptions,
    bindings: WanmanHostSdkBindings,
  ): Promise<void>
  normalizeTakeoverOptions(
    options: TConcreteTakeoverOptions | WanmanHostTakeoverOptions,
  ): TConcreteTakeoverOptions
}

function buildHostEnv(config: WanmanHostSdkConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(config.env ?? {}),
  }
}

function normalizeRunOptions(
  options: WanmanHostRunInvocation | undefined,
  defaults: (overrides?: Partial<RunOptions>) => RunOptions,
): RunOptions {
  return defaults(options ?? {})
}

export function createWanmanHostSdk<
  TProjectRunSpec = unknown,
  TPreparedTakeoverLaunch = unknown,
  TConcreteTakeoverOptions extends object = WanmanHostTakeoverOptions,
>(
  config: WanmanHostSdkConfig = {},
  adapters: WanmanHostSdkAdapters<TProjectRunSpec, TPreparedTakeoverLaunch, TConcreteTakeoverOptions>,
): WanmanHostSdk<
  TProjectRunSpec,
  TPreparedTakeoverLaunch,
  TConcreteTakeoverOptions | WanmanHostTakeoverOptions
> {
  const bindings: WanmanHostSdkBindings = {
    hostEnv: buildHostEnv(config),
  }

  return {
    async run(goal, options, spec = {} as TProjectRunSpec) {
      await adapters.runGoal(goal, normalizeRunOptions(options, createRunOptions), spec, bindings)
    },

    prepareTakeover(options) {
      return adapters.prepareTakeoverLaunch(adapters.normalizeTakeoverOptions(options))
    },

    async executePreparedTakeover(launch, options) {
      await adapters.executePreparedTakeoverLaunch(
        launch,
        normalizeRunOptions(options, createTakeoverRunOptions),
        bindings,
      )
    },

    async takeover(options, runOptions) {
      const launch = this.prepareTakeover(options)
      await this.executePreparedTakeover(launch, runOptions)
    },
  }
}

export function createEnvBackedWanmanHostSdk<
  TProjectRunSpec = unknown,
  TPreparedTakeoverLaunch = unknown,
  TConcreteTakeoverOptions extends object = WanmanHostTakeoverOptions,
>(
  env: NodeJS.ProcessEnv = process.env,
  config: Omit<WanmanHostSdkConfig, 'env'> = {},
  adapters: WanmanHostSdkAdapters<TProjectRunSpec, TPreparedTakeoverLaunch, TConcreteTakeoverOptions>,
): WanmanHostSdk<
  TProjectRunSpec,
  TPreparedTakeoverLaunch,
  TConcreteTakeoverOptions | WanmanHostTakeoverOptions
> {
  return createWanmanHostSdk(
    {
      ...config,
      env,
    },
    adapters,
  )
}
