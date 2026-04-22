/**
 * Tests for WorktreeManager — Git worktree lifecycle management.
 * Uses real git repos in temp directories.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { tmpdir } from 'os'
import { WorktreeManager } from '../worktree-manager.js'
import type { WorktreeInfo } from '../worktree-manager.js'

let repoDir: string
let manager: WorktreeManager

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'wt-test-'))
  execSync('git init -b main && git config user.email test@example.com && git config user.name Test && git commit --allow-empty -m "init"', {
    cwd: repoDir,
    stdio: 'pipe',
  })
  manager = new WorktreeManager(repoDir)
})

afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true })
})

describe('WorktreeManager', () => {
  it('should create a worktree', async () => {
    const info = await manager.create('task-1')

    expect(info.name).toBe('task-1')
    expect(info.branch).toBe('agent/task-1')
    expect(info.path).toBe(join(repoDir, '.worktrees', 'task-1'))
    expect(info.createdAt).toBeLessThanOrEqual(Date.now())
    expect(info.createdAt).toBeGreaterThan(Date.now() - 5000)
    expect(existsSync(info.path)).toBe(true)
  })

  it('should write metadata file in the worktree', async () => {
    const metaPath = join(repoDir, '.worktrees', 'task-1', '.worktree-meta.json')
    expect(existsSync(metaPath)).toBe(true)

    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
    expect(meta.name).toBe('task-1')
    expect(meta.branch).toBe('agent/task-1')
    expect(typeof meta.createdAt).toBe('number')
  })

  it('should list worktrees', async () => {
    // task-1 was created above; create one more
    await manager.create('task-2')

    const list = await manager.list()
    const names = list.map((w) => w.name)
    expect(names).toContain('task-1')
    expect(names).toContain('task-2')
    expect(list.length).toBeGreaterThanOrEqual(2)
  })

  it('should get a specific worktree', async () => {
    const info = await manager.get('task-1')
    expect(info).not.toBeNull()
    expect(info!.name).toBe('task-1')
    expect(info!.branch).toBe('agent/task-1')
  })

  it('should return null for non-existent worktree', async () => {
    const info = await manager.get('does-not-exist')
    expect(info).toBeNull()
  })

  it('should remove a worktree', async () => {
    await manager.remove('task-2')

    const info = await manager.get('task-2')
    expect(info).toBeNull()

    const wtPath = join(repoDir, '.worktrees', 'task-2')
    expect(existsSync(wtPath)).toBe(false)
  })

  it('should create a worktree from a specific base branch', async () => {
    // Create a branch to use as base
    execSync('git branch feature-base', { cwd: repoDir, stdio: 'pipe' })

    const info = await manager.create('task-3', 'feature-base')
    expect(info.branch).toBe('agent/task-3')
    expect(existsSync(info.path)).toBe(true)

    // Clean up
    await manager.remove('task-3')
  })

  it('should cleanup old worktrees', async () => {
    // Create two worktrees
    const old = await manager.create('old-task')
    const recent = await manager.create('recent-task')

    // Backdate the "old" worktree metadata by rewriting the meta file
    const oldMetaPath = join(old.path, '.worktree-meta.json')
    const oldMeta = JSON.parse(readFileSync(oldMetaPath, 'utf-8'))
    oldMeta.createdAt = Date.now() - 2 * 60 * 60 * 1000 // 2 hours ago
    writeFileSync(oldMetaPath, JSON.stringify(oldMeta))

    // Cleanup anything older than 1 hour
    const removed = await manager.cleanup(60 * 60 * 1000)

    expect(removed).toBe(1)
    expect(await manager.get('old-task')).toBeNull()
    expect(await manager.get('recent-task')).not.toBeNull()

    // Clean up
    await manager.remove('recent-task')
  })

  it('should throw when creating a duplicate worktree', async () => {
    await manager.create('dup-task')
    await expect(manager.create('dup-task')).rejects.toThrow()

    // Clean up
    await manager.remove('dup-task')
  })

  it('should handle removing non-existent worktree gracefully', async () => {
    // Should not throw
    await expect(manager.remove('nonexistent')).rejects.toThrow()
  })

  it('should cleanup when no old worktrees exist', async () => {
    const removed = await manager.cleanup(60 * 60 * 1000)
    expect(removed).toBe(0)
  })
})
