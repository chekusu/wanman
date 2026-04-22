import * as fs from 'node:fs'
import * as path from 'node:path'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())
const createLocalRuntimeClientMock = vi.hoisted(() => vi.fn((port: number) => ({ port, kind: 'runtime-client' })))

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}))

vi.mock('./runtime-client.js', () => ({
  createLocalRuntimeClient: createLocalRuntimeClientMock,
}))

import { startLocalSupervisor } from './local-supervisor.js'

function makeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    exitCode: number | null
    kill: ReturnType<typeof vi.fn>
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.exitCode = null
  child.kill = vi.fn()
  return child
}

describe('startLocalSupervisor', () => {
  const tmpDirs: string[] = []

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeTmpDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(tmpdir(), prefix))
    tmpDirs.push(dir)
    return dir
  }

  function makeLayout() {
    const root = makeTmpDir('wanman-start-supervisor-')
    const configPath = path.join(root, 'agents.json')
    const workspaceRoot = path.join(root, 'workspace')
    const gitRoot = path.join(root, 'repo')
    const sharedSkillsDir = path.join(root, 'skills')
    const homeRoot = path.join(root, 'home-root')
    const runtimeEntrypoint = path.join(root, 'runtime-entrypoint.js')
    const cliHostEntrypoint = path.join(root, 'cli-entrypoint.js')
    fs.mkdirSync(workspaceRoot, { recursive: true })
    fs.mkdirSync(gitRoot, { recursive: true })
    fs.mkdirSync(path.join(sharedSkillsDir, 'takeover-context'), { recursive: true })
    fs.writeFileSync(path.join(sharedSkillsDir, 'takeover-context', 'SKILL.md'), '# Takeover\n')
    fs.writeFileSync(runtimeEntrypoint, '')
    fs.writeFileSync(cliHostEntrypoint, '')
    fs.writeFileSync(configPath, JSON.stringify({ agents: [], port: 3120 }, null, 2))
    return { configPath, workspaceRoot, gitRoot, sharedSkillsDir, homeRoot, runtimeEntrypoint, cliHostEntrypoint }
  }

  it('starts the runtime with a localized config, environment, log buffer, and signal forwarding', async () => {
    const child = makeChild()
    spawnMock.mockReturnValue(child)
    const layout = makeLayout()

    const handle = await startLocalSupervisor({
      ...layout,
      goal: 'ship it',
      runtime: 'codex',
      codexModel: 'gpt-test',
      codexReasoningEffort: 'high',
    })

    const config = JSON.parse(fs.readFileSync(layout.configPath, 'utf-8')) as { port: number }
    expect(config.port).toBe(handle.port)
    expect(handle.endpoint).toBe(`http://127.0.0.1:${handle.port}`)
    expect(handle.entrypoint).toBe(layout.runtimeEntrypoint)
    expect(handle.runtime).toEqual({ port: handle.port, kind: 'runtime-client' })
    expect(createLocalRuntimeClientMock).toHaveBeenCalledWith(handle.port)

    expect(spawnMock).toHaveBeenCalledWith('node', [layout.runtimeEntrypoint], expect.objectContaining({
      cwd: layout.gitRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: expect.objectContaining({
        HOME: path.join(layout.homeRoot, 'home'),
        WANMAN_URL: `http://127.0.0.1:${handle.port}`,
        WANMAN_CONFIG: layout.configPath,
        WANMAN_WORKSPACE: layout.workspaceRoot,
        WANMAN_GIT_ROOT: layout.gitRoot,
        WANMAN_SHARED_SKILLS: layout.sharedSkillsDir,
        WANMAN_GOAL: 'ship it',
        WANMAN_RUNTIME: 'codex',
        WANMAN_CODEX_MODEL: 'gpt-test',
        WANMAN_CODEX_REASONING_EFFORT: 'high',
      }),
    }))

    child.stdout.emit('data', Buffer.from('first line\n'))
    child.stderr.emit('data', Buffer.from('second'))
    child.stderr.emit('data', Buffer.from(' line\n'))
    await expect(handle.readLogs(0)).resolves.toEqual({
      lines: ['first line', 'second line'],
      cursor: 2,
    })

    const detach = handle.attachSignalForwarding()
    process.emit('SIGINT', 'SIGINT')
    detach()
    expect(child.kill).toHaveBeenCalledWith('SIGINT')

    child.exitCode = 0
    await handle.stop(true)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL')
  })

  it('rejects waitForExit when the supervisor exits with a non-zero code', async () => {
    const child = makeChild()
    spawnMock.mockReturnValue(child)
    const layout = makeLayout()

    const handle = await startLocalSupervisor(layout)
    const wait = handle.waitForExit()
    child.emit('close', 2)

    await expect(wait).rejects.toThrow(/Supervisor exited with code 2/)
  })
})
