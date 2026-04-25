/**
 * Loop-level observability events.
 *
 * Design source: docs/research/2026-03-17-empty-loop-observability-review.md §5-6
 * db9 persistence: loop_events table (see brain-manager.ts initWanmanSchema)
 */

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type LoopClassification =
  | 'productive'    // task transition, artifact created, agent produced output
  | 'idle'          // no state change, no output
  | 'blocked'       // tasks exist but dependencies unmet
  | 'backlog_stuck' // agent idle but pending messages in queue
  | 'error'         // process error, RPC failure

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export interface LoopTick {
  type: 'loop.tick'
  runId: string
  loop: number
  timestamp: string
}

export interface LoopClassified {
  type: 'loop.classified'
  runId: string
  loop: number
  classification: LoopClassification
  reasons: string[]
  timestamp: string
}

export interface AgentSpawned {
  type: 'agent.spawned'
  runId: string
  loop: number
  agent: string
  lifecycle: '24/7' | 'on-demand' | 'idle_cached'
  trigger: 'startup' | 'message' | 'steer' | 'cron' | 'backlog-drain'
  timestamp: string
}

export interface TaskTransition {
  type: 'task.transition'
  runId: string
  loop: number
  taskId: number
  assignee?: string
  from: string
  to: string
  timestamp: string
}

export interface TaskBlocked {
  type: 'task.blocked'
  runId: string
  loop: number
  taskId: number
  assignee?: string
  waitingOn: number[]
  timestamp: string
}

export interface QueueBacklog {
  type: 'queue.backlog'
  runId: string
  loop: number
  agent: string
  pendingMessages: number
  timestamp: string
}

export interface ArtifactCreated {
  type: 'artifact.created'
  runId: string
  loop: number
  agent: string
  kind: string
  path?: string
  timestamp: string
}

export interface AgentBudgetExceeded {
  type: 'agent.budget_exceeded'
  runId: string
  loop: number
  agent: string
  tokens: number
  budget: number
  timestamp: string
}

/** Union of all loop event types */
export type LoopEvent =
  | LoopTick
  | LoopClassified
  | AgentSpawned
  | TaskTransition
  | TaskBlocked
  | QueueBacklog
  | ArtifactCreated
  | AgentBudgetExceeded

// ---------------------------------------------------------------------------
// Loop snapshot (aggregated per loop for dashboard / NDJSON)
// ---------------------------------------------------------------------------

export interface LoopSnapshot {
  loop: number
  runId: string
  timestamp: string
  classification: LoopClassification
  reasons: string[]
  agents: Array<{
    name: string
    state: 'running' | 'idle' | 'stopped'
    lifecycle: '24/7' | 'on-demand' | 'idle_cached'
  }>
  taskTransitions: number
  artifactsCreated: number
  pendingMessages: Record<string, number>
}
