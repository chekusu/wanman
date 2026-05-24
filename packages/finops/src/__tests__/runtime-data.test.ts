import { describe, expect, it } from 'vitest'
import { demoWorkspaceInput } from '../demo-data.js'
import { buildRuntimeDashboardFile } from '../runtime-data.js'

describe('runtime dashboard data', () => {
  it('sanitizes local repository paths before web preview', () => {
    const runtime = buildRuntimeDashboardFile({
      company: demoWorkspaceInput.company,
      inventory: {
        ...demoWorkspaceInput.inventory,
        root: '/home/codex/workspace/private-scan',
      },
      costs: [],
      revenue: [],
      usage: [],
      pricing: demoWorkspaceInput.pricing,
      generatedAt: '2026-05-25T00:00:00.000Z',
    })

    expect(runtime.dataSource.inventoryRoot).toBe('private://chekusu')
    expect(runtime.dashboard.inventory.repositories.every((repo) => repo.repoPath.startsWith('private://'))).toBe(true)
    expect(runtime.dashboard.inventory.references.every((ref) => ref.repoPath.startsWith('private://'))).toBe(true)
    expect(JSON.stringify(runtime)).not.toContain('/home/codex')
  })
})
