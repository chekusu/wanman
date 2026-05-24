/**
 * E2E test: Full Supervisor lifecycle.
 *
 * start → initEventBus → attach LoopLogger + Heartbeat →
 * RPC (task create/update, artifact put) → verify NDJSON + heartbeat →
 * shutdown → verify cleanup.
 *
 * This is the most comprehensive integration test — it verifies the entire
 * observability pipeline works end-to-end through a real Supervisor.
 *
 * Run: pnpm -F @wanman/runtime test e2e-supervisor-lifecycle
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentMatrixConfig, JsonRpcRequest } from '@wanman/core'
import { RPC_METHODS } from '@wanman/core'
import type { LoopEvent } from '../loop-events.js'

// ── Minimal mocks ──

const { mockExecSync } = vi.hoisted(() => ({
  mockExecSync: vi.fn<(...args: unknown[]) => string | Buffer>(),
}))
vi.mock('node:child_process', () => ({ execSync: mockExecSync }))
vi.mock('../http-server.js', () => ({
  createHttpServer: vi.fn(() => ({ close: (cb: () => void) => cb() })),
}))
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}))
vi.mock('../agent-process.js', () => {
  class MockAgentProcess {
    definition: unknown
    state = 'idle'
    constructor(def: unknown) { this.definition = def }
    async start() {}
    stop() {}
    handleSteer() {}
  }
  return { AgentProcess: MockAgentProcess }
})

// Brain mock
let artifactId = 0
vi.mock('../brain-manager.js', () => {
  class MockBrainManager {
    isInitialized = true
    env = { DATABASE_URL: 'mock://', DB9_DATABASE_ID: 'm', DB9_DATABASE_NAME: 'm', PGHOST: 'm', PGPORT: '5432', PGUSER: 'm', PGPASSWORD: 'm', PGDATABASE: 'm' }
    brainSkill = { name: 'brain', content: 'stub' }
    dbId = 'mock'
    async initialize() {}
    async executeSQL(sql: string) {
      if (sql.includes('CREATE TABLE') || sql.includes('CREATE INDEX')) return []
      if (sql.includes('INSERT INTO artifacts')) {
        return [{ id: ++artifactId, agent: 'dev', kind: 'tech_spec', created_at: new Date().toISOString() }]
      }
      if (sql.includes('INSERT INTO loop_events')) return []
      if (sql.includes('INSERT INTO runs')) return []
      if (sql.includes('UPDATE runs')) return []
      return []
    }
  }
  return { BrainManager: MockBrainManager }
})

import { Supervisor } from '../supervisor.js'
import { LoopLogger } from '../loop-logger.js'
import { Heartbeat } from '../heartbeat.js'

const tmpDir = join(tmpdir(), `e2e-lifecycle-${process.pid}-${Date.now()}`)
const ndjsonPath = join(tmpDir, 'loop-events.ndjson')
const heartbeatPath = join(tmpDir, '.wanman', 'heartbeat.json')

const config: AgentMatrixConfig = {
  dbPath: join(tmpDir, 'wanman.db'),
  agents: [
    { name: 'ceo', lifecycle: '24/7' as const, model: 'claude-sonnet-4-6', systemPrompt: '' },
    { name: 'dev', lifecycle: 'on-demand' as const, model: 'claude-sonnet-4-6', systemPrompt: '' },
    { name: 'finance', lifecycle: '24/7' as const, model: 'claude-sonnet-4-6', systemPrompt: '' },
  ],
  brain: { token: 'mock', dbName: 'mock' },
}

function rpc(method: string, params: Record<string, unknown> = {}): JsonRpcRequest {
  return { jsonrpc: '2.0', id: `lc-${Date.now()}-${Math.random()}`, method, params }
}

describe('Supervisor full lifecycle E2E', () => {
  let supervisor: Supervisor
  let logger: LoopLogger
  let heartbeat: Heartbeat

  beforeAll(async () => {
    mkdirSync(tmpDir, { recursive: true })

    supervisor = new Supervisor(config, { headless: true })

    // Wire observability pipeline
    const bus = supervisor.initEventBus('run-lifecycle-e2e')

    logger = new LoopLogger({ ndjsonPath, bufferCapacity: 500 })
    logger.attach(bus)
    await logger.createRun('run-lifecycle-e2e', 'Full lifecycle test')

    heartbeat = new Heartbeat(heartbeatPath, 'run-lifecycle-e2e')

    await supervisor.start()
  }, 15_000)

  afterAll(async () => {
    heartbeat.stop()
    logger.detach(supervisor.eventBus!)

    await logger.finalizeRun('run-lifecycle-e2e', {
      totalLoops: supervisor.eventBus!.currentLoop,
      productiveLoops: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      exitReason: 'test_complete',
    })

    await supervisor.shutdown()
    try { rmSync(tmpDir, { recursive: true }) } catch { /* ignore */ }
  })

  it('Loop 1: idle — no activity', () => {
    const bus = supervisor.eventBus!
    bus.tick()
    heartbeat.tick()
    const result = bus.classify([
      { name: 'ceo', state: 'idle', lifecycle: '24/7' },
      { name: 'dev', state: 'idle', lifecycle: 'on-demand' },
    ])
    expect(result.classification).toBe('idle')
  })

  it('Loop 2: productive — create and assign task via RPC', async () => {
    const bus = supervisor.eventBus!
    bus.tick()
    heartbeat.tick()

    const createRes = await supervisor.handleRpcAsync(rpc(RPC_METHODS.TASK_CREATE, {
      title: 'Implement login page',
      assignee: 'dev',
      priority: 8,
    } as unknown as Record<string, unknown>))
    expect(createRes.error).toBeUndefined()
    const task = createRes.result as { id: string }

    await supervisor.handleRpcAsync(rpc(RPC_METHODS.TASK_UPDATE, {
      id: task.id, status: 'in_progress',
    }))

    const result = bus.classify([
      { name: 'ceo', state: 'idle', lifecycle: '24/7' },
      { name: 'dev', state: 'running', lifecycle: 'on-demand' },
    ])
    expect(result.classification).toBe('productive')
  })

  it('Loop 3: productive — artifact created', async () => {
    const bus = supervisor.eventBus!
    bus.tick()
    heartbeat.tick()

    const res = await supervisor.handleRpcAsync(rpc(RPC_METHODS.ARTIFACT_PUT, {
      kind: 'tech_spec', agent: 'dev', source: 'lifecycle-e2e',
      confidence: 0.85, content: 'Login page spec', metadata: {},
    }))
    expect(res.error).toBeUndefined()

    const result = bus.classify([
      { name: 'ceo', state: 'idle', lifecycle: '24/7' },
      { name: 'dev', state: 'running', lifecycle: 'on-demand' },
    ])
    expect(result.classification).toBe('productive')
  })

  it('Loop 4: idle — no new activity', () => {
    const bus = supervisor.eventBus!
    bus.tick()
    heartbeat.tick()

    const result = bus.classify([
      { name: 'ceo', state: 'idle', lifecycle: '24/7' },
      { name: 'dev', state: 'idle', lifecycle: 'on-demand' },
    ])
    expect(result.classification).toBe('idle')
  })

  it('Loop 5: productive — task completed', async () => {
    const bus = supervisor.eventBus!
    bus.tick()
    heartbeat.tick()

    // Get the task and mark as done
    const listRes = await supervisor.handleRpcAsync(rpc(RPC_METHODS.TASK_LIST, {}))
    const tasks = (listRes.result as { tasks: Array<{ id: string; status: string }> }).tasks
    const activeTask = tasks.find(t => t.status === 'in_progress')!

    await supervisor.handleRpcAsync(rpc(RPC_METHODS.TASK_UPDATE, {
      id: activeTask.id, status: 'done', result: 'Login page implemented',
    }))

    const result = bus.classify([
      { name: 'ceo', state: 'idle', lifecycle: '24/7' },
      { name: 'dev', state: 'idle', lifecycle: 'on-demand' },
    ])
    expect(result.classification).toBe('productive')
  })

  // ── Verification tests (run after all loops) ──

  it('NDJSON file should contain all events from all loops', () => {
    expect(existsSync(ndjsonPath)).toBe(true)
    const lines = readFileSync(ndjsonPath, 'utf-8').trim().split('\n')
    const events = lines.map(l => JSON.parse(l) as LoopEvent)

    // 5 ticks + 5 classifications + task transitions + artifact
    expect(events.length).toBeGreaterThan(10)

    const ticks = events.filter(e => e.type === 'loop.tick')
    expect(ticks).toHaveLength(5)

    const classified = events.filter(e => e.type === 'loop.classified')
    expect(classified).toHaveLength(5)

    const transitions = events.filter(e => e.type === 'task.transition')
    expect(transitions.length).toBeGreaterThanOrEqual(2) // assigned→in_progress, in_progress→done

    const artifacts = events.filter(e => e.type === 'artifact.created')
    expect(artifacts).toHaveLength(1)
  })

  it('NDJSON events should have consistent runId', () => {
    const lines = readFileSync(ndjsonPath, 'utf-8').trim().split('\n')
    const events = lines.map(l => JSON.parse(l) as LoopEvent)

    for (const e of events) {
      expect(e.runId).toBe('run-lifecycle-e2e')
    }
  })

  it('classifications should be: idle, productive, productive, idle, productive', () => {
    const lines = readFileSync(ndjsonPath, 'utf-8').trim().split('\n')
    const classifications = lines
      .map(l => JSON.parse(l) as LoopEvent)
      .filter(e => e.type === 'loop.classified')
      .map(e => (e as { classification: string }).classification)

    expect(classifications).toEqual([
      'idle', 'productive', 'productive', 'idle', 'productive',
    ])
  })

  it('heartbeat should reflect 5 loops', () => {
    expect(existsSync(heartbeatPath)).toBe(true)
    const data = JSON.parse(readFileSync(heartbeatPath, 'utf-8'))
    expect(data.loopCount).toBe(5)
    expect(data.runId).toBe('run-lifecycle-e2e')
    expect(data.pid).toBe(process.pid)
  })

  it('ring buffer should contain recent events', () => {
    const recent = logger.recentEvents()
    expect(recent.length).toBeGreaterThan(10)
    // Last event should be one of the loop 5 events
    const last = recent[recent.length - 1]!
    expect(last.runId).toBe('run-lifecycle-e2e')
  })

  it('productive rate should be 60%', () => {
    const lines = readFileSync(ndjsonPath, 'utf-8').trim().split('\n')
    const classifications = lines
      .map(l => JSON.parse(l) as LoopEvent)
      .filter(e => e.type === 'loop.classified')
      .map(e => (e as { classification: string }).classification)

    const productive = classifications.filter(c => c === 'productive').length
    const rate = Math.round((productive / classifications.length) * 100)
    expect(rate).toBe(60) // 3 productive out of 5
  })
})
