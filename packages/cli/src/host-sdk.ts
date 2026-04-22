import {
  createEnvBackedWanmanHostSdk as createBaseEnvBackedWanmanHostSdk,
  createWanmanHostSdk as createBaseWanmanHostSdk,
  type WanmanHostSdkAdapters,
  type WanmanHostRunInvocation as BaseWanmanHostRunInvocation,
  type WanmanHostSdk as BaseWanmanHostSdk,
  type WanmanHostSdkConfig,
  type WanmanHostTakeoverOptions,
} from '@wanman/host-sdk'
import type { ProjectRunSpec } from './execution-session.js'
import { runGoal } from './run-host.js'

export type {
  WanmanHostRunOptions,
  WanmanHostSdkConfig,
  WanmanHostTakeoverOptions,
} from '@wanman/host-sdk'

export type WanmanHostRunInvocation = BaseWanmanHostRunInvocation

/**
 * In the open-source CLI the host SDK is run-only. Takeover flows live in
 * `commands/takeover.ts` and go straight through `takeover-local.ts` +
 * `run-host.ts`, so the takeover adapter here is a deliberate stub that throws
 * if anything ever tries to use it through the generic host-SDK surface.
 */
export type WanmanHostSdk = BaseWanmanHostSdk<ProjectRunSpec, never, WanmanHostTakeoverOptions>

function unsupportedTakeover(): never {
  throw new Error('Takeover control plane is not available in the open-source CLI. Use `wanman takeover <path>` directly.')
}

const adapters: WanmanHostSdkAdapters<ProjectRunSpec, never, WanmanHostTakeoverOptions> = {
  runGoal,
  prepareTakeoverPlan: unsupportedTakeover,
  executePreparedTakeoverPlan: unsupportedTakeover,
  normalizeTakeoverOptions: (options) => options as WanmanHostTakeoverOptions,
}

export function createWanmanHostSdk(config: WanmanHostSdkConfig = {}): WanmanHostSdk {
  return createBaseWanmanHostSdk(config, adapters)
}

export function createEnvBackedWanmanHostSdk(
  env: NodeJS.ProcessEnv = process.env,
  config: Omit<WanmanHostSdkConfig, 'env'> = {},
): WanmanHostSdk {
  return createBaseEnvBackedWanmanHostSdk(env, config, adapters)
}
