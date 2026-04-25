/**
 * Agent lifecycle mode.
 *
 * - `24/7`        — continuous respawn loop. The agent boots a fresh CLI
 *                   subprocess every iteration. Use for always-on roles.
 * - `on-demand`   — idle until triggered (cron / steer / message). Each
 *                   trigger starts a fresh, stateless run.
 * - `idle_cached` — idle until triggered (like `on-demand`), but the runtime
 *                   remembers the previous Claude `session_id` and resumes
 *                   it on the next trigger via `claude --resume`. Combines
 *                   "no CPU when idle" with "preserved conversation context".
 *                   **Claude-only.** The resume mechanism depends on Claude
 *                   Code's `system/init` session id and `--resume` flag;
 *                   Codex has no equivalent in this runtime today, so the
 *                   supervisor rejects `idle_cached` paired with a non-Claude
 *                   runtime at startup rather than letting it silently
 *                   degrade to `on-demand` semantics.
 */
export type AgentLifecycle = '24/7' | 'on-demand' | 'idle_cached';

/** Agent runtime backend */
export type AgentRuntime = 'claude' | 'codex';

/** Codex reasoning effort / speed tier */
export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

/** Model identifier or abstract tier — runtime-dependent (e.g. 'high', 'standard', 'o4-mini') */
export type ModelTier = string;

/** Message priority — steer interrupts current work, normal waits */
export type MessagePriority = 'steer' | 'normal';

/** Agent process state */
export type AgentState = 'idle' | 'running' | 'paused' | 'stopped' | 'error';

/** Coarse task/capsule work type */
export type TaskScopeType = 'code' | 'docs' | 'tests' | 'ops' | 'mixed';

/** Mission-board initiative state */
export type InitiativeStatus = 'active' | 'paused' | 'completed' | 'abandoned';

/** PR-sized change capsule state */
export type ChangeCapsuleStatus = 'open' | 'in_review' | 'merged' | 'abandoned';

/** Agent definition — loaded from agents.json config */
export interface AgentDefinition {
  name: string;
  lifecycle: AgentLifecycle;
  /** Runtime backend used to execute the agent process */
  runtime?: AgentRuntime;
  model: ModelTier;
  systemPrompt: string;
  /** Cron expressions for scheduled triggers */
  crons?: string[];
  /** Event types this agent subscribes to */
  events?: string[];
  /** Override ANTHROPIC_BASE_URL for this agent (e.g. LM Studio endpoint) */
  baseUrl?: string;
  /** Override ANTHROPIC_AUTH_TOKEN for this agent */
  apiKey?: string;
}

/** A message between agents or from external sources */
export interface AgentMessage {
  id: string;
  from: string;
  to: string;
  /** Message type (e.g. 'message', 'event', 'cron') */
  type: string;
  /** Structured payload */
  payload: unknown;
  priority: MessagePriority;
  timestamp: number;
  delivered: boolean;
}

/** Shared context entry — key-value store for inter-agent state */
export interface ContextEntry {
  key: string;
  value: string;
  updatedBy: string;
  updatedAt: number;
}

/** db9 Brain persistent memory config */
export interface BrainConfig {
  /** db9.ai API token (env: DB9_TOKEN) */
  token: string;
  /** Database name */
  dbName: string;
  /** db9 API base URL */
  baseUrl?: string;
}

/** Top-level config loaded from agents.json */
export interface AgentMatrixConfig {
  agents: AgentDefinition[];
  /** SQLite database path */
  dbPath?: string;
  /** HTTP server port */
  port?: number;
  /** Workspace root for agent working directories */
  workspaceRoot?: string;
  /** Git root for repo-aware runs (defaults from workspaceRoot) */
  gitRoot?: string;
  /** db9 Brain persistent memory config (optional) */
  brain?: BrainConfig;
  /** Top-level goal for the CEO agent to pursue autonomously */
  goal?: string;
}

/** External event pushed into the agent matrix */
export interface ExternalEvent {
  type: string;
  source: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

/** Long-running product initiative tracked during takeover */
export interface Initiative {
  id: string;
  title: string;
  goal: string;
  summary: string;
  status: InitiativeStatus;
  priority: number;
  sources: string[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** PR-sized change package linked to a branch */
export interface ChangeCapsule {
  id: string;
  goal: string;
  ownerAgent: string;
  branch: string;
  baseCommit: string;
  allowedPaths: string[];
  acceptance: string;
  reviewer: string;
  status: ChangeCapsuleStatus;
  createdAt: number;
  updatedAt: number;
  initiativeId?: string;
  taskId?: string;
  subsystem?: string;
  scopeType?: TaskScopeType;
  blockedBy?: string[];
  supersedes?: string;
}

// ── Auth types ──

/** Supported CLI auth providers */
export type AuthProviderName = 'github' | 'claude' | 'codex';

/** Auth status for a provider */
export type AuthStatus = 'authenticated' | 'unauthenticated' | 'pending' | 'error';

/** Auth provider info returned by auth.* RPC methods */
export interface AuthProviderInfo {
  name: AuthProviderName;
  status: AuthStatus;
  loginUrl?: string;
  loginCode?: string;
  error?: string;
}

/** Health check response */
export interface HealthResponse {
  status: 'ok';
  agents: Array<{
    name: string;
    state: AgentState;
    lifecycle: AgentLifecycle;
  }>;
  timestamp: string;
}
