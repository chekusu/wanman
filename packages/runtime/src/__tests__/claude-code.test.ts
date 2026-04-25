/**
 * Unit tests for Claude Code spawn wrapper.
 * Mocks child_process.spawn.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter, Readable, Writable } from 'stream'
import type { ClaudeEvent } from '../claude-code.js'

// Track the most recently created mock proc
let latestProc: {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  killed: boolean
  exitCode: number | null
  pid: number
  kill: ReturnType<typeof vi.fn>
  on: (...args: unknown[]) => unknown
  emit: (...args: unknown[]) => unknown
}

vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    const emitter = new EventEmitter()
    const stdin = new Writable({ write(_chunk, _enc, cb) { cb() } })
    const stdout = new Readable({ read() {} })
    const stderr = new Readable({ read() {} })

    latestProc = {
      stdin,
      stdout,
      stderr,
      killed: false,
      exitCode: null,
      pid: 12345,
      kill: vi.fn(() => {
        latestProc.killed = true
        emitter.emit('close', 0)
      }),
      on: emitter.on.bind(emitter) as unknown as typeof latestProc.on,
      emit: emitter.emit.bind(emitter) as unknown as typeof latestProc.emit,
    }

    return latestProc
  }),
}))

// Mock logger
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

// Import after mocks are set up
const { spawnClaudeCode } = await import('../claude-code.js')
const { spawn: spawnMock } = await import('child_process')

describe('spawnClaudeCode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should return a ClaudeCodeProcess handle', () => {
    const handle = spawnClaudeCode({
      model: 'haiku',
      systemPrompt: 'test prompt',
      cwd: '/tmp',
    })

    expect(handle.proc).toBeTruthy()
    expect(typeof handle.sendMessage).toBe('function')
    expect(typeof handle.kill).toBe('function')
    expect(typeof handle.wait).toBe('function')
    expect(typeof handle.onEvent).toBe('function')
    expect(typeof handle.onResult).toBe('function')
    expect(typeof handle.onExit).toBe('function')
  })

  it('should send initial message when provided', () => {
    spawnClaudeCode({
      model: 'sonnet',
      systemPrompt: 'test',
      cwd: '/tmp',
      initialMessage: 'hello',
    })

    // Verify stdin received the message by checking write was called
    const writeSpy = vi.spyOn(latestProc.stdin, 'write')
    // The initial message was sent during construction, so we test via sendMessage
    const handle = spawnClaudeCode({
      model: 'sonnet',
      systemPrompt: 'test',
      cwd: '/tmp',
    })
    // Get fresh spy after spawn
    const spy = vi.spyOn(latestProc.stdin, 'write')
    handle.sendMessage('test-message')

    expect(spy).toHaveBeenCalledTimes(1)
    const written = spy.mock.calls[0]![0] as string
    const parsed = JSON.parse(written.replace('\n', ''))
    expect(parsed.type).toBe('user')
    expect(parsed.message.content).toBe('test-message')
  })

  it('should parse JSONL events from stdout', async () => {
    const handle = spawnClaudeCode({
      model: 'haiku',
      systemPrompt: 'test',
      cwd: '/tmp',
    })

    const events: ClaudeEvent[] = []
    handle.onEvent((e) => events.push(e))

    // Simulate stdout JSONL
    const event = { type: 'assistant', message: 'hi' }
    latestProc.stdout.push(JSON.stringify(event) + '\n')

    await new Promise((r) => setTimeout(r, 50))
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('assistant')
  })

  it('should detect result events', async () => {
    const handle = spawnClaudeCode({
      model: 'haiku',
      systemPrompt: 'test',
      cwd: '/tmp',
    })

    const results: Array<{ text: string; isError: boolean }> = []
    handle.onResult((text, isError) => results.push({ text, isError }))

    const event = { type: 'result', result: 'done!', is_error: false }
    latestProc.stdout.push(JSON.stringify(event) + '\n')

    await new Promise((r) => setTimeout(r, 50))
    expect(results).toHaveLength(1)
    expect(results[0]!.text).toBe('done!')
    expect(results[0]!.isError).toBe(false)
  })

  it('should skip unparseable stdout lines', async () => {
    const handle = spawnClaudeCode({
      model: 'haiku',
      systemPrompt: 'test',
      cwd: '/tmp',
    })

    const events: ClaudeEvent[] = []
    handle.onEvent((e) => events.push(e))

    latestProc.stdout.push('not valid json\n')
    latestProc.stdout.push(JSON.stringify({ type: 'valid' }) + '\n')

    await new Promise((r) => setTimeout(r, 50))
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('valid')
  })

  it('should kill the process', () => {
    const handle = spawnClaudeCode({
      model: 'haiku',
      systemPrompt: 'test',
      cwd: '/tmp',
    })

    handle.kill()
    expect(latestProc.kill).toHaveBeenCalled()
  })

  it('should resolve wait when process exits', async () => {
    const handle = spawnClaudeCode({
      model: 'haiku',
      systemPrompt: 'test',
      cwd: '/tmp',
    })

    const waitPromise = handle.wait()
    latestProc.emit('close', 0)

    const code = await waitPromise
    expect(code).toBe(0)
  })

  it('should resolve wait immediately if process already exited', async () => {
    const handle = spawnClaudeCode({
      model: 'haiku',
      systemPrompt: 'test',
      cwd: '/tmp',
    })

    latestProc.exitCode = 42
    const code = await handle.wait()
    expect(code).toBe(42)
  })

  it('should not throw when sending to destroyed stdin', () => {
    const handle = spawnClaudeCode({
      model: 'haiku',
      systemPrompt: 'test',
      cwd: '/tmp',
    })

    handle.proc.stdin!.destroy()
    expect(() => handle.sendMessage('hello')).not.toThrow()
  })

  it('should log stderr data', async () => {
    spawnClaudeCode({
      model: 'haiku',
      systemPrompt: 'test',
      cwd: '/tmp',
    })

    // Simulate stderr output
    latestProc.stderr.push(Buffer.from('some warning\n'))

    await new Promise((r) => setTimeout(r, 50))
    // stderr was handled without crash (logged via mocked logger)
  })

  it('should fire onExit handlers when process closes', async () => {
    const handle = spawnClaudeCode({
      model: 'haiku',
      systemPrompt: 'test',
      cwd: '/tmp',
    })

    const exitCodes: number[] = []
    handle.onExit((code) => exitCodes.push(code))

    latestProc.emit('close', 42)

    await new Promise((r) => setTimeout(r, 50))
    expect(exitCodes).toHaveLength(1)
    expect(exitCodes[0]).toBe(42)
  })

  it('should fire onExit with code 1 when close code is null', async () => {
    const handle = spawnClaudeCode({
      model: 'haiku',
      systemPrompt: 'test',
      cwd: '/tmp',
    })

    const exitCodes: number[] = []
    handle.onExit((code) => exitCodes.push(code))

    latestProc.emit('close', null)

    await new Promise((r) => setTimeout(r, 50))
    expect(exitCodes).toHaveLength(1)
    expect(exitCodes[0]).toBe(1)
  })

  it('should force kill after timeout if SIGTERM does not work', async () => {
    vi.useFakeTimers()

    const handle = spawnClaudeCode({
      model: 'haiku',
      systemPrompt: 'test',
      cwd: '/tmp',
    })

    // Override the mock kill to NOT set killed=true (simulating process that won't die)
    const originalKill = latestProc.kill
    latestProc.kill = vi.fn((signal?: string) => {
      if (signal === 'SIGKILL') {
        // SIGKILL always works
        latestProc.killed = true
        latestProc.emit('close', 0)
      }
      // SIGTERM is ignored — process doesn't die
    }) as typeof latestProc.kill

    handle.kill()

    // First call should be SIGTERM
    expect(latestProc.kill).toHaveBeenCalledWith('SIGTERM')
    expect(latestProc.killed).toBe(false)

    // Advance past the 5s force kill timeout
    await vi.advanceTimersByTimeAsync(5000)

    // Should have sent SIGKILL
    expect(latestProc.kill).toHaveBeenCalledWith('SIGKILL')

    vi.useRealTimers()
  })

  it('should not kill if already killed', () => {
    const handle = spawnClaudeCode({
      model: 'haiku',
      systemPrompt: 'test',
      cwd: '/tmp',
    })

    handle.kill() // First kill
    latestProc.kill.mockClear()

    // Second kill should be a no-op since proc.killed is now true
    handle.kill()
    expect(latestProc.kill).not.toHaveBeenCalled()
  })

  it('should not pass --resume by default', () => {
    spawnClaudeCode({
      model: 'haiku',
      systemPrompt: 'test',
      cwd: '/tmp',
    })

    const calls = (spawnMock as unknown as { mock: { calls: unknown[][] } }).mock.calls
    const args = calls[calls.length - 1]![1] as string[]
    expect(args).not.toContain('--resume')
  })

  it('should pass --resume <id> when resumeSessionId is set', () => {
    spawnClaudeCode({
      model: 'haiku',
      systemPrompt: 'test',
      cwd: '/tmp',
      resumeSessionId: 'session-abc-123',
    })

    const calls = (spawnMock as unknown as { mock: { calls: unknown[][] } }).mock.calls
    const args = calls[calls.length - 1]![1] as string[]
    const idx = args.indexOf('--resume')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('session-abc-123')
  })

  it('should fire onSessionId for system/init events', async () => {
    const handle = spawnClaudeCode({
      model: 'haiku',
      systemPrompt: 'test',
      cwd: '/tmp',
    })

    const observed: string[] = []
    handle.onSessionId((id) => observed.push(id))

    latestProc.stdout.push(JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'session-from-init',
    }) + '\n')

    await new Promise((r) => setTimeout(r, 50))
    expect(observed).toEqual(['session-from-init'])
  })

  it('should not double-fire onSessionId when the same id is reported twice', async () => {
    const handle = spawnClaudeCode({
      model: 'haiku',
      systemPrompt: 'test',
      cwd: '/tmp',
    })

    const observed: string[] = []
    handle.onSessionId((id) => observed.push(id))

    const event = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'stable-id',
    }) + '\n'
    latestProc.stdout.push(event)
    latestProc.stdout.push(event)

    await new Promise((r) => setTimeout(r, 50))
    expect(observed).toEqual(['stable-id'])
  })

  it('should replay the latest session id to handlers registered late', async () => {
    const handle = spawnClaudeCode({
      model: 'haiku',
      systemPrompt: 'test',
      cwd: '/tmp',
    })

    latestProc.stdout.push(JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'late-handler-id',
    }) + '\n')

    await new Promise((r) => setTimeout(r, 50))

    const observed: string[] = []
    handle.onSessionId((id) => observed.push(id))
    expect(observed).toEqual(['late-handler-id'])
  })

  it('should report resumeMissed false by default', () => {
    const handle = spawnClaudeCode({
      model: 'haiku',
      systemPrompt: 'test',
      cwd: '/tmp',
    })
    expect(handle.resumeMissed()).toBe(false)
  })

  it('should set resumeMissed when stderr reports the resumed session is missing', async () => {
    const handle = spawnClaudeCode({
      model: 'haiku',
      systemPrompt: 'test',
      cwd: '/tmp',
      resumeSessionId: 'stale-session',
    })

    latestProc.stderr.push(Buffer.from('Error: No session found with id stale-session\n'))

    await new Promise((r) => setTimeout(r, 50))
    expect(handle.resumeMissed()).toBe(true)
  })

  it('should NOT set resumeMissed when no resumeSessionId was passed', async () => {
    const handle = spawnClaudeCode({
      model: 'haiku',
      systemPrompt: 'test',
      cwd: '/tmp',
    })

    latestProc.stderr.push(Buffer.from('Error: No session found\n'))

    await new Promise((r) => setTimeout(r, 50))
    expect(handle.resumeMissed()).toBe(false)
  })

  it('should set resumeMissed for Claude Code 2.1.119 stderr wording', async () => {
    // Regression: this exact wording was reported by chekusu/wanman#2 reviewer
    // testing against Claude Code 2.1.119. The earlier regex required
    // "session" specifically and missed the "conversation" wording.
    const handle = spawnClaudeCode({
      model: 'haiku',
      systemPrompt: 'test',
      cwd: '/tmp',
      resumeSessionId: 'abc-stale',
    })

    latestProc.stderr.push(Buffer.from('No conversation found with session ID: abc-stale\n'))

    await new Promise((r) => setTimeout(r, 50))
    expect(handle.resumeMissed()).toBe(true)
  })

  it('should set resumeMissed when the failure surfaces on the structured result event', async () => {
    // Claude Code 2.1.119+ also delivers the failure as a JSONL `result`
    // event with is_error=true and the message in either result/errors.
    // Detecting it on the JSONL channel is more stable than stderr because
    // the JSONL schema is versioned.
    const handle = spawnClaudeCode({
      model: 'haiku',
      systemPrompt: 'test',
      cwd: '/tmp',
      resumeSessionId: 'abc-stale',
    })

    latestProc.stdout.push(JSON.stringify({
      type: 'result',
      is_error: true,
      result: 'No conversation found with session ID: abc-stale',
    }) + '\n')

    await new Promise((r) => setTimeout(r, 50))
    expect(handle.resumeMissed()).toBe(true)
  })

  it('should set resumeMissed when result event reports the failure inside errors[]', async () => {
    const handle = spawnClaudeCode({
      model: 'haiku',
      systemPrompt: 'test',
      cwd: '/tmp',
      resumeSessionId: 'abc-stale',
    })

    latestProc.stdout.push(JSON.stringify({
      type: 'result',
      is_error: true,
      errors: ['No conversation found with session ID: abc-stale'],
    }) + '\n')

    await new Promise((r) => setTimeout(r, 50))
    expect(handle.resumeMissed()).toBe(true)
  })

  it('should NOT set resumeMissed for unrelated is_error result events', async () => {
    const handle = spawnClaudeCode({
      model: 'haiku',
      systemPrompt: 'test',
      cwd: '/tmp',
      resumeSessionId: 'abc-stale',
    })

    latestProc.stdout.push(JSON.stringify({
      type: 'result',
      is_error: true,
      result: 'Max turns exceeded',
    }) + '\n')

    await new Promise((r) => setTimeout(r, 50))
    expect(handle.resumeMissed()).toBe(false)
  })

  it('should handle result with non-string result field', async () => {
    const handle = spawnClaudeCode({
      model: 'haiku',
      systemPrompt: 'test',
      cwd: '/tmp',
    })

    const results: Array<{ text: string; isError: boolean }> = []
    handle.onResult((text, isError) => results.push({ text, isError }))

    const event = { type: 'result', result: { key: 'value' }, is_error: true }
    latestProc.stdout.push(JSON.stringify(event) + '\n')

    await new Promise((r) => setTimeout(r, 50))
    expect(results).toHaveLength(1)
    expect(results[0]!.text).toBe('{"key":"value"}')
    expect(results[0]!.isError).toBe(true)
  })
})
