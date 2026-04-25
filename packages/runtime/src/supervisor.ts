/**
 * Supervisor — main coordinator for the Agent Matrix.
 *
 * Responsibilities:
 * 1. Initialize message relay + context store (in-process SQLite)
 * 2. Create AgentProcess instances from config
 * 3. Handle JSON-RPC requests from wanman CLI
 * 4. Handle external events (webhooks, cron)
 * 5. Manage graceful startup/shutdown
 */

import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type {
  AgentMatrixConfig,
  JsonRpcRequest,
  JsonRpcResponse,
  ExternalEvent,
  HealthResponse,
  AgentSendParams,
  AgentRecvParams,
  ContextGetParams,
  ContextSetParams,
  EventPushParams,
  TaskCreateParams,
  TaskListParams,
  TaskGetParams,
  TaskUpdateParams,
  InitiativeCreateParams,
  InitiativeListParams,
  InitiativeGetParams,
  InitiativeUpdateParams,
  CapsuleCreateParams,
  CapsuleListParams,
  CapsuleGetParams,
  CapsuleUpdateParams,
  CapsuleMineParams,
  ArtifactPutParams,
  ArtifactListParams,
  ChangeCapsuleStatus,
  InitiativeStatus,
} from '@wanman/core';
import { RPC_METHODS, RPC_ERRORS, createRpcResponse, createRpcError } from '@wanman/core';
import { MessageStore } from './message-store.js';
import { ContextStore } from './context-store.js';
import { Relay } from './relay.js';
import { buildEnrichedPrompt } from './config.js';
import { AgentProcess } from './agent-process.js';
import { CronScheduler } from './cron-scheduler.js';
import { type CredentialManager } from './credential-manager.js';
import { BrainManager } from './brain-manager.js';
import { esc, escJson, SAFE_IDENT, SAFE_PATH } from './sql-escape.js';
import { LoopEventBus } from './loop-event-bus.js';
import { generatePreamble } from './preamble.js';
import type {
  EnvironmentProvider,
  PreambleProvider,
  RunCompleteCallback,
  RunCompleteInfo,
} from './agent-process.js';
import { TokenTracker } from './token-tracker.js';
import { SkillManager } from './skill-manager.js';
import { AuthManager, isAuthProviderName } from './auth-manager.js';
import { TaskPool, type Task } from './task-pool.js';
import { InitiativeBoard } from './initiative-board.js';
import { ChangeCapsulePool } from './change-capsule-pool.js';
import { createHttpServer } from './http-server.js';
import { createLogger } from './logger.js';
import type * as http from 'http';
import { resolveMaybePromise, type ContextBackend, type MessageTransport } from './runtime-contracts.js';
import type { AgentMessage } from '@wanman/core';
import { resolveAgentRuntime } from './agent-adapter.js';
import {
  SharedSkillManager,
  type ActivationSnapshotRecord,
} from './shared-skill-manager.js';
import { AgentHomeManager } from './agent-home-manager.js';

const log = createLogger('supervisor');

function postStorySyncEvent(event: {
  event_type: string;
  classification?: string;
  agent?: string;
  payload?: unknown;
}): void {
  const syncUrl = process.env['WANMAN_SYNC_URL'];
  const syncSecret = process.env['WANMAN_SYNC_SECRET'];
  const syncStoryId = process.env['WANMAN_STORY_ID'];
  if (!syncUrl || !syncStoryId) return;

  fetch(`${syncUrl}/event`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Story-Id': syncStoryId,
      ...(syncSecret ? { 'X-Sync-Secret': syncSecret } : {}),
    },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {});
}

function isHumanConversationTarget(name: string | null | undefined): boolean {
  return typeof name === 'string' && name.trim().toLowerCase() === 'human';
}

function inferHumanMessageType(payload: unknown, priority: 'steer' | 'normal'): 'decision' | 'blocker' {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (record.blocked === true) return 'blocker';
    if (record.kind === 'blocker' || record.kind === 'access_request') return 'blocker';
  }

  if (priority === 'steer') return 'blocker';
  return 'decision';
}

function normalizeThreadSyncMessageType(
  to: string,
  type: string | undefined,
  payload: unknown,
  priority: 'steer' | 'normal',
): string {
  const normalizedType = typeof type === 'string' && type.trim() ? type.trim() : 'message';
  if (normalizedType !== 'message') return normalizedType;
  if (!isHumanConversationTarget(to)) return normalizedType;
  return inferHumanMessageType(payload, priority);
}

function postStorySyncArtifact(artifact: {
  id?: string;
  agent?: string;
  kind: string;
  path: string;
  content?: string | null;
  metadata?: Record<string, unknown>;
}): void {
  const syncUrl = process.env['WANMAN_SYNC_URL'];
  const syncSecret = process.env['WANMAN_SYNC_SECRET'];
  const syncStoryId = process.env['WANMAN_STORY_ID'];
  if (!syncUrl || !syncStoryId) return;

  fetch(`${syncUrl}/artifact`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Story-Id': syncStoryId,
      ...(syncSecret ? { 'X-Sync-Secret': syncSecret } : {}),
    },
    body: JSON.stringify(artifact),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {});
}

export interface SupervisorOptions {
  credentialManager?: CredentialManager;
  /** If true, skip starting agent processes and cron jobs (HTTP + stores only). */
  headless?: boolean;
}

export class Supervisor {
  private config: AgentMatrixConfig;
  private credentialManager?: CredentialManager;
  private headless: boolean;
  private db!: Database.Database;
  private messageStore!: MessageStore;
  private contextStore!: ContextBackend;
  private relay!: MessageTransport;
  private agents: Map<string, AgentProcess> = new Map();
  /** Names of dynamically spawned agents (for cleanup tracking) */
  private dynamicAgents: Set<string> = new Set();
  private brainManager: BrainManager | null = null;
  private authManager: AuthManager;
  private taskPool!: TaskPool;
  private initiativeBoard!: InitiativeBoard;
  private capsulePool!: ChangeCapsulePool;
  private cronScheduler!: CronScheduler;
  private httpServer: http.Server | null = null;
  /** Loop-level event bus for observability */
  private _eventBus: LoopEventBus | null = null;
  /** Token consumption tracker */
  private _tokenTracker = new TokenTracker();
  /** Skill version manager */
  private _skillManager: SkillManager | null = null;
  /** Shared skill registry and activation snapshot manager */
  private _sharedSkillManager: SharedSkillManager | null = null;
  /** Per-agent HOME overlays for snapshot-scoped skill activation */
  private _agentHomeManager: AgentHomeManager | null = null;
  /** Cached snapshots for the current run/profile/task combination */
  private activationSnapshots = new Map<string, ActivationSnapshotRecord>();
  /** Latest snapshot seen by each agent, used for feedback attribution */
  private activeSnapshotByAgent = new Map<string, ActivationSnapshotRecord>();
  /** Total number of completed agent runs in this supervisor lifecycle */
  private completedRuns = 0;
  /** Per-agent completed run counts */
  private completedRunsByAgent = new Map<string, number>();

  constructor(config: AgentMatrixConfig, options?: SupervisorOptions) {
    this.config = config;
    this.credentialManager = options?.credentialManager;
    this.headless = options?.headless ?? false;
    this.authManager = new AuthManager();
    // TaskPool is initialized lazily — needs SQLite DB which may not exist yet

    if (config.brain) {
      this.brainManager = new BrainManager(config.brain);
    }

    this.initSqlite(config);
    this.wireSteerCallback();
    this.initCronScheduler();
  }

  /** Public accessor for the loop event bus (null until initEventBus is called) */
  get eventBus(): LoopEventBus | null { return this._eventBus }

  /** Public accessor for token tracker */
  get tokenTracker(): TokenTracker { return this._tokenTracker }

  private notifyTaskAssignment(
    agent: string,
    task: { id: string; title: string; priority: number; description: string; executionProfile?: string },
    from: string,
  ): void {
    if (!this.agents.has(agent)) {
      return;
    }
    this.relay.send(from, agent, 'task_assigned', {
      taskId: task.id,
      title: task.title,
      priority: task.priority,
      description: task.description,
      executionProfile: task.executionProfile,
    }, 'normal');
    log.info('auto-notified agent of task assignment', { agent, taskId: task.id });
  }

  private filterStaleTaskAssignmentMessages(agent: string, messages: AgentMessage[]): AgentMessage[] {
    return messages.filter((message) => {
      if (message.type !== 'task_assigned') {
        return true;
      }

      const payload = message.payload;
      if (!payload || typeof payload !== 'object' || !('taskId' in payload)) {
        return true;
      }

      const taskId = (payload as { taskId?: unknown }).taskId;
      if (typeof taskId !== 'string') {
        return true;
      }

      const task = this.taskPool.get(taskId);
      if (!task) {
        return false;
      }

      return task.assignee === agent;
    });
  }

  /**
   * Stop an agent that has exceeded its token budget. Releases claimed tasks,
   * records an event, and keeps the agent out of the respawn loop by calling
   * AgentProcess.stop() (which aborts the loop controller).
   *
   * The budget is taken from WANMAN_AGENT_TOKEN_BUDGET (integer total tokens).
   * When unset or zero/negative, enforcement is disabled.
   */
  private tokenBudgetAgentsStopped = new Set<string>();

  private enforceTokenBudget(agentName: string): void {
    if (this.tokenBudgetAgentsStopped.has(agentName)) return;

    const raw = process.env['WANMAN_AGENT_TOKEN_BUDGET'];
    if (!raw) return;
    const budget = parseInt(raw, 10);
    if (!Number.isFinite(budget) || budget <= 0) return;

    const runId = this._eventBus?.runId ?? 'unknown';
    const usage = this._tokenTracker.getUsage(runId);
    const agentTotal = usage.byAgent[agentName] ?? 0;
    if (agentTotal < budget) return;

    const agent = this.agents.get(agentName);
    log.warn('agent token budget exceeded — stopping', {
      agent: agentName, agentTotal, budget,
    });
    try {
      agent?.stop();
      const released = this.taskPool.releaseByAssignee(agentName);
      if (released > 0) {
        log.info('released claimed tasks after budget stop', { agent: agentName, count: released });
      }
      this._eventBus?.emit({
        type: 'agent.budget_exceeded',
        runId,
        loop: this._eventBus?.currentLoop ?? 0,
        agent: agentName,
        tokens: agentTotal,
        budget,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      log.warn('failed to stop agent after budget exceeded', {
        agent: agentName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.tokenBudgetAgentsStopped.add(agentName);
  }

  /** Record token usage and update context store for CEO budget awareness */
  recordTokenUsage(
    agentId: string,
    usageOrInputTokens: { inputTokens: number; outputTokens: number; totalTokens?: number } | number,
    outputTokens?: number,
  ): void {
    const runId = this._eventBus?.runId ?? 'unknown'
    const usage = typeof usageOrInputTokens === 'number'
      ? {
          inputTokens: usageOrInputTokens,
          outputTokens: outputTokens ?? 0,
          totalTokens: usageOrInputTokens + (outputTokens ?? 0),
        }
      : usageOrInputTokens
    this._tokenTracker.record({
      workflowId: runId,
      agentId,
      phase: 'execute',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      timestamp: Date.now(),
    })

    // Update context store so CEO can query via `wanman context get token_budget`
    try {
      const summary = this._tokenTracker.getUsage(runId)
      const budget = parseInt(process.env['WANMAN_TOKEN_BUDGET'] || '0', 10)
      const budgetCheck = budget > 0 ? this._tokenTracker.checkBudget(runId, budget) : null

      if (this.contextStore && 'set' in this.contextStore) {
        void resolveMaybePromise(this.contextStore.set(
          'token_usage',
          JSON.stringify({
            total: summary.total,
            byAgent: summary.byAgent,
            budget: budget || null,
            remaining: budgetCheck?.remaining ?? null,
            warning: budgetCheck?.warning ?? false,
            exceeded: budgetCheck?.exceeded ?? false,
          }),
          'system',
        ))
      }
    } catch {
      // Non-fatal
    }
  }

  /** Initialize the loop event bus for observability. Call before start(). */
  initEventBus(runId: string): LoopEventBus {
    this._eventBus = new LoopEventBus(runId)
    return this._eventBus
  }

  /** Build a preamble provider closure that captures supervisor state */
  private buildPreambleProvider(): PreambleProvider {
    return async (agentName: string): Promise<string | undefined> => {
      try {
        const tasks = this.taskPool?.listSync() ?? [];
        const preamble = generatePreamble({
          agentName,
          tasks,
          recentMessages: [], // Messages are already included directly in the prompt
          loopNumber: this._eventBus?.currentLoop ?? 0,
          uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
          runId: this._eventBus?.runId,
        });
        const snapshot = await this.getOrCreateActivationSnapshot(agentName);
        if (!snapshot || snapshot.resolvedSkills.length === 0) {
          return preamble;
        }

        const activePaths = snapshot.resolvedSkills
          .map(skill => `- ${skill.path}`)
          .join('\n');
        const scopeLabel = snapshot.taskId
          ? `task-bound snapshot (${snapshot.taskId.slice(0, 8)})`
          : `${snapshot.activationScope}-level snapshot`;
        const profileLine = snapshot.executionProfile
          ? `Execution profile: \`${snapshot.executionProfile}\`\n`
          : '';

        return `${preamble}

### Active Skill Snapshot
${profileLine}Snapshot ID: \`${snapshot.id}\` (${scopeLabel})
Read these skill files before proceeding:
${activePaths}`;
      } catch {
        // Non-fatal: preamble generation failure should never prevent agent spawn
        return undefined;
      }
    };
  }

  private buildEnvProvider(): EnvironmentProvider {
    return async (agentName: string): Promise<Record<string, string>> => {
      const snapshot = await this.getOrCreateActivationSnapshot(agentName)
      const agentHome = this._agentHomeManager?.prepareAgentHome(agentName, snapshot)
      return {
        ...(agentHome ? { HOME: agentHome } : {}),
        ...(snapshot?.materializedPath ? { WANMAN_ACTIVE_SKILLS_DIR: snapshot.materializedPath } : {}),
        ...(snapshot?.id ? { WANMAN_ACTIVE_SKILL_SNAPSHOT_ID: snapshot.id } : {}),
      }
    }
  }

  private verifySkillRuntime(): void {
    this._sharedSkillManager?.verifyActivationInfrastructure()
    const probeHome = this._agentHomeManager?.prepareAgentHome('__startup_probe__')
    if (!probeHome) {
      return
    }
    try {
      for (const runtimeDir of ['.claude', '.codex']) {
        const skillsPath = path.join(probeHome, runtimeDir, 'skills')
        const stat = fs.lstatSync(skillsPath)
        if (!stat.isSymbolicLink()) {
          throw new Error(`strict skill runtime requires ${skillsPath} to be a symlink`)
        }
      }
    } finally {
      this._agentHomeManager?.cleanupHomes()
    }
  }

  /** Build a run-complete callback that writes feedback to db9 */
  private buildRunCompleteCallback(): RunCompleteCallback {
    return (info: RunCompleteInfo) => {
      try {
        this.completedRuns++;
        this.completedRunsByAgent.set(
          info.agentName,
          (this.completedRunsByAgent.get(info.agentName) ?? 0) + 1,
        );

        // Record actual runtime-reported token usage for supervisor metrics.
        this.recordTokenUsage(info.agentName, {
          inputTokens: info.inputTokens,
          outputTokens: info.outputTokens,
          totalTokens: info.totalTokens,
        })

        // Per-agent token budget enforcement. Reads WANMAN_AGENT_TOKEN_BUDGET (a
        // total-tokens integer); when an agent crosses it we stop the AgentProcess
        // and release its claimed tasks so other agents can pick them up.
        this.enforceTokenBudget(info.agentName);

        // Write run_feedback to db9
        if (this.brainManager?.isInitialized) {
          const runId = this._eventBus?.runId ?? 'unknown'
          const loop = this._eventBus?.currentLoop ?? 0
          const tokenCount = info.totalTokens
          const attributedTask = this.getAttributableTaskForAgent(info.agentName)
          const snapshot = this.activeSnapshotByAgent.get(info.agentName)
          const sql = `INSERT INTO run_feedback (
            run_id,
            agent,
            task_completed,
            duration_ms,
            token_count,
            errored,
            steer_count,
            loop_number,
            task_id,
            execution_profile,
            bundle_id,
            bundle_version,
            activation_snapshot_id
          ) VALUES (
            '${esc(runId)}',
            '${esc(info.agentName)}',
            ${!info.errored},
            ${info.durationMs},
            ${tokenCount},
            ${info.errored},
            ${info.steerCount},
            ${loop},
            ${sqlStringOrNull(attributedTask?.id)},
            ${sqlStringOrNull(attributedTask?.executionProfile)},
            ${sqlStringOrNull(snapshot?.bundleId)},
            ${snapshot?.bundleVersion ?? 'NULL'},
            ${sqlStringOrNull(snapshot?.id)}
          )`
          this.brainManager.executeSQL(sql).catch(err => {
            log.warn('Failed to write run_feedback', { agent: info.agentName, error: String(err) })
          })
        }

        log.info('run complete', {
          agent: info.agentName,
          exitCode: info.exitCode,
          durationMs: info.durationMs,
          errored: info.errored,
          steerCount: info.steerCount,
        })
      } catch {
        // Non-fatal: feedback recording should never prevent agent operation
      }
    }
  }

  /**
   * Dynamically spawn a clone of an existing agent role.
   *
   * Creates a new AgentProcess with the same CLAUDE.md, model, and skills
   * as the template agent, but with a unique name (e.g. feedback-2).
   * The clone runs as on-demand — it starts idle and is triggered by messages.
   */
  async spawnDynamicAgent(templateName: string, cloneName?: string): Promise<{ name: string } | { error: string }> {
    // Find the template agent definition
    const templateDef = this.config.agents.find(a => a.name === templateName)
    if (!templateDef) {
      return { error: `Template agent '${templateName}' not found in config` }
    }

    // Generate clone name if not provided
    const name = cloneName || `${templateName}-${this.dynamicAgents.size + 2}`
    if (this.agents.has(name)) {
      return { error: `Agent '${name}' already exists` }
    }

    // Create clone definition — always on-demand (temporary workers)
    const cloneDef: import('@wanman/core').AgentDefinition = {
      ...templateDef,
      name,
      lifecycle: 'on-demand' as const,
      crons: undefined, // no cron for clones
      events: undefined, // no event subscriptions
    }

    const workspaceRoot = this.config.workspaceRoot || '/workspace/agents'
    const workDir = `${workspaceRoot}/${name}`
    const templateWorkDir = `${workspaceRoot}/${templateName}`
    fs.mkdirSync(workDir, { recursive: true })
    for (const entry of ['AGENT.md', 'CLAUDE.md']) {
      const source = path.join(templateWorkDir, entry)
      const target = path.join(workDir, entry)
      if (fs.existsSync(source) && !fs.existsSync(target)) {
        fs.copyFileSync(source, target)
      }
    }
    fs.mkdirSync(path.join(workDir, 'output'), { recursive: true })
    const brainEnv = this.brainManager?.env ?? {}
    const agentEnv: Record<string, string> = { ...brainEnv, WANMAN_AGENT_NAME: name }
    if (templateDef.baseUrl) agentEnv['ANTHROPIC_BASE_URL'] = templateDef.baseUrl
    if (templateDef.apiKey) agentEnv['ANTHROPIC_AUTH_TOKEN'] = templateDef.apiKey

    const goal = this.config.goal || process.env['WANMAN_GOAL'] || undefined
    const preambleProvider = this.buildPreambleProvider()
    const envProvider = this.buildEnvProvider()
    const onRunComplete = this.buildRunCompleteCallback()
    const timeBudgetMs = parseInt(process.env['WANMAN_TIME_BUDGET_MS'] || '0', 10) || undefined

    const agentProc = new AgentProcess(
      cloneDef, this.relay, workDir,
      this.credentialManager, agentEnv, goal,
      preambleProvider, onRunComplete, timeBudgetMs,
      (agentName) => this.hasAutonomousWork(agentName),
      envProvider,
    )

    this.agents.set(name, agentProc)
    this.dynamicAgents.add(name)

    // Start the agent (on-demand → goes to idle, waiting for messages)
    agentProc.start().catch(err => {
      log.error('dynamic agent start failed', { name, error: String(err) })
    })

    log.info('spawned dynamic agent', { name, template: templateName })
    return { name }
  }

  /** Destroy a dynamically spawned agent */
  async destroyDynamicAgent(name: string): Promise<boolean> {
    if (!this.dynamicAgents.has(name)) {
      return false // can't destroy static agents
    }
    const agent = this.agents.get(name)
    if (agent) {
      agent.stop()
      const released = this.taskPool.releaseByAssignee(name)
      if (released > 0) {
        log.info('released claimed tasks on agent destroy', { agent: name, count: released })
      }
      this.agents.delete(name)
    }
    this.dynamicAgents.delete(name)
    log.info('destroyed dynamic agent', { name })
    return true
  }

  /** Timestamp when supervisor started */
  private startedAt = Date.now();

  private openDatabase(dbPath: string): Database.Database {
    log.info('opening database', { dbPath });
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    const db = new Database(dbPath);
    try {
      db.pragma('journal_mode = WAL');
    } catch {
      db.pragma('journal_mode = DELETE');
    }
    db.pragma('busy_timeout = 5000');
    return db;
  }

  /** Initialize SQLite-based stores (existing behavior). */
  private initSqlite(config: AgentMatrixConfig): void {
    const dbPath = config.dbPath || '/tmp/wanman.db';
    this.db = this.openDatabase(dbPath);
    this.messageStore = new MessageStore(this.db);
    this.contextStore = new ContextStore(this.db);
    this.relay = new Relay(this.messageStore);
    this.taskPool = new TaskPool(this.db);
    this.initiativeBoard = new InitiativeBoard(this.db);
    this.capsulePool = new ChangeCapsulePool(this.db);
  }

  /** Wire steer callback on the relay (disabled in headless mode). */
  private wireSteerCallback(): void {
    if (!this.headless) {
      this.relay.setSteerCallback((agentName) => {
        const agent = this.agents.get(agentName);
        if (agent) {
          agent.handleSteer();
        } else {
          log.warn('steer target not found', { agent: agentName });
        }
      });

      // Wake on-demand / idle_cached agents when any message arrives (not just steer)
      this.relay.setNewMessageCallback((agentName) => {
        const agent = this.agents.get(agentName);
        if (
          agent
          && (agent.definition.lifecycle === 'on-demand' || agent.definition.lifecycle === 'idle_cached')
          && agent.state === 'idle'
        ) {
          // Check if any assigned task for this agent has unmet dependencies
          const blocked = this.hasBlockedTasksOnly(agentName);
          if (blocked) {
            log.info('idle agent has only blocked tasks, deferring', {
              agent: agentName,
              lifecycle: agent.definition.lifecycle,
            });
            return;
          }
          log.info('waking idle agent for new message', {
            agent: agentName,
            lifecycle: agent.definition.lifecycle,
          });
          agent.trigger();
        }
      });
    }
  }

  /** Initialize the cron scheduler. */
  private initCronScheduler(): void {
    this.cronScheduler = new CronScheduler((agentName, expression) => {
      this.relay.send('system', agentName, 'cron', { expression }, 'normal');
      // For idle agents (on-demand / idle_cached), also trigger them
      const agent = this.agents.get(agentName);
      if (
        agent
        && (agent.definition.lifecycle === 'on-demand' || agent.definition.lifecycle === 'idle_cached')
      ) {
        agent.handleSteer();
      }
    });
  }

  /** Start the supervisor: create agent processes, start HTTP server. */
  async start(): Promise<void> {
    const port = this.config.port || 3120;
    const workspaceRoot = this.config.workspaceRoot || '/workspace/agents';
    const gitRoot = this.config.gitRoot || process.env['WANMAN_GIT_ROOT']
      || workspaceRoot.replace(/\/agents\/?$/, '') || workspaceRoot;

    // Initialize Brain (before creating agent processes)
    if (this.brainManager) {
      await this.brainManager.initialize();
    }

    // Auto-initialize EventBus if not already set up externally
    if (!this._eventBus) {
      const runId = `run-${Date.now().toString(36)}`
      this.initEventBus(runId)
      log.info('auto-initialized event bus', { runId })
    }

    // Initialize Skill Manager
    this._skillManager = new SkillManager(
      this.brainManager,
      `${workspaceRoot}/../packages/core/agents`,
    );
    const sharedSkillsDir = process.env['WANMAN_SHARED_SKILLS'] || '/opt/wanman/shared-skills'
    this._sharedSkillManager = new SharedSkillManager(this.brainManager, sharedSkillsDir)
    await this._sharedSkillManager.syncFilesystemSkills()
    const agentUser = process.env['WANMAN_AGENT_USER']
    const baseHome = agentUser ? `/home/${agentUser}` : (process.env['HOME'] || '/root')
    const runId = this._eventBus?.runId ?? 'unknown'
    // Include pid + per-instance random suffix so parallel supervisors (e.g.
    // vitest file-level parallelism) never share a homesRoot. Without this,
    // two test files that start a Supervisor in the same millisecond collide
    // on `/tmp/wanman-agent-homes/<runId>/__startup_probe__/.claude/...` and
    // fail with EEXIST when the probe symlinks are rebuilt.
    const homesRoot = path.join(
      os.tmpdir(),
      'wanman-agent-homes',
      `${runId}-p${process.pid}-${randomUUID().slice(0, 8)}`,
    )
    this._agentHomeManager = new AgentHomeManager(baseHome, homesRoot)
    this.verifySkillRuntime()

    // Initialize git repo in workspace (idempotent)
    this.initWorkspaceGit(gitRoot, workspaceRoot);

    const brainEnv = this.brainManager?.env ?? {};

    // Create agent processes
    for (const def of this.config.agents) {
      const workDir = `${workspaceRoot}/${def.name}`;
      // Goal is available to all agents: CEO uses it for orchestration, workers for business context
      const goal = this.config.goal || process.env['WANMAN_GOAL'] || undefined;
      const agentEnv: Record<string, string> = { ...brainEnv, WANMAN_AGENT_NAME: def.name };
      const runtime = resolveAgentRuntime(def);
      // Per-agent LLM endpoint override (hybrid model routing)
      log.info('agent config', { agent: def.name, baseUrl: def.baseUrl ?? '(none)', apiKey: def.apiKey ? '***' : '(none)' });
      if (def.baseUrl) agentEnv['ANTHROPIC_BASE_URL'] = def.baseUrl;
      if (def.apiKey) agentEnv['ANTHROPIC_AUTH_TOKEN'] = def.apiKey;
      // We enrich prompts whenever the agent is not relying on the default Claude Code
      // workflow alone. Codex needs the same explicit protocol guidance as external LLMs.
      const shouldEnrichPrompt = runtime === 'codex'
        || !!def.baseUrl
        || !!process.env['ANTHROPIC_BASE_URL'];
      const agentDef = shouldEnrichPrompt
        ? { ...def, systemPrompt: buildEnrichedPrompt(def, workspaceRoot, this.config.agents, goal) }
        : def;
      // Preamble provider: generates context summary on agent respawn
      const preambleProvider = this.buildPreambleProvider();
      const envProvider = this.buildEnvProvider();
      // Run complete callback: records feedback to db9 for skill evolution
      const onRunComplete = this.buildRunCompleteCallback();
      // Time budget per agent spawn (env: WANMAN_TIME_BUDGET_MS, or per-agent config)
      const timeBudgetMs = parseInt(process.env['WANMAN_TIME_BUDGET_MS'] || '0', 10) || undefined;
      const agentProc = new AgentProcess(
        agentDef,
        this.relay,
        workDir,
        this.credentialManager,
        agentEnv,
        goal,
        preambleProvider,
        onRunComplete,
        timeBudgetMs,
        (agentName) => this.hasAutonomousWork(agentName),
        envProvider,
      );
      this.agents.set(def.name, agentProc);
    }

    // Start HTTP server (always — needed for health check and RPC even in headless mode)
    this.httpServer = createHttpServer({
      port,
      onRpc: (req) => this.handleRpcAsync(req),
      onEvent: (event) => this.handleExternalEvent(event),
      onHealth: () => this.getHealth(),
    });

    if (this.headless) {
      log.info('headless mode — skipping agent processes and cron jobs');
      return;
    }

    // Register cron jobs from agent definitions
    for (const def of this.config.agents) {
      if (def.crons) {
        for (const expr of def.crons) {
          this.cronScheduler.addJob(def.name, expr);
        }
      }
    }
    this.cronScheduler.start();

    // Start all agents
    for (const [name, agent] of this.agents) {
      log.info('starting agent', { agent: name, lifecycle: agent.definition.lifecycle });
      agent.start().catch((err) => {
        log.error('agent start failed', {
          agent: name,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    log.info('supervisor started', {
      agents: this.config.agents.map(a => a.name),
      port,
    });
  }

  /** Handle a JSON-RPC request (synchronous methods). */
  handleRpc(req: JsonRpcRequest): JsonRpcResponse {
    const params = req.params || {};
    const agent = (params as Record<string, unknown>).agent ?? (params as Record<string, unknown>).from;
    log.info('rpc', { method: req.method, agent: agent || undefined });

    switch (req.method) {
      case RPC_METHODS.AGENT_SEND: {
        const { from, to, type, payload, priority } = params as unknown as AgentSendParams;
        if (!to || payload === undefined) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, 'Missing "to" or "payload"');
        }
        const sender = (from as string) || 'external';
        const messagePriority = (priority as 'steer' | 'normal') || 'normal';
        const messageType = typeof type === 'string' && type.trim() ? type : 'message';
        const syncMessageType = normalizeThreadSyncMessageType(to, messageType, payload, messagePriority);

        // Validate target agent exists
        if (!this.hasKnownAgent(to) && !isHumanConversationTarget(to)) {
          return createRpcError(req.id, RPC_ERRORS.AGENT_NOT_FOUND, `Agent "${to}" not found`);
        }
        const id = isHumanConversationTarget(to)
          ? `human-${Date.now()}`
          : this.relay.send(
              sender,
              to,
              messageType,
              payload,
              messagePriority,
            );

        postStorySyncEvent({
          event_type: 'thread',
          classification: messagePriority,
          agent: sender,
          payload: {
            from: sender,
            to,
            type: syncMessageType,
            payload,
            priority: messagePriority,
          },
        });

        return createRpcResponse(req.id, { id, status: 'queued' });
      }

      case RPC_METHODS.AGENT_RECV: {
        const { agent, limit } = params as unknown as AgentRecvParams;
        if (!agent) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, 'Missing "agent"');
        }
        const messages = (this.relay as Relay).recv(agent, (limit as number) ?? 10);
        return createRpcResponse(req.id, { messages });
      }

      case RPC_METHODS.AGENT_LIST: {
        const agents = Array.from(this.agents.entries()).map(([name, proc]) => ({
          name,
          state: proc.state,
          lifecycle: proc.definition.lifecycle,
          model: proc.definition.model,
        }));
        return createRpcResponse(req.id, { agents });
      }

      case RPC_METHODS.CONTEXT_GET: {
        const { key } = params as unknown as ContextGetParams;
        if (!key) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, 'Missing "key"');
        }
        const entry = (this.contextStore as ContextStore).get(key);
        return createRpcResponse(req.id, entry);
      }

      case RPC_METHODS.CONTEXT_SET: {
        const { key, value, agent } = params as unknown as ContextSetParams;
        if (!key || value === undefined) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, 'Missing "key" or "value"');
        }
        (this.contextStore as ContextStore).set(key, value as string, (agent as string) || 'unknown');
        return createRpcResponse(req.id, { status: 'ok' });
      }

      case RPC_METHODS.CONTEXT_LIST: {
        const entries = (this.contextStore as ContextStore).getAll();
        return createRpcResponse(req.id, { entries });
      }

      case RPC_METHODS.EVENT_PUSH: {
        const { type, source, payload } = params as unknown as EventPushParams;
        this.handleExternalEvent({
          type: type || 'unknown',
          source: source || 'rpc',
          payload: (payload as Record<string, unknown>) || {},
          timestamp: Date.now(),
        });
        return createRpcResponse(req.id, { status: 'accepted' });
      }

      case RPC_METHODS.HEALTH_CHECK: {
        return createRpcResponse(req.id, this.getHealth());
      }

      case RPC_METHODS.AUTH_STATUS: {
        const provider = params['provider'];
        if (!provider) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, 'Missing "provider"');
        }
        if (!isAuthProviderName(provider)) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, `Unsupported auth provider: ${String(provider)}`);
        }
        return createRpcResponse(req.id, this.authManager.getLoginStatus(provider));
      }

      default:
        return createRpcError(req.id, RPC_ERRORS.METHOD_NOT_FOUND, `Unknown method: ${req.method}`);
    }
  }

  /** Handle a JSON-RPC request (supports async methods). Used by HTTP server. */
  async handleRpcAsync(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = req.params || {};
    const agent = (params as Record<string, unknown>).agent as string | undefined;
    log.info('rpc', { method: req.method, agent: agent || undefined });

    switch (req.method) {
      case RPC_METHODS.AUTH_PROVIDERS: {
        const providers = await this.authManager.getProviders();
        return createRpcResponse(req.id, { providers });
      }

      case RPC_METHODS.AUTH_START: {
        const provider = params['provider'];
        if (!provider) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, 'Missing "provider"');
        }
        if (!isAuthProviderName(provider)) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, `Unsupported auth provider: ${String(provider)}`);
        }
        const info = await this.authManager.startLogin(provider);
        return createRpcResponse(req.id, info);
      }

      // AGENT_RECV — local Relay returns sync, resolveMaybePromise handles both
      case RPC_METHODS.AGENT_RECV: {
        const { agent, limit } = params as unknown as AgentRecvParams;
        if (!agent) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, 'Missing "agent"');
        }
        const messages = await resolveMaybePromise(this.relay.recv(agent, (limit as number) ?? 10));
        return createRpcResponse(req.id, {
          messages: this.filterStaleTaskAssignmentMessages(agent, messages),
        });
      }

      // CONTEXT_GET — local ContextStore returns sync, resolveMaybePromise handles both
      case RPC_METHODS.CONTEXT_GET: {
        const { key } = params as unknown as ContextGetParams;
        if (!key) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, 'Missing "key"');
        }
        const entry = await resolveMaybePromise(this.contextStore.get(key));
        return createRpcResponse(req.id, entry);
      }

      // CONTEXT_SET — local ContextStore returns sync, resolveMaybePromise handles both
      case RPC_METHODS.CONTEXT_SET: {
        const { key, value, agent } = params as unknown as ContextSetParams;
        if (!key || value === undefined) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, 'Missing "key" or "value"');
        }
        await resolveMaybePromise(this.contextStore.set(key, value as string, (agent as string) || 'unknown'));
        return createRpcResponse(req.id, { status: 'ok' });
      }

      // CONTEXT_LIST — local ContextStore returns sync, resolveMaybePromise handles both
      case RPC_METHODS.CONTEXT_LIST: {
        const entries = await resolveMaybePromise(this.contextStore.getAll());
        return createRpcResponse(req.id, { entries });
      }

      // ── Task Pool ──

      case RPC_METHODS.TASK_CREATE: {
        const { title, description, scope, priority, parentId, assignee, dependsOn, initiativeId, capsuleId, subsystem, scopeType, executionProfile } = params as unknown as TaskCreateParams;
        if (!title) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, 'Missing "title"');
        }
        if (initiativeId && !this.initiativeBoard.get(initiativeId)) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, `Initiative "${initiativeId}" not found`);
        }
        const capsule = capsuleId ? this.capsulePool.get(capsuleId) : null;
        if (capsuleId && !capsule) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, `Capsule "${capsuleId}" not found`);
        }
        const normalizedScope = scope || { paths: [] };
        const conflicts = await this.taskPool.checkConflict(normalizedScope);
        if (conflicts.length > 0) {
          const conflictIds = conflicts.map(task => task.id.slice(0, 8)).join(', ');
          return createRpcError(
            req.id,
            RPC_ERRORS.INVALID_PARAMS,
            `Task scope conflicts with active task(s): ${conflictIds}`,
          );
        }
        const task = await this.taskPool.create({
          title,
          description: description || '',
          scope: normalizedScope,
          priority: priority ?? 5,
          parentId,
          dependsOn,
          initiativeId: initiativeId ?? capsule?.initiativeId,
          capsuleId,
          subsystem,
          scopeType,
          executionProfile,
        });
        if (assignee) {
          await this.taskPool.update(task.id, { status: 'assigned', assignee, executionProfile });
          // Auto-notify: send a message to the assigned agent so it knows about the task
          const from = (params as Record<string, unknown>)['from'] as string || 'system';
          this.notifyTaskAssignment(assignee, {
            id: task.id,
            title,
            priority: priority ?? 5,
            description: description || '',
            executionProfile,
          }, from);
        }
        const result = assignee ? this.taskPool.get(task.id) : task;
        return createRpcResponse(req.id, result);
      }

      case RPC_METHODS.TASK_LIST: {
        const { status, assignee, initiativeId, capsuleId } = params as unknown as TaskListParams;
        let tasks = await this.taskPool.list();
        if (status) tasks = tasks.filter(t => t.status === status);
        if (assignee) tasks = tasks.filter(t => t.assignee === assignee);
        if (initiativeId) tasks = tasks.filter(t => t.initiativeId === initiativeId);
        if (capsuleId) tasks = tasks.filter(t => t.capsuleId === capsuleId);
        return createRpcResponse(req.id, { tasks });
      }

      case RPC_METHODS.TASK_GET: {
        const { id } = params as unknown as TaskGetParams;
        if (!id) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, 'Missing "id"');
        }
        const task = this.taskPool.get(id);
        if (!task) {
          return createRpcError(req.id, RPC_ERRORS.INTERNAL_ERROR, `Task "${id}" not found`);
        }
        return createRpcResponse(req.id, task);
      }

      case RPC_METHODS.TASK_UPDATE: {
        const { id, status, assignee, result, initiativeId, capsuleId, subsystem, scopeType, executionProfile } = params as unknown as TaskUpdateParams;
        if (!id) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, 'Missing "id"');
        }
        const existing = this.taskPool.get(id);
        if (!existing) {
          return createRpcError(req.id, RPC_ERRORS.INTERNAL_ERROR, `Task "${id}" not found`);
        }
        if (initiativeId && !this.initiativeBoard.get(initiativeId)) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, `Initiative "${initiativeId}" not found`);
        }
        if (capsuleId && !this.capsulePool.get(capsuleId)) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, `Capsule "${capsuleId}" not found`);
        }
        const fullId = existing.id; // resolved full UUID from prefix
        const oldStatus = existing.status;
        const oldAssignee = existing.assignee;
        await this.taskPool.update(fullId, {
          ...(status ? { status: status as import('./task-pool.js').TaskStatus } : {}),
          ...(assignee ? { assignee } : {}),
          ...(result ? { result } : {}),
          ...(initiativeId ? { initiativeId } : {}),
          ...(capsuleId ? { capsuleId } : {}),
          ...(subsystem ? { subsystem } : {}),
          ...(scopeType ? { scopeType } : {}),
          ...(executionProfile ? { executionProfile } : {}),
        });
        const updatedTask = this.taskPool.get(fullId);

        if (assignee && assignee !== oldAssignee && updatedTask) {
          const from = (params as Record<string, unknown>)['from'] as string || 'system';
          this.notifyTaskAssignment(assignee, updatedTask, from);
        }

        // Emit task transition event for observability
        if (status && status !== oldStatus && this._eventBus) {
          this._eventBus.emit({
            type: 'task.transition',
            runId: this._eventBus.runId,
            loop: this._eventBus.currentLoop,
            taskId: typeof fullId === 'number' ? fullId : parseInt(String(fullId), 10),
            assignee: assignee || existing.assignee || undefined,
            from: oldStatus || 'unknown',
            to: status,
            timestamp: new Date().toISOString(),
          });
        }

        // When a task is marked done, wake any on-demand agents that were blocked waiting on it
        if (status === 'done') {
          this.wakeUnblockedAgents(fullId);
          // Auto-commit dev agent output to git
          if (updatedTask) {
            this.gitAutoCommit(updatedTask.assignee || 'unknown', updatedTask.title);
          }
        }

        // POST task update to external sync hook (best-effort)
        if (updatedTask) {
          postStorySyncEvent({
            event_type: 'task',
            classification: updatedTask.status,
            agent: updatedTask.assignee,
            payload: {
              id: updatedTask.id,
              title: updatedTask.title,
              status: updatedTask.status,
              assignee: updatedTask.assignee,
              result: updatedTask.result,
            },
          });
        }

        return createRpcResponse(req.id, updatedTask);
      }

      // ── Mission board / change capsules ──

      case RPC_METHODS.INITIATIVE_CREATE: {
        const { title, goal, summary, status, priority, sources, agent } = params as unknown as InitiativeCreateParams;
        if (!title || !goal) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, 'Missing required: title, goal');
        }
        const initiative = await this.initiativeBoard.create({
          title,
          goal,
          summary: summary || goal,
          status: status ?? 'active',
          priority: priority ?? 5,
          sources: sources ?? [],
          createdBy: agent || 'system',
        });
        return createRpcResponse(req.id, initiative);
      }

      case RPC_METHODS.INITIATIVE_LIST: {
        const { status } = params as unknown as InitiativeListParams;
        const initiatives = await this.initiativeBoard.list({
          ...(status ? { status: status as InitiativeStatus } : {}),
        });
        return createRpcResponse(req.id, { initiatives });
      }

      case RPC_METHODS.INITIATIVE_GET: {
        const { id } = params as unknown as InitiativeGetParams;
        if (!id) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, 'Missing "id"');
        }
        const initiative = this.initiativeBoard.get(id);
        if (!initiative) {
          return createRpcError(req.id, RPC_ERRORS.INTERNAL_ERROR, `Initiative "${id}" not found`);
        }
        return createRpcResponse(req.id, initiative);
      }

      case RPC_METHODS.INITIATIVE_UPDATE: {
        const { id, title, goal, summary, status, priority, sources } = params as unknown as InitiativeUpdateParams;
        if (!id) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, 'Missing "id"');
        }
        const existing = this.initiativeBoard.get(id);
        if (!existing) {
          return createRpcError(req.id, RPC_ERRORS.INTERNAL_ERROR, `Initiative "${id}" not found`);
        }
        const updated = await this.initiativeBoard.update(existing.id, {
          ...(title ? { title } : {}),
          ...(goal ? { goal } : {}),
          ...(summary ? { summary } : {}),
          ...(status ? { status: status as InitiativeStatus } : {}),
          ...(priority !== undefined ? { priority } : {}),
          ...(sources ? { sources } : {}),
        });
        return createRpcResponse(req.id, updated);
      }

      case RPC_METHODS.CAPSULE_CREATE: {
        const {
          goal,
          ownerAgent,
          branch,
          baseCommit,
          allowedPaths,
          acceptance,
          reviewer,
          initiativeId,
          taskId,
          subsystem,
          scopeType,
          blockedBy,
          supersedes,
        } = params as unknown as CapsuleCreateParams;
        if (!goal || !ownerAgent || !branch || !baseCommit || !acceptance || !Array.isArray(allowedPaths) || allowedPaths.length === 0) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, 'Missing required capsule fields');
        }
        if (initiativeId && !this.initiativeBoard.get(initiativeId)) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, `Initiative "${initiativeId}" not found`);
        }
        const linkedTask = taskId ? this.taskPool.get(taskId) : null;
        if (taskId && !linkedTask) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, `Task "${taskId}" not found`);
        }
        const conflicts = await this.capsulePool.checkConflict({ allowedPaths, subsystem });
        const highConflicts = conflicts.filter(conflict => conflict.level === 'high_conflict');
        if (highConflicts.length > 0) {
          const ids = highConflicts.map(conflict => conflict.capsule.id.slice(0, 8)).join(', ');
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, `Capsule conflicts with active capsule(s): ${ids}`);
        }
        const capsule = await this.capsulePool.create({
          goal,
          ownerAgent,
          branch,
          baseCommit,
          allowedPaths,
          acceptance,
          reviewer: reviewer || 'cto',
          status: 'open',
          ...(initiativeId ? { initiativeId } : {}),
          ...(taskId ? { taskId: linkedTask!.id } : {}),
          ...(subsystem ? { subsystem } : {}),
          ...(scopeType ? { scopeType } : {}),
          ...(blockedBy ? { blockedBy } : {}),
          ...(supersedes ? { supersedes } : {}),
        });
        if (linkedTask) {
          await this.taskPool.update(linkedTask.id, {
            capsuleId: capsule.id,
            initiativeId: capsule.initiativeId ?? linkedTask.initiativeId,
            subsystem: capsule.subsystem ?? linkedTask.subsystem,
            scopeType: capsule.scopeType ?? linkedTask.scopeType,
          });
        }
        return createRpcResponse(req.id, {
          ...capsule,
          conflicts: conflicts.filter(conflict => conflict.level === 'weak_conflict').map(conflict => ({
            capsuleId: conflict.capsule.id,
            level: conflict.level,
            reason: conflict.reason,
          })),
        });
      }

      case RPC_METHODS.CAPSULE_LIST: {
        const { status, ownerAgent, initiativeId, reviewer } = params as unknown as CapsuleListParams;
        const capsules = await this.capsulePool.list({
          ...(status ? { status: status as ChangeCapsuleStatus } : {}),
          ...(ownerAgent ? { ownerAgent } : {}),
          ...(initiativeId ? { initiativeId } : {}),
          ...(reviewer ? { reviewer } : {}),
        });
        return createRpcResponse(req.id, { capsules });
      }

      case RPC_METHODS.CAPSULE_GET: {
        const { id } = params as unknown as CapsuleGetParams;
        if (!id) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, 'Missing "id"');
        }
        const capsule = this.capsulePool.get(id);
        if (!capsule) {
          return createRpcError(req.id, RPC_ERRORS.INTERNAL_ERROR, `Capsule "${id}" not found`);
        }
        return createRpcResponse(req.id, capsule);
      }

      case RPC_METHODS.CAPSULE_UPDATE: {
        const {
          id,
          goal,
          ownerAgent,
          branch,
          baseCommit,
          allowedPaths,
          acceptance,
          reviewer,
          status,
          initiativeId,
          taskId,
          subsystem,
          scopeType,
          blockedBy,
          supersedes,
        } = params as unknown as CapsuleUpdateParams;
        if (!id) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, 'Missing "id"');
        }
        const existing = this.capsulePool.get(id);
        if (!existing) {
          return createRpcError(req.id, RPC_ERRORS.INTERNAL_ERROR, `Capsule "${id}" not found`);
        }
        if (initiativeId && !this.initiativeBoard.get(initiativeId)) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, `Initiative "${initiativeId}" not found`);
        }
        const linkedTask = taskId ? this.taskPool.get(taskId) : undefined;
        if (taskId && !linkedTask) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, `Task "${taskId}" not found`);
        }
        if (allowedPaths && allowedPaths.length > 0) {
          const conflicts = await this.capsulePool.checkConflict({
            allowedPaths,
            subsystem: subsystem ?? existing.subsystem,
          }, existing.id);
          if (conflicts.some(conflict => conflict.level === 'high_conflict')) {
            const ids = conflicts
              .filter(conflict => conflict.level === 'high_conflict')
              .map(conflict => conflict.capsule.id.slice(0, 8))
              .join(', ');
            return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, `Capsule conflicts with active capsule(s): ${ids}`);
          }
        }
        const updated = await this.capsulePool.update(existing.id, {
          ...(goal ? { goal } : {}),
          ...(ownerAgent ? { ownerAgent } : {}),
          ...(branch ? { branch } : {}),
          ...(baseCommit ? { baseCommit } : {}),
          ...(allowedPaths ? { allowedPaths } : {}),
          ...(acceptance ? { acceptance } : {}),
          ...(reviewer ? { reviewer } : {}),
          ...(status ? { status: status as ChangeCapsuleStatus } : {}),
          ...(initiativeId ? { initiativeId } : {}),
          ...(taskId ? { taskId: linkedTask!.id } : {}),
          ...(subsystem ? { subsystem } : {}),
          ...(scopeType ? { scopeType } : {}),
          ...(blockedBy ? { blockedBy } : {}),
          ...(supersedes ? { supersedes } : {}),
        });
        const effectiveTask = linkedTask ?? (updated.taskId ? this.taskPool.get(updated.taskId) : null);
        if (effectiveTask) {
          await this.taskPool.update(effectiveTask.id, {
            capsuleId: updated.id,
            initiativeId: updated.initiativeId ?? effectiveTask.initiativeId,
            subsystem: updated.subsystem ?? effectiveTask.subsystem,
            scopeType: updated.scopeType ?? effectiveTask.scopeType,
          });
        }
        return createRpcResponse(req.id, updated);
      }

      case RPC_METHODS.CAPSULE_MINE: {
        const { agent, status } = params as unknown as CapsuleMineParams;
        if (!agent) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, 'Missing "agent"');
        }
        const capsules = await this.capsulePool.mine(agent, status as ChangeCapsuleStatus | undefined);
        return createRpcResponse(req.id, { capsules });
      }

      // ── Artifacts ──

      case RPC_METHODS.ARTIFACT_PUT: {
        if (!this.brainManager?.isInitialized) {
          return createRpcError(req.id, RPC_ERRORS.INTERNAL_ERROR, 'Brain not initialized — artifact storage unavailable');
        }
        const { kind, agent, source, confidence, taskId, path, content, metadata } = params as unknown as ArtifactPutParams;
        if (!kind || !agent || !source || confidence === undefined) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, 'Missing required: kind, agent, source, confidence');
        }
        if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, 'confidence must be a number between 0 and 1');
        }
        if (!SAFE_IDENT.test(agent)) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, `invalid agent "${agent}": must match ${SAFE_IDENT}`);
        }
        if (!SAFE_IDENT.test(kind)) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, `invalid kind "${kind}": must match ${SAFE_IDENT}`);
        }
        if (path && !SAFE_PATH.test(path)) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, `invalid path "${path}": must match ${SAFE_PATH}`);
        }
        const fullMetadata = { ...metadata, source, confidence, verified: false };
        // agent/kind/path are whitelist-validated above; esc() is kept as defence-in-depth.
        // metadata is escaped with escJson so that JSON escape sequences (e.g. \n) survive
        // the jsonb parser (esc() would double the leading backslash and corrupt them).
        const sql = `INSERT INTO artifacts (agent, kind, path, content, metadata) VALUES ('${esc(agent)}', '${esc(kind)}', ${path ? `'${esc(path)}'` : 'NULL'}, ${content ? `'${esc(content)}'` : 'NULL'}, '${escJson(JSON.stringify(fullMetadata))}'::jsonb) RETURNING id, agent, kind, created_at`;
        try {
          const result = await this.brainManager.executeSQL(sql);
          const insertedArtifact = Array.isArray(result) && result.length > 0 && result[0] && typeof result[0] === 'object'
            ? result[0] as { id?: string | number }
            : null;
          // Emit artifact.created event for observability
          if (this._eventBus) {
            this._eventBus.emit({
              type: 'artifact.created',
              runId: this._eventBus.runId,
              loop: this._eventBus.currentLoop,
              agent,
              kind,
              path: path || undefined,
              timestamp: new Date().toISOString(),
            });
          }
          // POST to external sync hook (best-effort)
          postStorySyncArtifact({
            id: String(insertedArtifact?.id ?? Date.now()),
            agent,
            kind,
            path: path ?? `${kind}/${agent}`,
            content,
            metadata: fullMetadata,
          });
          return createRpcResponse(req.id, result);
        } catch (err) {
          return createRpcError(req.id, RPC_ERRORS.INTERNAL_ERROR, `Artifact insert failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      case RPC_METHODS.ARTIFACT_LIST: {
        if (!this.brainManager?.isInitialized) {
          return createRpcError(req.id, RPC_ERRORS.INTERNAL_ERROR, 'Brain not initialized');
        }
        const { agent: filterAgent, kind: filterKind, verified } = params as unknown as ArtifactListParams;
        if (filterAgent && !SAFE_IDENT.test(filterAgent)) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, `invalid agent filter "${filterAgent}"`);
        }
        if (filterKind && !SAFE_IDENT.test(filterKind)) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, `invalid kind filter "${filterKind}"`);
        }
        const conditions: string[] = [];
        if (filterAgent) conditions.push(`agent = '${esc(filterAgent)}'`);
        if (filterKind) conditions.push(`kind = '${esc(filterKind)}'`);
        if (verified !== undefined) conditions.push(`metadata->>'verified' = '${String(verified) === 'true' ? 'true' : 'false'}'`);
        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const sql = `SELECT id, agent, kind, path, length(content) as content_length, metadata, created_at FROM artifacts ${where} ORDER BY created_at DESC LIMIT 100`;
        try {
          const result = await this.brainManager.executeSQL(sql);
          return createRpcResponse(req.id, result);
        } catch (err) {
          return createRpcError(req.id, RPC_ERRORS.INTERNAL_ERROR, `Artifact list failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      case RPC_METHODS.ARTIFACT_GET: {
        if (!this.brainManager?.isInitialized) {
          return createRpcError(req.id, RPC_ERRORS.INTERNAL_ERROR, 'Brain not initialized');
        }
        const { id: artifactId } = params as unknown as { id: number };
        const parsedArtifactId = parseInt(String(artifactId), 10);
        if (artifactId === undefined || artifactId === null || isNaN(parsedArtifactId)) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, 'Missing or invalid required: id (must be a number)');
        }
        const sql = `SELECT id, agent, kind, path, content, metadata, created_at FROM artifacts WHERE id = ${parsedArtifactId}`;
        try {
          const result = await this.brainManager.executeSQL(sql);
          return createRpcResponse(req.id, result);
        } catch (err) {
          return createRpcError(req.id, RPC_ERRORS.INTERNAL_ERROR, `Artifact get failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // ── Hypotheses ──

      case RPC_METHODS.HYPOTHESIS_CREATE: {
        if (!this.brainManager?.isInitialized) {
          return createRpcError(req.id, RPC_ERRORS.INTERNAL_ERROR, 'Brain not initialized');
        }
        const { title, agent: hAgent, rationale, expectedValue, estimatedCost, parentId } = params as {
          title: string; agent: string; rationale?: string; expectedValue?: string; estimatedCost?: string; parentId?: number;
        };
        if (!title) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, 'Missing required: title');
        }
        const effectiveAgent = hAgent || 'ceo';
        if (!SAFE_IDENT.test(effectiveAgent)) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, `invalid agent "${effectiveAgent}"`);
        }
        const cols = ['agent', 'title'];
        const vals = [`'${esc(effectiveAgent)}'`, `'${esc(title)}'`];
        if (rationale) { cols.push('rationale'); vals.push(`'${esc(rationale)}'`); }
        if (expectedValue) { cols.push('expected_value'); vals.push(`'${esc(expectedValue)}'`); }
        if (estimatedCost) { cols.push('estimated_cost'); vals.push(`'${esc(estimatedCost)}'`); }
        if (parentId) { cols.push('parent_id'); vals.push(String(parseInt(String(parentId), 10))); }
        const sql = `INSERT INTO hypotheses (${cols.join(', ')}) VALUES (${vals.join(', ')}) RETURNING id, title, status, created_at`;
        try {
          const result = await this.brainManager.executeSQL(sql);
          return createRpcResponse(req.id, result);
        } catch (err) {
          return createRpcError(req.id, RPC_ERRORS.INTERNAL_ERROR, `Hypothesis create failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      case RPC_METHODS.HYPOTHESIS_LIST: {
        if (!this.brainManager?.isInitialized) {
          return createRpcError(req.id, RPC_ERRORS.INTERNAL_ERROR, 'Brain not initialized');
        }
        const { status: hStatus, treeRoot } = params as { status?: string; treeRoot?: number };
        let sql: string;
        const parsedTreeRoot = treeRoot ? parseInt(String(treeRoot), 10) : NaN;
        if (treeRoot && !isNaN(parsedTreeRoot)) {
          // Recursive tree query from a root
          sql = `WITH RECURSIVE tree AS (
            SELECT * FROM hypotheses WHERE id = ${parsedTreeRoot}
            UNION ALL
            SELECT h.* FROM hypotheses h JOIN tree t ON h.parent_id = t.id
          ) SELECT id, parent_id, agent, title, rationale, expected_value, estimated_cost, status, outcome, created_at, resolved_at FROM tree ORDER BY id`;
        } else {
          if (hStatus && !SAFE_IDENT.test(hStatus)) {
            return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, `invalid status "${hStatus}"`);
          }
          const conditions: string[] = [];
          if (hStatus) conditions.push(`status = '${esc(hStatus)}'`);
          const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
          sql = `SELECT id, parent_id, agent, title, rationale, expected_value, estimated_cost, status, outcome, created_at, resolved_at FROM hypotheses ${where} ORDER BY created_at DESC LIMIT 100`;
        }
        try {
          const result = await this.brainManager.executeSQL(sql);
          return createRpcResponse(req.id, result);
        } catch (err) {
          return createRpcError(req.id, RPC_ERRORS.INTERNAL_ERROR, `Hypothesis list failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      case RPC_METHODS.HYPOTHESIS_UPDATE: {
        if (!this.brainManager?.isInitialized) {
          return createRpcError(req.id, RPC_ERRORS.INTERNAL_ERROR, 'Brain not initialized');
        }
        const { id: hId, status: newStatus, outcome: hOutcome, evidence } = params as {
          id: number; status: string; outcome?: string; evidence?: number[];
        };
        const parsedHId = parseInt(String(hId), 10);
        if (hId === undefined || hId === null || isNaN(parsedHId)) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, 'Missing or invalid required: id (must be a number)');
        }
        if (!newStatus) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, 'Missing required: status');
        }
        if (!SAFE_IDENT.test(newStatus)) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, `invalid status "${newStatus}"`);
        }
        const sets = [`status = '${esc(newStatus)}'`];
        if (hOutcome) sets.push(`outcome = '${esc(hOutcome)}'`);
        if (evidence) sets.push(`evidence_artifact_ids = ARRAY[${evidence.map(e => parseInt(String(e), 10)).join(',')}]`);
        if (['validated', 'rejected', 'abandoned'].includes(newStatus)) {
          sets.push(`resolved_at = now()`);
        }
        const sql = `UPDATE hypotheses SET ${sets.join(', ')} WHERE id = ${parsedHId} RETURNING id, status, resolved_at`;
        try {
          const result = await this.brainManager.executeSQL(sql);
          return createRpcResponse(req.id, result);
        } catch (err) {
          return createRpcError(req.id, RPC_ERRORS.INTERNAL_ERROR, `Hypothesis update failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // ── Skill management ──

      case RPC_METHODS.SKILL_GET: {
        if (!this._skillManager) {
          return createRpcError(req.id, RPC_ERRORS.INTERNAL_ERROR, 'Skill manager not initialized');
        }
        const { agent: skillAgent } = params as { agent?: string };
        if (!skillAgent) return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, 'Missing "agent"');
        try {
          const content = await this._skillManager.resolveSkill(skillAgent);
          const versions = await this._skillManager.getVersions(skillAgent);
          return createRpcResponse(req.id, { agent: skillAgent, content, versions });
        } catch (err) {
          return createRpcError(req.id, RPC_ERRORS.INTERNAL_ERROR, `skill.get failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      case RPC_METHODS.SKILL_UPDATE: {
        if (!this._skillManager) {
          return createRpcError(req.id, RPC_ERRORS.INTERNAL_ERROR, 'Skill manager not initialized');
        }
        const { agent: updateAgent, content: skillContent, activate, createdBy } = params as {
          agent?: string; content?: string; activate?: boolean; createdBy?: string;
        };
        if (!updateAgent || !skillContent) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, 'Missing "agent" and "content"');
        }
        try {
          const version = await this._skillManager.createVersion(updateAgent, skillContent, createdBy || 'human');
          if (activate && version) {
            await this._skillManager.activateVersion(updateAgent, version.version);
            version.isActive = true;
          }
          return createRpcResponse(req.id, version);
        } catch (err) {
          return createRpcError(req.id, RPC_ERRORS.INTERNAL_ERROR, `skill.update failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      case RPC_METHODS.SKILL_ROLLBACK: {
        if (!this._skillManager) {
          return createRpcError(req.id, RPC_ERRORS.INTERNAL_ERROR, 'Skill manager not initialized');
        }
        const { agent: rollbackAgent } = params as { agent?: string };
        if (!rollbackAgent) return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, 'Missing "agent"');
        try {
          const success = await this._skillManager.rollback(rollbackAgent);
          return createRpcResponse(req.id, { success });
        } catch (err) {
          return createRpcError(req.id, RPC_ERRORS.INTERNAL_ERROR, `skill.rollback failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      case RPC_METHODS.SKILL_METRICS: {
        if (!this._skillManager) {
          return createRpcError(req.id, RPC_ERRORS.INTERNAL_ERROR, 'Skill manager not initialized');
        }
        try {
          const metrics = await this._skillManager.getSkillMetrics();
          const underperformers = await this._skillManager.identifyUnderperformers();
          return createRpcResponse(req.id, { metrics, underperformers });
        } catch (err) {
          return createRpcError(req.id, RPC_ERRORS.INTERNAL_ERROR, `skill.metrics failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // ── Dynamic agent spawning ──

      case RPC_METHODS.AGENT_SPAWN: {
        const { template, name: cloneName } = params as { template?: string; name?: string }
        if (!template) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, 'Missing "template" (name of agent role to clone)')
        }
        const result = await this.spawnDynamicAgent(template, cloneName)
        if ('error' in result) {
          return createRpcError(req.id, RPC_ERRORS.INTERNAL_ERROR, result.error)
        }
        return createRpcResponse(req.id, result)
      }

      case RPC_METHODS.AGENT_DESTROY: {
        const { name: destroyName } = params as { name?: string }
        if (!destroyName) {
          return createRpcError(req.id, RPC_ERRORS.INVALID_PARAMS, 'Missing "name"')
        }
        const destroyed = await this.destroyDynamicAgent(destroyName)
        return createRpcResponse(req.id, { destroyed })
      }

      case RPC_METHODS.SUPERVISOR_PAUSE: {
        for (const [name, agent] of this.agents) {
          agent.pause();
          log.info('paused agent', { agent: name });
        }
        return createRpcResponse(req.id, { status: 'paused', agents: this.agents.size });
      }

      case RPC_METHODS.SUPERVISOR_RESUME: {
        for (const [name, agent] of this.agents) {
          agent.resume();
          log.info('resumed agent', { agent: name });
        }
        return createRpcResponse(req.id, { status: 'running', agents: this.agents.size });
      }

      default:
        return this.handleRpc(req);
    }
  }

  /**
   * When a task completes, check if any on-demand agents were blocked
   * waiting on it and can now be triggered.
   */
  private wakeUnblockedAgents(completedTaskId: string): void {
    try {
      const tasks = this.taskPool.listSync();
      // Find tasks that depend on the completed task
      const unblockedAgents = new Set<string>();
      for (const t of tasks) {
        if (t.dependsOn.includes(completedTaskId) && t.assignee && t.status === 'assigned') {
          if (this.taskPool.areDependenciesMet(t.id)) {
            unblockedAgents.add(t.assignee);
          }
        }
      }
      for (const agentName of unblockedAgents) {
        const agent = this.agents.get(agentName);
        if (
          agent
          && (agent.definition.lifecycle === 'on-demand' || agent.definition.lifecycle === 'idle_cached')
          && agent.state === 'idle'
        ) {
          log.info('waking previously-blocked idle agent', {
            agent: agentName,
            lifecycle: agent.definition.lifecycle,
            unlockedBy: completedTaskId,
          });
          agent.trigger();
        }
      }
    } catch (err) {
      log.warn('wakeUnblockedAgents failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Check if an agent's assigned tasks ALL have unmet dependencies.
   * Returns true only if every assigned/pending task for this agent is blocked.
   * Uses sync listSync() to work in non-async callback context.
   */
  private hasBlockedTasksOnly(agentName: string): boolean {
    try {
      const tasks = this.taskPool.listSync();
      const agentTasks = tasks.filter(
        t => t.assignee === agentName && (t.status === 'assigned' || t.status === 'pending')
      );
      if (agentTasks.length === 0) return false;
      return agentTasks.every(t => t.dependsOn.length > 0 && !this.taskPool.areDependenciesMet(t.id));
    } catch {
      return false; // On error, don't block
    }
  }

  /**
   * Check whether a 24/7 agent has useful work to do even without new messages.
   * CEO always runs. Workers only spin when they have runnable assigned work.
   */
  private hasAutonomousWork(agentName: string): boolean {
    if (agentName === 'ceo') return true;
    try {
      const tasks = this.taskPool.listSync();
      return tasks.some(task => {
        if (task.assignee !== agentName) return false;
        if (!(task.status === 'assigned' || task.status === 'in_progress' || task.status === 'review')) return false;
        return this.taskPool.areDependenciesMet(task.id);
      });
    } catch {
      return true;
    }
  }

  // ── Git version control for workspace ──

  /**
   * Initialize the workspace as a git repo (idempotent).
   * All agent output will be version-controlled.
   */
  private initWorkspaceGit(gitRoot: string, workspaceRoot: string): void {
    const wsRoot = gitRoot;
    const relativeWorkspace = workspaceRoot.startsWith(wsRoot)
      ? workspaceRoot.slice(wsRoot.length).replace(/^\/+/, '')
      : workspaceRoot.replace(/^\/+/, '');
    const workspaceBase = relativeWorkspace || 'agents';
    this.workspaceArtifactsPattern = `${workspaceBase.replace(/\/+$/, '')}/*/output/`;
    try {
      // Check if already a git repo
      execSync('git rev-parse --is-inside-work-tree', { cwd: wsRoot, stdio: 'pipe' });
      log.info('workspace git already initialized', { path: wsRoot });
    } catch {
      try {
        execSync('git init', { cwd: wsRoot, stdio: 'pipe' });
        // Mark workspace as safe (avoids "dubious ownership" when root inits, agent user commits)
        execSync(`git config --global --add safe.directory ${wsRoot}`, { cwd: wsRoot, stdio: 'pipe' });
        // Configure git identity for the workspace (required in containers)
        execSync('git config user.email "agents@wanman.dev"', { cwd: wsRoot, stdio: 'pipe' });
        execSync('git config user.name "wanman agents"', { cwd: wsRoot, stdio: 'pipe' });
        execSync('git add -A', { cwd: wsRoot, stdio: 'pipe' });
        execSync('git commit -m "init: workspace initialized" --allow-empty', { cwd: wsRoot, stdio: 'pipe' });
        // Fix .git ownership so agent user can run git commands
        const agentUser = process.env['WANMAN_AGENT_USER'];
        if (agentUser && process.getuid?.() === 0) {
          execSync(`chown -R ${agentUser}:${agentUser} ${wsRoot}`, { stdio: 'pipe' });
        }
        log.info('workspace git initialized', { path: wsRoot });
      } catch (err) {
        log.warn('workspace git init failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }
    this.workspaceGitRoot = wsRoot;
  }

  private workspaceGitRoot: string | null = null;
  private workspaceArtifactsPattern = 'agents/*/output/';

  private hasKnownAgent(name: string): boolean {
    return this.agents.has(name) || this.config.agents.some(agent => agent.name === name);
  }

  /**
   * Auto-commit agent output after a task completes.
   * Commits all changes in the output directory.
   */
  private gitAutoCommit(assignee: string, taskTitle: string): void {
    if (!this.workspaceGitRoot) return;
    const cwd = this.workspaceGitRoot;
    try {
      // Check if there are any changes to commit
      const status = execSync('git status --porcelain', { cwd, encoding: 'utf-8' }).trim();
      if (!status) return; // nothing to commit

      // Stage per-agent output directories (not CLAUDE.md skill files)
      execSync(`git add ${this.workspaceArtifactsPattern} 2>/dev/null || true`, { cwd, stdio: 'pipe' });

      // Check if anything is actually staged
      const staged = execSync('git diff --cached --name-only', { cwd, encoding: 'utf-8' }).trim();
      if (!staged) return;

      const title = taskTitle.slice(0, 72).replace(/"/g, '\\"');
      const msg = `${assignee}: ${title}`;
      execSync(`git commit -m "${msg}" --author="${assignee}-agent <${assignee}@wanman.dev>"`, { cwd, stdio: 'pipe' });
      // Get the commit SHA
      const sha = execSync('git rev-parse --short HEAD', { cwd, encoding: 'utf-8' }).trim();
      log.info('git auto-commit', { assignee, sha, files: staged.split('\n').length });
    } catch (err) {
      log.warn('git auto-commit failed', { assignee, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private getAttributableTaskForAgent(agentName: string): Task | null {
    const tasks = this.taskPool?.listSync().filter(task =>
      task.assignee === agentName
      && ['assigned', 'in_progress', 'review'].includes(task.status)
    ) ?? []

    const inProgress = tasks.filter(task => task.status === 'in_progress')
    if (inProgress.length === 1) return inProgress[0]!
    if (tasks.length === 1) return tasks[0]!
    return null
  }

  private async getOrCreateActivationSnapshot(agentName: string): Promise<ActivationSnapshotRecord | null> {
    if (!this._sharedSkillManager) {
      return null
    }

    const runId = this._eventBus?.runId ?? 'unknown'
    const task = this.getAttributableTaskForAgent(agentName)
    const activationScope = task ? 'task' : 'run'
    const cacheKey = [
      runId,
      agentName,
      activationScope,
      task?.id ?? 'baseline',
      task?.executionProfile ?? 'default',
    ].join(':')

    const cached = this.activationSnapshots.get(cacheKey)
    if (cached) {
      this.activeSnapshotByAgent.set(agentName, cached)
      return cached
    }

    const snapshot = await this._sharedSkillManager.createActivationSnapshot({
      runId,
      loopNumber: this._eventBus?.currentLoop ?? 0,
      taskId: task?.id,
      agent: agentName,
      executionProfile: task?.executionProfile,
      activationScope,
      activatedBy: 'system',
    })

    if (snapshot) {
      this.activationSnapshots.set(cacheKey, snapshot)
      this.activeSnapshotByAgent.set(agentName, snapshot)
    }

    return snapshot
  }

  /** Handle an external event — route to subscribed agents. */
  handleExternalEvent(event: ExternalEvent): void {
    log.info('external event', { type: event.type, source: event.source });

    for (const def of this.config.agents) {
      if (def.events?.includes(event.type)) {
        this.relay.send('system', def.name, 'event', {
          eventType: event.type,
          source: event.source,
          ...event.payload,
        }, 'normal');
      }
    }
  }

  /** Get health status. */
  getHealth(): HealthResponse & { loop?: unknown; runtime?: unknown } {
    const health: HealthResponse & { loop?: unknown; runtime?: unknown } = {
      status: 'ok',
      agents: Array.from(this.agents.entries()).map(([name, proc]) => ({
        name,
        state: proc.state,
        lifecycle: proc.definition.lifecycle,
      })),
      timestamp: new Date().toISOString(),
    };

    // Include loop observability data if EventBus is active
    if (this._eventBus) {
      health.loop = {
        runId: this._eventBus.runId,
        currentLoop: this._eventBus.currentLoop,
      };
    }

    health.runtime = {
      completedRuns: this.completedRuns,
      completedRunsByAgent: Object.fromEntries(this.completedRunsByAgent.entries()),
      initiatives: this.initiativeBoard?.listSync().length ?? 0,
      activeInitiatives: this.initiativeBoard?.listSync().filter(initiative => initiative.status === 'active').length ?? 0,
      capsules: this.capsulePool?.listSync().length ?? 0,
      activeCapsules: this.capsulePool?.listSync().filter(capsule => capsule.status === 'open' || capsule.status === 'in_review').length ?? 0,
    };

    return health;
  }

  /** Graceful shutdown. */
  async shutdown(): Promise<void> {
    log.info('shutting down...');

    // Stop cron scheduler (may not be initialized if start() failed)
    if (this.cronScheduler) {
      this.cronScheduler.stop();
    }

    // Stop all agents and release their claimed tasks back to pending
    for (const [name, agent] of this.agents) {
      log.info('stopping agent', { agent: name });
      agent.stop();
      try {
        const released = this.taskPool.releaseByAssignee(name);
        if (released > 0) {
          log.info('released claimed tasks on shutdown', { agent: name, count: released });
        }
      } catch (err) {
        log.warn('failed to release tasks on shutdown', {
          agent: name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Close HTTP server (5s timeout to avoid hanging on keep-alive connections)
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 5_000);
        this.httpServer!.close(() => { clearTimeout(timer); resolve(); });
      });
    }

    // Close database
    if (this.db) {
      this.db.close();
    }

    this._sharedSkillManager?.cleanupSnapshots(this.activationSnapshots.values())
    this._agentHomeManager?.cleanupHomes()
    this.activationSnapshots.clear()
    this.activeSnapshotByAgent.clear()

    log.info('shutdown complete');
  }
}

function sqlStringOrNull(value: string | undefined): string {
  return value ? `'${esc(value)}'` : 'NULL'
}
