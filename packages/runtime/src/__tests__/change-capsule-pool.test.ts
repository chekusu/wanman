import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChangeCapsulePool } from '../change-capsule-pool.js'

describe('ChangeCapsulePool', () => {
  let db: Database.Database
  let pool: ChangeCapsulePool

  beforeEach(() => {
    db = new Database(':memory:')
    pool = new ChangeCapsulePool(db)
  })

  afterEach(() => {
    db.close()
  })

  it('creates, resolves, filters, mines, and updates capsules', async () => {
    const first = await pool.create({
      goal: 'Implement CLI output',
      ownerAgent: 'dev',
      branch: 'wanman/cli-output',
      baseCommit: 'abc123',
      allowedPaths: ['packages/cli/src/output.ts'],
      acceptance: 'tests pass',
      reviewer: 'cto',
      status: 'open',
      initiativeId: 'i1',
      taskId: 't1',
      subsystem: 'cli',
      scopeType: 'code',
      blockedBy: ['cap-old'],
      supersedes: 'cap-older',
    })
    await pool.create({
      goal: 'Write docs',
      ownerAgent: 'marketing',
      branch: 'wanman/docs',
      baseCommit: 'abc123',
      allowedPaths: ['docs/usage.md'],
      acceptance: 'docs updated',
      reviewer: 'docs',
      status: 'merged',
    })

    expect(pool.resolveId(first.id.slice(0, 8))).toBe(first.id)
    expect(pool.get(first.id.slice(0, 8))).toMatchObject({
      id: first.id,
      blockedBy: ['cap-old'],
      supersedes: 'cap-older',
      scopeType: 'code',
    })
    await expect(pool.list({ status: 'open' })).resolves.toHaveLength(1)
    await expect(pool.list({ ownerAgent: 'dev', initiativeId: 'i1', reviewer: 'cto' })).resolves.toHaveLength(1)
    await expect(pool.mine('dev')).resolves.toHaveLength(1)
    await expect(pool.mine('marketing')).resolves.toEqual([])
    await expect(pool.mine('marketing', 'merged')).resolves.toHaveLength(1)

    const updated = await pool.update(first.id.slice(0, 8), {
      status: 'in_review',
      ownerAgent: 'dev-2',
      allowedPaths: ['packages/cli/src/output.ts', 'packages/cli/src/output.test.ts'],
      blockedBy: [],
    })
    expect(updated).toMatchObject({
      id: first.id,
      status: 'in_review',
      ownerAgent: 'dev-2',
      allowedPaths: ['packages/cli/src/output.ts', 'packages/cli/src/output.test.ts'],
      blockedBy: [],
    })
  })

  it('classifies high, weak, and parallel conflicts for active capsules', async () => {
    const hot = await pool.create({
      goal: 'Runtime work',
      ownerAgent: 'dev',
      branch: 'wanman/runtime',
      baseCommit: 'abc123',
      allowedPaths: ['packages/runtime/src/supervisor.ts'],
      acceptance: 'tests pass',
      reviewer: 'cto',
      status: 'open',
      subsystem: 'runtime',
    })
    const sibling = await pool.create({
      goal: 'CLI sibling work',
      ownerAgent: 'dev-2',
      branch: 'wanman/cli-sibling',
      baseCommit: 'abc123',
      allowedPaths: ['packages/cli/src/foo.ts'],
      acceptance: 'tests pass',
      reviewer: 'cto',
      status: 'in_review',
      subsystem: 'cli',
    })

    const high = await pool.checkConflict({ allowedPaths: ['packages/runtime/src/supervisor.ts'] })
    expect(high).toEqual([
      expect.objectContaining({ capsule: expect.objectContaining({ id: hot.id }), level: 'high_conflict' }),
    ])

    const weak = await pool.checkConflict({ allowedPaths: ['packages/cli/src/bar.ts'] })
    expect(weak).toEqual([
      expect.objectContaining({ capsule: expect.objectContaining({ id: sibling.id }), level: 'weak_conflict' }),
    ])

    await expect(pool.checkConflict({ allowedPaths: ['apps/web/src/page.ts'] })).resolves.toEqual([])
    await expect(pool.checkConflict({ allowedPaths: ['packages/runtime/src/supervisor.ts'] }, hot.id)).resolves.toEqual([])
  })

  it('throws when updating an unknown capsule', async () => {
    await expect(pool.update('missing', { status: 'merged' })).rejects.toThrow(/Capsule not found/)
  })
})
