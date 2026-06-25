import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHomeManager } from '../agent-home-manager.js'

const tempRoots: string[] = []

describe('AgentHomeManager', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('mounts active snapshot skills into isolated claude and codex homes', () => {
    const { baseHome, homesRoot, snapshotPath } = createFixture()
    const manager = new AgentHomeManager(baseHome, homesRoot)

    const agentHome = manager.prepareAgentHome('ceo', {
      id: 'snapshot-1',
      runId: 'run-1',
      agent: 'ceo',
      activationScope: 'task',
      materializedPath: snapshotPath,
      resolvedSkills: [],
    })

    expect(fs.readlinkSync(path.join(agentHome, '.claude', 'skills'))).toBe(snapshotPath)
    expect(fs.readlinkSync(path.join(agentHome, '.codex', 'skills'))).toBe(snapshotPath)
    expect(fs.readlinkSync(path.join(agentHome, '.claude', '.credentials.json'))).toBe(path.join(baseHome, '.claude', '.credentials.json'))
    expect(fs.readlinkSync(path.join(agentHome, '.config'))).toBe(path.join(baseHome, '.config'))
    expect(fs.readlinkSync(path.join(agentHome, '.npmrc'))).toBe(path.join(baseHome, '.npmrc'))
    expect(fs.readlinkSync(path.join(agentHome, '.aws'))).toBe(path.join(baseHome, '.aws'))
  })

  it('creates an empty skills mount when no snapshot is active', () => {
    const { baseHome, homesRoot } = createFixture()
    const manager = new AgentHomeManager(baseHome, homesRoot)

    const agentHome = manager.prepareAgentHome('marketing')
    const claudeSkills = path.join(agentHome, '.claude', 'skills')

    expect(fs.lstatSync(claudeSkills).isSymbolicLink()).toBe(true)
    expect(fs.readdirSync(claudeSkills)).toHaveLength(0)
  })

  it('skips missing runtime roots while preparing the agent home', () => {
    const { baseHome, homesRoot } = createFixture()
    fs.rmSync(path.join(baseHome, '.codex'), { recursive: true, force: true })
    const manager = new AgentHomeManager(baseHome, homesRoot)

    const agentHome = manager.prepareAgentHome('partial-runtime')

    expect(fs.existsSync(path.join(agentHome, '.claude', '.credentials.json'))).toBe(true)
    expect(fs.existsSync(path.join(agentHome, '.codex', 'config.json'))).toBe(false)
    expect(fs.lstatSync(path.join(agentHome, '.codex', 'skills')).isSymbolicLink()).toBe(true)
  })

  it('cleans up all prepared homes', () => {
    const { baseHome, homesRoot } = createFixture()
    const manager = new AgentHomeManager(baseHome, homesRoot)

    manager.prepareAgentHome('ops')
    expect(fs.existsSync(homesRoot)).toBe(true)

    manager.cleanupHomes()
    expect(fs.existsSync(homesRoot)).toBe(false)
  })

  it('falls back to junction links for directories when Windows symlink privileges are missing', () => {
    const { baseHome, homesRoot, snapshotPath } = createFixture()
    const manager = new AgentHomeManager(baseHome, homesRoot)
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const originalSymlinkSync = fs.symlinkSync.bind(fs)
    const symlinkSpy = vi.spyOn(fs, 'symlinkSync').mockImplementation((target, path, type) => {
      if (type === 'dir') {
        const error = Object.assign(new Error('missing symlink privilege'), { code: 'EPERM' })
        throw error
      }
      return originalSymlinkSync(target, path, type)
    })

    manager.prepareAgentHome('windows', {
      id: 'snapshot-2',
      runId: 'run-2',
      agent: 'windows',
      activationScope: 'task',
      materializedPath: snapshotPath,
      resolvedSkills: [],
    })

    expect(symlinkSpy.mock.calls.some(([, , type]) => type === 'junction')).toBe(true)
    platformSpy.mockRestore()
  })

  it('throws actionable guidance when Windows file symlinks are blocked', () => {
    const { baseHome, homesRoot } = createFixture()
    const manager = new AgentHomeManager(baseHome, homesRoot)
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const originalSymlinkSync = fs.symlinkSync.bind(fs)
    vi.spyOn(fs, 'symlinkSync').mockImplementation((target, path, type) => {
      if (type === 'file') {
        const error = Object.assign(new Error('missing symlink privilege'), { code: 'EACCES' })
        throw error
      }
      return originalSymlinkSync(target, path, type)
    })

    expect(() => manager.prepareAgentHome('windows-file')).toThrow(
      /Enable Windows Developer Mode or run wanman inside WSL2 or Linux\/macOS/,
    )

    platformSpy.mockRestore()
  })

  it('rethrows file link errors outside Windows privilege handling', () => {
    const { baseHome, homesRoot } = createFixture()
    const manager = new AgentHomeManager(baseHome, homesRoot)
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const originalSymlinkSync = fs.symlinkSync.bind(fs)
    const expected = new Error('file symlink failed')
    vi.spyOn(fs, 'symlinkSync').mockImplementation((target, linkPath, type) => {
      if (type === 'file' && String(linkPath).endsWith('.npmrc')) {
        throw expected
      }
      return originalSymlinkSync(target, linkPath, type)
    })

    expect(() => manager.prepareAgentHome('linux-file')).toThrow(expected)

    platformSpy.mockRestore()
  })

  it('rethrows directory link errors outside Windows privilege handling', () => {
    const { baseHome, homesRoot } = createFixture()
    const manager = new AgentHomeManager(baseHome, homesRoot)
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const originalSymlinkSync = fs.symlinkSync.bind(fs)
    const expected = new Error('dir symlink failed')
    vi.spyOn(fs, 'symlinkSync').mockImplementation((target, linkPath, type) => {
      if (type === 'dir' && String(linkPath).endsWith('.config')) {
        throw expected
      }
      return originalSymlinkSync(target, linkPath, type)
    })

    expect(() => manager.prepareAgentHome('linux-dir')).toThrow(expected)

    platformSpy.mockRestore()
  })

  it('rethrows skills link errors outside Windows privilege handling', () => {
    const { baseHome, homesRoot, snapshotPath } = createFixture()
    const manager = new AgentHomeManager(baseHome, homesRoot)
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const originalSymlinkSync = fs.symlinkSync.bind(fs)
    const expected = new Error('skills symlink failed')
    vi.spyOn(fs, 'symlinkSync').mockImplementation((target, linkPath, type) => {
      if (type === 'dir' && String(linkPath).endsWith(`${path.sep}skills`)) {
        throw expected
      }
      return originalSymlinkSync(target, linkPath, type)
    })

    expect(() => manager.prepareAgentHome('linux-skills', {
      id: 'snapshot-3',
      runId: 'run-3',
      agent: 'linux-skills',
      activationScope: 'task',
      materializedPath: snapshotPath,
      resolvedSkills: [],
    })).toThrow(expected)

    platformSpy.mockRestore()
  })
})

function createFixture(): { baseHome: string; homesRoot: string; snapshotPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wanman-agent-home-'))
  tempRoots.push(root)

  const baseHome = path.join(root, 'base-home')
  const homesRoot = path.join(root, 'homes')
  const snapshotPath = path.join(root, 'snapshot')

  fs.mkdirSync(path.join(baseHome, '.claude'), { recursive: true })
  fs.mkdirSync(path.join(baseHome, '.codex'), { recursive: true })
  fs.mkdirSync(path.join(baseHome, '.config'), { recursive: true })
  fs.mkdirSync(path.join(baseHome, '.aws'), { recursive: true })
  fs.writeFileSync(path.join(baseHome, '.claude', '.credentials.json'), '{}')
  fs.writeFileSync(path.join(baseHome, '.codex', 'config.json'), '{}')
  fs.writeFileSync(path.join(baseHome, '.npmrc'), 'registry=https://registry.npmjs.org')

  fs.mkdirSync(path.join(snapshotPath, 'research'), { recursive: true })
  fs.writeFileSync(path.join(snapshotPath, 'research', 'SKILL.md'), '# Research')

  return { baseHome, homesRoot, snapshotPath }
}
