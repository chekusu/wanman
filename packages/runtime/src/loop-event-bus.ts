/**
 * LoopEventBus — central event bus for loop-level observability.
 *
 * Supervisor owns the bus. AgentProcess and RPC handlers emit events.
 * Consumers (LoopLogger, CLI dashboard) subscribe via on().
 *
 * Design: docs/research/2026-03-17-empty-loop-observability-review.md §5
 */

import { EventEmitter } from 'node:events'
import type {
  LoopEvent,
  LoopClassification,
  LoopClassified,
  LoopSnapshot,
} from './loop-events.js'
import { createLogger } from './logger.js'

const log = createLogger('loop-event-bus')

export class LoopEventBus {
  private emitter = new EventEmitter()
  private _runId: string
  private _currentLoop = 0

  /** Counters reset each loop tick — used for classification */
  private taskTransitions = 0
  private artifactsCreated = 0
  private agentSpawns = 0
  private errors = 0
  private pendingMessages: Record<string, number> = {}
  private blockedTasks = 0

  constructor(runId: string) {
    this._runId = runId
    this.emitter.setMaxListeners(20)
  }

  get runId(): string { return this._runId }
  get currentLoop(): number { return this._currentLoop }

  /** Subscribe to all loop events */
  on(listener: (event: LoopEvent) => void): void {
    this.emitter.on('event', listener)
  }

  /** Unsubscribe */
  off(listener: (event: LoopEvent) => void): void {
    this.emitter.off('event', listener)
  }

  /** Emit a loop event to all subscribers */
  emit(event: LoopEvent): void {
    // Track counters for classification
    switch (event.type) {
      case 'task.transition': this.taskTransitions++; break
      case 'artifact.created': this.artifactsCreated++; break
      case 'agent.spawned': this.agentSpawns++; break
      case 'task.blocked': this.blockedTasks++; break
      case 'queue.backlog':
        this.pendingMessages[event.agent] = event.pendingMessages
        break
    }

    try {
      this.emitter.emit('event', event)
    } catch (err) {
      // Non-fatal: observability never blocks main logic (gstack principle)
      log.warn('event listener error', { type: event.type, error: String(err) })
    }
  }

  /**
   * Signal the start of a new loop tick.
   * Resets per-loop counters and emits loop.tick.
   */
  tick(): void {
    this._currentLoop++
    this.taskTransitions = 0
    this.artifactsCreated = 0
    this.agentSpawns = 0
    this.errors = 0
    this.pendingMessages = {}
    this.blockedTasks = 0

    this.emit({
      type: 'loop.tick',
      runId: this._runId,
      loop: this._currentLoop,
      timestamp: new Date().toISOString(),
    })
  }

  /**
   * Classify the current loop and emit loop.classified.
   * Call this at the end of each loop tick after all events have been emitted.
   *
   * Classification rules from observability review §6.
   */
  classify(agentStates: Array<{ name: string; state: string; lifecycle: string }>): LoopClassified {
    const { classification, reasons } = this.computeClassification()

    const event: LoopClassified = {
      type: 'loop.classified',
      runId: this._runId,
      loop: this._currentLoop,
      classification,
      reasons,
      timestamp: new Date().toISOString(),
    }

    this.emit(event)
    return event
  }

  /** Build a LoopSnapshot for the current loop */
  snapshot(agentStates: Array<{ name: string; state: string; lifecycle: string }>): LoopSnapshot {
    const { classification, reasons } = this.computeClassification()
    return {
      loop: this._currentLoop,
      runId: this._runId,
      timestamp: new Date().toISOString(),
      classification,
      reasons,
      agents: agentStates.map(a => ({
        name: a.name,
        state: a.state as 'running' | 'idle' | 'stopped',
        lifecycle: a.lifecycle as '24/7' | 'on-demand' | 'idle_cached',
      })),
      taskTransitions: this.taskTransitions,
      artifactsCreated: this.artifactsCreated,
      pendingMessages: { ...this.pendingMessages },
    }
  }

  private computeClassification(): { classification: LoopClassification; reasons: string[] } {
    const reasons: string[] = []

    // Error takes highest priority
    if (this.errors > 0) {
      reasons.push(`${this.errors} error(s) in this loop`)
      return { classification: 'error', reasons }
    }

    // Productive: any task transition, artifact creation, or agent output
    if (this.taskTransitions > 0 || this.artifactsCreated > 0) {
      if (this.taskTransitions > 0) reasons.push(`${this.taskTransitions} task transition(s)`)
      if (this.artifactsCreated > 0) reasons.push(`${this.artifactsCreated} artifact(s) created`)
      return { classification: 'productive', reasons }
    }

    // Backlog stuck: agent idle but pending messages in queue
    const stuckAgents = Object.entries(this.pendingMessages)
      .filter(([, count]) => count > 0)
    if (stuckAgents.length > 0) {
      for (const [agent, count] of stuckAgents) {
        reasons.push(`${agent} has ${count} pending message(s) while idle`)
      }
      return { classification: 'backlog_stuck', reasons }
    }

    // Blocked: tasks exist but dependencies unmet
    if (this.blockedTasks > 0) {
      reasons.push(`${this.blockedTasks} task(s) blocked by dependencies`)
      return { classification: 'blocked', reasons }
    }

    // Idle: nothing happened
    reasons.push('no state changes detected')
    return { classification: 'idle', reasons }
  }

  /** Record an error in the current loop */
  recordError(): void {
    this.errors++
  }

  /** Remove all listeners (for cleanup) */
  removeAllListeners(): void {
    this.emitter.removeAllListeners()
  }
}
