import * as fs from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Heartbeat, LoopEventBus, LoopLogger } from './loop-observability.js'

const tmpDirs: string[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'wanman-loop-'))
  tmpDirs.push(dir)
  return dir
}

const agents = [
  { name: 'ceo', state: 'running', lifecycle: '24/7' },
  { name: 'dev', state: 'idle', lifecycle: 'on-demand' },
]

describe('LoopEventBus', () => {
  it('treats running agents alone as idle', () => {
    const bus = new LoopEventBus('run-cli-test')
    bus.tick()

    const result = bus.classify(agents)
    expect(result.classification).toBe('idle')
    expect(result.reasons).toContain('no state changes detected')
  })

  it('classifies task transitions as productive', () => {
    const bus = new LoopEventBus('run-cli-test')
    bus.tick()
    bus.emit({
      type: 'task.transition',
      runId: 'run-cli-test',
      loop: 1,
      taskId: 1,
      from: 'assigned',
      to: 'done',
      timestamp: new Date().toISOString(),
    })

    const result = bus.classify(agents)
    expect(result.classification).toBe('productive')
    expect(result.reasons[0]).toContain('task transition')
  })

  it('classifies blocked tasks without relying on agent churn', () => {
    const bus = new LoopEventBus('run-cli-test')
    bus.tick()
    bus.emit({
      type: 'task.blocked',
      runId: 'run-cli-test',
      loop: 1,
      taskId: 9,
      waitingOn: [4],
      timestamp: new Date().toISOString(),
    })

    const result = bus.classify(agents)
    expect(result.classification).toBe('blocked')
    expect(result.reasons[0]).toContain('blocked by dependencies')
  })

  it('classifies artifacts, backlogs, and errors through event counters', () => {
    const bus = new LoopEventBus('run-cli-test')
    bus.tick()
    bus.emit({
      type: 'artifact.created',
      runId: 'run-cli-test',
      loop: 1,
      agent: 'dev',
      kind: 'tech_spec',
      timestamp: new Date().toISOString(),
    })
    expect(bus.classify(agents).classification).toBe('productive')

    bus.tick()
    bus.emit({
      type: 'queue.backlog',
      runId: 'run-cli-test',
      loop: 2,
      agent: 'dev',
      pendingMessages: 2,
      timestamp: new Date().toISOString(),
    })
    expect(bus.classify(agents).classification).toBe('backlog_stuck')

    bus.tick()
    bus.recordError()
    expect(bus.classify(agents).classification).toBe('error')
  })
})

describe('LoopLogger', () => {
  it('writes loop events, keeps a bounded recent buffer, and detaches cleanly', () => {
    const dir = makeTmpDir()
    const bus = new LoopEventBus('run-logger')
    const logger = new LoopLogger({
      ndjsonPath: path.join(dir, 'events.ndjson'),
      bufferCapacity: 2,
    })
    logger.attach(bus)

    bus.tick()
    bus.emit({
      type: 'task.transition',
      runId: 'run-logger',
      loop: 1,
      taskId: 1,
      from: 'todo',
      to: 'done',
      timestamp: new Date().toISOString(),
    })
    logger.updateTaskSnapshot(2, 1)
    bus.classify(agents)

    expect(logger.recentEvents()).toHaveLength(2)
    expect(fs.readFileSync(path.join(dir, 'events.ndjson'), 'utf-8')).toContain('loop.classified')
    expect(fs.readFileSync(path.join(dir, 'results.tsv'), 'utf-8')).toContain('50%')

    logger.detach(bus)
    logger.detach(bus)
    bus.tick()
    expect(logger.recentEvents()).toHaveLength(2)
  })
})

describe('Heartbeat', () => {
  it('writes heartbeat data on start and tick, then stops idempotently', () => {
    vi.useFakeTimers()
    const dir = makeTmpDir()
    const heartbeatPath = path.join(dir, '.wanman', 'heartbeat.json')
    const heartbeat = new Heartbeat(heartbeatPath, 'run-heartbeat')

    heartbeat.start(1000)
    expect(JSON.parse(fs.readFileSync(heartbeatPath, 'utf-8')).loopCount).toBe(0)

    heartbeat.tick()
    expect(heartbeat.loopCount).toBe(1)
    expect(JSON.parse(fs.readFileSync(heartbeatPath, 'utf-8')).loopCount).toBe(1)

    vi.advanceTimersByTime(1000)
    expect(JSON.parse(fs.readFileSync(heartbeatPath, 'utf-8')).runId).toBe('run-heartbeat')

    heartbeat.stop()
    heartbeat.stop()
  })
})
