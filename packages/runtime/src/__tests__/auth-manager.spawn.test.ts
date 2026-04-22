import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('child_process', () => ({
  spawn: spawnMock,
}))

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

function makeChild(): ChildProcess & {
  stdout: PassThrough
  stderr: PassThrough
  kill: ChildProcess['kill'] & ReturnType<typeof vi.fn>
} {
  const child = new EventEmitter() as ChildProcess & {
    stdout: PassThrough
    stderr: PassThrough
    kill: ChildProcess['kill'] & ReturnType<typeof vi.fn>
  }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn(() => true) as ChildProcess['kill'] & ReturnType<typeof vi.fn>
  return child
}

describe('AuthManager spawn-backed flows', () => {
  let AuthManager: typeof import('../auth-manager.js').AuthManager

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.resetModules()
    AuthManager = (await import('../auth-manager.js')).AuthManager
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('checks GitHub auth by waiting for the CLI exit code', async () => {
    const child = makeChild()
    spawnMock.mockReturnValueOnce(child)
    const manager = new AuthManager()
    const result = manager.checkAuth('github')

    child.emit('close', 0)

    await expect(result).resolves.toBe(true)
    expect(spawnMock).toHaveBeenCalledWith('gh', ['auth', 'status'], expect.objectContaining({
      stdio: 'ignore',
    }))
  })

  it('treats CLI spawn errors as unauthenticated during auth checks', async () => {
    const child = makeChild()
    spawnMock.mockReturnValueOnce(child)
    const manager = new AuthManager()
    const result = manager.checkAuth('github')

    child.emit('error', new Error('missing gh'))

    await expect(result).resolves.toBe(false)
  })

  it('times out hung CLI auth checks instead of blocking provider status', async () => {
    vi.useFakeTimers()
    const child = makeChild()
    spawnMock.mockReturnValueOnce(child)
    const manager = new AuthManager()
    const result = manager.checkAuth('github')

    await vi.advanceTimersByTimeAsync(2000)

    await expect(result).resolves.toBe(false)
    expect(child.kill).toHaveBeenCalled()
  })

  it('captures Codex device login URL and code from stdout and records success on close', async () => {
    const child = makeChild()
    spawnMock.mockReturnValueOnce(child)
    const manager = new AuthManager()
    const result = manager.startLogin('codex')

    child.stdout.emit('data', Buffer.from('Open https://auth.openai.com/device and enter ABCD-12345'))

    await expect(result).resolves.toEqual({
      name: 'codex',
      status: 'pending',
      loginUrl: 'https://auth.openai.com/device',
      loginCode: 'ABCD-12345',
    })

    child.emit('close', 0)
    expect(manager.getLoginStatus('codex').status).toBe('authenticated')
  })

  it('returns an error when login spawn fails before printing a URL', async () => {
    const child = makeChild()
    spawnMock.mockReturnValueOnce(child)
    const manager = new AuthManager()
    const result = manager.startLogin('github')

    child.emit('error', new Error('missing gh'))

    await expect(result).resolves.toMatchObject({
      name: 'github',
      status: 'error',
      error: 'Failed to spawn login process: missing gh',
    })
  })

  it('returns close status when login exits before printing a URL', async () => {
    const child = makeChild()
    spawnMock.mockReturnValueOnce(child)
    const manager = new AuthManager()
    const result = manager.startLogin('github')

    child.emit('close', 2)

    await expect(result).resolves.toMatchObject({
      name: 'github',
      status: 'error',
      error: 'Login process exited with code 2',
    })
  })
})
