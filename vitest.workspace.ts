import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  'packages/core',
  'packages/runtime',
  'packages/cli',
  'packages/host-sdk',
])
