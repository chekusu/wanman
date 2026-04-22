export {
  createEnvBackedWanmanHostSdk,
  createWanmanHostSdk,
} from './host-sdk.js'
export type {
  WanmanHostRunInvocation,
  WanmanHostSdk,
} from './host-sdk.js'
export type {
  RunOptions,
  WanmanHostRunOptions,
  WanmanHostSdkConfig,
  WanmanHostTakeoverOptions,
} from '@wanman/host-sdk'
export { createDefaultRunOptions, createRunOptions, createTakeoverRunOptions } from '@wanman/host-sdk'

export { runGoal, detectProjectDir } from './run-host.js'
export type { ProjectRunSpec } from './execution-session.js'
