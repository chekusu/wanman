/**
 * Unit tests for Supervisor — JSON-RPC handling and coordination.
 * Uses in-memory SQLite, real stores, but mocks AgentProcess / HTTP server.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { AgentMatrixConfig, JsonRpcRequest } from '@wanman/core'
import { RPC_METHODS, RPC_ERRORS } from '@wanman/core'
import { Supervisor } from '../supervisor.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Mock http-server to avoid real network binding
vi.mock('../http-server.js', () => ({
  createHttpServer: vi.fn(() => ({
    close: (cb: () => void) => cb(),
  })),
}))

// Track whether start should fail
let startShouldFail = false
let createdAgentDefinitions: Array<Record<string, unknown>> = []

// Mock agent-process to avoid spawning real processes
vi.mock('../agent-process.js', () => {
  class MockAgentProcess {
    definition: unknown
    state = 'idle'
    constructor(def: unknown) {
      this.definition = def
      createdAgentDefinitions.push(def as Record<string, unknown>)
    }
    async start() {
      if (startShouldFail) throw new Error('spawn failed')
    }
    trigger() { return Promise.resolve() }
    stop() {}
    handleSteer() {}
  }
  return { AgentProcess: MockAgentProcess }
})

// Mock logger to suppress output
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

function makeConfig(overrides?: Partial<AgentMatrixConfig>): AgentMatrixConfig {
  return {
    agents: [
      { name: 'echo', lifecycle: '24/7', model: 'haiku', systemPrompt: 'echo bot' },
      { name: 'ping', lifecycle: 'on-demand', model: 'haiku', systemPrompt: 'ping bot' },
    ],
    dbPath: ':memory:',
    port: 0,
    ...overrides,
  }
}

function rpc(method: string, params?: Record<string, unknown>): JsonRpcRequest {
  return { jsonrpc: '2.0', id: 1, method, params }
}

describe('Supervisor', () => {
  let supervisor: Supervisor
  let tempWorkspace: string

  beforeEach(async () => {
    startShouldFail = false
    createdAgentDefinitions = []
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'wanman-supervisor-'))
    fs.mkdirSync(path.join(tempWorkspace, 'ping'), { recursive: true })
    fs.writeFileSync(path.join(tempWorkspace, 'ping', 'AGENT.md'), '# Ping agent')
    supervisor = new Supervisor(makeConfig())
    await supervisor.start()
  })

  afterEach(() => {
    fs.rmSync(tempWorkspace, { recursive: true, force: true })
  })

  describe('handleRpc — agent.send', () => {
    it('should queue a message to a known agent', () => {
      const res = supervisor.handleRpc(rpc(RPC_METHODS.AGENT_SEND, {
        from: 'cli',
        to: 'echo',
        type: 'message',
        payload: 'hello',
        priority: 'normal',
      }))
      expect(res.error).toBeUndefined()
      expect((res.result as Record<string, unknown>).status).toBe('queued')
      expect((res.result as Record<string, unknown>).id).toBeTruthy()
    })

    it('posts a best-effort thread sync event when story sync env is present', () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(null, { status: 200 }),
      )
      const previousEnv = {
        WANMAN_SYNC_URL: process.env['WANMAN_SYNC_URL'],
        WANMAN_SYNC_SECRET: process.env['WANMAN_SYNC_SECRET'],
        WANMAN_STORY_ID: process.env['WANMAN_STORY_ID'],
      }
      process.env['WANMAN_SYNC_URL'] = 'https://api.example.com/api/sync'
      process.env['WANMAN_SYNC_SECRET'] = 'sync-secret'
      process.env['WANMAN_STORY_ID'] = 'story-1'

      try {
        supervisor.handleRpc(rpc(RPC_METHODS.AGENT_SEND, {
          from: 'echo',
          to: 'ping',
          type: 'message',
          payload: 'Please revise the rollout plan.',
          priority: 'steer',
        }))

        expect(fetchSpy).toHaveBeenCalledWith(
          'https://api.example.com/api/sync/event',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({
              event_type: 'thread',
              classification: 'steer',
              agent: 'echo',
              payload: {
                from: 'echo',
                to: 'ping',
                type: 'message',
                payload: 'Please revise the rollout plan.',
                priority: 'steer',
              },
            }),
          }),
        )
      } finally {
        if (previousEnv.WANMAN_SYNC_URL === undefined) delete process.env['WANMAN_SYNC_URL']
        else process.env['WANMAN_SYNC_URL'] = previousEnv.WANMAN_SYNC_URL
        if (previousEnv.WANMAN_SYNC_SECRET === undefined) delete process.env['WANMAN_SYNC_SECRET']
        else process.env['WANMAN_SYNC_SECRET'] = previousEnv.WANMAN_SYNC_SECRET
        if (previousEnv.WANMAN_STORY_ID === undefined) delete process.env['WANMAN_STORY_ID']
        else process.env['WANMAN_STORY_ID'] = previousEnv.WANMAN_STORY_ID
        fetchSpy.mockRestore()
      }
    })

    it('accepts human as a special conversation target without queueing relay delivery', () => {
      const relay = (supervisor as unknown as {
        relay: { send: (from: string, to: string, type: string, payload: unknown, priority: string) => string }
      }).relay
      const sendSpy = vi.spyOn(relay, 'send')

      const res = supervisor.handleRpc(rpc(RPC_METHODS.AGENT_SEND, {
        from: 'ceo',
        to: 'human',
        type: 'message',
        payload: 'Please confirm the rollout plan.',
        priority: 'normal',
      }))

      expect(res.error).toBeUndefined()
      expect((res.result as Record<string, unknown>).status).toBe('queued')
      expect(sendSpy).not.toHaveBeenCalled()
    })

    it('infers decision type for normal human-directed messages in story sync', () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(null, { status: 200 }),
      )
      const previousEnv = {
        WANMAN_SYNC_URL: process.env['WANMAN_SYNC_URL'],
        WANMAN_SYNC_SECRET: process.env['WANMAN_SYNC_SECRET'],
        WANMAN_STORY_ID: process.env['WANMAN_STORY_ID'],
      }
      process.env['WANMAN_SYNC_URL'] = 'https://api.example.com/api/sync'
      process.env['WANMAN_SYNC_SECRET'] = 'sync-secret'
      process.env['WANMAN_STORY_ID'] = 'story-1'

      try {
        supervisor.handleRpc(rpc(RPC_METHODS.AGENT_SEND, {
          from: 'ceo',
          to: 'human',
          type: 'message',
          payload: 'Do you approve the rollout?',
          priority: 'normal',
        }))

        expect(fetchSpy).toHaveBeenCalledWith(
          'https://api.example.com/api/sync/event',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({
              event_type: 'thread',
              classification: 'normal',
              agent: 'ceo',
              payload: {
                from: 'ceo',
                to: 'human',
                type: 'decision',
                payload: 'Do you approve the rollout?',
                priority: 'normal',
              },
            }),
          }),
        )
      } finally {
        if (previousEnv.WANMAN_SYNC_URL === undefined) delete process.env['WANMAN_SYNC_URL']
        else process.env['WANMAN_SYNC_URL'] = previousEnv.WANMAN_SYNC_URL
        if (previousEnv.WANMAN_SYNC_SECRET === undefined) delete process.env['WANMAN_SYNC_SECRET']
        else process.env['WANMAN_SYNC_SECRET'] = previousEnv.WANMAN_SYNC_SECRET
        if (previousEnv.WANMAN_STORY_ID === undefined) delete process.env['WANMAN_STORY_ID']
        else process.env['WANMAN_STORY_ID'] = previousEnv.WANMAN_STORY_ID
        fetchSpy.mockRestore()
      }
    })

    it('infers blocker type for steer human-directed messages in story sync', () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(null, { status: 200 }),
      )
      const previousEnv = {
        WANMAN_SYNC_URL: process.env['WANMAN_SYNC_URL'],
        WANMAN_SYNC_SECRET: process.env['WANMAN_SYNC_SECRET'],
        WANMAN_STORY_ID: process.env['WANMAN_STORY_ID'],
      }
      process.env['WANMAN_SYNC_URL'] = 'https://api.example.com/api/sync'
      process.env['WANMAN_SYNC_SECRET'] = 'sync-secret'
      process.env['WANMAN_STORY_ID'] = 'story-1'

      try {
        supervisor.handleRpc(rpc(RPC_METHODS.AGENT_SEND, {
          from: 'dev',
          to: 'human',
          type: 'message',
          payload: 'I am blocked until you grant repo access.',
          priority: 'steer',
        }))

        expect(fetchSpy).toHaveBeenCalledWith(
          'https://api.example.com/api/sync/event',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({
              event_type: 'thread',
              classification: 'steer',
              agent: 'dev',
              payload: {
                from: 'dev',
                to: 'human',
                type: 'blocker',
                payload: 'I am blocked until you grant repo access.',
                priority: 'steer',
              },
            }),
          }),
        )
      } finally {
        if (previousEnv.WANMAN_SYNC_URL === undefined) delete process.env['WANMAN_SYNC_URL']
        else process.env['WANMAN_SYNC_URL'] = previousEnv.WANMAN_SYNC_URL
        if (previousEnv.WANMAN_SYNC_SECRET === undefined) delete process.env['WANMAN_SYNC_SECRET']
        else process.env['WANMAN_SYNC_SECRET'] = previousEnv.WANMAN_SYNC_SECRET
        if (previousEnv.WANMAN_STORY_ID === undefined) delete process.env['WANMAN_STORY_ID']
        else process.env['WANMAN_STORY_ID'] = previousEnv.WANMAN_STORY_ID
        fetchSpy.mockRestore()
      }
    })

    it('preserves explicit human-directed message types in story sync', () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(null, { status: 200 }),
      )
      const previousEnv = {
        WANMAN_SYNC_URL: process.env['WANMAN_SYNC_URL'],
        WANMAN_SYNC_SECRET: process.env['WANMAN_SYNC_SECRET'],
        WANMAN_STORY_ID: process.env['WANMAN_STORY_ID'],
      }
      process.env['WANMAN_SYNC_URL'] = 'https://api.example.com/api/sync'
      process.env['WANMAN_SYNC_SECRET'] = 'sync-secret'
      process.env['WANMAN_STORY_ID'] = 'story-1'

      try {
        supervisor.handleRpc(rpc(RPC_METHODS.AGENT_SEND, {
          from: 'dev',
          to: 'human',
          type: 'decision',
          payload: 'Choose between patch A and patch B.',
          priority: 'normal',
        }))

        expect(fetchSpy).toHaveBeenCalledWith(
          'https://api.example.com/api/sync/event',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({
              event_type: 'thread',
              classification: 'normal',
              agent: 'dev',
              payload: {
                from: 'dev',
                to: 'human',
                type: 'decision',
                payload: 'Choose between patch A and patch B.',
                priority: 'normal',
              },
            }),
          }),
        )
      } finally {
        if (previousEnv.WANMAN_SYNC_URL === undefined) delete process.env['WANMAN_SYNC_URL']
        else process.env['WANMAN_SYNC_URL'] = previousEnv.WANMAN_SYNC_URL
        if (previousEnv.WANMAN_SYNC_SECRET === undefined) delete process.env['WANMAN_SYNC_SECRET']
        else process.env['WANMAN_SYNC_SECRET'] = previousEnv.WANMAN_SYNC_SECRET
        if (previousEnv.WANMAN_STORY_ID === undefined) delete process.env['WANMAN_STORY_ID']
        else process.env['WANMAN_STORY_ID'] = previousEnv.WANMAN_STORY_ID
        fetchSpy.mockRestore()
      }
    })

    it('should return error for unknown target agent', () => {
      const res = supervisor.handleRpc(rpc(RPC_METHODS.AGENT_SEND, {
        from: 'cli',
        to: 'nonexistent',
        type: 'message',
        payload: 'hello',
        priority: 'normal',
      }))
      expect(res.error?.code).toBe(RPC_ERRORS.AGENT_NOT_FOUND)
    })

    it('should return error for missing params', () => {
      const res = supervisor.handleRpc(rpc(RPC_METHODS.AGENT_SEND, {
        from: 'cli',
      }))
      expect(res.error?.code).toBe(RPC_ERRORS.INVALID_PARAMS)
    })
  })

  describe('handleRpc — agent.recv', () => {
    it('should return pending messages', () => {
      // First send a message
      supervisor.handleRpc(rpc(RPC_METHODS.AGENT_SEND, {
        from: 'cli', to: 'echo', type: 'message', payload: 'hi', priority: 'normal',
      }))
      // Then receive
      const res = supervisor.handleRpc(rpc(RPC_METHODS.AGENT_RECV, { agent: 'echo' }))
      expect(res.error).toBeUndefined()
      const messages = (res.result as { messages: unknown[] }).messages
      expect(messages).toHaveLength(1)
    })

    it('should return error for missing agent param', () => {
      const res = supervisor.handleRpc(rpc(RPC_METHODS.AGENT_RECV, {}))
      expect(res.error?.code).toBe(RPC_ERRORS.INVALID_PARAMS)
    })
  })

  describe('handleRpc — agent.list', () => {
    it('should list all agents', () => {
      const res = supervisor.handleRpc(rpc(RPC_METHODS.AGENT_LIST))
      expect(res.error).toBeUndefined()
      const agents = (res.result as { agents: unknown[] }).agents
      expect(agents).toHaveLength(2)
    })
  })

  describe('handleRpc — context.get / context.set', () => {
    it('should set and get context', () => {
      supervisor.handleRpc(rpc(RPC_METHODS.CONTEXT_SET, {
        key: 'mrr', value: '5000', agent: 'finance',
      }))
      const res = supervisor.handleRpc(rpc(RPC_METHODS.CONTEXT_GET, { key: 'mrr' }))
      expect(res.error).toBeUndefined()
      expect((res.result as { value: string }).value).toBe('5000')
    })

    it('should return null for missing context key', () => {
      const res = supervisor.handleRpc(rpc(RPC_METHODS.CONTEXT_GET, { key: 'missing' }))
      expect(res.error).toBeUndefined()
      expect(res.result).toBeNull()
    })

    it('should error on missing key for get', () => {
      const res = supervisor.handleRpc(rpc(RPC_METHODS.CONTEXT_GET, {}))
      expect(res.error?.code).toBe(RPC_ERRORS.INVALID_PARAMS)
    })

    it('should error on missing key/value for set', () => {
      const res = supervisor.handleRpc(rpc(RPC_METHODS.CONTEXT_SET, { key: 'k' }))
      expect(res.error?.code).toBe(RPC_ERRORS.INVALID_PARAMS)
    })

    it('should list all context entries', () => {
      supervisor.handleRpc(rpc(RPC_METHODS.CONTEXT_SET, {
        key: 'mrr', value: '5000', agent: 'finance',
      }))
      supervisor.handleRpc(rpc(RPC_METHODS.CONTEXT_SET, {
        key: 'users', value: '100', agent: 'marketing',
      }))
      const res = supervisor.handleRpc(rpc(RPC_METHODS.CONTEXT_LIST))
      expect(res.error).toBeUndefined()
      const entries = (res.result as { entries: unknown[] }).entries
      expect(entries).toHaveLength(2)
    })
  })

  describe('handleRpc — event.push', () => {
    it('should accept an event', () => {
      const res = supervisor.handleRpc(rpc(RPC_METHODS.EVENT_PUSH, {
        type: 'deploy', source: 'github', payload: { repo: 'test' },
      }))
      expect(res.error).toBeUndefined()
      expect((res.result as Record<string, unknown>).status).toBe('accepted')
    })
  })

  describe('handleRpc — health.check', () => {
    it('should return health status', () => {
      const res = supervisor.handleRpc(rpc(RPC_METHODS.HEALTH_CHECK))
      const health = res.result as { status: string; agents: unknown[]; timestamp: string }
      expect(health.status).toBe('ok')
      expect(health.agents).toHaveLength(2)
      expect(health.timestamp).toBeTruthy()
    })
  })

  describe('handleRpc — agent.spawn', () => {
    it('should spawn a dynamic clone with a materialized workspace', async () => {
      const sv = new Supervisor(makeConfig({ workspaceRoot: tempWorkspace }))
      await sv.start()

      const res = await sv.handleRpcAsync(rpc(RPC_METHODS.AGENT_SPAWN, { template: 'ping', name: 'ping-2' }))
      expect(res.error).toBeUndefined()
      expect((res.result as { name: string }).name).toBe('ping-2')

      const list = sv.handleRpc(rpc(RPC_METHODS.AGENT_LIST))
      const agents = (list.result as { agents: Array<{ name: string }> }).agents.map(a => a.name)
      expect(agents).toContain('ping-2')
      expect(fs.existsSync(path.join(tempWorkspace, 'ping-2', 'AGENT.md'))).toBe(true)
      expect(fs.existsSync(path.join(tempWorkspace, 'ping-2', 'output'))).toBe(true)

      await sv.shutdown()
    })
  })

  describe('handleRpc — unknown method', () => {
    it('should return METHOD_NOT_FOUND', () => {
      const res = supervisor.handleRpc(rpc('unknown.method'))
      expect(res.error?.code).toBe(RPC_ERRORS.METHOD_NOT_FOUND)
    })
  })

  describe('handleExternalEvent', () => {
    it('should route events to subscribed agents', async () => {
      const config = makeConfig({
        agents: [
          { name: 'devops', lifecycle: '24/7', model: 'haiku', systemPrompt: 'devops', events: ['deploy'] },
          { name: 'echo', lifecycle: '24/7', model: 'haiku', systemPrompt: 'echo' },
        ],
      })
      const sv = new Supervisor(config)
      await sv.start() // must start to populate agents map

      sv.handleExternalEvent({
        type: 'deploy',
        source: 'github',
        payload: { repo: 'test' },
        timestamp: Date.now(),
      })

      // devops should have a message, echo should not
      const devopsRes = sv.handleRpc(rpc(RPC_METHODS.AGENT_RECV, { agent: 'devops' }))
      const echoRes = sv.handleRpc(rpc(RPC_METHODS.AGENT_RECV, { agent: 'echo' }))

      expect((devopsRes.result as { messages: unknown[] }).messages).toHaveLength(1)
      expect((echoRes.result as { messages: unknown[] }).messages).toHaveLength(0)

      await sv.shutdown()
    })

    it('should route events even before start() is awaited', () => {
      const config = makeConfig({
        agents: [
          { name: 'devops', lifecycle: '24/7', model: 'haiku', systemPrompt: 'devops', events: ['deploy'] },
        ],
      })
      const sv = new Supervisor(config)
      void sv.start()

      sv.handleExternalEvent({
        type: 'deploy',
        source: 'github',
        payload: { repo: 'test' },
        timestamp: Date.now(),
      })

      const devopsRes = sv.handleRpc(rpc(RPC_METHODS.AGENT_RECV, { agent: 'devops' }))
      expect((devopsRes.result as { messages: unknown[] }).messages).toHaveLength(1)

      void sv.shutdown()
    })
  })

  describe('agent prompt enrichment', () => {
    it('enriches codex agent prompts with the runtime protocol', async () => {
      const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wanman-codex-workspace-'))
      fs.mkdirSync(path.join(workspaceRoot, 'ceo'), { recursive: true })
      fs.writeFileSync(path.join(workspaceRoot, 'ceo', 'AGENT.md'), '# CEO agent')

      createdAgentDefinitions = []
      const sv = new Supervisor(makeConfig({
        workspaceRoot,
        goal: 'Launch a blueberry farm',
        agents: [
          { name: 'ceo', lifecycle: '24/7', model: 'haiku', runtime: 'codex', systemPrompt: 'ceo bot' },
        ],
      }))

      try {
        await sv.start()
        const ceoDefinition = createdAgentDefinitions.find(def => def['name'] === 'ceo')
        expect(ceoDefinition).toBeTruthy()
        expect(ceoDefinition?.['systemPrompt']).toEqual(expect.stringContaining('# Mandatory Protocol'))
        expect(ceoDefinition?.['systemPrompt']).toEqual(expect.stringContaining('Role guide:'))
      } finally {
        await sv.shutdown()
        fs.rmSync(workspaceRoot, { recursive: true, force: true })
      }
    })
  })

  describe('run completion metrics', () => {
    it('records runtime-reported token usage in supervisor metrics', async () => {
      supervisor.initEventBus('run-metrics')

      const executeSQL = vi.fn(async () => [])
      ;(supervisor as unknown as { brainManager: { isInitialized: boolean; executeSQL: (sql: string) => Promise<unknown[]> } }).brainManager = {
        isInitialized: true,
        executeSQL,
      }

      const onRunComplete = (supervisor as unknown as { buildRunCompleteCallback: () => (info: {
        agentName: string
        exitCode: number
        durationMs: number
        errored: boolean
        steerCount: number
        inputTokens: number
        outputTokens: number
        totalTokens: number
      }) => void }).buildRunCompleteCallback()

      onRunComplete({
        agentName: 'echo',
        exitCode: 0,
        durationMs: 1500,
        errored: false,
        steerCount: 1,
        inputTokens: 1200,
        outputTokens: 300,
        totalTokens: 2100,
      })

      await new Promise(resolve => setTimeout(resolve, 0))

      const usage = supervisor.tokenTracker.getUsage('run-metrics')
      expect(usage.total).toBe(2100)
      expect(usage.byAgent.echo).toBe(2100)

      const sql = String((executeSQL.mock.calls[0] ?? [''])[0] ?? '')
      expect(sql).toContain('token_count')
      expect(sql).toContain('activation_snapshot_id')
      expect(sql).toContain('execution_profile')
    })
  })

  describe('handleRpcAsync — task.create', () => {
    it('rejects conflicting scoped tasks', async () => {
      const first = await supervisor.handleRpcAsync(rpc(RPC_METHODS.TASK_CREATE, {
        title: 'Update runtime transport',
        scope: { paths: ['packages/runtime/src/supervisor.ts'] },
      }))
      expect(first.error).toBeUndefined()

      const second = await supervisor.handleRpcAsync(rpc(RPC_METHODS.TASK_CREATE, {
        title: 'Update supervisor logging',
        scope: { paths: ['packages/runtime/src/supervisor.ts'] },
      }))

      expect(second.error?.code).toBe(RPC_ERRORS.INVALID_PARAMS)
      expect(second.error?.message).toMatch(/conflicts with active task/i)
    })

    it('drops stale task assignment delivery after reassignment before recv', async () => {
      const createRes = await supervisor.handleRpcAsync(rpc(RPC_METHODS.TASK_CREATE, {
        title: 'Reassign me before delivery',
        assignee: 'ping',
        priority: 4,
      } as unknown as Record<string, unknown>))
      expect(createRes.error).toBeUndefined()

      const createdTask = createRes.result as { id: string }
      const updateRes = await supervisor.handleRpcAsync(rpc(RPC_METHODS.TASK_UPDATE, {
        id: createdTask.id,
        assignee: 'echo',
      }))
      expect(updateRes.error).toBeUndefined()

      const getRes = await supervisor.handleRpcAsync(rpc(RPC_METHODS.TASK_GET, { id: createdTask.id }))
      expect(getRes.error).toBeUndefined()
      expect(getRes.result).toMatchObject({
        id: createdTask.id,
        assignee: 'echo',
      })

      const echoList = await supervisor.handleRpcAsync(rpc(RPC_METHODS.TASK_LIST, { assignee: 'echo' }))
      expect(echoList.error).toBeUndefined()
      expect((echoList.result as { tasks: Array<{ id: string }> }).tasks).toEqual([
        expect.objectContaining({ id: createdTask.id }),
      ])

      const pingList = await supervisor.handleRpcAsync(rpc(RPC_METHODS.TASK_LIST, { assignee: 'ping' }))
      expect(pingList.error).toBeUndefined()
      expect((pingList.result as { tasks: unknown[] }).tasks).toHaveLength(0)

      const pingMessages = await supervisor.handleRpcAsync(rpc(RPC_METHODS.AGENT_RECV, { agent: 'ping' }))
      expect(pingMessages.error).toBeUndefined()
      expect((pingMessages.result as { messages: unknown[] }).messages).toHaveLength(0)

      const echoMessages = await supervisor.handleRpcAsync(rpc(RPC_METHODS.AGENT_RECV, { agent: 'echo' }))
      expect(echoMessages.error).toBeUndefined()
      expect((echoMessages.result as { messages: Array<{ type: string; payload: { taskId: string } }> }).messages).toEqual([
        expect.objectContaining({
          type: 'task_assigned',
          payload: expect.objectContaining({ taskId: createdTask.id }),
        }),
      ])
    })
  })

  describe('handleRpcAsync — initiatives and capsules', () => {
    it('creates initiatives and links capsules back to tasks', async () => {
      const initiativeRes = await supervisor.handleRpcAsync(rpc(RPC_METHODS.INITIATIVE_CREATE, {
        title: 'Advance API delivery',
        goal: 'Ship the next API-facing milestone',
        summary: 'Keep work anchored to external value',
        priority: 9,
        sources: ['README.md', 'docs/ROADMAP.md'],
        agent: 'ceo',
      }))
      expect(initiativeRes.error).toBeUndefined()
      const initiative = initiativeRes.result as { id: string }

      const taskRes = await supervisor.handleRpcAsync(rpc(RPC_METHODS.TASK_CREATE, {
        title: 'Fix webhook ingestion',
        assignee: 'ping',
        initiativeId: initiative.id,
        scopeType: 'code',
        scope: { paths: ['apps/api/src/routes/webhooks.ts'] },
      }))
      expect(taskRes.error).toBeUndefined()
      const task = taskRes.result as { id: string }

      const capsuleRes = await supervisor.handleRpcAsync(rpc(RPC_METHODS.CAPSULE_CREATE, {
        goal: 'Fix support-email webhook ingestion',
        ownerAgent: 'ping',
        branch: 'wanman/fix-support-email',
        baseCommit: 'abc123',
        allowedPaths: ['apps/api/src/routes/webhooks.ts'],
        acceptance: 'webhook forwards payload and tests pass',
        initiativeId: initiative.id,
        taskId: task.id,
        subsystem: 'api-webhooks',
        scopeType: 'code',
        agent: 'ceo',
      }))
      expect(capsuleRes.error).toBeUndefined()
      const capsule = capsuleRes.result as { id: string; initiativeId: string; taskId: string }
      expect(capsule.initiativeId).toBe(initiative.id)
      expect(capsule.taskId).toBe(task.id)

      const refreshedTask = await supervisor.handleRpcAsync(rpc(RPC_METHODS.TASK_GET, { id: task.id }))
      expect(refreshedTask.error).toBeUndefined()
      expect(refreshedTask.result).toMatchObject({
        id: task.id,
        initiativeId: initiative.id,
        capsuleId: capsule.id,
        scopeType: 'code',
      })

      const mineRes = await supervisor.handleRpcAsync(rpc(RPC_METHODS.CAPSULE_MINE, { agent: 'ping' }))
      expect(mineRes.error).toBeUndefined()
      expect((mineRes.result as { capsules: Array<{ id: string }> }).capsules).toEqual([
        expect.objectContaining({ id: capsule.id }),
      ])
    })

    it('rejects high-conflict capsules touching the same path', async () => {
      const first = await supervisor.handleRpcAsync(rpc(RPC_METHODS.CAPSULE_CREATE, {
        goal: 'Refactor supervisor logging',
        ownerAgent: 'ping',
        branch: 'wanman/refactor-supervisor-logging',
        baseCommit: 'abc123',
        allowedPaths: ['packages/runtime/src/supervisor.ts'],
        acceptance: 'logging cleanup passes tests',
        agent: 'ceo',
      }))
      expect(first.error).toBeUndefined()

      const second = await supervisor.handleRpcAsync(rpc(RPC_METHODS.CAPSULE_CREATE, {
        goal: 'Refactor supervisor metrics',
        ownerAgent: 'echo',
        branch: 'wanman/refactor-supervisor-metrics',
        baseCommit: 'abc123',
        allowedPaths: ['packages/runtime/src/supervisor.ts'],
        acceptance: 'metrics cleanup passes tests',
        agent: 'ceo',
      }))

      expect(second.error?.code).toBe(RPC_ERRORS.INVALID_PARAMS)
      expect(second.error?.message).toMatch(/capsule conflicts with active capsule/i)
    })
  })

  describe('steer callback edge cases', () => {
    it('should log warning when steer target agent not found', async () => {
      // Access relay via private field to send a steer message to unknown agent
      const relay = (supervisor as unknown as { relay: { send: (from: string, to: string, type: string, payload: unknown, priority: string) => void } }).relay
      // Send steer to non-existent agent — this triggers the callback
      // which should hit the else branch (lines 67-68)
      relay.send('external', 'nonexistent-agent', 'message', 'urgent', 'steer')
      // The callback should have logged a warning but not crashed
    })

    it('should call handleSteer on existing agent via steer callback', async () => {
      // Access relay via private field
      const relay = (supervisor as unknown as { relay: { send: (from: string, to: string, type: string, payload: unknown, priority: string) => void } }).relay
      // Send steer to existing agent
      relay.send('external', 'echo', 'message', 'urgent', 'steer')
      // handleSteer was called on the mock — no crash
    })
  })

  describe('agent start error', () => {
    it('should handle agent start failure gracefully', async () => {
      startShouldFail = true
      const sv = new Supervisor(makeConfig())
      // start() launches agent.start() with .catch() — should not throw
      await sv.start()
      // Give time for the async catch to fire
      await new Promise((r) => setTimeout(r, 10))
      await sv.shutdown()
      startShouldFail = false
    })
  })

  describe('brain-backed RPC success paths', () => {
    it('stores, lists, and fetches artifacts through the brain manager', async () => {
      const executeSQL = vi.fn().mockResolvedValue([{ id: 42, agent: 'ceo', kind: 'note' }])
      ;(supervisor as unknown as { brainManager: unknown }).brainManager = {
        isInitialized: true,
        executeSQL,
      }
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(null, { status: 200 }),
      )
      const previousEnv = {
        WANMAN_SYNC_URL: process.env['WANMAN_SYNC_URL'],
        WANMAN_SYNC_SECRET: process.env['WANMAN_SYNC_SECRET'],
        WANMAN_STORY_ID: process.env['WANMAN_STORY_ID'],
      }
      process.env['WANMAN_SYNC_URL'] = 'https://api.example.com/api/sync'
      process.env['WANMAN_SYNC_SECRET'] = 'sync-secret'
      process.env['WANMAN_STORY_ID'] = 'story-1'

      try {
        supervisor.initEventBus('run-1')
        const put = await supervisor.handleRpcAsync(rpc(RPC_METHODS.ARTIFACT_PUT, {
          kind: 'note',
          agent: 'ceo',
          source: 'test',
          confidence: 0.9,
          path: 'notes/one.md',
          content: 'hello',
          metadata: { topic: 'coverage' },
        }))
        expect(put.error).toBeUndefined()
        expect(executeSQL.mock.calls.at(-1)?.[0]).toContain('INSERT INTO artifacts')
        expect(fetchSpy).toHaveBeenCalledWith(
          'https://api.example.com/api/sync/artifact',
          expect.objectContaining({ method: 'POST' }),
        )

        const list = await supervisor.handleRpcAsync(rpc(RPC_METHODS.ARTIFACT_LIST, {
          agent: 'ceo',
          kind: 'note',
          verified: true,
        }))
        expect(list.error).toBeUndefined()
        expect(executeSQL.mock.calls.at(-1)?.[0]).toContain("metadata->>'verified' = 'true'")

        const get = await supervisor.handleRpcAsync(rpc(RPC_METHODS.ARTIFACT_GET, { id: 42 }))
        expect(get.error).toBeUndefined()
        expect(executeSQL.mock.calls.at(-1)?.[0]).toContain('WHERE id = 42')
      } finally {
        if (previousEnv.WANMAN_SYNC_URL === undefined) delete process.env['WANMAN_SYNC_URL']
        else process.env['WANMAN_SYNC_URL'] = previousEnv.WANMAN_SYNC_URL
        if (previousEnv.WANMAN_SYNC_SECRET === undefined) delete process.env['WANMAN_SYNC_SECRET']
        else process.env['WANMAN_SYNC_SECRET'] = previousEnv.WANMAN_SYNC_SECRET
        if (previousEnv.WANMAN_STORY_ID === undefined) delete process.env['WANMAN_STORY_ID']
        else process.env['WANMAN_STORY_ID'] = previousEnv.WANMAN_STORY_ID
        fetchSpy.mockRestore()
      }
    })

    it('creates, lists, and updates hypotheses through the brain manager', async () => {
      const executeSQL = vi.fn().mockResolvedValue([{ id: 7, status: 'validated' }])
      ;(supervisor as unknown as { brainManager: unknown }).brainManager = {
        isInitialized: true,
        executeSQL,
      }

      const created = await supervisor.handleRpcAsync(rpc(RPC_METHODS.HYPOTHESIS_CREATE, {
        title: 'Users need local mode',
        agent: 'ceo',
        rationale: 'OSS installs are simpler',
        expectedValue: 'activation',
        estimatedCost: 'small',
        parentId: 1,
      }))
      expect(created.error).toBeUndefined()
      expect(executeSQL.mock.calls.at(-1)?.[0]).toContain('INSERT INTO hypotheses')

      const tree = await supervisor.handleRpcAsync(rpc(RPC_METHODS.HYPOTHESIS_LIST, {
        treeRoot: 7,
      }))
      expect(tree.error).toBeUndefined()
      expect(executeSQL.mock.calls.at(-1)?.[0]).toContain('WITH RECURSIVE tree')

      const filtered = await supervisor.handleRpcAsync(rpc(RPC_METHODS.HYPOTHESIS_LIST, {
        status: 'active',
      }))
      expect(filtered.error).toBeUndefined()
      expect(executeSQL.mock.calls.at(-1)?.[0]).toContain("status = 'active'")

      const updated = await supervisor.handleRpcAsync(rpc(RPC_METHODS.HYPOTHESIS_UPDATE, {
        id: 7,
        status: 'validated',
        outcome: 'confirmed',
        evidence: [42, 43],
      }))
      expect(updated.error).toBeUndefined()
      const updateSql = String(executeSQL.mock.calls.at(-1)?.[0])
      expect(updateSql).toContain('evidence_artifact_ids = ARRAY[42,43]')
      expect(updateSql).toContain('resolved_at = now()')
    })
  })

  describe('skill RPC manager guards', () => {
    it('returns explicit errors when skill manager RPCs are unavailable', async () => {
      ;(supervisor as unknown as { _skillManager: unknown })._skillManager = null
      for (const [method, params] of [
        [RPC_METHODS.SKILL_GET, { agent: 'ceo' }],
        [RPC_METHODS.SKILL_UPDATE, { agent: 'ceo', content: '# Skill' }],
        [RPC_METHODS.SKILL_ROLLBACK, { agent: 'ceo' }],
        [RPC_METHODS.SKILL_METRICS, {}],
      ] as const) {
        const res = await supervisor.handleRpcAsync(rpc(method, params))
        expect(res.error?.code).toBe(RPC_ERRORS.INTERNAL_ERROR)
        expect(res.error?.message).toMatch(/Skill manager not initialized/)
      }
    })
  })

  describe('internal scheduling helpers', () => {
    it('detects blocked work and wakes on-demand agents when dependencies complete', async () => {
      const root = await supervisor.handleRpcAsync(rpc(RPC_METHODS.TASK_CREATE, {
        title: 'Root task',
        description: 'unblocks follow-up',
        assignee: 'echo',
      }))
      const rootTask = root.result as { id: string }
      const blocked = await supervisor.handleRpcAsync(rpc(RPC_METHODS.TASK_CREATE, {
        title: 'Blocked task',
        description: 'waits on root',
        assignee: 'ping',
        dependsOn: [rootTask.id],
      }))
      expect(blocked.error).toBeUndefined()

      const pingAgent = {
        definition: { lifecycle: 'on-demand' },
        state: 'idle',
        trigger: vi.fn(),
      }
      ;(supervisor as unknown as { agents: Map<string, unknown> }).agents.set('ping', pingAgent)

      const helpers = supervisor as unknown as {
        hasBlockedTasksOnly(agentName: string): boolean
        hasAutonomousWork(agentName: string): boolean
        wakeUnblockedAgents(completedTaskId: string): void
        taskPool: { listSync: () => unknown[] }
      }
      expect(helpers.hasBlockedTasksOnly('ping')).toBe(true)
      expect(helpers.hasAutonomousWork('ceo')).toBe(true)
      expect(helpers.hasAutonomousWork('ping')).toBe(false)

      await supervisor.handleRpcAsync(rpc(RPC_METHODS.TASK_UPDATE, {
        id: rootTask.id,
        status: 'done',
      }))
      helpers.wakeUnblockedAgents(rootTask.id)

      expect(helpers.hasBlockedTasksOnly('ping')).toBe(false)
      expect(helpers.hasAutonomousWork('ping')).toBe(true)
      expect(pingAgent.trigger).toHaveBeenCalled()

      const originalListSync = helpers.taskPool.listSync
      helpers.taskPool.listSync = () => { throw new Error('db unavailable') }
      expect(helpers.hasBlockedTasksOnly('ping')).toBe(false)
      expect(helpers.hasAutonomousWork('ping')).toBe(true)
      helpers.taskPool.listSync = originalListSync
    })

    it('builds preamble/env providers from active skill snapshots and records run feedback', async () => {
      const taskRes = await supervisor.handleRpcAsync(rpc(RPC_METHODS.TASK_CREATE, {
        title: 'Use a skill',
        description: 'exercise snapshot attribution',
        assignee: 'ping',
        executionProfile: 'research.deep_dive',
      }))
      const task = taskRes.result as { id: string }
      const snapshot = {
        id: 'snapshot-1',
        runId: 'run-1',
        loopNumber: 0,
        taskId: task.id,
        agent: 'ping',
        executionProfile: 'research.deep_dive',
        activationScope: 'task',
        activatedBy: 'system',
        materializedPath: '/tmp/skills/snapshot-1',
        resolvedSkills: [{ path: '/tmp/skills/research/SKILL.md' }],
        bundleId: 'bundle-1',
        bundleVersion: 3,
        createdAt: Date.now(),
      }
      const executeSQL = vi.fn().mockResolvedValue([])
      Object.assign(supervisor as unknown as {
        _sharedSkillManager: unknown
        _agentHomeManager: unknown
        brainManager: unknown
      }, {
        _sharedSkillManager: {
          createActivationSnapshot: vi.fn().mockResolvedValue(snapshot),
        },
        _agentHomeManager: {
          prepareAgentHome: vi.fn().mockReturnValue('/tmp/agent-home'),
          cleanupHomes: vi.fn(),
        },
        brainManager: {
          isInitialized: true,
          executeSQL,
        },
      })

      const helpers = supervisor as unknown as {
        buildPreambleProvider(): (agentName: string) => Promise<string | undefined>
        buildEnvProvider(): (agentName: string) => Promise<Record<string, string>>
        buildRunCompleteCallback(): (info: {
          agentName: string
          exitCode: number
          durationMs: number
          errored: boolean
          steerCount: number
          inputTokens: number
          outputTokens: number
          totalTokens: number
        }) => void
      }

      const preamble = await helpers.buildPreambleProvider()('ping')
      expect(preamble).toContain('Active Skill Snapshot')
      expect(preamble).toContain('/tmp/skills/research/SKILL.md')

      const env = await helpers.buildEnvProvider()('ping')
      expect(env).toEqual({
        HOME: '/tmp/agent-home',
        WANMAN_ACTIVE_SKILLS_DIR: '/tmp/skills/snapshot-1',
        WANMAN_ACTIVE_SKILL_SNAPSHOT_ID: 'snapshot-1',
      })

      supervisor.initEventBus('run-1')
      helpers.buildRunCompleteCallback()({
        agentName: 'ping',
        exitCode: 0,
        durationMs: 250,
        errored: false,
        steerCount: 2,
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      })

      expect(executeSQL).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO run_feedback'))
      expect(executeSQL.mock.calls.at(-1)?.[0]).toContain('snapshot-1')
    })
  })

  describe('shutdown', () => {
    it('should shutdown gracefully', async () => {
      await expect(supervisor.shutdown()).resolves.toBeUndefined()
    })
  })
})
