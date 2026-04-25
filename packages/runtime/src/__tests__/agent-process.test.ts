/**
 * Unit tests for AgentProcess — lifecycle management.
 * Mocks claude-code spawning.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import type { AgentDefinition } from '@wanman/core'
import { MessageStore } from '../message-store.js'
import { Relay } from '../relay.js'
import { AgentProcess, buildGoalPrompt } from '../agent-process.js'

// Deferred helper for controlling promise resolution from tests
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// Per-call wait deferreds
let waitDeferreds: Array<ReturnType<typeof deferred<number>>>
let eventHandlers: Array<((event: Record<string, unknown>) => void) | undefined>
/** Per-call session-id reporter. Tests call this to simulate Claude emitting
 *  a system/init session id, which AgentProcess captures for idle_cached. */
let sessionIdReporters: Array<(sessionId: string) => void>
/** Per-call exit handler — AgentProcess registers one to read resumeMissed
 *  after the process exits. The mock spawn invokes it on wait()-resolve. */
let exitReporters: Array<(code: number) => void>
/** Per-call resumeMissed flag — tests flip this via `setSpawnResumeMissed`
 *  to simulate Claude refusing the requested --resume id. */
let resumeMissedFlags: boolean[]
let spawnCallCount: number

function setSpawnResumeMissed(idx: number, missed: boolean) {
  resumeMissedFlags[idx] = missed
}

const mockKill = vi.fn()
const codexStartRunMock = vi.hoisted(() => vi.fn())

vi.mock('../claude-code.js', () => ({
  spawnClaudeCode: vi.fn(() => {
    const idx = spawnCallCount++
    if (!waitDeferreds[idx]) {
      waitDeferreds[idx] = deferred<number>()
    }
    const handlers: { event?: (event: Record<string, unknown>) => void } = {}
    const sessionIdHandlers: Array<(id: string) => void> = []
    const exitHandlers: Array<(code: number) => void> = []
    eventHandlers[idx] = (event) => handlers.event?.(event)
    sessionIdReporters[idx] = (id) => {
      for (const h of sessionIdHandlers) h(id)
    }
    exitReporters[idx] = (code) => {
      for (const h of exitHandlers) h(code)
    }
    return {
      proc: { pid: 12345, stdin: { end: vi.fn() } },
      wait: vi.fn(async () => {
        const code = await waitDeferreds[idx]!.promise
        // Mirror real adapter behaviour: onExit fires after wait resolves.
        for (const h of exitHandlers) h(code)
        return code
      }),
      kill: mockKill,
      sendMessage: vi.fn(),
      onEvent: vi.fn((handler) => { handlers.event = handler }),
      onResult: vi.fn(),
      onSessionId: vi.fn((handler) => { sessionIdHandlers.push(handler) }),
      onExit: vi.fn((handler) => { exitHandlers.push(handler) }),
      resumeMissed: vi.fn(() => resumeMissedFlags[idx] ?? false),
    }
  }),
}))

vi.mock('../codex-adapter.js', () => ({
  CodexAdapter: vi.fn().mockImplementation(function CodexAdapterMock() {
    return {
      runtime: 'codex',
      startRun: vi.fn((opts) => {
      codexStartRunMock(opts)
      const idx = spawnCallCount++
      if (!waitDeferreds[idx]) {
        waitDeferreds[idx] = deferred<number>()
      }
      const handlers: { event?: (event: Record<string, unknown>) => void } = {}
      eventHandlers[idx] = (event) => handlers.event?.(event)
      return {
        proc: { pid: 12345, stdin: { end: vi.fn() } },
        wait: vi.fn(() => waitDeferreds[idx]!.promise),
        kill: mockKill,
        sendMessage: vi.fn(),
        onEvent: vi.fn((handler) => { handlers.event = handler }),
        onResult: vi.fn(),
        onExit: vi.fn(),
      }
      }),
    }
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

function makeRelay(): Relay {
  const db = new Database(':memory:')
  const store = new MessageStore(db)
  return new Relay(store)
}

function makeDef(overrides?: Partial<AgentDefinition>): AgentDefinition {
  return {
    name: 'test-agent',
    lifecycle: 'on-demand',
    model: 'haiku',
    systemPrompt: 'test',
    ...overrides,
  }
}

describe('AgentProcess', () => {
  let relay: Relay

  beforeEach(() => {
    vi.clearAllMocks()
    codexStartRunMock.mockClear()
    waitDeferreds = []
    eventHandlers = []
    sessionIdReporters = []
    exitReporters = []
    resumeMissedFlags = []
    spawnCallCount = 0
    relay = makeRelay()
  })

  describe('buildGoalPrompt', () => {
    it('lets CEO create backlog when the task list is empty', () => {
      const prompt = buildGoalPrompt('ceo', 'Launch a blueberry farm')
      expect(prompt).toContain('If no tasks exist yet, analyze the goal and create tasks')
    })

    it('keeps workers from creating backlog when they have no assigned tasks', () => {
      const prompt = buildGoalPrompt('marketing', 'Launch a blueberry farm')
      expect(prompt).toContain('task list --assignee marketing')
      expect(prompt).toContain('do not create new backlog on your own')
      expect(prompt).not.toContain('If no tasks exist yet, analyze the goal and create tasks')
    })
  })

  describe('constructor', () => {
    it('should start in idle state', () => {
      const agent = new AgentProcess(makeDef(), relay, '/tmp/work')
      expect(agent.state).toBe('idle')
    })

    it('rejects idle_cached + declared codex runtime at construction', () => {
      expect(() => new AgentProcess(
        makeDef({ name: 'support', lifecycle: 'idle_cached', runtime: 'codex' }),
        relay,
        '/tmp/work',
      )).toThrow(/idle_cached only works with the Claude runtime/)
    })

    it('rejects idle_cached when WANMAN_RUNTIME forces effective runtime to codex', () => {
      const original = process.env['WANMAN_RUNTIME']
      process.env['WANMAN_RUNTIME'] = 'codex'
      try {
        expect(() => new AgentProcess(
          makeDef({ name: 'support', lifecycle: 'idle_cached' }),
          relay,
          '/tmp/work',
        )).toThrow(/forced by WANMAN_RUNTIME=codex/)
      } finally {
        if (original === undefined) delete process.env['WANMAN_RUNTIME']
        else process.env['WANMAN_RUNTIME'] = original
      }
    })

    it('accepts idle_cached + claude runtime', () => {
      const agent = new AgentProcess(
        makeDef({ name: 'support', lifecycle: 'idle_cached', runtime: 'claude' }),
        relay,
        '/tmp/work',
      )
      expect(agent.state).toBe('idle')
      expect(agent.definition.lifecycle).toBe('idle_cached')
    })

    it('accepts idle_cached with default runtime (claude)', () => {
      const agent = new AgentProcess(
        makeDef({ name: 'support', lifecycle: 'idle_cached' }),
        relay,
        '/tmp/work',
      )
      expect(agent.state).toBe('idle')
    })

    it('should store definition', () => {
      const def = makeDef({ name: 'my-agent' })
      const agent = new AgentProcess(def, relay, '/tmp/work')
      expect(agent.definition.name).toBe('my-agent')
    })
  })

  describe('start — on-demand', () => {
    it('should stay idle for on-demand agents', async () => {
      const agent = new AgentProcess(makeDef({ lifecycle: 'on-demand' }), relay, '/tmp')
      await agent.start()
      expect(agent.state).toBe('idle')
    })

    it('should stay idle for idle_cached agents (no respawn loop)', async () => {
      const agent = new AgentProcess(makeDef({ lifecycle: 'idle_cached' }), relay, '/tmp')
      await agent.start()
      expect(agent.state).toBe('idle')
    })
  })

  describe('start — 24/7 (runLoop)', () => {
    it('should enter running state and spawn a process', async () => {
      // First spawn resolves immediately, then stop aborts the loop
      waitDeferreds[0] = deferred<number>()

      const agent = new AgentProcess(makeDef({ lifecycle: '24/7' }), relay, '/tmp')
      await agent.start()

      // Give the runLoop time to spawn
      await new Promise((r) => setTimeout(r, 10))
      expect(agent.state).toBe('running')

      // Resolve the first spawn and stop before respawn
      waitDeferreds[0].resolve(0)
      await new Promise((r) => setTimeout(r, 10))

      agent.stop()
      expect(agent.state).toBe('stopped')
    })

    it('should include pending messages in the prompt', async () => {
      const { spawnClaudeCode } = await import('../claude-code.js')
      waitDeferreds[0] = deferred<number>()

      // Pre-queue a message
      relay.send('alice', 'test-agent', 'message', 'hello from alice', 'normal')

      const agent = new AgentProcess(makeDef({ lifecycle: '24/7', name: 'test-agent' }), relay, '/tmp')
      await agent.start()

      await new Promise((r) => setTimeout(r, 10))

      // spawnClaudeCode should have been called with a prompt containing the message
      expect(spawnClaudeCode).toHaveBeenCalledWith(expect.objectContaining({
        initialMessage: expect.stringContaining('alice'),
      }))

      waitDeferreds[0].resolve(0)
      agent.stop()
      await new Promise((r) => setTimeout(r, 10))
    })

    it('should use default prompt when no pending messages', async () => {
      const { spawnClaudeCode } = await import('../claude-code.js')
      waitDeferreds[0] = deferred<number>()

      const agent = new AgentProcess(makeDef({ lifecycle: '24/7' }), relay, '/tmp')
      await agent.start()

      await new Promise((r) => setTimeout(r, 10))

      expect(spawnClaudeCode).toHaveBeenCalledWith(expect.objectContaining({
        initialMessage: expect.stringContaining('wanman recv'),
      }))

      waitDeferreds[0].resolve(0)
      agent.stop()
      await new Promise((r) => setTimeout(r, 10))
    })

    it('should skip empty worker spins when runtime reports no autonomous work', async () => {
      const { spawnClaudeCode } = await import('../claude-code.js')

      const agent = new AgentProcess(
        makeDef({ lifecycle: '24/7', name: 'marketing' }),
        relay,
        '/tmp',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => false,
      )
      await agent.start()

      await new Promise((r) => setTimeout(r, 20))

      expect(spawnClaudeCode).not.toHaveBeenCalled()
      expect(agent.state).toBe('idle')

      agent.stop()
    })

    it('should respawn after exit (loop behavior)', async () => {
      const { spawnClaudeCode } = await import('../claude-code.js')
      // First spawn exits immediately, second blocks until stop
      waitDeferreds[0] = deferred<number>()
      waitDeferreds[0].resolve(0)
      waitDeferreds[1] = deferred<number>()

      const agent = new AgentProcess(makeDef({ lifecycle: '24/7' }), relay, '/tmp')
      await agent.start()

      // Wait long enough for first exit + RESPAWN_DELAY (5s) + second spawn
      // But we can't wait 5 real seconds, so stop during the sleep
      await new Promise((r) => setTimeout(r, 50))

      agent.stop()
      await new Promise((r) => setTimeout(r, 10))

      // At minimum the first spawn happened
      expect(vi.mocked(spawnClaudeCode).mock.calls.length).toBeGreaterThanOrEqual(1)
    })

    it('should recover from errors in runLoop', async () => {
      // First spawn throws, second blocks until stop
      waitDeferreds[0] = deferred<number>()
      waitDeferreds[0].reject(new Error('spawn failed'))
      waitDeferreds[1] = deferred<number>()

      const agent = new AgentProcess(makeDef({ lifecycle: '24/7' }), relay, '/tmp')
      await agent.start()

      // Give time for error handling
      await new Promise((r) => setTimeout(r, 50))

      // Agent should be in error state temporarily, then back to loop
      agent.stop()
      await new Promise((r) => setTimeout(r, 10))
      expect(agent.state).toBe('stopped')
    })

    it('should stop cleanly when aborted during running', async () => {
      waitDeferreds[0] = deferred<number>()

      const agent = new AgentProcess(makeDef({ lifecycle: '24/7' }), relay, '/tmp')
      await agent.start()

      await new Promise((r) => setTimeout(r, 10))
      expect(agent.state).toBe('running')

      agent.stop()
      // Immediately after stop(), state should be 'stopped' and kill should be called
      expect(agent.state).toBe('stopped')
      expect(mockKill).toHaveBeenCalled()

      // Resolve to avoid dangling promise
      waitDeferreds[0].resolve(0)
    })
  })

  describe('trigger — on-demand', () => {
    it('should spawn when there are pending messages', async () => {
      waitDeferreds[0] = deferred<number>()
      waitDeferreds[0].resolve(0)

      const agent = new AgentProcess(makeDef(), relay, '/tmp')
      relay.send('alice', 'test-agent', 'message', 'hello', 'normal')

      await agent.trigger()
      expect(agent.state).toBe('idle')
    })

    it('should skip trigger when no pending messages', async () => {
      const { spawnClaudeCode } = await import('../claude-code.js')
      const agent = new AgentProcess(makeDef(), relay, '/tmp')

      await agent.trigger()
      expect(spawnClaudeCode).not.toHaveBeenCalled()
    })

    it('should skip trigger when already running', async () => {
      waitDeferreds[0] = deferred<number>()

      const agent = new AgentProcess(makeDef(), relay, '/tmp')
      relay.send('alice', 'test-agent', 'message', 'hello', 'normal')

      const triggerPromise = agent.trigger()
      expect(agent.state).toBe('running')

      relay.send('alice', 'test-agent', 'message', 'hello2', 'normal')
      await agent.trigger() // returns early

      waitDeferreds[0].resolve(0)
      await triggerPromise
    })

    it('should re-trigger to drain backlog when messages arrive during execution', async () => {
      const { spawnClaudeCode } = await import('../claude-code.js')

      // First trigger: process msg1, during which msg2 arrives
      waitDeferreds[0] = deferred<number>()
      // Second trigger (backlog drain): process msg2
      waitDeferreds[1] = deferred<number>()
      waitDeferreds[1].resolve(0)

      const agent = new AgentProcess(makeDef(), relay, '/tmp')
      relay.send('alice', 'test-agent', 'message', 'msg1', 'normal')

      const triggerPromise = agent.trigger()

      // While msg1 is being processed, a new message arrives
      relay.send('alice', 'test-agent', 'message', 'msg2', 'normal')

      // Resolve first trigger — backlog drain should re-trigger automatically
      waitDeferreds[0].resolve(0)
      await triggerPromise

      // Give time for the async re-trigger to complete
      await new Promise((r) => setTimeout(r, 50))

      // spawnClaudeCode should have been called twice (original + backlog drain)
      expect(vi.mocked(spawnClaudeCode).mock.calls.length).toBe(2)
      expect(agent.state).toBe('idle')
    })

    it('should not re-trigger when no backlog remains', async () => {
      const { spawnClaudeCode } = await import('../claude-code.js')
      waitDeferreds[0] = deferred<number>()
      waitDeferreds[0].resolve(0)

      const agent = new AgentProcess(makeDef(), relay, '/tmp')
      relay.send('alice', 'test-agent', 'message', 'msg1', 'normal')

      await agent.trigger()

      // No new messages arrived during execution — should NOT re-trigger
      expect(vi.mocked(spawnClaudeCode).mock.calls.length).toBe(1)
      expect(agent.state).toBe('idle')
    })

    it('on-demand never passes resumeSessionId, even after a session id is observed', async () => {
      const { spawnClaudeCode } = await import('../claude-code.js')
      waitDeferreds[0] = deferred<number>()
      waitDeferreds[1] = deferred<number>()

      const agent = new AgentProcess(makeDef({ lifecycle: 'on-demand' }), relay, '/tmp')

      // First trigger: relay enqueues msg1, mock fires onSessionId mid-run.
      relay.send('alice', 'test-agent', 'message', 'msg1', 'normal')
      const t1 = agent.trigger()
      await new Promise((r) => setTimeout(r, 5))
      sessionIdReporters[0]!('session-from-claude-1')
      waitDeferreds[0].resolve(0)
      await t1

      // Second trigger should still spawn fresh — on-demand discards the id.
      relay.send('alice', 'test-agent', 'message', 'msg2', 'normal')
      const t2 = agent.trigger()
      await new Promise((r) => setTimeout(r, 5))
      waitDeferreds[1].resolve(0)
      await t2

      const calls = vi.mocked(spawnClaudeCode).mock.calls
      expect(calls.length).toBe(2)
      expect(calls[0]![0]).not.toHaveProperty('resumeSessionId')
      expect(calls[1]![0]).not.toHaveProperty('resumeSessionId')
    })
  })

  describe('trigger — idle_cached', () => {
    it('skips resumeSessionId on the very first trigger (no session captured yet)', async () => {
      const { spawnClaudeCode } = await import('../claude-code.js')
      waitDeferreds[0] = deferred<number>()
      waitDeferreds[0].resolve(0)

      const agent = new AgentProcess(makeDef({ lifecycle: 'idle_cached' }), relay, '/tmp')
      relay.send('alice', 'test-agent', 'message', 'first message', 'normal')

      await agent.trigger()

      const calls = vi.mocked(spawnClaudeCode).mock.calls
      expect(calls.length).toBe(1)
      expect(calls[0]![0].resumeSessionId).toBeUndefined()
    })

    it('passes the previously-captured session id as resumeSessionId on the next trigger', async () => {
      const { spawnClaudeCode } = await import('../claude-code.js')
      waitDeferreds[0] = deferred<number>()
      waitDeferreds[1] = deferred<number>()

      const agent = new AgentProcess(makeDef({ lifecycle: 'idle_cached' }), relay, '/tmp')

      relay.send('alice', 'test-agent', 'message', 'msg1', 'normal')
      const t1 = agent.trigger()
      await new Promise((r) => setTimeout(r, 5))
      sessionIdReporters[0]!('captured-session-xyz')
      waitDeferreds[0].resolve(0)
      await t1

      relay.send('alice', 'test-agent', 'message', 'msg2', 'normal')
      const t2 = agent.trigger()
      await new Promise((r) => setTimeout(r, 5))
      waitDeferreds[1].resolve(0)
      await t2

      const calls = vi.mocked(spawnClaudeCode).mock.calls
      expect(calls.length).toBe(2)
      expect(calls[0]![0].resumeSessionId).toBeUndefined()
      expect(calls[1]![0].resumeSessionId).toBe('captured-session-xyz')
    })

    it('falls back to a cold-start retry without resume when the prior session is missing', async () => {
      const { spawnClaudeCode } = await import('../claude-code.js')
      waitDeferreds[0] = deferred<number>()
      waitDeferreds[1] = deferred<number>()
      waitDeferreds[2] = deferred<number>()

      const agent = new AgentProcess(makeDef({ lifecycle: 'idle_cached' }), relay, '/tmp')

      // Run 1: capture a session id.
      relay.send('alice', 'test-agent', 'message', 'msg1', 'normal')
      const t1 = agent.trigger()
      await new Promise((r) => setTimeout(r, 5))
      sessionIdReporters[0]!('about-to-go-stale')
      waitDeferreds[0].resolve(0)
      await t1

      // Run 2: simulate Claude rejecting --resume on the next spawn. The
      // mock's resumeMissed flag is read inside onExit, which AgentProcess
      // checks after wait() resolves.
      setSpawnResumeMissed(1, true)
      relay.send('alice', 'test-agent', 'message', 'msg2', 'normal')
      const t2 = agent.trigger()
      await new Promise((r) => setTimeout(r, 5))
      waitDeferreds[1].resolve(0)
      // Wait for AgentProcess to observe resumeMissed and fire the cold-start.
      await new Promise((r) => setTimeout(r, 10))
      waitDeferreds[2].resolve(0)
      await t2

      const calls = vi.mocked(spawnClaudeCode).mock.calls
      expect(calls.length).toBe(3)
      // Spawn 1: cold start (no session yet)
      expect(calls[0]![0].resumeSessionId).toBeUndefined()
      // Spawn 2: tried to resume the captured id...
      expect(calls[1]![0].resumeSessionId).toBe('about-to-go-stale')
      // Spawn 3: cold-start retry after the resume miss
      expect(calls[2]![0].resumeSessionId).toBeUndefined()
    })

    it('handleSteer triggers idle_cached agents the same way it triggers on-demand', async () => {
      waitDeferreds[0] = deferred<number>()
      waitDeferreds[0].resolve(0)

      const agent = new AgentProcess(makeDef({ lifecycle: 'idle_cached' }), relay, '/tmp')
      await agent.start()
      expect(agent.state).toBe('idle')

      relay.send('alice', 'test-agent', 'message', 'urgent', 'steer')
      agent.handleSteer()

      // Let the async trigger run to completion.
      await new Promise((r) => setTimeout(r, 10))
      expect(spawnCallCount).toBeGreaterThanOrEqual(1)
    })

    it('merges per-run environment from envProvider before spawn', async () => {
      const { spawnClaudeCode } = await import('../claude-code.js')
      waitDeferreds[0] = deferred<number>()
      waitDeferreds[0].resolve(0)

      const envProvider = vi.fn(async () => ({
        HOME: '/tmp/agent-home',
        WANMAN_ACTIVE_SKILLS_DIR: '/tmp/active-skills',
      }))

      const agent = new AgentProcess(
        makeDef(),
        relay,
        '/tmp',
        undefined,
        { WANMAN_AGENT_NAME: 'test-agent' },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        envProvider,
      )

      relay.send('alice', 'test-agent', 'message', 'msg1', 'normal')
      await agent.trigger()

      expect(envProvider).toHaveBeenCalledWith('test-agent')
      expect(spawnClaudeCode).toHaveBeenCalledWith(expect.objectContaining({
        env: expect.objectContaining({
          WANMAN_AGENT_NAME: 'test-agent',
          HOME: '/tmp/agent-home',
          WANMAN_ACTIVE_SKILLS_DIR: '/tmp/active-skills',
        }),
      }))
    })

    it('passes Codex reasoning effort and fast-mode flags to Codex runs', async () => {
      waitDeferreds[0] = deferred<number>()
      waitDeferreds[0].resolve(0)

      const agent = new AgentProcess(
        makeDef({ runtime: 'codex', model: 'high' }),
        relay,
        '/tmp',
        undefined,
        {
          WANMAN_CODEX_REASONING_EFFORT: 'xhigh',
          WANMAN_CODEX_FAST: 'yes',
        },
      )

      relay.send('alice', 'test-agent', 'message', 'msg1', 'normal')
      await agent.trigger()

      expect(codexStartRunMock).toHaveBeenCalledWith(expect.objectContaining({
        runtime: 'codex',
        model: 'gpt-5.4',
        reasoningEffort: 'xhigh',
        fast: true,
      }))
    })

    it('handles all runtime event log formats without interrupting the run', async () => {
      relay.send('ceo', 'test-agent', 'message', 'do work', 'normal')

      const agent = new AgentProcess(makeDef(), relay, '/tmp')
      waitDeferreds[0] = deferred<number>()
      const triggerPromise = agent.trigger()
      await new Promise(r => setTimeout(r, 0))

      eventHandlers[0]?.({ type: 'item.completed', item: { title: 'done' } })
      eventHandlers[0]?.({ type: 'turn.failed', error: { message: 'bad turn' } })
      eventHandlers[0]?.({ type: 'event', tool_name: 'Bash', tool_input: { command: 'pnpm test' } })
      eventHandlers[0]?.({ type: 'event', tool_name: 'Read', tool_input: { file_path: 'README.md' } })
      eventHandlers[0]?.({
        type: 'event',
        message: {
          content: [
            { type: 'tool_use', name: 'Write', input: { file_path: 'out.txt' } },
            { type: 'text', text: 'summary text' },
            { type: 'tool_result', is_error: false, content: 'ok' },
          ],
        },
      })
      eventHandlers[0]?.({
        type: 'result',
        cost_usd: 0.01,
        duration_ms: 10,
        is_error: false,
        stop_reason: 'complete',
      })

      waitDeferreds[0].resolve(0)
      await triggerPromise
      expect(agent.state).toBe('idle')
    })
  })

  describe('handleSteer', () => {
    it('should kill current process when running', async () => {
      waitDeferreds[0] = deferred<number>()

      const agent = new AgentProcess(makeDef(), relay, '/tmp')
      relay.send('alice', 'test-agent', 'message', 'hello', 'normal')

      const triggerPromise = agent.trigger()
      // Wait for the async ensureFresh() microtask to settle before spawn
      await new Promise((r) => setTimeout(r, 10))

      agent.handleSteer()
      expect(mockKill).toHaveBeenCalled()

      waitDeferreds[0].resolve(0)
      await triggerPromise
    })

    it('should not crash when no current process', () => {
      const agent = new AgentProcess(makeDef(), relay, '/tmp')
      // handleSteer with no running process should not throw
      expect(() => agent.handleSteer()).not.toThrow()
    })

    it('should trigger on-demand agent from idle when steer arrives', async () => {
      waitDeferreds[0] = deferred<number>()
      waitDeferreds[0].resolve(0)

      const agent = new AgentProcess(makeDef({ lifecycle: 'on-demand' }), relay, '/tmp')
      await agent.start()

      relay.send('alice', 'test-agent', 'message', 'urgent', 'steer')
      agent.handleSteer()

      await new Promise((r) => setTimeout(r, 50))
    })
  })

  describe('stop', () => {
    it('should set state to stopped', () => {
      const agent = new AgentProcess(makeDef(), relay, '/tmp')
      agent.stop()
      expect(agent.state).toBe('stopped')
    })

    it('should kill current process if running', async () => {
      waitDeferreds[0] = deferred<number>()

      const agent = new AgentProcess(makeDef(), relay, '/tmp')
      relay.send('alice', 'test-agent', 'message', 'hello', 'normal')

      const triggerPromise = agent.trigger()
      // Wait for the async ensureFresh() microtask to settle before spawn
      await new Promise((r) => setTimeout(r, 10))

      agent.stop()
      expect(mockKill).toHaveBeenCalled()
      expect(agent.state).toBe('stopped')

      waitDeferreds[0].resolve(0)
      await triggerPromise
    })

    it('should be idempotent', () => {
      const agent = new AgentProcess(makeDef(), relay, '/tmp')
      agent.stop()
      agent.stop()
      expect(agent.state).toBe('stopped')
    })
  })

  describe('pause/resume', () => {
    it('sends SIGSTOP and SIGCONT to the active process', async () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
      waitDeferreds[0] = deferred<number>()

      const agent = new AgentProcess(makeDef(), relay, '/tmp')
      relay.send('alice', 'test-agent', 'message', 'hello', 'normal')
      const triggerPromise = agent.trigger()
      await new Promise((r) => setTimeout(r, 10))

      agent.pause()
      expect(agent.state).toBe('paused')
      expect(killSpy).toHaveBeenCalledWith(12345, 'SIGSTOP')

      agent.resume()
      expect(agent.state).toBe('running')
      expect(killSpy).toHaveBeenCalledWith(12345, 'SIGCONT')

      waitDeferreds[0].resolve(0)
      await triggerPromise
      killSpy.mockRestore()
    })

    it('ignores pause/resume when the agent is not in the matching state', () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
      const agent = new AgentProcess(makeDef(), relay, '/tmp')

      agent.pause()
      agent.resume()

      expect(agent.state).toBe('idle')
      expect(killSpy).not.toHaveBeenCalled()
      killSpy.mockRestore()
    })
  })

  describe('time budget', () => {
    it('should kill agent when time budget is exceeded', async () => {
      relay.send('ceo', 'test-agent', 'message', 'work', 'normal')

      // Create agent with 50ms time budget
      const agent = new AgentProcess(
        makeDef(), relay, '/tmp',
        undefined, undefined, undefined, undefined, undefined,
        50, // timeBudgetMs
      )

      waitDeferreds[0] = deferred<number>()

      const triggerPromise = agent.trigger()

      // Wait for the budget to expire
      await new Promise(r => setTimeout(r, 100))

      // Kill should have been called
      expect(mockKill).toHaveBeenCalled()

      // Resolve the wait to allow trigger() to complete
      waitDeferreds[0].resolve(137) // SIGTERM exit code
      await triggerPromise
    })

    it('should NOT kill agent when it finishes before budget', async () => {
      relay.send('ceo', 'test-agent', 'message', 'quick work', 'normal')

      const agent = new AgentProcess(
        makeDef(), relay, '/tmp',
        undefined, undefined, undefined, undefined, undefined,
        5000, // 5s budget — plenty of time
      )

      waitDeferreds[0] = deferred<number>()

      const triggerPromise = agent.trigger()

      // Resolve immediately (agent finishes fast)
      waitDeferreds[0].resolve(0)
      await triggerPromise

      // Kill should NOT have been called
      expect(mockKill).not.toHaveBeenCalled()
    })
  })

  describe('run complete callback', () => {
    it('should fire onRunComplete after on-demand agent finishes', async () => {
      relay.send('ceo', 'test-agent', 'message', 'do work', 'normal')

      const callbacks: Array<{ agentName: string; exitCode: number; errored: boolean; inputTokens: number; outputTokens: number; totalTokens: number }> = []
      const agent = new AgentProcess(
        makeDef(), relay, '/tmp',
        undefined, undefined, undefined, undefined,
        (info) => callbacks.push(info),
      )

      waitDeferreds[0] = deferred<number>()
      const triggerPromise = agent.trigger()
      await new Promise(r => setTimeout(r, 0))
      eventHandlers[0]?.({
        type: 'result',
        usage: {
          input_tokens: 1200,
          output_tokens: 300,
        },
      })
      waitDeferreds[0].resolve(0)
      await triggerPromise

      expect(callbacks).toHaveLength(1)
      expect(callbacks[0]!.agentName).toBe('test-agent')
      expect(callbacks[0]!.exitCode).toBe(0)
      expect(callbacks[0]!.errored).toBe(false)
      expect(callbacks[0]!.inputTokens).toBe(1200)
      expect(callbacks[0]!.outputTokens).toBe(300)
      expect(callbacks[0]!.totalTokens).toBe(1500)
    })

    it('should capture Codex token totals from event_msg payload metadata', async () => {
      relay.send('ceo', 'test-agent', 'message', 'do codex work', 'normal')

      const callbacks: Array<{ inputTokens: number; outputTokens: number; totalTokens: number }> = []
      const agent = new AgentProcess(
        makeDef(), relay, '/tmp',
        undefined, undefined, undefined, undefined,
        (info) => callbacks.push(info),
      )

      waitDeferreds[0] = deferred<number>()
      const triggerPromise = agent.trigger()
      await new Promise(r => setTimeout(r, 0))
      eventHandlers[0]?.({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            input_tokens: 26549,
            output_tokens: 1590,
            total_token_usage: 28139,
          },
        },
      })
      waitDeferreds[0].resolve(0)
      await triggerPromise

      expect(callbacks).toHaveLength(1)
      expect(callbacks[0]!.inputTokens).toBe(26549)
      expect(callbacks[0]!.outputTokens).toBe(1590)
      expect(callbacks[0]!.totalTokens).toBe(28139)
    })

    it('should report errored=true when exit code is non-zero', async () => {
      relay.send('ceo', 'test-agent', 'message', 'fail work', 'normal')

      const callbacks: Array<{ errored: boolean; exitCode: number }> = []
      const agent = new AgentProcess(
        makeDef(), relay, '/tmp',
        undefined, undefined, undefined, undefined,
        (info) => callbacks.push(info),
      )

      waitDeferreds[0] = deferred<number>()
      const triggerPromise = agent.trigger()
      waitDeferreds[0].resolve(1) // error exit
      await triggerPromise

      expect(callbacks[0]!.errored).toBe(true)
      expect(callbacks[0]!.exitCode).toBe(1)
    })

    it('should track steer count in callback', async () => {
      // Use a 24/7 agent that's already running — steer increments counter
      // but doesn't trigger new runs
      const callbacks: Array<{ steerCount: number }> = []
      const agent = new AgentProcess(
        makeDef({ lifecycle: '24/7' }), relay, '/tmp',
        undefined, undefined, undefined, undefined,
        (info) => callbacks.push(info),
      )

      waitDeferreds[0] = deferred<number>()
      agent.start()

      // Wait for agent to start running
      await new Promise(r => setTimeout(r, 10))

      // Steers while running increment counter but kill+respawn handled by loop
      agent.handleSteer()
      agent.handleSteer()

      // First run completes (killed by steer)
      waitDeferreds[0].resolve(137)
      await new Promise(r => setTimeout(r, 50))

      // The callback should have steerCount = 2
      expect(callbacks.length).toBeGreaterThanOrEqual(1)
      expect(callbacks[0]!.steerCount).toBe(2)

      agent.stop()
    })
  })
})
